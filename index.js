/**
 * dsh-novel —— 小说助手 · 宿主半边（Node / Cordis 侧）
 *
 * 设计前提（已与用户敲定）：
 *   - 一个工作区 = 一本书。书稿就是工作区里的一组 Markdown 文件，插件不另建私有书库。
 *   - book.json 里的 chapters 是章节顺序的唯一真相；文件名叫什么、放在哪，都由它显式记录。
 *   - 插件只做两件事：给模型受约束的读写工具；给界面一个只读的数据出口（/novel-api）。
 *
 * 为什么工具定义是手写对象而不是 defineTool(...)：
 *   defineTool 来自 @deepseek-ai/dsh-tools，只在宿主自己的 node_modules 里。
 *   本插件用 link: 装成外部目录，解析不到那个包；而 ctx.tools.register 真正要求的只是
 *   { name, description, parameters(JSON Schema), output:{ schema, render }, execute }，
 *   所以这里直接给等价形状，零依赖、不锁版本。
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { countChars, isPlaceholderText, INTERIOR_RE, MONEY_RE, AI_TONE_PHRASES, DIALOGUE_REVIEW_RULES, DEAI_RULES, styleStats, styleFit, interiorStats, payoffMoments, detectAiTone, CJK_STOP, styleAnchorText, aiSnippet, aiSentences } from './lib/text.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cardIdentity, parseScenes, stageContext, updateHistory, historyParameters, moveScene, chapterOverview, editStageFields, hash as stageHash, PRESENTATION_RULES, presentationChecks, ROLE_FIELDS, SCENE_FIELDS, CHAPTER_FIELDS } from './stage.js'
import { BOOK_FILE, CHAPTERS_DIR, DEFAULT_CHAPTER_TARGET, clampInt, readText, readJson, writeFileAtomic, writeJson, normalizeFile, CHAPTER_STATUS, normalizeChapter, loadBook, chapterStats, persistBook, findChapter, chapterNumberOf, nextChapterId } from './lib/book.js'
import { safeCharacterName, STATE_CODES, parseStates, stateAt, appearanceIndex, appearanceReport, ROLE_RANK, parseCardRole, cardRank, parseCardHook, listCharacters, parseRelations, characterGraph, readCharacter, writeCharacter, parseCardAliases } from './lib/people.js'
import { CHARACTERS_DIR } from './lib/book.js'
import { CHARACTER_EXT } from './lib/book.js'
import { characterSummary } from './lib/people.js'
import { DEAD_WORDS, ALIVE_CLAUSE } from './lib/people.js'
import { parseCadence } from './lib/people.js'
import { parseBeatSections, parseBeatShifts, parseBeatReactions, parseBeatCognition, parseBeatInteriors, parseBeatMarks, beatHeading, matchBeatSection, parseBeatInfos, parseBeatEventRefs, readBeats, writeBeats, beatsCoverage, beatCoverage, beatRhythm, payoffBudget } from './lib/beats.js'
import { BEATS_FILE, parseSceneCadence } from './lib/book.js'
import { BEAT_MARK, BEAT_MARK_COLON, BEAT_MARK_TAIL } from './lib/beats.js'
import { OUTLINE_FILE } from './lib/book.js'
import { THREADS_FILE, EVENTS_FILE, SETTINGS_DIR, settingCategory, settingSummary, listSettings, readSetting, writeSetting, SETTING_VOID_RE, setSettingStatus, deleteSetting, parseThreads, latestWrittenId, decorateThreads, loadThreads, writeThread, validateThreadPatch, parseChapterRange, parseEventLines, readEvents, eventTimeline, writeEventLine } from './lib/library.js'
import { stampOf, stampToIso, shortHash } from './lib/book.js'

export const name = 'novel'

// tools: 注册 novel_* 工具；webServer: 给客户端挂只读数据路由。
export const inject = ['tools', 'webServer']

const API_PREFIX = '/novel-api'
const PLUGIN_REVISION = 'review-hints-v1'

const REVIEW_SOURCE_ROLES = {
  chapter: { role: 'written-content', label: '当前正文', policy: '核对叙述、对白和推断各自声称了什么；人物说法不自动成为作者事实。' },
  setting: { role: 'declared-rule', label: '声明的世界规则', policy: '作为机制约束；与正文不一致时先指出差异，不自行补造例外。' },
  character: { role: 'character-profile', label: '人物资料', policy: '约束认知、行为与声口；外貌锚点不要求一次用齐。' },
  style: { role: 'expression-constraint', label: '表达约束', policy: '约束表达方式，不改变情节和机制；与计划原句冲突时优先保留计划意图而非照抄措辞。' },
  beats: { role: 'plot-plan', label: '章纲计划', policy: '计划不是已经发生的事实，内心原句默认是素材，不要求逐字照抄。' },
  outline: { role: 'plot-plan', label: '大纲计划', policy: '表达将来的安排，不能据此把正文中的差异直接判成事实错误。' },
  events: { role: 'event-plan', label: '事件线计划', policy: '检查目标、因果与推进安排，计划区间不自动证明事件已经发生。' },
  threads: { role: 'plan-and-history', label: '伏笔计划与历史备忘', policy: '先区分条目是计划、记录还是旧备忘；可能过时，不自动作为覆盖正文的事实基准。' },
}

const MATERIAL_INPUT_RULES = '生成前先核对材料角色：正文是当前表述，设定是声明规则，人物卡是资料，文风是表达约束，章纲/大纲/事件线是计划，threads 是伏笔计划与可能过时的备忘。来源差异不自动证明谁错；作者明确裁决优先，裁决不明时指出分歧，不擅自覆盖资料。计划原句默认不要求照抄，保留意图与情绪并按文风表达。候选冲突需要模型核对，工具不自动认证兼容性。'


const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu

/**
 * 工具返回值必须能无损往返 JSON：值为 undefined 的键、NaN/Infinity、落单代理项、
 * 循环引用都会让宿主把整个结果判成非法输出（invalid output: value is not lossless JSON），
 * 调用方只能看到一个和书稿毫无关系的报错。这里在注册边界统一收口：
 * 丢掉 undefined 键、把非有限数与不可表示的值落成 null、修掉落单代理项。
 */
function toLosslessJson(value, seen = new WeakSet()) {
  if (value === undefined) return null
  if (value === null) return null
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'string') return value.replace(LONE_SURROGATE, '\uFFFD')
  if (type === 'boolean') return value
  if (type === 'bigint') return value.toString()
  if (type !== 'object') return null
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => toLosslessJson(item, seen))
  const copy = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    copy[key] = toLosslessJson(item, seen)
  }
  seen.delete(value)
  return copy
}

/** 一次调用作用域里的书根（工具/路由各自解析，互不串书）。 */
const rootContext = new AsyncLocalStorage()

/**
 * 会话的工作目录。优先问 workingDirectory 服务，其次读会话 header。
 * 「书根 = 会话 cwd」是这个插件的基本约定：换工作区就该换书。
 */
