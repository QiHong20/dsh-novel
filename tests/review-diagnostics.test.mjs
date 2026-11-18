import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const BODY = '七号炉的炉皮在跳。\n\n他把手按上去。\n'
const ASPECTS = ['continuity', 'timing', 'voice', 'narration', 'rhythm', 'facts']

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-review-diag-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.mkdir(path.join(root, 'characters'))
  await fs.writeFile(path.join(root, 'chapters/0001.md'), BODY)
  await fs.writeFile(path.join(root, 'characters/陆昭.md'), '# 陆昭\n\n- ID：lu-zhao\n\n- 说话：句子短。\n')
  await fs.writeFile(path.join(root, 'outline.md'), '# 大纲\n')
  await fs.writeFile(path.join(root, 'beats.md'), '## 0001 第一章\n\n- 场景：他 → 炉坑 → 想拆炉 → 撞上反顶\n')
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({
    title: '诊断测试',
    targetChars: 3000,
    chapters: [{ id: '0001', title: '第一章', file: 'chapters/0001.md', status: 'draft', targetChars: 3000 }],
  }))
  const tools = new Map()
  apply({ tools: { register: definition => tools.set(definition.name, definition) }, effect() {} }, { root })
  const call = (name, args) => tools.get(name).execute(args)
  const { baseHash } = await call('novel_deai_pack', { chapter: '0001' })
  return { call, baseHash }
}

const baseChecks = () => Object.fromEntries(ASPECTS.map(aspect => [aspect, {
  verdict: 'supported',
  detail: '本维度已核对。',
  counterargument: '最可能推翻的相反证据是段落顺序，已按段号复核。',
  evidence: [{ source: 'chapter', index: 1, quote: '七号炉的炉皮在跳' }],
}]))

const fullReview = (checks, extra = {}) => ({
  chapter: '0001',
  checks,
  observations: [],
  timeBudgets: [],
  scenes: [{
    startIndex: 1,
    endIndex: 2,
    layout: '炉坑：他站在炉前。',
    mechanism: '炉皮在跳，他按手确认。',
    timeline: '贴壳，再按手。',
    actions: [],
  }],
  paragraphs: [
    { index: 1, reason: '开场异常。' },
    { index: 2, reason: '承接动作。' },
  ],
  ...extra,
})

test('缺正文引文的维度会被点名，而不是只回一句笼统提示', async t => {
  const { call, baseHash } = await fixture(t)
  const checks = baseChecks()
  checks.voice.evidence = [{ source: 'character', name: '陆昭', quote: '句子短。' }]
  await assert.rejects(
    call('novel_deai_review', { ...fullReview(checks), baseHash }),
    error => {
      assert.match(error.message, /checks 不完整/)
      assert.match(error.message, /voice\.evidence 需至少一条 chapter 引文/)
      // 未出问题的维度不该被报出来
      assert.doesNotMatch(error.message, /narration\./)
      return true
    },
  )
})

test('引文与段号不符时报出段号与原文片段', async t => {
  const { call, baseHash } = await fixture(t)
  const checks = baseChecks()
  checks.facts.evidence = [{ source: 'chapter', index: 2, quote: '他按上去' }]
  await assert.rejects(
    call('novel_deai_review', { ...fullReview(checks), baseHash }),
    error => {
      assert.match(error.message, /chapter 第 2 段/)
      assert.match(error.message, /找不到「他按上去」/)
      return true
    },
  )
})

test('六维各带一条正文引文时可正常登记', async t => {
  const { call, baseHash } = await fixture(t)
  const result = await call('novel_deai_review', { ...fullReview(baseChecks()), baseHash })
  assert.equal(result.status, 'recorded')
  assert.deepEqual(result.checkVerdicts, Object.fromEntries(ASPECTS.map(aspect => [aspect, 'supported'])))
})

test('超长 payload 可写成 JSON 文件后用 payloadFile 登记', async t => {
  const { call, baseHash } = await fixture(t)
  const payload = fullReview(baseChecks())
  const file = path.join(os.tmpdir(), `novel-review-${Date.now()}.json`)
  await fs.writeFile(file, JSON.stringify(payload))
  t.after(() => fs.rm(file, { force: true }))
  const result = await call('novel_deai_review', { chapter: '0001', baseHash, payloadFile: file })
  assert.equal(result.status, 'recorded')
  assert.equal(result.reviewedParagraphs, 2)
})

test('payloadFile 缺失或非法 JSON 时给出可读原因', async t => {
  const { call, baseHash } = await fixture(t)
  await assert.rejects(
    call('novel_deai_review', { chapter: '0001', baseHash, payloadFile: 'nope.json' }),
    error => /payloadFile 不存在/.test(error.message),
  )
  const broken = path.join(os.tmpdir(), `novel-review-broken-${Date.now()}.json`)
  await fs.writeFile(broken, '{"checks":')
  t.after(() => fs.rm(broken, { force: true }))
  await assert.rejects(
    call('novel_deai_review', { chapter: '0001', baseHash, payloadFile: broken }),
    error => /payloadFile 不是合法 JSON/.test(error.message),
  )
})

test('既没给字段也没给 payloadFile 时报出缺哪一项', async t => {
  const { call, baseHash } = await fixture(t)
  await assert.rejects(
    call('novel_deai_review', { chapter: '0001', baseHash }),
    error => /缺少 checks/.test(error.message),
  )
})
