import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { grill, renderGrill } from '../lib/grill.js'
import { apply } from '../index.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-grill-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'characters'))
  await fs.writeFile(path.join(root, 'characters/甲.md'), '# 甲\n怕死。')
  const tools = new Map()
  apply({ tools: { register: d => tools.set(d.name, d) }, effect() {} }, { root })
  return { root, call: args => tools.get('novel_grill').execute(args) }
}
const question = { basis: '人物卡写他怕死，但剧情中救人。', text: '他为何冒险？', options: [{ label: '保护朋友', effect: '关系胜过恐惧' }, { label: '争取利益', effect: '要写明收益和退路' }] }
const update = (v, action, extra = {}) => ({ id: v.session.id, baseHash: v.baseHash, action, ...extra })

test('真实工具多轮访谈支持选项、自定义、暂停恢复和草案；正式资料不变', async t => {
  const { root, call } = await fixture(t)
  let v = await call({ action: 'start', mode: 'character', topic: '怕死的主角', sources: ['characters/甲.md'] })
  assert.equal(v.session.depth, 'deep')
  assert.match(v.sources[0].text, /怕死/)
  v = await call(update(v, 'ask', { question }))
  assert.match(renderGrill(v), /自定义/)
  const q = v.session.questions[0].id
  await assert.rejects(call(update(v, 'ask', { question })), /尚待回答/)
  v = await call(update(v, 'answer', { questionId: q, answer: '不是朋友，是他欠过一条命。', disposition: 'decided' }))
  v = await call(update(v, 'pause'))
  await assert.rejects(call(update(v, 'ask', { question })), /未进行中/)
  v = await grill(root, { action: 'inspect', id: v.session.id })
  assert.equal(v.session.status, 'paused')
  v = await call(update(v, 'resume'))
  v = await call(update(v, 'ask', { question: { ...question, text: '他愿意付出多大的代价？' } }))
  v = await call(update(v, 'answer', { questionId: v.session.questions[1].id, answer: '这点先留白。', disposition: 'deferred' }))
  const draft = { decisions: [{ questionId: q, quote: '欠过一条命', content: '救人是为了还债。' }], openQuestions: ['代价未定'], content: '# 甲\n救人还债。' }
  v = await call(update(v, 'summarize', { draft }))
  assert.equal(v.session.status, 'active')
  v = await call(update(v, 'finish', { draft }))
  assert.equal(v.session.status, 'drafted')
  assert.equal(v.session.draft.unresolved.length, 1)
  assert.equal(await fs.readFile(path.join(root, 'characters/甲.md'), 'utf8'), '# 甲\n怕死。')
  assert.equal((await call({ action: 'list' })).sessions.length, 1)
})

test('候选不得成为决定，改答使下游及草案失效，资料变化必须核对', async t => {
  const { root, call } = await fixture(t)
  let v = await call({ action: 'start', mode: 'plot', topic: '救人', sources: ['characters/甲.md'] })
  v = await call(update(v, 'ask', { question }))
  const q = v.session.questions[0].id
  v = await call(update(v, 'answer', { questionId: q, selected: ['A', 'B'], answer: '都行，尚未决定。' }))
  const draft = { decisions: [{ questionId: q, quote: '都行', content: '保护朋友。' }], openQuestions: [] }
  await assert.rejects(call(update(v, 'finish', { draft })), /明确决定/)
  v = await call(update(v, 'ask', { question: { ...question, text: '先考虑退路？' } }))
  v = await call(update(v, 'revise', { questionId: q, answer: '为了还债。', disposition: 'decided' }))
  assert.ok(v.session.questions[1].needsReview)
  const corrected = { decisions: [{ questionId: q, quote: '还债', content: '救人为还债。' }], openQuestions: ['退路待定'] }
  await assert.rejects(call(update(v, 'finish', { draft: corrected })), /改答影响/)
  await fs.appendFile(path.join(root, 'characters/甲.md'), '\n改成勇敢。')
  v = await call({ action: 'inspect', id: v.session.id })
  assert.deepEqual(v.changedSources, ['characters/甲.md'])
  await assert.rejects(call(update(v, 'finish', { draft: corrected, note: '已核对改答' })), /资料发生变化/)
  v = await call(update(v, 'refresh', { note: '新人物卡仍不改变还债动机。' }))
  v = await call(update(v, 'finish', { draft: corrected, note: '退路仍留白。' }))
  assert.equal(v.session.status, 'drafted')
})

test('版本锁防止并发丢答案，限制资料路径和问题选项', async t => {
  const { call } = await fixture(t)
  await assert.rejects(call({ action: 'start', mode: 'character', topic: '甲', sources: ['../outside.md'] }), /资料路径/)
  let v = await call({ action: 'start', mode: 'character', topic: '甲' })
  await assert.rejects(call(update(v, 'ask', { question: { ...question, options: [] } })), /2–4/)
  const old = v
  v = await call(update(v, 'ask', { question }))
  await assert.rejects(call(update(old, 'pause')), /已变化/)
  const answer = update(v, 'answer', { questionId: v.session.questions[0].id, answer: 'A', selected: ['A'], disposition: 'decided' })
  const results = await Promise.allSettled([call(answer), call(answer)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  await assert.rejects(call({ action: 'inspect', id: '../escape' }), /ID 无效/)
})
