import test from 'node:test'
import { loadBook } from '../lib/book.js'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { parseScenes } from '../lib/beat-structure.js'
import { presentationRequirements, validatePresentationReviews, presentationReviewView } from '../lib/presentation-review.js'
import { stageContext } from '../stage.js'

const plan = '## 0001 开场\n### 场景 first：守门\n- 时序：10\n- 出场：a\n- 视角：a\n- 叙述方式：限知\n#### 人物 a\n- 必须表现：他决定留在门边。\n- 心理内容：担心来人。\n- 描写重点：手掌\n'
const requirements = () => presentationRequirements(parseScenes(plan, '0001'))
const response = r => ({ id: r.id, fingerprint: r.fingerprint, verdict: 'supported', detail: '正文写他留在门边。', counterargument: '留守不证明完全不担心，不额外解释心理。', evidence: [{ source: 'chapter', index: 1, quote: '他守在门边。' }] })

test('明确要求必答，可选心理和外貌不必写进正文；错场、重复、旧版本均拒绝', () => {
  const reqs = requirements(), required = reqs.find(r => r.required)
  assert.equal(reqs.filter(r => r.required).length, 1)
  const ranges = [{ sceneId: 'first', startIndex: 1, endIndex: 1 }]
  const paragraphs = [{ index: 1, text: '他守在门边。' }, { index: 2, text: '他守在门边。' }]
  assert.throws(() => validatePresentationReviews(reqs, [], ranges, paragraphs), /未核对/u)
  assert.equal(validatePresentationReviews(reqs, [response(required)], ranges, paragraphs).findings.length, 0)
  assert.throws(() => validatePresentationReviews(reqs, [response(required), response(required)], ranges, paragraphs), /重复/u)
  assert.throws(() => validatePresentationReviews(reqs, [{ ...response(required), fingerprint: 'old' }], ranges, paragraphs), /变化/u)
  assert.throws(() => validatePresentationReviews(reqs, [{ ...response(required), evidence: [{ source: 'chapter', index: 2, quote: '他守在门边。' }] }], ranges, paragraphs), /对应场景/u)
  const optional = reqs.find(r => !r.required)
  assert.equal(validatePresentationReviews(reqs, [response(required), { ...response(optional), verdict: 'conflict' }], ranges, paragraphs).findings.length, 0)
})

test('核对视图区分未审、已审、改稿失效；仅作者参考产生边界项', () => {
  const reqs = requirements()
  assert.equal(presentationReviewView(reqs, null, 'a').pending, 1)
  const review = { baseHash: 'a', presentationReviews: [response(reqs[0])] }
  assert.equal(presentationReviewView(reqs, review, 'a').reviewed, 1)
  assert.equal(presentationReviewView(reqs, review, 'b').items[0].status, 'stale')
  const changed = presentationRequirements(parseScenes(plan.replace('留在门边', '离开门边'), '0001'))
  assert.equal(presentationReviewView(changed, review, 'a').items[0].status, 'stale')
  const boundary = presentationRequirements(parseScenes(plan + '- 视角权限：仅作者参考\n', '0001'))
  assert.ok(boundary.some(r => r.level === 'boundary'))
})

test('真实审稿工具要求逐项回执、阻塞定稿，并随章纲变化失效', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-presentation-review-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.writeFile(path.join(root, 'chapters/0001.md'), '他守在门边。')
  await fs.writeFile(path.join(root, 'beats.md'), plan)
  const chapter = { id: '0001', title: '开场', file: 'chapters/0001.md', status: 'draft' }
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '测试', chapters: [chapter] }))
  const tools = new Map()
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect() {} }, { root })
  const call = (name, args) => tools.get(name).execute(args)
  const pack = await call('novel_deai_pack', { chapter: '0001' })
  assert.equal(pack.presentationRequirements.filter(r => r.required).length, 1)
  const payload = { chapter: '0001', baseHash: pack.baseHash,
    checks: Object.fromEntries(['continuity', 'timing', 'voice', 'narration', 'rhythm', 'facts'].map(aspect => [aspect, { verdict: 'supported', detail: '已按本段核对。', counterargument: '没有写来人，不能断言来人已到。', evidence: [{ source: 'chapter', index: 1, quote: '他守在门边。' }] }])),
    observations: [], timeBudgets: [], scenes: [{ sceneId: 'first', startIndex: 1, endIndex: 1, layout: '门边。', mechanism: '静态留守，无操作链。', timeline: '持续守候，未明确时长。', actions: [] }], paragraphs: [{ index: 1, reason: '保留守候事实。' }] }
  await assert.rejects(call('novel_deai_review', payload), /未核对/u)
  const required = pack.presentationRequirements.find(r => r.required)
  const blocked = await call('novel_deai_review', { ...payload, presentationReviews: [{ ...response(required), verdict: 'uncertain', detail: '守候是否出于决定仍缺依据。' }] })
  assert.equal(blocked.status, 'blocked')
  await assert.rejects(call('novel_write', { chapter: '0001', content: '他守在门边。', status: 'final' }), /复核|审稿/u)
  const success = await call('novel_deai_review', { ...payload, presentationReviews: [response(required)], resolutions: { narration: '重新核对要求：留守的动作足以体现选择，无须增加心理独白。' } })
  assert.equal(success.status, 'recorded')
  const { meta } = await loadBook(root)
  assert.equal((await stageContext(root, meta.chapters, '0001')).presentationReview.reviewed, 1)
  assert.match(meta.chapters[0].deaiReview.priorSceneBindings.first, /^[a-f0-9]{64}$/u)
  await fs.writeFile(path.join(root, 'beats.md'), plan.replace('他决定留在门边。', '他决定离开门边。'))
  const check = await call('novel_check', { chapter: '0001' })
  assert.equal(check.deaiReview.status, 'pending')
  assert.equal((await stageContext(root, meta.chapters, '0001')).presentationReview.items[0].status, 'stale')
})