async function sessionDirectory(ctx, sessionId, exec) {
  const directories = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  const agent = exec && exec.agent ? exec.agent : undefined
  if (agent && directories && typeof directories.ensure === 'function') {
    try {
      const cwd = await directories.ensure(agent, exec ? exec.signal : undefined)
      // ensure() 对「没设过目录」的会话会回进程 cwd；header 另有其地时以 header 为准
      if (typeof cwd === 'string' && cwd !== '' && agent && agent.session) {
        const hd = agent.session.header ?? agent.session.meta
        const hc = hd && typeof hd.cwd === 'string' ? hd.cwd : ''
        if (hc !== '' && path.resolve(cwd) === path.resolve(process.cwd()) && path.resolve(hc) !== path.resolve(process.cwd())) return hc
      }
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {}
  }
  let session = agent && agent.session ? agent.session : undefined
  if (!session && sessionId && typeof ctx.get === 'function') {
    const sessions = ctx.get('sessions')
    try {
      session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    } catch {}
  }
  if (session && directories && typeof directories.get === 'function') {
    try {
      const cwd = directories.get(session)
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {}
  }
  const header = session && (session.header ?? session.meta)
  if (header && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
  return ''
}

function resolveRoot(config) {
  const configured = config && typeof config.root === 'string' ? config.root.trim() : ''
  if (configured) return path.resolve(configured)
  const fromEnv = process.env.DSH_NOVEL_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return process.cwd()
}



/** 原子写：先写同目录临时文件再 rename，正文不会被半截写完的进程留在盘上。 */


/** 章节文件相对根目录，统一成 posix 风格，避免 book.json 在 Windows 上写满反斜杠。 */



/**
 * 读出书的结构。
 * 有 book.json 就以它为准；没有就退回「扫 chapters/ 目录、按文件名排序」，
 * 这样用户直接往目录里扔 .md 也能被看见，不会因为缺元数据就一片空白。
 */


/** 章节相对进度：实际字数 / 目标字数，用来在界面上标「偏短 / 已达标」。 */
function chapterProgress(item) {
  if (!item.target) return 0
  return Math.min(1, item.chars / item.target)
}

// ---- 人物卡 --------------------------------------------------------------



/** 人物卡的「一句话」：正文里第一行非标题、非空的内容，截到 60 字。 */

// ---- 人物状态（生死/在场）时间线 --------------------------------------------

/**
 * 从人物卡的「状态」小节读出状态时间线。
 * 格式：`- @0003 去世（雾港码头失足）`＝从第 3 章起进入这个状态，直到下一条状态为止。
 * 没写这个小节 = 一直活着。只认 `@NNNN` 起点，不解析自然语言时间。
 */

/** 取「截至 limit（含）最后一个状态」；没写过状态就是活着。 */

// ---- 写入前的格式校验（只提醒，不拒绝写入）-----------------------------------
function sectionLines(text, pattern) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const collected = []
  let inside = false
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s*(.+?)\s*$/u.exec(line)
    if (heading) {
      inside = new RegExp('^(' + pattern + ')', 'u').test(heading[1].replace(/[*_`]/gu, '').trim())
      continue
    }
    if (!inside) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^[（(>｜|#]/u.test(trimmed)) continue
    if (/^\*\*.*\*\*[：:]?$/u.test(trimmed)) continue
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/u.exec(line)
    const item = (bullet ? bullet[1] : trimmed).trim()
    if (!item) continue
    collected.push(item)
  }
  return collected
}

function warnText(list) {
  const items = (list ?? []).filter(Boolean)
  if (!items.length) return ''
  return `\n\n⚠ 格式提醒（已写入，但下面这些位置读不到）：\n` + items.map(item => `- ${item}`).join('\n')
}

function validateCardContent(content) {
  const warnings = []
  const identity = cardIdentity(String(content || ''))
  if (!/^[a-zA-Z0-9_-]+$/.test(identity.id)) warnings.push('缺少有效的稳定 ID：请在卡片顶部写 - ID：character-id')
  if (!identity.role) warnings.push('缺少人物定位')
  if (identity.importance === '未设置') warnings.push('缺少重要程度：核心/重要/一般/临时')
  const body = String(content ?? '')
  if (!/^\s{0,3}#{2,6}\s+/mu.test(body)) {
    warnings.push('这张卡没有任何二级标题：关系图和生死判定只读 `## 关系` 与 `## 状态` 两节，没有就什么都读不到。')
    return warnings
  }
  if (!/^\s{0,3}#{1,6}\s*关系\s*$/mu.test(body)) warnings.push('缺 `## 关系` 小节：这个人在关系图上不会有一条边。')
  if (!/^\s{0,3}#{1,6}\s*(状态|时间线|生死|行踪)\s*$/mu.test(body)) warnings.push('缺 `## 状态` 小节：生死时间线为空（一直活着的话可以忽略这条）。')
  const relations = sectionLines(body, '关系|人物关系|人物之间的关系|关系网')
  const badRelation = relations.filter(line => !/^[^：:]{1,28}[：:]/u.test(line))
  if (badRelation.length) {
    warnings.push(
      `「关系」里 ${badRelation.length} 行不是「名字：说明」格式，读不到：${badRelation.slice(0, 3).map(item => '「' + item.slice(0, 18) + '」').join(' / ')}`,
    )
  }
  const states = sectionLines(body, '状态|时间线|状态时间线|生死|行踪')
  const badState = states.filter(line => !/^@\s*\d{3,4}\s*[：:，,]?\s*\S/u.test(line))
  if (badState.length) {
    warnings.push(
      `「状态」里 ${badState.length} 行不是「@章id 状态」格式（必须以 @ 加四位章 id 开头），读不到：${badState.slice(0, 3).map(item => '「' + item.slice(0, 18) + '」').join(' / ')}`,
    )
  }
  const coded = /^@\s*\d{3,4}\s*[：:，,]?\s*(在世|去世|已故|失踪|假死|复活|远走)/u
  const legacyState = states.filter(line => /^@\s*\d{3,4}/u.test(line) && !coded.test(line))
  if (legacyState.length) {
    warnings.push(
      `「时间线」里 ${legacyState.length} 行没写状态码（${legacyState.slice(0, 2).map(item => '「' + item.slice(0, 16) + '」').join(' / ')}）：改成「@章id 状态码｜说明」，状态码只有 在世/去世/已故/失踪/假死/复活/远走 七个。不写状态码插件只能靠关键词猜——「死账」「死对头」就会被当成死人。`,
    )
  }
  if (/@\s*\d{3,4}\s*[-~]\s*\d{3,4}/u.test(body)) warnings.push('用了 `@0003-0008` 区间写法：现在只认起始章，后面的终点会被忽略。')
  if (!/^\s*[-*+]?\s*(?:性格|表面|里子|行事|脾气|性情)\s*[：:]/mu.test(body)) {
    warnings.push('缺「- 性格：…」行（或「- 表面/里子：…」）：可以是护短热心、讲究体面、沉稳果断或爱算小账，写清遇事第一反应、习惯性小动作与底线，别只写抽象形容词。')
  }
  if (!/^\s*[-*+]?\s*(?:外貌|外貌锚点|长相|体态)\s*[：:]/mu.test(body)) {
    warnings.push('缺「- 外貌锚点：…」行：按人物出身与经历分布有度地写 1–2 个视觉特征——气质神态、标志性饰物、体态（如眼角笑纹、银色袖扣）或有来历的伤疤与职业磨损（如虎口旧疤、义体接驳痕）皆可，避免全书清一色完美脸或清一色伤疤脸，禁止堆砌五官形容词。')
  }
  if (!/^\s*[-*+]?\s*(?:说话|说话方式|口癖|腔调|台词|语态)\s*[：:]/mu.test(body)) {
    warnings.push('缺「- 说话：…」行：只写性格形容词，正文里所有人说话都会变成同一个腔调。建议写明句长/用词偏好（爽朗、温吞、利落或礼貌等）与忌讳，并附 1–2 句逐字台词例句。')
  }
  return warnings
}

function validateSettingContent(content) {
  const warnings = []
  const first = String(content ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)[0] ?? ''
  if (!/^[-*+]\s*分类\s*[：:]/u.test(first)) {
    warnings.push('首行不是 `- 分类：地点|规矩|物品|术语|组织|历史|其他`：右栏不会显示分类徽标。')
  }
  return warnings
}

async function loadTextFile(target) {
  let buffer
  try {
    buffer = await fsp.readFile(target)
  } catch (error) {
    throw new Error(`读不了 ${target}：${error?.message ?? error}`)
  }
  const bytes = buffer.length
  // 32 MB 足够覆盖一本长篇；再大也是同一个文风/同一本书，多读只是浪费内存。
  const truncated = bytes > 32 * 1024 * 1024
  if (truncated) buffer = buffer.subarray(0, 32 * 1024 * 1024)
  const { encoding, text } = detectEncoding(buffer)
  return { text, encoding, bytes, truncated }
}

async function readManuscriptFile(target) {
  return (await loadTextFile(target)).text
}

// 一条龙克隆：读原文 → 统计 → 取锚点 → 写卡 → 存原文 → 设为当前。
// 工具走这里，HTTP 路由也走这里，避免两套逻辑各长各的。
async function cloneStyle(root, options = {}) {
  const reference = options.sample || options.source
  let raw = options.text
  let label = '（直接给的文本）'
  if (reference) {
    const target = path.isAbsolute(reference) ? reference : path.join(root, reference)
    raw = await readManuscriptFile(target)
    label = `\`${path.basename(target)}\``
  }
  if (!String(raw ?? '').trim()) {
    throw new Error('克隆文风要先给一本书：novel_style({ clone: true, source: "D:\\\\books\\\\某本.txt" })')
  }
  const size = clampInt(options.size, STYLE_EXCERPT_CHARS, 100, 2000)
  const stats = styleStats(raw)
  const excerpts = sampleExcerpts(raw, STYLE_EXCERPTS, size)
  const banned = CLICHE_WORDS.filter(word => !raw.includes(word)).slice(0, 8)
  const name = String(options.name ?? '').trim() || (reference ? path.basename(reference, path.extname(reference)) : '克隆文风')
  const voice = detectVoice(raw)
  const card = composeStyleCard({
    title: name,
    sourceLabel: `${label}（${countChars(raw)} 字样本，自动克隆）`,
    stats,
    excerpts,
    banned,
    voice,
  })
  const saved = await writeStyle(root, name, card)
  const storedSample = await writeStyleSample(root, saved.name, raw)
  const activated = options.active === false ? '' : await activateStyle(root, saved.name)
  return {
    mode: 'clone',
    name: saved.name,
    file: saved.file,
    chars: saved.chars,
    stats,
    excerpts,
    sample: { file: storedSample.file, chars: storedSample.chars },
    active: activated,
    voice,
    warnings: validateStyleContent(card),
  }
}

function validateStyleContent(content) {
  const warnings = []
  const text = String(content ?? '')
  if (!/^#\s*文风卡/mu.test(text.trim())) warnings.push('开头应是「# 文风卡：名字」：少了这一行，人一眼看不出这是卡。')
  if (!/^##\s*锚点原文/mu.test(text)) warnings.push('缺「## 锚点原文」小节：没有逐字摘录，模型学不到句子，只剩形容词。')
  else {
    const anchors = text.split(/^###\s/mu).length - 1
    if (anchors < 2) warnings.push(`「锚点原文」里只有 ${anchors} 段，建议 3–5 段（每段 100–300 字）。`)
  }
  if (!/^##\s*禁忌/mu.test(text)) warnings.push('缺「## 禁忌（不要出现）」小节：novel_check 只能靠它查越界写法。')
  warnings.push(...parseStyleRestrictions(text).warnings)
  return warnings
}

function validateBeatsContent(content) {
  const warnings = []
  const body = String(content ?? '')
  if (/^\s{0,3}#{1,6}\s+\d{3,4}/mu.test(body)) warnings.push('章纲里不要再写「## 数字」这种章标题：标题由插件生成（写了也会被剥掉），正文只写场景。')
  const scenes = parseScenes(body).length || body.split(/\r?\n/u).filter(line => /^\s{0,3}[-*+]\s*场景\s*[：:]/u.test(line)).length
  if (!scenes) warnings.push('一条场景都没写（应为 3–6 条：`- 场景：谁 → 在哪 → 想干什么 → 撞上什么`）。')
  else if (scenes > 8) warnings.push(`写了 ${scenes} 场，超过 8 场：一章塞不下，考虑拆一点到下一章。（只是提醒，内容已完整保存，回合数/行数都没有上限。）`)
  return warnings
}

function validateChapterContent(content) {
  const warnings = []
  const body = String(content ?? '')
  if (!body.trim()) warnings.push('正文是空的。')
  if (/^\s{0,3}#{2,6}\s*(关系|状态|章纲|伏笔)\s*$/mu.test(body)) {
    warnings.push('正文里出现了 `## 关系`/`## 状态`/`## 章纲` 这类结构标题：那是卡片和章纲的格式，不是小说正文。')
  }
  return warnings
}

/** 人物卡的「- 定位：」决定谁是主角、谁是女主——排序、装配、描写要求都靠它。 */
/** 「- 记忆点：算珠；素色麻衣」——正文里反复认得出来的那几样东西。 */


/**
 * 从人物卡的「关系」小节读出有向边。
 * 只认 `- 名字：说明` 这种行（也容忍 `*` / `**加粗**` / 半角冒号），
 * 因为这是我在写卡时约定的格式，比自然语言解析可靠得多。
 *
 * 名字后面可以跟**起始章**标记：`- 老周 @0007：开始怀疑她` 表示这条关系从第 7 章起成立。
 * 没有标记 = 从开篇就成立。只记起点、不记终点（关系断了就把这行改写或删掉）。
 */

/**
 * 把「有向关系」摊成图数据；目标没建卡的人物留成虚线幽灵节点。
 * `upto` 给了章节 id（四位字符串）就只看「截至这一章已经成立」的关系：
 * 起始章晚于 upto 的边不画。关系只记起点、没有终点，所以不存在「已结束」这回事。
 */



// ---- 设定（settings/*.md，一个条目一个文件）--------------------------------
//
// 和人物卡同构：名字就是文件名，正文第一行非标题非空行拿来当摘要。
// 可选第一行写 `- 分类：地点 / 规矩 / 物品 / 术语`，右栏用来分组显示。







// 「作废」比删除常用来得多：设定写错了但过程有价值——留证据，不再进装配包。


// 删除不是硬删：挪进 settings/.trash/，作者后悔了还能捞回来。

// ---- 文风卡（styles/<名字>.md）--------------------------------------------
//
// 一套文风 = 一个 Markdown 文件，`book.json` 的 `style` 指向当前在用的那一套。
// 为什么不只存几个形容词：模型学不像。真正起作用的是「3–5 段原文锚点 + 明确禁忌」，
// 形容词只有在这两样都在的时候才有落点。

const STYLES_DIR = 'styles'
const STYLE_EXCERPTS = 5
const STYLE_EXCERPT_CHARS = 480

// 克隆时自动填的禁忌候选：这些词是「AI 腔」的典型症状，样本里没出现就别让它长出来。
// 这不是审美判断，是减法：作者自己没写过的腔调，续写时最容易冒出来。
const CLICHE_WORDS = [
  '氤氲', '缱绻', '仿佛', '宛如', '不由', '不禁', '心中暗道', '心头一紧', '瞬间', '顿时',
  '令人', '似乎', '微微', '轻轻', '缓缓', '深深', '渐渐', '泛起', '掠过', '弥漫着',
  '洋溢着', '充斥着', '令人窒息', '说不清道不明', '五味杂陈', '若有所思',
]

/**
 * 自动拼一张可用的文风卡：统计量写进「节奏」，高频词写进「用词」，
 * 采样原文原样摆进「锚点原文」，样本里没出现的 AI 腔词进「禁忌」。
 * 模型拿到之后可以再润色，但不需要它从零编——这是「克隆」和「分析」的区别。
 */
// 卡的开头是给人看的摘要（节奏/用词），模型真正学得会的是锚点原文 + 禁忌。
// 所以注入时不按「整张卡截前 N 字」，而是把这两节挑出来按预算切。
// 手写的文风卡真正值钱的是那几条规矩（段落多长、短句怎么用、对话怎么标、过渡词用哪些）。
// 自动克隆写不出来，但读过锚点的人会补上，所以注入时一定要带上——否则模型只看到锚点和禁忌。
/** 文风按完整条目装配；预算含空白和标题，以 Unicode 字符计。 */
function assembleStylePrompt(text, maxChars) {
  const raw = String(text ?? '').replace(/\r\n/gu, '\n').trim()
  const sections = raw.split(/^##[ \t]+/mu)
  const candidates = []
  const add = (label, body, priority) => {
    if (body.trim()) candidates.push({ id: `style-${candidates.length + 1}`, label, text: body.trim(), priority })
  }
  // 顶部元信息中，视角/叙述权限不能被当成摘要丢掉。
  const prefix = sections.shift() || ''
  for (const line of prefix.split('\n')) {
    if (/视角|时态|叙述权限|叙述距离|叙述人称/u.test(line)) add('视角与叙述权限', line, 0)
    else if (line.trim()) add('卡片说明', line, 5)
  }
  for (const section of sections) {
    const newline = section.indexOf('\n')
    const heading = (newline < 0 ? section : section.slice(0, newline)).trim()
    const body = newline < 0 ? '' : section.slice(newline + 1).trim()
    if (/^锚点原文/u.test(heading)) {
      // 有三级标题时以整段锚点为单位；旧卡无标题时按空行分组。
      const chunks = /^###[ \t]+/mu.test(body) ? body.split(/(?=^###[ \t]+)/mu) : body.split(/\n[ \t]*\n/u)
      chunks.filter(chunk => chunk.trim()).forEach((chunk, i) => add(`锚点原文 ${i + 1}`, `## ${heading}\n${chunk}`, 3))
      continue
    }
    // 保留列表条目的续行、正例与引用，不再只拿前两条。
    const chunks = body.split(/(?=^[-*+][ \t]+)/mu).filter(chunk => chunk.trim())
    chunks.forEach((chunk, i) => {
      const priority = /\[必选\]/u.test(chunk) || /核心|视角|叙述权限|格式|面板|模板|专有/u.test(heading) ? 0
        : /锚点/u.test(heading) ? 1
        : /禁忌/u.test(heading) ? 2
        : /反例|正例/u.test(heading) || /^[-*+]\s*正例/u.test(chunk) ? 4 : 3
      // 标题只随第一条出现：一节 27 条禁忌不该把标题刷 27 遍，那会把预算吃光
      add(`${heading} · ${i + 1}`, i === 0 ? `## ${heading}\n${chunk}` : chunk, priority)
    })
  }
  candidates.sort((a, b) => a.priority - b.priority)
  const included = []
  const omitted = []
  const parts = []
  const length = value => Array.from(value).length
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0))
  for (const item of candidates) {
    const next = [...parts, item.text].join('\n\n')
    const entry = { id: item.id, label: item.label, priority: item.priority, chars: length(item.text) }
    if (length(next) <= budget) {
      parts.push(item.text)
      included.push(entry)
    } else {
      omitted.push({ ...entry, reason: '文风预算不足，完整条目未截断；可增大 budget 或用 novel_style 读取完整卡片' })
    }
  }
  return { text: parts.join('\n\n'), included, omitted, budget, used: length(parts.join('\n\n')) }
}

// 视角只能靠人称代词密度的粗估：第一人称满篇「我」，第三人称满篇「他/她」。
// 不准的地方（比如内心独白里大量「我」）交给作者改一行，但比空着强。
function detectVoice(text) {
  const body = String(text ?? '')
  const first = (body.match(/[我咱]/gu) || []).length
  const third = (body.match(/[他她]/gu) || []).length
  if (!first && !third) return ''
  if (first > third * 1.5) return '偏第一人称（「我 / 咱」明显多于「他 / 她」）'
  if (third > first * 1.5) return '偏第三人称（「他 / 她」明显多于「我 / 咱」）'
  if (third >= first) return '偏第三人称（人称混用，以「他 / 她」为主）'
  return '偏第一人称（人称混用，以「我 / 咱」为主）'
}

function composeStyleCard({ title, sourceLabel, stats, excerpts, banned, voice }) {
  const lines = []
  lines.push(`# 文风卡：${title}`)
  lines.push(`- 来源：${sourceLabel}`)
  lines.push(`- 一句话：句均 ${stats.avgSentence} 字、段均 ${stats.avgParagraph} 字、对话占 ${stats.dialogueRatio}%，照着锚点的呼吸来`)
  lines.push(`- 视角与时态：${voice || '（自动克隆判断不出，读过锚点补一句「第三人称限知 / 过去时」这类结论）'}`)
  lines.push('')
  // 这一段是「骨架」，不是结论：抄自统计，但格式照着人手写的卡来 ——
  // 段落单位 / 短句怎么用 / 对话怎么标 / 过渡与断场。模型读到这一节才知道该照做什么。
  lines.push('## 一、段落：一个完整的意思')
  lines.push(`- 一段约 ${Math.max(12, Math.round(stats.avgParagraph * 0.6))}—${Math.max(20, Math.round(stats.avgParagraph * 1.6))} 字（样本均值 ${stats.avgParagraph} 字）。`)
  lines.push('- 句子内部可以有逗号、有转折、有补充说明；不要为了「短」把一句话拆成三行。')
  lines.push('')
  lines.push('## 二、短句：是重音，不是节拍')
  lines.push(`- 样本平均句长 ${stats.avgSentence} 字；比这短一半的句子只放在情绪拐点、信息落点和章末。`)
  lines.push('- 全篇短句等于没有重音：（读过锚点后补一句本书的分寸，比如「一章 8—10 处」。）')
  lines.push('')
  lines.push('## 三、对话：标签与引号的规矩')
  lines.push(`- 样本里含引号的段落占 ${stats.dialogueRatio}%，对话密度照这个走。`)
  lines.push('- （补：标签独立成段还是贴在引号后？允许哪些「笑骂道 / 低声说」？同一人连说几句怎么排？）')
  lines.push('')
  lines.push('## 四、过渡与断场')
  lines.push(`- 样本每千字省略号 ${stats.per1000.ellipsis} 处、破折号 ${stats.per1000.dash} 处；断场靠这些，不靠空行堆。`)
  lines.push('')
  lines.push('## 五、旁白的分寸')
  lines.push('- （补：能不能解释、能不能下判断、能不能吐槽；贴紧主角视角的口吻与人味怎么落。）')
  lines.push('')
  lines.push('## 节奏')
  lines.push(`- 平均句长 ${stats.avgSentence} 字（别写成二十多字的长句）`)
  lines.push(`- 平均段长 ${stats.avgParagraph} 字（一段别比这长太多）`)
  lines.push(`- 含引号的段落 ${stats.dialogueRatio}%（对话的密度跟着这个走）`)
  lines.push(`- 每千字标点：逗号 ${stats.per1000.comma} · 句号 ${stats.per1000.period} · 省略号 ${stats.per1000.ellipsis} · 破折号 ${stats.per1000.dash}`)
  lines.push('')
  lines.push('## 用词')
  lines.push(`- 高频双字词：${stats.words.slice(0, 12).map(item => item.word).join('、')}`)
  lines.push('')
  lines.push('## 锚点原文')
  excerpts.forEach((excerpt, index) => {
    lines.push('')
    lines.push(`### 锚点 ${index + 1}（取自原文 ${excerpt.at} 处）`)
    for (const row of String(excerpt.text).split(/\r?\n/u)) lines.push(row.trim() ? `> ${row.trim()}` : '>')
  })
  lines.push('')
  lines.push('## 禁忌（不要出现）')
  if (banned.length) {
    for (const word of banned) lines.push(`- ${word}`)
  } else {
    lines.push('- （AI 腔词在样本里几乎都出现过，读过锚点后自己补 2–3 条）')
  }
  return `${lines.join('\n')}\n`
}

function safeStyleName(name) {
  const text = String(name ?? '').trim()
  if (!text) throw new Error('文风名字不能为空')
  if (/[\\/:*?"<>|]/u.test(text)) throw new Error(`文风名字不能包含 \\ / : * ? " < > |：${text}`)
  return text
}

function styleSummary(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const plain = trimmed.replace(/^[-*+]\s*/u, '')
    if (/^(来源|书名|作者|一句话)[:：]/u.test(plain)) return plain.slice(0, 80)
  }
  return ''
}

async function listStyles(root) {
  let names = []
  try {
    names = await fsp.readdir(path.join(root, STYLES_DIR))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  const items = []
  for (const file of names.filter(name => /\.md$/iu.test(name) && !/\.sample\.md$/iu.test(name)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const name = path.basename(file, path.extname(file))
    const text = (await readText(path.join(root, STYLES_DIR, file))) ?? ''
    const sample = await readStyleSample(root, name)
    items.push({ name, file: `${STYLES_DIR}/${file}`, chars: countChars(text), summary: styleSummary(text), sampleChars: sample.chars })
  }
  return items
}

async function readStyle(root, name) {
  const safe = safeStyleName(name)
  return await readText(path.join(root, STYLES_DIR, `${safe}${CHARACTER_EXT}`))
}

async function writeStyle(root, name, content) {
  const safe = safeStyleName(name)
  const file = path.join(root, STYLES_DIR, `${safe}${CHARACTER_EXT}`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
  return { name: safe, file: `${STYLES_DIR}/${path.basename(file)}`, chars: countChars(content) }
}

// 参考文本：卡里只放 3–5 段锚点，原文另存一份，随时能回去比对、也能让子代理分块提炼。
// 存成 styles/<名字>.sample.md，和卡同目录，卸载插件也还在。

function styleSampleFile(name) {
  return `${safeStyleName(name)}.sample${CHARACTER_EXT}`
}

async function readStyleSample(root, name) {
  const text = await readText(path.join(root, STYLES_DIR, styleSampleFile(name)))
  return text === null ? { present: false, chars: 0, text: '' } : { present: true, chars: countChars(text), text }
}

async function writeStyleSample(root, name, text) {
  const safe = safeStyleName(name)
  const file = path.join(root, STYLES_DIR, styleSampleFile(safe))
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, 'utf8')
  return { name: safe, file: `${STYLES_DIR}/${path.basename(file)}`, chars: countChars(text) }
}

/**
 * 删掉一张文风卡。不硬删：连参考原文一起挪进 styles/.trash/，写错了还能捞回来。
 * 删的如果正是当前在用的那张，顺手把 book.json 的 style 清空（否则会指着一个不存在的卡）。
 */
async function deleteStyle(root, name) {
  const safe = safeStyleName(name)
  const dir = path.join(root, STYLES_DIR)
  const card = path.join(dir, `${safe}${CHARACTER_EXT}`)
  const sample = path.join(dir, styleSampleFile(safe))
  const existing = []
  for (const file of [card, sample]) {
    if (await fsp.access(file).then(() => true).catch(() => false)) existing.push(file)
  }
  if (existing.length === 0) {
    throw new Error(`没有这套文风「${safe}」`)
  }
  const trash = path.join(dir, '.trash')
  await fsp.mkdir(trash, { recursive: true })
  const stamp = stampOf()
  const removed = []
  for (const file of existing) {
    const target = path.join(trash, `${path.basename(file, CHARACTER_EXT)}-${stamp}${CHARACTER_EXT}`)
    await fsp.rename(file, target)
    removed.push(`${STYLES_DIR}/.trash/${path.basename(target)}`)
  }
  const wasActive = activeStyleName((await loadBook(root)).meta) === safe
  if (wasActive) await activateStyle(root, '')
  const activeAfter = activeStyleName((await loadBook(root)).meta)
  return { name: safe, removed, wasActive, active: activeAfter }
}

/** 当前在用的文风名（book.json 的 style 字段），没设就是空串。 */
function activeStyleName(meta) {
  return typeof meta?.style === 'string' ? meta.style.trim() : ''
}

async function activateStyle(root, name) {
  const safe = String(name ?? '').trim() ? safeStyleName(name) : ''
  const bookPath = path.join(root, BOOK_FILE)
  let raw = {}
  try {
    raw = JSON.parse(await fsp.readFile(bookPath, 'utf8'))
  } catch {
    raw = {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  raw.version = raw.version ?? 1
  if (safe) raw.style = safe
  else delete raw.style
  await fsp.writeFile(bookPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return safe
}

/** 认编码：BOM 优先，其次无 BOM 的 UTF-16，再按 UTF-8 试探，最后落到 GB18030（中文 txt 常见）。 */
function detectEncoding(buffer) {
  const bytes = buffer
  const length = bytes.length
  if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8-bom', text: bytes.subarray(3).toString('utf8') }
  }
  if (length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', text: new TextDecoder('utf-16le').decode(bytes.subarray(2)) }
  }
  if (length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', text: new TextDecoder('utf-16be').decode(bytes.subarray(2)) }
  }
  // 没有 BOM 的 UTF-16：正文里会有一半是 0x00
  const probe = Math.min(length, 4000)
  let zeros = 0
  for (let index = 0; index < probe; index += 1) {
    if (bytes[index] === 0x00) zeros += 1
  }
  if (probe > 0 && zeros > probe / 4) {
    try {
      return { encoding: 'utf-16', text: new TextDecoder('utf-16le').decode(bytes) }
    } catch {
      /* 落到后面的试探 */
    }
  }
  const utf8 = bytes.toString('utf8')
  const broken = (utf8.match(/\uFFFD/gu) ?? []).length
  if (broken <= Math.max(2, utf8.length / 500)) return { encoding: 'utf-8', text: utf8 }
  try {
    return { encoding: 'gb18030', text: new TextDecoder('gb18030').decode(bytes) }
  } catch {
    return { encoding: 'unknown', text: utf8 }
  }
}

/** 书稿可能是 UTF-8，也可能是到处流通的 GBK txt：先当 UTF-8 解，坏字太多再换 GB18030。 */
function decodeManuscript(buffer) {
  return detectEncoding(buffer).text
}

/** 只用统计量说清「这本书怎么说话」：句长、段长、对话占比、标点密度、高频双字词。 */

/**
 * 文风贴合度：拿文风卡自己的锚点当基准，看这一章的节奏指标偏了多少。
 * 只比可数的东西（句长、段长、对话占比、每千字标点），不做「写得好不好」的判断。
 */

/** 从文风卡里取「锚点原文」小节的正文（去掉引用符号），用来当节奏基准。 */

/** 均匀取几段原文当锚点 —— 形容词描述得再准，也不如让模型看见原句。 */
function sampleExcerpts(text, count = STYLE_EXCERPTS, chars = STYLE_EXCERPT_CHARS) {
  const paragraphs = String(text ?? '')
    .replace(/\r\n/gu, '\n')
    .split(/\n+/u)
    .map(item => item.trim())
    .filter(item => item.length >= 20 && !/^[-=*#\s]+$/u.test(item))
  if (paragraphs.length === 0) return []
  const picked = []
  const used = new Set()
  // 锚点要的是「连续一段散文」，不是「一个自然段」：这本书一段才 30 字，
  // 只取一段等于给了模型一句台词，学不到节奏。所以从起点往后累积到 chars 为止。
  const takeWindow = index => {
    const rows = []
    let total = 0
    for (let i = index; i < paragraphs.length && total < chars && rows.length < 16; i += 1) {
      rows.push(paragraphs[i])
      total += paragraphs[i].length
    }
    let text = rows.join('\n')
    if (text.length > chars + 80) text = `${text.slice(0, chars)}…`
    return text
  }
  for (let slot = 0; slot < count; slot += 1) {
    const ratio = count === 1 ? 0 : slot / (count - 1)
    let index = Math.min(paragraphs.length - 1, Math.round(ratio * (paragraphs.length - 1)))
    while (used.has(index) && index + 1 < paragraphs.length) index += 1
    used.add(index)
    picked.push({
      at: `${Math.round((index / Math.max(paragraphs.length - 1, 1)) * 100)}%`,
      text: takeWindow(index),
    })
  }
  return picked
}

/** 只选择本章标题匹配或未标章号的备忘，不把它们提升为事实。 */
function materialMemoSections(text, chapter) {
  const sections = []
  let current
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (/^#{1,2}\s/u.test(line)) {
      current = { heading: line.replace(/^#+\s*/u, ''), lines: [] }
      sections.push(current)
    } else if (current) current.lines.push(line)
  }
  const chapterNumber = Number(chapter.id) || chapterNumberOf(chapter.title)
  return {
    index: sections.map(item => item.heading),
    selected: sections.filter(item => {
      const number = chapterNumberOf(item.heading)
      return item.heading.split(/\s/u)[0] === chapter.id || chapterNumber > 0 && number === chapterNumber
        || number === 0 && /备忘|硬账|历史|纪要|笔记/u.test(item.heading)
    }).map(item => ({ heading: item.heading, text: item.lines.join('\n').trim(), role: REVIEW_SOURCE_ROLES.threads.role })),
  }
}

/** 复用现有字面规则生成候选，不推断语义冲突或材料权威。 */
async function materialPreflight(root, chapter, known = {}) {
  const beatsText = known.beatsText ?? (await readBeats(root, chapter)).section?.body ?? ''
  const styleName = known.styleName ?? activeStyleName((await loadBook(root)).meta)
  const styleText = known.styleText ?? (styleName ? (await readStyle(root, styleName)) ?? '' : '')
  const memoText = (await readText(path.join(root, THREADS_FILE))) ?? ''
  const restrictions = parseStyleRestrictions(styleText)
  const missingSources = styleName && !styleText.trim() ? [{ source: 'style', name: styleName, detail: '启用文风卡缺失或为空，无法核对表达约束；请先读取或补齐资料，不把缺资料当成无冲突。' }] : []
  const literalCandidates = [
    ...styleRestrictionMatches(beatsText, restrictions.banned).map(detail => ({ classification: 'candidate', source: 'beats', ruleSource: 'style', ruleName: styleName, kind: 'banned-in-plan', detail })),
    ...styleRestrictionMatches(beatsText, restrictions.limited).map(detail => ({ classification: 'candidate', source: 'beats', ruleSource: 'style', ruleName: styleName, kind: 'limited-in-plan', detail })),
  ]
  const memo = materialMemoSections(memoText, chapter)
  return {
    chapter: { id: chapter.id, title: chapter.title },
    status: missingSources.length || literalCandidates.length || restrictions.semantic.length && beatsText.trim() || memo.selected.length ? 'needs-model-review' : 'no-automatic-candidates',
    certifiesConsistency: false,
    policy: MATERIAL_INPUT_RULES,
    sourceRoles: REVIEW_SOURCE_ROLES,
    literalCandidates,
    missingSources,
    semanticComparison: { rules: restrictions.semantic, plan: beatsText, planSource: 'beats', ruleSource: 'style', ruleName: styleName },
    memo: { present: Boolean(memoText.trim()), ...memo },
    sourceVersions: [
      { source: 'beats', hash: createHash('sha256').update(beatsText).digest('hex') },
      { source: 'style', name: styleName, hash: createHash('sha256').update(styleText).digest('hex') },
      { source: 'threads', hash: createHash('sha256').update(memoText).digest('hex') },
    ],
  }
}

function renderMaterialPreflight(value, compact = false) {
  const lines = ['【资料预检：候选待核对，不是兼容性认证】', value.policy]
  for (const item of value.missingSources ?? []) lines.push(`- [资料缺失/${item.source}:${item.name}] ${item.detail}`)
  for (const item of value.literalCandidates) lines.push(`- [字面候选/${item.kind}] ${item.detail}；对应文风卡：${item.ruleName}。先检查是否为反例或转述，不自动判错。`)
  if (value.semanticComparison.rules.length && value.semanticComparison.plan) {
    lines.push('章纲与以下语义约束需逐项对照；确定如何保留剧情、调整表达后再生成：', ...value.semanticComparison.rules.map(rule => `- ${rule}`))
    if (!compact) lines.push('待对照的章纲计划原文：', value.semanticComparison.plan)
  }
  for (const item of value.memo.selected) lines.push(`历史/计划候选 [threads：${item.heading}]，不是自动事实基准：`, item.text)
  if (value.memo.present) lines.push('threads 小节索引：' + value.memo.index.join('；') + '。未展示的部分按需读取，不能声称已核对全文。')
  if (!value.literalCandidates.length) lines.push('未发现字面候选不代表不存在语义冲突。')
  return lines.join('\n')
}

/** 按最终提示文本计预算；Unicode 字符含空白，不等同于 token。 */
function assembleNovelContext(value, budget) {
  const size = text => Array.from(text).length
  const rewrite = value.mode === 'rewrite'
  const scope = value.rewriteScope
  const voiceRule = '人物的临场反应与对话应贴合各自人物卡的性格、认知与说话习惯，避免千人一面。外貌锚点按现场需要自然呈现，不要求初登场一次用齐。'
  const instructions = rewrite
    ? scope.partial
      ? `局部改写：只修改给出的范围。先核对事实、人物动作、信息点，再调整文风与各角色声口。用 novel_write({chapter:"${value.chapter.id}",mode:"patch",baseHash:"${scope.baseHash}",start:${scope.start},end:${scope.end},content:"修改后的片段"}) 保存，其余正文由插件保留。${voiceRule}`
      : `整章改写：先逐项核对事实、人物动作和信息点全部保留，再检查文风与各角色声口。优先局部修订；整章覆盖使用 novel_write 的 mode:"replace"，并传 baseHash:"${scope.baseHash}"。${voiceRule}`
    : `按章纲和文风写作；省略的资料不代表没有约束，必要时调用对应工具读取。${voiceRule} 场景和关键动作链应完整呈现；参考字数不限制正文长度，不因接近或超过目标而缩写、省略过程或提前收尾。是否分章按情节自然节点决定；确需顺延尚未开始的后续场景时，结构化章纲使用 novel_move_scene 整场移动，旧版逐行章纲可用 novel_write({ ..., carryOver: true })；不能把当前动作的前提与结果拆散。`
  const head = `【${rewrite ? '改写' : '续写'}装配包】${value.chapter.id} ${value.chapter.title}\n参考篇幅 ${value.chapter.target} 字（允许超出，不因超出删减）。上下文预算 ${budget} Unicode 字符（仅限制本次装配包，含标题、空白和指令，不是 token，也不是正文字数上限）。\n${instructions}`
  const blocks = []
  const add = (id, label, body, required = false) => {
    if (body) blocks.push({ id, label, text: `## ${label}\n${body}`, required })
  }
  if (value.materialPreflight) add('materialPreflight', '生成前资料预检（先核对再写）', renderMaterialPreflight(value.materialPreflight, true), true)
  if (rewrite) add('chapterText', scope.partial ? `本章片段 [${scope.start}, ${scope.end})，全章 ${scope.total} 字符` : '完整本章原文', value.chapterText, true)
  if ((value.chapter.id === '0001' || !value.prevTail.text) && !(rewrite && scope.partial)) {
    add(
      'openingRules',
      '第一章开篇纪律（黄金三百字）',
      '1. 前 300 字必须见冲突、异常或反常识奇观：禁止从日常慢热或大段背景科普开局，直接把主角放进正在发生的危机、交易或异常现场，用动作带出核心卖点或金手指。\n' +
        '2. 爽感或筹码必须落袋：即使主角表面吃亏或受压，章末前也必须拿到实打实的回报（信息优势、暗中占到的便宜、新能力或关键筹码），避免整章纯憋屈。\n' +
        '3. 章末留强钩子：把眼前悬念与主线/金手指咬合在一起，给出明确的翻页理由。',
      true,
    )
  }
  add('beats', '本章剧情计划（不是既成事实，原句不要求照抄）', value.beats.text, true)
  add('stage', '场景人物认知与计划边界', value.stage?.text || '', true)
  const interiorLines = value.beats && Array.isArray(value.beats.interiors) ? value.beats.interiors : []
  if (interiorLines.length) add('interiors', '可选心理材料（遵守视角，不按数量填充）', interiorLines.map(item => item.text).join('\n') + '\n可用联想、短回忆或间接叙述；仅作者参考不得直接写入内心。只有明确指定的保留心声原句才需逐字保留。', true)
  const cognitionRows = value.beats && Array.isArray(value.beats.cognition) ? value.beats.cognition : []
  if (cognitionRows.length) {
    add(
      'cognition',
      '本章认知起点（他此刻还不知道什么）',
      cognitionRows.map(item => '- ' + item.text).join('\n') +
        '\n\n写的时候守住这条边界：他知道的照常写，不知道的别让角色装懂——不知道该愣就问、该误判就误判，别一开口就像本地老手。',
      true,
    )
  }
  add('rewriteRules', '写作与审稿纪律', value.rewriteRules, true)
  add('style', `文风：${value.style.name}`, value.style.text, true)
  if (value.rhythm && value.rhythm.present) add('rhythm', '章纲节奏', `爽点：${value.rhythm.payoff.join('、') || '无'}；钩子：${value.rhythm.hook ? '有' : '无'}；转折：${value.rhythm.turn}`)
  value.characters.forEach((item, i) => add(`character-${i}`, `人物：${item.name}`, item.content))
  value.settings.forEach((item, i) => add(`setting-${i}`, `设定：${item.name}`, item.content))
  value.spine.forEach((item, i) => add(`event-${i}`, `事件：${item.id} ${item.title}`, `因为：${item.because}\n所以：${item.so}`))
  add('prevTail', '上一章结尾（节选）', value.prevTail.text)
  add('outline', '大纲参考（节选）', value.outline)
  value.threads.forEach((item, i) => add(`thread-${i}`, '伏笔', `${item.thread}（埋于 ${item.planted}，回收 ${item.payoff}）`))
  value.aiTone.forEach((item, i) => add(`tone-${i}`, `AI 腔线索：${item.label}`, (item.samples || []).join('\n')))
  value.warnings.forEach((item, i) => add(`warning-${i}`, '写作提醒', item))
  const included = []
  const omitted = []
  const parts = [head]
  // 为省略提示预留固定空间，报告明细作为元数据返回，不把原文再次塞回输出。
  const footer = '\n\n装配清单：' + blocks.map(item => item.id + '=' + item.label).join('；') + '\n未展示的条目因总预算不足而省略；用 novel_read、novel_style、novel_card、novel_setting 等补读。' + (value.style.omitted.length ? '\n文风省略：' + value.style.omitted.map(item => item.label).join('；') + '（文风额度不足，规则仍有效；用 novel_style 读全卡）' : '')
  const required = blocks.filter(item => item.required)
  const minimum = size([head, ...required.map(item => item.text)].join('\n\n') + footer)
  if (minimum > budget) {
    const prompt = `上下文预算不足：必要内容需 ${minimum} 字符，当前 ${budget}。未提供残缺正文，不可据此覆盖整章。增大 budget（最多 40000）；长章请用 novel_context({chapter:"${value.chapter.id}",mode:"rewrite",rewriteStart:0,rewriteLimit:1000,budget:6000}) 分段改写。若片段仍放不下，缩小 rewriteLimit 或增大 budget。`
    const guidance = !rewrite && value.stage?.scenes?.length ? `上下文预算不足：必要内容需 ${minimum} 字符，当前 ${budget}。请增加 budget（默认 12000，最多 40000），或用 novel_context({chapter:"${value.chapter.id}",scene:"${value.stage.scenes[0].id}",budget:20000}) 按场景装配（最多 40000）；不得忽略人物认知边界。` : prompt
    return { ...value, chapterText: '', prompt: guidance, budget, budgetUsed: size(guidance), ready: false, minimumBudget: minimum, included: [], omitted: blocks.map(({ id, label }) => ({ id, label, reason: '必要内容超出预算，本次未装配' })) }
  }
  for (const block of [...required, ...blocks.filter(item => !item.required)]) {
    if (size([...parts, block.text].join('\n\n') + footer) <= budget) {
      parts.push(block.text)
      included.push({ id: block.id, label: block.label })
    } else omitted.push({ id: block.id, label: block.label, reason: '总预算不足，完整条目省略' })
  }
  const prompt = parts.join('\n\n') + footer
  return { ...value, prompt, budget, budgetUsed: size(prompt), budgetUnit: 'unicode-code-points', ready: true, included, omitted }
}

function rewriteSelection(text, start, limit) {
  const chars = Array.from(text)
  const partial = start !== undefined
  const from = partial ? Number(start) : 0
  if (!Number.isInteger(from) || from < 0 || from >= chars.length && chars.length > 0) throw new Error('rewriteStart 超出正文范围')
  const length = limit === undefined ? 1000 : Number(limit)
  if (!Number.isInteger(length) || length < 1) throw new Error('rewriteLimit 必须是正整数')
  const end = partial ? Math.min(chars.length, from + length) : chars.length
  return { text: chars.slice(from, end).join(''), scope: { partial, start: from, end, total: chars.length, nextStart: end < chars.length ? end : null, baseHash: createHash('sha256').update(text).digest('hex') } }
}

function applyChapterEdit(previous, args) {
  const hash = createHash('sha256').update(previous).digest('hex')
  if (args.baseHash !== undefined && args.baseHash !== hash) throw new Error('正文已变化，请重新获取上下文后再保存；未写入')
  if (args.mode !== 'patch') return args.mode === 'append' && previous ? `${previous.replace(/\s+$/u, '')}\n\n${args.content}` : args.content
  if (!args.baseHash) throw new Error('局部改写必须提供上下文返回的 baseHash')
  const chars = Array.from(previous)
  const patches = args.patches ?? [{ start: args.start, end: args.end, content: args.content }]
  if (!Array.isArray(patches) || !patches.length || patches.some(patch => !patch || typeof patch !== 'object')) throw new Error('局部改写至少需要一个有效片段；未写入')
  const sorted = [...patches].sort((a, b) => a.start - b.start)
  let cursor = 0
  const parts = []
  for (const patch of sorted) {
    if (!patch || !Number.isInteger(patch.start) || !Number.isInteger(patch.end) || patch.start < cursor || patch.end <= patch.start || patch.end > chars.length || typeof patch.content !== 'string') throw new Error('局部改写范围无效或片段重叠；未写入')
    parts.push(chars.slice(cursor, patch.start).join(''), patch.content)
    cursor = patch.end
  }
  parts.push(chars.slice(cursor).join(''))
  return parts.join('')
}

/** 禁忌分为字面禁止、少用提醒与待语义复核；不猜测语义规则是否违反。 */
function parseStyleRestrictions(text) {
  const result = { banned: [], limited: [], semantic: [], warnings: [] }
  let group = null
  let active = null
  const category = heading => /^语义禁忌/u.test(heading) ? 'semantic'
    : /^少用词/u.test(heading) ? 'limited' : /^(禁忌|禁用词|禁用句)/u.test(heading) ? 'banned' : null
  for (const [index, line] of String(text ?? '').split(/\r?\n/u).entries()) {
    const heading = line.trim().match(/^(#{2,6})\s+(.+)$/u)
    if (heading) {
      if (heading[1].length === 2) group = category(heading[2])
      active = category(heading[2]) || group
      continue
    }
    if (!active || !line.trim() || /^\s*>/u.test(line)) continue
    let plain = line.trim().replace(/^[-*+]\s*/u, '').trim()
    let kind = active
    const prefix = plain.match(/^(词|禁用词|少用词|语义禁忌|整句(?:（[^）]*）)?|禁用句)\s*[：:]\s*/u)
    if (prefix) {
      if (prefix[1] === '少用词') kind = 'limited'
      if (prefix[1] === '语义禁忌') kind = 'semantic'
      plain = plain.slice(prefix[0].length)
    }
    if (!plain || /^[（(].*[）)]$/u.test(plain)) continue
    if (!prefix && kind !== 'semantic' && /^(不要|不得|避免|禁止|不能|不许)/u.test(plain)) {
      kind = 'semantic'
      result.warnings.push(`第 ${index + 1} 行是自然语言要求，已列入语义待复核；如需字面匹配请写「禁用词：…」或「整句：…」。`)
    }
    // 整句仅兼容旧模板的带空格斜杠分隔，不拆句内顿号、逗号或斜杠。
    const sentence = prefix ? /整句|禁用句/u.test(prefix[1]) : /[。！？!?]/u.test(plain)
    const values = kind === 'semantic' ? [plain] : sentence ? plain.split(/\s+\/\s+/u) : plain.split(/\s*[/、]\s*/u)
    if (values.length > 1) result.warnings.push(`第 ${index + 1} 行已兼容拆分为 ${values.length} 项；建议一行一项。`)
    for (let value of values) {
      value = value.trim()
      const pairs = { '「': '」', '『': '』', '“': '”', '"': '"' }
      if (pairs[value[0]] === value.at(-1)) value = value.slice(1, -1).trim()
      if (value && !result[kind].includes(value)) result[kind].push(value)
    }
  }
  return result
}

function styleRestrictionMatches(text, words) {
  const hits = []
  const lines = String(text ?? '').split(/\r?\n/u)
  lines.forEach((line, index) => {
    for (const word of words) {
      let offset = 0
      while ((offset = line.indexOf(word, offset)) >= 0) {
        const column = Array.from(line.slice(0, offset)).length + 1
        hits.push(`第 ${index + 1} 行第 ${column} 列「${word}」：${line.slice(Math.max(0, offset - 20), offset + word.length + 20)}`)
        offset += word.length
      }
    }
  })
  return hits
}

// ---- 伏笔表（threads.md，人工维护的 Markdown 表格）--------------------------
//
//   | 伏笔 | 埋设 | 回收 | 状态 |
//   | --- | --- | --- | --- |
//   | 账册上的死期 | 0002 | | open |
//   | 老周的左手 | 0002 | 0002 | closed |
//
// 列顺序固定；「回收」列是**计划**回收章，所以状态留空 = open（还没收）。
// 只有显式写 done / closed 才算收掉；否则「到期未收」永远判不出来。


/** 已写到的最后一章 id（用来判断「该收了但还没收」）。 */

/** 给伏笔行补 due 标记：计划回收章已经到了（或过了）却还没收。 */


/**
 * 写入或更新伏笔表的一行，其余行一个字不动。
 * 匹配键是第一条单元格（伏笔描述）；未提供字段保留原值。
 */


// ---- 上下文装配 -----------------------------------------------------------

/** 取文末 N 字，尽量从段落边界开始，避免把一句话切成两半；开头的标题行会被丢掉。 */
function tail(text, maxChars) {
  const plain = String(text ?? '').trim()
  if (!plain) return ''
  const chars = Array.from(plain)
  const cut = chars.length <= maxChars ? plain : chars.slice(chars.length - maxChars).join('')
  const atBreak = cut === plain ? cut : cut.slice(cut.indexOf('\n') + 1 || 0)
  return atBreak.replace(/^(#{1,6}\s.*\r?\n)+/u, '').trim()
}

/** 从大纲里取与本章相关的一段：优先找「第 N 章」「0003」这样的标题行，找不到就给前 N 字。 */
function outlineExcerpt(outline, chapter, maxChars) {
  const text = String(outline ?? '')
  if (!text) return ''
  const lines = text.split(/\r?\n/u)
  const index = lines.findIndex(line => {
    if (!/^#{1,6}\s|^\s*[-*+]\s/u.test(line)) return false
    return line.includes(chapter.title) || line.includes(chapter.id) || line.includes(`第 ${Number(chapter.id)} 章`) || line.includes(`第${Number(chapter.id)}章`)
  })
  if (index >= 0) {
    const start = lines[index].replace(/^#{1,6}\s*/u, '').startsWith('#') ? index + 1 : index
    const section = [lines[index]]
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,6}\s/u.test(lines[i])) break
      section.push(lines[i])
    }
    return Array.from(section.join('\n').trim()).slice(0, maxChars).join('')
  }
  return Array.from(text.trim()).slice(0, maxChars).join('')
}

function mentions(text, name) {
  if (!text || !name) return false
  return text.includes(name)
}

/** 把 outline.md 按 `## ` 切成小节，供右栏「小说大纲」逐节显示。 */
function splitOutline(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  if (!source.trim()) return []
  const sections = []
  let current = { title: '', body: [] }
  for (const line of source.split('\n')) {
    if (/^#{1,2}\s/u.test(line)) {
      if (current.title || current.body.join('').trim()) sections.push(current)
      current = { title: line.replace(/^#{1,2}\s*/u, '').trim(), body: [] }
      continue
    }
    current.body.push(line)
  }
  if (current.title || current.body.join('').trim()) sections.push(current)
  return sections
    .map(section => {
      const body = section.body.join('\n').trim()
      return { title: section.title, body, chars: countChars(body) }
    })
    .filter(section => section.title || section.body)
}

/* ── 章纲（beats.md） ──────────────────────────────────────────────
 * 大纲管整本书怎么走，章纲管这一章拍哪几个场景。一个文件、每章一节，
 * 二级标题写成 `## <章 id> <标题>`，正文就是这一章的 beat 列表。
 * 单独成文件而不是塞进 book.json，是为了让人和 AI 都能直接读写、diff 好看。
 */

/* ── 内心反应（人物不能只是执行动作） ──────────────────────────────
 * 判据不是「有多少个形容词」，而是「得手/失手之后有没有一个身体或念头反应」。
 * 一处都不用：他心里、手心、喉咙、胸口、后悔、发狠、愣、咬牙……
 * 这些词机器认得，写得好不好机器不判。
 */


/** 章纲里的「- 位移：从「…」到「…」」——这一场结束时他心里变了什么。 */

/**
 * 章纲里的「- 心里：想起他爸递二十块那一下」——这一场他要想到什么、感觉到什么。
 *
 * 为什么要把它写进章纲、而不写进文风卡的规矩里：
 * 规矩是「怎么写」（句式、节奏），章纲是「写什么」；内心材料属于后者。
 * 只在文风卡里写「要加心理」，模型会在一模一样的位置加一模一样的句子——
 * 那才是工业产物。写进章纲，每章的念头就不一样了。
 */

const INTERIOR_MOODS = ['暗爽', '得意', '憋屈', '火', '慌', '心凉', '发狠', '松口气', '不耐', '恶心', '钝痛', '疑惑', '心疼', '讽刺']

/**
 * 「- 心里：情绪｜台词」：作为可选材料读取；不强制情绪或台词格式。
 */
/**
 * 「- 认知：…」：这一章他此刻**不知道**什么。比人物卡更有效——人物卡说身份，认知说边界。
 */


/**
 * 找「标了 → 爽点 / 转折 却没有反应」的场：
 * 按章纲那一行切段，去正文里找最像的段落，再看那一带有没有身体/念头。
 */

/**
 * 「钱一动，人就该有反应」：找出这一章所有提到钱/得手的段落，看它们身上或紧跟着有没有身体、念头。
 * 不拿章纲去对位——章纲是抽象骨架，对位容易错位；这条检查只看正文里最确定的东西。
 */

/* ── 节奏标记（爽点 / 钩子 / 转折） ────────────────────────────────
 * 爽点不单独建表：它是「这一场戏怎么演」的属性，写在场记后面最不容易丢。
 * 两种写法都认：`→ 爽点（信息压制）`（推荐，类型写在括号里）
 * 和既有的 `钩子：陈默说……`（标记+冒号，冒号后当备注）。
 * 宿主只解析、不存第二份；全局台账由 beatRhythm() 现算。
 */



/** 先按章节 id 匹配，再退回标题包含（人可能顺手把「## 第三章 空铺」写成不带 id 的样子）。 */

/** 「信息行」：这一章必须让读者新知道的事实。它不是场景（没地点、没对手、没有变化），
 *  所以单独记、单独查：章纲里可以写，但正文里没给出来就要报。
 */

/* ── 事件线（events.md） ────────────────────────────────────────────
 * 一章可以同时推进多条线，一条线跨很多章 —— 多对多，所以它和 threads.md
 * 一样配得上一份独立资产。定义写在 events.md，章纲里只留锚点
 * （「- 事件：主线-1、感情-2」），时间线由 eventTimeline() 现算，不落第二份。
 */




/** 时间线：事件 → 覆盖哪些章；章 → 推了哪几条线。区间给默认，锚点做修正。 */

/** 整段替换一条线（和 writeBeats 同语义：别的线一个字都不动）。 */

/** 只替换这一章那一节，别的章一个字都不动；没有这一节就追加到文件末尾。 */

/** 给状态条 / 右栏用：哪些章有章纲、几行。 */

/**
 * 章纲到底落实了没有：逐条 beat 拿它和正文求「最长公共片段」，太短就算这场景可能没写。
 * 只是提醒，不改文件——真正判断要靠人；但没有这个提醒，模型很容易只写了第一条 beat 就收笔。
 */

/**
 * 节奏台账：爽点／钩子／转折的分布。**不存盘**——真相只在 beats.md 那几行字里，
 * 这里每次现算，所以永远不会和章纲打架。
 */

/** 计划层的「预算」：outline.md 的 `## 爽点节奏` 里写 `打脸×3` 这种，×N 求和。 */

/** 写回 book.json：章节表是唯一真相，所以任何写操作都要顺手维护它；未知字段原样保留。 */
async function scaffoldAgents(root) {
  const target = path.join(root, 'AGENTS.md')
  const templateFile = new URL('./templates/AGENTS.md', import.meta.url)
  let body = ''
  try {
    body = await fsp.readFile(templateFile, 'utf8')
  } catch {
    body =
      '# 这本书怎么写（给 AI 的规范）\n\n' +
      '- 结构：book.json（章节顺序的唯一真相）+ chapters/编号.md + outline.md + beats.md（章纲）+ characters/*.md + settings/*.md + threads.md（伏笔）+ styles/*.md（文风卡）\n' +
      '- 章纲每章一节 `## 0003 第三章 标题`，3–6 条 `- 场景：谁 → 在哪 → 想干什么 → 撞上什么`，末尾写 `→ 爽点（类型）` / `→ 钩子`。\n' +
      '- 只在脑子里发生的事写 `- 信息：…`（不是场景）；前世／世界事实落 settings/。\n' +
      '- 写正文前先 novel_context({ chapter }) 拿装配包；写完 novel_check({ chapter }) 自查。\n' +
      '- 不要用 write/edit 直接改 chapters/ 里的文件——那边没有历史快照；用 novel_write。\n'
  }
  const previous = await readText(target)
  const startMarker = '<!-- novel-deai:start -->'
  const endMarker = '<!-- novel-deai:end -->'
  const block = `${startMarker}\n## 交付前语义复核（本节替代旧版去味流程）\n\n${DEAI_WORKFLOW}\n${endMarker}`
  const source = previous ?? body
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start >= 0 && end < start || start < 0 && end >= 0) throw new Error('AGENTS.md 的去味流程标记不完整，请先修复标记；未写入')
  const next = start >= 0
    ? source.slice(0, start) + block + source.slice(end + endMarker.length)
    : `${source}${source.endsWith('\n') ? '\n' : '\n\n'}${block}\n`
  if (next !== previous) await writeFileAtomic(target, next)
  return { path: target, created: previous === null, updated: previous !== null && next !== previous, bytes: Buffer.byteLength(next) }
}


// ---- 历史版本 ------------------------------------------------------------
//
// 一章的旧稿按「快照」留着：chapters/.history/<章id>-<stamp>.md，旁边一份同名 .json
// 记元数据（怎么改的、多少字、用的哪套文风）。永久保留、不做自动删除——作者删掉的
// 段落是最容易后悔的东西，磁盘比后悔便宜。
const HISTORY_DIR = '.history'

/** 紧凑 ISO 时间戳（YYYYMMDDHHmmss，UTC），也就是历史文件名的后缀。 */

/** 由 stamp 反解 ISO；没有 json 元数据的老文件靠它推时间。 */

/** 内容指纹：用来跳过「什么都没改」的重复快照。 */

function historyDir(root) {
  return path.join(root, CHAPTERS_DIR, HISTORY_DIR)
}

function historyPath(root, chapterId, version) {
  return path.join(historyDir(root), `${chapterId}-${version}.md`)
}

/** 哪一章有哪些版本，最新的在前。没有 .json 的老文件也算进来（source: legacy）。 */
async function listHistory(root, chapterId) {
  const dir = historyDir(root)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch (error) {
    return []
  }
  const safeId = String(chapterId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`^${safeId}-(\\d{14}(?:-\\d+)?)\\.md$`, 'u')
  const out = []
  for (const name of names) {
    const hit = pattern.exec(name)
    if (!hit) continue
    const version = hit[1]
    const content = (await readText(historyPath(root, chapterId, version))) ?? ''
    let meta = null
    try {
      meta = JSON.parse((await readText(path.join(dir, `${chapterId}-${version}.json`))) ?? 'null')
    } catch (error) {
      meta = null
    }
    out.push({
      version,
      file: `${CHAPTERS_DIR}/${HISTORY_DIR}/${chapterId}-${version}.md`,
      chars: meta && Number.isInteger(meta.chars) ? meta.chars : countChars(content),
      hash: meta && typeof meta.hash === 'string' ? meta.hash : shortHash(content),
      source: meta && typeof meta.source === 'string' ? meta.source : 'legacy',
      note: meta && typeof meta.note === 'string' ? meta.note : '',
      style: meta && typeof meta.style === 'string' ? meta.style : '',
      createdAt: meta && typeof meta.createdAt === 'string' ? meta.createdAt : stampToIso(version),
    })
  }
  out.sort((a, b) => (a.version < b.version ? 1 : -1))
  return out
}

/** 读某一版全文。 */
async function readVersion(root, chapterId, version) {
  const content = await readText(historyPath(root, chapterId, version))
  if (content == null) return null
  const listed = await listHistory(root, chapterId)
  const meta = listed.find(item => item.version === version) ?? null
  return { version, chars: countChars(content), content, file: meta ? meta.file : '', meta }
}

/**
 * 把一份旧稿存成一版。内容跟最新一版一致就不存（避免「保存两次什么都没改」刷时间线）。
 * 同一秒写两次时版本号追加 -2、-3。
 */
async function snapshotChapter(root, options) {
  const text = String(options.text ?? '')
  if (!text.trim()) return null
  const hash = shortHash(text)
  const existing = await listHistory(root, options.chapter.id)
  if (existing.length && existing[0].hash === hash) return null

  const base = stampOf()
  let version = base
  let n = 1
  while ((await readText(historyPath(root, options.chapter.id, version))) != null) {
    version = `${base}-${++n}`
  }

  const dir = historyDir(root)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${options.chapter.id}-${version}.md`), text, 'utf8')
  const meta = {
    version,
    chapter: options.chapter.id,
    title: options.chapter.title,
    chars: countChars(text),
    hash,
    source: options.source ?? 'write:replace',
    note: options.note ?? '',
    style: options.style ?? '',
    createdAt: new Date().toISOString(),
  }
  await fsp.writeFile(path.join(dir, `${options.chapter.id}-${version}.json`), JSON.stringify(meta, null, 2), 'utf8')
  return {
    version,
    file: `${CHAPTERS_DIR}/${HISTORY_DIR}/${options.chapter.id}-${version}.md`,
    chars: meta.chars,
    createdAt: meta.createdAt,
  }
}

/** 每一章留一份「上次见到时」的正文，用来发现绕过工具的外部改动。 */
function lastSnapshotPath(root, chapterId) {
  return path.join(historyDir(root), `${chapterId}.last.md`)
}

/**
 * 漂移看门狗：正文被工具之外的写入改过（对话里直接用 write/pwsh 改文件），
 * 就在下一次读状态时把「上一份已知内容」补成一版 source: external。
 * 历史不依赖模型记不记得用工具：工具内部靠快照，工具外部靠这里补。
 */
let reconciledAt = 0
async function reconcileHistory(root, options = {}) {
  const now = Date.now()
  if (options.throttle === true && now - reconciledAt < 8000) return []
  reconciledAt = now
  const { meta } = await loadBook(root)
  const found = []
  for (const chapter of meta.chapters) {
    if (!chapter || !chapter.id || !chapter.file) continue
    const current = await readText(path.join(root, chapter.file))
    if (current == null) continue
    const tracker = lastSnapshotPath(root, chapter.id)
    const last = await readText(tracker)
    if (last == null) {
      await writeFileAtomic(tracker, current)
      continue
    }
    if (last === current) continue
    const kept = await snapshotChapter(root, {
      chapter,
      text: last,
      source: 'external',
      note: '这版是被工具之外的写入覆盖掉的（对话里直接改文件就会发生这种事）',
      style: activeStyleName(meta),
    })
    await writeFileAtomic(tracker, current)
    if (kept) found.push(kept)
  }
  return found
}

/** 恢复到某一版：先把当前内容也留一版，所以「恢复」本身也能撤销。 */
async function restoreVersion(root, chapterId, version) {
  const { meta } = await loadBook(root)
  const chapter = findChapter(meta.chapters, chapterId)
  if (!chapter) throw new Error(`没有这一章「${chapterId}」`)
  const target = await readVersion(root, chapter.id, version)
  if (!target) throw new Error(`没有这一版「${version}」`)

  const currentFile = path.join(root, chapter.file)
  const current = (await readText(currentFile)) ?? ''
  const snapshot = current.trim()
    ? await snapshotChapter(root, {
        chapter,
        text: current,
        source: 'restore',
        note: `恢复前留存（要恢复到 ${version}）`,
        style: activeStyleName(meta),
      })
    : null

  await writeFileAtomic(currentFile, target.content)
  await writeFileAtomic(lastSnapshotPath(root, chapter.id), target.content)
  const chars = countChars(target.content)
  if (chars > 0) chapter.status = 'draft'
  await persistBook(root, { ...meta, chapters: meta.chapters }, meta.chapters)
  return { version, chars, snapshot }
}

/** 全书巡检：把逐章检查横向扫一遍，只报「能算出来的事实」，不给评语。 */
async function auditBook(root) {
  const { meta } = await loadBook(root)
  const target = meta.targetChars
  const styleNameAudit = activeStyleName(meta)
  const styleRawAudit = styleNameAudit ? await readStyle(root, styleNameAudit) : null
  const rows = []
  for (const chapter of meta.chapters) rows.push(await chapterStats(root, chapter, target))
  const cards = await listCharacters(root)
  const beatBoard = await readBeats(root, null)
  const sections = Array.isArray(beatBoard.sections) ? beatBoard.sections : []
  const threadBoard = await loadThreads(root)
  const latest = latestWrittenId(rows.filter(row => row.written))
  const issues = []
  const add = (level, kind, detail, chapterId) => {
    issues.push(chapterId ? { level, kind, detail, chapter: chapterId } : { level, kind, detail })
  }
  for (const row of rows) {
    const label = row.id + ' ' + row.title
    if (row.chars === 0 && !row.placeholder) add('error', 'empty-chapter', label + '：文件里没有正文', row.id)
    if (!row.written) continue
    const goal = row.target > 0 ? row.target : target
    if (goal > 0) {
      if (row.chars < goal * 0.7) add('warn', 'short', label + '：' + row.chars + '/' + goal + ' 字，差 ' + (goal - row.chars), row.id)
    }
    if (sections.length) {
      const section = matchBeatSection(sections, row)
      if (section) {
        const body = (await readText(path.join(root, row.file))) ?? ''
        const cover = beatCoverage(body, section.body)
        if (cover.total > 0 && cover.covered < cover.total) {
          add('warn', 'beats-gap', label + '：章纲 ' + cover.total + ' 场，字面近似匹配 ' + cover.covered + ' 场；未匹配不代表漏写，需对照全文', row.id)
        }
      }
    }
    if (styleRawAudit) {
      const chapterBody = (await readText(path.join(root, row.file))) ?? ''
      const fitSampleAudit = await readStyleSample(root, styleNameAudit)
      const fit = styleFit(chapterBody, styleRawAudit, fitSampleAudit && fitSampleAudit.present ? fitSampleAudit.text : "")
      if (fit.flagged.length) {
        const worst = fit.flagged
          .slice()
          .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
          .slice(0, 2)
          .map(item => `${item.label} ${item.act}（锚点 ${item.ref}）`)
        add('warn', 'style-drift', label + '：节奏统计偏差，仅供复核——' + worst.join('；'), row.id)
      }

    }
  }
  const written = rows.filter(row => row.written)
  const placeholders = rows.filter(row => row.placeholder)
  for (const item of decorateThreads(threadBoard.rows, latest).filter(row => row.due)) {
    add('warn', 'thread-due', '「' + item.thread + '」计划在 ' + item.payoff + ' 收，现在已经写到 ' + latest + ' 还没收', item.payoff)
  }
  const cadenced = cards.filter(card => card.cadence > 0)
  if (cadenced.length) {
    const seen = await appearanceIndex(root, rows, cards, target)
    const report = appearanceReport(seen.last, cadenced, latest || seen.latestId)
    for (const name of Object.keys(report)) {
      const item = report[name]
      if (!item.due) continue
      const where = item.last ? ' 上一次出场是第 ' + item.last + ' 章，已经 ' + item.gap + ' 章没露面' : ' 一次都没在正文里出现'
      add('warn', 'absent-role', name + where + '；人物卡上写的是每 ' + item.cadence + ' 章至少一次', item.last || latest)
    }
  }
  const eventBoard = await readEvents(root)
  if (eventBoard.present) {
    const timeline = eventTimeline(eventBoard, rows, sections)
    for (const warning of timeline.warnings) add('warn', 'spine', warning)
  }
  const rhythm = await beatRhythm(root, rows)
  const gapLimit = rhythm.gapLimit || 2
  if (latest && rhythm.currentGap >= gapLimit) {
    add('warn', 'no-payoff', '已经连续 ' + rhythm.currentGap + ' 章没有爽点（大纲要求每 ' + gapLimit + ' 章至少一次）', latest)
  }
  const rank = { error: 0, warn: 1 }
  issues.sort((a, b) => (rank[a.level] - rank[b.level]) || String(a.chapter || '').localeCompare(String(b.chapter || '')))
  return {
    issues,
    summary: {
      chapters: rows.length,
      written: written.length,
      placeholders: placeholders.length,
      words: written.reduce((sum, row) => sum + row.chars, 0),
      target: rows.reduce((sum, row) => sum + (row.target || target || 0), 0),
      errors: issues.filter(item => item.level === 'error').length,
      warns: issues.filter(item => item.level === 'warn').length,
      gapLimit,
      latest,
    },
  }
}

/** 导出正文：全书或章节区间，合成一个文件，或按章拆开（只含已有正文的章）。 */
async function exportBook(root, options) {
  const args = options || {}
  const { meta } = await loadBook(root)
  const target = meta.targetChars
  const format = args.format === 'md' ? 'md' : 'txt'
  const rows = []
  for (const chapter of meta.chapters) rows.push(await chapterStats(root, chapter, target))
  const from = typeof args.from === 'string' && args.from.trim() !== '' ? args.from.trim() : ''
  const to = typeof args.to === 'string' && args.to.trim() !== '' ? args.to.trim() : ''
  const picked = rows.filter(row => (!from || row.id >= from) && (!to || row.id <= to) && row.chars > 0 && !row.placeholder)
  if (picked.length === 0) throw new Error('这一段没有可导出的正文（都是空的或占位）')
  const stamp = stampOf()
  const dir = path.join(root, 'export')
  await fsp.mkdir(dir, { recursive: true })
  const pieces = []
  let words = 0
  const perChapter = args.mode === 'per-chapter'
  for (const row of picked) {
    const body = ((await readText(path.join(root, row.file))) ?? '').trim()
    words += countChars(body)
    if (perChapter) {
      const file = path.join(dir, stamp + '-' + row.id + '.txt')
      const head = row.title ? row.title + String.fromCharCode(10, 10) : ''
      await writeFileAtomic(file, head + body + String.fromCharCode(10))
    } else {
      pieces.push((format === 'md' ? '## ' : '') + (row.title || row.id))
      pieces.push("")
      pieces.push(body)
      pieces.push("")
    }
  }
  if (perChapter) {
    return { mode: 'per-chapter', dir: path.relative(root, dir), chapters: picked.length, words }
  }
  const name = args.out && String(args.out).trim() ? String(args.out).trim() : 'book-' + stamp + '.' + format
  const file = path.join(dir, name)
  const head = format === 'md' && meta.title ? '# ' + meta.title + String.fromCharCode(10, 10) : ''
  const content = head + pieces.join(String.fromCharCode(10)) + String.fromCharCode(10)
  await writeFileAtomic(file, content)
  return { mode: 'single', file: path.relative(root, file), chapters: picked.length, words, chars: countChars(content) }
}
export function apply(ctx, config) {
  const fallbackRoot = resolveRoot(config)

  /** 当前作用域里的书根：工具体在各会话的 cwd 里跑，路由体在请求解析出的根里跑。 */
  const rootNow = () => rootContext.getStore() ?? fallbackRoot

  /** config.root 是作者显式钉死的根，优先级最高；否则跟着会话走，最后才退回进程 cwd。 */
  const rootOf = async (sessionId, exec) => {
    if (config && typeof config.root === 'string' && config.root.trim() !== '') return config.root
    const directory = await sessionDirectory(ctx, sessionId, exec)
    return directory === '' ? fallbackRoot : directory
  }

  /** 注册工具时统一包一层：先把会话根放进作用域，再跑工具本体。 */
  const toolDefs = new Map()
  const registerTool = definition => {
    toolDefs.set(definition.name, definition)
    const execute = definition.execute
    return ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined
        const root = await rootOf(header ? header.id : undefined, exec)
        return toLosslessJson(await rootContext.run(root, () => execute(args, exec)))
      },
    })
  }

  async function snapshot() {
    const { exists, meta } = await loadBook(rootNow())
    const chapters = []
    for (const chapter of meta.chapters) chapters.push(await chapterStats(rootNow(), chapter, meta.targetChars))
    const outline = (await readText(path.join(rootNow(), OUTLINE_FILE))) ?? ''
    const characters = await listCharacters(rootNow())
    const threads = await loadThreads(rootNow())
    const beats = await beatsCoverage(rootNow(), chapters)
    const rhythm = await beatRhythm(rootNow(), chapters)
    const eventBoard = await readEvents(rootNow())
    const beatBoard = await readBeats(rootNow(), null)
    const spine = eventTimeline(eventBoard, chapters, beatBoard.sections)
    const budget = payoffBudget(outline)
    const settings = await listSettings(rootNow())
    const styles = await listStyles(rootNow())
    const activeStyle = activeStyleName(meta)
    const written = chapters.filter(item => item.written)
    const writtenLatest = latestWrittenId(written)
    const targetTotal = chapters.reduce((sum, item) => sum + (item.target || 0), 0)
    const agents = await fsp.access(path.join(rootNow(), 'AGENTS.md')).then(() => true).catch(() => false)
    return {
      root: rootNow(),
      exists,
      agents,
      book: {
        title: meta.title,
        author: meta.author,
        genre: meta.genre,
        summary: meta.summary,
        targetChars: meta.targetChars,
        targetCharsSet: meta.targetCharsSet,
      },
      outline: { chars: countChars(outline), present: outline !== '' },
      beats: { present: beats.present, total: beats.total, covered: beats.covered.length, missing: beats.missing },
      events: {
        present: spine.present,
        lines: spine.lineCount,
        total: spine.eventCount,
        done: spine.done,
        warnings: spine.warnings.length,
        byChapter: spine.chapters.map(item => ({ id: item.id, hits: item.hits.map(hit => hit.eventId) })),
      },
      rhythm: {
        total: rhythm.total,
        withBeats: rhythm.withBeats,
        payoff: rhythm.payoff,
        withPayoff: rhythm.withPayoff,
        hooks: rhythm.hooks,
        turns: rhythm.turns,
        longestGap: rhythm.longestGap,
        currentGap: rhythm.currentGap,
        gapLimit: rhythm.gapLimit,
        budget: budget ? budget.total : 0,
        perChapter: rhythm.perChapter.map(item => ({          id: item.id,
          title: item.title,
          hasBeats: item.hasBeats,
          payoff: item.payoff,
          hook: item.hook,
          turn: item.turn,
        })),
      },
      characters: characters.map(item => ({ name: item.name, summary: item.summary, chars: item.chars })),
      settings: settings.map(item => ({ name: item.name, summary: item.summary, category: item.category, chars: item.chars })),
      styles: styles.map(item => ({ name: item.name, summary: item.summary, chars: item.chars })),
      style: activeStyle,
      threads: {
        present: threads.present,
        opened: threads.rows.filter(item => item.open).length,
        due: decorateThreads(threads.rows, writtenLatest).filter(item => item.due).length,
        total: threads.rows.length,
      },
      chapters: chapters.map(item => ({ ...item, progress: chapterProgress(item) })),
      totals: {
        chapters: chapters.length,
        written: written.length,
        planned: chapters.filter(item => !item.written).length,
        placeholders: chapters.filter(item => item.placeholder).length,
        chars: chapters.reduce((sum, item) => sum + item.chars, 0),
        target: targetTotal,
        progress: targetTotal > 0 ? Math.min(1, chapters.reduce((sum, item) => sum + item.chars, 0) / targetTotal) : 0,
      },
    }
  }

  /** 统一的工具结果渲染：模型读文字，界面读卡片标题。 */
  const textRender = text => [{ type: 'text', text }]

  registerTool({
    name: 'novel_status',
    description:
      '查看当前这本书的结构：书名、章节清单（按 book.json 的顺序）、每章字数与目标字数、总进度、人物卡与未回收伏笔数量。写作前先调用它确认上下文。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          exists: { type: 'boolean' },
          agents: { type: 'boolean' },
          book: { type: 'object', additionalProperties: true },
          outline: { type: 'object', additionalProperties: true },
          characters: { type: 'array', items: { type: 'object', additionalProperties: true } },
          settings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          threads: { type: 'object', additionalProperties: true },
          rhythm: { type: 'object', additionalProperties: true },
          chapters: { type: 'array', items: { type: 'object', additionalProperties: true } },
          totals: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const rhythms = new Map((value.rhythm?.perChapter ?? []).map(item => [item.id, item]))
        const head =
          `《${value.book.title}》 ${value.totals.chapters} 章 / 已写 ${value.totals.written} 章 / 共 ${value.totals.chars} 字` +
          `（目标 ${value.totals.target} 字${value.book.targetCharsSet ? '' : ' · 默认值'}，完成 ${Math.round(value.totals.progress * 100)}%）` +
          `\n人物卡 ${value.characters.length} 张 · 设定 ${value.settings.length} 条 · 未回收伏笔 ${value.threads.opened} 条` +
          (value.totals.placeholders
            ? `\n有 ${value.totals.placeholders} 章还是「（待写）」占位：只算结构，不算正文`
            : '') +
          (value.settings.length === 0
            ? '\n设定 0 条：世界规则别只写在 outline.md 里 —— 先用 novel_setting 建 3–8 条（地点 / 规矩 / 物品 / 术语），否则写正文时装配不到。'
            : '') +
          (value.agents === false
            ? '\n这个工作区还没有 AGENTS.md（写作规范）：AI 每轮都看不到「目录结构 / 人物卡与章纲格式 / 先装配再写」这些约定，容易把它当普通文件夹、用 write 直接写 md。用 novel_book({ scaffold: true }) 让插件写一份。'
            : '') +
          (value.rhythm && value.rhythm.withBeats
            ? `\n节奏：爽点 ${value.rhythm.payoff}${value.rhythm.budget ? ` / 计划 ${value.rhythm.budget}` : ''}` +
              ` · 有爽点的章 ${value.rhythm.withPayoff}/${value.rhythm.withBeats} · 钩子 ${value.rhythm.hooks} 章 · 最长断档 ${value.rhythm.longestGap} 章` +
              (value.rhythm.currentGap >= (value.rhythm.gapLimit || 2)
                ? `\n⚠ 已经连续 ${value.rhythm.currentGap} 章没有爽点：读者会走神，下一章该给一次情绪回报（打脸 / 翻盘 / 揭秘 / 情感兑现都算）。`
                : '')
            : '')
        const list = value.chapters.length
          ? '\n' +
            value.chapters
              .map(item => {
                // 差几十字不叫「偏短」：达标线放到目标的 95%，别制造假警报。
                const flag =
                  item.placeholder
                    ? '待写（占位）'
                    : item.chars === 0
                    ? '未写'
                    : item.chars >= item.target * 0.95
                      ? '达标'
                      : item.chars * 2 >= item.target
                        ? '偏短'
                        : '远短'
                const rhythm = rhythms.get(item.id)
                const mark = rhythm && rhythm.hasBeats
                  ? ` · 爽×${rhythm.payoff}${rhythm.hook ? ' 钩' : ''}`
                  : ''
                return `- ${item.id} ${item.title}（${item.chars}/${item.target} 字 · ${flag} · ${item.status}${mark}）`
              })
              .join('\n')
          : '\n（还没有章节）'
        return textRender(head + list)
      },
    },
    execute: async () => {
      // 读状态前先对一遍历史：有人绕过工具改了正文，这里补一版再说。
      await reconcileHistory(rootNow(), { throttle: true })
      return snapshot()
    },
    presentCall: () => ({ card: 'generic', title: '查看书稿结构', kind: 'read', rawInput: {} }),
  })

  registerTool({
    name: 'novel_book',
    description:
      '查看或修改整本书的元信息：书名、作者、类型、一句话简介、每章目标字数。' +
      '目标字数是全书默认的参考篇幅（每章可单独覆盖），超出不报警、不要求删减或缩写。' +
      '作者的篇幅意图常写在大纲里（例如「4 章 × 1000 字」）：如果大纲写了而 book.json 没写，' +
      '用这个工具把 targetChars 定下来，不要让插件默认值冒充作者的决定。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '书名' },
        author: { type: 'string', description: '作者' },
        genre: { type: 'string', description: '类型（悬疑 / 奇幻 / 都市 …）' },
        summary: { type: 'string', description: '一句话简介' },
        targetChars: { type: 'number', description: '每章目标字数（200–50000，整本默认）' },
        scaffold: {
          type: 'boolean',
          description: '创建写作规范；已存在时仅追加或更新插件管理的交付复核小节，保留作者自定义内容。旧书无需更新文件也会在上下文中收到最新复核流程。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          book: { type: 'object', additionalProperties: true },
          changed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const book = value.book
        const head =
          `《${book.title}》` +
          (book.author ? ` · ${book.author}` : '') +
          (book.genre ? ` · ${book.genre}` : '')
        const target =
          `每章目标 ${book.targetChars} 字` + (book.targetCharsSet ? '' : '（默认值，还没定下来）')
        const changed = value.changed.length ? `\n已更新：${value.changed.join('、')}` : '\n（没有改动）'
        const notes = []
        if (value.scaffold) {
          notes.push(
            value.scaffold.created
              ? `写作规范已写到 ${value.scaffold.path}（${value.scaffold.bytes} 字节）：目录结构、人物卡 / 章纲 / 伏笔 / 文风卡格式、六步流程都在里面，下一轮对话会被自动加载。`
              : value.scaffold.updated
                ? `${value.scaffold.path} 的交付复核小节已更新，作者自定义内容已保留。`
                : `${value.scaffold.path} 的交付复核小节已是最新。`,
          )
        }
        return textRender(
          head + '\n' + target + (book.summary ? '\n' + book.summary : '') + changed + (notes.length ? '\n' + notes.join('\n') : ''),
        )
      },
    },
    execute: async args => {
      const { meta } = await loadBook(rootNow())
      const next = { ...meta }
      const changed = []
      if (typeof args.title === 'string' && args.title.trim() && args.title.trim() !== meta.title) {
        next.title = args.title.trim()
        changed.push('书名')
      }
      if (typeof args.author === 'string' && args.author.trim() !== meta.author) {
        next.author = args.author.trim()
        changed.push('作者')
      }
      if (typeof args.genre === 'string' && args.genre.trim() !== meta.genre) {
        next.genre = args.genre.trim()
        changed.push('类型')
      }
      if (typeof args.summary === 'string' && args.summary.trim() !== meta.summary) {
        next.summary = args.summary.trim()
        changed.push('简介')
      }
      if (args.targetChars != null) {
        const target = clampInt(args.targetChars, meta.targetChars, 200, 50000)
        if (target !== meta.targetChars) changed.push('每章目标字数')
        next.targetChars = target
        next.targetCharsSet = true
      }
      if (changed.length) await persistBook(rootNow(), next, next.chapters)
      let scaffold = null
      if (args.scaffold === true) {
        scaffold = await scaffoldAgents(rootNow())
        if (scaffold.created || scaffold.updated) changed.push('AGENTS.md（写作规范）')
      }
      return {
        book: {
          title: next.title,
          author: next.author,
          genre: next.genre,
          summary: next.summary,
          targetChars: next.targetChars,
          targetCharsSet: next.targetCharsSet,
        },
        changed,
        ...(scaffold ? { scaffold } : {}),
      }
    },
    presentCall: () => ({ card: 'generic', title: '改书的元信息', kind: 'write', rawInput: {} }),
  })

  registerTool({
    name: 'novel_import',
    description:
      '把一份原文文件里的章节「原样搬进」chapters/ —— 由宿主按行切片搬字节，**不经过你读正文**（省上下文、省 token，也不会被改写）。' +
      '\n\n先探测再落盘：novel_import({ source, dryRun: true }) 只返回识别到的章数、标题、每章字数；确认无误再 dryRun: false 真正写入。' +
      '\n\n边界谁定：默认按「第N章」这类标题行自动切（也认 Chapter N / ## 标题 / N、标题）；标题格式怪就给 pattern（正则）；边界要人工干预就给 ranges: [{ title, from, to }]（行号从 1 起，你只报边界，正文不经过你）。' +
      '\n\n拆书/导入旧稿的正确用法：novel_import 落章节原文 → 再逐章 novel_beats 写章纲 / novel_card 建人物 —— 不要让 AI 把整本书重抄一遍。默认跳过「同名或同章号」的已有章节（「第一章 日记」和「第1章 日记」算同一章），replace: true 才覆盖原文件。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '原文文件路径（自动认 UTF-8 / GBK / UTF-16）' },
        pattern: { type: 'string', description: '自定义章节标题正则（可选），不填用内置几种' },
        ranges: {
          type: 'array',
          description: '显式边界：[{ title, from, to }]，行号从 1 开始',
          items: { type: 'object', additionalProperties: true },
        },
        limit: { type: 'number', description: '最多导入多少章（默认 50，上限 500）' },
        offset: { type: 'number', description: '从识别到的第几章开始（1 起，默认 1）' },
        dryRun: { type: 'boolean', description: 'true = 只探测不写盘，建议先跑一次' },
        replace: { type: 'boolean', description: 'true = 已存在同名章节也覆盖' },
        status: { type: 'string', enum: CHAPTER_STATUS, description: '导入后的章节状态，默认 planned' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          encoding: { type: 'string' },
          bytes: { type: 'number' },
          detected: { type: 'number' },
          imported: { type: 'number' },
          skipped: { type: 'array', items: { type: 'string' } },
          empty: { type: 'array', items: { type: 'string' } },
          totalChars: { type: 'number' },
          chapters: { type: 'array', items: { type: 'object', additionalProperties: true } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = value.chapters
          .slice(0, 12)
          .map(item => `- ${item.id ? `${item.id} ` : `${item.index}. `}${item.title}（${item.chars} 字）`)
        const more = value.chapters.length > 12 ? `\n… 还有 ${value.chapters.length - 12} 章` : ''
        if (value.mode === 'dry-run') {
          return textRender(
            `探测（没有写任何文件）：识别到 ${value.detected} 章，本次 ${value.chapters.length} 章，共 ${value.totalChars} 字` +
              `（编码 ${value.encoding}，${Math.round(value.bytes / 1024)} KB）\n` +
              lines.join('\n') +
              more +
              (value.warnings.length ? `\n⚠ ${value.warnings.join('；')}` : '') +
              '\n\n确认没问题就再调一次同样的参数、加 dryRun: false 真正落盘。',
          )
        }
        return textRender(
          `已导入 ${value.imported} 章进 chapters/（共 ${value.totalChars} 字）` +
            (value.skipped.length ? `；跳过同名 ${value.skipped.length} 章` : '') +
        (value.empty && value.empty.length ? `；原文为空的 ${value.empty.length} 章（已建成 planned，等你补）：${value.empty.join('、')}` : '') +
            '\n' +
            lines.join('\n') +
            more +
            (value.warnings.length ? `\n⚠ ${value.warnings.join('；')}` : '') +
            '\n\n下一步：每章 novel_beats 写章纲（3–6 条「- 场景：…」+「→ 爽点 / → 钩子」），人物用 novel_card 落卡。',
        )
      },
    },
    execute: async args => {
      const root = rootNow()
      const loaded = await loadTextFile(args.source)
      const lines = loaded.text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n')
      const warnings = []

      let segments = []
      if (Array.isArray(args.ranges) && args.ranges.length) {
        for (const range of args.ranges) {
          const from = Math.max(1, Number(range?.from) || 0)
          const to = Math.min(lines.length, Number(range?.to) || 0)
          if (!from || !to || to < from) continue
          segments.push({
            title: String(range?.title ?? '').trim() || `第 ${segments.length + 1} 章`,
            body: lines.slice(from - 1, to).join('\n').trim(),
          })
        }
        if (!segments.length) throw new Error('ranges 里没有可用的边界（from/to 是行号，从 1 开始）')
      } else {
        const patterns = args.pattern
          ? [new RegExp(args.pattern, 'u')]
          : [
              /^\s*第\s*[0-9０-９一二三四五六七八九十百千零两]{1,8}\s*章/u,
              /^\s*Chapter\s+\d+/iu,
              /^\s*#{1,3}\s+\S/u,
              /^\s*\d{1,4}\s*[.、]\s*\S/u,
            ]
        let marks = []
        for (const pattern of patterns) {
          marks = []
          lines.forEach((line, index) => {
            if (line.length <= 40 && pattern.test(line)) marks.push({ index, title: line.replace(/^[#\s]+/u, '').trim() })
          })
          if (marks.length >= 2) break
        }
        if (!marks.length) {
          throw new Error('没在这份文件里认出章节标题：用 pattern 指定正则，或用 ranges 显式给边界（行号）')
        }
        for (let i = 0; i < marks.length; i += 1) {
          const mark = marks[i]
          const next = marks[i + 1] ? marks[i + 1].index : lines.length
          segments.push({ title: mark.title, body: lines.slice(mark.index + 1, next).join('\n').trim() })
        }
      }

      const total = segments.length
      const offset = clampInt(args.offset, 1, 1, 100000)
      const limit = clampInt(args.limit, 50, 1, 500)
      const picked = segments.slice(offset - 1, offset - 1 + limit)
      if (!picked.length) throw new Error(`识别到 ${total} 章，但 offset=${offset} 之后没有内容了`)

      const preview = picked.map((segment, index) => ({
        index: offset + index,
        title: segment.title,
        chars: countChars(segment.body),
      }))
      const totalChars = preview.reduce((sum, item) => sum + item.chars, 0)
      const emptyTitles = picked.filter(segment => countChars(segment.body) === 0).map(segment => segment.title)
      for (const title of emptyTitles) {
        warnings.push(`${title} 原文里是空的（只有标题、没有正文），导入时会建成 planned 章，等你补写`)
      }

      if (args.dryRun === true) {
        return {
          mode: 'dry-run',
          source: args.source,
          encoding: loaded.encoding,
          bytes: loaded.bytes,
          detected: total,
          imported: 0,
          skipped: [],
          empty: emptyTitles,
          totalChars,
          chapters: preview,
          warnings,
        }
      }

      const { meta } = await loadBook(root)
      const chapters = [...meta.chapters]
      const imported = []
      const skipped = []
      const empty = []
      for (const segment of picked) {
        const key = chapterNumberOf(segment.title)
        const existing = chapters.find(
          item => item.title.trim() === segment.title.trim() || (key > 0 && chapterNumberOf(item.title) === key),
        )
        if (existing && args.replace !== true) {
          skipped.push(segment.title)
          continue
        }
        if (mode === 'patch' && !existing) throw new Error('局部改写必须指定已有章节')
      let chapter = existing
        if (!chapter) {
          const id = nextChapterId(chapters)
          chapter = {
            id,
            title: segment.title,
            file: `${CHAPTERS_DIR}/${id}.md`,
            status: CHAPTER_STATUS.includes(args.status) ? args.status : 'planned',
            targetChars: 0,
            note: '原文摘录',
          }
          chapters.push(chapter)
        } else {
          chapter = { ...chapter, note: chapter.note || '原文摘录' }
          chapters[chapters.findIndex(item => item.id === chapter.id)] = chapter
        }
        const bodyChars = countChars(segment.body)
        if (bodyChars === 0) {
          // 原文这一章就是空的：别留个 1 字节的空壳假装导入成功
          chapter = { ...chapter, status: 'planned', note: '原文为空' }
          chapters[chapters.findIndex(item => item.id === chapter.id)] = chapter
          empty.push(`${chapter.id} ${chapter.title}`)
          continue
        }
        const target = path.join(root, chapter.file)
        await fsp.mkdir(path.dirname(target), { recursive: true })
        const previous = (await readText(target)) ?? ''
        if (previous.trim() && previous.trim() !== segment.body.trim()) {
          await snapshotChapter(root, { chapter, text: previous, source: 'import:replace', note: '导入原文前留存', style: activeStyleName(meta) })
        }
        await writeFileAtomic(target, `${segment.body}\n`)
        // 种一次快照指纹，免得看门狗把这些章当成「被工具外改动」。
        await writeFileAtomic(lastSnapshotPath(root, chapter.id), `${segment.body}\n`)
        imported.push({ id: chapter.id, title: chapter.title, chars: countChars(segment.body) })
      }
      if (imported.length) await persistBook(root, meta, chapters)
      return {
        mode: 'import',
        source: args.source,
        encoding: loaded.encoding,
        bytes: loaded.bytes,
        detected: total,
        imported: imported.length,
        skipped,
        empty,
        totalChars: imported.reduce((sum, item) => sum + item.chars, 0),
        chapters: imported,
        warnings,
      }
    },
    presentCall: () => ({ card: 'generic', title: '导入原文到章节', kind: 'write', rawInput: {} }),
  })

  registerTool({
    name: 'novel_read',
    description:
      '读正文。给 chapter = 读这本书的一章（chapter 可以是章 id 如 0003、章节标题或文件名）；给 source = 读任意外部文本文件（旧稿、下载的 txt、别人的稿子），自动认 UTF-8 / GBK(GB18030) / UTF-16 编码，按字分页返回（offset + limit），长篇不要一次读完。' +
      '\n\n导入旧稿的标准组合（不另设导入工具）：novel_read({ source }) 分页扫一遍看清章节标题长什么样 → 自己判断章节边界（插件不猜边界）→ 逐章 novel_write({ chapter, title, content }) 落盘 → novel_status 核对章数与字数 → 需要的话再 novel_outline / novel_card / novel_setting / novel_style({ clone: true }) 逆向提炼。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '章 id、章节标题或文件名（可省略 .md）；给 source 时忽略' },
        source: { type: 'string', description: '外部文件路径：绝对路径，或相对当前书目录' },
        offset: { type: 'integer', description: '从第几个字开始（按字符算，不是字节），默认 0' },
        limit: { type: 'integer', description: '一次返回多少字，默认 4000，上限 20000' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          chars: { type: 'integer' },
          content: { type: 'string' },
          source: { type: 'string' },
          encoding: { type: 'string' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          from: { type: 'integer' },
          to: { type: 'integer' },
          nextOffset: { type: 'integer' },
          done: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.source) {
          const rest = value.done ? '已读完' : `还有 ${value.chars - value.to} 字，下次 offset=${value.nextOffset}`
          const cut = value.truncated ? '（文件超过 32 MB，只读了前 32 MB）' : ''
          return textRender(
            `【外部文件】${value.source}\n编码 ${value.encoding} · ${value.bytes} 字节 · 共 ${value.chars} 字 · 本次 ${value.from}–${value.to} 字 · ${rest}${cut}\n\n${value.text}`,
          )
        }
        return textRender(value.content || '（这一章还是空的）')
      },
    },
    execute: async args => {
      const target = typeof args.source === 'string' ? args.source.trim() : ''
      if (target) {
        const file = path.isAbsolute(target) ? target : path.join(rootNow(), target)
        const { text, encoding, bytes, truncated } = await loadTextFile(file)
        const characters = Array.from(text)
        const total = characters.length
        const from = Math.max(0, Math.min(total, Math.trunc(Number(args.offset) || 0)))
        const limit = Math.max(200, Math.min(20000, Math.trunc(Number(args.limit) || 4000)))
        const to = Math.min(total, from + limit)
        const slice = characters.slice(from, to).join('')
        return {
          source: file,
          encoding,
          bytes,
          truncated,
          chars: total,
          from,
          to,
          nextOffset: to < total ? to : 0,
          done: to >= total,
          text: slice,
          content: slice,
        }
      }
      const { meta } = await loadBook(rootNow())
      const chapter = findChapter(meta.chapters, args.chapter)
      if (!chapter) {
        throw new Error(`找不到章节 "${args.chapter}"；先调用 novel_status 看有哪些章`)
      }
      const content = (await readText(path.join(rootNow(), chapter.file))) ?? ''
      return { id: chapter.id, title: chapter.title, chars: countChars(content), content }
    },
    presentCall: args =>
      ({
        card: 'generic',
        title: args.source ? `读外部文件 ${path.basename(String(args.source))}` : `读取 ${args.chapter}`,
        kind: 'read',
        rawInput: args,
      }),
  })

  registerTool({
    name: 'novel_write',
    description:
      '写一章正文。不给 chapter 就自动新建下一章；mode=replace 覆盖整章（默认，覆盖前会把旧稿备份到 chapters/.history/），mode=append 追加到章末。写完会同步 book.json，字数随之更新。目标字数只作参考，允许超出，不要求缩写或提前收尾。按情节自然节点决定分章；确需顺延后续场景时可传 carryOver: true。' +
      '\n改写先用 novel_deai_pack 阅读全文与声口；多个修改用 mode:"patch", baseHash, patches:[{start,end,content}] 一次提交，所有坐标均以同一版原文为准。单片段 start/end/content 仍可用。修改后重新取包并提交 novel_deai_review，再 novel_check；未完成当前版本复核不可标记 final。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要写入的正文（Markdown）' },
        chapter: { type: 'string', description: '章 id 或标题；省略则新建下一章' },
        title: { type: 'string', description: '章节标题；新建时可指定，默认「第 N 章」' },
        mode: { type: 'string', enum: ['replace', 'append', 'patch'], description: 'replace 覆盖（默认）| append 追加 | patch 仅替换 start/end 范围' },
        baseHash: { type: 'string', description: '上下文返回的原文 SHA-256，patch 必填；原文改变则拒绝写入' },
        start: { type: 'integer', minimum: 0, description: 'patch 起点，Unicode 字符索引，含起点' },
        end: { type: 'integer', minimum: 1, description: 'patch 终点，Unicode 字符索引，不含终点' },
        patches: {
          type: 'array', minItems: 1, description: 'patch 批量替换；一次验证整章哈希，所有范围基于同一版原文，不可重叠。与顶层 start/end/content 互斥。',
          items: {
            type: 'object', additionalProperties: false,
            properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, content: { type: 'string' } },
            required: ['start', 'end', 'content'],
          },
        },
        status: { type: 'string', enum: CHAPTER_STATUS, description: '写完后的章节状态，默认 draft' },
        note: { type: 'string', description: '一句话说明这次改动（写进历史时间线，例如「按文风重写」「补了结尾」）' },
        carryOver: { type: 'boolean', description: 'true = 把本章章纲里还没写完的场景/信息自动顺延到下一章章纲，避免硬塞' },
      },
      anyOf: [{ required: ['content'] }, { required: ['patches'] }],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          chars: { type: 'integer' },
          target: { type: 'integer' },
          totalChars: { type: 'integer' },
          created: { type: 'boolean' },
          status: { type: 'string' },
          backup: { type: 'string' },
          carriedOver: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const gap = value.target > 0 && value.chars < value.target ? `，距目标 ${value.target} 字还差 ${value.target - value.chars}` : ''
        const carry = value.carriedOver
          ? `\n已将未写完的 ${value.carriedOver.scenes} 场戏${value.carriedOver.infos ? `、${value.carriedOver.infos} 条信息` : ''}顺延至 ${value.carriedOver.nextChapter.id} ${value.carriedOver.nextChapter.title} 章纲，可直接调用 novel_context({ chapter: "${value.carriedOver.nextChapter.id}" }) 接着写。`
          : ''
        return textRender(
          `${value.created ? '已新建' : '已写入'} ${value.id} ${value.title}，本章 ${value.chars} 字${gap}，全书 ${value.totalChars} 字。` +
            (value.backup ? `旧稿已备份到 ${value.backup}。` : '') +
            carry +
            warnText(value.warnings),
        )
      },
    },
    execute: async args => {
      if (args.carryOver && args.chapter) {
        const { meta } = await loadBook(rootNow())
        const chapter = findChapter(meta.chapters, args.chapter)
        const board = chapter ? await readBeats(rootNow(), chapter) : null
        if (board?.section?.scenes?.length) throw new Error('结构化场景请用 novel_move_scene 整场顺延，再保存正文；不能按行拆分人物约束')
      }
      const { meta } = await loadBook(rootNow())
      const chapters = [...meta.chapters]
      const mode = args.mode === 'patch' ? 'patch' : args.mode === 'append' ? 'append' : 'replace'
      if (args.patches !== undefined && (mode !== 'patch' || args.content !== undefined || args.start !== undefined || args.end !== undefined)) throw new Error('patches 仅用于 patch 模式，不能同时提供顶层 start/end/content')
      if (args.patches === undefined && typeof args.content !== 'string') throw new Error('必须提供正文 content 或 patch 模式的 patches')
      const existing = args.chapter ? findChapter(chapters, args.chapter) : undefined

      if (args.chapter && !existing) {
        throw new Error(`找不到章节 "${args.chapter}"；要新建一章请省略 chapter`)
      }

      let chapter = existing
      const created = !chapter
      if (!chapter) {
        const id = nextChapterId(chapters)
        chapter = {
          id,
          title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : `第 ${Number(id)} 章`,
          file: `${CHAPTERS_DIR}/${id}.md`,
          status: 'draft',
          targetChars: 0,
        }
        chapters.push(chapter)
      } else {
        chapter = { ...chapter }
        if (typeof args.title === 'string' && args.title.trim() && args.title.trim() !== chapter.title) {
          chapter.title = args.title.trim()
        }
        const index = chapters.findIndex(item => item.id === chapter.id)
        chapters[index] = chapter
      }

      if (CHAPTER_STATUS.includes(args.status)) chapter.status = args.status

      const target = path.join(rootNow(), chapter.file)
      const previous = (await readText(target)) ?? ''
      const body = applyChapterEdit(previous, { ...args, mode })
      const reviewed = await hasCurrentDeaiReview(rootNow(), chapter, body, meta)
      if (args.status === 'final' && !reviewed) throw new Error('当前版本缺少有效审稿记录或仍有阻塞项，请先保存草稿、读取审稿包并如实登记；有效记录也不代表自动语义认证；未写入')
      if (chapter.status === 'final' && !reviewed) chapter.status = 'draft'

      // 覆盖/追加前先留一版完整快照（正文 + 元数据），改写是破坏性操作。
      let backup = ''
      if (previous.trim() && previous !== body) {
        const kept = await snapshotChapter(rootNow(), {
          chapter,
          text: previous,
          source: `write:${mode}`,
          note: typeof args.note === 'string' ? args.note : '',
          style: activeStyleName(meta),
        })
        if (kept) backup = kept.file
      }

      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, body, 'utf8')
      await writeFileAtomic(lastSnapshotPath(rootNow(), chapter.id), body)

      const chars = countChars(body)
      if (!CHAPTER_STATUS.includes(args.status)) {
        chapter.status = chars > 0 && !isPlaceholderText(body) ? 'draft' : chapter.status
      }
      await persistBook(rootNow(), { ...meta, chapters }, chapters)

      const after = await snapshot()
      const chapterTarget = chapter.targetChars > 0 ? chapter.targetChars : meta.targetChars
      // 写完顺手对一遍章纲：漏掉的场景当场说出来，别等作者读完全章才发现。
      const warnings = validateChapterContent(body)
      const stageAfterWrite = await stageContext(rootNow(), chapters, chapter.id)
      warnings.push(...stageAfterWrite.warnings)
      if (stageAfterWrite.scenes.length) warnings.push('写后请逐场核对实际认知与关系变化：novel_character_history propose 提交逐字正文依据，再确认；章纲计划不会自动进入历史。')
      const beat = await readBeats(rootNow(), chapter)
      let carriedOver = null
      if (beat.section && beat.section.chars > 0) {
        const gap = beatCoverage(body, beat.section.body)
        const infoList = beat.section.infos ?? []
        const infoGap = infoList.length ? beatCoverage(body, infoList.map(item => item.text).join('\n')) : { missing: [] }
        if (args.carryOver === true && (gap.missing.length > 0 || infoGap.missing.length > 0)) {
          const missingScenes = new Set(gap.missing.map(item => item.index))
          const missingInfos = new Set(infoGap.missing.map(item => item.index))
          const beatLines = beat.section.body.replace(/\r\n/gu, '\n').split('\n')
          const hasExplicitScenes = beatLines.some(line => /^\s*[-*+]?\s*场景\s*[：:]/u.test(line))
          const keptLines = []
          const movedLines = []
          let sceneIdx = 0
          let infoIdx = 0
          let movingScene = false
          for (const line of beatLines) {
            const isScene = hasExplicitScenes ? /^\s*[-*+]?\s*场景\s*[：:]/u.test(line) : (line.trim().length >= 6 && !/^\s*[-*+]?\s*(?:信息|落点|钩子|爽点|转折|位移|反应|心里|心理|念头|回忆|认知|备注|注|事件)\s*[：:]/u.test(line))
            const isInfo = /^\s*[-*+]?\s*信息\s*[：:]/u.test(line)
            if (isScene) {
              sceneIdx += 1
              movingScene = missingScenes.has(sceneIdx)
              if (movingScene) movedLines.push(line)
              else keptLines.push(line)
              continue
            }
            if (isInfo) {
              infoIdx += 1
              movingScene = false
              if (missingInfos.has(infoIdx)) movedLines.push(line)
              else keptLines.push(line)
              continue
            }
            if (movingScene && /^\s*[-*+]?\s*(?:心里|心理|念头|回忆|反应|对方反应|位移)\s*[：:]/u.test(line)) {
              movedLines.push(line)
              continue
            }
            movingScene = false
            keptLines.push(line)
          }
          if (movedLines.length) {
            await writeBeats(rootNow(), chapter, keptLines.join('\n').trim())
            const curIdx = chapters.findIndex(item => item.id === chapter.id)
            let nextChapter = curIdx >= 0 && curIdx + 1 < chapters.length ? chapters[curIdx + 1] : null
            if (!nextChapter) {
              const nextId = nextChapterId(chapters)
              nextChapter = {
                id: nextId,
                title: `第 ${Number(nextId)} 章`,
                file: `${CHAPTERS_DIR}/${nextId}.md`,
                status: 'planned',
                targetChars: 0,
              }
              chapters.push(nextChapter)
              await persistBook(rootNow(), { ...meta, chapters }, chapters)
            }
            const nextBeat = await readBeats(rootNow(), nextChapter)
            const nextBody = nextBeat.section && nextBeat.section.body ? `${movedLines.join('\n')}\n${nextBeat.section.body}` : movedLines.join('\n')
            await writeBeats(rootNow(), nextChapter, nextBody)
            carriedOver = {
              nextChapter: { id: nextChapter.id, title: nextChapter.title },
              scenes: missingScenes.size,
              infos: missingInfos.size,
            }
          }
        } else {
          const skipped = gap.missing.map(item => `第 ${item.index} 场「${item.snippet}…」`)
          if (skipped.length) {
            warnings.push(
              `章纲 ${gap.total} 场，有 ${skipped.length} 场未通过字面近似匹配：${skipped.join('、')}。` +
                '这不证明漏写；先对照全文确认是否已换一种表达落地，不为匹配补写、照抄或移动场景。',
            )
          }
          if (infoGap.missing.length) {
            warnings.push(
              `章纲 ${infoList.length} 条「信息」，有 ${infoGap.missing.length} 条未通过字面近似匹配：` +
                infoGap.missing.map(item => `第 ${item.index} 条「${item.snippet}…」`).join('、') +
                '。先核对正文是否已通过动作、对白或其他表达传达，不单凭未匹配就补写或改章纲。',
            )
          }
        }
      }
      // 文风闸门：写完当场比一次节奏。漂移是累积的，指望下一章自己纠回来不现实。
      const fitStyleName = activeStyleName(meta)
      if (fitStyleName) {
        const fitCard = await readStyle(rootNow(), fitStyleName)
        if (fitCard) {
          const fitSample = await readStyleSample(rootNow(), fitStyleName)
          const fit = styleFit(body, fitCard, fitSample && fitSample.present ? fitSample.text : '')
          if (fit.flagged.length) {
            const worst = fit.flagged
              .slice()
              .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
              .slice(0, 3)
              .map(item => `${item.label} ${item.act}（卡上 ${item.ref}）`)
            warnings.push(
              `这一章的节奏偏离文风卡「${fitStyleName}」：${worst.join('；')}。` +
                '这只是统计线索，请结合具体表达判断；不要为降低句号密度拼接长句，也不要为凑密度补动作。只有作者授权改稿且确有表达问题时才修订。',
            )
          }
        }
      }
      if (!reviewed) warnings.push(`【当前版本待复核】章节 ${chapter.id}：${DEAI_WORKFLOW}`)
      return {
        id: chapter.id,
        title: chapter.title,
        file: chapter.file,
        chars,
        target: chapterTarget,
        totalChars: after.totals.chars,
        created,
        status: chapter.status,
        backup,
        ...(carriedOver ? { carriedOver } : {}),
        warnings,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.chapter ? `写入 ${args.chapter}` : '新建一章',
      kind: 'write',
      rawInput: args,
    }),
  })

  registerTool({
    name: 'novel_outline',
    description: '读或写这本书的总纲（工作区根目录的 outline.md）。不传 content 就是读取。',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: '新的总纲全文；省略则只读取现有总纲' } },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { chars: { type: 'integer' }, content: { type: 'string' } },
      },
      render: (_args, value) => textRender(value.content || '（还没有大纲）'),
    },
    execute: async args => {
      const target = path.join(rootNow(), OUTLINE_FILE)
      if (typeof args.content === 'string') {
        await fsp.mkdir(rootNow(), { recursive: true })
        await fsp.writeFile(target, args.content, 'utf8')
      }
      const content = (await readText(target)) ?? ''
      return { chars: countChars(content), content }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.content === undefined ? '读取大纲' : '更新大纲',
      kind: args.content === undefined ? 'read' : 'write',
      rawInput: args,
    }),
  })

  registerTool({
    name: 'novel_style',
    description:
      '文风卡：styles/<名字>.md，一套文风一个文件，book.json 的 style 指向当前在用的那一套。\n' +
      '用户说「克隆这本书的文风」＝一次调用：novel_style({ clone: true, source: 路径 })，插件自己分析、写卡、存原文、启用，不用先分析再手写。\n' +
      '不传参数 = 列出全部文风卡并标出哪一套在用。\n' +
      '给 source（书稿路径，工作区相对或绝对）或 text = 只做分析，返回统计量 + 均匀采样的原文锚点，你据此写卡。\n' +
      '给 sample（参考文本路径）+ name = 分析**并且**把原文存成 styles/<名字>.sample.md，以后随时能回看原文、也能让子代理分块提炼。\n' +
      '书很长（> 1.5 万字）时不要自己硬读：用 subagent 工具把样本按章切开分别提炼（句式、用词、对话处理、意象、禁忌），\n' +
      '子代理只返回结论和逐字锚点候选，你再合成一张卡。样本短就直接分析。\n' +
      '给 name 不给 content = 读这张卡；给 name 且给 content = 写入（覆盖）。\n' +
      '卡的结构（照这个写；「锚点原文」必须是逐字摘录，形容词撑不起文风）：\n' +
      '# 文风卡：<名字>\n- 来源：《书名》<作者>\n- 一句话：<读起来什么感觉>\n- 视角与时态：<第一/第三人称 · 过去/现在>\n' +
      '## 句法\n（多长、怎么断、爱用哪种句式）\n## 用词\n（名词动词的偏好，可引高频词）\n## 对话\n（语气词、对话标签怎么处理）\n' +
      '## 意象\n（反复出现的物、光、声音）\n## 禁忌（不要出现）\n- <3–6 条，novel_check 会照着查；既能写词（氤氲），也能写整句（他拿起笔。）>\n## 锚点原文\n（3–5 段逐字摘录，每段 100–300 字）\n' +
      '【自动克隆只给骨架】clone 生成的卡带有统计量、锚点和自动挑的禁忌，但「规矩」那一节是空的。' +
      '读过锚点后必须自己补这几条，否则模型只学得到句子长度、学不到写法：' +
      '段落单位（一段多少句多少字）/ 短句当重音（一章几处）/ 具体的事不报数字 / 对话标签怎么标 / 旁白能不能下判断 / 过渡与断场用什么词。' +
      '结构范本见插件目录 templates/style-card.md，可用 novel_style({ name: "<名字>", content }) 覆盖写回。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文风卡名字（=文件名）。写卡/读卡时给' },
        content: { type: 'string', description: '整张卡的 Markdown；给了就写入' },
        source: { type: 'string', description: '要分析的书稿文件路径（支持 GBK/UTF-8 的 txt），只分析不存储' },
        sample: { type: 'string', description: '同一份样本，但会和 name 一起被存成 styles/<名字>.sample.md（参考原文，之后可回看）' },
        text: { type: 'string', description: '直接给一段样本文本（不想给文件时用）' },
        saveSample: { type: 'boolean', description: '配合 text 用：把这段文本也存成 styles/<名字>.sample.md' },
        clone: { type: 'boolean', description: 'true = 一条龙克隆：分析样本 + 自动写完整文风卡（锚点、节奏、禁忌都填好）+ 存参考原文 + 启用。用户说「克隆这本书的文风」时直接用它' },
        size: { type: 'integer', description: '每段锚点截多少字，默认 480' },
        active: { type: 'boolean', description: 'true = 写完/读完就把它设为当前在用的文风（写进 book.json 的 style）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          active: { type: 'string' },
          styles: { type: 'array', items: { type: 'object', additionalProperties: true } },
          name: { type: 'string' },
          file: { type: 'string' },
          chars: { type: 'integer' },
          content: { type: 'string' },
          stats: { type: 'object', additionalProperties: true },
          excerpts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          sample: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' } },
          active: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.mode === 'list') {
          const lines = [value.styles.length ? `文风卡 ${value.styles.length} 套${value.active ? `，当前在用「${value.active}」` : '，还没有正在用的（book.json 里没有 style）'}` : '还没有文风卡。给我一本书（novel_style({ source: 路径 })）就能照着它做一套。']
          for (const item of value.styles) {
            lines.push(`- ${item.name}${item.active ? ' ✓ 在用' : ''}（${item.chars} 字${item.sampleChars ? `，参考原文 ${item.sampleChars} 字` : '，没有参考原文'}）${item.summary ? `：${item.summary}` : ''}`)
          }
          return textRender(lines.join('\n'))
        }
        if (value.mode === 'clone') {
          const stats = value.stats
          const parts = [
            `${warnText(value.warnings)}已克隆文风「${value.name}」→ ${value.file}（${value.chars} 字）` +
              (value.active ? `，已设为当前文风。` : `；想启用：novel_style({ name: "${value.name}", active: true })。`),
            `参考原文：${value.sample.file}（${value.sample.chars} 字）`,
            '',
            `平均句长 ${stats.avgSentence} · 平均段长 ${stats.avgParagraph} · 对话占 ${stats.dialogueRatio}% · 高频词 ${stats.words.slice(0, 6).map(item => item.word).join('、')}`,
            `卡里已经写好 ${value.excerpts.length} 段逐字锚点和禁忌词表；${value.voice ? `视角估成「${value.voice}」，不对就改那一行` : '视角没判出来，读过锚点补一句'}`,
            value.active ? '现在 novel_context 会自动带上它，novel_check 会按禁忌查。' : '',
          ].filter(Boolean)
          return textRender(parts.join('\n'))
        }
        if (value.mode === 'analyze') {
          const stats = value.stats
          const parts = [
            `【文风分析】${value.file || '（直接用给的文本）'} · ${stats.chars} 字`,
            `平均句长 ${stats.avgSentence} 字 · 平均段长 ${stats.avgParagraph} 字 · 含引号的段落 ${stats.dialogueRatio}%`,
            `标点密度（每千字）：逗号 ${stats.per1000.comma} · 句号 ${stats.per1000.period} · 省略号 ${stats.per1000.ellipsis} · 破折号 ${stats.per1000.dash} · 分号 ${stats.per1000.semicolon} · 叹号 ${stats.per1000.exclaim} · 问号 ${stats.per1000.question}`,
            `高频双字词：${stats.words.map(item => `${item.word}×${item.count}`).join(' ')}`,
            '',
            `## 原文锚点（${value.excerpts.length} 段，直接抄进卡里）`,
          ]
          value.excerpts.forEach((item, index) => parts.push(`\n### 锚点 ${index + 1}（位于 ${item.at} 处）\n${item.text}`))
          if (value.sample) {
            parts.push(`\n参考原文已存：${value.sample.file}（${value.sample.chars} 字）——卡里只放锚点，原文留在 styles/ 下随时比对；右栏「小说文风」页点「看原文」能看到。`)
            parts.push(`样本很长时别自己硬读：subagent 按章切开分别提炼，再合成卡。`)
          } else {
            parts.push('\n（想把这批原文留档：再调一次，把 source 换成 sample 并带上 name，就会存成 styles/<名字>.sample.md。）')
          }
          parts.push('\n下一步：按上面这些数字和原句写一张卡，然后 novel_style({ name, content }) 写入。')
          return textRender(parts.join('\n'))
        }
        if (value.mode === 'read') {
          return textRender(`${value.active ? `已切到「${value.name}」，之后 novel_context 会自动带上它。\n\n` : ''}${value.content}`)
        }
        return textRender(
          `${warnText(value.warnings)}已写入文风卡「${value.name}」（${value.chars} 字）。` +
            (value.active ? `已设为当前文风，novel_context 会自动带上它。` : `想让它生效：novel_style({ name: "${value.name}", active: true })。`),
        )
      },
    },
    execute: async args => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const content = typeof args.content === 'string' ? args.content : ''
      const source = typeof args.source === 'string' ? args.source.trim() : ''
      const sample = typeof args.sample === 'string' ? args.sample.trim() : ''
      const rawText = typeof args.text === 'string' ? args.text : ''

      const readManuscript = async target => {
        let buffer
        try {
          buffer = await fsp.readFile(target)
        } catch (error) {
          throw new Error(`读不了 ${target}：${error?.message ?? error}`)
        }
        // 32 MB 足够覆盖一本长篇；再大也是同一个文风，多读只是浪费内存。
        if (buffer.length > 32 * 1024 * 1024) buffer = buffer.subarray(0, 32 * 1024 * 1024)
        return decodeManuscript(buffer)
      }

      const analyze = async (raw, file) => {
        const size = clampInt(args.size, STYLE_EXCERPT_CHARS, 100, 2000)
        const stored = name && (sample || args.saveSample) ? await writeStyleSample(rootNow(), name, raw) : null
        return {
          mode: 'analyze',
          file,
          name,
          chars: countChars(raw),
          stats: styleStats(raw),
          excerpts: sampleExcerpts(raw, STYLE_EXCERPTS, size),
          ...(stored ? { sample: { file: stored.file, chars: stored.chars } } : {}),
        }
      }

      if (args.clone) {
        return cloneStyle(rootNow(), {
          name: args.name,
          sample: args.sample,
          source,
          text: rawText,
          size: args.size,
          active: args.active,
        })
      }
      if (content && name) {
        const warnings = validateStyleContent(content)
        const saved = await writeStyle(rootNow(), name, content)
        const activated = args.active ? await activateStyle(rootNow(), saved.name) : ''
        return { mode: 'write', name: saved.name, file: saved.file, chars: saved.chars, warnings, active: activated }
      }
      if (sample) {
        const target = path.isAbsolute(sample) ? sample : path.join(rootNow(), sample)
        return await analyze(await readManuscript(target), path.basename(target))
      }
      if (name && args.active) {
        const activated = await activateStyle(rootNow(), name)
        const text = await readStyle(rootNow(), name)
        if (text === null) throw new Error(`没有文风卡「${name}」；给 name + content 就能写一张`)
        return { mode: 'read', name, chars: countChars(text), content: text, active: activated }
      }
      if (name && !source && !rawText) {
        const text = await readStyle(rootNow(), name)
        if (text === null) throw new Error(`没有文风卡「${name}」；给 name + content 就能写一张`)
        return { mode: 'read', name, chars: countChars(text), content: text }
      }
      if (source) {
        const target = path.isAbsolute(source) ? source : path.join(rootNow(), source)
        return await analyze(await readManuscript(target), path.basename(target))
      }
      if (rawText) return await analyze(rawText, '')
      const { meta } = await loadBook(rootNow())
      const items = await listStyles(rootNow())
      const active = activeStyleName(meta)
      return {
        mode: 'list',
        active,
        styles: items.map(item => ({ name: item.name, chars: item.chars, sampleChars: item.sampleChars, summary: item.summary, active: item.name === active })),
      }
    },
    presentCall: args => ({ card: 'generic', title: '文风卡', kind: args.content ? 'write' : 'read', rawInput: args }),
  })

  registerTool({
    name: 'novel_stage_edit',
    description: '局部编辑章纲：先读取 novel_context 获得 stage.baseHash。提供 chapter、可选 scene/character、baseHash 和 fields。只更新指定对象的字段，保留其他人物、未知字段和正文。心理与登场字段：' + ROLE_FIELDS.join('、') + '。' + PRESENTATION_RULES,
    parameters: { type: 'object', additionalProperties: false, required: ['chapter', 'baseHash', 'fields'], properties: { chapter: { type: 'string' }, scene: { type: 'string' }, character: { type: 'string' }, baseHash: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textRender(JSON.stringify(value)) },
    execute: async args => editStageFields(rootNow(), args),
    presentCall: args => ({ card: 'generic', title: '编辑章纲字段', kind: 'write', rawInput: args }),
  })

  registerTool({
    name: 'novel_move_scene',
    description: '将完整场景及人物约束移动到目标章节末尾，保留场景 ID 和故事时序；原位置认知记录失效，需重新核对。需要调整故事时间时再编辑章纲。',
    parameters: { type: 'object', additionalProperties: false, required: ['scene', 'chapter'], properties: { scene: { type: 'string' }, chapter: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textRender(JSON.stringify(value, null, 2)) },
    execute: async args => moveScene(rootNow(), (await loadBook(rootNow())).meta.chapters, args.scene, args.chapter),
    presentCall: args => ({ card: 'generic', title: '整场顺延', kind: 'write', rawInput: args }),
  })

  registerTool({
    name: 'novel_character_history',
    description: '人物认知与有向关系历史。inspect 查看；propose 提交正文提取候选（character/scene 为稳定 ID，kind 为已知/未知/误信/怀疑/关系/状态/呈现，content 内容、source 信息来源、evidence 逐字正文引文；关系必填 target，可给 event、supersedes）。confirm 需 character+id，仅在核对正文且作者确认或已授权核对流程后调用；revoke 撤销。计划不能直接确认为事实。来源改变需重新提取。',
    parameters: historyParameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textRender(JSON.stringify(value, null, 2)) },
    execute: async args => updateHistory(rootNow(), (await loadBook(rootNow())).meta.chapters, args),
    presentCall: args => ({ card: 'generic', title: '人物认知历史', kind: !args.action || args.action === 'inspect' ? 'read' : 'write', rawInput: args }),
  })

  registerTool({
    name: 'novel_preflight',
    description: '只读资料预检：生成或改写前区分正文、声明规则、人物资料、表达约束、剧情计划与历史备忘；列出章纲和文风的字面候选、待模型对照的语义要求及本章备忘。候选不等于确认矛盾，不修改材料，不自动裁定哪个来源正确。',
    parameters: { type: 'object', additionalProperties: false, properties: { chapter: { type: 'string', description: '已登记章节的 id 或标题' } }, required: ['chapter'] },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string' }, certifiesConsistency: { type: 'boolean' }, literalCandidates: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      render: (_args, value) => textRender(renderMaterialPreflight(value)),
    },
    execute: async args => {
      const root = rootNow()
      const { meta } = await loadBook(root)
      const chapter = findChapter(meta.chapters, args.chapter)
      if (!chapter) throw new Error(`找不到章节「${args.chapter}」，请先核对章节清单`)
      return await materialPreflight(root, chapter, { styleName: activeStyleName(meta) })
    },
    presentCall: args => ({ card: 'generic', title: `资料预检 ${args.chapter}`, kind: 'read', rawInput: args }),
  })

  registerTool({
    name: 'novel_context',
    description:
      '续写前的标准动作：先做只读资料预检，再装配章纲、上章结尾、人物卡和伏笔。先核对章纲与文风的候选冲突，区分计划和历史备忘，不要求照抄计划原句。总长度受上下文 budget 限制，不限制正文长度。',
    parameters: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '稳定场景 ID；只装配该场的角色状态和章纲' },
        chapter: { type: 'string', description: '要写的章 id 或标题；省略则取第一个未写的章（没有就取下一章）' },
        budget: { type: 'integer', description: '本次上下文提示的 Unicode 字符上限（含空白、标题、指令，非 token），续写默认 12000、改写 16000，最多 40000；不限制正文字数' },
        rewriteStart: { type: 'integer', minimum: 0, description: '局部改写起点，Unicode 字符索引；提供后只装配该片段，保存必须 mode:patch' },
        rewriteLimit: { type: 'integer', minimum: 1, description: '局部改写字符数，默认 1000；下一段须重新获取上下文' },
        mode: {
          type: 'string',
          enum: ['continue', 'rewrite'],
          description: 'continue（默认）＝续写下一章；rewrite＝改写已写过的这一章：会额外把这章现有正文一起带回来，文风锚点配额也放大',
        },
        pass: {
          type: 'string',
          enum: ['deai'],
          description: 'deai＝「去 AI 味」：额外带上改写纪律，并附本章检测到的 AI 腔清单。通常配合 mode: "rewrite"',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          chapter: { type: 'object', additionalProperties: true },
          beats: { type: 'object', additionalProperties: true },
          outline: { type: 'string' },
          prevTail: { type: 'object', additionalProperties: true },
          characters: { type: 'array', items: { type: 'object', additionalProperties: true } },
          settings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          threads: { type: 'array', items: { type: 'object', additionalProperties: true } },
          style: { type: 'object', additionalProperties: true },
          mode: { type: 'string' },
          chapterText: { type: 'string' },
          settingsCount: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
          spine: { type: 'array', items: { type: 'object', additionalProperties: true } },
          pass: { type: 'string' },
          rewriteRules: { type: 'string' },
          aiTone: { type: 'array', items: { type: 'object', additionalProperties: true } },
          budgetUsed: { type: 'integer' },
          materialPreflight: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => textRender(value.prompt),
    },
    execute: async args => {
      if (args.mode !== 'rewrite' && (args.rewriteStart !== undefined || args.rewriteLimit !== undefined)) throw new Error('分段参数仅用于 rewrite 模式')
      if (args.rewriteLimit !== undefined && args.rewriteStart === undefined) throw new Error('rewriteLimit 需要同时提供 rewriteStart')
      const { meta } = await loadBook(rootNow())
      const chapters = []
      for (const chapter of meta.chapters) chapters.push(await chapterStats(rootNow(), chapter, meta.targetChars))

      let index = -1
      if (args.chapter) {
        const found = findChapter(chapters, args.chapter)
        if (!found) throw new Error(`找不到章节 "${args.chapter}"；先调用 novel_status 看有哪些章`)
        index = chapters.findIndex(item => item.id === found.id)
      } else {
        index = chapters.findIndex(item => item.chars === 0)
        if (index < 0) index = chapters.length
      }

      const current = index < chapters.length
        ? chapters[index]
        : { id: nextChapterId(chapters), title: `第 ${Number(nextChapterId(chapters))} 章`, chars: 0, target: meta.targetChars, status: 'planned' }

      // 续写也要完整带上文风锚点与设定细节：默认 12000，改写 16000（用户反馈 5000 装不下章纲+人物+文风）。
      const budget = clampInt(args.budget, args.mode === 'rewrite' ? 16000 : 12000, 300, 40000)
      const prev = chapters.slice(0, index).reverse().find(item => item.chars > 0)
      const prevText = prev ? (await readText(path.join(rootNow(), prev.file))) ?? '' : ''
      const prevTailText = tail(prevText, Math.max(300, Math.min(800, Math.round(budget * 0.3))))

      const outlineText = (await readText(path.join(rootNow(), OUTLINE_FILE))) ?? ''
      const outlinePart = outlineExcerpt(outlineText, current, Math.max(200, Math.min(900, Math.round(budget * 0.35))))

      // 章纲优先：有这一章的 beats 就按清单配额给它，大纲退成背景参考。
      const beats = await readBeats(rootNow(), current)
      const stage = await stageContext(rootNow(), meta.chapters, current.id, args.scene)
      const beatsText = args.scene ? stage.scenes[0].raw : (beats.section?.body || '')
      const sceneText = `${beatsText}\n${outlinePart}`

      // 节奏：把本章章纲上的爽点/钩子标记算出来，顺便看前面断了几章。
      const marks = beats.section ? beats.section.marks : { payoff: [], hook: 0, turn: 0 }
      let gapBefore = 0
      const chapterIndex = meta.chapters.findIndex(item => item.id === current.id)
      for (let i = chapterIndex - 1; i >= 0; i -= 1) {
        const section = matchBeatSection(beats.sections, meta.chapters[i])
        if (!section || section.chars === 0) continue
        if ((section.marks?.payoff.length ?? 0) > 0) break
        gapBefore += 1
      }
      const rhythm = {
        present: Boolean(beats.section && beats.section.chars > 0),
        payoff: marks.payoff.map(item => item.label || '爽点'),
        hook: marks.hook > 0,
        turn: marks.turn,
        gapBefore,
      }

      // 事件线：这一章该推进哪几条（区间给默认，章纲锚点做修正）。
      // 装配时把「因为 / 所以」带上，模型才知道这一章要交代因果，而不是把情节填满。
      const eventBoard = await readEvents(rootNow())
      const spineLookup = []
      for (const eventLine of eventBoard.lines) {
        for (const event of eventLine.events) spineLookup.push({ ...event, lineId: eventLine.id, lineName: eventLine.name })
      }
      const anchorIds = beats.section && Array.isArray(beats.section.events) ? beats.section.events : []
      const spine = []
      for (const event of spineLookup) {
        const inRange = event.from !== '' && current.id >= event.from && current.id <= event.to
        const anchored = anchorIds.includes(event.id)
        if (!inRange && !anchored) continue
        spine.push({
          id: event.id,
          line: event.lineName || event.lineId,
          title: event.title,
          because: event.because,
          so: event.so,
          anchored,
        })
      }

      // 出场人选的判定：先看上一章结尾里提到了谁，再看本章大纲里提到了谁；
      // 命中不足 3 张时用其他卡补齐（叙述者往往不会被点名，但一定得出场）。
      const cards = await listCharacters(rootNow())
      const picked = []
      for (const card of cards) {
        if (mentions(prevTailText, card.name) || mentions(sceneText, card.name)) picked.push(card)
      }
      for (const card of cards) {
        if (picked.length >= 3) break
        if (!picked.includes(card)) picked.push(card)
      }
      const characters = []
      const castIds = new Set(stage.scenes.flatMap(scene => scene.cast))
      const ordered = (stage.scenes.length ? cards.filter(card => castIds.has(card.id)) : picked.slice(0, 5)).sort((a, b) => (a.rank || 9) - (b.rank || 9))
      for (const card of ordered) {
        const content = await readCharacter(rootNow(), card.name)
        const state = stateAt(card.states, current.id)
        if (content !== null) {
          characters.push({
            name: card.name,
            state: state ? { chapter: state.chapter, label: state.label, dead: state.dead } : null,
            role: card.role || '',
            rank: card.rank || 9,
            hook: card.hook || '',
            content: '作者侧稳定设定（不等于人物当前已知；当前认知以场景历史为准）：\n' + content.trim(),
          })
        }
      }

      const threads = await loadThreads(rootNow())
      const currentId = String(current.id)
      const threadRows = threads.rows
        .filter(item => item.open && (item.payoff === '' || item.payoff >= currentId))
        .slice(0, 10)
        .map(item => ({ thread: item.thread, planted: item.planted, payoff: item.payoff }))

      // 相关设定：只在被正文/章纲/大纲点名时才带，避免把整本世界观灌进上下文。
      const settingItems = await listSettings(rootNow())
      const settingHits = []
      const matchesSetting = (haystack, name) => {
        if (mentions(haystack, name)) return true
        const parts = String(name ?? '').split(/[·・、/／与和及\-_\s]+/u).filter(part => part.length >= 2)
        return parts.some(part => mentions(haystack, part))
      }
      for (const item of settingItems) {
        if (matchesSetting(prevTailText, item.name) || matchesSetting(sceneText, item.name)) settingHits.push(item)
      }
      const settings = []
      const voided = []
      for (const item of settingHits.slice(0, 4)) {
        const content = await readSetting(rootNow(), item.name)
        if (content !== null && SETTING_VOID_RE.test(content)) {
          voided.push(item.name)
          continue
        }
        if (content !== null) settings.push({ name: item.name, category: item.category, content: content.trim() })
      }

      // 设定是「当下用不到」的那一类，模型最容易把它写成 outline 里的散文。这里主动拦一道。
      const contextWarnings = []
      if (settingItems.length === 0) {
        contextWarnings.push(
          '这本书还没有任何设定条目（settings/ 是空的）：地名、规矩、物品、术语先用 novel_setting 建条目，只写在 outline.md 里等于没建。',
        )
      }

      // 文风：book.json 里 style 指向的那一套。形容词不够用，锚点原文和禁忌要一起进来，
      // 否则模型只会照着章纲把「信息」写全，写出来却不像这本书。
      const styleName = activeStyleName(meta)
      const styleRaw = styleName ? await readStyle(rootNow(), styleName) : null
      // 改写时句子要「像」，锚点配额给得更大：卡里真正管用的是锚点，不是摘要。
      const rewrite = args.mode === 'rewrite'
      const styleBudget = rewrite
        ? Math.max(800, Math.min(3000, Math.round(budget * 0.6)))
        : Math.max(1100, Math.min(2800, Math.round(budget * 0.6)))
      const styleAssembly = assembleStylePrompt(styleRaw, styleBudget)
      const styleText = styleAssembly.text

      // 改写模式要带回这一章现有的正文：没有它，「按文风重写」就变成「重新写一遍」。
      let chapterText = ''
      let rawChapter = ''
      if (current.file) {
        rawChapter = (await readText(path.join(rootNow(), current.file))) ?? ''
        if (rewrite) chapterText = rawChapter
      }
      // 「去 AI 味」：带上改写纪律 + 本章能指认的 AI 腔清单（检测在宿主算，省得模型自己数）。
      const deai = args.pass === 'deai'
      const tone = deai && rawChapter ? detectAiTone(rawChapter) : { signals: [], total: 0 }

      const selected = rewriteSelection(rawChapter, args.rewriteStart, args.rewriteLimit)
      if (rewrite) chapterText = selected.text
      const preflight = await materialPreflight(rootNow(), current, { beatsText, styleName, styleText: styleRaw ?? '' })
      return assembleNovelContext({
        chapter: { id: current.id, title: current.title, target: current.target ?? meta.targetChars, status: current.status },
        beats: { present: Boolean(beats.section), heading: beats.section ? beats.section.heading : '', text: beatsText, infos: beats.section?.infos ?? [], interiors: beats.section?.interiors ?? [], cognition: beats.section?.cognition ?? [] },
        rhythm,
        stage,
        spine,
        outline: outlinePart,
        prevTail: prev ? { id: prev.id, title: prev.title, text: prevTailText } : { id: '', title: '', text: '' },
        characters,
        settings,
        threads: threadRows,
        style: { name: styleName, present: Boolean(styleText), ...styleAssembly },
        mode: rewrite ? 'rewrite' : 'continue',
        chapterText,
        settingsCount: settingItems.length,
        warnings: [...contextWarnings, ...stage.warnings],
        pass: deai ? 'deai' : '',
        rewriteRules: `${DEAI_RULES}\n\n${DEAI_WORKFLOW}`,
        aiTone: deai ? tone.signals : [],
        rewriteScope: selected.scope,
        materialPreflight: preflight,
      }, budget)
    },
    presentCall: args => ({ card: 'generic', title: '取上下文装配包', kind: 'read', rawInput: args }),
  })

  registerTool({
    name: 'novel_card',
    description: '人物卡：name 读取；name+content 覆盖；不传参列出。顶部必填 - ID：稳定英文ID、- 定位：男主/女主/男二/女二/重要配角/反派等、- 重要程度：核心/重要/一般/临时。记录身份、长期目标、外貌锚点、性格（第一反应/底线）、说话习惯。作者秘密放 ## 作者侧秘密。人物 ID 不随姓名改变，出场与关系使用 ID 引用。动态认知、关系与成长用 novel_character_history 记录来源和生效场景，不用全局卡覆盖历史。格式参考 templates/character-card.md。' + PRESENTATION_RULES,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '人物名（也是文件名）；省略则列出全部' },
        content: { type: 'string', description: '这张卡的全文（Markdown）；给了就写入' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          name: { type: 'string' },
          characters: { type: 'array', items: { type: 'object', additionalProperties: true } },
          content: { type: 'string' },
          chars: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.mode === 'list') {
          return textRender(
            value.characters.length
              ? `人物卡 ${value.characters.length} 张：\n` + value.characters.map(item => `- ${item.name}：${item.summary || '（无简介）'}`).join('\n')
              : '（还没有人物卡。写一张：novel_card({ name: "林小满", content: "# 林小满\\n..." })）',
          )
        }
        if (value.mode === 'write') return textRender(`已写入人物卡「${value.name}」，${value.chars} 字。${warnText(value.warnings)}`)
        return textRender(value.content || '（这张卡还是空的）')
      },
    },
    execute: async args => {
      if (!args.name) {
        return { mode: 'list', characters: await listCharacters(rootNow()) }
      }
      if (typeof args.content === 'string') {
        const written = await writeCharacter(rootNow(), args.name, args.content)
        return { mode: 'write', name: written.name, chars: written.chars, warnings: validateCardContent(args.content) }
      }
      const content = await readCharacter(rootNow(), args.name)
      if (content === null) throw new Error(`没有人物卡「${args.name}」；先 novel_card({ name: "${args.name}", content: "..." }) 建一张`)
      return { mode: 'read', name: args.name, content, chars: countChars(content) }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.name ? (typeof args.content === 'string' ? `写人物卡 ${args.name}` : `读人物卡 ${args.name}`) : '列出人物卡',
      kind: typeof args.content === 'string' ? 'write' : 'read',
      rawInput: args,
    }),
  })

  // ---- 设定（世界观条目）--------------------------------------------------
  registerTool({
    name: 'novel_setting',
    description:
      '维护世界观设定（工作区 settings/ 目录，一个条目一个 .md，比如地点、规矩、物品、术语）。不传参数 = 列出所有设定；给 name 不给 content = 读这条；给 name 且给 content = 写这条。写第 N 章前用 novel_context，它会自动带上有提到的设定。给 name 且 delete: true = 删除这条（挪进 settings/.trash/，不硬删，能捞回来）。' +
      '\n\n【格式约定】首行写 `- 分类：地点|规矩|物品|术语|组织|历史|其他`（右栏会显示成徽标）；正文开头第一句当摘要（别超过 60 字）。设定按「一个可被点名的东西一条」拆开写——写第 3 章需要的是「账册」这一条，不是整本世界观。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '设定名（也是文件名，如「雾港的规矩」）；省略则列出全部' },
        content: { type: 'string', description: '这条设定的全文（Markdown，可含「- 分类：地点」一行）；给了就写入' },
        delete: { type: 'boolean', description: 'true = 删除这条设定（挪进 settings/.trash/）' },
        status: { type: 'string', enum: ['active', 'deprecated'], description: 'deprecated = 标成作废（留文件、不再进装配包）；active = 恢复' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          name: { type: 'string' },
          settings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          content: { type: 'string' },
          chars: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.mode === 'status') {
          return textRender(
            value.status === 'deprecated'
              ? `「${value.name}」已标成作废：文件还在 settings/，但不再进装配包。恢复：novel_setting({ name: "${value.name}", status: "active" })。`
              : `「${value.name}」已恢复启用。`,
          )
        }
        if (value.mode === 'delete') {
          return textRender(`已删除设定「${value.name}」，挪到了 ${value.file}（没硬删，要恢复就把它挪回 settings/）。`)
        }
        if (value.mode === 'list') {
          return textRender(
            value.settings.length
              ? `设定 ${value.settings.length} 条：\n` +
                  value.settings
                    .map(item => `- ${item.name}${item.category ? `（${item.category}）` : ''}：${item.summary || '（无摘要）'}`)
                    .join('\n')
              : '（还没有设定。写一条：novel_setting({ name: "雾港的规矩", content: "- 分类：规矩\\n..." })）',
          )
        }
        if (value.mode === 'write') return textRender(`已写入设定「${value.name}」，${value.chars} 字。${warnText(value.warnings)}`)
        return textRender(value.content || '（这条设定还是空的）')
      },
    },
    execute: async args => {
      if (!args.name) {
        if (args.delete === true) throw new Error('删除设定要给 name（删哪一条）')
        return { mode: 'list', settings: await listSettings(rootNow()) }
      }
      if (args.delete === true) {
        const existing = await readSetting(rootNow(), args.name)
        if (existing === null) throw new Error(`没有设定「${args.name}」`)
        const removed = await deleteSetting(rootNow(), args.name)
        return { mode: 'delete', name: removed.name, file: removed.file, deleted: true }
      }
      if (args.status === 'active' || args.status === 'deprecated') {
        const existing = await readSetting(rootNow(), args.name)
        if (existing === null) throw new Error(`没有设定「${args.name}」`)
        const changed = await setSettingStatus(rootNow(), args.name, args.status)
        return { mode: 'status', name: changed.name, status: changed.status, chars: changed.chars }
      }
      if (typeof args.content === 'string') {
        const written = await writeSetting(rootNow(), args.name, args.content)
        return { mode: 'write', name: written.name, chars: written.chars, warnings: validateSettingContent(args.content) }
      }
      const content = await readSetting(rootNow(), args.name)
      if (content === null) throw new Error(`没有设定「${args.name}」；先 novel_setting({ name: "${args.name}", content: "..." }) 建一条`)
      return { mode: 'read', name: args.name, content, chars: countChars(content) }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.delete === true ? `删除设定 ${args.name}` : args.name ? (typeof args.content === 'string' ? `写设定 ${args.name}` : `读设定 ${args.name}`) : '列出设定',
      kind: args.delete === true ? 'delete' : typeof args.content === 'string' ? 'write' : 'read',
      rawInput: args,
    }),
  })

  // ---- 伏笔表 ---------------------------------------------------------------
  registerTool({
    name: 'novel_threads',
    description:
      '伏笔表（工作区 threads.md，一张四列表格）。不给参数 = 列出全部伏笔，并标出「计划回收章已经到了、但还没收」的；给 thread + planted = 登记一条新的；再给 payoff / status = 更新那一条（收回了就把 status 写 done，或写上回收章 id）。' +
      '\n\n【格式约定·表头固定四列】' +
      '\n| 伏笔 | 埋设 | 回收 | 状态 |' +
      '\n| 投币箱里多出的硬币 | 0001 | 0004 | open |' +
      '\n埋设 / 回收写四位章 id；「回收」是**计划**回收章。状态留空 = open（埋了还没收），收掉了才写 done 或 closed。' +
      '\n一条伏笔一行，别散着写进正文或人物卡；埋了就登记，写不到计划回收章那就要么收掉、要么把这个计划改掉。',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: '伏笔的一句话描述（同时是这一行的键；已存在就更新它）' },
        planted: { type: 'string', description: '埋设章（四位章 id，如 0003）' },
        payoff: { type: 'string', description: '计划回收的章（四位章 id）；不打算回收就留空' },
        status: { type: 'string', enum: ['open', 'done', 'closed'], description: 'open 埋了没收 / done、closed 已收回' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          thread: { type: 'string' },
          row: { type: 'object', additionalProperties: true },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          latest: { type: 'string' },
          replaced: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const line = item =>
          `- ${item.thread}（${item.planted || '?'} 埋` +
          (item.payoff ? ` · 计划 ${item.payoff} 收` : ' · 未定回收章') +
          (item.status && item.status !== 'open' ? ` · ${item.status}` : '') +
          '）' +
          (item.due ? ' ← 到期还没收' : '')
        if (value.mode === 'write') {
          const row = value.row
          return textRender(
            `${value.replaced ? '已更新' : '已登记'}伏笔「${value.thread}」${row ? `（${row.planted || '?'} 埋${row.payoff ? ` · 计划 ${row.payoff} 收` : ''} · ${row.status}）` : ''}。${warnText(value.warnings)}`,
          )
        }
        const open = value.rows.filter(item => item.open)
        const closed = value.rows.filter(item => !item.open)
        const out = [`【伏笔】未回收 ${open.length} 条 · 已回收 ${closed.length} 条` + (value.latest ? `（已写到 ${value.latest}）` : '')]
        if (!value.rows.length) out.push('（还没有伏笔。登记一条：novel_threads({ thread: "怀表", planted: "0001", payoff: "0004" })）')
        if (open.length) {
          out.push('', '未回收：')
          for (const item of open) out.push(line(item))
        }
        if (closed.length) {
          out.push('', '已回收：')
          for (const item of closed) out.push(line(item))
        }
        const due = open.filter(item => item.due)
        if (due.length) out.push('', `⚠ 有 ${due.length} 条到了计划回收章还没收：${due.map(item => item.thread).join('、')}`)
        return textRender(out.join('\n'))
      },
    },
    execute: async args => {
      const hasThread = typeof args.thread === 'string' && args.thread.trim()
      if (!hasThread) {
        const threads = await loadThreads(rootNow())
        const { meta } = await loadBook(rootNow())
        const stats = []
        for (const chapter of meta.chapters) stats.push(await chapterStats(rootNow(), chapter, meta.targetChars))
        const latest = latestWrittenId(stats.filter(item => item.written))
        return { mode: 'list', rows: decorateThreads(threads.rows, latest), latest }
      }
      const written = await writeThread(rootNow(), {
        thread: args.thread,
        planted: typeof args.planted === 'string' ? args.planted : undefined,
        payoff: typeof args.payoff === 'string' ? args.payoff : undefined,
        status: typeof args.status === 'string' ? args.status : undefined,
      })
      return {
        mode: 'write',
        thread: written.thread,
        row: written.row,
        rows: written.rows,
        replaced: written.replaced,
        warnings: validateThreadPatch(args),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.thread ? `伏笔 ${args.thread}` : '列出伏笔',
      kind: args.thread ? 'write' : 'read',
      rawInput: args,
    }),
  })

  // ---- 自检（只报告，不改文件）--------------------------------------------
  registerTool({
    name: 'novel_check',
    description:
      '写完后做机械自检（不联网、不改文件）：旧称、未登记说话人、重复句、标点、长度、文风与默认开启的 AI 腔线索。按章读取时同时检查当前正文的模型审稿记录，不认证动作可行性或语义自然度。近似统计仅作非阻塞提示。作者只要求检查时，不得为清除提示自行调用写入工具改正文。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '章节 id 或标题；给了就读这一章的文件来查' },
        text: { type: 'string', description: '直接查这段文本（给了 text 就不读文件）' },
        aiTone: { type: 'boolean', description: '默认开启，false 仅关闭机械线索检测；不跳过当前版本语义复核。命中是待审线索，不是 AI 写作判定。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '仅表示已实现的校验无待处理项，不表示文章获得语义或质量认证' },
          runtime: { type: 'object', additionalProperties: false, properties: { revision: { type: 'string' }, moduleFile: { type: 'string' } } },
          workspaceRoot: { type: 'string' },
          mechanicalOk: { type: 'boolean', description: '仅表示本次机械检查是否有待处理项，不表示语义正确' },
          deaiReview: { type: 'object', additionalProperties: true, description: '模型审稿记录：pending 待登记，blocked 有矛盾或依据不足，recorded 已有有效记录，untracked 为直接检查文本；不提供自动语义通过认证' },
          heuristicNotes: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '非阻塞统计线索；不能据此自动补动作、改台词或合并句子' },
          chars: { type: 'integer' },
          target: { type: 'integer' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string' },
                detail: { type: 'string' },
                count: { type: 'integer' },
                samples: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'detail'],
            },
          },
        },
        required: ['ok', 'chars', 'issues'],
      },
      render: (_args, value) => {
        const review = value.styleReview
        const reviewLines = [
          ...(value.runtime ? [`宿主修订：${value.runtime.revision}；插件文件：${value.runtime.moduleFile}；书稿工作区：${value.workspaceRoot}`] : []),
          ...(value.deaiReview ? [renderReviewStatus(value.deaiReview.status, value.deaiReview.findings ?? [])] : []),
          ...(value.deaiReview?.checkVerdicts ? ['六维实际登记值：' + Object.entries(value.deaiReview.checkVerdicts).map(([aspect, verdict]) => `${aspect}: ${verdict}`).join('；')] : []),
          ...(value.deaiReview ? [value.deaiReview.detail] : []),
          ...(value.aiToneReview ? [`已纳入当前版本语义复核的机械线索（${value.aiToneReview.total} 处）：`, ...value.aiToneReview.signals.map(item => `${item.label}：${item.samples.join(' / ')}`)] : []),
          ...(value.heuristicNotes ?? []).map(item => `非阻塞线索 [${item.kind}] ${item.detail}`),
          ...(review ? [
            ...review.warnings.map(item => `格式提醒：${item}`),
            ...(review.limitedCount ? [`少用词命中 ${review.limitedCount} 处（仅提醒，不判违规）：`, ...review.limited] : []),
            ...(review.semantic.length ? ['语义禁忌待会话 AI 复核（尚未判定）：', ...review.semantic] : []),
          ] : []),
        ]
        const semanticCount = value.issues.filter(item => item.kind.startsWith('semantic-') || item.kind === 'deai-review-pending').length
        reviewLines.push(...(value.presentationReview || []).map(item => `表现安排待核对（非错误） ${item.scene}/${item.character}：${item.detail}`))
        const categories = new Map()
        for (const item of value.issues.filter(item => !item.kind.startsWith('semantic-') && item.kind !== 'deai-review-pending')) categories.set(item.kind, (categories.get(item.kind) ?? 0) + 1)
        const heading = `机械及资料待处理 ${value.issues.length - semanticCount} 项；审稿阻塞 ${value.deaiReview?.findings?.length ?? 0} 项；待登记提示 ${value.issues.filter(item => item.kind === 'deai-review-pending').length} 项；非阻塞线索 ${(value.heuristicNotes ?? []).length} 项（${value.chars} 字${value.target ? `，参考 ${value.target}` : ''}）。本工具不自动判定语义通过。`
        if (categories.size) reviewLines.push('机械及资料计数（按返回条目计，不是正文错误数）：' + [...categories].map(([kind, count]) => `${kind}: ${count}`).join('；'))
        if (!value.issues.length) return textRender([heading, ...reviewLines, '机械零命中与审稿登记均不代表语义结论一定正确。'].join('\n'))
        const lines = [heading]
        for (const issue of value.issues) {
          lines.push(`- [${issue.kind}] ${issue.detail}`)
          for (const sample of issue.samples ?? []) lines.push(`    · ${sample}`)
        }
        lines.push(...reviewLines)
        return textRender(lines.join('\n'))
      },
    },
    execute: async args => {
      const { meta } = await loadBook(rootNow())
      let text = typeof args.text === 'string' ? args.text : ''
      let chapter
      if (typeof args.chapter === 'string' && args.chapter.trim()) {
        chapter = findChapter(meta.chapters, args.chapter)
        if (!chapter) throw new Error(`没有这一章「${args.chapter}」；先 novel_status 看章节 id`)
        if (typeof args.text !== 'string') text = (await readText(path.join(rootNow(), chapter.file))) ?? ''
      }
      const cards = []
      for (const card of await listCharacters(rootNow())) {
        cards.push({ name: card.name, content: (await readCharacter(rootNow(), card.name)) ?? '' })
      }
      const target = chapter ? chapter.target || meta.targetChars : meta.targetChars
      // 占位梗概不是正文：这时候报「字数不够」和「章纲没落地」都是噪音，先说真正的那件事。
      if (isPlaceholderText(text)) {
        return {
          ok: false,
          chars: countChars(text),
          target,
          issues: [
            {
              kind: 'placeholder',
              detail:
                '这一章还是「（待写）」占位（只有梗概），不算正文：先用 novel_context({ chapter, mode: "continue" }) 拿装配包，把它写成真正的章节，再来自查。',
            },
          ],
        }
      }
      const report = inspectText(text, { cards, target })
      report.runtime = { revision: PLUGIN_REVISION, moduleFile: fileURLToPath(import.meta.url) }
      report.workspaceRoot = rootNow()
      if (chapter) {
        const stage = await stageContext(rootNow(), meta.chapters, chapter.id)
        report.presentationReview = stage.reviews
        report.issues.push(...stage.warnings.map(detail => ({ kind: 'stage-reference', detail })))
        for (const scene of stage.scenes) for (const person of scene.characters) if (person.gap) report.issues.push({ kind: 'stage-history-gap', detail: `${scene.id}/${person.name}：${person.gap}` })
      }
      report.heuristicNotes = []
      const chapterReview = chapter && typeof args.text !== 'string'
      const reviewState = chapterReview ? await deaiReviewState(rootNow(), chapter, text, meta) : { status: 'untracked', findings: [] }
      const recorded = reviewState.status === 'recorded'
      report.deaiReview = {
        status: reviewState.status,
        certifiesSemantics: false,
        findings: reviewState.findings,
        // 待审稿/直接查文本时没有六维结论：这里必须落成 null，不能是 undefined 键，
        // 否则工具结果过不了宿主的无损 JSON 校验（宿主报 invalid output: value is not lossless JSON）。
        checkVerdicts: reviewState.checkVerdicts ?? null,
        evidenceContexts: reviewState.evidenceContexts ?? [],
        timingReports: reviewState.timingReports ?? [],
        detail: chapterReview
          ? recorded ? '模型判断已登记，当前无已登记阻塞项；引用与时间记账可校验，动作是否可行、文章是否自然未获自动认证。' : reviewState.status === 'blocked' ? '当前记录存在矛盾、依据不足或工具校验阻塞项。' : '当前正文或引用资料已变化，或尚无有效记录，待会话重新审稿。'
          : '本次直接检查文本，仅报告机械线索，未核验章节语义复核。',
      }
      report.issues.unshift(...reviewState.findings.map(item => ({ kind: `semantic-${item.verdict}`, detail: `[${item.aspect}] ${item.detail}`, samples: item.evidence.map(reference => `${reference.source}${reference.name ? ':' + reference.name : ''}${reference.index ? ' #' + reference.index : ''}：${reference.quote}`) })))
      report.heuristicNotes.push(...(reviewState.preferenceNotes ?? []).map(item => ({ kind: 'editorial-preference', detail: `[${item.aspect}] ${item.detail}`, samples: item.evidence.map(reference => reference.quote) })))
      if (chapterReview && reviewState.status === 'pending') {
        report.issues.push({ kind: 'deai-review-pending', detail: `当前正文版本尚未登记完整语义复核。${DEAI_WORKFLOW}` })
      }
      if (args.aiTone !== false) {
        const tone = detectAiTone(text)
        if (tone.signals.length > 0 && recorded) report.aiToneReview = tone
        if (tone.signals.length > 0 && !recorded) {
          report.issues.push({
            kind: 'ai-tone',
            detail:
              `读到 ${tone.signals.length} 类「AI 腔」（共 ${tone.total} 处）：` +
              `${tone.signals.map(item => `${item.label}×${item.count}`).join('；')}。` +
              '这些是待人工判断的线索；结合全文、人物声口和文风样本决定是否修改，正常表达可保留并说明理由。用 novel_deai_pack 获取全文，只修有问题的片段。',
            count: tone.total,
            samples: tone.signals.slice(0, 4).map(item => `[${item.label}] ${(item.samples[0] ?? '').slice(0, 60)}`),
          })
        }
      }
      if (!meta.targetCharsSet) {
        const lengthIssue = report.issues.find(item => item.kind === 'length')
        if (lengthIssue) {
          lengthIssue.detail +=
            `（这个目标 ${meta.targetChars} 字是插件的默认值，book.json 里没写 targetChars；` +
            '如果大纲里说了篇幅，用 novel_book({ targetChars }) 定下来）'
        }
      }
      // 有章纲就再对一遍：这一步以前没做，结果模型写了三条 beat 就收笔，章纲第 4、5 场没人发现。
      const beat = await readBeats(rootNow(), chapter ?? null)
    const beatBody = beat && beat.section ? String(beat.section.body ?? '') : ''
    if (beatBody) {
      const beatLines = beatBody.split(/\r?\n/u)
      const reactions = beat && beat.section && Array.isArray(beat.section.reactions) ? beat.section.reactions : []
      for (let index = 0; index < beatLines.length; index += 1) {
        const line = beatLines[index]
        if (!/爽点\s*[（(]\s*打脸/u.test(line)) continue
        let has = false
        for (let cursor = index + 1; cursor < beatLines.length; cursor += 1) {
          if (/^\s*[-*+]?\s*场景\s*[：:]/u.test(beatLines[cursor])) break
          if (/^\s*[-*+]?\s*(?:反应|对方反应)\s*[：:]/u.test(beatLines[cursor])) { has = true; break }
        }
        if (!has) {
          report.issues.push({
            kind: 'no-reaction-on-payoff',
            detail: '这一场的爽点标的是「打脸」，但章纲里没写对手当场怎么反应：补一行「- 反应：他把烟塞回兜里，笑了一下，说「行，你有种」」——可用表情、动作或对白呈现；是否直接写内心遵守本场叙述视角，不强制增加心理段落。',
          })
          break
        }
      }
      if (reactions.length === 0 && /爽点\s*[（(]\s*打脸/u.test(beatBody)) {
        // already covered above; keep single issue
      }
    }
      if (beat.section && beat.section.chars > 0) {
        const gap = beatCoverage(text, beat.section.body)
        if (gap.missing.length) {
          report.heuristicNotes.push({
            kind: 'beats-gap',
            detail:
              `章纲 ${gap.total} 场，字面近似匹配 ${gap.covered} 场。待对照全文的有：` +
              gap.missing.map(item => `第 ${item.index} 场「${item.snippet}…」`).join('、') + '。未匹配不代表漏写，不要求照抄章纲或补写；确认实际缺失后再登记语义问题。',
          })
        }
        // 节奏：爽点与钩子写在章纲的场记末尾，这里只做提醒，不逼着改。
        const marks = beat.section.marks ?? { payoff: [], hook: 0, turn: 0 }
        if (!marks.payoff.length) {
          let gapBefore = 0
          const index = meta.chapters.findIndex(item => item.id === chapter.id)
          for (let i = index - 1; i >= 0; i -= 1) {
            const section = matchBeatSection(beat.sections, meta.chapters[i])
            if (!section || section.chars === 0) continue
            if ((section.marks?.payoff.length ?? 0) > 0) break
            gapBefore += 1
          }
          report.issues.push({
            kind: 'no-payoff',
            detail:
              `章纲里一场「→ 爽点」都没有${gapBefore ? `，而且已经连续 ${gapBefore} 章没有了` : ''}：` +
              '读者追下去靠情绪回报，全是信息过场容易被跳读。类型可以是打脸 / 翻盘 / 揭秘 / 情感兑现 / 强强对话——在那一场末尾补一句「→ 爽点（类型）」再写。',
          })
        }
        if (!marks.hook) {
          report.issues.push({
            kind: 'no-hook',
            detail: '章末没有「→ 钩子」：一章收尾要留一个必须翻页的理由（新麻烦 / 新信息 / 一句悬着的话），在最后一场末尾标一下。',
          })
        }
        const infos = beat.section.infos ?? []
        if (infos.length) {
          if (gap.total === 0) {
            report.issues.push({
              kind: 'info-only',
              detail:
                `这一章的章纲只有 ${infos.length} 条「信息」，一场戏都没写：信息行是「读者要新知道什么」，不能代替场景。` +
                '补上 3–6 条「- 场景：谁 → 在哪 → 想干什么 → 撞上什么」。',
            })
          }
          if (infos.length > 3) {
            report.issues.push({
              kind: 'too-many-infos',
              detail: `这一章标了 ${infos.length} 条信息。一章最多 3 条——再多就是在写提纲，读者记不住。`,
            })
          }
          const infoGap = beatCoverage(text, infos.map(item => item.text).join('\n'))
          if (infoGap.missing.length) {
            report.heuristicNotes.push({
              kind: 'info-missing',
              detail:
                `章纲 ${infos.length} 条「信息」，${infoGap.missing.length} 条未通过字面近似匹配：` +
                infoGap.missing.map(item => `第 ${item.index} 条「${item.snippet}…」`).join('、') + '。可能已用不同表达传达；先核对读者是否已获必要信息，不单凭词面补写或阻塞。',
            })
          }
        }
      }
      const styleName = activeStyleName(meta)
      const styleRaw = styleName ? await readStyle(rootNow(), styleName) : null
      if (styleRaw) {
        const restrictions = parseStyleRestrictions(styleRaw)
        const hits = styleRestrictionMatches(text, restrictions.banned)
        if (hits.length) {
          report.issues.push({ kind: 'style-banned', detail: `命中文风卡「${styleName}」的禁用词或整句，共 ${hits.length} 处。`, count: hits.length, samples: hits.slice(0, 20) })
        }
        const limited = styleRestrictionMatches(text, restrictions.limited)
        report.styleReview = {
          limited: limited.slice(0, 20), limitedCount: limited.length,
          semantic: restrictions.semantic, warnings: restrictions.warnings,
        }
        const fitSample = await readStyleSample(rootNow(), styleName)
        const fit = styleFit(text, styleRaw, fitSample && fitSample.present ? fitSample.text : "")
        if (fit.flagged.length) {
          const worst = fit.flagged
            .slice()
            .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
            .slice(0, 3)
            .map(row => `${row.label} ${row.act}（卡上锚点是 ${row.ref}，${row.ratio >= 1 ? '偏多' : '偏少'} ${row.ratio} 倍）`)
          report.heuristicNotes.push({
            kind: 'style-drift',
            detail: `与文风卡「${styleName}」的统计差异：${worst.join('；')}。只供结合全文复核，不要求重写，不要用逗号拼接句子凑指标。`,
          })
        }
        // 对白比例仅提供统计线索，是否调整取决于场景与人物表达。
        const dialogueRow = (fit.rows || []).find(row => row.key === 'dialogue')
        if (dialogueRow && dialogueRow.act >= 25 && dialogueRow.ratio >= 1.6) {
          report.heuristicNotes.push({
            kind: 'dialogue-heavy',
            detail: `含对白的段落占 ${dialogueRow.act}%，文风样本是 ${dialogueRow.ref}%（${dialogueRow.ratio} 倍）。这是非阻塞统计线索；结合完整场景判断，不按比例删对白、压缩问答或补身体动作。`,
          })
        }

        // 词表与邻段窗口只是线索，不把未命中当成缺少人物反应。
        const moments = payoffMoments(text)
        if (moments.total >= 4 && moments.hit / moments.total < 0.3) {
          report.heuristicNotes.push({
            kind: 'payoff-no-reaction',
            detail:
              `金钱相关词命中 ${moments.total} 段，其中 ${moments.hit} 段的当前段及后两段全文命中反应关键词（${Math.round((moments.hit / moments.total) * 100)}%）。` +
              '检测没有截断全文，样例才截短展示；零命中不等于缺少自然反应，不要求补动作。' +
              (moments.samples.length ? `比如这几段：「${moments.samples.join('」「')}」` : ''),
            count: moments.total - moments.hit,
            samples: moments.samples,
          })
        }
        // 只提供观察数据，不根据关键词密度要求增加心理段落。
        report.interiorObservation = interiorStats(text)

      }
      // 事件线：串了区间、锚了不存在的事件、或者落在区间里却没锚，都要提醒。
      // 只有「按章查」才有章 id 可比；直接查一段文本时跳过这节（否则 chapter 是 undefined）。
      const spineBoard = chapter ? await readEvents(rootNow()) : { present: false }
      if (spineBoard.present) {
        const beatBoard = await readBeats(rootNow(), null)
        const timeline = eventTimeline(spineBoard, meta.chapters, beatBoard.sections)
        const mine = timeline.chapters.find(item => item.id === chapter.id)
        const anchored = mine ? mine.anchors.length : 0
        const inRange = timeline.lines.reduce(
          (sum, item) =>
            sum +
            item.events.filter(event => event.from && chapter.id >= event.from && chapter.id <= event.to).length,
          0,
        )
        if (anchored === 0 && inRange > 0) {
          report.issues.push({
            kind: 'spine-unanchored',
            detail: '这一章落在 ' + inRange + ' 条事件的区间里，但章纲没写「- 事件：…」：装配包与右栏泳道都会以为这一章不推任何线。',
          })
        }
        for (const warning of timeline.warnings) {
          if (!warning.startsWith(chapter.id)) continue
          report.issues.push({ kind: 'spine-conflict', detail: warning })
        }
      }
      // 戏份承诺：人物卡上写「每 N 章至少出场一次」，就要真的查。
      // 判据只看「已写章」——还没写的章不算漏。
      const cadenceCards = cards.filter(card => parseCadence(card.content))
      if (cadenceCards.length) {
        const bookNow = await loadBook(rootNow())
        const bookChapters = bookNow.meta.chapters ?? []
        const uptoId = chapter
          ? chapter.id
          : [...bookChapters]
              .reverse()
              .map(item => item.id)
              .find(() => true) || ''
        if (uptoId) {
          const ready = cadenceCards.map(card => ({
            name: card.name,
            file: `${CHARACTERS_DIR}/${card.name}${CHARACTER_EXT}`,
            cadence: parseCadence(card.content),
            states: parseStates(card.content),
          }))
          const seen = await appearanceIndex(rootNow(), bookChapters, ready, bookNow.meta.targetChars)
          const report2 = appearanceReport(seen.last, ready, uptoId)
          for (const item of ready) {
            const info = report2[item.name]
            if (!info || !info.due) continue
            report.issues.push({
              kind: 'absent-role',
              detail: info.last
                ? `${item.name} 上一次出场是第 ${Number(info.last)} 章，到现在已经 ${info.gap} 章没露面；人物卡上写的是每 ${item.cadence} 章至少一次。要么给他一场戏，要么把卡上的戏份改掉。`
                : `${item.name} 一直没在正文里出现过；人物卡上写的是每 ${item.cadence} 章至少一次。`,
            })
          }
        }
      }
      report.mechanicalOk = report.issues.every(item => item.kind.startsWith('semantic-') || item.kind === 'deai-review-pending')
      report.ok = report.issues.length === 0
      return report
    },
    presentCall: args => ({
      card: 'generic',
      title: args.chapter ? `自检 ${args.chapter}` : '自检文本',
      kind: 'read',
      rawInput: args,
    }),
  })

  registerTool({
    name: 'novel_deai_pack',
    description:
      '交付前阅读全文审稿：返回全部非空段落、章纲、设定索引、人物卡和文风卡。先按场景追踪人物位置、工具来源、动作前提、耗时与救险因果，再审对白、设定讲解和朗诵腔。多个修改用同一 baseHash 和 patches 一次回写，修改后重新取包并调用 novel_deai_review 登记最终版本复核。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '章节 id 或标题' },
      },
      required: ['chapter'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          chapter: { type: 'object', additionalProperties: true },
          baseHash: { type: 'string' },
          totalItems: { type: 'integer' },
          voices: { type: 'array', items: { type: 'object', additionalProperties: true } },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          rules: { type: 'string' },
          style: { type: 'object', additionalProperties: true },
          dialogueContext: { type: 'object', additionalProperties: true },
          settingReferences: { type: 'array', items: { type: 'object', additionalProperties: true } },
          sourceRequirements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          materialPreflight: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `【全文语义审稿】${value.chapter.id} ${value.chapter.title} · 全部 ${value.totalItems} 段（baseHash: ${value.baseHash}）`,
          '',
          value.rules,
        ]
        if (value.materialPreflight) lines.push('', renderMaterialPreflight(value.materialPreflight))
        if (value.voices.length) {
          lines.push('', '## 出场人物声口（改对话时必须保住）')
          for (const v of value.voices) {
            lines.push(`### ${v.name}`, v.content)
          }
        }
        lines.push('仅以代称出场或尚未匹配的角色，请用 novel_card 补读人物卡；不要由缺少卡片推断人物没有声口约束。')
        lines.push('', '## 本章场景与认知约束（按空间动作与对白钩子逐段核对）', value.dialogueContext?.beats || '（无章纲：以完整正文中已发生的事实为依据，不补造场景或人物动机。）')
        lines.push('', '## 设定索引（涉及机制、能量路径或身体反应时，用 novel_setting 读取相关完整条目）')
        for (const item of value.settingReferences ?? []) lines.push(`- ${item.name}：${item.summary}`)
        if (!value.settingReferences?.length) lines.push('（无设定条目：不能用想象的新机制补救原文矛盾。）')
        lines.push('', '## 各维度 supported 所需来源（须在对应 checks 中引用）')
        for (const item of value.sourceRequirements ?? []) lines.push(`- ${item.aspect}：${item.source}:${item.name}`)
        if (value.style.text) lines.push('', `## 文风样本与约束：${value.style.name}`, value.style.text)
        lines.push('', '## 全部正文（没有机械命中也必须阅读；有问题才修改）', '批量回写：novel_write({chapter,mode:"patch",baseHash,patches:[{start,end,content}]}）。修改后本包失效，重新取包审稿；无须修改也要提交 novel_deai_review。')
        for (const item of value.items) {
          lines.push('')
          lines.push(`### #${item.index} [${item.tags.join(' / ')}] (start=${item.start}, end=${item.end})`)
          lines.push(`**待审原文**：${item.text}`)
        }
        return textRender(lines.join('\n'))
      },
    },
    execute: async args => {
      const { meta } = await loadBook(rootNow())
      const chapter = findChapter(meta.chapters, args.chapter)
      if (!chapter) throw new Error(`没有这一章「${args.chapter}」；先 novel_status 看章节 id`)
      const raw = (await readText(path.join(rootNow(), chapter.file))) ?? ''
      if (!raw.trim()) throw new Error(`这一章「${chapter.id}」还是空的`)
      const cards = []
      for (const card of await listCharacters(rootNow())) {
        cards.push({ name: card.name, content: (await readCharacter(rootNow(), card.name)) ?? '' })
      }
      const packed = extractDeaiPack(raw, cards)
      const styleName = activeStyleName(meta)
      const beats = await readBeats(rootNow(), chapter)
      const styleText = styleName ? (await readStyle(rootNow(), styleName)) ?? '' : ''
      return {
        chapter: { id: chapter.id, title: chapter.title },
        ...packed,
        rules: `${DEAI_RULES}\n\n${SCENE_REVIEW_RULES}\n\n${REVIEW_EVIDENCE_RULES}\n\n${DEAI_WORKFLOW}`,
        style: { name: styleName, text: styleText },
        dialogueContext: { beats: beats.section?.body ?? '' },
        settingReferences: (await listSettings(rootNow())).map(item => ({ name: item.name, summary: item.summary })),
        sourceRequirements: (await reviewSourceCoverage(rootNow(), meta, raw)).requirements,
        materialPreflight: await materialPreflight(rootNow(), chapter, { beatsText: beats.section?.body ?? '', styleName, styleText }),
      }
    },
    presentCall: args => ({ card: 'generic', title: `全文语义审稿 ${args.chapter}`, kind: 'read', rawInput: args }),
  })

  registerTool({
    name: 'novel_deai_review',
    description: '登记有证据的审稿结果。checks 汇总六项判断；observations 逐条区分确定矛盾、缺失依据和非阻塞表达偏好，无发现填 []。确认矛盾须声明同一对象、属性与时间范围。证据支持 threads/events 并回显来源角色，历史备忘不自动覆盖正文。timeBudgets 只核算时间记账。已登记矛盾或依据不足、明示超时或无效记账依据阻塞 final；估算和未知耗时本身不自动阻塞，即使 checks 写 supported 也不能覆盖；引用校验不证明推论正确。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        chapter: { type: 'string' },
        baseHash: { type: 'string', description: '当前 novel_deai_pack 返回的整章哈希，发现矛盾也可登记' },
        checks: {
          type: 'object', additionalProperties: false,
          properties: Object.fromEntries(Object.entries(DEAI_REVIEW_ASPECTS).map(([key, description]) => [key, {
            type: 'object', additionalProperties: false, description,
            properties: {
              verdict: { type: 'string', enum: ['supported', 'conflict', 'uncertain', 'not-applicable'], description: '有依据支持、确认矛盾、依据不足或本项不适用；不确定不能伪装通过' },
              detail: { type: 'string', minLength: 1, description: '具体结论，区分原文事实与推断；不把修改设想当原文事实' },
              evidence: { type: 'array', minItems: 1, items: REVIEW_EVIDENCE_SCHEMA, description: '至少一条对应段号的正文引文；确认矛盾至少两条不同引文。涉及设定的断言另引相关来源；引文逐字校验' },
              counterargument: { type: 'string', minLength: 1, description: '指出最可能推翻本结论的原文、缺失依据或替代解释，再说明如何处理；不能只写已检查无问题' },
            },
            required: ['verdict', 'detail', 'evidence', 'counterargument'],
          }])),
          required: Object.keys(DEAI_REVIEW_ASPECTS),
        },
        resolutions: {
          type: 'object', additionalProperties: false, description: '上次已登记的阻塞项本次转为 supported/not-applicable 时，必须按对应维度说明如何修复或为何更正判断；证据使用本次 checks 的引文，不能静默删除旧问题。',
          properties: Object.fromEntries(Object.keys(DEAI_REVIEW_ASPECTS).map(key => [key, { type: 'string', minLength: 1 }])),
        },
        observations: {
          type: 'array', description: '逐条分类审稿发现，无发现填 []。确定矛盾、依据不足、表达偏好不能混成一个标签；偏好不阻塞。checks 的 conflict/uncertain 必须有对应观察支持。',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              aspect: { type: 'string', enum: Object.keys(DEAI_REVIEW_ASPECTS) },
              classification: { type: 'string', enum: ['conflict', 'missing-basis', 'preference'] },
              detail: { type: 'string', minLength: 1 },
              evidence: { type: 'array', minItems: 1, items: REVIEW_EVIDENCE_SCHEMA },
              counterargument: { type: 'string', minLength: 1, description: '排除同名异物、不同属性或时间变化；依据不足不能说成确定写错' },
              comparison: {
                type: 'object', additionalProperties: false, description: 'conflict 必填，确认比较的是同一对象、同一属性与相容的时间范围；不同物件数量不直接比较。',
                properties: { entity: { type: 'string', minLength: 1 }, property: { type: 'string', minLength: 1 }, timeScope: { type: 'string', minLength: 1 } },
                required: ['entity', 'property', 'timeScope'],
              },
            },
            required: ['aspect', 'classification', 'detail', 'evidence', 'counterargument'],
          },
        },
        timeBudgets: {
          type: 'array', description: '逐个核对有明确时间限制的窗口；没有窗口填 []，不得在文字里编数字代替提交。阶段顺序相加，并行阶段取任务最长值；同一窗口不换算单位。',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              label: { type: 'string', minLength: 1 },
              unit: { type: 'string', minLength: 1, description: '原文时间单位，如息、秒，不擅自换算' },
              availableText: { type: 'string', minLength: 1, description: '逐字引用可用时间，如“六息”；必须出现在 evidence 中，由工具解析数值' },
              evidence: { type: 'array', minItems: 1, items: REVIEW_EVIDENCE_SCHEMA },
              phases: {
                type: 'array', minItems: 1,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    parallel: { type: 'boolean', description: '是否同时进行；并行时 evidence 必须说明对应的原文依据' },
                    evidence: { type: 'array', items: REVIEW_EVIDENCE_SCHEMA },
                    tasks: {
                      type: 'array', minItems: 1,
                      items: {
                        type: 'object', additionalProperties: false,
                        properties: {
                          label: { type: 'string', minLength: 1 },
                          basis: { type: 'string', enum: ['stated', 'estimated', 'unknown'] },
                          duration: { type: 'number', minimum: 0, description: '明示或估算的非负耗时，unknown 时省略' },
                          durationText: { type: 'string', description: 'stated 必填，必须是原文明示的经过时间或操作耗时；剩余时间、上限和第几息不能冒充耗时。单位须与窗口相同，数值须等于 duration' },
                          evidence: { type: 'array', minItems: 1, items: REVIEW_EVIDENCE_SCHEMA },
                        },
                        required: ['label', 'basis', 'evidence'],
                      },
                    },
                  },
                  required: ['parallel', 'evidence', 'tasks'],
                },
              },
            },
            required: ['label', 'unit', 'availableText', 'evidence', 'phases'],
          },
        },
        scenes: {
          type: 'array', minItems: 1, description: '按正文顺序分场，连续覆盖当前包全部段落，不可遗漏或重叠；每场列全关键动作并承接上一场状态。静态场景可用空 actions，但须说明无动作的依据。',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              startIndex: { type: 'integer', minimum: 1 },
              endIndex: { type: 'integer', minimum: 1 },
              layout: { type: 'string', minLength: 1, description: '人物、设备、通道与危险区的相对位置及已知状态；转场说明如何从上场到达' },
              mechanism: { type: 'string', minLength: 1, description: '主要因果链：异常来源→采取措施→能量或物质去向→结果；说明各辅助动作的必要性与设定依据，无此类机制时说明原因' },
              timeline: { type: 'string', minLength: 1, description: '把移动、拿取工具、对白与操作放进同一时间线，核对串并行和倒计时；不默认一息等于一秒，不编造精确耗时；无明确时间窗口时说明依据' },
              actions: {
                type: 'array', description: '按发生顺序记录全部关键物理动作；同段多个动作逐条列出',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: { index: { type: 'integer', minimum: 1 }, ...Object.fromEntries(Object.entries(SCENE_ACTION_FIELDS).map(([key, description]) => [key, { type: 'string', minLength: 1, description }])) },
                  required: ['index', ...Object.keys(SCENE_ACTION_FIELDS)],
                },
              },
            },
            required: ['startIndex', 'endIndex', 'layout', 'mechanism', 'timeline', 'actions'],
          },
        },
        paragraphs: {
          type: 'array', minItems: 1, description: '覆盖当前审稿包全部段落，每段说明保留理由或待解决问题；有矛盾或缺依据时如实登记，并在 checks 标为 conflict/uncertain，不能编造前提后宣告完成。',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              index: { type: 'integer', minimum: 1 },
              reason: { type: 'string', minLength: 1 },
              dialogue: {
                type: 'object', additionalProperties: false, description: '带对话标签的段落必填；先区分实际对白、内心、引用和无法确定。实际对白须填写说话者、听者、目的、现场压力与措辞判断；包含多轮对白时逐轮写在对应字段中。',
                properties: {
                  kind: { type: 'string', enum: ['speech', 'thought', 'quotation', 'uncertain'] },
                  speaker: { type: 'string', description: '谁在说；无法确定时明确写出，不凭空指定' },
                  listener: { type: 'string', description: '说给谁听，以及对方此刻知道什么' },
                  intent: { type: 'string', description: '此刻想让对方知道、相信或做什么，依据正文和章纲判断' },
                  pressure: { type: 'string', description: '剩余时间、正在进行的动作及双方关系怎样影响这句话' },
                  assessment: { type: 'string', description: '措辞是否清楚、符合声口、能完成目的；省略或狠话是否需要读者解码，说明保留理由或待解决问题' },
                },
                required: ['kind'],
              },
            },
            required: ['index', 'reason'],
          },
        },
      },
      required: ['chapter', 'baseHash', 'checks', 'observations', 'timeBudgets', 'scenes', 'paragraphs'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { chapter: { type: 'string' }, baseHash: { type: 'string' }, reviewedParagraphs: { type: 'integer' }, status: { type: 'string', description: 'recorded 仅表示已登记，blocked 表示存在阻塞项，均非自动语义认证' }, certifiesSemantics: { type: 'boolean', description: '固定为 false，工具不自动认证小说语义正确' }, checkVerdicts: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.keys(DEAI_REVIEW_ASPECTS).map(aspect => [aspect, { type: 'string', enum: ['supported', 'conflict', 'uncertain', 'not-applicable'] }])) }, findings: { type: 'array', items: { type: 'object', additionalProperties: true } }, preferenceNotes: { type: 'array', items: { type: 'object', additionalProperties: true } }, evidenceContexts: { type: 'array', items: { type: 'object', additionalProperties: true } }, timingReports: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      render: (_args, value) => textRender([
        renderReviewStatus(value.status, value.findings),
        '六维实际登记值：' + Object.entries(value.checkVerdicts ?? {}).map(([aspect, verdict]) => `${aspect}: ${verdict}`).join('；'),
        `已登记 ${value.chapter} 当前版本的模型审稿结果，共 ${value.reviewedParagraphs} 段。${value.status === 'blocked' ? '存在矛盾、依据不足或工具校验阻塞项。' : '当前无已登记阻塞项，不等于文章获得自动语义通过。'}`,
        ...value.findings.map(item => `[${item.aspect}/${item.verdict}] ${item.detail}\n${item.evidence.map(reference => `- ${reference.source}${reference.name ? ':' + reference.name : ''}${reference.index ? ' #' + reference.index : ''}：${reference.quote}`).join('\n')}`),
        ...(value.preferenceNotes ?? []).map(item => `表达偏好（非阻塞）[${item.aspect}] ${item.detail}`),
        ...(value.timingReports ?? []).map(item => `时间记账「${item.label}」：提交值合计 ${item.total}，明示耗时下界 ${item.minimum} / 可用 ${item.available} ${item.unit}；${item.uncertain ? `记账局限（不单凭估算或未知自动阻塞）：${(item.uncertainties ?? []).join('；')}。` : ''}动作可行性未获自动判定；新增计时句不能代替可行性判断。`),
        '## 工具提取的引文完整段落（包括 supported 项）',
        ...(value.evidenceContexts ?? []).map(item => `[${item.aspects.join('/')} · ${item.source}/${item.role ?? REVIEW_SOURCE_ROLES[item.source]?.role ?? ''}${item.name ? ':' + item.name : ''}${item.index ? ' #' + item.index : ''}]\n${item.context}`),
        '请运行 novel_check 核对当前状态；登记记录不是自动自然度认证。',
      ].join('\n')),
    },
    execute: async args => {
      const root = rootNow()
      const { meta } = await loadBook(root)
      const chapter = findChapter(meta.chapters, args.chapter)
      if (!chapter) throw new Error(`没有这一章「${args.chapter}」`)
      const raw = (await readText(path.join(root, chapter.file))) ?? ''
      const packed = extractDeaiPack(raw, [])
      if (!raw.trim() || args.baseHash !== packed.baseHash) throw new Error('正文为空或版本已变化，请重新调用 novel_deai_pack；未登记')
      const observations = reviewObservations(args.observations, args.checks)
      let timing = calculateReviewTimeBudgets(args.timeBudgets, packed, args.checks)
      const evidence = await validateReviewEvidence(root, chapter, packed, args.checks, [...timing.evidence, ...observations.evidence])
      timing = calculateReviewTimeBudgets(args.timeBudgets, packed, args.checks, evidence.contexts)
      const coverage = await reviewSourceCoverage(root, meta, raw, args.checks)
      const validationFindings = [...timing.findings, ...coverage.findings, ...observations.findings]
      if (!hasCompleteSceneReviews(args.scenes, packed.totalItems)) throw new Error('场景复核必须按顺序连续覆盖全文，并完整填写布局、机制、时间线与关键动作；未登记')
      const paragraphs = args.paragraphs
      const indices = new Set(Array.isArray(paragraphs) ? paragraphs.map(item => item?.index) : [])
      if (!Array.isArray(paragraphs) || paragraphs.length !== packed.totalItems || indices.size !== packed.totalItems || packed.items.some(item => !indices.has(item.index)) || paragraphs.some(item => typeof item?.reason !== 'string' || !item.reason.trim())) throw new Error('必须逐段覆盖当前版本全文并说明保留理由或待解决问题，不能遗漏或重复；未登记')
      const byIndex = new Map(paragraphs.map(item => [item.index, item]))
      for (const item of packed.items) {
        if (!item.tags.includes('对话')) continue
        const dialogue = byIndex.get(item.index).dialogue
        if (!dialogue || !['speech', 'thought', 'quotation', 'uncertain'].includes(dialogue.kind)) throw new Error(`第 ${item.index} 段缺少引语类型判断；未登记`)
        if (dialogue.kind === 'uncertain' && !['conflict', 'uncertain'].includes(args.checks.voice.verdict)) throw new Error(`第 ${item.index} 段引语类型尚未确定，voice 不能登记为通过；请如实标记 uncertain 或 conflict`)
        if (dialogue.kind === 'speech' && ['speaker', 'listener', 'intent', 'pressure', 'assessment'].some(key => typeof dialogue[key] !== 'string' || !dialogue[key].trim())) throw new Error(`第 ${item.index} 段必须结合实际场景填写完整对白判断；未登记`)
      }
      const findings = sortReviewFindings([...reviewFindings(args.checks, args.observations), ...validationFindings])
      const previous = chapter.deaiReview
      const resolvedFindings = hasCompleteReviewChecks(previous?.checks)
        ? [...reviewFindings(previous.checks, previous.observations), ...(previous.validationFindings ?? [])].filter(item => !findings.some(current => current.aspect === item.aspect))
        : []
      if (resolvedFindings.some(item => typeof args.resolutions?.[item.aspect] !== 'string' || !args.resolutions[item.aspect].trim())) throw new Error('旧阻塞项转为通过时必须填写对应 resolutions，说明修复依据或更正原因；未登记')
      const status = findings.length ? 'blocked' : 'recorded'
      chapter.deaiReview = {
        version: DEAI_REVIEW_VERSION,
        baseHash: packed.baseHash,
        styleName: activeStyleName(meta),
        reviewedAt: new Date().toISOString(),
        status,
        certifiesSemantics: false,
        checks: args.checks,
        observations: args.observations,
        sources: evidence.sources,
        evidenceContexts: evidence.contexts,
        timeBudgets: args.timeBudgets,
        timingReports: timing.reports,
        sourceCoverage: coverage.requirements,
        validationFindings,
        scenes: args.scenes,
        paragraphs,
        resolvedFindings: resolvedFindings.map(item => ({ ...item, resolution: args.resolutions[item.aspect] })),
      }
      if (status === 'blocked' && chapter.status === 'final') chapter.status = 'draft'
      await persistBook(root, meta, meta.chapters)
      return { chapter: chapter.id, baseHash: packed.baseHash, reviewedParagraphs: paragraphs.length, status, certifiesSemantics: false, checkVerdicts: Object.fromEntries(Object.entries(args.checks).map(([aspect, check]) => [aspect, check.verdict])), findings, preferenceNotes: observations.notes, evidenceContexts: evidence.contexts, timingReports: timing.reports }
    },
    presentCall: args => ({ card: 'generic', title: `登记语义复核 ${args.chapter}`, kind: 'write', rawInput: args }),
  })

  // ---- 章纲（大纲之下、正文之上那一层）------------------------------------
  registerTool({
    name: 'novel_beats',
    description: '章纲写在 beats.md，每章 ## 章ID 标题。chapter 读取；chapter+content 覆盖当前章；无参数查看覆盖。每场用 ### 场景 scene-id：标题，写 - 时序：整数（故事先后，非章号）、- 故事时间：描述、- 地点：地点、- 视角：人物ID、- 出场：人物ID、人物ID、- 提及：仅被提到的人物ID、- 事件：具体事件ID、- 冲突：目标与阻力。角色块 #### 人物 character-id，写已知/未知/误信/怀疑及来源、目标、关系与情绪、表达意图、触发、计划变化。每个场景 ID 全书唯一；时序越大越晚，同场变化仅触发后生效。计划不是已发生事实，写后用 novel_character_history 提取并核对。节奏标记可用 → 爽点（类型）/ → 钩子 / → 转折。正文前用 novel_context({chapter,scene})；顺延用 novel_move_scene 保留整场约束。人物块可选字段：' + ROLE_FIELDS.join('、') + '。场景写 - 叙述方式：限知/全知/客观；视角写人物ID。' + PRESENTATION_RULES,
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '章节 id 或标题；写 content 时必填' },
        content: { type: 'string', description: '这一章的章纲全文（Markdown 列表）；给了就写入' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          written: { type: 'boolean' },
          chapter: { type: 'object', additionalProperties: true },
          beats: { type: 'object', additionalProperties: true },
          coverage: { type: 'object', additionalProperties: true },
          sections: { type: 'array', items: { type: 'object', additionalProperties: true } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['written'],
      },
      render: (_args, value) => {
        const coverage = value.coverage ?? { total: 0, covered: [], missing: [] }
        const tail = `章纲覆盖 ${coverage.covered.length}/${coverage.total} 章${coverage.missing.length ? `（还缺 ${coverage.missing.join('、')}）` : ''}`
        const rhythmTail = value.rhythm
          ? `\n节奏：爽点 ${value.rhythm.payoff}${value.rhythm.budget ? ` / 计划 ${value.rhythm.budget}` : ''}` +
            ` · 有爽点的章 ${value.rhythm.withPayoff}/${value.rhythm.withBeats} · 钩子 ${value.rhythm.hooks} 章 · 最长断档 ${value.rhythm.longestGap} 章` +
            (value.rhythm.currentGap >= (value.rhythm.gapLimit || 2) ? `\n⚠ 已经连续 ${value.rhythm.currentGap} 章没有爽点（每 ${value.rhythm.gapLimit || 2} 章至少一次）` : '')
          : ''
        if (value.written) {
          return textRender(`已写入 ${value.chapter.id} ${value.chapter.title} 的章纲（${value.beats.chars} 字）。${warnText(value.warnings)}\n${tail}${rhythmTail}`)
        }
        if (value.chapter) {
          const body = value.beats && value.beats.present ? value.beats.text : '（这一章还没有章纲；可以给 content 写一段，或让我按大纲拆）'
          const marks = value.marks
          const markLine = marks
            ? `\n本章标记：爽点 ${marks.payoff}（${marks.labels.length ? marks.labels.join('、') : '未写类型'}） · 钩子 ${marks.hook ? '有' : '无'} · 转折 ${marks.turn}`
            : ''
          return textRender(`【章纲】${value.chapter.id} ${value.chapter.title}\n\n${body}${markLine}\n\n${tail}${rhythmTail}`)
        }
        const lines = ['【全书章纲】']
        if (!value.sections.length) lines.push('（beats.md 还是空的）')
        const marks = new Map((value.rhythm?.perChapter ?? []).map(item => [item.id, item]))
        for (const section of value.sections ?? []) {
          const mark = marks.get(section.id)
          const flag = mark ? ` · 爽×${mark.payoff}${mark.hook ? ' 钩' : ''}` : ''
          lines.push(`- ${section.heading}（${section.chars} 字${flag}）`)
        }
        lines.push('', tail + rhythmTail)
        return textRender(lines.join('\n'))
      },
    },
    execute: async args => {
      const { meta } = await loadBook(rootNow())
      const chapters = []
      for (const chapter of meta.chapters) chapters.push(await chapterStats(rootNow(), chapter, meta.targetChars))
      const coverage = await beatsCoverage(rootNow(), chapters)

      const hasContent = typeof args.content === 'string'
      if (hasContent && !args.chapter) throw new Error('写章纲要给 chapter（哪一章）')
      const chapter = args.chapter ? findChapter(meta.chapters, args.chapter) : null
      if (args.chapter && !chapter) throw new Error(`没有这一章「${args.chapter}」；先 novel_status 看章节 id`)

      const rhythm = await beatRhythm(rootNow(), chapters)
      const budget = payoffBudget((await readText(path.join(rootNow(), OUTLINE_FILE))) ?? '')
      const rhythmSummary = {
        payoff: rhythm.payoff,
        withPayoff: rhythm.withPayoff,
        withBeats: rhythm.withBeats,
        hooks: rhythm.hooks,
        turns: rhythm.turns,
        longestGap: rhythm.longestGap,
        currentGap: rhythm.currentGap,
        gapLimit: rhythm.gapLimit,
        budget: budget ? budget.total : 0,
        perChapter: rhythm.perChapter.map(item => ({ id: item.id, payoff: item.payoff, hook: item.hook, turn: item.turn })),
      }

      if (hasContent) {
        const written = await writeBeats(rootNow(), chapter, args.content)
        return {
          written: true,
          warnings: validateBeatsContent(args.content),
          chapter: { id: chapter.id, title: chapter.title },
          beats: {
            heading: written.heading,
            text: String(args.content).trim(),
            chars: written.chars,
            present: written.chars > 0,
            infos: parseBeatInfos(args.content),
            scenes: parseScenes(args.content, chapter.id),
          },
          coverage: await beatsCoverage(rootNow(), chapters),
          rhythm: rhythmSummary,
        }
      }

      const board = await readBeats(rootNow(), chapter)
      // 不带参数时 schema 里的 chapter / beats 就不出现（写成 null 会被判 "must be an object"）。
      return {
        written: false,
        ...(chapter ? { chapter: { id: chapter.id, title: chapter.title } } : {}),
        ...(board.section
          ? {
              beats: {
                heading: board.section.heading,
                text: board.section.body,
                chars: board.section.chars,
                present: true,
                infos: board.section.infos ?? [],
              },
            }
          : {}),
        ...(board.section
          ? {
              marks: {
                payoff: board.section.marks.payoff.length,
                labels: board.section.marks.payoff.map(item => item.label).filter(Boolean),
                hook: board.section.marks.hook > 0,
                turn: board.section.marks.turn,
              },
            }
          : {}),
        coverage,
        rhythm: rhythmSummary,
        sections: board.sections.map(section => ({ id: section.id, heading: section.heading, chars: section.chars })),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.content ? `写章纲 ${args.chapter ?? ''}`.trim() : '读章纲',
      kind: typeof args.content === 'string' ? 'write' : 'read',
      rawInput: args,
    }),
  })

  // ---- 历史版本 -----------------------------------------------------------
  registerTool({
    name: 'novel_events',
    description:
      '事件线（events.md）：一条线跨多章、一章可以同时推进好几条线 —— 这是多对多，所以它和大纲、章纲分开存。' +
      '不传参 = 看全书事件线覆盖；给 line = 读那条线；给 line + content = 整段替换这条线（别的线一个字都不动）。' +
      '\n\n【格式约定】' +
      '\n## 主线：远离与反扑        ← 一条线一个二级标题，冒号前是线 id，后面是人话名字' +
      '\n- 目标：…                  ← 可选' +
      '\n### 主线-1 真相落地（1–3） ← 一个事件一个三级标题，括号里是起止章' +
      '\n- 因为：…' +
      '\n- 所以：…' +
      '\n- 不可替代：…              ← 少了这条，就只是情节摘要，删掉这场故事照样走' +
      '\n\n章纲里用「- 事件：主线-1、感情-1」把这一章锚到事件上；区间是默认值，锚点是修正。',
    parameters: {
      type: 'object',
      properties: {
        line: { type: 'string', description: '事件线 id 或名字；写 content 时必填' },
        content: { type: 'string', description: '这条线的完整小节（含 ## 标题）；给了就写入' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          written: { type: 'boolean' },
          line: { type: 'object', additionalProperties: true },
          lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
          warnings: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
        required: ['written', 'text'],
      },
      render: (_args, value) => textRender(value.text),
    },
    execute: async args => {
      const { meta } = await loadBook(rootNow())
      const board = await readEvents(rootNow())

      if (typeof args.content === 'string') {
        if (!args.line) throw new Error('写事件线要给 line（哪条线）')
        const written = await writeEventLine(rootNow(), args.line.trim(), args.content)
        const fresh = await readEvents(rootNow())
        const line = fresh.lines.find(item => item.id === args.line.trim() || item.name.includes(args.line.trim()))
        return {
          written: true,
          ...(line ? { line: { id: line.id, name: line.name, events: line.events.length } } : {}),
          lines: [],
          warnings: [],
          text: '已写入事件线「' + (line ? line.name : args.line) + '」（' + (line ? line.events.length : 0) + ' 个事件，' + written.chars + ' 字）。',
        }
      }

      if (!board.present) {
        return {
          written: false,
          lines: [],
          warnings: [],
          text: '【事件线】events.md 还是空的。先 novel_events({ line: "主线", content: "## 主线：主线名\\n### 主线-1 第一个事件（1–3）\\n- 因为：…\\n- 所以：…\\n- 不可替代：…" }) 建第一条。',
        }
      }

      const chapters = []
      for (const chapter of meta.chapters) chapters.push(await chapterStats(rootNow(), chapter, meta.targetChars))
      const beatBoard = await readBeats(rootNow(), null)
      const timeline = eventTimeline(board, chapters, beatBoard.sections)

      if (args.line) {
        const wanted = args.line.trim()
        const line = timeline.lines.find(item => item.id === wanted || item.name.includes(wanted))
        if (!line) throw new Error('没有这条事件线「' + wanted + '」；先 novel_events() 看看有哪些')
        const rows = ['【事件线】' + line.id + '：' + line.name + (line.goal ? '（目标：' + line.goal + '）' : ''), '']
        for (const event of line.events) {
          rows.push('### ' + event.id + ' ' + event.title + '（' + (event.from || '?') + '–' + (event.to || '?') + '）· ' + event.status)
          if (event.because) rows.push('- 因为：' + event.because)
          if (event.so) rows.push('- 所以：' + event.so)
          if (event.irreplaceable) rows.push('- 不可替代：' + event.irreplaceable)
          rows.push('- 覆盖 ' + event.total + ' 章（已写 ' + event.written + '）：' + (event.chapters.length ? event.chapters.join('、') : '没有章节落在区间里'))
        }
        return { written: false, line: { id: line.id, name: line.name }, lines: [], warnings: timeline.warnings, text: rows.join(String.fromCharCode(10)) }
      }

      const rows = ['【全书事件线】' + timeline.lineCount + ' 条线 · ' + timeline.eventCount + ' 个事件 · 有正文的 ' + timeline.done]
      for (const line of timeline.lines) {
        rows.push('', '## ' + line.id + '：' + line.name + (line.span ? '（' + line.span + '）' : ''))
        for (const event of line.events) {
          rows.push('- ' + event.id + ' ' + event.title + '（' + (event.from || '?') + '–' + (event.to || '?') + '）· ' + event.status + ' ' + event.written + '/' + event.total)
        }
      }
      if (timeline.warnings.length) {
        rows.push('', '⚠ 有 ' + timeline.warnings.length + ' 处不一致：')
        for (const warning of timeline.warnings) rows.push('- ' + warning)
      }
      return { written: false, lines: timeline.lines.map(item => ({ id: item.id, name: item.name, total: item.total, covered: item.covered })), warnings: timeline.warnings, text: rows.join(String.fromCharCode(10)) }
    },
    presentCall: args => ({ card: 'generic', title: args.content ? '写事件线' : '看事件线', kind: args.content ? 'edit' : 'read', rawInput: args }),
  })
  registerTool({
    name: 'novel_audit',
    description:
      '全书巡检：把逐章检查横向扫一遍（空章、字数偏差、章纲漏写、伏笔到期、配角欠场、事件未锚、断爽），按严重度排序输出。' +
      '\n只报能算出来的事实，不给「写得好不好」的评语。写完一批章之后跑一次，比逐章 novel_check 省事。' +
      '\n需要逐章细节时再用 novel_check({ chapter })。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', description: '只看某一级：error 或 warn；不传=全部' },
        limit: { type: 'number', description: '最多列几条，默认 20' },
      },
      additionalProperties: true,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
          summary: { type: 'object', additionalProperties: true },
        },
      },
      render(args, value) {
        const summary = value.summary || {}
        const rows = ['【全书巡检】' + (summary.chapters || 0) + ' 章（已写 ' + (summary.written || 0) + ' · 占位 ' + (summary.placeholders || 0) + '）' + (summary.words || 0) + ' / ' + (summary.target || 0) + ' 字']
        rows.push((summary.errors || 0) + ' 个问题 · ' + (summary.warns || 0) + ' 个提醒（爽点断档阈值 ' + (summary.gapLimit || 2) + ' 章）')
        const issues = value.issues || []
        if (!issues.length) {
          rows.push('', '没有发现能算出来的问题。')
          return [{ type: 'text', text: rows.join(String.fromCharCode(10)) }]
        }
        rows.push('')
        for (const item of issues) {
          const mark = item.level === 'error' ? '✗' : '·'
          rows.push(mark + ' [' + item.kind + '] ' + item.detail)
        }
        return [{ type: 'text', text: rows.join(String.fromCharCode(10)) }]
      },
    },
    execute: async args => {
      const report = await auditBook(rootNow())
      const level = args && args.level === 'error' ? 'error' : args && args.level === 'warn' ? 'warn' : ''
      const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 20))
      const issues = level ? report.issues.filter(item => item.level === level) : report.issues
      return { issues: issues.slice(0, limit), summary: report.summary }
    },
    presentCall: () => ({ card: 'generic', title: '全书巡检', kind: 'read' }),
  })
  registerTool({
    name: 'novel_export',
    description:
      '导出正文到书的 export/ 目录：全书或某段章节，合成一个 txt/md，或按章拆成多个 txt（投稿/备份用）。' +
      '\n只导出有正文的章；返回章数、总字数，以及落盘文件名。' +
      '\n参数：from/to（章节 id，含端点）、format（txt|md）、mode（single|per-chapter）、out（单文件名，可选）。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '从哪一章开始（章节 id）' },
        to: { type: 'string', description: '到哪一章结束（章节 id）' },
        format: { type: 'string', description: 'txt 或 md，默认 txt' },
        mode: { type: 'string', description: 'single=合成一个文件（默认）；per-chapter=按章拆开' },
        out: { type: 'string', description: '合成模式下的文件名，默认 book-<时间>.txt' },
      },
      additionalProperties: true,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          file: { type: 'string' },
          dir: { type: 'string' },
          chapters: { type: 'number' },
          words: { type: 'number' },
          chars: { type: 'number' },
        },
      },
      render(args, value) {
        const target = value.mode === 'per-chapter' ? value.dir + '/（每章一个 txt）' : value.file
        const rows = ['已导出 ' + value.chapters + ' 章 / ' + value.words + ' 字 → ' + target]
        return [{ type: 'text', text: rows.join(String.fromCharCode(10)) }]
      },
    },
    execute: async args => await exportBook(rootNow(), args || {}),
    presentCall: () => ({ card: 'generic', title: '导出正文', kind: 'write' }),
  })
  registerTool({
    name: 'novel_history',
    description:
      '看一章改过哪些版本（最新的在前：时间、字数、怎么改的、用的哪套文风）。' +
      '\n不传 version = 列时间线；给 version = 读那一版全文。' +
      '\n每次 novel_write 覆盖旧稿前都会自动留一版，所以这里看到的就是这一章的全部旧稿。' +
      '\n想回到某一版用 novel_restore（恢复前会先把当前内容也留一版，恢复本身能撤销）。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '章 id 或标题' },
        version: { type: 'string', description: '版本号（时间线里那一串数字）；给了就读这一版全文' },
      },
      required: ['chapter'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          chapter: { type: 'object', additionalProperties: true },
          current: { type: 'object', additionalProperties: true },
          versions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          version: { type: 'object', additionalProperties: true },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.version) {
          const head = `【${value.chapter.id} ${value.chapter.title}】版本 ${value.version.version}（${value.version.chars} 字，${value.version.source}${value.version.note ? ` · ${value.version.note}` : ''}）`
          return textRender(`${head}\n\n${value.content}`)
        }
        const lines = value.versions.length
          ? value.versions.map(
              (item, index) =>
                `- ${index === 0 ? '★ ' : ''}${item.version} · ${item.chars} 字 · ${item.source}${item.style ? ` · ${item.style}` : ''}${item.note ? ` · 被「${item.note}」替换` : ''}`,
            )
          : ['- （还没有旧稿；第一次覆盖写时才会留第一版）']
        const head = `${value.chapter.id} ${value.chapter.title}：当前 ${value.current.chars} 字，${value.versions.length} 个历史版本`
        return textRender(`${head}\n${lines.join('\n')}`)
      },
    },
    execute: async args => {
      const { meta } = await loadBook(rootNow())
      const chapter = findChapter(meta.chapters, args.chapter)
      if (!chapter) throw new Error(`没有这一章「${args.chapter}」`)
      const versions = await listHistory(rootNow(), chapter.id)
      const currentText = (await readText(path.join(rootNow(), chapter.file))) ?? ''
      const base = {
        chapter: { id: chapter.id, title: chapter.title, chars: countChars(currentText) },
        current: { chars: countChars(currentText), hash: shortHash(currentText) },
        versions,
      }
      if (!args.version) return { ...base, content: '' }
      const target = await readVersion(rootNow(), chapter.id, String(args.version).trim())
      if (!target) throw new Error(`没有这一版「${args.version}」；先 novel_history 看有哪些`)
      return { ...base, version: target.meta ?? { version: target.version, chars: target.chars }, content: target.content }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.version ? `读版本 ${args.version}` : `历史 ${args.chapter}`,
      kind: 'read',
      rawInput: args,
    }),
  })

  registerTool({
    name: 'novel_restore',
    description:
      '把某一章恢复到某个历史版本。恢复前会先把当前内容也留一版（所以随时能再恢复回来），恢复后章节状态回到 draft。' +
      '\n不知道有哪些版本就先 novel_history({ chapter })。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '章 id 或标题' },
        version: { type: 'string', description: '要恢复到的版本号（novel_history 里那一串）' },
      },
      required: ['chapter', 'version'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          chapter: { type: 'object', additionalProperties: true },
          version: { type: 'string' },
          chars: { type: 'integer' },
          snapshot: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const kept = value.snapshot ? `当前内容已留存为 ${value.snapshot.version}。` : ''
        return textRender(`已把 ${value.chapter.id} ${value.chapter.title} 恢复到 ${value.version}（${value.chars} 字）。${kept}`)
      },
    },
    execute: async args => {
      const result = await restoreVersion(rootNow(), args.chapter, String(args.version).trim())
      const { meta } = await loadBook(rootNow())
      const chapter = findChapter(meta.chapters, args.chapter)
      return { chapter: { id: chapter.id, title: chapter.title }, ...result }
    },
    presentCall: args => ({ card: 'generic', title: `恢复 ${args.chapter} → ${args.version}`, kind: 'write', rawInput: args }),
  })

  // ---- 界面数据出口 -------------------------------------------------------
  // 客户端跑在浏览器里，拿不到文件系统；这里给它一个只读 JSON 路由。
  // 只读、只在本机回环地址上、不含任何写入口，所以不额外做鉴权。
  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const entrance = new URL(req.url ?? API_PREFIX, 'http://localhost')
          const entranceRoot = await rootOf(entrance.searchParams.get('session'), undefined)
          await rootContext.run(entranceRoot, async () => {
          try {
            const url = new URL(req.url ?? API_PREFIX, 'http://localhost')
            const route = url.pathname.slice(API_PREFIX.length) || '/state'
            if (req.method === 'POST') {
              // 写入口只有下面这 12 个，且都要求自定义头（见下）。
              if (
                route !== '/character-history' &&
                route !== '/start-chapter' &&
                route !== '/outline' &&
                route !== '/beats' &&
                route !== '/event' &&
                route !== '/setting' &&
                route !== '/setting-delete' &&
                route !== '/thread' &&
                route !== '/style' &&
                route !== '/style-active' &&
                route !== '/style-clone' &&
                route !== '/style-delete' &&
                route !== '/restore' &&
                route !== '/export'
              ) {
                sendJson(res, 405, { error: `不支持的写操作 ${route}` })
                return
              }
              // 自定义头等于强制预检，跨站表单提交拿不到这个头；再配合同源 cookie 就够本机场景了。
              if (req.headers['x-novel-action'] !== '1') {
                sendJson(res, 403, { error: '缺少 x-novel-action 头' })
                return
              }
              const payload = await readJsonBody(req, 256 * 1024)
              if (route === '/character-history') {
                const { meta } = await loadBook(rootNow())
                sendJson(res, 200, await updateHistory(rootNow(), meta.chapters, payload))
                return
              }
    if (route === '/outline') {
                if (typeof payload.content !== 'string') {
                  sendJson(res, 400, { error: '需要 content 字符串' })
                  return
                }
                await fsp.writeFile(path.join(rootNow(), OUTLINE_FILE), payload.content, 'utf8')
                sendJson(res, 200, { ok: true, chars: countChars(payload.content) })
                return
              }
              if (route === '/export') {
                try {
                  const exported = await exportBook(rootNow(), payload)
                  const relFile = exported && exported.mode === 'single' ? exported.file : ''
                  sendJson(res, 200, {
                    ok: true,
                    ...exported,
                    ...(relFile ? { download: `${API_PREFIX}/download?file=${encodeURIComponent(relFile)}` } : {}),
                  })
                } catch (error) {
                  sendJson(res, 400, { error: error && error.message ? error.message : '导出失败' })
                }
                return
              }
              if (route === '/restore') {
                if (typeof payload.chapter !== 'string' || !payload.chapter.trim()) {
                  sendJson(res, 400, { error: '需要 chapter（哪一章）' })
                  return
                }
                if (typeof payload.version !== 'string' || !payload.version.trim()) {
                  sendJson(res, 400, { error: '需要 version（哪一版）' })
                  return
                }
                try {
                  const restored = await restoreVersion(rootNow(), payload.chapter, payload.version.trim())
                  const { meta: restoreMeta } = await loadBook(rootNow())
                  const chapter = findChapter(restoreMeta.chapters, payload.chapter)
                  sendJson(res, 200, {
                    ok: true,
                    chapter: { id: chapter.id, title: chapter.title },
                    version: restored.version,
                    chars: restored.chars,
                    snapshot: restored.snapshot,
                  })
                } catch (error) {
                  sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
                }
                return
              }
              if (route === '/beats') {
                if (payload.baseHash && payload.baseHash !== stageHash((await readText(path.join(rootNow(), BEATS_FILE))) || '')) { sendJson(res, 409, { error: '章纲已变化，请重新读取后保存' }); return }
                if (payload.fields) {
                  try { sendJson(res, 200, await editStageFields(rootNow(), payload)) }
                  catch (error) { sendJson(res, 409, { error: error.message }) }
                  return
                }
                if (typeof payload.content !== 'string') {
                  sendJson(res, 400, { error: '需要 content 字符串' })
                  return
                }
                if (typeof payload.chapter !== 'string' || !payload.chapter.trim()) {
                  sendJson(res, 400, { error: '需要 chapter（哪一章）' })
                  return
                }
                const { meta } = await loadBook(rootNow())
                const chapter = findChapter(meta.chapters, payload.chapter)
                if (!chapter) {
                  sendJson(res, 404, { error: `没有这一章「${payload.chapter}」` })
                  return
                }
                const written = await writeBeats(rootNow(), chapter, payload.content)
                sendJson(res, 200, { ok: true, chapter: { id: chapter.id, title: chapter.title }, chars: written.chars })
                return
              }
              if (route === '/setting') {
                if (typeof payload.content !== 'string') {
                  sendJson(res, 400, { error: '需要 content 字符串' })
                  return
                }
                if (typeof payload.name !== 'string' || !payload.name.trim()) {
                  sendJson(res, 400, { error: '需要 name（哪条设定）' })
                  return
                }
                const written = await writeSetting(rootNow(), payload.name, payload.content)
                sendJson(res, 200, { ok: true, name: written.name, chars: written.chars })
                return
              }
              if (route === '/setting-delete') {
                if (typeof payload.name !== 'string' || !payload.name.trim()) {
                  sendJson(res, 400, { error: '需要 name（删哪条设定）' })
                  return
                }
                const existing = await readSetting(rootNow(), payload.name)
                if (existing === null) {
                  sendJson(res, 404, { error: `没有设定「${payload.name}」` })
                  return
                }
                const removed = await deleteSetting(rootNow(), payload.name)
                sendJson(res, 200, { ok: true, name: removed.name, file: removed.file })
                return
              }
              if (route === '/thread') {
                if (typeof payload.thread !== 'string' || !payload.thread.trim()) {
                  sendJson(res, 400, { error: '需要 thread（哪条伏笔）' })
                  return
                }
                const written = await writeThread(rootNow(), {
                  thread: payload.thread,
                  planted: typeof payload.planted === 'string' ? payload.planted : undefined,
                  payoff: typeof payload.payoff === 'string' ? payload.payoff : undefined,
                  status: typeof payload.status === 'string' ? payload.status : undefined,
                })
                sendJson(res, 200, {
                  ok: true,
                  thread: written.thread,
                  row: written.row,
                  replaced: written.replaced,
                  warnings: validateThreadPatch(payload),
                })
                return
              }
              if (route === '/event') {
                if (typeof payload.content !== 'string') {
                  sendJson(res, 400, { error: '需要 content 字符串' })
                  return
                }
                if (typeof payload.line !== 'string' || !payload.line.trim()) {
                  sendJson(res, 400, { error: '需要 line（哪条事件线）' })
                  return
                }
                const written = await writeEventLine(rootNow(), payload.line.trim(), payload.content)
                sendJson(res, 200, { ok: true, line: written.line, chars: written.chars })
                return
              }
              if (route === '/style-clone') {
                const reference = typeof payload.source === 'string' ? payload.source.trim() : ''
                const inline = typeof payload.text === 'string' ? payload.text : ''
                if (!reference && !inline.trim()) {
                  sendJson(res, 400, { error: '需要 source（原文路径）或 text（原文）' })
                  return
                }
                const cloned = await cloneStyle(rootNow(), {
                  name: payload.name,
                  source: reference,
                  text: inline,
                  active: payload.active !== false,
                })
                sendJson(res, 200, { ok: true, ...cloned })
                return
              }
              if (route === '/style-active') {
                const next = typeof payload.name === 'string' ? payload.name.trim() : ''
                const saved = await activateStyle(rootNow(), next)
                sendJson(res, 200, { ok: true, style: saved })
                return
              }
              if (route === '/style-delete') {
                if (typeof payload.name !== 'string' || !payload.name.trim()) {
                  sendJson(res, 400, { error: '需要 name（删哪套文风）' })
                  return
                }
                try {
                  const removed = await deleteStyle(rootNow(), payload.name)
                  sendJson(res, 200, { ok: true, ...removed })
                } catch (error) {
                  sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
                }
                return
              }
              if (route === '/style') {
                if (typeof payload.content !== 'string') {
                  sendJson(res, 400, { error: '需要 content 字符串' })
                  return
                }
                if (typeof payload.name !== 'string' || !payload.name.trim()) {
                  sendJson(res, 400, { error: '需要 name（这套文风叫什么）' })
                  return
                }
                const written = await writeStyle(rootNow(), payload.name, payload.content)
                sendJson(res, 200, { ok: true, name: written.name, chars: written.chars, warnings: validateStyleContent(payload.content) })
                return
              }
              const started = await startChapter(rootNow(), payload.id)
              sendJson(res, 200, { ok: true, ...started })
              return
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { error: '只提供 GET' })
              return
            }
            if (route === '/state' || route === '/') {
              await reconcileHistory(rootNow(), { throttle: true })
              sendJson(res, 200, await snapshot())
              return
            }
            if (route === '/context') {
              const chapter = (url.searchParams.get('chapter') || '').trim()
              if (!chapter) { sendJson(res, 400, { error: '需要 chapter（哪一章）' }); return }
              const definition = toolDefs.get('novel_context')
              if (!definition) { sendJson(res, 500, { error: '装配包工具未注册' }); return }
              const mode = url.searchParams.get('mode') === 'rewrite' ? 'rewrite' : 'continue'
              const budget = Number(url.searchParams.get('budget')) || 12000
              try {
                const args = { chapter, mode, ...(budget ? { budget } : {}) }
                const value = await definition.execute(args, {})
                const rendered = (definition.output && typeof definition.output.render === 'function' ? definition.output.render(args, value) : [])
                  .map(part => (part && part.type === 'text' ? part.text : ''))
                  .filter(Boolean)
                  .join('\n')
                if (url.searchParams.get('format') === 'text') {
                  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
                  res.end(rendered)
                  return
                }
                sendJson(res, 200, {
                  chapter: value.chapter || { id: chapter },
                  mode: value.mode || mode,
                  chars: Array.from(rendered).length,
                  budgetUsed: value.budgetUsed || 0,
                  text: rendered,
                })
              } catch (error) {
                sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
              }
              return
            }
            if (route === '/chapter') {
              const { meta } = await loadBook(rootNow())
              const chapter = findChapter(meta.chapters, url.searchParams.get('id'))
              if (!chapter) {
                sendJson(res, 404, { error: 'no such chapter' })
                return
              }
              const content = (await readText(path.join(rootNow(), chapter.file))) ?? ''
              sendJson(res, 200, {
                id: chapter.id,
                title: chapter.title,
                chars: countChars(content),
                content,
              })
              return
            }
            if (route === '/characters') {
              const cards = await listCharacters(rootNow())
              const upto = (url.searchParams.get('chapter') ?? '').trim()
              const book = await loadBook(rootNow())
              const ids = (book.meta.chapters ?? []).map(item => item.id)
              const rawChapters = book.meta.chapters ?? []
              const seen = cards.some(card => card.cadence)
                ? await appearanceIndex(rootNow(), rawChapters, cards, book.meta.targetChars)
                : { last: new Map(), latestId: '' }
              sendJson(res, 200, {
                characters: cards,
                graph: characterGraph(cards, upto),
                upto,
                chapterIds: ids,
                appearance: appearanceReport(seen.last, cards, upto || seen.latestId),
              })
              return
            }
            if (route === '/outline') {
              const text = (await readText(path.join(rootNow(), OUTLINE_FILE))) ?? ''
              sendJson(res, 200, {
                present: text.trim().length > 0,
                chars: countChars(text),
                text,
                sections: splitOutline(text),
              })
              return
            }
            if (route === '/ai-tone') {
              const { meta } = await loadBook(rootNow())
              const wanted = url.searchParams.get('chapter')
              const chapter = wanted ? findChapter(meta.chapters, wanted) : null
              if (!chapter) {
                sendJson(res, 400, { error: wanted ? `没有这一章「${wanted}」` : '需要 chapter（哪一章）' })
                return
              }
              const raw = chapter.file ? (await readText(path.join(rootNow(), chapter.file))) ?? '' : ''
              const tone = detectAiTone(raw)
              sendJson(res, 200, {
                chapter: { id: chapter.id, title: chapter.title },
                chars: countChars(raw),
                total: tone.total,
                signals: tone.signals,
                rules: `${DEAI_RULES}\n\n${DEAI_WORKFLOW}`,
              })
              return
            }
            if (route === '/character-history') {
              const { meta } = await loadBook(rootNow())
              sendJson(res, 200, await updateHistory(rootNow(), meta.chapters, { action: 'inspect' }))
              return
            }
            if (route === '/stage') {
              const { meta } = await loadBook(rootNow())
              const chapter = findChapter(meta.chapters, url.searchParams.get('chapter'))
              if (!chapter) { sendJson(res, 404, { error: '章节不存在' }); return }
              sendJson(res, 200, await stageContext(rootNow(), meta.chapters, chapter.id, url.searchParams.get('scene') || undefined))
              return
            }
            if (route === '/beats') {
              const { meta } = await loadBook(rootNow())
              const wanted = url.searchParams.get('chapter')
              const chapter = wanted ? findChapter(meta.chapters, wanted) : null
              if (wanted && !chapter) {
                sendJson(res, 404, { error: `没有这一章「${wanted}」` })
                return
              }
              const board = await readBeats(rootNow(), chapter)
              const rhythm = await beatRhythm(rootNow(), meta.chapters)
              const castCards = await listCharacters(rootNow())
              sendJson(res, 200, {
                present: board.present,
                chapter: chapter ? { id: chapter.id, title: chapter.title } : null,
                text: board.section ? board.section.body : '',
                chars: board.section ? board.section.chars : 0,
                baseHash: stageHash((await readText(path.join(rootNow(), BEATS_FILE))) || ''),
                fields: { role: ROLE_FIELDS, scene: SCENE_FIELDS, chapter: CHAPTER_FIELDS },
                sections: board.sections.map(section => ({
                  id: section.id,
                  heading: section.heading,
                  chars: section.chars,
                  text: section.body,
                  scenes: section.scenes,
                  overview: { ...chapterOverview(section.body, section.id), reviewCount: section.scenes.flatMap(scene => presentationChecks(scene, castCards)).length },
                  payoff: section.marks.payoff.length,
                  labels: section.marks.payoff.map(item => item.label).filter(Boolean),
                  hook: section.marks.hook > 0,
                  turn: section.marks.turn,
                  infos: (section.infos ?? []).length,
                })),
                coverage: await beatsCoverage(rootNow(), meta.chapters),
                rhythm: {
                  payoff: rhythm.payoff,
                  withPayoff: rhythm.withPayoff,
                  withBeats: rhythm.withBeats,
                  hooks: rhythm.hooks,
                  turns: rhythm.turns,
                  longestGap: rhythm.longestGap,
                  currentGap: rhythm.currentGap,
                  gapLimit: rhythm.gapLimit,
                  budget: payoffBudget((await readText(path.join(rootNow(), OUTLINE_FILE))) ?? '')?.total ?? 0,
                  perChapter: rhythm.perChapter.map(item => ({ id: item.id, payoff: item.payoff, hook: item.hook, turn: item.turn })),
                },
              })
              return
            }
            if (route === '/events') {
              const { meta } = await loadBook(rootNow())
              const chapters = []
              for (const chapter of meta.chapters) chapters.push(await chapterStats(rootNow(), chapter, meta.targetChars))
              const eventBoard = await readEvents(rootNow())
              const beatBoard = await readBeats(rootNow(), null)
              const wanted = (url.searchParams.get('chapter') ?? '').trim()
              const spine = eventTimeline(eventBoard, wanted ? chapters.filter(item => item.id === wanted) : chapters, beatBoard.sections)
              sendJson(res, 200, {
                present: spine.present,
                text: eventBoard.text,
                lines: spine.lines,
                chapters: spine.chapters,
                warnings: spine.warnings,
                lineCount: spine.lineCount,
                eventCount: spine.eventCount,
                done: spine.done,
              })
              return
            }
            if (route === '/event') {
              const lineId = (url.searchParams.get('line') ?? '').trim()
              const board = await readEvents(rootNow())
              const line = board.lines.find(item => item.id === lineId || item.name === lineId)
              if (!line) {
                sendJson(res, 404, { error: 'no such line' })
                return
              }
              sendJson(res, 200, {
                line: line.id,
                name: line.name,
                goal: line.goal,
                span: line.span,
                events: line.events,
              })
              return
            }
            if (route === '/character') {
              const content = await readCharacter(rootNow(), url.searchParams.get('name'))
              if (content === null) {
                sendJson(res, 404, { error: 'no such character' })
                return
              }
              sendJson(res, 200, { name: url.searchParams.get('name'), ...cardIdentity(content), chars: countChars(content), content })
              return
            }
            if (route === '/settings') {
              sendJson(res, 200, { settings: await listSettings(rootNow()) })
              return
            }
            if (route === '/setting') {
              const name = url.searchParams.get('name')
              const content = await readSetting(rootNow(), name)
              if (content === null) {
                sendJson(res, 404, { error: 'no such setting' })
                return
              }
              const sample = await readStyleSample(rootNow(), name)
              sendJson(res, 200, { name, chars: countChars(content), content, sample: { present: sample.present, chars: sample.chars } })
              return
            }
            if (route === '/threads') {
              const threads = await loadThreads(rootNow())
              const { meta: threadMeta } = await loadBook(rootNow())
              const threadStats = []
              for (const chapter of threadMeta.chapters) threadStats.push(await chapterStats(rootNow(), chapter, threadMeta.targetChars))
              const latest = latestWrittenId(threadStats.filter(item => item.written))
              sendJson(res, 200, { ...threads, rows: decorateThreads(threads.rows, latest), latest })
              return
            }
            if (route === '/history') {
              const wanted = url.searchParams.get('chapter') ?? ''
              if (!wanted.trim()) {
                sendJson(res, 400, { error: '需要 chapter（哪一章）' })
                return
              }
              const { meta: historyMeta } = await loadBook(rootNow())
              const chapter = findChapter(historyMeta.chapters, wanted)
              if (!chapter) {
                sendJson(res, 404, { error: `没有这一章「${wanted}」` })
                return
              }
              await reconcileHistory(rootNow(), { throttle: true })
              const currentText = (await readText(path.join(rootNow(), chapter.file))) ?? ''
              sendJson(res, 200, {
                chapter: { id: chapter.id, title: chapter.title, chars: countChars(currentText) },
                current: { chars: countChars(currentText), hash: shortHash(currentText) },
                versions: await listHistory(rootNow(), chapter.id),
              })
              return
            }
            if (route === '/style-fit') {
              const wanted = (url.searchParams.get('chapter') || '').trim()
              if (!wanted) {
                sendJson(res, 400, { error: '需要 chapter（哪一章）' })
                return
              }
              const { meta: fitMeta } = await loadBook(rootNow())
              const hit = findChapter(fitMeta.chapters, wanted)
              if (!hit) {
                sendJson(res, 404, { error: '没有这一章 ' + wanted })
                return
              }
              const fitStyleName = activeStyleName(fitMeta)
              const fitCard = fitStyleName ? await readStyle(rootNow(), fitStyleName) : null
              if (!fitCard) {
                sendJson(res, 400, { error: '这本书还没有在用文风卡' })
                return
              }
              const fitBody = (await readText(path.join(rootNow(), hit.file))) ?? ''
              const fitSampleRoute = await readStyleSample(rootNow(), fitStyleName)
              const fit = styleFit(fitBody, fitCard, fitSampleRoute && fitSampleRoute.present ? fitSampleRoute.text : "")
              sendJson(res, 200, {
                chapter: { id: hit.id, title: hit.title },
                style: fitStyleName,
                ok: fit.ok,
                rows: fit.rows,
                flagged: fit.flagged,
              })
              return
            }
            if (route === '/download') {
              const rel = (url.searchParams.get('file') || '').trim()
              if (!rel) {
                sendJson(res, 400, { error: '需要 file（导出文件路径）' })
                return
              }
              const bookRoot = rootNow()
              const target = path.resolve(bookRoot, rel)
              const exportRoot = path.resolve(bookRoot, 'export')
              if (target !== exportRoot && !target.startsWith(exportRoot + path.sep)) {
                sendJson(res, 403, { error: '只能下载 export/ 里的文件' })
                return
              }
              let data
              try {
                data = await fsp.readFile(target)
              } catch {
                sendJson(res, 404, { error: '文件不存在' })
                return
              }
              const fileName = path.basename(target)
              const type = /\.md$/iu.test(fileName) ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
              res.writeHead(200, {
                'content-type': type,
                'content-length': String(data.length),
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
                'cache-control': 'no-store',
              })
              res.end(data)
              return
            }
            if (route === '/audit') {
              sendJson(res, 200, await auditBook(rootNow()))
              return
            }
            if (route === '/history-all') {
              const { meta: historyMeta } = await loadBook(rootNow())
              const chapters = []
              for (const chapter of historyMeta.chapters) {
                const versions = await listHistory(rootNow(), chapter.id)
                chapters.push({
                  id: chapter.id,
                  title: chapter.title,
                  status: chapter.status,
                  versions: versions.length,
                  lastAt: versions.length ? versions[0].createdAt : '',
                  lastChars: versions.length ? versions[0].chars : 0,
                })
              }
              sendJson(res, 200, { chapters })
              return
            }
            if (route === '/version') {
              const wanted = url.searchParams.get('chapter') ?? ''
              const version = (url.searchParams.get('version') ?? '').trim()
              if (!wanted.trim() || !version) {
                sendJson(res, 400, { error: '需要 chapter 和 version' })
                return
              }
              const { meta: historyMeta } = await loadBook(rootNow())
              const chapter = findChapter(historyMeta.chapters, wanted)
              if (!chapter) {
                sendJson(res, 404, { error: `没有这一章「${wanted}」` })
                return
              }
              const target = await readVersion(rootNow(), chapter.id, version)
              if (!target) {
                sendJson(res, 404, { error: `没有这一版「${version}」` })
                return
              }
              sendJson(res, 200, {
                chapter: { id: chapter.id, title: chapter.title },
                version: target.version,
                chars: target.chars,
                content: target.content,
                meta: target.meta,
              })
              return
            }
            if (route === '/styles') {
              const { meta: styleMeta } = await loadBook(rootNow())
              const active = activeStyleName(styleMeta)
              const items = await listStyles(rootNow())
              sendJson(res, 200, {
                active,
                styles: items.map(item => ({ name: item.name, chars: item.chars, sampleChars: item.sampleChars, summary: item.summary, active: item.name === active })),
              })
              return
            }
            if (route === '/style-sample') {
              const name = url.searchParams.get('name') ?? ''
              if (!name.trim()) {
                sendJson(res, 400, { error: '需要 name（哪套文风）' })
                return
              }
              const sample = await readStyleSample(rootNow(), name)
              if (!sample.present) {
                sendJson(res, 404, { error: 'no such sample' })
                return
              }
              // 页面只回前 6000 字：参考原文是给眼睛比对句子用的，不是给前端全文搬运的。
              const LIMIT = 6000
              const chars = Array.from(sample.text)
              const cut = chars.length > LIMIT
              sendJson(res, 200, {
                name,
                chars: sample.chars,
                truncated: cut,
                text: cut ? `${chars.slice(0, LIMIT).join('')}\n\n……（后面还有 ${chars.length - LIMIT} 字，完整原文在 styles/${name}.sample.md）` : sample.text,
              })
              return
            }
            if (route === '/style') {
              const name = url.searchParams.get('name') ?? ''
              if (!name.trim()) {
                sendJson(res, 400, { error: '需要 name（哪套文风）' })
                return
              }
              const content = await readStyle(rootNow(), name)
              if (content === null) {
                sendJson(res, 404, { error: 'no such style' })
                return
              }
              const sample = await readStyleSample(rootNow(), name)
              sendJson(res, 200, { name, chars: countChars(content), content, sample: { present: sample.present, chars: sample.chars } })
              return
            }
            sendJson(res, 404, { error: `unknown route ${route}` })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          })
        },
      }),
    'novel: api route',
  )
}

