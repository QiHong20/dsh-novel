import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { parseScenes, presentationChecks, chapterOverview, patchStageText, hash, stageContext, updateHistory, moveScene } from '../stage.js'
import { apply } from '../index.js'
import { persistBook } from '../lib/book.js'

const chapterBody = `- 本章目标：建立疑虑
### 场景 encounter：初见
- 时序：10
- 视角：a
- 叙述方式：限知
- 出场：a、b
- 事件：main-1
- 冲突：主角追问，女主回避。
- 结果：主角决定等待。
#### 人物 a
- 目标：问清缘由
- 心理内容：想到父亲最后一次叮嘱。
- 表达方式：短暂联想
- 视角权限：可直接呈现
#### 人物 b
- 目标：隐瞒来意
- 心理内容：怕连累对方。
- 视角权限：仅作者参考
- 登场性质：首次正式登场
- 观察者：a
- 描写重点：高挑体态，磨旧的袖口。
- 呈现时机：她伸手接茶时。
- 自定义备注：这一行必须保留。
`
const full = `# 章纲
## 0001 初见
${chapterBody}
## 0002 后续
### 场景 later：重逢
- 时序：20
- 视角：a
- 出场：a、b
#### 人物 a
- 目标：等待
#### 人物 b
- 目标：解释
`

test('心理与登场按角色解析，一级摘要不泄露心理详情', () => {
  const [scene] = parseScenes(chapterBody)
  assert.equal(scene.roles[1].psychology.视角权限, '仅作者参考')
  assert.equal(scene.roles[1].appearance.描写重点, '高挑体态，磨旧的袖口。')
  const summary = chapterOverview(chapterBody)
  assert.equal(summary.fields.本章目标, '建立疑虑')
  assert.match(summary.scenes[0].summary, /主角追问/)
  assert.ok(!JSON.stringify(summary).includes('怕连累'))
  const checks = presentationChecks(scene, [{ id: 'b', importance: '重要' }])
  assert.ok(!checks.some(c => c.code === 'perspective'))
  assert.ok(checks.every(c => c.type === '语义待核对'))
})

test('缺省不强制心理；全知允许配角内心；初见例外不要求外貌扫描', () => {
  const [scene] = parseScenes(chapterBody)
  scene.roles[1].fields.视角权限 = '可直接呈现'
  assert.ok(presentationChecks(scene).some(c => c.code === 'perspective'))
  scene.narration = '全知'
  assert.ok(!presentationChecks(scene).some(c => c.code === 'perspective'))
  delete scene.roles[1].fields.描写重点
  scene.roles[1].fields.不描写原因 = '暗处，只听见声音'
  assert.ok(!presentationChecks(scene, [{ id: 'b', importance: '核心' }]).some(c => c.code === 'appearance-plan'))
  assert.deepEqual(presentationChecks(parseScenes('### 场景 s：过场\n- 出场：a\n#### 人物 a\n- 目标：离开')[0]), [])
})

test('局部编辑精确保留其他角色、其他章节、自定义字段及 CRLF；拒绝过期与结构注入', () => {
  const text = full.replaceAll('\n', '\r\n')
  const args = { chapter: '0001', scene: 'encounter', character: 'b', baseHash: hash(text), fields: { 心理内容: '担心秘密暴露。', 展开程度: '一闪而过' } }
  const changed = patchStageText(text, args)
  assert.ok(changed.includes('- 自定义备注：这一行必须保留。\r\n'))
  assert.equal(changed.slice(changed.indexOf('## 0002')), text.slice(text.indexOf('## 0002')))
  assert.equal(changed.slice(0, changed.indexOf('#### 人物 b')), text.slice(0, text.indexOf('#### 人物 b')))
  assert.ok(!/(?<!\r)\n/.test(changed))
  assert.throws(() => patchStageText(changed, args), /已变化/)
  assert.throws(() => patchStageText(text, { ...args, fields: { 心理内容: '新内容\n## 9999 注入' } }), /多行/)
  assert.throws(() => patchStageText(text, { ...args, fields: { ID: 'rename' } }), /不支持/)
  assert.throws(() => patchStageText(text, { ...args, character: 'missing' }), /人物块/)
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stage-v2-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const dir of ['characters', 'chapters']) await fs.mkdir(path.join(root, dir))
  const chapters = ['0001', '0002'].map(id => ({ id, title: id, file: `chapters/${id}.md` }))
  const chapterOne = '她伸手接茶，露出磨旧的袖口。\n他留在原地等待。'
  chapters[0].deaiReview = { baseHash: hash(chapterOne), scenes: [{ startIndex: 1, endIndex: 1, sceneId: 'encounter' }, { startIndex: 2, endIndex: 2, sceneId: 'remainder' }] }
  await persistBook(root, { title: '未命名作品' }, chapters)
  const planned = full.replace('## 0002 后续', '### 场景 remainder：留守\n- 时序：15\n- 出场：a\n#### 人物 a\n- 目标：等待\n\n## 0002 后续')
  await fs.writeFile(path.join(root, 'beats.md'), planned)
  await fs.writeFile(path.join(root, 'events.md'), '## main：主线\n### main-1 初见\n- 目标：结识\n')
  for (const id of ['a', 'b']) await fs.writeFile(path.join(root, 'characters', `${id}.md`), `# ${id}\n- ID：${id}\n- 定位：重要配角\n- 重要程度：重要`)
  for (const c of chapters) await fs.writeFile(path.join(root, c.file), c.id === '0001' ? chapterOne : '她再次出现。')
  return { root, chapters }
}

