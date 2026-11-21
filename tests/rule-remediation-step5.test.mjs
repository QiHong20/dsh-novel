import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'
import { beatReactionCandidates, calculateBeatRhythm, parseBeatSections } from '../lib/beats.js'
import { appearanceIndex, appearanceReport, listCharacters } from '../lib/people.js'

const ASPECTS = ['continuity', 'timing', 'voice', 'narration', 'rhythm', 'facts']

function scene(id, time, options = {}) {
  const cast = options.cast ?? ['hero']
  const mentioned = options.mentioned ?? []
  return [
    `### 场景 ${id}：${options.title ?? id}`,
    `- 时序：${time}`,
    `- 出场：${cast.join('、')}`,
    ...(mentioned.length ? [`- 提及：${mentioned.join('、')}`] : []),
    ...(options.lines ?? []),
    ...cast.flatMap(character => [`#### 人物 ${character}`, '- 目标：推进本场']),
    '',
  ].join('\n')
}

function beatsFile(chapters) {
  return chapters.map(chapter => `## ${chapter.id} ${chapter.title}\n\n${chapter.body}`).join('\n')
}

async function fixture(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-remediation-step5-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const dir of ['chapters', 'characters']) await fs.mkdir(path.join(root, dir), { recursive: true })
  const chapters = options.chapters.map(chapter => ({ id: chapter.id, title: chapter.title, file: `chapters/${chapter.id}.md`, status: 'draft' }))
  await fs.writeFile(path.join(root, 'book.json'), `${JSON.stringify({ title: '第五步测试', targetChars: 3000, chapters }, null, 2)}\n`)
  for (const chapter of options.chapters) await fs.writeFile(path.join(root, `chapters/${chapter.id}.md`), chapter.text ?? `${chapter.title}正文。`)
  await fs.writeFile(path.join(root, 'beats.md'), options.beats)
  await fs.writeFile(path.join(root, 'outline.md'), options.outline ?? '每三章一爽点')
  for (const card of options.cards ?? []) await fs.writeFile(path.join(root, `characters/${card.name}.md`), card.text)

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
  const request = async url => {
    const req = Readable.from([])
    Object.assign(req, { url, method: 'GET', headers: {} })
    let raw = ''
    const res = { statusCode: 200, destroyed: false, writeHead(code) { this.statusCode = code }, end(value) { raw += value ? String(value) : '' } }
    await handler(req, res)
    return { status: res.statusCode, value: raw ? JSON.parse(raw) : null }
  }
  const render = (name, args, value) => {
    const tool = tools.get(name)
    assert.ok(tool, `没有注册工具 ${name}`)
    return tool.output.render(args, value).map(part => part.text).join('\n')
  }
  return { root, chapters, call, request, render }
}

const checks = quote => Object.fromEntries(ASPECTS.map(aspect => [aspect, {
  verdict: 'supported',
  detail: '已按当前全文和场景核对。',
  evidence: [{ source: 'chapter', index: 1, quote }],
  counterargument: '若场景范围或正文变化，本判断需要重新登记。',
}]))

const reviewScene = (sceneId, startIndex, endIndex, reaction) => ({
  sceneId,
  startIndex,
  endIndex,
  layout: '人物都在大厅内，位置连续。',
  mechanism: '证据出现后，对手让开，结果承接下一场。',
  timeline: '先展示证据，再出现反应，随后离场。',
  actions: [],
  ...(reaction ? { reaction } : {}),
})

test('共享爽点算法包含本章、保留历史阈值命中并按书目顺序计算', () => {
  const chapters = [
    { id: '0010', title: '一' },
    { id: '0002', title: '二' },
    { id: '0003', title: '三' },
    { id: '0004', title: '四' },
  ]
  const sections = parseBeatSections(beatsFile(chapters.map((chapter, index) => ({
    ...chapter,
    body: scene(`s${index + 1}`, (index + 1) * 10, { lines: index === 3 ? ['→ 爽点（翻盘）'] : [] }),
  }))))
  const rhythm = calculateBeatRhythm(chapters, sections, 3)
  assert.deepEqual(rhythm.perChapter.map(item => item.gap), [1, 2, 3, 0])
  assert.deepEqual(rhythm.perChapter.map(item => item.breached), [false, false, true, false])
  assert.deepEqual(rhythm.breaches, [{ id: '0003', title: '三', gap: 3 }])
  assert.equal(rhythm.currentGap, 0)
  assert.equal(rhythm.longestGap, 3)

  const ambiguous = calculateBeatRhythm([chapters[0]], parseBeatSections(`## 0010 一\n${scene('a', 10)}\n## 0010 重复\n${scene('b', 20)}`), 3)
  assert.equal(ambiguous.complete, false)
  assert.equal(ambiguous.perChapter[0].matchStatus, 'ambiguous')
  assert.equal(ambiguous.perChapter[0].hasBeats, false)
})