/** 读一个 JSON 请求体，超限直接拒绝（本插件只收极小的控制指令）。 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** 从人物卡里抠出「旧称 / 别名」这类登记行，供自检比对。 */

/** 说话人候选：中文小说里「某某说／道／问／点头」这类句式最稳，比全篇分词靠谱。 */
const SPEAKER_STOPWORDS = new Set([
  '有人', '大家', '众人', '对方', '那人', '此人', '男人', '女人', '老人', '少年', '少女', '孩子',
  '别人', '我们', '他们', '她们', '你们', '咱们', '自己', '人家', '两人', '二人', '三人', '一人',
  '于是', '然后', '接着', '最后', '这时', '此时', '忽然', '突然', '终于', '只是', '但是', '而且',
  '所以', '因此', '同时', '声音', '语气', '心里', '门外', '屋里', '身后', '窗', '门口', '柜台',
])

/** 说话人候选里混进来的不是人名，而是「那人不」「她没」「街坊都」这种，用虚词表剔掉。 */
const SPEAKER_BLOCK = /[不没的了也都才又就还再便正已却把他她它我你您咱那这其每各某和跟与在是有要会能]/u

// 「她说道」「低声音问道」「着嗓子喊」这类半截词，靠首尾字把它挡掉。
// 注意：这里刻意不挡「老 / 小 / 大」（老周、小林都是真名），只挡虚词和描述性语素。
const SPEAKER_START_BLOCK = /^[着过说问道答喊叫吼声嗓音低高轻重缓急冷热哭笑怒叹皱摇点心神身手里外前后上下这那么些很更最也还就又才便却]/u
const SPEAKER_END_BLOCK = /[说问道答喊叫吼着了过声嗓音的嘴头手眼脸眉肩腿脚身心气口牙拳步忙紧快慢然后起来去走站坐转抬低叫骂斥叱讥嘲愣怔顿沉冷淡微轻缓深]/u

