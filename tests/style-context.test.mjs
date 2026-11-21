import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import { styleAnchorText } from '../lib/text.js'

// 测试纯装配函数，无需启动 DSH 或改变生产模块导出。
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('function assembleStylePrompt(')
const end = source.indexOf('function detectVoice', start)
const assemble = vm.runInNewContext(`${source.slice(start, end)}; assembleStylePrompt`)
const cues = source.slice(source.indexOf('const STYLE_SCENE_CUES'), source.indexOf('/** 文风按完整条目'))
const sampling = source.slice(source.indexOf('function styleSceneScores'), source.indexOf('/** 只选择本章标题匹配'))
const sample = vm.runInNewContext(`${cues}\n${sampling}; sampleExcerpts`)
const cardStart = source.indexOf('function composeStyleCard')
const cardEnd = source.indexOf('function safeStyleName', cardStart)
const compose = vm.runInNewContext(`${source.slice(cardStart, cardEnd)}; composeStyleCard`)
const requestStart = source.indexOf('function readRequestBody')
const requestEnd = source.indexOf('/** 从人物卡里抠出', requestStart)
const { readBody, readJson } = vm.runInNewContext(
  `${source.slice(requestStart, requestEnd)}; ({ readBody: readRequestBody, readJson: readJsonBody })`, { Buffer },
)
const decodeStart = source.indexOf('function detectEncoding')
const decodeEnd = source.indexOf('/** 以文字线索粗分场景', decodeStart)
const decodeUpload = vm.runInNewContext(`${source.slice(decodeStart, decodeEnd)}; decodeStyleUpload`, {
  Buffer, TextDecoder, MANUSCRIPT_MAX_BYTES: 32 * 1024 * 1024,
})
const rulesStart = source.indexOf('function verifyStyleRules')
const rulesEnd = source.indexOf('// 参考文本', rulesStart)
const { verify, append, calibrationText, formatStylePreference, readCalibration, withCalibration, applyCalibration } = vm.runInNewContext(
  `${source.slice(rulesStart, rulesEnd)}; ({ verify: verifyStyleRules, append: appendStyleRules,
    calibrationText, formatStylePreference, readCalibration: readStyleCalibration,
    withCalibration: withStyleCalibration, applyCalibration: applyStyleCalibration })`,
)
const generateStart = source.indexOf('async function generateStyleRules')
const generateEnd = source.indexOf('function composeStyleCard', generateStart)
const generate = vm.runInNewContext(`${source.slice(generateStart, generateEnd)}; generateStyleRules`, {
  AbortSignal, verifyStyleRules: verify, calibrationText, formatStylePreference,
})
const card = `# 文风卡：测试
- 视角与时态：第三人称限知，不得读取旁人的思想
## 对话
- 第一条
- 第二条
- 第三条：避免解释台词
- 正例：他说：“走吧。”
## 反例
- “他很悲伤。”不要直接总结
## 锚点原文
### 锚点 1
> “走。”
> 他站起来，推开门。
### 锚点 2
> 她没有回答。
## 禁忌
- 氤氲`

test('保留顶部视角、第三条规则、正反例和全部锚点', () => {
  const result = assemble(card.replaceAll('\n', '\r\n'), 2000)
  for (const text of ['第三人称限知', '第三条', '他说', '不要直接总结', '推开门', '她没有回答']) {
    assert.ok(result.text.includes(text), text)
  }
  assert.equal(result.omitted.length, 0)
})

test('后置必选规则优先，省略条目有原因，锚点不截断', () => {
  const result = assemble(`${card}\n## 其他\n- [必选] 不得改变人称`, 95)
  assert.ok(result.text.includes('第三人称限知'))
  assert.ok(result.text.includes('不得改变人称'))
  assert.ok(result.omitted.length > 0)
  assert.ok(result.omitted.every(item => item.reason))
  assert.ok(Array.from(result.text).length <= 95)
  if (result.text.includes('锚点 1')) assert.ok(result.text.includes('推开门。'))
})

test('顶部多行必选项整条进入硬预算，续行不被拆成可选说明', () => {
  const content = '- [必选] 不得越过主角的限知视角\n  （例外：群像全景可短暂切到旁观者）\n- 普通说明。'
  const result = assemble(content, 1)
  assert.equal(result.requiredItems.length, 1)
  assert.match(result.text, /例外：群像全景可短暂切到旁观者/u)
  assert.equal(result.missingRequired.length, 0)
})