test('歧义章纲把断档计数截断，后续无标记章不再继承未知区间的确定告警', () => {
  const chapters = [
    { id: '0001', title: '一' },
    { id: '0002', title: '歧义' },
    { id: '0003', title: '三' },
    { id: '0004', title: '四' },
  ]
  const sections = parseBeatSections([
    `## 0001 一\n${scene('s1', 10)}`,
    `## 0002 歧义\n${scene('s2', 20)}`,
    `## 0002 重复\n${scene('s3', 30, { lines: ['→ 爽点（打脸）'] })}`,
    `## 0003 三\n${scene('s4', 40)}`,
    `## 0004 四\n${scene('s5', 50)}`,
  ].join('\n'))
  const rhythm = calculateBeatRhythm(chapters, sections, 3)
  assert.equal(rhythm.complete, false)
  assert.deepEqual(rhythm.perChapter.map(item => item.matchStatus), ['matched', 'ambiguous', 'matched', 'matched'])
  assert.deepEqual(rhythm.perChapter.map(item => item.breached), [false, false, false, false])
  assert.deepEqual(rhythm.breaches, [])
  assert.equal(rhythm.currentGap, 2)
  assert.equal(rhythm.currentBreached, false)
})

test('状态、章纲、审计和逐章检查共用三章阈值，写回返回保存后的节奏', async t => {
  const chapters = [
    { id: '0001', title: '一' },
    { id: '0002', title: '二' },
    { id: '0003', title: '三' },
  ]
  const beats = beatsFile(chapters.map((chapter, index) => ({ ...chapter, body: scene(`s${index + 1}`, (index + 1) * 10, { lines: ['→ 钩子'] }) })))
  const env = await fixture(t, { chapters, beats })
  const checked = []
  for (const chapter of chapters) checked.push(await env.call('novel_check', { chapter: chapter.id, aiTone: false }))
  assert.deepEqual(checked.map(item => item.rhythm.gap), [1, 2, 3])
  assert.deepEqual(checked.map(item => item.issues.some(issue => issue.kind === 'no-payoff')), [false, false, true])

  const status = await env.call('novel_status')
  assert.equal(status.rhythm.gapLimit, 3)
  assert.equal(status.rhythm.currentBreached, true)
  assert.deepEqual(status.rhythm.perChapter.map(item => item.breached), [false, false, true])
  const board = await env.request('/novel-api/beats')
  assert.equal(board.status, 200)
  assert.deepEqual(board.value.rhythm.perChapter.map(item => item.gap), [1, 2, 3])
  const audit = await env.call('novel_audit')
  assert.deepEqual(audit.issues.filter(issue => issue.kind === 'no-payoff').map(issue => issue.chapter), ['0003'])
  const context = await env.call('novel_context', { chapter: '0003' })
  assert.equal(context.rhythm.gap, 3)
  assert.equal(context.rhythm.breached, true)
  const contextHttp = await env.request('/novel-api/context?chapter=0003')
  assert.equal(contextHttp.value.rhythm.gap, 3)

  const saved = await env.call('novel_beats', {
    chapter: '0003',
    content: scene('s3', 30, { lines: ['→ 爽点（翻盘）', '→ 钩子'] }),
  })
  assert.equal(saved.written, true)
  assert.equal(saved.rhythm.currentGap, 0)
  assert.equal(saved.rhythm.currentBreached, false)
  assert.equal(saved.rhythm.perChapter.find(item => item.id === '0003').hasPayoff, true)
})

