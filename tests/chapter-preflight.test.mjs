import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { loadLedger, writeLedger } from '../lib/library.js'

const wrongPrice = '这口炉子值三块下品？'
const compensation = '料钱两块，误期一块，三块下品。'
const correctedLine = '料钱两块，加上误期一块，共索赔三块下品？'

async function createBook(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-chapter-preflight-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

function registerTools(root, { review, userQuestions } = {}) {
  const tools = new Map()
  apply({
    tools: { register: tool => tools.set(tool.name, tool) },
    get: name => name === 'userQuestions' ? userQuestions : undefined,
    effect() {},
    llm: { async *stream({ messages }) {
      const report = await review(JSON.parse(messages[0].content[0].text))
      const text = typeof report === 'string' ? report : JSON.stringify(report)
      yield { type: 'block-end', block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }, { root })
  const exec = {
    agent: { model: { current: () => ({ provider: 'test', model: 'test' }) }, session: { id: 'test' } },
    callId: 'approval',
  }
  return (name, args) => tools.get(name).execute(args, exec)
}

function compensationReport(sources) {
  const outline = sources.find(item => item.file === 'outline.md').text
  const evidence = [{ file: 'beats.md', quote: compensation }]
  const issues = outline.includes(wrongPrice) ? [{
    kind: 'conflict', detail: '总纲范本把三块索赔写成炉价',
    evidence: [...evidence, { file: 'outline.md', quote: wrongPrice }],
    question: '三块下品应按什么口径？',
    options: [{ label: '索赔', effect: '修订总纲范本' }, { label: '炉价', effect: '改写本章冲突' }],
  }] : []
  return { facts: [{ text: compensation, evidence }], issues }
}

async function createConflict(t) {
  const root = await createBook(t)
  const chapter = '0001'
  const outline = path.join(root, 'outline.md')
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({
    chapters: [{ id: chapter, title: '问价', file: 'chapters/0001.md' }],
  }))
  await fs.writeFile(outline, `# 总纲\n\n## 附一\n${wrongPrice}\n`)
  await fs.writeFile(path.join(root, 'beats.md'), `## 0001 问价
### 场景 dispute：索赔
- 时序：10
- 出场：chen
- 冲突：${compensation}
#### 人物 chen
- 目标：索赔
`)

  return { root, chapter, outline }
}

test('章前剧情冲突须经拷问和确认修订，复检通过后方可保存正文', async t => {
  const { root, chapter, outline } = await createConflict(t)
  let selected = []
  let reviewCount = 0
  const call = registerTools(root, {
    userQuestions: { async ask({ questions }) {
      const [question] = questions
      assert.match(question.question, /炉子值三块下品/u)
      assert.ok(question.question.includes(correctedLine))
      return { answers: [{ id: question.id, selected }] }
    } },
    review({ sources }) {
      reviewCount += 1
      return compensationReport(sources)
    },
  })
  const preflight = (action, args = {}) => call('novel_chapter_preflight', { action, chapter, ...args })
  const write = preflightId => call('novel_write', { chapter, content: '陈麻子把料钱和误期损失一笔笔报清。', preflightId })

  await assert.rejects(write(), /章前剧情预检/u)
  const blocked = await preflight('check')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.questions.length, 1)
  assert.equal((await preflight('check')).grillId, blocked.grillId)
  assert.equal(reviewCount, 1)
  const edits = [{ file: 'outline.md', before: wrongPrice, after: correctedLine, reason: '更正本章费用含义', issueIds: ['1'] }]
  await assert.rejects(preflight('preview', { preflightId: blocked.preflightId, edits }), /未获明确回答/u)
  const { baseHash } = await call('novel_grill', { action: 'inspect', id: blocked.grillId })
  await call('novel_grill', {
    action: 'answer', id: blocked.grillId, baseHash, questionId: blocked.questions[0].id,
    disposition: 'decided', selected: ['A'], answer: '按索赔写，改总纲范本。',
  })
  const { planId } = await preflight('preview', { preflightId: blocked.preflightId, edits })
  assert.equal((await preflight('apply', { planId })).status, 'blocked')
  assert.ok((await fs.readFile(outline, 'utf8')).includes(wrongPrice))

  selected = ['确认应用']
  const ready = await preflight('apply', { planId })
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.lastRepair.files, ['outline.md'])
  assert.equal(reviewCount, 2)
  const archived = await call('novel_grill', { action: 'list' })
  assert.deepEqual(archived.sessions.map(session => session.status), ['archived'])
  const history = await call('novel_grill', { action: 'inspect', id: blocked.grillId })
  assert.equal(history.session.questions[0].answer.text, '按索赔写，改总纲范本。')
  await assert.rejects(call('novel_grill', {
    action: 'resume', id: blocked.grillId, baseHash: history.baseHash,
  }), /已归档/u)
  const context = await call('novel_context', { chapter })
  assert.equal(context.chapterPreflight.preflightId, ready.preflightId)
  assert.ok(context.prompt.includes(compensation))

  await fs.appendFile(outline, '\n附记更新。\n')
  await assert.rejects(write(ready.preflightId), /stale/u)
  const checked = await preflight('check')
  assert.equal(checked.status, 'ready')
  assert.ok((await write(checked.preflightId)).chars > 0)
})

for (const useChapterId of [true, false]) {
  test(`新章沿用预检标题及编号（${useChapterId ? '指定章 ID' : '省略章 ID'}）`, async t => {
    const root = await createBook(t)
    const chapter = '0001'
    const line = '风从城北吹来。'
    await fs.writeFile(path.join(root, 'outline.md'), `## 风起\n${line}\n`)
    const report = { facts: [{ text: line, evidence: [{ file: 'outline.md', quote: line }] }], issues: [] }
    const call = registerTools(root, {
      review: () => [
        '已核对资料。', '```json', '这段不是有效结果。', '```',
        '```json', JSON.stringify(report), '```', '以上为核对结果。',
      ].join('\n'),
    })
    const check = await call('novel_chapter_preflight', { action: 'check', chapter, title: '风起' })
    assert.equal(check.status, 'ready')
    const target = useChapterId ? { chapter } : {}
    if (useChapterId) await assert.rejects(call('novel_write', { chapter, content: line }), /提供 preflightId/u)
    const context = await call('novel_context', target)
    assert.equal(context.chapter.title, '风起')
    assert.equal(context.chapterPreflight.preflightId, check.preflightId)
    const draft = { ...target, content: line, preflightId: check.preflightId }
    await assert.rejects(call('novel_write', { ...draft, title: '风落' }), /stale/u)
    const written = await call('novel_write', draft)
    assert.equal(written.id, chapter)
    assert.equal(written.title, '风起')
  })
}

test('小幅润色可保存，新增段落和任意位置明显扩写需预检', async t => {
  const root = await createBook(t)
  const chapter = '0001'
  const file = path.join(root, 'chapters', '0001.md')
  const original = '火烧起来了。\n\n他关了门。\n'
  const line = '火势继续蔓延。'
  const baseHash = createHash('sha256').update(original).digest('hex')
  const call = registerTools(root)
  await fs.mkdir(path.dirname(file))
  await fs.writeFile(file, original)
  const write = args => call('novel_write', { chapter, baseHash, ...args })
  await assert.rejects(write({
    mode: 'replace', content: original.replace('。', '！') + '\n' + line,
  }), /章前剧情预检/u)
  const last = '他关了门。'
  const start = original.indexOf(last)
  await assert.rejects(write({
    mode: 'patch', patches: [
      { start: 0, end: start, content: '起火。\n\n' },
      { start, end: start + last.length, content: last + '\n\n' + line },
    ],
  }), /章前剧情预检/u)
  await assert.rejects(write({
    mode: 'patch', start: 0, end: 1, content: line.repeat(10),
  }), /章前剧情预检/u)
  assert.equal(await fs.readFile(file, 'utf8'), original)

  const polished = '他随手掩上了门。'
  await write({ mode: 'patch', start, end: start + last.length, content: polished })
  const revised = original.replace(last, polished)
  assert.equal(await fs.readFile(file, 'utf8'), revised)
  const final = revised.replace('火烧起来了。', '巷口的火烧了起来。')
  const rename = fs.rename
  let atomicallySaved = false
  t.mock.method(fs, 'rename', async (from, target) => {
    if (target === file) atomicallySaved = true
    return rename(from, target)
  })
  await call('novel_write', {
    chapter, mode: 'replace', baseHash: createHash('sha256').update(revised).digest('hex'), content: final,
  })
  assert.equal(await fs.readFile(file, 'utf8'), final)
  assert.ok(atomicallySaved)
})

test('批量写入中断后恢复，复检输出无效时可重试', async t => {
  const { root, chapter, outline } = await createConflict(t)
  const events = path.join(root, 'events.md')
  const oldEvent = '陈麻子报炉价。'
  const newEvent = '陈麻子报出两笔损失的合计。'
  await fs.writeFile(events, `# 事件线\n${oldEvent}\n`)
  let confirmations = 0
  let invalidRecheck = true
  const call = registerTools(root, {
    userQuestions: { async ask({ questions }) {
      confirmations += 1
      return { answers: [{ id: questions[0].id, selected: ['确认应用'] }] }
    } },
    review({ sources, revisions }) {
      return revisions && invalidRecheck ? '无法解析的结果。' : compensationReport(sources)
    },
  })
  const preflight = (action, args = {}) => call('novel_chapter_preflight', { action, chapter, ...args })
  const blocked = await preflight('check')
  await call('novel_grill', {
    action: 'answer', id: blocked.grillId, baseHash: blocked.grillBaseHash, questionId: blocked.questions[0].id,
    disposition: 'decided', answer: '按索赔写，两处都改。',
  })
  const { planId } = await preflight('preview', { preflightId: blocked.preflightId, edits: [
    { file: 'outline.md', before: wrongPrice, after: correctedLine, reason: '更正本章范本', issueIds: ['1'] },
    { file: 'events.md', before: oldEvent, after: newEvent, reason: '同步本章事件线', issueIds: ['1'] },
  ] })

  const rename = fs.rename
  const writes = []
  let fail = true
  t.mock.method(fs, 'rename', async (from, target) => {
    if (target === outline || target === events) writes.push(path.basename(target))
    if (target === events && fail) throw new Error('模拟事件线写入失败')
    return rename(from, target)
  })
  const interrupted = await preflight('apply', { planId })
  assert.equal(interrupted.status, 'write-failed')
  assert.deepEqual(interrupted.applied, ['outline.md'])
  assert.ok((await fs.readFile(outline, 'utf8')).includes(correctedLine))
  assert.ok((await fs.readFile(events, 'utf8')).includes(oldEvent))

  fail = false
  await assert.rejects(preflight('resume', { planId }), /有效的 JSON 核对结果/u)
  assert.equal((await preflight('inspect')).status, 'recheck')
  assert.ok((await fs.readFile(events, 'utf8')).includes(newEvent))
  invalidRecheck = false
  const ready = await preflight('check')
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.lastRepair.files, ['outline.md', 'events.md'])
  assert.deepEqual(writes, ['outline.md', 'events.md', 'events.md'])
  assert.equal(confirmations, 1)
})