test('空行后的缩进续段仍属于上一条必选规则', () => {
  const content = '- [必选] 不得越过主角的限知视角\n\n  （例外：群像全景可短暂切到旁观者）\n'
  const result = assemble(content, 1)
  assert.equal(result.requiredItems.length, 1)
  assert.match(result.text, /例外：群像全景可短暂切到旁观者/u)
  // 空行后的非缩进文字仍是独立说明，不被吸进上一条规则。
  const separated = assemble('- [必选] 主语只能是主角\n\n普通卡片说明。', 200)
  assert.equal(separated.requiredItems.length, 1)
  assert.ok(separated.requiredItems[0].chars < Array.from(separated.text).length)
  assert.match(separated.text, /- \[必选\] 主语只能是主角/u)
  assert.match(separated.text, /普通卡片说明。/u)
})

test('必选规则突破文风软份额且重排后仍携带分类标题', () => {
  const content = '## 语义禁忌\n- 普通规则。\n- [必选] 不得越过主角限知视角。'
  const result = assemble(content, 20)
  assert.ok(result.used > result.budget)
  assert.equal(result.requiredItems.length, 1)
  assert.match(result.text, /^## 语义禁忌\n- \[必选\] 不得越过主角限知视角。/u)
  assert.equal(result.missingRequired.length, 0)
})

test('首条过长被省略时后续条目仍保留反例、少用词和语义禁忌标题', () => {
  for (const heading of ['反例', '少用词', '语义禁忌']) {
    const result = assemble(`## ${heading}\n- ${'很长'.repeat(100)}\n- 短条目`, 30)
    assert.equal(result.text, `## ${heading}\n- 短条目`)
  }
})

test('只认列表项开头的必选标记，卡片顶部规则同样进入硬预算', () => {
  const result = assemble('## 普通规则\n- 这是一条示例。\n  引文中写了 [必选]，但不是规则标记。', 200)
  assert.equal(result.requiredItems.length, 0)
  const top = assemble('- [必选] 不得改变叙述人称。', 1)
  assert.equal(top.requiredItems.length, 1)
  assert.match(top.text, /不得改变叙述人称/u)
})

test('文风软份额不能裁剪叙述权限，旧卡及空卡可用', () => {
  const tiny = assemble(card, 1)
  assert.equal(tiny.text, tiny.requiredText)
  assert.ok(tiny.minimumBudget > tiny.budget)
  assert.ok(tiny.omitted.length > 0)
  assert.equal(assemble('', 100).included.length, 0)
  assert.ok(assemble('只使用第一人称。', 100).text.includes('只使用第一人称'))
  const anchor = '## 锚点原文\n> 短句。\n> 第二句。'
  assert.equal(assemble(anchor, 100).text, anchor)
})

test('场景上下文保留核心规则、通用锚点和匹配锚点，说明省略原因', () => {
  const content = '# 文风卡：测试\n## 核心规则\n- [必选] 第三人称限知\n## 锚点原文\n### 锚点 1【动作】\n> 她扑向门口。\n### 锚点 2【通用】\n> 风一下停了。\n### 锚点 3【对白】\n> “走。”'
  const result = assemble(content, 1000, ['对白'])
  assert.ok(result.text.includes('第三人称限知'))
  assert.ok(result.text.includes('风一下停了。'))
  assert.ok(result.text.includes('“走。”'))
  assert.ok(!result.text.includes('她扑向门口。'))
  assert.match(result.omitted[0].reason, /当前场景/u)
  assert.ok(assemble(content, 1000).text.includes('她扑向门口。'))
})

test('多场章纲优先装配每种场景各一段锚点', () => {
  const content = '# 文风卡：测试\n## 叙述主声\n- 旁白跟随人物判断。\n## 锚点原文\n'
    + '### 锚点 1【对白】\n> “等等。”\n### 锚点 2【对白】\n> “再说一遍。”\n'
    + '### 锚点 3【动作】\n> 他扑向门口。\n### 锚点 4【心理】\n> 她重新思量了片刻。'
  const result = assemble(content, 2000, ['对白', '动作', '心理'])
  assert.ok(result.text.includes('旁白跟随人物判断'))
  assert.ok(!result.text.includes('再说一遍'))
  assert.equal(result.included.filter(item => item.kind).map(item => item.kind).join('、'), '对白、动作、心理')
})

test('当众验证和异常发现按叙事任务选样本，排除赛程概述', () => {
  const content = [
    '## 锚点原文',
    '### 锚点 1【动作】', '> 正文 第五百六十五章 第二轮', '> 第一日共二十五场比试，淘汰赛依次结束了。',
    '### 锚点 2【通用】', '> 话音落下，围观众人脸色一变。有人喝道：先让他把证据拿出来。',
    '### 锚点 3【对白】', '> “不可能！”她一怔，定眼一看，那道暗纹居然动了。',
  ].join('\n')
  const scenes = [
    { title: '当众验炉', text: '当众验证证据，掌柜不认账。', kinds: ['动作'] },
    { title: '废料堆', text: '挑铜时听见不该有的声音。', kinds: [] },
  ]
  const result = assemble(content, 2000, ['动作'], scenes)
  assert.ok(result.sceneGuide[0].includes('锚点原文 2'))
  assert.ok(result.sceneGuide[0].includes('反应如何改变交锋'))
  assert.ok(result.sceneGuide[1].includes('锚点原文 3'))
  assert.ok(result.sceneGuide[1].includes('异常显露'))
  assert.ok(!result.text.includes('淘汰赛'))
  assert.ok(!assemble(content, 2000).text.includes('正文 第五百六十五章'))
})

test('审稿不能用文风规则条款替代锚点原文证据', async () => {
  const start = source.indexOf('async function reviewSourceCoverage')
  const end = source.indexOf('async function readReviewSource', start)
  const coverage = vm.runInNewContext(`${source.slice(start, end)}; reviewSourceCoverage`, {
    listCharacters: async () => [], listSettings: async () => [],
    activeStyleName: () => '测试', readStyle: async () => card, styleAnchorText,
  })
  const checks = { rhythm: { verdict: 'supported', evidence: [{ source: 'style', name: '测试', quote: '第三条：避免解释台词' }] } }
  const missing = await coverage('/book', {}, '正文', checks)
  assert.equal(missing.findings[0].verdict, 'uncertain')
  assert.match(missing.findings[0].detail, /锚点原文/u)
  checks.rhythm.evidence[0].quote = '他站起来，推开门。'
  assert.equal((await coverage('/book', {}, '正文', checks)).findings.length, 0)
})

test('AI 规则核验原文行号，追加去重并进入写作上下文', () => {
  const raw = '“你去过？”\r\n他等了一会。\r\n“先说你是怎么知道的。”'
  const candidate = {
    scope: '通用',
    rule: '追问时可以先反问。',
    evidence: [
      { startLine: 1, endLine: 1, quote: '你去过？' },
      { startLine: 3, endLine: 3, quote: '怎么知道的' },
    ],
  }
  assert.throws(() => verify([{ ...candidate, evidence: [candidate.evidence[0]] }], raw), /两处/u)
  const wrong = { ...candidate.evidence[0], startLine: 2, endLine: 2 }
  assert.throws(() => verify([{ ...candidate, evidence: [wrong] }], raw), /引文.*不符/u)
  const checked = verify([candidate], raw)
  const result = append(card, checked)
  assert.equal(result.added, 1)
  assert.ok(result.content.startsWith(card))
  assert.ok(result.content.includes('## AI 提炼的文风规则'))
  assert.ok(result.content.includes('原文第 3–3 行'))
  assert.equal(append(result.content, checked).added, 0)
  const context = assemble(result.content, 2500)
  assert.ok(context.text.includes('追问时可以先反问。'))
  assert.ok(!context.text.includes('怎么知道的'))
})

const calibrationQuestion = {
  scope: '对白',
  question: '是否在追问后立即给出答案？',
  options: [
    { label: '延迟揭示', effect: '读者多等一个来回。', rule: '追问后先留一个来回，再揭示答案。' },
    { label: '立即回答', effect: '对话推进更快。', rule: '追问后立即给出关键答案。' },
  ],
}

test('模型只选择已展示的行号，插件给规则和校准题回填原文证据', async () => {
  const raw = '这行不发送。\r\n“先说你是怎么知道的。”\r\n\r\n她没接话。\r\n他把前因一口气交代了。'
  const excerpts = [
    { kind: '对白', sourceGroup: '第一章', startLine: 2, text: '“先说你是怎么知道的。”' },
    { kind: '通用', sourceGroup: '第二章', startLine: 4, text: '她没接话。' },
    { kind: '对白', sourceGroup: '第三章', startLine: 5, text: '他把前因一口气交代了。' },
  ]
  const preference = { when: '双方在试探筹码', prefer: '用追问延迟交代信息', unless: '读者缺少理解动作的前提' }
  const modelQuestion = {
    scope: '对白', question: '希望谈判的判断过程显露到什么程度？', scenario: '双方都在试探，读者已知道双方的即时目标。',
    options: [
      { ...preference, label: '保留不确定性', effect: '让读者自己判断试探成败。', example: '她把信推了过去。“你想从这儿知道什么？”他没有接信。' },
      { ...preference, label: '显露判断', effect: '读者更早理解风险。', prefer: '用一句叙述交代视角人物的判断', example: '她把信推了过去。他没伸手。她猜他还拿不准信的真假。“你想知道什么？”' },
    ],
  }
  const calls = []
  const llm = {
    async *stream(options) {
      calls.push(options)
      const evidence = calls.length === 1 ? [1, 3] : [2, 4]
      const text = JSON.stringify({
        rules: [{ scope: '对白', ...preference, evidence, contrast: [5] }],
        narrative: [{ facet: '旁白声调', pattern: '让叙述紧贴听见和看见的反应。', evidence: [2, 4] }],
        questions: [{ ...modelQuestion, evidence: [2, 4] }, { ...modelQuestion, evidence: [2] }],
      })
      yield { type: 'block-end', block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const agent = { session: { id: 'test-session' }, model: { current: () => ({ provider: 'test-provider', model: 'test-model' }) } }
  const { rules, narrative, questions } = await generate(llm, agent, excerpts, raw)
  assert.equal(rules.length, 1)
  assert.match(rules[0].rule, /当双方在试探筹码时.*读者缺少理解动作的前提时可以调整/u)
  assert.equal(rules[0].evidence[0].quote, '“先说你是怎么知道的。”')
  assert.equal(rules[0].evidence[1].startLine, 4)
  assert.equal(rules[0].evidence[1].quote, '她没接话。')
  assert.equal(rules[0].contrast[0].quote, '他把前因一口气交代了。')
  assert.equal(narrative[0].facet, '旁白声调')
  assert.equal(narrative[0].evidence[1].startLine, 4)
  assert.equal(questions.length, 1)
  assert.equal(questions[0].scenario, modelQuestion.scenario)
  assert.equal(questions[0].evidence[1].quote, '她没接话。')
  assert.equal(questions[0].answer, null)
  assert.equal(questions[0].options[0].example, modelQuestion.options[0].example)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].model, 'test-model')
  assert.equal(calls[0].sessionId, 'test-session')
  assert.match(calls[0].messages[0].content[0].text, /2 \| “先说/u)
  assert.ok(!calls[0].messages[0].content[0].text.includes('这行不发送'))
  assert.match(calls[1].messages[0].content[0].text, /已展示的原文行号/u)
})

test('保存或跳过校准题只更新对应规则，未选方案不进入写作上下文', () => {
  const first = { ...calibrationQuestion, id: 1, evidence: [], answer: null }
  const second = { ...calibrationQuestion, id: 2, evidence: [], answer: null }
  const initial = withCalibration(card, [first, second])
  assert.throws(() => applyCalibration(initial, { 3: { option: 0 } }), /不属于/u)
  const answered = applyCalibration(initial, { 1: { option: 0 }, 2: { custom: '短答后允许留白。' } })
  const assembled = assemble(answered, 2500).text
  assert.ok(assembled.includes('## 作者校准规则'))
  assert.ok(assembled.includes(first.options[0].rule))
  assert.ok(assembled.includes('短答后允许留白。'))
  assert.ok(!assembled.includes(first.options[1].rule))
  assert.ok(!assembled.includes(first.question))
  const skipped = applyCalibration(answered, { 1: { skip: true } })
  const reopened = readCalibration(skipped)
  assert.equal(reopened.questions[0].answer.skip, true)
  assert.equal(reopened.questions[1].answer.custom, '短答后允许留白。')
  assert.ok(reopened.content.includes('短答后允许留白。'))
  assert.ok(!reopened.content.includes(first.options[0].rule))
  const adaptive = readCalibration(applyCalibration(answered, { 1: { adaptive: true } }))
  assert.equal(adaptive.questions[0].answer.adaptive, true)
  assert.ok(!adaptive.content.includes(first.options[0].rule))
  assert.ok(adaptive.content.includes('短答后允许留白。'))
  const local = readCalibration(applyCalibration(answered, { 1: { option: 1, local: true } }))
  assert.equal(local.questions[0].answer.local, true)
  assert.ok(!local.content.includes(first.options[0].rule))
  assert.ok(!local.content.includes(first.options[1].rule))
})

test('反例不合格时保留有效的场景偏好，只重试被拒的通用偏好', async () => {
  const raw = '她等他先开口。\n他把信攥紧了。\n他问她来意。'
  const excerpts = [
    { kind: '对白', sourceGroup: '第一章', startLine: 1, text: '她等他先开口。\n他把信攥紧了。' },
    { kind: '对白', sourceGroup: '第二章', startLine: 3, text: '他问她来意。' },
  ]
  const preference = { when: '人物正在试探', unless: '读者还不知道争执缘由' }
  const scoped = { ...preference, scope: '对白', prefer: '让短暂停顿显出顾虑', evidence: [1], contrast: [2] }
  const general = { ...preference, scope: '通用', prefer: '始终用追问推进', evidence: [1, 3], contrast: [2] }
  const verification = {
    scope: '对白', question: '你更喜欢哪一版表现犹豫？', scenario: '两人交接一封信，一方不确定该不该接。',
    evidence: [1], options: [
      { ...preference, label: '压住情绪', effect: '保留不确定性。', prefer: scoped.prefer, example: '她伸手，停在离信封半寸的地方。对面的人等着，谁都没说话。' },
      { ...preference, label: '直接表达顾虑', effect: '让读者马上理解她的迟疑。', prefer: '用一句短答说出担心', example: '她伸手，停在离信封半寸的地方。“我怕他们知道。”她把那句话说得很轻。' },
    ],
  }
  const requests = []
  const llm = {
    async *stream(options) {
      requests.push(options.messages[0].content[0].text)
      const rules = requests.length === 1 ? [scoped, general] : [general]
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify({
        rules, questions: requests.length === 3 ? [verification] : [],
      }) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const agent = { session: { id: 'session' }, model: { current: () => ({ provider: 'provider', model: 'model' }) } }
  const result = await generate(llm, agent, excerpts, raw)
  assert.equal(requests.length, 3)
  assert.match(requests[1], /始终用追问推进/u)
  assert.ok(!requests[1].includes('让短暂停顿显出顾虑'))
  assert.equal(result.rules.length, 1)
  assert.equal(result.rules[0].scope, '对白')
  assert.equal(result.rules[0].contrast.length, 0)
  assert.equal(result.warnings.length, 2)
  assert.match(requests[2], /让短暂停顿显出顾虑/u)
  assert.equal(result.questions[0].verification, true)
  assert.equal(result.questions[0].evidence[0].quote, '她等他先开口。')
})

test('同类场景从不同章段取样，保留出处和原始行号', () => {
  const raw = [
    '第一章试探', '“你要什么？”他反问。', '“说清楚。”她追问。',
    '第二章 交涉', '“先把门打开。”她反问道。', '他没有回答。',
    '第三章 归途', '风吹过空巷，灯从墙头落下。',
  ].join('\n')
  const dialogue = sample(raw, 9, 100).filter(item => item.kind === '对白')
  assert.equal(dialogue.length, 2)
  assert.equal(new Set(dialogue.map(item => item.sourceGroup)).size, 2)
  assert.equal(dialogue[1].startLine, 5)
})

test('本书试写两版共享章纲和模型，只有一版带待验证文风', async () => {
  const start = source.indexOf('async function generateStyleTrial')
  const end = source.indexOf('function composeStyleCard', start)
  const requests = []
  const trial = vm.runInNewContext(`${source.slice(start, end)}; generateStyleTrial`, {
    readStyle: async () => card,
    styleRevision: () => 'revision',
    loadStyleTrialChapter: async () => ({
      chapter: { title: '交接' }, chapters: [], scenes: [{ id: '', title: '本章首场', raw: '人物只交付一封信。' }],
    }),
    listCharacters: async () => [], listSettings: async () => [], styleSceneScores: () => [],
    assembleStylePrompt: assemble,
    readStyleModelText: async (_llm, options) => {
      requests.push(options)
      return options.messages[0].content[0].text
    },
  })
  const agent = { session: { id: 'session' }, model: { current: () => ({ provider: 'provider', model: 'model' }) } }
  const result = await trial('/book', {}, agent, { name: '测试', baseHash: 'revision', chapter: '0001', scene: '' }, new AbortController().signal)
  const baseline = result.variants.find(item => !item.styled)
  const styled = result.variants.find(item => item.styled)
  assert.ok(baseline.text.includes('人物只交付一封信。'))
  assert.ok(!baseline.text.includes('第三人称限知'))
  assert.ok(styled.text.startsWith(baseline.text))
  assert.ok(styled.text.includes('第三人称限知'))
  assert.equal(requests[0].model, requests[1].model)
  assert.equal(requests[0].system, requests[1].system)
})

test('采样保留短对白、空行和缩进，按原文行号回查', () => {
  const input = ['第一章 开场', '  “走。”', '', '不。', '第二章 离开', '她推开门。']
  const excerpts = sample(input.join('\r\n'), 5, 480)
  assert.equal(excerpts.length, 2)
  assert.equal(excerpts[0].kind, '对白')
  assert.equal(excerpts[0].startLine, 2)
  assert.equal(excerpts[0].endLine, 4)
  assert.equal(excerpts[0].text, input.slice(1, 4).join('\n'))
  assert.equal(excerpts[1].kind, '通用')
  const longLine = '她推开门'.repeat(40)
  assert.equal(sample(longLine, 5, 100)[0].text, longLine)
  assert.equal(sample('“走。”', 5, 480).length, 1)
})

test('自动卡保留统计和原文，字面禁忌保持为空', () => {
  const excerpt = sample('  她没有立刻开口。\n\n不。', 5, 480)[0]
  const content = compose({
    title: '长句样本',
    sourceLabel: '样本',
    stats: { avgSentence: 42, avgParagraph: 60, dialogueRatio: 0, per1000: {}, words: [] },
    excerpts: [excerpt],
    voice: '代词频次',
  })
  assert.match(content, /状态：待校准/u)
  assert.match(content, /平均句长 42 字/u)
  assert.match(content, /原文第 1–3 行/u)
  assert.ok(content.includes('>   她没有立刻开口。\n> \n> 不。'))
  assert.ok(!content.includes('别写成二十多字'))
  assert.ok(!content.split('## 禁忌')[1].includes('\n- '))
})

test('上传按原始字节拼接并拒绝超限请求', async () => {
  const chunks = [Buffer.from([0xc4]), Buffer.from([0xe3, 0xba, 0xc3])]
  assert.deepEqual(await readBody(Readable.from(chunks), 4), Buffer.concat(chunks))
  await assert.rejects(readBody(Readable.from(chunks), 3), { code: 'BODY_TOO_LARGE' })
})

test('通过 JSON 传送原文字节后仍可识别 GBK', async () => {
  const data = Buffer.from('c4e3bac3cac0bde7', 'hex').toString('base64')
  const body = Buffer.from(JSON.stringify({ file: { name: '样本.txt', data } }))
  const payload = await readJson(Readable.from([body.subarray(0, 17), body.subarray(17)]), 1024)
  const upload = decodeUpload(payload.file)
  assert.equal(upload.fileName, '样本.txt')
  assert.equal(upload.text, '你好世界')
  assert.equal(decodeUpload({ name: '样本.txt', data: 'c4=g' }), null)
})

test('桌面端克隆只把所选文件的路径交给宿主', async () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const start = client.indexOf('async function styleClonePayload')
  const end = client.indexOf('// ----', start)
  const file = { name: '样本.txt' }
  const makePayload = vm.runInNewContext(`${client.slice(start, end)}; styleClonePayload`, {
    __DSH_HOST_PATHS__: {
      pathFor(selected) {
        assert.equal(selected, file)
        return '/样本目录/样本.txt'
      },
    },
  })
  const payload = await makePayload(file, '')
  assert.equal(payload.source, '/样本目录/样本.txt')
  assert.equal(payload.name, '')
  assert.equal(payload.file, undefined)
})
