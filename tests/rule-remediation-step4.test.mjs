import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'
import { loadBook, persistBook } from '../lib/book.js'
import { stageContext } from '../stage.js'

const digest = text => createHash('sha256').update(text).digest('hex')
const BODY = '甲在门前看见空盒。\n乙在后场说出暗号。\n甲记住暗号。'
const MANDATORY_STYLE = '不得越过主角的限知视角。'.repeat(1200)

const scene = (id, time) => `### 场景 ${id}：${id}
- 时序：${time}
- 出场：a
- 冲突：核对暗号
#### 人物 a
- 目标：查清真相
`

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-remediation-step4-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const dir of ['chapters', 'characters', 'styles']) await fs.mkdir(path.join(root, dir), { recursive: true })
  const chapters = [
    {
      id: '0010', title: '旧章', file: 'chapters/0010.md', status: 'draft',
      deaiReview: { baseHash: digest(BODY), scenes: [{ startIndex: 1, endIndex: 1, sceneId: 'first' }, { startIndex: 2, endIndex: 3, sceneId: 'second' }] },
    },
    { id: '0002', title: '后续', file: 'chapters/0002.md', status: 'draft' },
    { id: '0003', title: '待写', file: 'chapters/0003.md', status: 'planned' },
  ]
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ style: '测试' }))
  await persistBook(root, { title: '第四步测试', targetChars: 3000, targetCharsSet: true }, chapters)
  await fs.writeFile(path.join(root, 'chapters/0010.md'), BODY)
  await fs.writeFile(path.join(root, 'chapters/0002.md'), '甲带着暗号继续追查。')
  await fs.writeFile(path.join(root, 'chapters/0003.md'), '')
  await fs.writeFile(path.join(root, 'characters/甲.md'), '# 甲\n- ID：a\n- 定位：主角\n- 重要程度：核心\n')
  await fs.writeFile(path.join(root, 'beats.md'), [
    '## 0010 旧章', scene('first', 10), scene('second', 20),
    '## 0002 后续', scene('later', 30),
    '## 0003 待写', scene('future', 40),
  ].join('\n'))
  await fs.writeFile(path.join(root, 'ledger.md'), [
    '# 状态台账', '',
    '| 类别 | 项目 | 当前状态 | 变更章 | 备注 |',
    '| --- | --- | --- | --- | --- |',
    '| 资产 | 甲的铜钱 | 17 文 | 0002 | 后续花销后的余额 |',
    '| 道具 | 暗号纸 | 已消耗 | 0002 | 后续烧毁 |',
  ].join('\n'))
  await fs.writeFile(path.join(root, 'styles/测试.md'), [
    '# 文风卡：测试',
    '- 视角与时态：第三人称限知。',
    '## 语义禁忌',
    '- 普通提醒：不要替人物解释情绪。',
    `- [必选] ${MANDATORY_STYLE}`,
    '## 反例',
    `- ${'过长反例。'.repeat(500)}`,
    '- 短反例。',
    '## 少用词',
    '- 不由得',
    '## 锚点原文',
    '### 锚点 1【通用】',
    '> 风一下停了。',
  ].join('\n'))

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
    Object.assign(req, {
      url,
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? {} : { 'x-novel-action': '1' },
    })
    let raw = ''
    const res = { statusCode: 200, destroyed: false, writeHead(code) { this.statusCode = code }, end(value) { raw += value ? String(value) : '' } }
    await handler(req, res)
    return { status: res.statusCode, value: raw ? JSON.parse(raw) : null }
  }
  return { root, chapters, call, request }
}

const historyArgs = (sceneId, evidenceIndex, evidence, extra = {}) => ({
  action: 'propose',
  character: 'a',
  scene: sceneId,
  kind: '已知',
  content: '甲知道了暗号',
  source: '亲耳听见',
  evidence,
  evidenceIndex,
  ...extra,
})

