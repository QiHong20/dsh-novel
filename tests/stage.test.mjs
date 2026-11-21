import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stageBook, stageContext, updateHistory, moveScene, parseScenes, hash } from '../stage.js'
import { apply } from '../index.js'
import { Readable } from 'node:stream'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const dir of ['characters', 'chapters']) await fs.mkdir(path.join(root, dir))
  const chapterOne = '甲看见信物。乙只听说有人失踪。'
  const chapters = ['0001', '0002', '0003'].map(id => ({ id, title: id, file: `chapters/${id}.md` }))
  chapters[0].deaiReview = { baseHash: hash(chapterOne), scenes: [{ startIndex: 1, endIndex: 1, sceneId: 'first' }] }
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '测试', chapters }))
  for (const c of chapters) await fs.writeFile(path.join(root, c.file), c.id === '0001' ? chapterOne : '')
  for (const [id, name] of [['a', '甲'], ['b', '乙']]) await fs.writeFile(path.join(root, 'characters', `${name}.md`), `# ${name}\n- ID：${id}\n- 定位：重要配角\n- 重要程度：重要\n## 作者侧秘密\n真实身份不可当成角色已知。`)
  const scene = (id, time, cast = 'a、b') => `### 场景 ${id}：对质\n- 时序：${time}\n- 出场：${cast}\n- 提及：不在场的人\n- 冲突：追问信物\n#### 人物 a\n- 未知：幕后主使\n- 目标：查清真相\n- 触发：看到信物\n- 计划变化：怀疑旧约\n`
  await fs.writeFile(path.join(root, 'beats.md'), `## 0001 开场\n${scene('first', 10)}\n## 0002 后续\n${scene('later', 20)}\n## 0003 倒叙\n${scene('flashback', 5)}`)
  return { root, chapters }
}
const proposal = { action: 'propose', character: 'a', scene: 'first', kind: '已知', content: '看到信物', source: '亲眼看见', evidence: '甲看见信物。', evidenceIndex: 1 }

test('已登记章出现重复 ID 时保留歧义诊断，不把两份小节场景都载入', async t => {
  const { root, chapters } = await fixture(t)
  const file = path.join(root, 'beats.md')
  const text = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, text.replace('## 0003 倒叙\n', '## 0002 后续副本\n### 场景 duplicated：重复\n- 时序：99\n- 出场：a\n#### 人物 a\n- 目标：重复\n\n## 0003 倒叙\n'))
  const context = await stageContext(root, chapters, '0002')
  assert.equal(context.scenes.length, 0, '歧义章节不能载入任一小节的场景')
  assert.match(context.warnings.join('\n'), /请核对并为目标小节保留唯一章 ID/u)
  const book = await stageBook(root, chapters)
  assert.ok(!book.scenes.some(scene => scene.id === 'later' || scene.id === 'duplicated'), '歧义章节的场景不能进入全书场景表')
  await assert.rejects(
    updateHistory(root, chapters, { ...proposal, character: 'a', scene: 'duplicated', evidence: '甲看见信物。' }),
    /唯一场景/u,
    '人物历史不能依据歧义章节登记',
  )
  // 书目之外的数字小节仍保留，用于诊断陈旧章纲。
  await fs.writeFile(file, `${text}\n## 0009 未登记\n### 场景 orphan：遗留\n- 时序：99\n- 出场：a\n#### 人物 a\n- 目标：遗留\n`)
  assert.ok((await stageBook(root, chapters)).scenes.some(scene => scene.id === 'orphan'))
})

test('场景读取与局部编辑共用章纲匹配：制表符与无 ID 标题不会归入上一章', async t => {
  const { root, chapters } = await fixture(t)
  const file = path.join(root, 'beats.md')
  const text = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, text.replace('## 0002 后续', '##\t0002 后续'))
  const first = await stageContext(root, chapters, '0001')
  assert.ok(!first.scenes.some(item => item.id === 'later'), '制表符标题所属场景不能算进上一章')
  assert.ok((await stageContext(root, chapters, '0002')).scenes.some(item => item.id === 'later'))
  const renamed = chapters.map(chapter => chapter.id === '0002' ? { ...chapter, title: '后续' } : chapter)
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '测试', chapters: renamed }))
  await fs.writeFile(file, text.replace('## 0002 后续', '## 后续'))
  assert.ok(!(await stageContext(root, renamed, '0001')).scenes.some(item => item.id === 'later'))
  assert.ok((await stageContext(root, renamed, '0002')).scenes.some(item => item.id === 'later'), '唯一无 ID 旧标题仍按标题认领')
})