// 还有一类漏网的：名字被从中间切断（「陈健基笑骂道」切出「基笑骂」）。
// 判据：这段字出现在已知人物名的尾部，就不是新人名。
const looksLikeTailOfKnown = (name, knownNames) => [...knownNames].some(item => item !== name && item.endsWith(name))

// ── 「去 AI 味」检测 ─────────────────────────────────────────────
// 规则抽自 qu-ai-wei（MIT）的 pattern catalog，只保留机器能判定的部分：
// 「这段像不像 AI 写的」这种整体判断不给机器做，只报可数、可指认的信号。



/**
 * @returns {{ signals: Array<{ kind: string, label: string, count: number, samples: string[] }>, total: number }}
 */

/** 由会话模型结合完整场景审查对白，代码不推断人物意图或替换台词。 */

const DEAI_REVIEW_VERSION = 6

const REVIEW_EVIDENCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    source: { type: 'string', enum: Object.keys(REVIEW_SOURCE_ROLES) },
    name: { type: 'string', description: 'character/setting/style 的实际条目名，不能填写路径；其他来源省略' },
    index: { type: 'integer', minimum: 1, description: 'chapter 来源必填，使用审稿包的段号；其他来源省略' },
    quote: { type: 'string', minLength: 1, description: '逐字短引文，不能用省略号拼接或把推断写成原文' },
  },
  required: ['source', 'quote'],
}