test('打脸反应只在当前结构化场景查找，旧逐行格式保留旧边界', () => {
  const structured = parseBeatSections(beatsFile([{ id: '0001', title: '一', body: [
    scene('first', 10, { lines: ['→ 爽点（打脸）'] }),
    scene('second', 20, { lines: ['- 反应：对手低头。'] }),
  ].join('\n') }]))[0]
  assert.deepEqual(beatReactionCandidates(structured).map(item => item.sceneId), ['first'])

  const sameScene = { ...structured, scenes: parseBeatSections(beatsFile([{ id: '0001', title: '一', body: scene('first', 10, { lines: ['→ 爽点（打脸）', '- 反应：对手低头。'] }) }]))[0].scenes }
  assert.equal(beatReactionCandidates(sameScene).length, 0)

  for (const empty of ['- 反应：', '- 反应：   ', '- 对方反应：\t']) {
    const blank = parseBeatSections(beatsFile([{ id: '0001', title: '一', body: scene('first', 10, { lines: ['→ 爽点（打脸）', empty] }) }]))[0]
    assert.deepEqual(beatReactionCandidates(blank).map(item => item.sceneId), ['first'], empty)
  }

  const legacy = { body: '- 场景：甲 → 当众揭穿 → 爽点（打脸）\n- 场景：乙 → 收尾\n- 反应：对手低头。', scenes: [] }
  assert.equal(beatReactionCandidates(legacy).length, 1)
  assert.equal(beatReactionCandidates(legacy)[0].format, 'legacy')
})

test('逐场语义反应只能引用同场正文，确认后仍保留并标注字面线索', async t => {
  const body = '甲把证据拍在桌上。\n对手收起笑意，低头让开。\n众人离开大厅。'
  const beats = beatsFile([{ id: '0001', title: '一', body: [
    scene('first', 10, { lines: ['→ 爽点（打脸）'] }),
    scene('second', 20),
  ].join('\n') }])
  const env = await fixture(t, {
    chapters: [{ id: '0001', title: '一', text: body }],
    beats,
    cards: [{ name: '甲', text: '# 甲\n- ID：hero\n- 定位：主角\n' }],
  })
  const before = await env.call('novel_check', { chapter: '0001', aiTone: false })
  assert.equal(before.issues.some(issue => issue.kind === 'no-reaction-on-payoff'), false)
  assert.equal(before.heuristicNotes.find(item => item.kind === 'no-reaction-on-payoff').semanticStatus, 'pending')

  const pack = await env.call('novel_deai_pack', { chapter: '0001' })
  const reaction = {
    verdict: 'supported',
    detail: '对手通过收起笑意和让开自然回应了打脸。',
    evidence: [{ source: 'chapter', index: 2, quote: '对手收起笑意，低头让开' }],
    counterargument: '若这只是无关转场，则不能证明回应；当前动作紧接证据展示。',
  }
  const reviewChecks = checks('甲把证据拍在桌上')
  reviewChecks.voice.evidence.push({ source: 'character', name: '甲', quote: '- ID：hero' })
  const payload = {
    chapter: '0001',
    baseHash: pack.baseHash,
    beatsHash: pack.beatsHash,
    styleHash: pack.style.hash,
    checks: reviewChecks,
    observations: [],
    timeBudgets: [],
    scenes: [reviewScene('first', 1, 2, reaction), reviewScene('second', 3, 3)],
    paragraphs: [1, 2, 3].map(index => ({ index, reason: '本段承接当前场景。' })),
  }
  await assert.rejects(
    env.call('novel_deai_review', { ...payload, scenes: [reviewScene('first', 1, 2, { ...reaction, evidence: [{ source: 'chapter', index: 3, quote: '众人离开大厅' }] }), reviewScene('second', 3, 3)] }),
    /超出本场|来自本场/u,
  )
  const registered = await env.call('novel_deai_review', payload)
  assert.equal(registered.status, 'recorded')
  const after = await env.call('novel_check', { chapter: '0001', aiTone: false })
  const note = after.heuristicNotes.find(item => item.kind === 'no-reaction-on-payoff')
  assert.equal(note.semanticStatus, 'supported')
  assert.match(note.detail, /已登记本场自然反应判断/u)
  const direct = await env.call('novel_check', { chapter: '0001', text: body, aiTone: false })
  assert.equal(direct.deaiReview.status, 'untracked')
  assert.equal(direct.heuristicNotes.find(item => item.kind === 'no-reaction-on-payoff').semanticStatus, 'pending')

  await fs.writeFile(path.join(env.root, 'beats.md'), beats.replace('- 时序：10', '- 时序：11'))
  const changed = await env.call('novel_check', { chapter: '0001', aiTone: false })
  assert.equal(changed.deaiReview.status, 'pending')
  assert.equal(changed.heuristicNotes.find(item => item.kind === 'no-reaction-on-payoff').semanticStatus, 'pending')
})

