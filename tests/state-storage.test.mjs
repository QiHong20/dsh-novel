import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hash, stageBook, stageContext } from '../stage.js'
import { updateState, stateBook, statesAt } from '../lib/state-history.js'
import { manageBeatStorage, readBeatStorage, writeBeatStorage } from '../lib/beat-storage.js'
import { readBeats, writeBeats } from '../lib/beats.js'
import { readText, writeFileAtomic } from '../lib/book.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-state-storage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.mkdir(path.join(root, 'characters'))
  await fs.writeFile(path.join(root, 'characters/a.md'), '# 甲\n- ID：a\n- 定位：主角\n- 重要程度：核心')
  const chapters = ['0001', '0002', '0003'].map((id, i) => ({ id, title: id, file: `chapters/${id}.md`, deaiReview: { baseHash: hash('钥匙交给甲。'), scenes: [{ sceneId: `s${i}`, startIndex: 1, endIndex: 1 }] } }))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '无题材测试', chapters }))
  for (const c of chapters) await fs.writeFile(path.join(root, c.file), '钥匙交给甲。')
  const scene = i => `### 场景 s${i}：交接\n- 时序：${[10, 20, 5][i]}\n- 出场：a\n- 状态对象：key\n- 事件：e1\n- 本场推进：交接\n- 本场允许结果：归属变化\n- 禁止提前兑现：后续开门\n#### 人物 a\n- 目标：保管\n`
  const beats = '# 章纲\n\n' + chapters.map((c, i) => `## ${c.id} ${c.title}\n- 事件：e1\n${scene(i)}`).join('\n')
  await fs.writeFile(path.join(root, 'beats.md'), beats)
  await fs.writeFile(path.join(root, 'events.md'), '## 主线\n### e1 交接（1–3）\n- 因为：受托\n- 所以：保管\n')
  return { root, chapters, beats }
}

test('自定义实体状态：证据确认、前置依赖、倒叙隔离及撤销', async t => {
  const { root, chapters } = await fixture(t)
  await updateState(root, { action: 'entity', entity: 'key', name: '钥匙', type: '物件' })
  const args = { action: 'propose', entity: 'key', property: '归属', value: '甲', trigger: '交接完成', scene: 's0', event: 'e1', evidence: '钥匙交给甲。', evidenceIndex: 1 }
  await assert.rejects(updateState(root, { ...args, event: 'absent' }), /事件/u)
  await assert.rejects(updateState(root, { ...args, evidence: '不存在的证据' }), /正文分场/u)
  const proposed = await updateState(root, args)
  const id = proposed.records[0].id
  let book = await stageBook(root, chapters)
  assert.equal(statesAt(await stateBook(root, book), book, book.scenes[1]).records.length, 0)
  await updateState(root, { action: 'confirm', id })
  let state = await stateBook(root, book)
  assert.equal(statesAt(state, book, book.scenes[1]).records[0].value, '甲')
  assert.equal(statesAt(state, book, book.scenes[0]).records.length, 0)
  assert.equal(statesAt(state, book, book.scenes[2]).records.length, 0)
  const next = await updateState(root, { ...args, scene: 's1', previous: id })
  await updateState(root, { action: 'confirm', id: next.records[1].id })
  await updateState(root, { action: 'revoke', id })
  state = await stateBook(root, book)
  assert.equal(state.records[1].valid, false)
  assert.match(state.records[1].invalidReasons.join(' '), /前置状态/u)
})

test('正文变化使世界状态失效，缺少实体显式报告', async t => {
  const { root, chapters } = await fixture(t)
  let book = await stageBook(root, chapters)
  assert.deepEqual(statesAt(await stateBook(root, book), book, book.scenes[0]).missingEntities, ['key'])
  await updateState(root, { action: 'entity', entity: 'key', name: '钥匙', type: '物件' })
  const result = await updateState(root, { action: 'propose', entity: 'key', property: '可用', value: true, trigger: '交接', scene: 's0', evidence: '钥匙交给甲。', evidenceIndex: 1 })
  await updateState(root, { action: 'confirm', id: result.records[0].id })
  await fs.appendFile(path.join(root, chapters[0].file), '后来改变。')
  book = await stageBook(root, chapters)
  const state = await stateBook(root, book)
  assert.equal(state.records[0].valid, false)
  assert.equal(statesAt(state, book, book.scenes[1]).records.length, 0)
})

test('场景无锚点明确展示章级候选，不自动成为本场任务', async t => {
  const { root, chapters, beats } = await fixture(t)
  await fs.writeFile(path.join(root, 'beats.md'), beats.replace('### 场景 s0：交接\n- 时序：10\n- 出场：a\n- 状态对象：key\n- 事件：e1', '### 场景 s0：交接\n- 时序：10\n- 出场：a\n- 状态对象：key'))
  const context = await stageContext(root, chapters, '0001', 's0')
  assert.deepEqual(context.eventBindings[0].events, [])
  assert.deepEqual(context.eventBindings[0].candidates, ['e1'])
  assert.match(context.text, /章级候选（不是本场任务）/u)
  assert.ok(context.diagnostics.some(d => d.code === 'scene-event-unbound'))
})

test('分章迁移保持原文及场景语义，既有写工具写入新文件', async t => {
  const { root, chapters, beats } = await fixture(t)
  const before = await stageContext(root, chapters, '0001')
  const preview = await manageBeatStorage(root)
  await assert.rejects(manageBeatStorage(root, { action: 'migrate', baseHash: 'stale' }), /清单/u)
  const result = await manageBeatStorage(root, { action: 'migrate', baseHash: preview.baseHash })
  assert.equal(result.preserved, true)
  assert.equal(await readBeatStorage(root), beats)
  assert.equal(await fs.readFile(path.join(root, result.backup), 'utf8'), beats)
  assert.equal((await stageContext(root, chapters, '0001')).text, before.text)
  const section = await readBeats(root, chapters[0], chapters)
  await writeBeats(root, chapters[0], section.section.body.replace('保管', '妥善保管'), chapters, section.baseHash)
  assert.match(await fs.readFile(path.join(root, 'beats/0001.md'), 'utf8'), /妥善保管/u)
  assert.equal(await fs.readFile(path.join(root, 'beats.md'), 'utf8'), beats)
  assert.match(await readText(path.join(root, 'beats.md')), /妥善保管/u)
})

test('未完成多文件事务读取旧快照，恢复后一次切换并拒绝陈旧写入', async t => {
  const { root, beats } = await fixture(t)
  const preview = await manageBeatStorage(root)
  await manageBeatStorage(root, { action: 'migrate', baseHash: preview.baseHash })
  const after = beats.replaceAll('保管', '看管')
  await fs.writeFile(path.join(root, '.novel/beats-transaction.json'), JSON.stringify({ before: beats, after }))
  await fs.writeFile(path.join(root, 'beats/0001.md'), '部分写入')
  assert.equal(await readBeatStorage(root), beats)
  await assert.rejects(writeBeatStorage(root, beats), /未完成事务/u)
  await manageBeatStorage(root, { action: 'resume' })
  assert.equal(await readBeatStorage(root), after)
  await writeFileAtomic(path.join(root, 'beats.md'), beats)
  assert.equal(await readBeatStorage(root), beats)
})