test('章前资料路径解析到书稿父目录时拒绝读取', async t => {
  const root = await createBook(t)
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({
    chapters: [{ id: '0001', title: '边界', file: 'chapters/../..' }],
  }))
  const call = registerTools(root)
  await assert.rejects(call('novel_chapter_preflight', { action: 'check', chapter: '0001' }), /资料路径超出书稿目录/u)
})

test('预检和写作上下文都识别人物别名与复合设定，作废设定不进入核对', async t => {
  const root = await createBook(t)
  const chapter = '0001'
  const line = '小七从雾港乘船离开。'
  await fs.writeFile(path.join(root, 'outline.md'), `## 第 1 章\n${line}\n`)
  await fs.mkdir(path.join(root, 'characters'))
  for (const name of ['安甲', '白乙', '陈丙', '陆小北']) {
    await fs.writeFile(path.join(root, 'characters', name + '.md'), `# ${name}\n${name === '陆小北' ? '- 别名：小七\n' : ''}`)
  }
  await fs.mkdir(path.join(root, 'settings'))
  await fs.writeFile(path.join(root, 'settings', '雾港-商路.md'), '# 雾港商路\n有客船。')
  await fs.writeFile(path.join(root, 'settings', '雾港-旧规则.md'), '# 雾港旧规则\n- 状态：作废\n没有客船。')
  const call = registerTools(root, {
    review({ sources }) {
      const files = sources.map(source => source.file)
      assert.ok(files.includes('characters/陆小北.md'))
      assert.ok(files.includes('settings/雾港-商路.md'))
      assert.ok(!files.includes('settings/雾港-旧规则.md'))
      return { facts: [{ text: line, evidence: [{ file: 'outline.md', quote: line }] }], issues: [] }
    },
  })
  await call('novel_chapter_preflight', { action: 'check', chapter, sources: ['settings/雾港-旧规则.md'] })
  const context = await call('novel_context', { chapter })
  assert.ok(context.characters.some(item => item.name === '陆小北'))
  assert.deepEqual(context.settings.map(item => item.name), ['雾港-商路'])
})

