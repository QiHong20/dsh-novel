import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBeatInfos, parseBeatInteriors, parseBeatCognition } from '../lib/beats.js'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('function assembleNovelContext(')
const end = source.indexOf('/** 禁忌分为', start)
const { assemble, select, edit, contextArgs, beatScope } = vm.runInNewContext(
  `${source.slice(start, end)}; ({assemble:assembleNovelContext,select:rewriteSelection,edit:applyChapterEdit,contextArgs:contextRequestArgs,beatScope:contextBeatScope})`,
  { createHash, parseBeatInfos, parseBeatInteriors, parseBeatCognition },
)
const fixture = text => {
  const selected = select(text)
  return { mode: 'rewrite', chapter: { id: '0001', title: '测试', target: 3000 }, chapterText: selected.text, rewriteScope: selected.scope,
    beats: { text: '保留全部事实' }, rewriteRules: '', style: { name: '测试', text: '限知视角', omitted: [] },
    characters: [], settings: [], spine: [], prevTail: { text: '' }, outline: '', threads: [], aiTone: [], warnings: [] }
}

test('长章完整输入，预算不足时不返回可覆盖的残缺正文', () => {
  const text = '正文。'.repeat(2400) + '\r\n末尾不可丢失😀'
  const full = assemble(fixture(text), 20000)
  assert.equal(full.ready, true)
  assert.ok(full.prompt.includes(text))
  assert.equal(full.budgetUsed, Array.from(full.prompt).length)
  const blocked = assemble(fixture(text), 6000)
  assert.equal(blocked.ready, false)
  assert.equal(blocked.chapterText, '')
  assert.ok(blocked.prompt.includes('rewriteStart'))
  assert.ok(blocked.budgetUsed <= 6000)
})

test('预览请求传递场景、模式和局部范围，默认预算仍由工具决定', () => {
  const defaults = contextArgs(new URLSearchParams({ chapter: '0001' }))
  assert.equal(defaults.mode, 'continue')
  assert.equal(defaults.budget, undefined)
  const scoped = contextArgs(new URLSearchParams('chapter=0001&scene=proof&mode=rewrite&rewriteStart=0&rewriteLimit=200&pass=deai'))
  assert.equal(scoped.scene, 'proof')
  assert.equal(scoped.mode, 'rewrite')
  assert.equal(scoped.rewriteStart, 0)
  assert.equal(scoped.rewriteLimit, 200)
  assert.equal(scoped.pass, 'deai')
  assert.throws(() => contextArgs(new URLSearchParams('chapter=0001&budget=')), /整数/u)
})

test('第一章后续场景只显示本场装配，跳过开篇纪律', () => {
  const value = { ...fixture(''), mode: 'continue', scene: { id: 'proof', title: '当众验炉', opening: false } }
  value.beats = { text: '核对炉壁砂眼。', interiors: [{ text: '对方在等他出错。' }] }
  const result = assemble(value, 8000)
  assert.equal(result.ready, true)
  assert.match(result.prompt, /当众验炉/u)
  assert.match(result.prompt, /本次只处理选定场景/u)
  assert.match(result.prompt, /对方在等他出错/u)
  assert.ok(!result.prompt.includes('第一章开篇纪律'))
})

test('分场装配保留章级认知，按选中场景提取心理和信息', () => {
  const first = '### 场景 start：开场\n- 心理：陌生人的来意不明。'
  const second = '### 场景 proof：验炉\n- 信息：炉壁有砂眼。\n- 心理：掌柜在等他出错。'
  const body = `- 认知：陆昭不公开自己的来历。\n\n${first}\n\n${second}`
  const result = beatScope({ body }, { title: '验炉', raw: second })
  assert.equal(result.heading, '验炉')
  assert.equal(result.cognition[0].text, '陆昭不公开自己的来历。')
  assert.equal(result.interiors[0].text, '掌柜在等他出错。')
  assert.equal(result.infos[0].text, '炉壁有砂眼。')
  assert.ok(!result.text.includes('陌生人的来意'))
})

