import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('function assembleNovelContext(')
const end = source.indexOf('/** 禁忌分为', start)
const { assemble, select, edit } = vm.runInNewContext(`${source.slice(start, end)}; ({assemble:assembleNovelContext,select:rewriteSelection,edit:applyChapterEdit})`, { createHash })
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
