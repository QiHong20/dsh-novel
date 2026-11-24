import test from 'node:test'
import assert from 'node:assert/strict'
import { priorContext } from '../lib/prior-context.js'
import { hash } from '../lib/beat-structure.js'

function fixture() {
  const scenes = [{ id: 'early', chapter: '0001', time: 10, raw: '早场' }, { id: 'late', chapter: '0001', time: 30, raw: '晚场' }, { id: 'target', chapter: '0002', time: 40, raw: '目标' }]
  const text = '甲收到钥匙。\n\n甲在三十日后开门。'
  const chapters = [{ id: '0001', title: '前章', deaiReview: { baseHash: hash(text), scenes: [{ sceneId: 'early', startIndex: 1, endIndex: 1 }, { sceneId: 'late', startIndex: 2, endIndex: 2 }], priorSceneBindings: { early: hash('早场'), late: hash('晚场') } } }, { id: '0002', title: '本章' }]
  return { scenes, chapters, sources: new Map([['0001', text]]) }
}

test('正常承接返回真实相邻场，前文命中保留段落及版本，不重复尾段', () => {
  const book = fixture(), result = priorContext(book, [book.scenes[2]], ['甲'])
  assert.equal(result.tail.scene, 'late')
  assert.equal(result.tail.text, '甲在三十日后开门。')
  assert.equal(result.excerpts.length, 1)
  assert.equal(result.excerpts[0].scene, 'early')
  assert.equal(result.excerpts[0].sourceHash, book.chapters[0].deaiReview.baseHash)
  assert.equal(result.status, 'scene-time-filtered')
})

test('倒叙不携带故事未来段，也不把更早段伪装成相邻结尾', () => {
  const book = fixture(); book.scenes[2].time = 20
  const result = priorContext(book, [book.scenes[2]], ['甲'])
  assert.equal(result.tail.text, '')
  assert.equal(result.excerpts[0].text, '甲收到钥匙。')
  assert.equal(result.excluded[0].scene, 'late')
  assert.ok(!JSON.stringify(result.excerpts).includes('三十日后'))
})

test('正文改动、场景改动和旧分场缺少版本绑定均不继承', () => {
  for (const change of [b => b.sources.set('0001', '改稿'), b => { b.scenes[0].raw += '变更'; b.scenes[1].raw += '变更' }, b => { delete b.chapters[0].deaiReview.priorSceneBindings }]) {
    const book = fixture(); change(book)
    const result = priorContext(book, [book.scenes[2]], ['甲'])
    assert.equal(result.tail.text, '')
    assert.equal(result.excerpts.length, 0)
    assert.equal(result.status, 'incomplete')
  }
})

test('同章前场可承接，目标及后场不进入；预算不足不截断段落', () => {
  const book = fixture()
  const result = priorContext(book, [book.scenes[1]], ['甲'])
  assert.equal(result.tail.scene, 'early')
  assert.ok(!JSON.stringify(result.excerpts).includes('三十日后'))
  const tiny = priorContext(book, [book.scenes[1]], ['甲'], 1)
  assert.equal(tiny.tail.text, '')
  assert.ok(tiny.missing.length > 0)
})

test('缺少分场的已写前章必须报告，即使人物姓名没有命中', () => {
  const book = fixture(); book.scenes = book.scenes.slice(2)
  const result = priorContext(book, book.scenes, ['乙'])
  assert.equal(result.status, 'incomplete')
  assert.match(result.missing.join(' '), /完整正文分场/u)
})