const REVIEW_EVIDENCE_RULES = [
  '计算前先核对变量含义、传递关系与适用条件：螺杆行程减少三成不自动等于表盘读数减少三成，不能未经设定支持套用倒数、线性或叠乘公式。圈数与行程比例可描述同一对象的不同属性，不能仅因量纲不同就判矛盾；也不能为保住既定结论反推修改原文数字。',
  '人物卡描述性格倾向，不是每场必须执行的动作清单；危急时敢拉闸不等于遇到锁死总闸也必须去拉。核对机会、认知、现场条件与替代行为，不为兑现标签新增动作。读数、观察、推断与记录来源分开：仪器不能直接读出的结论可能来自既有知识或其他证据，缺来源时指出缺口，不自动补造某份历史记录。',
  '没有单步耗时本身不是缺陷，允许用明示阶段时长覆盖阶段内动作，不要求小说逐步标时。时间审稿仍需核对窗口边界、动作顺序和串并行；有具体冲突或缺少影响判断的关键依据时指出对应区间与关系，不以动作数量多、缺少逐步数字直接阻塞，也不把算术相容扩大为动作可行。修改建议是候选，不宣称改变指称、观察或反应必然不改变事实。',
  '逐条发现填 observations，无发现填 []。每条提交 aspect/classification/detail/evidence/counterargument；classification 分 conflict（确定矛盾）、missing-basis（缺失依据）、preference（可选表达偏好）。conflict 另填 comparison 的 entity/property/timeScope，至少两条不同证据，说明同一对象、同一属性与可比较时间。checks 中的 conflict/uncertain 须有对应观察；表达偏好单列为非阻塞项。字段齐全不证明分类正确。',
  '来源有不同角色：chapter 是当前文本，setting 是声明规则，character 是人物资料，style 是表达约束，beats/outline/events 是剧情计划，threads 可能混有计划与历史备忘。人物说法不是自动的作者事实，计划不是既成事实，旧备忘不自动高于正文；来源差异先记 missing-basis，不自行决定修改哪份资料。',
  '判断矛盾前排除同名异物、属性不同、时间变化和正常观察。桩与链等不同物件的数量不能直接比较；“新”或留有指印不提供精确日期；角色可以说出自己的观察，不需要其他人先说过。工程推断须有依据，浮油本身不能证明下层物体不接水，两条通路也可能互补；缺少依据不能冒充确认矛盾。',
  '跨场追踪关键物件的位置与状态：持有、佩戴、装填、文字是否已填写、温度以及交接。重点核对已填单据变空白、脱下物件再次佩戴、卡住物件直接被携带等跳变；不要求为所有日常动作逐步报幕，省略是否影响读懂仍由模型判断。',
  '证据审稿：checks 每项填写 verdict/detail/evidence/counterargument。verdict 取 supported（有依据支持）、conflict（确认矛盾）、uncertain（依据不足）、not-applicable（不适用）。发现问题也可以登记，conflict/uncertain 会保存为阻塞项，不能用空泛肯定句替代判断。',
  '每项至少引用一条当前正文，格式 {source:"chapter",index:段号,quote:"逐字短引文"}；确认矛盾至少提供两条不同引文。可另引 beats/outline/events/threads；人物、设定、文风用 {source:"character"或"setting"或"style",name:"实际条目名",quote:"逐字短引文"}，先读取相应资料。工具会核对原文和段号并绑定来源版本，回显来源角色，不据此认证权威。',
  'counterargument 写最可能推翻当前结论的原文、缺失依据或替代解释及处理结果。连接、状态与危险禁令要比较前后证据；时间只能使用已有单位和数量，不把常识估算当设定，不编造距离、长度、级数或耗时。修法是提案，不是现成事实；影响后文需读后文，未读不得宣称无影响。',
  '问题顺序固定为连续性与技术因果、时间、事实与信息缺失、对白、叙述及句段。外貌锚点数量、词频、没有打断的独白本身不构成硬伤；没有明确要求不得当强制修改项。上下文缺失记 uncertain，不能补造设定后提交 supported。',
  'timeBudgets 必填，无明确窗口用 []；有窗口时提交 label/unit/availableText/evidence/phases。availableText 必须是引文中的同单位时间，如“六息”。每阶段提交 parallel/evidence/tasks，每任务提交 label/basis/evidence；stated 要有 duration 和逐字 durationText，estimated 的 duration 只能作估算，unknown 不填数字。阶段顺序相加，并行取最长值；不自动换算单位。估算或未知只限定记账范围，不自动证明正文有缺陷；不得用它们认证物理可行，也不单凭它们阻塞。',
  '时间数量必须区分角色：“还剩六息”是剩余量，“第九息”是时点，都不等于某操作耗时。stated 的引文须明确表达经过时间、操作用时或所需时长；工具会结合真实位置的上下文检查，不能只摘出“六息”隐藏“还剩”。角色无法确定时保存 uncertain，不把剩余量或截止时点直接相加来证明动作放得下，也不要求为消除阻塞向正文补造时长。',
  '对应维度的 supported 必须覆盖审稿包 sourceRequirements：voice 引用实际出场人物卡，narration/rhythm 引用当前文风卡，facts 引用正文点名的设定。其他维度的引用不抵扣，缺少来源由工具标 uncertain。来源覆盖不证明资料支持结论。',
  '工具会回显所有引文所在的完整段落，包括 supported；检查完整段落中的反例，不得只引用末句遮住前文。正文重复出现相同短句时按段号定位；其他资料中的重复引文会回显所有匹配段落。',
  '输出契约：recorded 只表示模型判断已登记、当前没有已登记阻塞项，不能转述成“语义复核已通过”。timeBudgets 只校验时间记账，新增“三息过去了”不能证明动作真能完成。近似统计未命中不等于缺少自然反应，不为凑词频、身体动作密度或句号密度改稿。若作者只要求检查，保持正文不变并报告判断边界。',
].join('\n')

