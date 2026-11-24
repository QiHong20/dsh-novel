import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { CONTEXT_REVIEW_CHECKS, validateContextReview, recordContextReview, contextReviewStatus } from '../lib/context-review.js'

const pack = text => ({ full: true, ready: true, chapter: { id: '0001' }, prompt: text,
  packHash: createHash('sha256').update(text).digest('hex'), missingMaterials: ['人物卡／设定为自由文本：未标注段落的生效及揭示边界尚未核实'] })
const checks = () => Object.fromEntries(CONTEXT_REVIEW_CHECKS.map(k => [k, { verdict: 'supported', detail: '本包明确只处理交接。', counterargument: '不能据此推定已打开门。', quotes: ['钥匙交给甲'] }]))

test('独立核对不允许遗漏维度、伪造引文、硬缺项或普通包', () => {
  const p = pack('本场只把钥匙交给甲，不开门。')
  assert.equal(validateContextReview(p, checks()), true)
  const incomplete = checks(); delete incomplete.knowledge
  assert.throws(() => validateContextReview(p, incomplete), /knowledge/u)
  const fake = checks(); fake.timeline.quotes = ['未来已经开门']
  assert.throws(() => validateContextReview(p, fake), /timeline/u)
  assert.throws(() => validateContextReview({ ...p, missingMaterials: ['依赖设定不存在：锁'] }, checks()), /未解决/u)
  assert.throws(() => validateContextReview({ ...p, full: false }, checks()), /完整包/u)
  assert.throws(() => validateContextReview({ ...p, ready: false }, checks()), /完整包/u)
})

test('核对冻结精确包；正文范围变化不继承通过，冲突如实阻塞', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-context-review-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const p = pack('本场只把钥匙交给甲，不开门。')
  assert.equal((await contextReviewStatus(root, p)).selfContained, false)
  await assert.rejects(recordContextReview(root, p, { packHash: 'old', checks: checks() }), /已变化/u)
  await recordContextReview(root, p, { packHash: p.packHash, checks: checks() })
  assert.equal((await contextReviewStatus(root, p)).selfContained, false)
  assert.equal((await contextReviewStatus(root, p)).semanticSupported, true)
  const frozen = JSON.parse(await fs.readFile(path.join(root, '.novel/context-reviews', `${p.packHash}.json`), 'utf8'))
  assert.equal(frozen.prompt, p.prompt)
  assert.equal((await contextReviewStatus(root, pack('本场把钥匙交给甲，之后开门。'))).selfContained, false)
  const uncertain = checks(); uncertain.revelation.verdict = 'uncertain'
  await recordContextReview(root, p, { packHash: p.packHash, checks: uncertain })
  assert.equal((await contextReviewStatus(root, p)).status, 'blocked')
  assert.equal((await contextReviewStatus(root, p)).selfContained, false)
})
