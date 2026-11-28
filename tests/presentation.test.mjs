import test from 'node:test'
import assert from 'node:assert/strict'
import { presentationContext, selectPresentationExcerpts, renderPresentationExcerpts } from '../lib/presentation.js'

test('空锚点获得指导，已有要求不被生成的情绪取代，局部改写明确范围', () => {
  const text = presentationContext({ scenes: [{ id: 's1', title: '见面', viewpoint: 'a', characters: [
    { id: 'a', name: '甲', fields: {} },
    { id: 'b', name: '乙', fields: { 描写重点: '衣袖', 心理内容: '犹疑', 表达意图: '劝退' } },
  ] }] }, [], true)
  assert.match(text, /甲.*从目标、认知与关系依据推演/)
  assert.match(text, /乙.*已有表现字段/)
  assert.match(text, /只修改选定片段/)
  assert.match(text, /没有呈现记录不代表从未描写/)
  assert.match(text, /非视角人物资料仅供作者参考/)
})

test('旧章纲不伪造场景，仍提供表现指导', () => {
  assert.match(presentationContext({}, [{ name: '甲' }]), /不能可靠划分场景.*相关人物：甲/)
})

test('原文候选保留语境和来源，限制总量且不截断原段', () => {
  const chapters = [{ id: '0001', title: '旧事', text: '前因。\n\n甲拒绝了邀请。\n\n后来他又改变主意。' }]
  const rows = selectPresentationExcerpts(chapters, ['甲'], 100)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chapter, '0001')
  assert.match(rows[0].text, /后来他又改变主意/)
  assert.deepEqual(selectPresentationExcerpts(chapters, ['甲'], 5), [])
  assert.match(renderPresentationExcerpts(rows), /同段出现不证明直接互动/)
  assert.deepEqual(selectPresentationExcerpts(chapters, ['乙']), [])
})

test('检索优先近期且相邻原文不重复', () => {
  const rows = selectPresentationExcerpts([
    { id: '1', text: '甲：旧事。' },
    { id: '2', text: '甲：你好。\n\n乙：你好。\n\n甲：走吧。' },
  ], ['甲', '乙'])
  assert.equal(rows[0].chapter, '2')
  assert.equal(rows.filter(r => r.chapter === '2').length, 1)
})

test('只回看最近两章，更早的原文不进候选', () => {
  const chapters = [
    { id: '0001', text: '甲在很早以前来过一次。' },
    { id: '0002', text: '甲当时还没钱。' },
    { id: '0003', text: '甲掏出了钱。' },
  ]
  const rows = selectPresentationExcerpts(chapters, ['甲'])
  assert.deepEqual([...new Set(rows.map(row => row.chapter))], ['0003', '0002'])
  assert.ok(rows.every(row => row.chapter !== '0001'))
  assert.deepEqual([...new Set(selectPresentationExcerpts(chapters, ['甲'], 12000, 1).map(row => row.chapter))], ['0003'])
  assert.equal(selectPresentationExcerpts(chapters, ['甲'], 12000, 0).length > 0, true, '0 表示不限章数')
})