const SCENE_ACTION_FIELDS = {
  actor: '执行动作的人物或设备；同段多个执行者分别记录',
  from: '动作前的位置、姿态及接触对象，引用段号说明来源',
  to: '动作后的位置和状态；原地操作也要说明，不用瞬移跳过通路',
  action: '具体做了什么，动作如何完成',
  tools: '使用物件、手持状态、拿取或交接来源及对应段号；未使用工具则明确说明',
  prerequisites: '动作成立的先决条件、通路与既有设定依据，引用相应段号或已读取的设定条目',
  result: '直接产生的可见结果及如何承接下一步，状态变化必须有前因',
  timing: '动作与移动、取物、对白的先后或并行关系，是否容得进已知时间窗口',
  safety: '与已出现的危险和禁令是否相容，接触危险物的防护或例外是否已有依据；无此约束也需说明',
}

const SCENE_REVIEW_RULES = [
  '场景连续性钩子：先按全文顺序分场，再逐步还原人物与设备的位置、姿态、持物和状态。不得用未写出的拿取、移动、入水或防护步骤替原文圆场。',
  '每场用 scenes 记录连续的 startIndex/endIndex、layout（布局）、mechanism（异常—措施—去向—结果）、timeline（含移动、取物和对白的完整时间线）与 actions。关键动作逐条填写 index 及 actor/from/to/action/tools/prerequisites/result/timing/safety；同段多动作分别记录，转场承接上一场状态。纯静态段落允许空 actions，但布局与时间线需说明依据。',
  '追踪工具从哪里来、由谁拿取或交接、是否够得着；追踪湿衣、伤口、姿态变化的前因；核对先前危险禁令与后续接触行为，不能无依据忽然安全。',
  '核对救险或技术操作的主要因果链，说明每个辅助操作的必要作用、能量或物质的去向与既有设定依据。不要用术语、动作堆叠或巧合代替机制；不得为简化而改变已确认的设定。',
  '把所有移动、对白、拿取和操作放进同一时间窗口，区分谁在同时做什么，不把一息擅自换算成一秒。原稿有矛盾时先指出并修订；设定不足以确定修法时向作者澄清，不能编造前提后登记完成。',
  '复核信息投放：紧张场景先给读者理解当前动作所需的信息，完整体系讲解按情节需要放置；挪动说明不能让关键操作失去依据。检查对称格言、逐项报幕和旁白总结是否替代现场；正常排比可保留。',
  '检查接口、器官与感官反应的对应和先后是否有设定依据，不凭数量相同就安排一一对应或逐项亮起；判断异常感知是在演示机制还是机械报幕，不把某一种身体描写设为全书禁用。',
  '篇幅规则：目标字数仅供参考，超出是正常写作结果，不触发删字、缩写、提前结束或强行分章。保留空间过渡、工具来源、动作前提、因果桥梁和读者必需的信息；是否分章由情节自然节点决定，不能把当前因果链拆散。上下文预算只限制工具装配，不限制正文长度。',
].join('\n')