test('总预算含标题和指令，完整省略可选材料', () => {
  const value = fixture('原文')
  value.characters = [{ name: '甲', content: '人物资料'.repeat(500) }]
  const result = assemble(value, 1000)
  assert.equal(result.ready, true)
  assert.ok(result.budgetUsed <= 1000)
  assert.ok(result.omitted.some(item => item.id === 'character-0'))
  assert.ok(!result.prompt.includes('人物资料'))
  assert.ok(result.prompt.includes('人物：甲'))
})

test('局部修改精确保留前后文、CRLF及 Unicode，并拒绝过期稿件', () => {
  const text = '前言😀\r\n待改文字\r\n后文不动'
  const selected = select(text, 5, 4)
  assert.equal(selected.text, '待改文字')
  const args = { mode: 'patch', ...selected.scope, content: '改好了' }
  assert.equal(edit(text, args), '前言😀\r\n改好了\r\n后文不动')
  assert.throws(() => edit(text + '新内容', args), /已变化/)
  assert.throws(() => edit(text, { ...args, baseHash: '' }), /已变化|baseHash/)
  assert.throws(() => edit(text, { ...args, end: 999 }), /范围无效/)
  assert.throws(() => edit(text, { mode: 'replace', baseHash: '旧稿', content: '覆盖' }), /已变化/)
})

test('极小预算有明确后续操作，片段索引校验', () => {
  const result = assemble(fixture('正文'.repeat(300)), 300)
  assert.equal(result.ready, false)
  assert.ok(result.budgetUsed <= 300)
  assert.throws(() => select('正文', 3, 1), /范围/)
  assert.throws(() => select('正文', 0, 0), /正整数/)
})

test('表现包启用后人物卡必须完整装配，预算不足明确拒绝', () => {
  const value = fixture('原文')
  value.presentation = '从目标、认知与关系推演关键选择，不补造事实。'
  value.characters = [{ name: '甲', content: '完整人物资料'.repeat(1000) }]
  value.presentationExcerpts = '前文候选'.repeat(200)
  const blocked = assemble(value, 3000)
  assert.equal(blocked.ready, false)
  const ready = assemble(value, 20000)
  assert.equal(ready.ready, true)
  assert.ok(ready.prompt.includes(value.characters[0].content))
  assert.ok(ready.prompt.includes(value.presentationExcerpts))
  assert.equal(ready.budgetUsed, Array.from(ready.prompt).length)
})


test('完整模式的事件不能被预算静默省略，包指纹可复现', () => {
  const value = { ...fixture('原文'), full: true, spine: [{ id: 'e1', title: '必须交代', because: '前因'.repeat(2000), so: '后果' }] }
  assert.equal(assemble(value, 3000).ready, false)
  const result = assemble(value, 20000)
  assert.equal(result.ready, true)
  assert.equal(result.omitted.length, 0)
  assert.match(result.prompt, /必须交代/u)
  assert.equal(result.packHash, assemble(value, 20000).packHash)
  assert.equal(result.selfContained, false)
})

test('伏笔按书目截断，保留逾期，未知实际回收日期不推断', () => {
  const from = source.indexOf('function contextThreads(')
  const to = source.indexOf('function assembleNovelContext(', from)
  const scope = vm.runInNewContext(source.slice(from, to) + '; contextThreads')
  const chapters = ['z', 'a', 'q'].map(id => ({ id }))
  const result = scope([
    { thread: '未来', planted: 'q', payoff: '', status: 'open', open: true },
    { thread: '逾期', planted: 'z', payoff: 'z', status: 'open', open: true },
    { thread: '未知回收', planted: 'z', payoff: 'q', status: 'done', open: false },
    { thread: '后章回收', planted: 'z', payoff: 'q', status: 'q', open: true },
  ], chapters, 'a')
  assert.deepEqual(Array.from(result.rows, r => r.thread), ['逾期', '后章回收'])
  assert.match(result.rows[0].scope, /逾期/u)
  assert.equal(result.missing.length, 1)
})