test('重检仍阻塞时归档旧拷问，模型核对期间可以查询状态', async t => {
  const { root, chapter, outline } = await createConflict(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let reviewCount = 0
  const call = registerTools(root, {
    async review({ sources }) {
      if (++reviewCount === 2) {
        entered.resolve()
        await release.promise
      }
      return compensationReport(sources)
    },
  })
  const preflight = action => call('novel_chapter_preflight', { action, chapter })
  const first = await preflight('check')
  await fs.appendFile(outline, '\n补充附记。')
  const recheck = preflight('check')
  let timer
  try {
    await Promise.race([entered.promise, recheck])
    const status = await Promise.race([
      preflight('inspect'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('查询状态被模型调用阻塞')), 2000) }),
    ])
    assert.equal(status.status, 'stale')
  } finally {
    clearTimeout(timer)
    release.resolve()
    await recheck
  }
  const second = await recheck
  assert.equal(second.status, 'blocked')
  assert.notEqual(second.grillId, first.grillId)
  const { sessions } = await call('novel_grill', { action: 'list' })
  assert.equal(sessions.find(session => session.id === first.grillId).status, 'archived')
  assert.equal(sessions.find(session => session.id === second.grillId).status, 'active')
  const stateDir = path.join(root, '.novel', 'chapter-preflight')
  const [stateName] = await fs.readdir(stateDir)
  const state = JSON.parse(await fs.readFile(path.join(stateDir, stateName), 'utf8'))
  assert.equal(Object.hasOwn(state, 'supersededGrillId'), false)
})