/** 写作约束与审稿钩子共用，避免只在改写后补救。 */

const DEAI_WORKFLOW = '生成或改写前先核对 novel_context 内的 materialPreflight，或单独调用 novel_preflight({chapter})。区分剧情计划、表达约束和可能过时的备忘，计划原句不默认照抄；有分歧先核实意图，不擅自覆盖资料。审稿先调用 novel_deai_pack({chapter}) 阅读全文、资料及各维度 sourceRequirements。先查空间因果和物件状态，再查时间与信息缺失，最后审表达；目标字数仅供参考，超出不缩写。用 novel_deai_review({chapter,baseHash,checks,observations,timeBudgets,scenes,paragraphs}) 如实登记：checks 提交 verdict/detail/evidence/counterargument 并在对应维度引用所需资料；observations 逐条区分 conflict、missing-basis、preference，无发现填 []。conflict 须比较同一对象、同一属性和可比较时间，填写 comparison 并引用至少两条证据；仅历史备忘与正文不一致先记缺失依据，偏好不阻塞。timeBudgets 提交明示时间窗口和串并行任务，区分明示、估算、未知，无窗口填 []；scenes 和 paragraphs 覆盖全文。工具核算记账、检查来源覆盖并回显完整引文和来源角色。已登记的矛盾与具体依据不足、明示超时或无效记账依据可阻塞定稿，不单凭估算或未知耗时阻塞，即使 checks 写 supported。需要修改时在已获授权范围内修订并重新取包。旧阻塞项转为通过填写 resolutions。最后运行 novel_check；正文、引用资料、来源覆盖要求或启用文风变化后旧记录失效。登记、计算和引用校验不认证动作可行或文章自然。'

