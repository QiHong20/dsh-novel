import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { manageMaterialScope, scopedMaterial } from '../lib/material-scope.js'
import { stageBook } from '../stage.js'

test('旧资料候选确认后按事实时间、揭示顺序、人物权限筛选；改稿及排序使范围失效', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-material-scope-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'characters'))
  await fs.mkdir(path.join(root, 'settings'))
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.writeFile(path.join(root, 'characters/a.md'), '# 甲\n- ID：a')
  const source = 'settings/钥匙.md'
  await fs.writeFile(path.join(root, source), '黄铜制成\n已交接\n甲知道藏处\n后续开门\n终局秘密')
  const chapters = ['0001', '0002', '0003'].map(id => ({ id, title: id, file: `chapters/${id}.md` }))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '范围测试', chapters }))
  const beats = chapters.map((c, i) => `## ${c.id} ${c.title}\n### 场景 s${i}：交接\n- 时序：${[10,20,5][i]}\n- 出场：a\n- 视角：a\n#### 人物 a\n- 目标：查明\n`).join('\n')
  await fs.writeFile(path.join(root, 'beats.md'), beats)
  const inspect = await manageMaterialScope(root, { source })
  const entries = inspect.units.map((u, i) => ({ ...u, kind: ['stable','fact','knowledge','plan','private'][i], reason: '按剧情依据核对范围',
    ...(i !== 4 ? { reveal: i === 3 ? 's2' : 's0' } : {}), ...([1,2,3].includes(i) ? { from: i === 3 ? 's2' : 's0' } : {}), ...(i === 2 ? { observer: 'a' } : {}) }))
  let book = await stageBook(root, chapters)
  assert.equal((await scopedMaterial(root, source, book, book.scenes[1])).text, '')
  await assert.rejects(manageMaterialScope(root, { action: 'propose', source, sourceHash: inspect.sourceHash, entries: entries.slice(1) }), /未标记/u)
  await manageMaterialScope(root, { action: 'propose', source, sourceHash: inspect.sourceHash, entries })
  assert.equal((await scopedMaterial(root, source, book, book.scenes[1])).status, 'unscoped')
  await manageMaterialScope(root, { action: 'confirm', source, sourceHash: inspect.sourceHash })
  const current = await scopedMaterial(root, source, book, book.scenes[1])
  assert.match(current.text, /黄铜制成|已交接|甲知道藏处/u)
  assert.doesNotMatch(current.text, /后续开门|终局秘密/u)
  const first = await scopedMaterial(root, source, book, book.scenes[0])
  assert.doesNotMatch(first.text, /已交接|甲知道/u)
  const other = await scopedMaterial(root, source, book, { ...book.scenes[1], viewpoint: 'b' })
  assert.doesNotMatch(other.text, /甲知道/u)
  const flashback = await scopedMaterial(root, source, book, book.scenes[2])
  assert.doesNotMatch(flashback.text, /已交接/u)
  assert.match(flashback.text, /本场计划，非事实/u)
  await fs.writeFile(path.join(root, 'beats.md'), beats.replace('时序：10', '时序：11'))
  book = await stageBook(root, chapters)
  assert.equal((await scopedMaterial(root, source, book, book.scenes[1])).status, 'unscoped')
  await fs.appendFile(path.join(root, source), '\n新秘密')
  assert.equal((await scopedMaterial(root, source, book, book.scenes[1])).text, '')
})