test('人物戏份按目标章截断；章纲出场只是计划，确认记录与字面候选分级并正确失效', async t => {
  const chapters = [
    { id: '0010', title: '开场', text: '他独自走进大厅。' },
    { id: '0002', title: '提及', text: '众人只提到陆昭离城。' },
    { id: '0003', title: '信件', text: '阿昭的名字写在信上。' },
    { id: '0004', title: '归来', text: '他重新回到大厅。' },
  ]
  const beats = beatsFile([
    { id: '0010', title: '开场', body: scene('s1', 10, { cast: ['lu-zhao'] }) },
    { id: '0002', title: '提及', body: scene('s2', 20, { cast: ['other'], mentioned: ['lu-zhao'] }) },
    { id: '0003', title: '信件', body: scene('s3', 30, { cast: ['other'], mentioned: ['lu-zhao'] }) },
    { id: '0004', title: '归来', body: scene('s4', 40, { cast: ['lu-zhao'] }) },
  ])
  const card = '# 陆昭\n- ID：lu-zhao\n- 定位：主角\n- 戏份：每 2 章至少出场一次\n- 别名：阿昭\n'
  const env = await fixture(t, {
    chapters,
    beats,
    cards: [
      { name: '陆昭', text: card },
      { name: '旁人', text: '# 旁人\n- ID：other\n- 定位：重要配角\n' },
    ],
  })
  let cards = await listCharacters(env.root)
  const plannedOnly = appearanceReport(await appearanceIndex(env.root, env.chapters, cards), cards, '0004').陆昭
  assert.equal(plannedOnly.last, '')
  assert.equal(plannedOnly.plannedLast, '0004')
  assert.equal(plannedOnly.due, true)

  // 确认的人物历史记录绑定当前正文与稳定场景，才算正文侧核实出场。
  const review = {
    baseHash: createHash('sha256').update(chapters[0].text).digest('hex'),
    scenes: [{ startIndex: 1, endIndex: 1, sceneId: 's1' }],
  }
  const book = JSON.parse(await fs.readFile(path.join(env.root, 'book.json'), 'utf8'))
  book.chapters[0].deaiReview = review
  env.chapters[0].deaiReview = review
  await fs.writeFile(path.join(env.root, 'book.json'), JSON.stringify(book, null, 2))
  const proposed = await env.call('novel_character_history', {
    action: 'propose', character: 'lu-zhao', scene: 's1', kind: '登场', onStage: true,
    content: '陆昭独自走进大厅', source: '正文描写', evidence: '他独自走进大厅', evidenceIndex: 1,
  })
  await env.call('novel_character_history', { action: 'confirm', character: 'lu-zhao', id: proposed.record.id })

  cards = await listCharacters(env.root)
  const first = await appearanceIndex(env.root, env.chapters, cards)
  assert.equal(await appearanceIndex(env.root, env.chapters, cards), first)
  const old = appearanceReport(first, cards, '0003').陆昭
  assert.equal(old.last, '0010')
  assert.equal(old.basis, 'confirmed-appearance')
  assert.equal(old.plannedLast, '0010')
  assert.equal(old.candidateLast, '0003')
  assert.equal(old.gap, 2)
  assert.equal(old.due, true)
  const latest = appearanceReport(first, cards, '0004').陆昭
  assert.equal(latest.last, '0010')
  assert.equal(latest.plannedLast, '0004')
  assert.equal(latest.gap, 3)

  const http = await env.request('/novel-api/characters?chapter=0003')
  assert.equal(http.status, 200)
  assert.deepEqual(http.value.appearance.陆昭, old)
  const checked = await env.call('novel_check', { chapter: '0003', aiTone: false })
  assert.deepEqual(checked.appearance.陆昭, old)
  assert.equal(checked.issues.some(issue => issue.kind === 'absent-role'), true)

  // 同字数正文改稿：0003 的“阿昭”改为“小陆”，缓存必须失效。
  await fs.writeFile(path.join(env.root, 'chapters/0003.md'), '小陆的名字写在信上。')
  cards = await listCharacters(env.root)
  let refreshed = await appearanceIndex(env.root, env.chapters, cards)
  assert.equal(appearanceReport(refreshed, cards, '0003').陆昭.candidateLast, '0002')

  // 同长度改回原文后候选恢复，说明缓存跟的是正文内容而不是字数。
  await fs.writeFile(path.join(env.root, 'chapters/0003.md'), '阿昭的名字写在信上。')
  cards = await listCharacters(env.root)
  refreshed = await appearanceIndex(env.root, env.chapters, cards)
  assert.equal(appearanceReport(refreshed, cards, '0003').陆昭.candidateLast, '0003')

  // 等长别名替换后，旧别名的正文命中立即消失。
  await fs.writeFile(path.join(env.root, 'characters/陆昭.md'), card.replace('阿昭', '小陆'))
  cards = await listCharacters(env.root)
  refreshed = await appearanceIndex(env.root, env.chapters, cards)
  assert.equal(appearanceReport(refreshed, cards, '0003').陆昭.candidateLast, '0002')

  // 正文改掉确认记录的依据段落后，记录失效，欠场重新按目标章计算。
  await fs.writeFile(path.join(env.root, 'chapters/0010.md'), '大厅空无一人。')
  cards = await listCharacters(env.root)
  refreshed = await appearanceIndex(env.root, env.chapters, cards)
  const invalidated = appearanceReport(refreshed, cards, '0004').陆昭
  assert.equal(invalidated.last, '')
  assert.equal(invalidated.due, true)
})

