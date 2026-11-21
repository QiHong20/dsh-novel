import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'
import { BEAT_SECTION_CHANGED, mutateBeatsFile, readBeats, writeBeatsBatch } from '../lib/beats.js'
import { BEAT_STRUCTURE_INVALID, validateBeatStructure } from '../lib/beat-structure.js'
import { editStageFields, moveScene } from '../stage.js'

const scene = (id, time = 10) => `### 场景 ${id}：${id}场景
- 时序：${time}
- 出场：a
- 冲突：追问来意
#### 人物 a
- 目标：问清来意
- 自定义备注：保留原文
`
const FIRST = scene('arrival')
const REMAINING = scene('remaining', 20)
const CHAPTER_BODY = `- 本章目标：建立疑虑
${FIRST}
${REMAINING}`
const FULL = `# 章纲

## 0001 初见

${CHAPTER_BODY}
## 0002 后续

${scene('later', 30)}`
const digest = text => createHash('sha256').update(text).digest('hex')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-remediation-step3-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const chapters = [
    { id: '0001', title: '初见', file: 'chapters/0001.md', status: 'draft' },
    { id: '0002', title: '后续', file: 'chapters/0002.md', status: 'planned' },
  ]
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '结构测试', chapters }))
  await fs.writeFile(path.join(root, 'chapters/0001.md'), '原有正文。\n')
  await fs.writeFile(path.join(root, 'beats.md'), FULL)
  const tools = new Map()
  let handler
  apply({
    tools: { register: definition => tools.set(definition.name, definition) },
    effect: fn => fn(),
    webServer: { register: value => { handler = value.handler } },
  }, { root })
  const call = (name, args = {}) => {
    const tool = tools.get(name)
    assert.ok(tool, `没有注册工具 ${name}`)
    return tool.execute(args)
  }
  const request = async (url, payload) => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
    Object.assign(req, { url, method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? {} : { 'x-novel-action': '1' } })
    let raw = ''
    const res = { statusCode: 200, writeHead(code) { this.statusCode = code }, end(value) { raw += value ? String(value) : '' } }
    await handler(req, res)
    return { status: res.statusCode, value: raw ? JSON.parse(raw) : null }
  }
  const read = () => fs.readFile(path.join(root, 'beats.md'), 'utf8')
  const render = (name, args, value) => tools.get(name).output.render(args, value).map(part => part.text).join('\n')
  return { root, chapters, call, request, read, render }
}

const invalidCases = [
  { name: '没有结构化场景', content: '- 本章目标：建立疑虑', code: 'chapter-scenes-required' },
  { name: '缺时序', change: value => value.replace('- 时序：10\n', ''), fields: { 时序: '' }, code: 'scene-time-required' },
  { name: '非法时序', change: value => value.replace('- 时序：10', '- 时序：明日'), fields: { 时序: '明日' }, code: 'scene-time-required' },
  { name: '时序超出安全整数', change: value => value.replace('- 时序：10', '- 时序：9007199254740993'), fields: { 时序: '9007199254740993' }, code: 'scene-time-required' },
  { name: '重复时序', change: value => value.replace('- 时序：10', '- 时序：10\n- 时序：11'), code: 'scene-time-required' },
  { name: '缺出场', change: value => value.replace('- 出场：a\n', ''), fields: { 出场: '' }, code: 'scene-cast-required' },
  { name: '空白出场', change: value => value.replace('- 出场：a', '- 出场：   '), fields: { 出场: '   ' }, code: 'scene-cast-required' },
  { name: '重复出场字段', change: value => value.replace('- 出场：a', '- 出场：a\n- 出场：a'), code: 'scene-cast-required' },
  { name: '重复出场人物', change: value => value.replace('- 出场：a', '- 出场：a、a'), fields: { 出场: 'a、a' }, code: 'scene-cast-duplicate' },
  { name: '出场者缺人物块', change: value => value.replace('- 出场：a', '- 出场：a、b'), fields: { 出场: 'a、b' }, code: 'scene-character-block-required' },
  { name: '重复人物块', change: value => value.replace('- 自定义备注：保留原文', '- 自定义备注：保留原文\n#### 人物 a\n- 目标：重复块'), code: 'scene-character-block-duplicate' },
  { name: '损坏的人物块标题', change: value => value.replace('- 自定义备注：保留原文', '- 自定义备注：保留原文\n#### 人物 b：说明\n- 目标：改写上一块'), code: 'scene-character-heading-invalid' },
  { name: '场景 ID 全书重复', change: value => value.replace('### 场景 arrival', '### 场景 later'), code: 'scene-id-duplicate' },
  { name: '场景标题为空', change: value => value.replace('### 场景 arrival：arrival场景', '### 场景 arrival：'), code: 'scene-heading-invalid' },
  { name: '合法场景混入损坏标题', change: value => `${value}\n### 场景 中文ID：损坏\n- 时序：40\n- 出场：a\n#### 人物 a\n`, code: 'scene-heading-invalid' },
  { name: '整章内容注入额外章标题', change: value => `${value}\n## 0009 注入章\n${scene('injected', 50)}`, code: 'chapter-heading-unexpected' },
]