test('人物历史按正文段号绑定实际场景，后一场引文不能授权前一场', async t => {
  const { root, chapters, call, request } = await fixture(t)
  const pack = await call('novel_deai_pack', { chapter: '0010' })
  assert.equal(pack.items[1].index, 2)
  assert.equal(pack.items[1].text, '乙在后场说出暗号。')

  const wrong = await call('novel_character_history', historyArgs('first', 2, '乙在后场说出暗号。'))
  assert.equal(wrong.record.status, 'candidate')
  assert.equal(wrong.record.binding.status, 'pending')
  assert.equal(wrong.record.binding.actualScene, 'second')
  const refused = await request('/novel-api/character-history', { action: 'confirm', character: 'a', id: wrong.record.id })
  assert.equal(refused.status, 409)
  assert.match(refused.value.error, /属于场景 second|尚未可靠归属/u)
  assert.equal((await stageContext(root, chapters, '0002', 'later')).scenes[0].characters[0].history.length, 0)

  const correct = await call('novel_character_history', historyArgs('second', 2, '乙在后场说出暗号。'))
  assert.equal(correct.record.binding.status, 'bound')
  assert.deepEqual([correct.record.binding.startIndex, correct.record.binding.endIndex], [2, 3])
  await call('novel_character_history', { action: 'confirm', character: 'a', id: correct.record.id })
  assert.equal((await stageContext(root, chapters, '0010', 'first')).scenes[0].characters[0].history.length, 0)
  assert.equal((await stageContext(root, chapters, '0010', 'second')).scenes[0].characters[0].history.length, 0)
  assert.equal((await stageContext(root, chapters, '0002', 'later')).scenes[0].characters[0].history.length, 1)
})

test('正文分场范围变化后旧确认记录重新待核对', async t => {
  const { root, chapters, call, request } = await fixture(t)
  const proposed = await call('novel_character_history', historyArgs('second', 2, '乙在后场说出暗号。'))
  await call('novel_character_history', { action: 'confirm', character: 'a', id: proposed.record.id })

  const { meta: book } = await loadBook(root)
  book.chapters[0].deaiReview.scenes = [{ startIndex: 1, endIndex: 2, sceneId: 'first' }, { startIndex: 3, endIndex: 3, sceneId: 'second' }]
  await persistBook(root, book, book.chapters)
  const changed = await stageContext(root, book.chapters, '0002', 'later')
  assert.equal(changed.scenes[0].characters[0].history.length, 0)
  assert.match(changed.warnings.join('\n'), /待复核/u)
  const refused = await request('/novel-api/character-history', { action: 'confirm', character: 'a', id: proposed.record.id })
  assert.equal(refused.status, 409)
})

test('分场数量相同但正文顺序与章纲不同时，只认显式 sceneId', async t => {
  const { root, chapters, call } = await fixture(t)
  const { meta: book } = await loadBook(root)
  // 正文先写 second 再写 first；数量与章纲相同，但数组下标与章纲顺序相反。
  book.chapters[0].deaiReview.scenes = [{ startIndex: 1, endIndex: 1, sceneId: 'second' }, { startIndex: 2, endIndex: 3, sceneId: 'first' }]
  await persistBook(root, book, book.chapters)

  const swapped = await call('novel_character_history', historyArgs('second', 2, '乙在后场说出暗号。'))
  assert.equal(swapped.record.binding.status, 'pending')
  assert.equal(swapped.record.binding.actualScene, 'first')
  // 显式 sceneId 才是归属依据：复核把第 2 段声明为 first 时，登记 first 才能绑定。
  assert.equal((await call('novel_character_history', historyArgs('first', 2, '乙在后场说出暗号。'))).record.binding.status, 'bound')

  // 不声明 sceneId 的旧分场不能再按下标认领。
  const { meta: legacy } = await loadBook(root)
  legacy.chapters[0].deaiReview.scenes = [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 3 }]
  await persistBook(root, legacy, legacy.chapters)
  const unbound = await call('novel_character_history', historyArgs('second', 2, '乙在后场说出暗号。'))
  assert.equal(unbound.record.binding.status, 'pending')
  assert.match(unbound.record.binding.reason, /sceneId/u)
  assert.equal((await stageContext(root, chapters, '0002', 'later')).scenes[0].characters[0].history.length, 0)
})

test('审稿登记要求结构化场景显式声明 sceneId', async t => {
  const { call } = await fixture(t)
  const pack = await call('novel_deai_pack', { chapter: '0010' })
  const checks = Object.fromEntries(['continuity', 'timing', 'voice', 'narration', 'rhythm', 'facts'].map(aspect => [aspect, {
    verdict: 'supported', detail: '已核对。', counterargument: '最可能相反的是段落顺序。',
    evidence: [{ source: 'chapter', index: 1, quote: '甲在门前看见空盒' }],
  }]))
  const payload = {
    chapter: '0010', baseHash: pack.baseHash, styleHash: pack.style.hash, checks, observations: [], timeBudgets: [],
    paragraphs: [{ index: 1, reason: '开场。' }, { index: 2, reason: '承接。' }, { index: 3, reason: '结果。' }],
    scenes: [
      { startIndex: 1, endIndex: 1, layout: '门前。', mechanism: '发现空盒。', timeline: '先看门。', actions: [] },
      { startIndex: 2, endIndex: 3, layout: '后场。', mechanism: '说出暗号。', timeline: '随后开口。', actions: [] },
    ],
  }
  await assert.rejects(call('novel_deai_review', payload), /sceneId/u)
  const registered = await call('novel_deai_review', { ...payload, scenes: [
    { ...payload.scenes[0], sceneId: 'first' },
    { ...payload.scenes[1], sceneId: 'second' },
  ] })
  assert.equal(registered.chapter, '0010')
})