test('转述类认知记录不证明人物实际登场，自检回执使用正文证据口径', async t => {
  const chapters = [
    { id: '0001', title: '一', text: '甲独自走进大厅。' },
    { id: '0002', title: '二', text: '众人转述陆昭已知暗号。' },
  ]
  const beats = beatsFile([
    { id: '0001', title: '一', body: scene('s1', 10, { cast: ['other'] }) },
    { id: '0002', title: '二', body: scene('s2', 20, { cast: ['lu-zhao'] }) },
  ])
  const env = await fixture(t, {
    chapters,
    beats,
    cards: [
      { name: '陆昭', text: '# 陆昭\n- ID：lu-zhao\n- 定位：主角\n- 戏份：每 2 章至少出场一次\n' },
      { name: '旁人', text: '# 旁人\n- ID：other\n- 定位：重要配角\n' },
    ],
  })
  const review = {
    baseHash: createHash('sha256').update(chapters[1].text).digest('hex'),
    scenes: [{ startIndex: 1, endIndex: 1, sceneId: 's2' }],
  }
  const book = JSON.parse(await fs.readFile(path.join(env.root, 'book.json'), 'utf8'))
  book.chapters[1].deaiReview = review
  env.chapters[1].deaiReview = review
  await fs.writeFile(path.join(env.root, 'book.json'), JSON.stringify(book, null, 2))

  // 章纲把陆昭排进第二场，但正文只是旁人转述；认知记录即使确认也不证明本人登场。
  const proposed = await env.call('novel_character_history', {
    action: 'propose', character: 'lu-zhao', scene: 's2', kind: '已知',
    content: '陆昭已知暗号', source: '旁人转述', evidence: '众人转述陆昭已知暗号', evidenceIndex: 1,
  })
  assert.equal(proposed.record.binding.status, 'bound')
  await env.call('novel_character_history', { action: 'confirm', character: 'lu-zhao', id: proposed.record.id })

  const cards = await listCharacters(env.root)
  const index = await appearanceIndex(env.root, env.chapters, cards)
  const report = appearanceReport(index, cards, '0002').陆昭
  assert.equal(report.last, '')
  assert.equal(report.basis, 'none')
  assert.equal(report.plannedLast, '0002')
  assert.equal(report.candidateLast, '0002')
  assert.equal(report.gap, 2)
  assert.equal(report.due, true)

  const checked = await env.call('novel_check', { chapter: '0002', aiTone: false })
  assert.equal(checked.appearance.陆昭.last, '')
  assert.equal(checked.issues.some(issue => issue.kind === 'absent-role'), true)
  const receipt = env.render('novel_check', { chapter: '0002', aiTone: false }, checked)
  assert.match(receipt, /核实出场取当前正文仍有效的已确认「登场」记录/u)
  assert.doesNotMatch(receipt, /结构化场景 cast 为准|已确认人物历史/u)
})