for (const item of invalidCases) {
  test(`严格保存：${item.name}在工具与右栏得到一致拒绝`, async t => {
    const { call, request, read, render } = await fixture(t)
    const before = await read()
    const content = item.content ?? item.change(CHAPTER_BODY)
    const tool = await call('novel_beats', { chapter: '0001', content })
    const http = await request('/novel-api/beats', { chapter: '0001', content, baseHash: digest(before) })
    assert.equal(tool.ok, false)
    assert.equal(tool.written, false)
    assert.equal(tool.code, BEAT_STRUCTURE_INVALID)
    assert.equal(http.status, 400)
    assert.deepEqual(http.value.issues, tool.issues)
    assert.ok(tool.issues.some(issue => issue.code === item.code && issue.severity === 'error'))
    assert.match(render('novel_beats', {}, tool), /未写入/)
    assert.equal(await read(), before)
    if (item.fields) {
      const fields = await call('novel_stage_edit', { chapter: '0001', scene: 'arrival', fields: item.fields, baseHash: digest(before) })
      const fieldHttp = await request('/novel-api/beats', { chapter: '0001', scene: 'arrival', fields: item.fields, baseHash: digest(before) })
      assert.deepEqual(fields.issues, tool.issues)
      assert.equal(fieldHttp.status, 400)
      assert.deepEqual(fieldHttp.value.issues, tool.issues)
      assert.equal(await read(), before)
    }
  })
}

test('局部编辑按章纲匹配定位章节：制表符标题与无 ID 旧小节不会被算进上一章', async t => {
  const { root, call, read } = await fixture(t)
  const withTab = FULL.replace('## 0002 后续', '##\t0002 后续')
  await fs.writeFile(path.join(root, 'beats.md'), withTab)
  const result = await call('novel_stage_edit', { chapter: '0001', scene: 'later', fields: { 地点: '越界修改' }, baseHash: digest(withTab) })
  assert.equal(result.written, false)
  assert.equal(result.code, BEAT_SECTION_CHANGED)
  assert.equal(await read(), withTab)

  const withLegacy = withTab.replace('##\t0002 后续', '## 后续')
  await fs.writeFile(path.join(root, 'beats.md'), withLegacy)
  const legacy = await call('novel_stage_edit', { chapter: '0001', scene: 'later', fields: { 地点: '越界修改' }, baseHash: digest(withLegacy) })
  assert.equal(legacy.written, false)
  assert.equal(await read(), withLegacy)

  // 目标章本身仍可正常编辑：制表符标题按章 ID 匹配，不会被上一章的范围吞掉。
  await fs.writeFile(path.join(root, 'beats.md'), withTab)
  const own = await call('novel_stage_edit', { chapter: '0002', scene: 'later', fields: { 地点: '院内' }, baseHash: digest(withTab) })
  assert.equal(own.ok, true)
  assert.match(await read(), /- 地点：院内/u)
})