test('并发更新不同台账项目保留全部变更', async t => {
  const root = await createBook(t)
  const items = ['旧钥匙', '银票', '伤药', '通行证']
  await Promise.all(items.map(item => writeLedger(root, { item, state: '已登记' })))
  const { rows } = await loadLedger(root)
  assert.deepEqual(rows.map(row => row.item).sort(), [...items].sort())
})

test('局部补丁纯拆段和整章拆段兼带小幅润色可以保存', async t => {
  const root = await createBook(t)
  const chapter = '0001'
  const file = path.join(root, 'chapters', '0001.md')
  const original = '天亮了，他掩上门。巷口的火烧了起来。他提灯跑过去。'
  await fs.mkdir(path.dirname(file))
  await fs.writeFile(file, original)
  const call = registerTools(root)
  const first = '天亮了，他掩上门。'
  const split = original.replace(first, first + '\n\n')
  await call('novel_write', {
    chapter, mode: 'patch', baseHash: createHash('sha256').update(original).digest('hex'),
    start: 0, end: Array.from(original).length, content: split,
  })
  assert.equal(await fs.readFile(file, 'utf8'), split)

  const polished = split.replace('烧了起来。他提灯', '渐渐烧了起来。\n\n他提起灯')
  await call('novel_write', {
    chapter, mode: 'replace', baseHash: createHash('sha256').update(split).digest('hex'), content: polished,
  })
  assert.equal(await fs.readFile(file, 'utf8'), polished)
})

test('预检模型只收到文风规则，隐藏校准记录的更新沿用已有核对', async t => {
  const root = await createBook(t)
  const chapter = '0001'
  const line = '风从城北吹来。'
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ style: '简洁' }))
  await fs.writeFile(path.join(root, 'outline.md'), `## 第 1 章\n${line}\n`)
  await fs.mkdir(path.join(root, 'styles'))
  const card = path.join(root, 'styles', '简洁.md')
  const visible = '# 文风\n\n- 保持第三人称。\n'
  const updateCalibration = draft => fs.writeFile(card,
    `${visible}\n<!-- novel-style-calibration: ${JSON.stringify([{ draft }])} -->\n`)
  await updateCalibration('试写样稿'.repeat(45000))
  let reviewCount = 0
  const call = registerTools(root, {
    review({ sources }) {
      reviewCount += 1
      assert.equal(sources.find(source => source.file === 'styles/简洁.md').text, visible)
      return { facts: [{ text: line, evidence: [{ file: 'outline.md', quote: line }] }], issues: [] }
    },
  })
  const preflight = action => call('novel_chapter_preflight', { action, chapter })
  const first = await preflight('check')
  assert.equal(first.status, 'ready')
  await updateCalibration('改了校准样稿。')
  assert.equal((await preflight('check')).preflightId, first.preflightId)
  assert.equal(reviewCount, 1)
  await fs.appendFile(card, '\n- 避免长句。')
  assert.equal((await preflight('inspect')).status, 'stale')
})