test('实际工具装配保留心理权限与外貌计划，语义核对不作为机械错误，呈现不成为角色认知', async t => {
  const { root, chapters } = await fixture(t)
  const tools = new Map()
  apply({ tools: { register: def => tools.set(def.name, def) }, effect() {} }, { root })
  const context = await tools.get('novel_context').execute({ chapter: '0001', scene: 'encounter', budget: 20000 })
  assert.ok(context.ready)
  assert.match(context.prompt, /仅作者参考/)
  assert.match(context.prompt, /高挑体态/)
  assert.match(context.prompt, /不设数量和密度配额/)
  const check = await tools.get('novel_check').execute({ chapter: '0001' })
  assert.ok(check.presentationReview.length > 0)
  assert.ok(!check.issues.some(i => ['no-interior', 'no-interior-plan', 'psychology-plan'].includes(i.kind)))
  tools.get('novel_check').output.render({}, check)
  const { record } = await updateHistory(root, chapters, { action: 'propose', character: 'b', scene: 'encounter', kind: '呈现', content: '读者看见磨旧的袖口', source: '正文描写', evidence: '露出磨旧的袖口。', evidenceIndex: 1 })
  assert.equal((await stageContext(root, chapters, '0002')).scenes[0].characters[1].presented.length, 0)
  await updateHistory(root, chapters, { action: 'confirm', character: 'b', id: record.id })
  const later = (await stageContext(root, chapters, '0002')).scenes[0].characters[1]
  assert.equal(later.presented.length, 1)
  assert.equal(later.history.length, 0)
  await moveScene(root, chapters, 'encounter', '0002')
  const moved = (await stageContext(root, chapters, '0002', 'encounter')).scenes[0]
  assert.equal(moved.roles[1].psychology.视角权限, '仅作者参考')
  assert.equal(moved.roles[1].appearance.呈现时机, '她伸手接茶时。')
})

test('HTTP 局部编辑使用版本锁且保留正文，读取返回派生视图而不是第二份章纲', async t => {
  const { root } = await fixture(t)
  let handler
  apply({ tools: { register() {} }, effect: fn => fn(), webServer: { register: value => { handler = value.handler } } }, { root })
  const request = async (url, payload) => {
    const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : [])
    Object.assign(req, { url, method: payload ? 'POST' : 'GET', headers: { 'x-novel-action': '1' } })
    let raw = ''
    const res = { statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status }, end(value) { raw += value || '' } }
    await handler(req, res)
    return { status: res.statusCode, value: JSON.parse(raw) }
  }
  const board = (await request('/novel-api/beats')).value
  assert.equal(board.sections[0].overview.cast.length, 2)
  const payload = { chapter: '0001', scene: 'encounter', character: 'b', baseHash: board.baseHash, fields: { 心理内容: '不愿牵连对方。' } }
  assert.equal((await request('/novel-api/beats', payload)).status, 200)
  assert.equal((await request('/novel-api/beats', payload)).status, 409)
  assert.equal(await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8'), '她伸手接茶，露出磨旧的袖口。\n他留在原地等待。')
  assert.match((await request('/novel-api/stage?chapter=0001')).value.scenes[0].characters[1].constraints, /不愿牵连/)
})