test('章名尾部空白不影响保存回执，文件与回执哈希一致', async t => {
  const { root, chapters, call, read } = await fixture(t)
  const spaced = { ...chapters[1], title: '后续  ' }
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '结构测试', chapters: [chapters[0], spaced] }))
  const result = await call('novel_beats', { chapter: '0002', content: scene('spaced', 40) })
  assert.equal(result.written, true)
  assert.equal(result.baseHash, digest(await read()))
  assert.match(result.beats.text, /spaced/u)
  assert.equal(result.chapter.title, '后续  ')
})

test('共享结构校验逐章检查，初始空文档合法，有章无场景非法', () => {
  assert.deepEqual(validateBeatStructure(''), [])
  assert.deepEqual(validateBeatStructure('# 章纲\n\n> 尚未规划\n'), [])
  assert.deepEqual(validateBeatStructure(FULL), [])
  const issues = validateBeatStructure(`${FULL}\n## 0003 待规划\n- 本章目标：探索\n`)
  assert.ok(issues.some(item => item.code === 'chapter-scenes-required' && item.chapter === '0003'))
})

test('合法写入回执的正文、场景和哈希来自实际保存内容', async t => {
  const { root, chapters, call, request, read } = await fixture(t)
  const content = `## 0001 初见\n\n${CHAPTER_BODY.replace('追问来意', '继续追问').replace('\n\n', '\n\n\n\n')}`
  const tool = await call('novel_beats', { chapter: '0001', content })
  assert.equal(tool.written, true)
  assert.equal(tool.baseHash, digest(await read()))
  const board = await readBeats(root, chapters[0], chapters)
  assert.equal(tool.beats.text, board.section.body)
  assert.equal(tool.beats.scenes[0].raw, board.section.scenes[0].raw)
  const http = await request('/novel-api/beats', { chapter: '0001', content: CHAPTER_BODY, baseHash: tool.baseHash })
  assert.equal(http.status, 200)
  assert.equal(http.value.baseHash, digest(await read()))
  assert.deepEqual(http.value.issues, [])
})

test('局部编辑保留 CRLF、自定义字段与其他章节，并允许删除可选字段', async t => {
  const { root, call, read } = await fixture(t)
  const before = FULL.replaceAll('\n', '\r\n')
  await fs.writeFile(path.join(root, 'beats.md'), before)
  const result = await call('novel_stage_edit', { chapter: '0001', scene: 'arrival', fields: { 冲突: '' }, baseHash: digest(before) })
  assert.equal(result.ok, true)
  const after = await read()
  assert.equal(after.slice(after.indexOf('## 0002')), before.slice(before.indexOf('## 0002')))
  assert.match(after, /- 自定义备注：保留原文\r\n/)
  assert.ok(!/(?<!\r)\n/u.test(after))
  assert.equal(result.baseHash, digest(after))
})

test('超出八场只返回 warning，工具、原文与字段入口口径一致', async t => {
  const { call, request, read } = await fixture(t)
  const content = Array.from({ length: 9 }, (_, index) => scene(`many-${index}`, index)).join('\n')
  const tool = await call('novel_beats', { chapter: '0001', content })
  assert.equal(tool.written, true)
  assert.equal(tool.issues[0].code, 'chapter-scene-limit')
  assert.equal(tool.issues[0].severity, 'warning')
  const http = await request('/novel-api/beats', { chapter: '0001', content, baseHash: digest(await read()) })
  assert.equal(http.status, 200)
  assert.deepEqual(http.value.issues, tool.issues)
  const fields = await call('novel_stage_edit', { chapter: '0001', scene: 'many-0', fields: { 地点: '院中' }, baseHash: digest(await read()) })
  assert.equal(fields.ok, true)
  assert.deepEqual(fields.issues, tool.issues)
  assert.deepEqual(fields.warnings, tool.warnings)
  const board = await request('/novel-api/beats')
  assert.ok(board.value.warnings.some(value => /超过 8 场/u.test(value)))
})

