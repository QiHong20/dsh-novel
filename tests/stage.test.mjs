import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stageContext, updateHistory, moveScene, parseScenes } from '../stage.js'
import { apply } from '../index.js'
import { Readable } from 'node:stream'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const dir of ['characters', 'chapters']) await fs.mkdir(path.join(root, dir))
  const chapters = ['0001', '0002', '0003'].map(id => ({ id, title: id, file: `chapters/${id}.md` }))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '测试', chapters }))
  for (const c of chapters) await fs.writeFile(path.join(root, c.file), c.id === '0001' ? '甲看见信物。乙只听说有人失踪。' : '')
  for (const [id, name] of [['a', '甲'], ['b', '乙']]) await fs.writeFile(path.join(root, 'characters', `${name}.md`), `# ${name}\n- ID：${id}\n- 定位：重要配角\n- 重要程度：重要\n## 作者侧秘密\n真实身份不可当成角色已知。`)
  const scene = (id, time, cast = 'a、b') => `### 场景 ${id}：对质\n- 时序：${time}\n- 出场：${cast}\n- 提及：不在场的人\n- 冲突：追问信物\n#### 人物 a\n- 未知：幕后主使\n- 目标：查清真相\n- 触发：看到信物\n- 计划变化：怀疑旧约\n`
  await fs.writeFile(path.join(root, 'beats.md'), `## 0001 开场\n${scene('first', 10)}\n## 0002 后续\n${scene('later', 20)}\n## 0003 倒叙\n${scene('flashback', 5)}`)
  return { root, chapters }
}
const proposal = { action: 'propose', character: 'a', scene: 'first', kind: '已知', content: '看到信物', source: '亲眼看见', evidence: '甲看见信物。' }

test('候选与计划不继承；确认后只有知情角色、较晚场景继承；倒叙不泄露', async t => {
  const { root, chapters } = await fixture(t)
  const { record } = await updateHistory(root, chapters, proposal)
  const get = async (chapter, scene) => (await stageContext(root, chapters, chapter, scene)).scenes[0].characters
  assert.equal((await get('0002', 'later'))[0].history.length, 0)
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  assert.equal((await get('0002', 'later'))[0].history.length, 1)
  assert.equal((await get('0002', 'later'))[1].history.length, 0)
  assert.equal((await get('0001', 'first'))[0].history.length, 0)
  assert.equal((await get('0003', 'flashback'))[0].history.length, 0)
})

test('正文修改使记录失效，过期候选不得确认', async t => {
  const { root, chapters } = await fixture(t)
  const { record } = await updateHistory(root, chapters, proposal)
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  await fs.appendFile(path.join(root, 'chapters/0001.md'), '补充事实。')
  const context = await stageContext(root, chapters, '0002')
  assert.equal(context.scenes[0].characters[0].history.length, 0)
  assert.match(context.warnings.join(''), /待复核/)
  await assert.rejects(updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id }), /来源已变化/)
})

test('逐字证据、关系方向、引用与路径受到校验', async t => {
  const { root, chapters } = await fixture(t)
  await assert.rejects(updateHistory(root, chapters, { ...proposal, evidence: '编造的话' }), /逐字引文/)
  await assert.rejects(updateHistory(root, chapters, { ...proposal, character: '../escape' }), /ID/)
  await assert.rejects(updateHistory(root, chapters, { ...proposal, kind: '关系' }), /target/)
  const { record } = await updateHistory(root, chapters, { ...proposal, kind: '关系', target: 'b', content: '开始信任乙' })
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  const people = (await stageContext(root, chapters, '0002')).scenes[0].characters
  assert.equal(people[0].history[0].target, 'b')
  assert.equal(people[1].history.length, 0)
})

test('整场移动保持约束和 ID，原确认失效', async t => {
  const { root, chapters } = await fixture(t)
  const { record } = await updateHistory(root, chapters, proposal)
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  await moveScene(root, chapters, 'first', '0002')
  const context = await stageContext(root, chapters, '0002', 'first')
  assert.equal(context.scenes[0].id, 'first')
  assert.match(context.scenes[0].roles[0].constraints, /计划变化：怀疑旧约/)
  assert.equal((await stageContext(root, chapters, '0001')).scenes.length, 0)
  assert.match(context.warnings.join(''), /待复核/)
})