test('场景诊断按章节和场景归属过滤，不依赖 ID 前缀；全局冲突保留', async t => {
  const { root, chapters } = await fixture(t)
  const chapter = await stageContext(root, chapters, '0001')
  assert.ok(chapter.warnings.some(w => w.startsWith('first：')))
  assert.ok(!chapter.warnings.some(w => /later：|flashback：/.test(w)))
  assert.ok(!chapter.text.includes('later：'))
  await fs.appendFile(path.join(root, 'beats.md'), '\n### 场景 first：重复\n- 时序：99\n')
  assert.ok((await stageContext(root, chapters, '0002')).warnings.some(w => /场景 ID 缺失或重复/.test(w)))
})

test('真实检查将历史覆盖与表现清单移出问题计数，首场历史不靠事后登记清零', async t => {
  const { root, chapters } = await fixture(t)
  const file = path.join(root, 'beats.md')
  // Remove the flashback so first really has no earlier scene in story time.
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).split('## 0003')[0].replace('- 目标：查清真相', '- 心理内容：犹疑\n- 视角权限：仅作者参考\n- 目标：查清真相'))
  const tools = new Map()
  apply({ tools: { register: definition => tools.set(definition.name, definition) }, effect() {} }, { root })
  const tool = tools.get('novel_check')
  const report = await tool.execute({ chapter: '0001' })
  assert.equal(report.historyCoverage.length, 2)
  assert.ok(report.historyCoverage.every(r => r.status === 'no-prior-scene'))
  assert.equal(report.presentationReview.length, 1)
  assert.ok(!report.issues.some(r => r.kind === 'stage-history-gap'))
  assert.ok(!report.issues.some(r => r.detail.includes('later：')))
  const rendered = JSON.stringify(tool.output.render({}, report))
  assert.match(rendered, /人物表现审阅清单/)
  assert.doesNotMatch(rendered, /表现安排待核对/)
  const { record } = await updateHistory(root, chapters, proposal)
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  const first = await stageContext(root, chapters, '0001')
  const later = await stageContext(root, chapters, '0002')
  assert.equal(first.scenes[0].characters[0].historyStatus, 'no-prior-scene')
  assert.equal(later.scenes[0].characters[0].historyStatus, 'recorded')
  assert.equal(later.scenes[0].characters[1].historyStatus, 'unrecorded')
})

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
  const file = path.join(root, 'beats.md')
  const { record } = await updateHistory(root, chapters, proposal)
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  const original = (await fs.readFile(file, 'utf8')).replaceAll('- 计划变化：怀疑旧约\n', '- 计划变化：怀疑旧约\n#### 人物 b\n- 目标：隐瞒真相\n')
  await fs.writeFile(file, original.replace('## 0002 后续', '### 场景 remaining：留守\n- 时序：15\n- 出场：a\n#### 人物 a\n- 目标：留守\n\n## 0002 后续'))
  await moveScene(root, chapters, 'first', '0002')
  const context = await stageContext(root, chapters, '0002', 'first')
  assert.equal(context.scenes[0].id, 'first')
  assert.match(context.scenes[0].roles[0].constraints, /计划变化：怀疑旧约/)
  assert.deepEqual((await stageContext(root, chapters, '0001')).scenes.map(scene => scene.id), ['remaining'])
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
  const body = '甲看见信物。\n甲随后发现信物是假的。'
  await fs.writeFile(path.join(root, 'chapters/0001.md'), body)
  chapters[0].deaiReview = { baseHash: hash(body), scenes: [{ startIndex: 1, endIndex: 1, sceneId: 'first' }, { startIndex: 2, endIndex: 2, sceneId: 'second' }] }
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '测试', chapters }))
  const { record } = await updateHistory(root, chapters, { ...proposal, kind: '误信', content: '乙拿走了信物' })
  await updateHistory(root, chapters, { action: 'confirm', character: 'a', id: record.id })
  assert.equal((await stageContext(root, chapters, '0001', 'second')).scenes[0].characters[0].history[0].kind, '误信')
  const corrected = await updateHistory(root, chapters, { ...proposal, scene: 'second', content: '信物其实是假的', evidence: '甲随后发现信物是假的。', evidenceIndex: 2, supersedes: record.id })
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