const DEAI_REVIEW_ASPECTS = {
  continuity: '结合 scenes 动作链核对人物与设备位置、转场路线、工具来源、状态变化前因、技术因果和安全禁令，确认读者能连续还原现场，不能用脑补步骤消解矛盾。',
  timing: '核对倒计时与动作、观察、解释、交涉是否相容，指出具体段落依据；无倒计时也检查场景时间。',
  voice: '对照场景、人物认知、关系与说话目的，检查对白是否当场听得懂、是否为了狠话而生硬压缩，检查角色是否雷同；逐段提交 dialogue 判断，未匹配人物卡时先补读。',
  narration: '检查紧张场景的体系讲解是否打断现场，细节堆叠、旁白解释、标签重复与总结是否替代情节；检查数量对应和感官亮灯是否有设定依据，说明保留理由。',
  rhythm: '对照文风锚点检查固定句段模板、工整对称、逐项报幕、冲突与对白是否生硬；无文风卡时明确说明，不因篇幅超出强制缩写。',
  facts: '核对事实、意图、因果、数字和信息点；尤其检查空间过渡、工具来源、动作前提和后果是否被缩写省略。区分已确认事实与原稿矛盾，修法不明先澄清，不编造补丁。',
}

/** 验证场景记录的结构与全文覆盖，物理和语义判断由会话审稿负责。 */
function hasCompleteSceneReviews(scenes, totalItems) {
  if (!Array.isArray(scenes) || !scenes.length) return false
  let nextIndex = 1
  for (const scene of scenes) {
    if (!scene || scene.startIndex !== nextIndex || !Number.isInteger(scene.endIndex) || scene.endIndex < scene.startIndex || scene.endIndex > totalItems) return false
    if (['layout', 'mechanism', 'timeline'].some(key => typeof scene[key] !== 'string' || !scene[key].trim()) || !Array.isArray(scene.actions)) return false
    let actionIndex = scene.startIndex
    for (const action of scene.actions) {
      if (!action || !Number.isInteger(action.index) || action.index < actionIndex || action.index > scene.endIndex) return false
      if (Object.keys(SCENE_ACTION_FIELDS).some(key => typeof action[key] !== 'string' || !action[key].trim())) return false
      actionIndex = action.index
    }
    nextIndex = scene.endIndex + 1
  }
  return nextIndex === totalItems + 1
}

function hasCompleteReviewChecks(checks) {
  return Object.keys(DEAI_REVIEW_ASPECTS).every(key => {
    const check = checks?.[key]
    return check && ['supported', 'conflict', 'uncertain', 'not-applicable'].includes(check.verdict)
      && ['detail', 'counterargument'].every(field => typeof check[field] === 'string' && check[field].trim())
      && Array.isArray(check.evidence) && check.evidence.length > 0
      && check.evidence.some(reference => reference?.source === 'chapter')
      && check.evidence.every(reference => reference && typeof reference.quote === 'string' && reference.quote.trim())
      && (check.verdict !== 'conflict' || new Set(check.evidence.map(reference => JSON.stringify([reference.source, reference.name ?? '', reference.index, reference.quote]))).size >= 2)
  })
}

/** 严重程度由工具固定排序，不能让外貌等补充项挤到因果矛盾之前。 */
function reviewFindings(checks, observations = []) {
  return ['continuity', 'timing', 'facts', 'voice', 'narration', 'rhythm']
    .filter(aspect => ['conflict', 'uncertain'].includes(checks[aspect].verdict))
    .filter(aspect => !(Array.isArray(observations) ? observations : []).some(item => item.aspect === aspect && item.classification !== 'preference'))
    .map(aspect => ({ ...checks[aspect], aspect }))
}

/** 分类和证据门槛可校验，比较对象是否真正相同仍需语义判断。 */
function reviewObservations(observations, checks) {
  if (!hasCompleteReviewChecks(checks) || !Array.isArray(observations)) throw new Error('必须提交完整 checks 与逐条分类的 observations；无观察填 []')
  const findings = [], notes = [], evidence = []
  for (const item of observations) {
    if (!item || !Object.hasOwn(DEAI_REVIEW_ASPECTS, item.aspect) || !['conflict', 'missing-basis', 'preference'].includes(item.classification)
      || ['detail', 'counterargument'].some(key => typeof item[key] !== 'string' || !item[key].trim()) || !Array.isArray(item.evidence) || !item.evidence.length) throw new Error('每条观察必须单独分类并填写维度、说明、证据和反证；不能混合标签')
    if (item.classification === 'conflict') {
      if (!item.comparison || ['entity', 'property', 'timeScope'].some(key => typeof item.comparison[key] !== 'string' || !item.comparison[key].trim())) throw new Error('确认矛盾必须明确同一对象、同一属性与可比较时间范围')
      const distinct = new Set(item.evidence.map(reference => JSON.stringify([reference?.source, reference?.name, reference?.index, reference?.quote])))
      if (distinct.size < 2) throw new Error('确认矛盾至少需要两条不同的逐字证据')
      const sources = new Set(item.evidence.map(reference => reference?.source))
      if (sources.size === 2 && sources.has('threads') && sources.has('chapter')) throw new Error('仅凭正文与历史备忘的来源差异不能自动裁定谁错，请分类为 missing-basis 并说明待核实的口径')
    }
    evidence.push(...item.evidence.map(reference => ({ aspect: item.aspect, reference })))
    if (item.classification === 'preference') notes.push(item)
    else findings.push({ ...item, verdict: item.classification === 'conflict' ? 'conflict' : 'uncertain' })
  }
  for (const aspect of Object.keys(DEAI_REVIEW_ASPECTS)) {
    const verdict = checks[aspect].verdict
    if (verdict === 'conflict' && !observations.some(item => item.aspect === aspect && item.classification === 'conflict')) throw new Error(`${aspect} 的确认矛盾必须有对应 conflict 观察，表达偏好不能充当硬伤`)
    if (verdict === 'uncertain' && !observations.some(item => item.aspect === aspect && item.classification !== 'preference')) throw new Error(`${aspect} 的依据不足必须有逐条观察说明`)
  }
  return { findings, notes, evidence }
}

function sortReviewFindings(findings) {
  const order = ['continuity', 'timing', 'facts', 'voice', 'narration', 'rhythm']
  return [...findings].sort((left, right) => order.indexOf(left.aspect) - order.indexOf(right.aspect))
}

/** 状态直接取工具结果，阻塞计数不等同于自动确认的正文错误数。 */
function renderReviewStatus(status, findings) {
  const conflicts = findings.filter(item => item.verdict === 'conflict').length
  const uncertain = findings.filter(item => item.verdict === 'uncertain').length
  return `status: ${status}；certifiesSemantics: false；已登记阻塞 ${findings.length} 项（conflict: ${conflicts}，uncertain: ${uncertain}）。${status === 'pending' ? '当前版本待重新登记。' : status === 'untracked' ? '直接检查文本，未核验章节审稿记录。' : status === 'blocked' ? '已登记且存在阻塞项。' : '当前无已登记阻塞项，仍不认证语义正确。'}`
}

/** 只解析同一单位的明示表达，不进行单位换算或估计动作耗时。 */
function reviewTimeValue(literal, unit) {
  const text = String(literal ?? '').replace(/\s+/gu, '')
  const suffix = text.endsWith('半') && text !== `半${unit}` ? 0.5 : 0
  const body = suffix ? text.slice(0, -1) : text
  if (!unit || !body.endsWith(unit)) return NaN
  const amount = body.slice(0, -unit.length)
  if (amount === '半') return suffix ? NaN : 0.5
  if (/^\d+(?:\.\d+)?$/u.test(amount)) return Number(amount) + suffix
  if (!/^[零〇一二两三四五六七八九十百千万]+$/u.test(amount)) return NaN
  if (/[一二两三四五六七八九][零〇一二两三四五六七八九]/u.test(amount) || /[百千万][一二两三四五六七八九]$/u.test(amount) || (amount.match(/万/gu) ?? []).length > 1) return NaN
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let total = 0, section = 0, digit = 0, previousUnit = 10000
  for (const character of amount) {
    if (character in digits) digit = digits[character]
    else if (character === '万') { total += (section + digit || 1) * 10000; section = 0; digit = 0; previousUnit = 10000 }
    else {
      const multiplier = ({ 十: 10, 百: 100, 千: 1000 })[character]
      if (multiplier >= previousUnit) return NaN
      section += (digit || 1) * multiplier
      digit = 0
      previousUnit = multiplier
    }
  }
  return total + section + digit + suffix
}

/** 按被引用位置辨别数量角色；不明确时不能把它当作耗时。 */
function reviewDurationRole(literal, references, packed, contexts) {
  const roles = new Set()
  for (const reference of references) {
    if (typeof reference?.quote !== 'string' || !reference.quote.includes(literal)) continue
    const context = reference.source === 'chapter'
      ? packed?.items.find(item => item.index === reference.index)?.text
      : contexts.find(item => item.source === reference.source && item.name === reference.name && item.context.includes(reference.quote))?.context
    const text = context ?? reference.quote
    for (let quoteAt = text.indexOf(reference.quote); quoteAt >= 0; quoteAt = text.indexOf(reference.quote, quoteAt + reference.quote.length)) {
      for (let offset = reference.quote.indexOf(literal); offset >= 0; offset = reference.quote.indexOf(literal, offset + literal.length)) {
        const position = quoteAt + offset
        const before = text.slice(Math.max(0, position - 20), position)
        const after = text.slice(position + literal.length, position + literal.length + 10)
        if (/(?:还剩|只剩|剩下|剩余|余下|尚余|仅余|尚有|还有)\s*$/u.test(before)) roles.add('remaining')
        else if (/第\s*$/u.test(before)) roles.add('checkpoint')
        else if (/(?:最多|至少|撑不过|限时|不超过|不到|约|大约|差不多)\s*$/u.test(before) || /^(?:之内|以内)/u.test(after)) roles.add('limit')
        else if (/(?:并非|不是|并未|没有|未曾)[^。！？\n]{0,8}$/u.test(before)) roles.add('unknown')
        else if (/(?:过了|用了|用去|耗去|耗时|用时|花了|花费|持续|需要)(?:足足|整整)?[：:\s]*$/u.test(before) || /^(?:过去了|过去|已过|后才)/u.test(after)) roles.add('elapsed')
        else roles.add('unknown')
      }
    }
  }
  return roles.size === 1 ? [...roles][0] : 'unknown'
}

function calculateReviewTimeBudgets(budgets, packed, checks, contexts = []) {
  if (!Array.isArray(budgets)) throw new Error('必须提交 timeBudgets；无明确窗口时填 []，不得编造耗时')
  const reports = [], findings = [], evidence = []
  const collect = references => {
    if (!Array.isArray(references)) throw new Error('时间预算的 evidence 必须是数组')
    evidence.push(...references.map(reference => ({ aspect: 'timing', reference })))
  }
  const quoted = (literal, references) => references.some(reference => typeof reference?.quote === 'string' && reference.quote.includes(literal))
  if (!budgets.length && checks?.timing?.verdict === 'supported') {
    const pattern = /(?:还剩|只剩|剩下|撑不过|限时|最多)\s*[零〇一二两三四五六七八九十百千万\d.]+\s*(?:息|秒|分钟|小时|天|刻钟)|[零〇一二两三四五六七八九十百千万\d.]+\s*(?:息|秒|分钟|小时|天|刻钟)(?:之内|以内)/u
    const candidates = (packed?.items ?? []).filter(item => pattern.test(item.text))
    if (candidates.length) {
      const references = candidates.map(item => ({ source: 'chapter', index: item.index, quote: item.text }))
      collect(references)
      findings.push({ aspect: 'timing', verdict: 'uncertain', detail: '原文存在候选时间窗口，但 timeBudgets 为空，不能仅凭文字判断提交确定通过。请核对窗口并列出预算；确实不适用时说明依据。', evidence: references, counterargument: '候选表达不等于已经确认的倒计时，仍需模型判断其语境。' })
    }
  }
  for (const budget of budgets) {
    if (!budget || typeof budget.label !== 'string' || !budget.label.trim() || typeof budget.unit !== 'string' || !budget.unit.trim() || !Array.isArray(budget.phases) || !budget.phases.length) throw new Error('时间窗口必须填写名称、单位与阶段')
    collect(budget.evidence)
    const available = reviewTimeValue(budget.availableText, budget.unit)
    if (!Number.isFinite(available) || available <= 0 || !quoted(budget.availableText, budget.evidence)) throw new Error('可用时间必须是 evidence 中的逐字时间表达，且单位一致')
    let total = 0, minimum = 0, uncertain = false, invalidBasis = false, operations = 0
    const uncertainties = []
    for (const phase of budget.phases) {
      if (!phase || typeof phase.parallel !== 'boolean' || !Array.isArray(phase.tasks) || !phase.tasks.length) throw new Error('时间阶段必须声明 parallel 并列出任务')
      collect(phase.evidence)
      operations += phase.tasks.length + 1
      if (phase.parallel && !phase.evidence.length) { uncertain = true; invalidBasis = true; uncertainties.push('并行阶段缺少原文依据') }
      const values = [], known = []
      for (const task of phase.tasks) {
        if (!task || typeof task.label !== 'string' || !task.label.trim() || !['stated', 'estimated', 'unknown'].includes(task.basis)) throw new Error('每个时间任务必须注明名称和 stated/estimated/unknown 依据')
        collect(task.evidence)
        if (!task.evidence.length) throw new Error('时间任务必须引用对应动作的原文')
        if (task.basis === 'unknown') {
          if (task.duration !== undefined || task.durationText !== undefined) throw new Error('未知耗时不能填写伪精确数值')
          uncertain = true; uncertainties.push(`「${task.label}」耗时未知`); values.push(0); known.push(0); continue
        }
        if (!Number.isFinite(task.duration) || task.duration < 0) throw new Error('已知或估算耗时必须是非负有限数值')
        if (task.basis === 'stated') {
          if (reviewTimeValue(task.durationText, budget.unit) !== task.duration || !quoted(task.durationText, task.evidence)) throw new Error('明示耗时的数值、单位与逐字引文不一致')
          const role = reviewDurationRole(task.durationText, task.evidence, packed, contexts)
          if (role === 'elapsed') known.push(task.duration)
          else {
            uncertain = true
            invalidBasis = true
            known.push(0)
            const label = ({ remaining: '剩余时间', checkpoint: '时间点', limit: '时间上限或非精确量', unknown: '角色不明的时间量' })[role]
            uncertainties.push(`「${task.label}」引用的「${task.durationText}」属于${label}，不能据此证明操作耗时`)
          }
        } else { uncertain = true; uncertainties.push(`「${task.label}」是模型估算`); known.push(0) }
        values.push(task.duration)
      }
      const aggregate = values => values.reduce((sum, value) => phase.parallel ? Math.max(sum, value) : sum + value, 0)
      total += aggregate(values)
      minimum += aggregate(known)
    }
    if (!Number.isFinite(total) || !Number.isFinite(minimum)) throw new Error('时间预算数值超出可计算范围')
    const tolerance = Number.EPSILON * Math.max(1, available, total) * Math.max(4, operations)
    reports.push({ label: budget.label, unit: budget.unit, available, total, minimum, uncertain, uncertainties, scope: 'arithmetic-only', feasibility: 'not-automatically-verified' })
    if (total > available + tolerance && minimum <= available + tolerance) uncertainties.push('含估算的提交值超出窗口，只表示该估算假设下超限，不证明正文动作超时')
    // 未知或估算不证明正文有缺陷；明示超限和无效记账依据才自动产生阻塞。
    if (minimum > available + tolerance || invalidBasis) {
      findings.push({ aspect: 'timing', verdict: minimum > available + tolerance ? 'conflict' : 'uncertain', detail: `「${budget.label}」明示耗时下界 ${minimum}、提交值合计 ${total}、可用 ${available} ${budget.unit}。${uncertain ? uncertainties.join('；') : '明示耗时超过可用窗口。'}`, evidence: budget.evidence, counterargument: '剩余时间不是经过时间，不能用倒计时标记自证动作放得下；是否漏列动作、并行依据是否成立仍需语义复核。' })
    }
  }
  return { reports, findings, evidence }
}

/** 按维度要求对应资料，来源类型覆盖不等于语义支持。 */
async function reviewSourceCoverage(root, meta, raw, checks) {
  const requirements = [], findings = []
  const add = (aspect, source, name) => requirements.push({ aspect, source, name })
  for (const card of await listCharacters(root)) {
    const content = (await readCharacter(root, card.name)) ?? ''
    if ([card.name, ...parseCardAliases(content)].some(name => mentions(raw, name))) add('voice', 'character', card.name)
  }
  const styleName = activeStyleName(meta)
  if (styleName) { add('rhythm', 'style', styleName); add('narration', 'style', styleName) }
  for (const setting of await listSettings(root)) {
    if (mentions(raw, setting.name)) add('facts', 'setting', setting.name)
  }
  for (const requirement of requirements) {
    const check = checks?.[requirement.aspect]
    if (!check || check.verdict !== 'supported' || check.evidence.some(reference => reference.source === requirement.source && reference.name === requirement.name)) continue
    findings.push({ aspect: requirement.aspect, verdict: 'uncertain', detail: `本项宣告 supported，但缺少 ${requirement.source}:${requirement.name} 的逐字依据。请补读并引用，或如实登记依据不足。`, evidence: check.evidence, counterargument: '其他维度的引用不能代替本维度的来源；引用存在也不能证明结论成立。' })
  }
  return { requirements, findings }
}

async function readReviewSource(root, chapter, reference) {
  switch (reference.source) {
    case 'chapter': return await readText(path.join(root, chapter.file))
    case 'beats': return await readText(path.join(root, BEATS_FILE))
    case 'outline': return await readText(path.join(root, OUTLINE_FILE))
    case 'threads': return await readText(path.join(root, THREADS_FILE))
    case 'events': return await readText(path.join(root, EVENTS_FILE))
    case 'character': return await readCharacter(root, reference.name)
    case 'setting': return await readSetting(root, reference.name)
    case 'style': return await readStyle(root, reference.name)
    default: throw new Error(`未知审稿来源：${reference.source}`)
  }
}

/** 按真实字符位置提取完整段落，保留引文前后的原文。 */
function reviewEvidenceContext(text, start, end) {
  let from = 0, to = text.length
  for (const match of text.matchAll(/\r?\n[\t ]*\r?\n/gu)) {
    if (match.index + match[0].length <= start) from = match.index + match[0].length
    else if (match.index >= end) { to = match.index; break }
  }
  return text.slice(from, to)
}

/** 校验引文并提取上下文，不替代语义相关性判断。 */
async function validateReviewEvidence(root, chapter, packed, checks, additional = []) {
  if (!hasCompleteReviewChecks(checks)) throw new Error('每项 checks 必须提交 verdict/detail/evidence/counterargument，并引用正文；conflict 至少需要两条不同引文；未登记')
  const cache = new Map()
  const contexts = new Map()
  const byIndex = new Map(packed.items.map(item => [item.index, item]))
  const references = Object.keys(DEAI_REVIEW_ASPECTS).flatMap(aspect => checks[aspect].evidence.map(reference => ({ aspect, reference }))).concat(additional)
  for (const { aspect, reference } of references) {
    if (!reference || typeof reference.quote !== 'string' || !reference.quote.trim()) throw new Error('引用必须包含逐字原文')
    const named = ['character', 'setting', 'style'].includes(reference.source)
    if (named ? typeof reference.name !== 'string' || !reference.name.trim() : reference.name !== undefined) throw new Error('人物、设定、文风引用必须填写条目名，其他来源不要填写 name；未登记')
    const key = JSON.stringify([reference.source, reference.name ?? ''])
    if (!cache.has(key)) {
      const text = await readReviewSource(root, chapter, reference)
      if (text === null) throw new Error(`审稿引用来源不存在：${key}；未登记`)
      const hash = createHash('sha256').update(text).digest('hex')
      if (reference.source === 'chapter' && hash !== packed.baseHash) throw new Error('正文已变化，请重新取审稿包；未登记')
      cache.set(key, { text, source: reference.source, role: REVIEW_SOURCE_ROLES[reference.source].role, ...(named ? { name: reference.name } : {}), hash })
    }
    const source = cache.get(key)
    if (!source.text.includes(reference.quote)) throw new Error(`引用不是来源中的逐字原文：${key}；未登记`)
    let context
    if (reference.source === 'chapter') {
      const paragraph = byIndex.get(reference.index)
      if (!paragraph || !paragraph.text.includes(reference.quote)) throw new Error(`正文引文与段号 ${reference.index} 不匹配；未登记`)
      const start = Array.from(source.text).slice(0, paragraph.start).join('').length
      const length = paragraph.text.endsWith('\r') ? paragraph.text.length - 1 : paragraph.text.length
      context = reviewEvidenceContext(source.text, start, start + length)
    } else if (reference.index !== undefined) throw new Error('非正文来源不使用审稿包段号，请省略 index；未登记')
    else {
      const blocks = new Set()
      for (let start = source.text.indexOf(reference.quote); start >= 0; start = source.text.indexOf(reference.quote, start + reference.quote.length)) blocks.add(reviewEvidenceContext(source.text, start, start + reference.quote.length))
      context = [...blocks].join('\n\n')
    }
    const contextKey = JSON.stringify([key, reference.index, context])
    if (!contexts.has(contextKey)) contexts.set(contextKey, { source: reference.source, role: REVIEW_SOURCE_ROLES[reference.source].role, ...(named ? { name: reference.name } : {}), ...(reference.index !== undefined ? { index: reference.index } : {}), context, aspects: [] })
    const entry = contexts.get(contextKey)
    if (!entry.aspects.includes(aspect)) entry.aspects.push(aspect)
  }
  return { sources: [...cache.values()].map(({ text, ...reference }) => reference), contexts: [...contexts.values()] }
}

/** 正文或证据来源变化后记录失效，阻塞项不会因登记成功而消失。 */
async function deaiReviewState(root, chapter, text, meta) {
  const pending = { status: 'pending', findings: [] }
  const review = chapter.deaiReview
  if (review?.version !== DEAI_REVIEW_VERSION || review.baseHash !== createHash('sha256').update(text).digest('hex')
    || review.styleName !== activeStyleName(meta) || !hasCompleteReviewChecks(review.checks)
    || !Array.isArray(review.sources) || !review.sources.length || !Array.isArray(review.paragraphs)
    || !hasCompleteSceneReviews(review.scenes, review.paragraphs.length)) return pending
  let validationFindings, timingReports, preferenceNotes
  try {
    for (const reference of review.sources) {
      const current = reference.source === 'chapter' ? text : await readReviewSource(root, chapter, reference)
      if (current === null || createHash('sha256').update(current).digest('hex') !== reference.hash) return pending
    }
    const coverage = await reviewSourceCoverage(root, meta, text, review.checks)
    if (JSON.stringify(coverage.requirements) !== JSON.stringify(review.sourceCoverage)) return pending
    const timing = calculateReviewTimeBudgets(review.timeBudgets, extractDeaiPack(text, []), review.checks, review.evidenceContexts ?? [])
    const observations = reviewObservations(review.observations, review.checks)
    validationFindings = [...timing.findings, ...coverage.findings, ...observations.findings]
    preferenceNotes = observations.notes
    timingReports = timing.reports
  } catch {
    return pending
  }
  const findings = sortReviewFindings([...reviewFindings(review.checks, review.observations), ...validationFindings])
  return { status: findings.length ? 'blocked' : 'recorded', findings, checkVerdicts: Object.fromEntries(Object.entries(review.checks).map(([aspect, check]) => [aspect, check.verdict])), preferenceNotes, evidenceContexts: review.evidenceContexts, timingReports }
}

async function hasCurrentDeaiReview(root, chapter, text, meta) {
  return (await deaiReviewState(root, chapter, text, meta)).status === 'recorded'
}

/** 返回全部非空正文段落，机械标签只帮助定位，不决定审稿范围。 */
function extractDeaiPack(text, cards) {
  const source = String(text ?? '')
  const baseHash = createHash('sha256').update(source).digest('hex')
  const lines = source.split('\n')
  const paras = []
  let offset = 0
  for (const line of lines) {
    const len = Array.from(line).length
    if (line.trim()) {
      paras.push({ text: line, start: offset, end: offset + len })
    }
    offset += len + 1
  }
  const items = []
  for (let i = 0; i < paras.length; i += 1) {
    const cur = paras[i]
    const tags = []
    if (/[「『"“]/u.test(cur.text)) tags.push('对话')
    if (INTERIOR_RE.test(cur.text) || /(他自己管这叫|他没打算|想的是|脑子里)/u.test(cur.text)) tags.push('心理/体感')
    if (/不是[^，。！？\n]{2,12}，是|看不出来|听不见|先[^，]{1,6}，[^，]{1,6}再|像有人在/u.test(cur.text)) {
      tags.push('疑似金句/对称')
    }
    if (!tags.length) tags.push('叙述')
    items.push({
      index: items.length + 1,
      start: cur.start,
      end: cur.end,
      tags,
      text: cur.text,
    })
  }
  const voices = []
  for (const card of cards ?? []) {
    if (![card.name, ...parseCardAliases(card.content ?? '')].some(name => source.includes(name))) continue
    const speechHit = /^\s*[-*+]?\s*(?:说话|说话方式|口癖)\s*[：:]\s*(.+)$/mu.exec(card.content ?? '')
    const persHit = /^\s*[-*+]?\s*(?:性格|表面)\s*[：:]\s*(.+)$/mu.exec(card.content ?? '')
    voices.push({
      name: card.name,
      content: card.content ?? '',
      speech: speechHit ? speechHit[1].trim() : '',
      personality: persHit ? persHit[1].trim() : '',
    })
  }
  return { baseHash, totalItems: items.length, voices, items }
}

/** 机械自检：只做可判定的事，不做语义推断（语义那部分该由模型自己读）。 */
function inspectText(text, { cards, target }) {
  const body = String(text ?? '')
  const chars = countChars(body)
  const issues = []

  if (!body.trim()) {
    return { ok: false, chars: 0, target, issues: [{ kind: 'empty', detail: '文本是空的，没有可查的内容' }] }
  }

  const known = new Set()
  const aliasMap = new Map()
  for (const card of cards) {
    known.add(card.name)
    const content = card.content ?? ''
    for (const alias of parseCardAliases(content)) {
      known.add(alias)
      aliasMap.set(alias, card.name)
    }
  }

  // ① 旧称残留
  const staleHits = []
  for (const [alias, owner] of aliasMap) {
    const count = body.split(alias).length - 1
    if (count > 0) staleHits.push(`「${alias}」×${count}（人物卡里是「${owner}」的旧称）`)
  }
  if (staleHits.length) {
    issues.push({ kind: 'stale-name', detail: '正文里还在用人物卡的旧称', count: staleHits.length, samples: staleHits })
  }

  // ② 未登记说话人
  const speakers = new Map()
  // 只认「名字 + 说话动词 + 引号」这一种最稳的句式：陈健基说道：「…」。
  // 不认动作标签（点头／皱眉）——「那人点头」这种根本分不清是人名还是路人。
  const speakerPattern = /([\u4e00-\u9fff]{2,3})(?=(?:说|道|问|答|喊|叫|吼)(?:道|着|了)?\s*[：:，,]?\s*[「『"“])/gu
  for (const match of body.matchAll(speakerPattern)) {
    const name = match[1]
    if (SPEAKER_STOPWORDS.has(name)) continue
    if (SPEAKER_BLOCK.test(name)) continue
    if (SPEAKER_START_BLOCK.test(name)) continue
    if (SPEAKER_END_BLOCK.test(name)) continue
    if (known.has(name)) continue
    if (looksLikeTailOfKnown(name, known)) continue
    // 真名在一章里会被反复叫；「默撇嘴」「晴赶紧」这种切口只出现一次。
    if (body.split(name).length - 1 < 2) continue
    speakers.set(name, (speakers.get(name) ?? 0) + 1)
  }
  if (speakers.size) {
    const samples = [...speakers.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} ×${count}`)
    issues.push({
      kind: 'unregistered',
      detail: `这些说话人没有人物卡（可能是漏登记，也可能是临时角色）：${samples.join('、')}`,
      count: speakers.size,
      samples,
    })
  }

  // ③ 连续重复句
  const seen = new Map()
  for (const raw of body.split(/[。！？!?\n]/u)) {
    const sentence = raw.trim()
    if (sentence.length < 12) continue
    seen.set(sentence, (seen.get(sentence) ?? 0) + 1)
  }
  const repeats = [...seen.entries()].filter(([, count]) => count > 1)
  if (repeats.length) {
    issues.push({
      kind: 'repeated-sentence',
      detail: `${repeats.length} 句话出现了不止一次`,
      count: repeats.length,
      samples: repeats.slice(0, 3).map(([sentence, count]) => `${count}× ${sentence.slice(0, 40)}…`),
    })
  }

  // ④ 标点写法
  const asciiEllipsis = (body.match(/\.{3,}/gu) ?? []).length
  const asciiDash = (body.match(/(?<!-)--(?!-)/gu) ?? []).length
  if (asciiEllipsis || asciiDash) {
    const samples = []
    if (asciiEllipsis) samples.push(`半角省略号 ${asciiEllipsis} 处 → 建议「……」`)
    if (asciiDash) samples.push(`半角破折号 ${asciiDash} 处 → 建议「——」`)
    issues.push({ kind: 'punctuation', detail: '标点用了半角写法', count: asciiEllipsis + asciiDash, samples })
  }

  // ⑤ 目标字数
  if (target && target > 0) {
    if (chars < target * 0.8) {
      issues.push({
        kind: 'length',
        detail: `比目标短：${chars}/${target} 字，还差 ${target - chars} 字`,
      })
    }
  }

  return { ok: issues.length === 0, chars, target, issues }
}

/** 把 planned 章节真正建出来：写一个只有标题的空文件，状态转 draft。 */
async function startChapter(root, wanted) {
  const { meta } = await loadBook(root)
  const chapters = meta.chapters
  const chapter = findChapter(chapters, wanted)
  if (!chapter) throw new Error(`没有这一章「${wanted}」；先 novel_status 看章节 id`)
  const file = path.join(root, chapter.file)
  const existing = await readText(file)
  let created = false
  if (existing === null) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, `# ${chapter.title}\n\n`, 'utf8')
    created = true
  }
  if (chapter.status !== 'draft' && chapter.status !== 'final') chapter.status = 'draft'
  await persistBook(root, meta, chapters)
  const stats = await chapterStats(root, chapter, meta.targetChars)
  return { id: chapter.id, title: chapter.title, file: chapter.file, status: chapter.status, created, chars: stats.chars, target: stats.target }
}