test('画像或他人口述外貌的呈现记录不证明本人登场', async t => {
  const chapters = [
    { id: '0001', title: '一', text: '甲独自走进大厅。' },
    { id: '0002', title: '通缉画像', text: '墙上贴着陆昭的通缉画像，眉眼很深。' },
  ]
  const beats = beatsFile([
    { id: '0001', title: '一', body: scene('s1', 10, { cast: ['other'] }) },
    { id: '0002', title: '通缉画像', body: scene('s2', 20, { cast: ['lu-zhao'] }) },
  ])
  const env = await fixture(t, {
    chapters,
    beats,
    cards: [
      { name: '陆昭', text: '# 陆昭\n- ID：lu-zhao\n- 定位：主角\n- 戏份：每 2 章至少出场一次\n' },
      { name: '旁人', text: '# 旁人\n- ID：other\n- 定位：重要配角\n' },
    ],
  })
  const review = {
    baseHash: createHash('sha256').update(chapters[1].text).digest('hex'),
    scenes: [{ startIndex: 1, endIndex: 1, sceneId: 's2' }],
  }
  const book = JSON.parse(await fs.readFile(path.join(env.root, 'book.json'), 'utf8'))
  book.chapters[1].deaiReview = review
  env.chapters[1].deaiReview = review
  await fs.writeFile(path.join(env.root, 'book.json'), JSON.stringify(book, null, 2))

  // 主角本人没有出现，只有通缉画像交代外貌；呈现记录不能清零欠场。
  const portrait = await env.call('novel_character_history', {
    action: 'propose', character: 'lu-zhao', scene: 's2', kind: '呈现',
    content: '读者从通缉画像看到陆昭的眉眼', source: '通缉画像', evidence: '墙上贴着陆昭的通缉画像', evidenceIndex: 1,
  })
  assert.equal(portrait.record.binding.status, 'bound')
  await env.call('novel_character_history', { action: 'confirm', character: 'lu-zhao', id: portrait.record.id })
  await assert.rejects(
    env.call('novel_character_history', {
      action: 'propose', character: 'lu-zhao', scene: 's2', kind: '登场',
      content: '陆昭出场', source: '误判', evidence: '墙上贴着陆昭的通缉画像', evidenceIndex: 1,
    }),
    /onStage: true/u,
  )

  const cards = await listCharacters(env.root)
  const report = appearanceReport(await appearanceIndex(env.root, env.chapters, cards), cards, '0002').陆昭
  assert.equal(report.last, '')
  assert.equal(report.basis, 'none')
  assert.equal(report.plannedLast, '0002')
  assert.equal(report.due, true)
  const sceneView = await env.call('novel_context', { chapter: '0002', budget: 20000 })
  assert.match(sceneView.prompt, /通缉画像/u)
})

test('人物起算章仍按人物卡第一条状态，距离按书目顺序中的已写章数量', async t => {
  const chapters = [
    { id: '0005', title: '五', text: '甲在场。' },
    { id: '0006', title: '六', text: '乙在场。' },
    { id: '0020', title: '二十', text: '甲再次出现。' },
    { id: '0021', title: '二十一', text: '乙再次出现。' },
  ]
  const beats = beatsFile(chapters.map((chapter, index) => ({ id: chapter.id, title: chapter.title, body: scene(`s${index}`, (index + 1) * 10, { cast: ['hero'] }) })))
  const card = '# 甲\n- ID：hero\n- 定位：主角\n- 戏份：每 1 章至少出场一次\n## 状态\n- @0020 在世\n'
  const env = await fixture(t, { chapters, beats, cards: [{ name: '甲', text: card }] })
  const cards = await listCharacters(env.root)
  const index = await appearanceIndex(env.root, env.chapters, cards)
  assert.equal(appearanceReport(index, cards, '0005').甲, undefined)
  const atTwenty = appearanceReport(index, cards, '0020').甲
  assert.equal(atTwenty.since, '0020')
  assert.equal(atTwenty.gap, 1)
  assert.equal(atTwenty.due, true)
})