test('章纲新增或重复场景后，旧分场复核不能再被人物历史使用', async t => {
  const { root, chapters, call } = await fixture(t)
  const proposed = await call('novel_character_history', historyArgs('second', 2, '乙在后场说出暗号。'))
  await call('novel_character_history', { action: 'confirm', character: 'a', id: proposed.record.id })
  const beatsFile = path.join(root, 'beats.md')
  const original = await fs.readFile(beatsFile, 'utf8')

  // 章纲新增第三场：旧复核没有认领 C，novel_check 判待复核，人物历史也不能再继承。
  await fs.writeFile(beatsFile, original.replace(
    '## 0002 后续',
    `${scene('added', 15)}\n## 0002 后续`,
  ))
  const added = await stageContext(root, chapters, '0002', 'later')
  assert.equal(added.scenes[0].characters[0].history.length, 0)
  assert.match(added.warnings.join('\n'), /未被正文分场认领|待复核/u)
  await assert.rejects(
    call('novel_character_history', { action: 'confirm', character: 'a', id: proposed.record.id }),
    /分场复核已不适用于当前章纲|不得确认/u,
  )

  // 重复场景 ID 同样使旧分场不可用。
  await fs.writeFile(beatsFile, original.replace('## 0002 后续', `${scene('second', 25)}\n## 0002 后续`))
  assert.equal((await stageContext(root, chapters, '0002', 'later')).scenes[0].characters[0].history.length, 0)

  await fs.writeFile(beatsFile, original)
  const restored = await stageContext(root, chapters, '0002', 'later')
  assert.equal(restored.scenes[0].characters[0].history.length, 1)
})

test('人物历史确认与正文覆盖共用书目锁，不会留下可继承的旧来源', async t => {
  const { root, call } = await fixture(t)
  const proposed = await call('novel_character_history', historyArgs('second', 2, '乙在后场说出暗号。'))
  const [confirmed, written] = await Promise.allSettled([
    call('novel_character_history', { action: 'confirm', character: 'a', id: proposed.record.id }),
    call('novel_write', { chapter: '0010', mode: 'replace', content: `${BODY}\n正文已改。` }),
  ])
  assert.equal(written.status, 'fulfilled')
  assert.ok(['fulfilled', 'rejected'].includes(confirmed.status))
  const { meta: book } = await loadBook(root)
  const context = await stageContext(root, book.chapters, '0002', 'later')
  assert.equal(context.scenes[0].characters[0].history.length, 0)
  if (confirmed.status === 'fulfilled') assert.match(context.warnings.join('\n'), /待复核/u)
  else assert.match(confirmed.reason.message, /来源已变化/u)
})

test('缺少新段号契约的旧确认记录只读为待复核', async t => {
  const { root, chapters, call } = await fixture(t)
  const proposed = await call('novel_character_history', historyArgs('second', 2, '乙在后场说出暗号。'))
  await call('novel_character_history', { action: 'confirm', character: 'a', id: proposed.record.id })
  const file = path.join(root, 'character-history/a.md')
  const raw = await fs.readFile(file, 'utf8')
  const record = JSON.parse(/```json\n([\s\S]*?)\n```/u.exec(raw)[1])
  for (const key of ['recordVersion', 'evidenceIndex', 'sourceSceneId', 'sourceSceneStart', 'sourceSceneEnd']) delete record[key]
  await fs.writeFile(file, `# 人物经历：a\n\n## ${record.id} · confirmed\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`)
  const context = await stageContext(root, chapters, '0002', 'later')
  assert.equal(context.scenes[0].characters[0].history.length, 0)
  assert.match(context.warnings.join('\n'), /缺少有效 evidenceIndex|待复核/u)
})