test('真实注册工具完成章纲→上下文→候选→确认闭环，预算必须保留认知边界', async t => {
  const { root } = await fixture(t)
  const tools = new Map()
  apply({ tools: { register: definition => tools.set(definition.name, definition) }, effect() {} }, { root })
  const call = (name, args) => tools.get(name).execute(args)
  const before = await call('novel_context', { chapter: '0002', scene: 'later', budget: 20000 })
  assert.ok(before.ready)
  assert.equal(before.stage.scenes.length, 1)
  assert.match(before.prompt, /未记录/)
  const { record } = await call('novel_character_history', proposal)
  await call('novel_character_history', { action: 'confirm', character: 'a', id: record.id })
  const after = await call('novel_context', { chapter: '0002', scene: 'later', budget: 20000 })
  assert.match(after.prompt, /已确认入场历史/)
  assert.match(after.prompt, /看到信物/)
  assert.equal(after.characters.length, 2)
  const small = await call('novel_context', { chapter: '0002', scene: 'later', budget: 300 })
  assert.equal(small.ready, false)
  const beats = await call('novel_beats', { chapter: '0001' })
  assert.ok(beats.beats.text.includes('first'))
})

test('同场各角色约束不互相污染，提及不作为出场', () => {
  const [scene] = parseScenes('### 场景 s：标题\n- 时序：1\n- 出场：a\n- 提及：b\n#### 人物 a\n- 未知：秘密\n')
  assert.deepEqual(scene.cast, ['a'])
  assert.deepEqual(scene.mentioned, ['b'])
})

test('同章前场确认可供后场继承，修正历史不抹去过去，撤销后重新计算', async t => {
  const { root, chapters } = await fixture(t)
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('## 0002 后续', '### 场景 second：后场\n- 时序：15\n- 出场：a\n#### 人物 a\n- 目标：核对误解\n\n## 0002 后续'))
  const { record } = await updateHistory(root, chapters, { ...proposal, kind: '误信', content: '乙拿走了信物' })
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  assert.equal((await stageContext(root, chapters, '0001', 'second')).scenes[0].characters[0].history[0].kind, '误信')
  const corrected = await updateHistory(root, chapters, { ...proposal, scene: 'second', supersedes: record.id })
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: corrected.record.id })
  const current = (await stageContext(root, chapters, '0002')).scenes[0].characters[0].history
  assert.equal(current.length, 1)
  assert.equal(current[0].kind, '已知')
  assert.equal((await stageContext(root, chapters, '0001', 'second')).scenes[0].characters[0].history[0].kind, '误信')
  await updateHistory(root, chapters, { action: 'revoke', character: 'a', id: corrected.record.id })
  assert.equal((await stageContext(root, chapters, '0002')).scenes[0].characters[0].history[0].kind, '误信')
})

test('HTTP 读取场景与候选、写入防护和不支持的方法', async t => {
  const { root } = await fixture(t)
  let handler
  apply({ tools: { register() {} }, effect: callback => callback(), webServer: { register: value => { handler = value.handler } } }, { root })
  const request = async (url, method = 'GET', payload, headers = {}) => {
    const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : [])
    Object.assign(req, { url, method, headers })
    let body = ''
    const res = { statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status }, end(value) { body += value || '' } }
    await handler(req, res)
    return { status: res.statusCode, body: JSON.parse(body) }
  }
  const stage = await request('/novel-api/stage?chapter=0002&scene=later')
  assert.equal(stage.status, 200)
  assert.equal(stage.body.scenes[0].id, 'later')
  assert.equal((await request('/novel-api/character-history', 'POST', proposal)).status, 403)
  const saved = await request('/novel-api/character-history', 'POST', proposal, { 'x-novel-action': '1' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.record.status, 'candidate')
  assert.equal((await request('/novel-api/character-history')).body.records.length, 1)
  assert.equal((await request('/novel-api/stage?chapter=0002', 'DELETE')).status, 405)
})