test('阻塞拷问文件丢失时，查询与修订入口引导重检并可恢复', async t => {
  const { root, chapter, outline } = await createConflict(t)
  let reviewCount = 0
  let confirmations = 0
  const call = registerTools(root, {
    userQuestions: { async ask({ questions }) {
      confirmations += 1
      return { answers: [{ id: questions[0].id, selected: ['确认应用'] }] }
    } },
    review({ sources }) {
      reviewCount += 1
      return compensationReport(sources)
    },
  })
  const preflight = (action, args = {}) => call('novel_chapter_preflight', { action, chapter, ...args })
  const removeInterview = id => fs.unlink(path.join(root, '.novel', 'grills', id + '.json'))
  const first = await preflight('check')
  await removeInterview(first.grillId)
  assert.equal((await preflight('inspect')).status, 'stale')
  await assert.rejects(preflight('preview', { preflightId: first.preflightId }), /拷问会话已失效，请重新预检/u)

  const rebuilt = await preflight('check')
  assert.equal(rebuilt.status, 'blocked')
  assert.notEqual(rebuilt.grillId, first.grillId)
  assert.equal((await preflight('check')).grillId, rebuilt.grillId)
  assert.equal(reviewCount, 2)
  await call('novel_grill', {
    action: 'answer', id: rebuilt.grillId, baseHash: rebuilt.grillBaseHash,
    questionId: rebuilt.questions[0].id, disposition: 'decided', answer: '按索赔写，修订总纲。',
  })
  const { planId } = await preflight('preview', { preflightId: rebuilt.preflightId, edits: [
    { file: 'outline.md', before: wrongPrice, after: correctedLine, reason: '更正本章范本', issueIds: ['1'] },
  ] })
  await removeInterview(rebuilt.grillId)
  await assert.rejects(preflight('apply', { planId }), /拷问会话已失效，请重新预检/u)
  assert.equal(confirmations, 0)
  assert.ok((await fs.readFile(outline, 'utf8')).includes(wrongPrice))
})

test('首章无需前文，章纲引文不合格时自动纠正一次', async t => {
  const root = await createBook(t)
  const chapter = '0001'
  const line = '- 冲突：守门人拦住陆昭。'
  await fs.writeFile(path.join(root, 'beats.md'), `## 0001 第 1 章\n### 场景 entrance：城门\n- 时序：10\n- 出场：hero\n${line}\n#### 人物 hero\n- 目标：入城\n`)
  let attempts = 0
  const call = registerTools(root, {
    review({ sources, feedback }) {
      assert.ok(!sources.find(source => source.file === 'chapters/0001.md').text)
      assert.ok(sources.find(source => source.file === 'beats.md').text.includes(line))
      attempts += 1
      if (attempts === 1) {
        assert.equal(feedback, undefined)
        return { facts: [{ text: '守门人拦下了陆昭。', evidence: [] }], issues: [] }
      }
      assert.match(feedback, /第 1 条.*未提供引文/u)
      return { facts: [{ text: '首场由守门人拦住陆昭。', evidence: [{ file: 'beats.md', quote: line }] }], issues: [] }
    },
  })
  const result = await call('novel_chapter_preflight', { action: 'check', chapter })
  assert.equal(result.status, 'ready')
  assert.equal(attempts, 2)
  assert.equal((await call('novel_grill', { action: 'list' })).sessions.length, 0)
})

test('首章资料缺失时以拷问澄清起稿方向', async t => {
  const root = await createBook(t)
  const chapter = '0001'
  const call = registerTools(root, {
    review: () => ({
      facts: [],
      issues: [{
        kind: 'missing-basis', detail: '缺少开篇剧情要求。', evidence: [],
        question: '首章以哪场冲突开篇？',
        options: [{ label: '城门受阻', effect: '开篇明确入城目标' }, { label: '河边遇险', effect: '开篇建立紧迫局势' }],
      }],
    }),
  })
  const result = await call('novel_chapter_preflight', { action: 'check', chapter })
  assert.equal(result.status, 'blocked')
  assert.equal(result.questions.length, 1)
})