test('回改旧章不装配当前台账值，只返回非阻塞历史缺项', async t => {
  const { call } = await fixture(t)
  const historical = await call('novel_context', { chapter: '0010', mode: 'continue', budget: 200000 })
  assert.equal(historical.ready, true)
  assert.equal(historical.ledgerScope.mode, 'historical')
  assert.deepEqual(historical.ledger, [])
  assert.equal(historical.ledgerMissing.length, 2)
  assert.ok(historical.ledgerMissing.every(item => !Object.hasOwn(item, 'state') && !Object.hasOwn(item, 'note')))
  assert.doesNotMatch(historical.prompt, /17 文|已消耗|后续烧毁/u)
  assert.match(historical.prompt, /只保存当前快照|历史值缺失（非阻塞）/u)
  const rewritten = await call('novel_context', { chapter: '0010', mode: 'rewrite', budget: 200000 })
  assert.equal(rewritten.ledgerScope.mode, 'historical')
  assert.doesNotMatch(rewritten.prompt, /17 文|已消耗|后续烧毁/u)

  const latestRewrite = await call('novel_context', { chapter: '0002', mode: 'rewrite', budget: 200000 })
  assert.equal(latestRewrite.ledgerScope.mode, 'frontier-rewrite')
  assert.match(latestRewrite.prompt, /当前终态参考，不等于本章开场状态/u)
  const future = await call('novel_context', { chapter: '0003', mode: 'continue', budget: 200000 })
  assert.equal(future.ready, true)
  assert.equal(future.ledgerScope.mode, 'current')
  assert.match(future.prompt, /仅适用于从当前进度向后续写/u)
  assert.equal(future.ledger.length, 1)
  assert.match(future.prompt, /17 文/u)
  assert.doesNotMatch(future.prompt, /已消耗/u)
})

test('最新章按场续写与局部改写不把章末台账冒充目标位置起始状态', async t => {
  const { call } = await fixture(t)
  const scoped = await call('novel_context', { chapter: '0002', scene: 'later', budget: 200000 })
  assert.equal(scoped.ledgerScope.mode, 'historical')
  assert.equal(scoped.ledgerScope.reason, 'target-position-inside-written-chapter')
  assert.deepEqual(scoped.ledger, [])
  assert.doesNotMatch(scoped.prompt, /17 文|已消耗|后续烧毁/u)
  assert.match(scoped.prompt, /同一章后续场景和后文已形成的状态/u)

  const partial = await call('novel_context', { chapter: '0002', mode: 'rewrite', rewriteStart: 0, rewriteLimit: 4, budget: 200000 })
  assert.equal(partial.ledgerScope.mode, 'historical')
  assert.deepEqual(partial.ledger, [])
})

test('必选文风纳入最低预算，工具与 HTTP 返回明确缺项', async t => {
  const { call, request } = await fixture(t)
  const ready = await call('novel_context', { chapter: '0003', budget: 200000 })
  assert.equal(ready.ready, true)
  assert.equal(ready.missingRequired.length, 0)
  assert.equal(ready.requiredItems.length, 1)
  assert.match(ready.prompt, /\[必选\] 不得越过主角的限知视角/u)
  assert.match(ready.prompt, /## 语义禁忌/u)
  assert.ok(ready.minimumBudget < ready.budget)

  const blocked = await call('novel_context', { chapter: '0003', budget: 300 })
  assert.equal(blocked.ready, false)
  assert.ok(blocked.minimumBudget > blocked.budget)
  assert.ok(blocked.budgetUsed <= blocked.budget)
  assert.equal(blocked.budgetUnit, 'unicode-code-points')
  assert.equal(blocked.missingRequired.length, 1)
  assert.match(blocked.missingRequired[0].label, /语义禁忌/u)
  assert.match(blocked.prompt, /缺少 1 条必选文风/u)
  const retried = await call('novel_context', { chapter: '0003', budget: blocked.minimumBudget })
  assert.equal(retried.ready, true)
  assert.match(retried.prompt, /\[必选\] 不得越过主角的限知视角/u)

  // 缺项标签很多时，失败提示也必须留在预算内，完整明细只走元数据。
  for (const budget of [300, 1000, 5000]) {
    const value = budget === 300 ? blocked : await call('novel_context', { chapter: '0003', budget })
    assert.ok(value.budgetUsed <= budget, `budget ${budget} 的失败提示不能超出预算`)
    if (!value.ready) assert.match(value.prompt, /missingRequired/u)
  }

  const http = await request('/novel-api/context?chapter=0003&budget=300')
  assert.equal(http.status, 200)
  assert.equal(http.value.ready, false)
  assert.equal(http.value.minimumBudget, blocked.minimumBudget)
  assert.deepEqual(http.value.missingRequired, blocked.missingRequired)
  assert.equal(http.value.budgetUnit, 'unicode-code-points')
})