test('原文与字段提交的陈旧哈希优先返回 409，不被结构错误掩盖', async t => {
  const { root, call, request, read } = await fixture(t)
  const oldHash = digest(await read())
  const changed = FULL.replace('追问来意', '新版本追问')
  await fs.writeFile(path.join(root, 'beats.md'), changed)
  for (const payload of [
    { chapter: '0001', content: '- 本章目标：没有场景', baseHash: oldHash },
    { chapter: '0001', scene: 'arrival', fields: { 时序: '' }, baseHash: oldHash },
  ]) {
    const result = await request('/novel-api/beats', payload)
    assert.equal(result.status, 409)
    assert.equal(result.value.code, BEAT_SECTION_CHANGED)
    assert.match(result.value.error, /章纲已变化/)
  }
  const tool = await call('novel_stage_edit', { chapter: '0001', scene: 'arrival', fields: { 时序: '' }, baseHash: oldHash })
  assert.equal(tool.code, BEAT_SECTION_CHANGED)
  assert.equal(await read(), changed)
})

test('字段请求错误为 400，不冒充版本冲突', async t => {
  const { request, read } = await fixture(t)
  const before = await read()
  for (const fields of [null, [], '错误', { ID: '禁止改名' }, { 地点: '多行\n内容' }]) {
    const result = await request('/novel-api/beats', { chapter: '0001', scene: 'arrival', fields, baseHash: digest(before) })
    assert.equal(result.status, 400)
  }
  const missingHash = await request('/novel-api/beats', { chapter: '0001', content: CHAPTER_BODY })
  assert.equal(missingHash.status, 400)
  assert.equal(await read(), before)
})

test('低层批量保存校验完整候选，两端任一非法都不部分写入', async t => {
  const { root, chapters, read } = await fixture(t)
  const before = await read()
  await assert.rejects(writeBeatsBatch(root, [
    { chapter: chapters[0], content: '- 本章目标：缺场景' },
    { chapter: chapters[1], content: scene('replacement', 40) },
  ], chapters, digest(before)), error => error.code === BEAT_STRUCTURE_INVALID)
  assert.equal(await read(), before)
})

test('局部编辑不会因只修改目标章而漏掉其他章的非法结构', async t => {
  const { root, read } = await fixture(t)
  const before = `${FULL}\n## 0003 空章\n`
  await fs.writeFile(path.join(root, 'beats.md'), before)
  await assert.rejects(editStageFields(root, { chapter: '0001', scene: 'arrival', fields: { 地点: '门口' }, baseHash: digest(before) }), error => error.code === BEAT_STRUCTURE_INVALID)
  assert.equal(await read(), before)
})

test('整场移动校验最终全文，保留源章剩余场景与人物块', async t => {
  const { root, chapters, read } = await fixture(t)
  const result = await moveScene(root, chapters, 'arrival', '0002')
  assert.equal(result.moved, 'arrival')
  assert.equal(result.baseHash, digest(await read()))
  const board = await readBeats(root, null, chapters)
  assert.deepEqual(board.sections.find(item => item.id === '0001').scenes.map(item => item.id), ['remaining'])
  const moved = board.sections.find(item => item.id === '0002').scenes.find(item => item.id === 'arrival')
  assert.equal(moved.time, 10)
  assert.match(moved.roles[0].constraints, /自定义备注：保留原文/)
  assert.deepEqual(validateBeatStructure(await read()), [])
})

test('移走源章最后一场会使结构非法，整次移动拒绝且不删除章级字段', async t => {
  const { root, chapters, call, read } = await fixture(t)
  const before = FULL.replace(REMAINING, '')
  await fs.writeFile(path.join(root, 'beats.md'), before)
  await assert.rejects(moveScene(root, chapters, 'arrival', '0002'), error => error.code === BEAT_STRUCTURE_INVALID)
  const result = await call('novel_move_scene', { scene: 'arrival', chapter: '0002' })
  assert.equal(result.written, false)
  assert.equal(result.code, BEAT_STRUCTURE_INVALID)
  assert.equal(await read(), before)
})

test('共享事务不能通过回调绕过结构校验', async t => {
  const { root, read } = await fixture(t)
  const before = await read()
  await assert.rejects(mutateBeatsFile(root, () => ({ text: '## 0001 空章\n' })), error => error.code === BEAT_STRUCTURE_INVALID)
  assert.equal(await read(), before)
})
