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
import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'novel'

// tools: 注册 novel_* 工具；webServer: 给客户端挂只读数据路由。
export const inject = ['tools', 'webServer']

const BOOK_FILE = 'book.json'
const CHAPTERS_DIR = 'chapters'
const CHARACTERS_DIR = 'characters'
const OUTLINE_FILE = 'outline.md'
const THREADS_FILE = 'threads.md'
const BEATS_FILE = 'beats.md'
const EVENTS_FILE = 'events.md'
const API_PREFIX = '/novel-api'
const DEFAULT_CHAPTER_TARGET = 3000

/** 章节字数：去掉所有空白后按字符计（中文场景比按词计更贴近直觉）。 */
function countChars(text) {
  return Array.from(String(text ?? '').replace(/\s+/gu, '')).length
}

/**
 * 章纲级「占位正文」：`（待写）重生在 1998 年…` 这种一句话梗概不是正文。
 * 它让「已写 N 章」和进度条虚高，也让改状态时把这一章错标成 draft。
 */
function isPlaceholderText(text) {
  const body = String(text ?? '').replace(/\s+/gu, '')
  if (body === '') return false
  if (!/^[（(【\[]*(待写|待补|待续|占位|TODO|todo|TBD)/u.test(body)) return false
  return Array.from(body).length <= 300
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
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

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function readJson(file) {
  const raw = await readText(file)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${path.basename(file)} 不是合法 JSON，请先修好它再继续`)
  }
}

/** 原子写：先写同目录临时文件再 rename，正文不会被半截写完的进程留在盘上。 */
async function writeFileAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(temp, text, 'utf8')
  await fsp.rename(temp, file)
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 章节文件相对根目录，统一成 posix 风格，避免 book.json 在 Windows 上写满反斜杠。 */
function normalizeFile(file, id) {
  const raw = typeof file === 'string' && file.trim() ? file.trim() : `${id}.md`
  const posix = raw.replace(/\\/gu, '/')
  return posix.includes('/') ? posix : `${CHAPTERS_DIR}/${posix}`
}

const CHAPTER_STATUS = ['planned', 'draft', 'final']

function normalizeChapter(entry) {
  const file = typeof entry.file === 'string' && entry.file.trim() ? entry.file : ''
  const fallbackId = path.basename(file || 'chapter', path.extname(file || ''))
  const id = String(entry.id ?? fallbackId)
  const status = CHAPTER_STATUS.includes(entry.status) ? entry.status : 'draft'
  return {
    id,
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : id,
    file: normalizeFile(entry.file, id),
    status,
    targetChars: Number.isFinite(Number(entry.targetChars)) ? Math.max(0, Math.round(Number(entry.targetChars))) : 0,
    ...(typeof entry.note === 'string' && entry.note.trim() ? { note: entry.note } : {}),
  }
}

/**
 * 读出书的结构。
 * 有 book.json 就以它为准；没有就退回「扫 chapters/ 目录、按文件名排序」，
 * 这样用户直接往目录里扔 .md 也能被看见，不会因为缺元数据就一片空白。
 */
async function loadBook(root) {
  const bookPath = path.join(root, BOOK_FILE)
  const raw = await readJson(bookPath)
  const meta = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const declared = Array.isArray(meta.chapters) ? meta.chapters.filter(item => item && typeof item === 'object') : []

  let chapters = declared.map(normalizeChapter)

  if (chapters.length === 0) {
    let names = []
    try {
      names = await fsp.readdir(path.join(root, CHAPTERS_DIR))
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    chapters = names
      .filter(file => /\.md$/iu.test(file))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map(file => {
        // 没有 book.json 时按文件名猜：`0003.md`、`0003 第三章 湖心亭.md`、`第三章.md` 都要认。
        // 开头是数字就把数字当章 id（补齐四位），剩下的当标题；否则整段文件名叫章节名。
        const stem = path.basename(file, path.extname(file)).trim()
        const numbered = /^(\d{1,4})\s*[-_.、:：]?\s*(.*)$/u.exec(stem)
        if (numbered) {
          return normalizeChapter({
            id: numbered[1].padStart(4, '0'),
            title: numbered[2].trim() || `第 ${Number(numbered[1])} 章`,
            file,
          })
        }
        return normalizeChapter({ id: stem, title: stem, file })
      })
  }

  return {
    exists: raw !== null || chapters.length > 0,
    bookPath,
    raw: meta,
    meta: {
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : '未命名作品',
      author: typeof meta.author === 'string' ? meta.author : '',
      genre: typeof meta.genre === 'string' ? meta.genre : '',
      summary: typeof meta.summary === 'string' ? meta.summary : '',
      targetChars: clampInt(meta.targetChars, DEFAULT_CHAPTER_TARGET, 200, 50000),
      // 「没写」和「写了 3000」是两件事：前者是插件默认值，不该被当成作者的决定。
      targetCharsSet: Number.isFinite(Number(meta.targetChars)) && Number(meta.targetChars) > 0,
      style: typeof meta.style === 'string' ? meta.style.trim() : '',
      chapters,
    },
  }
}

async function chapterStats(root, chapter, fallbackTarget) {
  const text = (await readText(path.join(root, chapter.file))) ?? ''
  const chars = countChars(text)
  const target = chapter.targetChars > 0 ? chapter.targetChars : fallbackTarget
  const placeholder = isPlaceholderText(text)
  return {
    ...chapter,
    chars,
    target,
    missing: text === '',
    placeholder,
    written: chars > 0 && !placeholder,
    status: (text === '' || placeholder) && chapter.status === 'draft' ? 'planned' : chapter.status,
  }
}

/** 章节相对进度：实际字数 / 目标字数，用来在界面上标「偏短 / 已达标」。 */
function chapterProgress(item) {
  if (!item.target) return 0
  return Math.min(1, item.chars / item.target)
}

// ---- 人物卡 --------------------------------------------------------------

const CHARACTER_EXT = '.md'

function safeCharacterName(name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('人物名不能为空')
  if (/[\\/:*?"<>|]/u.test(trimmed)) throw new Error(`人物名不能包含 \\ / : * ? " < > |：${trimmed}`)
  return trimmed
}

/** 人物卡的「一句话」：正文里第一行非标题、非空的内容，截到 60 字。 */
function characterSummary(text) {
  const line = String(text ?? '')
    .split(/\r?\n/u)
    .map(item => item.trim())
    .find(item => item && !item.startsWith('#'))
  if (!line) return ''
  const plain = line.replace(/^[-*+]\s*/u, '').replace(/\*\*/gu, '')
  return Array.from(plain).slice(0, 60).join('')
}

// ---- 人物状态（生死/在场）时间线 --------------------------------------------
const DEAD_WORDS = /(去世|死亡|死|殁|阵亡|身亡|牺牲|遇难|丧命|死去|不在了)/u
const ALIVE_CLAUSE = /(没死|未死|不死|假死|装死|没去世|未去世|没牺牲|没遇难|不是死|诈死)/gu

/**
 * 从人物卡的「状态」小节读出状态时间线。
 * 格式：`- @0003 去世（雾港码头失足）`＝从第 3 章起进入这个状态，直到下一条状态为止。
 * 没写这个小节 = 一直活着。只认 `@NNNN` 起点，不解析自然语言时间。
 */
function parseStates(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const states = []
  let inside = false
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s*(.+?)\s*$/u.exec(line)
    if (heading) {
      const title = heading[1].replace(/[*_`]/gu, '').trim()
      inside = /^(状态|时间线|状态时间线|生死|行踪)/u.test(title)
      continue
    }
    if (!inside) continue
    const bullet = /^\s{0,3}[-*+]\s+(.+)$/u.exec(line)
    if (!bullet) continue
    const raw = bullet[1].replace(/\*\*/gu, '').trim()
    const split = /^@\s*(\d{3,4})\s*[：:，,]?\s*(.+)$/u.exec(raw)
    if (!split) continue
    const label = split[2].trim()
    if (!label) continue
    states.push({ chapter: split[1].padStart(4, '0'), label, dead: DEAD_WORDS.test(label.replace(ALIVE_CLAUSE, '')) })
  }
  states.sort((a, b) => a.chapter.localeCompare(b.chapter))
  return states
}

/** 取「截至 limit（含）最后一个状态」；没写过状态就是活着。 */
function stateAt(states, limit) {
  let current = null
  for (const item of states ?? []) {
    if (limit && item.chapter > limit) break
    current = item
  }
  return current
}

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
  if (/@\s*\d{3,4}\s*[-~]\s*\d{3,4}/u.test(body)) warnings.push('用了 `@0003-0008` 区间写法：现在只认起始章，后面的终点会被忽略。')
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
  const scenes = body.split(/\r?\n/u).filter(line => /^\s{0,3}[-*+]\s*场景\s*[：:]/u.test(line)).length
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

/** 「三」这类中文数字也认：大纲里写「三章一爽点」是常态，写代码的人却总当成 sin=3。 */
function numberFromToken(token) {
  const raw = String(token ?? '').trim()
  if (!raw) return 0
  if (/^\d+$/u.test(raw)) return Number(raw)
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (raw === '十') return 10
  const tenAt = raw.indexOf('十')
  if (tenAt === -1) return digits[raw] ?? 0
  const head = tenAt === 0 ? 1 : digits[raw.slice(0, tenAt)] ?? 0
  const tail = raw.slice(tenAt + 1)
  return head * 10 + (tail ? digits[tail] ?? 0 : 0)
}

/** 人物卡上的戏份承诺：「- 戏份：每 8 章至少出场一次」。 */
function parseCadence(text) {
  const hit = /戏份[^\n]*?每\s*([一二三四五六七八九十百零两\d]{1,3})\s*章/u.exec(String(text ?? ''))
  if (!hit) return 0
  const value = numberFromToken(hit[1])
  return value >= 1 && value <= 60 ? value : 0
}

/** 大纲里的爽点规格：「三章一爽点」/「每 3 章至少一次爽点」。 */
function parseSceneCadence(outlineText) {
  const body = String(outlineText ?? '')
  const patterns = [
    /每\s*([一二三四五六七八九十两\d]{1,3})\s*章\s*(?:至少)?\s*(?:一次)?\s*爽点/u,
    /([一二三四五六七八九十两\d]{1,3})\s*章\s*一\s*爽点/u,
  ]
  for (const pattern of patterns) {
    const hit = pattern.exec(body)
    if (!hit) continue
    const value = numberFromToken(hit[1])
    if (value >= 1 && value <= 20) return value
  }
  return 0
}

// 出场索引按「书的内容指纹」缓存：/characters 每 15 秒轮询一次，
// 每次把几十章正文全读一遍太浪费，指纹没变就直接用上次的结果。
let appearanceCache = { key: '', value: null }

/**
 * 谁在哪一章出场过。判据是「名字出现在正文里」——含人物卡上的旧称。
 * 只扫有正文的章（characters.written），空章和占位章不算出场。
 */
async function appearanceIndex(root, chapters, cards, target = 0) {
  // meta.chapters 上没有 written/chars（那是 snapshot 才补的），这里自己过一遍 chapterStats。
  const written = []
  for (const chapter of chapters) {
    if (chapter.written === true) {
      written.push({ chapter, chars: chapter.chars ?? 0 })
      continue
    }
    if (chapter.written === false || chapter.placeholder === true) continue
    const stats = await chapterStats(root, chapter, target)
    if (stats.written) written.push({ chapter, chars: stats.chars })
  }
  const key = `${root}|${written.map(row => `${row.chapter.id}:${row.chars}`).join(',')}|${cards.map(card => card.name).join(',')}`
  if (appearanceCache.key === key) return appearanceCache.value
  const names = new Map()
  for (const card of cards) {
    const cardText = (await readText(path.join(root, card.file))) ?? ''
    names.set(card.name, [card.name, ...parseCardAliases(cardText)].filter(Boolean))
  }
  const last = new Map()
  for (const row of written) {
    const chapter = row.chapter
    const body = (await readText(path.join(root, chapter.file))) ?? ''
    for (const card of cards) {
      const candidates = names.get(card.name) ?? [card.name]
      if (candidates.some(name => name && body.includes(name))) last.set(card.name, chapter.id)
    }
  }
  const latestId = written.length ? written[written.length - 1].chapter.id : ''
  const value = { last, latestId }
  appearanceCache = { key, value }
  return value
}

/** 把出场索引换算成「多久没露面」，给 /characters 与 novel_check 共用。 */
function appearanceReport(lastMap, cards, uptoId) {
  const report = {}
  if (!uptoId) return report
  for (const card of cards) {
    if (!card.cadence) continue
    const lastId = lastMap.get(card.name) ?? ''
    const firstState = Array.isArray(card.states) && card.states.length ? card.states[0].chapter : ''
    if (!lastId && firstState && uptoId < firstState) continue
    const startNum = firstState ? Number(firstState) : 1
    const gap = lastId ? Math.max(0, Number(uptoId) - Number(lastId)) : Math.max(1, Number(uptoId) - startNum + 1)
    report[card.name] = { last: lastId, gap, cadence: card.cadence, due: gap >= card.cadence }
  }
  return report
}

async function listCharacters(root) {
  let names = []
  try {
    names = await fsp.readdir(path.join(root, CHARACTERS_DIR))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
    return []
  }
  const cards = []
  for (const file of names.filter(item => item.toLocaleLowerCase().endsWith(CHARACTER_EXT)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const name = path.basename(file, CHARACTER_EXT)
    const text = (await readText(path.join(root, CHARACTERS_DIR, file))) ?? ''
    cards.push({
      name,
      file: `${CHARACTERS_DIR}/${file.replace(/\\/gu, '/')}`,
      chars: countChars(text),
      summary: characterSummary(text),
      relations: parseRelations(text),
      states: parseStates(text),
      cadence: parseCadence(text),
    })
  }
  return cards
}

/**
 * 从人物卡的「关系」小节读出有向边。
 * 只认 `- 名字：说明` 这种行（也容忍 `*` / `**加粗**` / 半角冒号），
 * 因为这是我在写卡时约定的格式，比自然语言解析可靠得多。
 *
 * 名字后面可以跟**起始章**标记：`- 老周 @0007：开始怀疑她` 表示这条关系从第 7 章起成立。
 * 没有标记 = 从开篇就成立。只记起点、不记终点（关系断了就把这行改写或删掉）。
 */
function parseRelations(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const relations = []
  let inside = false
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s*(.+?)\s*$/u.exec(line)
    if (heading) {
      const title = heading[1].replace(/[*_`]/gu, '').trim()
      inside = /^(关系|人物关系|人物之间的关系|关系网)/u.test(title)
      continue
    }
    if (!inside) continue
    const bullet = /^\s{0,3}[-*+]\s+(.+)$/u.exec(line)
    if (!bullet) continue
    const raw = bullet[1].replace(/\*\*/gu, '').trim()
    const split = /^([^：:]{1,28})[：:]\s*(.*)$/u.exec(raw)
    if (!split) continue
    let target = split[1].trim()
    let from = ''
    // 只认起始章：`@0007`。老数据写成 `@0003-0008` 也照样解析，但只取 0003 当起点，区间后半段忽略。
    const stamp = /^(.*?)\s*@\s*(\d{3,4})(?:\s*[-~]\s*\d{3,4})?\s*$/u.exec(target)
    if (stamp) {
      target = stamp[1].trim()
      from = stamp[2]
    }
    if (!target) continue
    relations.push({ target, label: split[2].trim(), from })
  }
  return relations
}

/**
 * 把「有向关系」摊成图数据；目标没建卡的人物留成虚线幽灵节点。
 * `upto` 给了章节 id（四位字符串）就只看「截至这一章已经成立」的关系：
 * 起始章晚于 upto 的边不画。关系只记起点、没有终点，所以不存在「已结束」这回事。
 */
function characterGraph(cards, upto) {
  const limit = upto ? String(upto).padStart(4, '0') : ''
  const nodes = cards.map(card => {
    const current = stateAt(card.states, limit)
    return {
      id: card.name,
      name: card.name,
      summary: card.summary,
      chars: card.chars,
      ghost: false,
      dead: Boolean(current && current.dead),
      stateLabel: current ? current.label : '',
      stateChapter: current ? current.chapter : '',
      states: (card.states ?? []).map(item => ({ chapter: item.chapter, label: item.label, dead: item.dead })),
    }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges = []
  const push = (from, to, label, ghost, mark) => {
    if (!byId.has(to)) {
      const node = { id: to, name: to, summary: '', chars: 0, ghost: true, dead: false, stateLabel: '', stateChapter: '', states: [] }
      byId.set(to, node)
      nodes.push(node)
    }
    if (ghost && !byId.get(to).ghost) return
    const tail = byId.get(from)
    const head = byId.get(to)
    edges.push({ from, to, label, fromChapter: mark, dead: Boolean((tail && tail.dead) || (head && head.dead)) })
  }
  for (const card of cards) {
    for (const relation of card.relations) {
      if (limit && relation.from && relation.from > limit) continue
      const mark = relation.from
      if (byId.has(relation.target)) {
        push(card.name, relation.target, relation.label, false, mark)
        continue
      }
      // 「林小满」写成「小满」也要连上：取唯一包含匹配，含糊就不猜。
      const fuzzy = cards.filter(other => other.name !== card.name && (other.name.includes(relation.target) || relation.target.includes(other.name)))
      if (fuzzy.length === 1) push(card.name, fuzzy[0].name, relation.label, false, mark)
      else push(card.name, relation.target, relation.label, true, mark)
    }
  }
  return { nodes, edges }
}

async function readCharacter(root, name) {
  const file = path.join(root, CHARACTERS_DIR, `${safeCharacterName(name)}${CHARACTER_EXT}`)
  return (await readText(file)) ?? null
}

async function writeCharacter(root, name, content) {
  const file = path.join(root, CHARACTERS_DIR, `${safeCharacterName(name)}${CHARACTER_EXT}`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
  return { name, file: `${CHARACTERS_DIR}/${path.basename(file)}`, chars: countChars(content) }
}

// ---- 设定（settings/*.md，一个条目一个文件）--------------------------------
//
// 和人物卡同构：名字就是文件名，正文第一行非标题非空行拿来当摘要。
// 可选第一行写 `- 分类：地点 / 规矩 / 物品 / 术语`，右栏用来分组显示。

const SETTINGS_DIR = 'settings'

function settingCategory(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = /^\s*[-*+]?\s*分类\s*[：:]\s*(.+)$/u.exec(line)
    if (match) return match[1].replace(/[*`]/gu, '').trim()
  }
  return ''
}

function settingSummary(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#{1,6}\s/u.test(trimmed)) continue
    if (/^\s*[-*+]\s*分类\s*[：:]/u.test(trimmed)) continue
    return Array.from(trimmed.replace(/^[-*+]\s*/u, '')).slice(0, 60).join('')
  }
  return ''
}

async function listSettings(root) {
  let names = []
  try {
    names = await fsp.readdir(path.join(root, SETTINGS_DIR))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
    return []
  }
  const items = []
  for (const file of names.filter(item => item.toLocaleLowerCase().endsWith(CHARACTER_EXT)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const name = path.basename(file, CHARACTER_EXT)
    const text = (await readText(path.join(root, SETTINGS_DIR, file))) ?? ''
    items.push({
      name,
      file: `${SETTINGS_DIR}/${file.replace(/\\/gu, '/')}`,
      chars: countChars(text),
      summary: settingSummary(text),
      category: settingCategory(text),
    })
  }
  return items
}

async function readSetting(root, name) {
  const file = path.join(root, SETTINGS_DIR, `${safeCharacterName(name)}${CHARACTER_EXT}`)
  return (await readText(file)) ?? null
}

async function writeSetting(root, name, content) {
  const safe = safeCharacterName(name)
  const file = path.join(root, SETTINGS_DIR, `${safe}${CHARACTER_EXT}`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
  return { name: safe, file: `${SETTINGS_DIR}/${path.basename(file)}`, chars: countChars(content) }
}

// 「作废」比删除常用来得多：设定写错了但过程有价值——留证据，不再进装配包。
const SETTING_VOID_RE = /^\s*[-*+]?\s*状态\s*[：:]\s*(作废|废弃|停用|不用了|已废)/mu

async function setSettingStatus(root, name, status) {
  const safe = safeCharacterName(name)
  const file = path.join(root, SETTINGS_DIR, `${safe}${CHARACTER_EXT}`)
  const current = (await readText(file)) ?? ''
  const lines = current.replace(/\r\n/gu, '\n').split('\n').filter(line => !SETTING_VOID_RE.test(line))
  if (status === 'deprecated') {
    const categoryAt = lines.findIndex(line => /^\s*[-*+]?\s*分类\s*[：:]/u.test(line))
    const at = categoryAt >= 0 ? categoryAt + 1 : Math.min(1, lines.length)
    lines.splice(at, 0, '- 状态：作废')
  }
  const body = lines.join('\n').replace(/\n{3,}/gu, '\n\n')
  await fsp.writeFile(file, body, 'utf8')
  return { name: safe, status: status === 'deprecated' ? 'deprecated' : 'active', chars: countChars(body) }
}

// 删除不是硬删：挪进 settings/.trash/，作者后悔了还能捞回来。
async function deleteSetting(root, name) {
  const safe = safeCharacterName(name)
  const file = path.join(root, SETTINGS_DIR, `${safe}${CHARACTER_EXT}`)
  const stamp = stampOf()
  const trashDir = path.join(root, SETTINGS_DIR, '.trash')
  await fsp.mkdir(trashDir, { recursive: true })
  const target = path.join(trashDir, `${safe}-${stamp}${CHARACTER_EXT}`)
  await fsp.rename(file, target)
  return { name: safe, file: `${SETTINGS_DIR}/.trash/${path.basename(target)}` }
}

// ---- 文风卡（styles/<名字>.md）--------------------------------------------
//
// 一套文风 = 一个 Markdown 文件，`book.json` 的 `style` 指向当前在用的那一套。
// 为什么不只存几个形容词：模型学不像。真正起作用的是「3–5 段原文锚点 + 明确禁忌」，
// 形容词只有在这两样都在的时候才有落点。

const STYLES_DIR = 'styles'
const STYLE_EXCERPTS = 5
const STYLE_EXCERPT_CHARS = 480
const CJK_STOP = new Set('的了着过是在有和与就都也还很太不没我你他她它们这那哪个上下来的地去得把被给对从到又再才只'.split(''))

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
      const priority = /\[必选\]/u.test(chunk) || /核心|视角|叙述权限/u.test(heading) ? 0
        : /禁忌/u.test(heading) ? 1
        : /反例|正例/u.test(heading) || /^[-*+]\s*正例/u.test(chunk) ? 4 : 2
      add(`${heading} · ${i + 1}`, `## ${heading}\n${chunk}`, priority)
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
function styleStats(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const chars = countChars(source)
  const sentences = source
    .split(/[。！？!?…]+/u)
    .map(item => item.replace(/\s+/gu, ''))
    .filter(item => item.length >= 2)
  const paragraphs = source
    .split(/\n+/u)
    .map(item => item.trim())
    .filter(item => item.length >= 12)
  const dialogue = paragraphs.filter(item => /[「『“"＂]/u.test(item)).length
  const per1000 = mark => Math.round(((source.split(mark).length - 1) / Math.max(chars, 1)) * 10000) / 10
  const average = list => (list.length ? Math.round((list.reduce((sum, item) => sum + item.length, 0) / list.length) * 10) / 10 : 0)

  const counts = new Map()
  for (const chunk of source.replace(/[^\u4e00-\u9fff]+/gu, ' ').split(/\s+/u)) {
    for (let index = 0; index + 1 < chunk.length; index += 1) {
      const gram = chunk.slice(index, index + 2)
      if (CJK_STOP.has(gram[0]) || CJK_STOP.has(gram[1])) continue
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
  }



  return {
    chars,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    avgSentence: average(sentences),
    avgParagraph: average(paragraphs),
    dialogueRatio: paragraphs.length ? Math.round((dialogue / paragraphs.length) * 100) : 0,
    per1000: {
      comma: per1000('，'),
      period: per1000('。'),
      ellipsis: per1000('…'),
      dash: per1000('—'),
      semicolon: per1000('；'),
      exclaim: per1000('！'),
      question: per1000('？'),
    },
    words: [...counts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([word, count]) => ({ word, count })),
  }
}

/**
 * 文风贴合度：拿文风卡自己的锚点当基准，看这一章的节奏指标偏了多少。
 * 只比可数的东西（句长、段长、对话占比、每千字标点），不做「写得好不好」的判断。
 */
function styleFit(text, cardText, refText) {
  const refSource = refText && countChars(refText) > 3000 ? refText : styleAnchorText(cardText)
  const ref = styleStats(refSource)
  const act = styleStats(text)
  const rows = []
  // hard=false 的指标只记录、不报警。段均/对话段/逗号测的是排版与习惯，
  // 读者读着顺就是顺；把它们当硬指标会把「段落比样本长一点」也判成跑偏。
  const push = (key, label, refValue, actValue, tol, hard = true) => {
    if (!refValue) return
    const ratio = Math.round((actValue / refValue) * 100) / 100
    const low = tol ? tol[0] : 0.65
    const high = tol ? tol[1] : 1.55
    rows.push({ key, label, ref: refValue, act: actValue, ratio, hard, flag: hard && (ratio < low || ratio > high) })
  }
  push('avgSentence', '句均字数', ref.avgSentence, act.avgSentence, [0.7, 1.45])
  push('avgParagraph', '段均字数', ref.avgParagraph, act.avgParagraph, [0.7, 1.4], false)
  push('dialogue', '含对话段占比', ref.dialogueRatio, act.dialogueRatio, [0.5, 2], false)
  push('comma', '每千字逗号', ref.per1000.comma, act.per1000.comma, [0.6, 1.7], false)
  push('period', '每千字句号', ref.per1000.period, act.per1000.period, [0.7, 1.5])
  // 标点类指标：参考文本里本来就只出现几次的，比值没意义，先要求样本里够多。
  if (ref.per1000.dash >= 1.5 && act.per1000.dash >= 1)
    push('dash', '每千字破折号', ref.per1000.dash, act.per1000.dash, [0.35, 2.8], false)
  if (ref.per1000.ellipsis >= 1.5 && act.per1000.ellipsis >= 1)
    push('ellipsis', '每千字省略号', ref.per1000.ellipsis, act.per1000.ellipsis, [0.35, 2.8], false)
  const flagged = rows.filter(row => row.flag)
  return { ok: flagged.length === 0, rows, flagged, ref, act }
}

/** 从文风卡里取「锚点原文」小节的正文（去掉引用符号），用来当节奏基准。 */
function styleAnchorText(cardText) {
  const sections = String(cardText ?? '').split(/\n##\s+/u).slice(1)
  for (const chunk of sections) {
    const rows = chunk.split(/\r?\n/u)
    if (!/^锚点原文/u.test(rows[0].trim())) continue
    return rows.slice(1).map(line => line.replace(/^>\s?/u, '')).join('\n')
  }
  return ''
}

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

/** 按最终提示文本计预算；Unicode 字符含空白，不等同于 token。 */
function assembleNovelContext(value, budget) {
  const size = text => Array.from(text).length
  const rewrite = value.mode === 'rewrite'
  const scope = value.rewriteScope
  const instructions = rewrite
    ? scope.partial
      ? `局部改写：只修改给出的范围。先核对事实、人物动作、信息点，再调整文风。用 novel_write({chapter:"${value.chapter.id}",mode:"patch",baseHash:"${scope.baseHash}",start:${scope.start},end:${scope.end},content:"修改后的片段"}) 保存，其余正文由插件保留。`
      : `整章改写：先逐项核对事实、人物动作和信息点全部保留，再检查文风。优先局部修订；整章覆盖使用 novel_write 的 mode:"replace"，并传 baseHash:"${scope.baseHash}"。`
    : '按章纲和文风写作；省略的资料不代表没有约束，必要时调用对应工具读取。'
  const head = `【${rewrite ? '改写' : '续写'}装配包】${value.chapter.id} ${value.chapter.title}\n目标 ${value.chapter.target} 字。预算 ${budget} Unicode 字符（含标题、空白和指令，不是 token）。\n${instructions}`
  const blocks = []
  const add = (id, label, body, required = false) => {
    if (body) blocks.push({ id, label, text: `## ${label}\n${body}`, required })
  }
  if (rewrite) add('chapterText', scope.partial ? `本章片段 [${scope.start}, ${scope.end})，全章 ${scope.total} 字符` : '完整本章原文', value.chapterText, true)
  add('beats', '本章章纲', value.beats.text, true)
  add('rewriteRules', '改写纪律', value.rewriteRules, true)
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
    const prompt = `上下文预算不足：必要内容需 ${minimum} 字符，当前 ${budget}。未提供残缺正文，不可据此覆盖整章。增大 budget（最多 20000）；长章请用 novel_context({chapter:"${value.chapter.id}",mode:"rewrite",rewriteStart:0,rewriteLimit:1000,budget:6000}) 分段改写。若片段仍放不下，缩小 rewriteLimit 或增大 budget。`
    return { ...value, chapterText: '', prompt, budget, budgetUsed: size(prompt), ready: false, minimumBudget: minimum, included: [], omitted: blocks.map(({ id, label }) => ({ id, label, reason: '必要内容超出预算，本次未装配' })) }
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
  if (!Number.isInteger(args.start) || !Number.isInteger(args.end) || args.start < 0 || args.end <= args.start || args.end > chars.length) throw new Error('局部改写范围无效；未写入')
  return chars.slice(0, args.start).join('') + args.content + chars.slice(args.end).join('')
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

function parseThreads(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim())
    if (cells.length < 2) continue
    if (cells.every(cell => /^:?-{2,}:?$/u.test(cell) || cell === '')) continue
    if (cells[0] === '伏笔' || cells[0] === 'thread') continue
    const [label, planted = '', payoff = '', status = ''] = cells
    if (!label) continue
    const state = status ? status.toLocaleLowerCase() : 'open'
    rows.push({
      thread: label,
      planted: planted || '',
      payoff: payoff || '',
      status: state,
      open: state !== 'closed' && state !== 'done',
    })
  }
  return rows
}

/** 已写到的最后一章 id（用来判断「该收了但还没收」）。 */
function latestWrittenId(chapters) {
  let latest = ''
  for (const chapter of chapters) {
    if (!chapter.chars) continue
    if (chapter.id > latest) latest = chapter.id
  }
  return latest
}

/** 给伏笔行补 due 标记：计划回收章已经到了（或过了）却还没收。 */
function decorateThreads(rows, latest) {
  return rows.map(item => ({
    ...item,
    due: Boolean(item.open && item.payoff && latest && item.payoff <= latest),
  }))
}

async function loadThreads(root) {
  const text = (await readText(path.join(root, THREADS_FILE))) ?? ''
  return { present: text !== '', chars: countChars(text), rows: parseThreads(text) }
}

/**
 * 写入或更新伏笔表的一行，其余行一个字不动。
 * 匹配键是第一条单元格（伏笔描述）；未提供字段保留原值。
 */
async function writeThread(root, patch) {
  const file = path.join(root, THREADS_FILE)
  const existing = (await readText(file)) ?? '# 伏笔表\n\n| 伏笔 | 埋设 | 回收 | 状态 |\n| --- | --- | --- | --- |\n'
  const lines = existing.replace(/\r\n/gu, '\n').split('\n')
  const isRow = line => /^\s*\|/u.test(line)
  const isSeparator = line => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/u.test(line)
  const splitCells = line =>
    line
      .trim()
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map(cell => cell.trim())

  let headerIndex = lines.findIndex(line => isRow(line) && !isSeparator(line) && /伏笔|thread/u.test(line))
  if (headerIndex < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('')
    lines.push('| 伏笔 | 埋设 | 回收 | 状态 |', '| --- | --- | --- | --- |')
    headerIndex = lines.length - 2
  }

  let start = headerIndex + 1
  if (isSeparator(lines[start] ?? '')) start += 1
  let lastRow = start - 1
  for (let i = start; i < lines.length; i++) {
    if (!isRow(lines[i]) || isSeparator(lines[i])) break
    lastRow = i
  }

  // 先清掉模板留下的空占位行（|  |  |  |  |），否则新伏笔会追加在它下面
  for (let i = lastRow; i >= start; i--) {
    if (!isRow(lines[i]) || isSeparator(lines[i])) continue
    if (splitCells(lines[i]).every(cell => cell === '')) {
      lines.splice(i, 1)
      lastRow -= 1
    }
  }

  const target = String(patch.thread).trim()
  let touched = -1
  for (let i = start; i <= lastRow; i++) {
    if (!isRow(lines[i]) || isSeparator(lines[i])) continue
    if (splitCells(lines[i])[0] === target) {
      touched = i
      break
    }
  }

  const previous = touched >= 0 ? splitCells(lines[touched]) : [target, '', '', '']
  const cells = [
    target,
    patch.planted ?? previous[1] ?? '',
    patch.payoff ?? previous[2] ?? '',
    patch.status ?? previous[3] ?? '',
  ]
  const row = `| ${cells.map(cell => String(cell).trim() || ' ').join(' | ')} |`
  if (touched >= 0) lines[touched] = row
  else lines.splice(lastRow + 1, 0, row)

  const next = lines.join('\n').replace(/\n{3,}/gu, '\n\n')
  await fsp.writeFile(file, next, 'utf8')

  const rows = parseThreads(next)
  return { thread: target, row: rows.find(item => item.thread === target) ?? null, rows, replaced: touched >= 0 }
}

function validateThreadPatch(patch) {
  const warnings = []
  const checkId = (value, label) => {
    if (value === undefined || value === '') return
    if (!/^\d{3,4}$/u.test(String(value))) warnings.push(`${label}不是四位章 id（如 0003）：「${value}」这一列右栏读不到。`)
  }
  checkId(patch.planted, '埋设章')
  checkId(patch.payoff, '回收章')
  if (patch.status !== undefined && patch.status !== '' && !['open', 'done', 'closed'].includes(String(patch.status))) {
    warnings.push(`状态只认 open / done / closed，收到「${patch.status}」会按 open 处理（留空＝open，收掉了才写 done）。`)
  }
  return warnings
}

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
function parseBeatSections(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const sections = []
  let current = null
  for (const line of source.split('\n')) {
    if (/^##\s/u.test(line)) {
      current = { heading: line.replace(/^##\s*/u, '').trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }
  return sections.map(section => {
    const body = section.lines.join('\n').trim()
    const match = /^(\d{1,6})\b/u.exec(section.heading)
    return {
      id: match ? match[1].padStart(4, '0') : '',
      heading: section.heading,
      body,
      chars: countChars(body),
      marks: parseBeatMarks(body),
      infos: parseBeatInfos(body),
      shifts: parseBeatShifts(body),
      interiors: parseBeatInteriors(body),
    reactions: parseBeatReactions(body),
      events: parseBeatEventRefs(body),
    }
  })
}

/* ── 内心反应（人物不能只是执行动作） ──────────────────────────────
 * 判据不是「有多少个形容词」，而是「得手/失手之后有没有一个身体或念头反应」。
 * 一处都不用：他心里、手心、喉咙、胸口、后悔、发狠、愣、咬牙……
 * 这些词机器认得，写得好不好机器不判。
 */
const INTERIOR_RE = /(心里|心头|心中|暗自|心底|脑子里|觉得|想着|想起|后悔|不甘|发狠|喉咙|喉结|嗓子|咽了口|咽下|胸口|手心|掌心|指尖|手指|后背|耳朵|耳根|太阳穴|胃里|鼻头|眼眶|发烫|发凉|发紧|冷汗|愣|松了口气|咬牙|手抖|腿软|呼吸|心跳|空了一块)/u

function interiorStats(text) {
  const paras = String(text ?? '').split(/\n+/).map(item => item.trim()).filter(Boolean)
  const hit = paras.filter(item => INTERIOR_RE.test(item)).length
  return { paras: paras.length, hit, ratio: paras.length ? Math.round((hit / paras.length) * 1000) / 10 : 0 }
}

/** 章纲里的「- 位移：从「…」到「…」」——这一场结束时他心里变了什么。 */
function parseBeatShifts(body) {
  const rows = []
  String(body ?? '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .forEach((line, index) => {
      const match = /^\s*[-*+]?\s*位移\s*[：:]\s*(.+)$/u.exec(line)
      if (match) rows.push({ index, text: match[1].trim().slice(0, 120) })
    })
  return rows
}

/**
 * 章纲里的「- 心里：想起他爸递二十块那一下」——这一场他要想到什么、感觉到什么。
 *
 * 为什么要把它写进章纲、而不写进文风卡的规矩里：
 * 规矩是「怎么写」（句式、节奏），章纲是「写什么」；内心材料属于后者。
 * 只在文风卡里写「要加心理」，模型会在一模一样的位置加一模一样的句子——
 * 那才是工业产物。写进章纲，每章的念头就不一样了。
 */
function parseBeatReactions(body) {
  const lines = String(body ?? '').split(/\r?\n/u)
  const hits = []
  for (let index = 0; index < lines.length; index += 1) {
    const found = /^\s*[-*+]?\s*(?:反应|对方反应)\s*[：:]\s*(.+)$/u.exec(lines[index])
    if (found) hits.push({ index, text: found[1].trim() })
  }
  return hits
}

function parseBeatInteriors(body) {
  const rows = []
  String(body ?? '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .forEach((line, index) => {
      const match = /^\s*[-*+]?\s*(?:心里|心理|念头|回忆)\s*[：:]\s*(.+)$/u.exec(line)
      if (match) rows.push({ index, text: match[1].trim().slice(0, 160) })
    })
  return rows
}

/**
 * 找「标了 → 爽点 / 转折 却没有反应」的场：
 * 按章纲那一行切段，去正文里找最像的段落，再看那一带有没有身体/念头。
 */
const MONEY_RE = /(到账|入账|赚|挣|收钱|给钱|递过去|推过去|掏出|数出|三百|五百|一千|两千|合同|提成|分红|工资|净利|存折|涨|签字)/u

/**
 * 「钱一动，人就该有反应」：找出这一章所有提到钱/得手的段落，看它们身上或紧跟着有没有身体、念头。
 * 不拿章纲去对位——章纲是抽象骨架，对位容易错位；这条检查只看正文里最确定的东西。
 */
function payoffMoments(text) {
  const paras = String(text ?? '').split(/\n+/).map(item => item.trim()).filter(Boolean)
  const samples = []
  let total = 0
  let hit = 0
  for (let i = 0; i < paras.length; i += 1) {
    if (!MONEY_RE.test(paras[i])) continue
    total += 1
    const window = paras.slice(i, Math.min(paras.length, i + 3))
    if (window.some(item => INTERIOR_RE.test(item))) {
      hit += 1
      continue
    }
    if (samples.length < 3) samples.push(paras[i].slice(0, 30))
  }
  return { total, hit, samples }
}

/* ── 节奏标记（爽点 / 钩子 / 转折） ────────────────────────────────
 * 爽点不单独建表：它是「这一场戏怎么演」的属性，写在场记后面最不容易丢。
 * 两种写法都认：`→ 爽点（信息压制）`（推荐，类型写在括号里）
 * 和既有的 `钩子：陈默说……`（标记+冒号，冒号后当备注）。
 * 宿主只解析、不存第二份；全局台账由 beatRhythm() 现算。
 */
const BEAT_MARK = /(?:→|->|—>|=>)\s*(爽点|钩子|转折)\s*(?:[（(]([^）)]{0,24})[）)])?/gu
const BEAT_MARK_COLON = /(?:^|[\s、，,。；;])(爽点|钩子|转折)\s*[：:]\s*([^\n]{0,24})/u
const BEAT_MARK_TAIL = /(?:^|[\s、，,。；;])(爽点|钩子|转折)\s*(?:[（(]([^）)]{0,24})[）)])?\s*$/u

function parseBeatMarks(body) {
  const payoff = []
  let hook = 0
  let turn = 0
  const lines = String(body ?? '').split('\n')
  lines.forEach((line, index) => {
    let kind = ''
    let label = ''
    BEAT_MARK.lastIndex = 0
    const arrow = BEAT_MARK.exec(line)
    if (arrow) {
      kind = arrow[1]
      label = (arrow[2] ?? '').trim()
    } else {
      // 也认「钩子：陈默说…」这种把标记写在句子里的写法（作者既有习惯）。
      const colon = BEAT_MARK_COLON.exec(line)
      if (colon) {
        kind = colon[1]
        label = (colon[2] ?? '').trim().replace(/[。；;，,、\s]+$/u, '')
      } else {
        const tail = BEAT_MARK_TAIL.exec(line.trim())
        if (tail) {
          kind = tail[1]
          label = (tail[2] ?? '').trim()
        }
      }
    }
    if (!kind) return
    if (kind === '爽点') payoff.push({ index, label })
    else if (kind === '钩子') hook += 1
    else turn += 1
  })
  return { payoff, hook, turn }
}

function beatHeading(chapter) {
  return `${chapter.id} ${chapter.title}`
}

/** 先按章节 id 匹配，再退回标题包含（人可能顺手把「## 第三章 空铺」写成不带 id 的样子）。 */
function matchBeatSection(sections, chapter) {
  const id = String(chapter.id).padStart(4, '0')
  const byId = sections.find(section => section.id === id)
  if (byId) return byId
  if (!chapter.title) return null
  return sections.find(section => section.heading.includes(chapter.title)) ?? null
}

/** 「信息行」：这一章必须让读者新知道的事实。它不是场景（没地点、没对手、没有变化），
 *  所以单独记、单独查：章纲里可以写，但正文里没给出来就要报。
 */
function parseBeatInfos(body) {
  const infos = []
  String(body ?? '')
    .split('\n')
    .forEach(line => {
      const match = /^\s*[-*+]?\s*信息\s*[：:]\s*(.+)$/u.exec(line)
      if (!match) return
      const text = match[1].trim()
      if (text) infos.push({ index: infos.length + 1, text })
    })
  return infos
}

/* ── 事件线（events.md） ────────────────────────────────────────────
 * 一章可以同时推进多条线，一条线跨很多章 —— 多对多，所以它和 threads.md
 * 一样配得上一份独立资产。定义写在 events.md，章纲里只留锚点
 * （「- 事件：主线-1、感情-2」），时间线由 eventTimeline() 现算，不落第二份。
 */
function parseBeatEventRefs(body) {
  const refs = []
  String(body ?? '').split('\n').forEach(line => {
    const match = /^\s*[-*+]?\s*事件\s*[：:]\s*(.+)$/u.exec(line)
    if (!match) return
    match[1].split(/[、,，/／;；\s]+/u).forEach(piece => {
      const id = piece.trim().replace(/[。.、]$/u, '')
      if (id && !refs.includes(id)) refs.push(id)
    })
  })
  return refs
}

function parseChapterRange(text) {
  const hit = String(text ?? '').match(/(\d{1,4})\s*(?:[-–—~～至到]\s*(\d{1,4}))?/u)
  if (!hit) return { from: '', to: '' }
  const from = hit[1].padStart(4, '0')
  const to = hit[2] ? hit[2].padStart(4, '0') : from
  return { from, to: to < from ? from : to }
}

function parseEventLines(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const lines = []
  let line = null
  let event = null
  const closeEvent = () => {
    if (!line || !event) {
      event = null
      return
    }
    const body = event.raw.trim()
    const pick = label => {
      const hit = new RegExp('^\\s*[-*+]?\\s*' + label + '\\s*[：:]\\s*(.+)$', 'mu').exec(body)
      return hit ? hit[1].trim() : ''
    }
    line.events.push({
      id: event.id,
      title: event.title,
      from: event.from,
      to: event.to,
      because: pick('因为'),
      so: pick('所以'),
      irreplaceable: pick('不可替代'),
      body,
      chars: countChars(body),
    })
    event = null
  }
  for (const raw of source.split('\n')) {
    if (/^###\s/u.test(raw)) {
      closeEvent()
      if (!line) continue
      const title = raw.replace(/^###\s*/u, '').trim()
      const head = /^([^\s（(]+)\s*(.*)$/u.exec(title) ?? [title, title, '']
      const rest = head[2] ?? ''
      const range = parseChapterRange(rest)
      event = {
        id: head[1].trim(),
        title: rest.replace(/[（(][^）)]*[）)]/gu, '').trim(),
        from: range.from,
        to: range.to,
        raw: '',
      }
      continue
    }
    if (/^##\s/u.test(raw)) {
      closeEvent()
      const title = raw.replace(/^##\s*/u, '').trim()
      const split = /^([^：:]{1,10})[：:]\s*(.+)$/u.exec(title)
      line = {
        id: (split ? split[1] : title).trim(),
        name: (split ? split[2] : title).trim(),
        goal: '',
        span: '',
        raw: '',
        events: [],
      }
      lines.push(line)
      continue
    }
    if (event) { event.raw += raw + '\n'; continue }
    if (line) line.raw += raw + '\n'
  }
  closeEvent()
  for (const item of lines) {
    const body = item.raw.trim()
    const goal = /^\s*[-*+]?\s*目标\s*[：:]\s*(.+)$/mu.exec(body)
    const span = /^\s*[-*+]?\s*(?:起点|跨度|区间)[^\n：:]*[：:]\s*(.+)$/mu.exec(body)
    item.goal = goal ? goal[1].trim() : ''
    item.span = span ? span[1].trim() : ''
    delete item.raw
  }
  return lines
}

async function readEvents(root) {
  const text = (await readText(path.join(root, EVENTS_FILE))) ?? ''
  const lines = parseEventLines(text)
  const events = []
  for (const line of lines) {
    for (const event of line.events) events.push({ ...event, lineId: line.id, lineName: line.name })
  }
  return { present: text.trim().length > 0, chars: countChars(text), text, lines, events }
}

/** 时间线：事件 → 覆盖哪些章；章 → 推了哪几条线。区间给默认，锚点做修正。 */
function eventTimeline(board, chapters, beatSections) {
  const lookup = new Map()
  for (const line of board.lines) {
    for (const event of line.events) lookup.set(event.id, { ...event, lineId: line.id, lineName: line.name })
  }
  const warnings = []
  const perChapter = chapters.map(item => {
    const section = beatSections ? matchBeatSection(beatSections, item) : null
    const anchors = section && Array.isArray(section.events) ? section.events : []
    return { id: item.id, title: item.title, written: item.written === true, anchors, hits: [] }
  })
  const byId = new Map(perChapter.map(item => [item.id, item]))
  for (const item of perChapter) {
    for (const id of item.anchors) {
      const event = lookup.get(id)
      if (!event) {
        warnings.push(item.id + ' 锚了「' + id + '」，但 events.md 里没有这条事件')
        continue
      }
      if (event.from && (item.id < event.from || item.id > event.to)) {
        warnings.push(item.id + ' 锚了「' + id + '」，可它标的是 ' + event.from + '–' + event.to + ' 章')
      }
      item.hits.push({ lineId: event.lineId, lineName: event.lineName, eventId: event.id, title: event.title })
    }
    if (item.anchors.length > 4) {
      warnings.push(item.id + ' 一章推了 ' + item.anchors.length + ' 条线，容易写成摘要而不是戏')
    }
  }
  const lines = board.lines.map(line => {
    const events = line.events.map(event => {
      const covered = []
      for (const item of perChapter) {
        const inRange = event.from !== '' && item.id >= event.from && item.id <= event.to
        if (inRange || item.anchors.includes(event.id)) covered.push(item.id)
      }
      const done = covered.filter(id => byId.get(id) && byId.get(id).written).length
      return {
        id: event.id,
        title: event.title,
        from: event.from,
        to: event.to,
        because: event.because,
        so: event.so,
        irreplaceable: event.irreplaceable,
        chapters: covered,
        written: done,
        total: covered.length,
        status: covered.length === 0 ? '未开始' : done === covered.length ? '已写完' : done === 0 ? '未动笔' : '进行中',
      }
    })
    return {
      id: line.id,
      name: line.name,
      goal: line.goal,
      span: line.span,
      events,
      covered: events.filter(item => item.written > 0).length,
      total: events.length,
    }
  })
  return {
    present: board.present,
    lines,
    chapters: perChapter,
    warnings,
    lineCount: lines.length,
    eventCount: lines.reduce((sum, line) => sum + line.total, 0),
    done: lines.reduce((sum, line) => sum + line.covered, 0),
  }
}

/** 整段替换一条线（和 writeBeats 同语义：别的线一个字都不动）。 */
async function writeEventLine(root, lineId, content) {
  const file = path.join(root, EVENTS_FILE)
  const existing =
    (await readText(file)) ??
    '# 事件线\n\n> 一条线一个 ## 小节，一个事件一个 ### 小节；事件标题写「### 主线-1 真相落地（1–3）」。\n'
  const normalized = String(content ?? '').replace(/\r\n/gu, '\n').trim()
  const blockText = /^##\s/u.test(normalized) ? normalized : '## ' + lineId + '\n\n' + normalized
  const source = existing.replace(/\r\n/gu, '\n')
  const rows = source.split('\n')
  const heads = []
  rows.forEach((row, index) => { if (/^##\s/u.test(row)) heads.push(index) })
  const target = heads.find(index => rows[index].replace(/^##\s*/u, '').trim().startsWith(lineId))
  let next
  if (target === undefined) {
    next = source.trimEnd() + '\n\n' + blockText + '\n'
  } else {
    const after = heads.filter(index => index > target)[0]
    const head = rows.slice(0, target)
    const tail = after === undefined ? [] : rows.slice(after)
    next = head.concat(blockText.split('\n')).concat(tail).join('\n')
  }
  next = next.replace(/\n{3,}/gu, '\n\n')
  await writeFileAtomic(file, next)
  return { line: lineId, chars: countChars(blockText) }
}
async function readBeats(root, chapter) {
  const text = (await readText(path.join(root, BEATS_FILE))) ?? ''
  const sections = parseBeatSections(text)
  const section = chapter ? matchBeatSection(sections, chapter) : null
  return {
    present: text.trim().length > 0,
    sections,
    section: section
        ? {
            heading: section.heading,
            body: section.body,
            chars: section.chars,
            marks: section.marks,
            infos: section.infos,
            events: section.events,
          }
      : null,
  }
}

/** 只替换这一章那一节，别的章一个字都不动；没有这一节就追加到文件末尾。 */
async function writeBeats(root, chapter, content) {
  const file = path.join(root, BEATS_FILE)
  const existing = (await readText(file)) ?? '# 章纲\n\n> 每章一节，标题写 `## <章 id> <标题>`，正文写这一章要拍的场景。\n'
  const raw = String(content ?? '').replace(/\r\n/gu, '\n').trim()
  // 节标题由插件生成；粘进来的 `## 0003 …` 会变成两层标题，直接剥掉
  const normalized = raw.replace(/^#{1,6}\s*\d{3,4}[^\n]*(?:\n+|$)/u, '').trim()
  const lines = existing.replace(/\r\n/gu, '\n').split('\n')
  const isHeading = line => /^##\s/u.test(line)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (!isHeading(lines[i])) continue
    const heading = lines[i].replace(/^##\s*/u, '').trim()
    const id = (/^(\d{1,6})\b/u.exec(heading) || [])[1]
    const hit = (id && id.padStart(4, '0') === String(chapter.id).padStart(4, '0'))
      || (chapter.title && heading.includes(chapter.title))
    if (hit) {
      start = i
      break
    }
  }
  let end = lines.length
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      if (isHeading(lines[i])) {
        end = i
        break
      }
    }
  }
  const block = [`## ${beatHeading(chapter)}`, '', normalized, '']
  if (start >= 0) lines.splice(start, end - start, ...block)
  else {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('')
    lines.push(...block)
  }
  const output = `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '')}\n`
  await fsp.writeFile(file, output, 'utf8')
  return { heading: beatHeading(chapter), chars: countChars(normalized) }
}

/** 给状态条 / 右栏用：哪些章有章纲、几行。 */
async function beatsCoverage(root, chapters) {
  const { sections } = await readBeats(root, null)
  const covered = []
  for (const chapter of chapters) {
    const section = matchBeatSection(sections, chapter)
    if (section && section.chars > 0) covered.push(chapter.id)
  }
  return { present: sections.length > 0, total: chapters.length, covered, missing: chapters.filter(c => !covered.includes(c.id)).map(c => c.id) }
}

/**
 * 章纲到底落实了没有：逐条 beat 拿它和正文求「最长公共片段」，太短就算这场景可能没写。
 * 只是提醒，不改文件——真正判断要靠人；但没有这个提醒，模型很容易只写了第一条 beat 就收笔。
 */
function beatCoverage(text, beatsText) {
  const source = String(text ?? '')
  const markerPattern = /^(?:信息|落点|钩子|爽点|转折|位移|反应|心里|心理|念头|回忆|备注|注)\s*[：:]/u
  const rawLines = String(beatsText ?? '')
    .split('\n')
    .map(line => line.replace(/^\s*[-*+]\s*/u, '').trim())
    .filter(line => line.length >= 6 && !line.startsWith('#') && !markerPattern.test(line))
  // 作者写了「- 场景：…」就只按场景算；没写就退回全部实体行（老章纲是散文式的）。
  const scenes = rawLines.filter(line => /^场景\s*[：:]/u.test(line))
  const entries = scenes.length ? scenes : rawLines
  if (!entries.length || !source) return { total: entries.length, covered: 0, missing: [] }

  const quotesOf = line => [...line.matchAll(/[「『"“]([^」』"”]{2,})[」』"”]/gu)].map(match => match[1])
  const longestCommon = line => {
    // 只比汉字/字母数字，标点和空格不参与，避免「撞上」「→」这类高频符号凑长度。
    const a = [...line.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '')]
    const b = [...source.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '')]
    if (!a.length || !b.length) return 0
    let best = 0
    let previous = new Array(b.length + 1).fill(0)
    for (let i = 1; i <= a.length; i += 1) {
      const current = new Array(b.length + 1).fill(0)
      for (let j = 1; j <= b.length; j += 1) {
        if (a[i - 1] === b[j - 1]) {
          current[j] = previous[j - 1] + 1
          if (current[j] > best) best = current[j]
        }
      }
      previous = current
    }
    return best
  }

  // 章纲是摘要、正文是散文，两者的公共片段常常只有三五个字。
  // 所以再加一路「双字词命中率」：摘要里一半以上的双字词在正文里出现过，就认为这一场落地了。
  // 宁可漏报也不误报——报警一次错一次，作者就会把这个检查当噪音关掉。
  const STRUCT_WORDS = /(场景|落点|信息|钩子|爽点|转折|结果|然后|于是|接着|想要|目标|本章|这章|读者|收尾|结尾)/gu
  const bigramRatio = line => {
    const cleaned = String(line ?? '').replace(STRUCT_WORDS, '')
    const han = cleaned.replace(/[^\u4e00-\u9fff]/gu, '')
    if (han.length < 4) return 1
    const grams = new Set()
    for (let i = 0; i + 2 <= han.length; i += 1) grams.add(han.slice(i, i + 2))
    let hit = 0
    for (const gram of grams) if (source.includes(gram)) hit += 1
    return grams.size ? hit / grams.size : 1
  }

  // 章纲写的是「谁 → 在哪 → 想干什么 → 撞上什么」这种抽象骨架，正文是具体场景，
  // 整行比相似度必然很低。所以按 → 切段，逐段看有没有交集：多数段都沾到了，就算这场写了。
  const segmentsOf = line =>
    String(line ?? '')
      .replace(/^场景\s*[：:]/u, '')
      .split(/→|->|—>|=>/u)
      .map(part => part.replace(STRUCT_WORDS, '').trim())
      .filter(part => part.replace(/[^\u4e00-\u9fff]/gu, '').length >= 2)
  const segmentRatio = line => {
    const segments = segmentsOf(line)
    // 没有「→」的条目（信息行、散文式章纲）不走分段判据，交给双字词命中率去判。
    if (segments.length < 2) return 0
    let hit = 0
    for (const segment of segments) {
      const han = segment.replace(/[^\u4e00-\u9fff]/gu, '')
      let touched = false
      for (let i = 0; i + 2 <= han.length; i += 1) {
        if (source.includes(han.slice(i, i + 2))) {
          touched = true
          break
        }
      }
      if (touched) hit += 1
    }
    return hit / segments.length
  }

  const missing = []
  entries.forEach((entry, index) => {
    const quoted = quotesOf(entry).filter(term => source.includes(term))
    const shared = longestCommon(entry)
    const ratio = bigramRatio(entry)
    const segments = segmentRatio(entry)
    const touched = quoted.length > 0 || shared >= 8 || ratio >= 0.45 || segments >= 0.6
    if (!touched) missing.push({ index: index + 1, snippet: entry.slice(0, 28), ratio: Math.round(ratio * 100), segments: Math.round(segments * 100) })
  })
  return { total: entries.length, covered: entries.length - missing.length, missing }
}

/**
 * 节奏台账：爽点／钩子／转折的分布。**不存盘**——真相只在 beats.md 那几行字里，
 * 这里每次现算，所以永远不会和章纲打架。
 */
async function beatRhythm(root, chapters) {
  const { sections } = await readBeats(root, null)
  const outlineText = (await readText(path.join(root, OUTLINE_FILE))) ?? ''
  const gapLimit = parseSceneCadence(outlineText) || 2
  const perChapter = chapters.map(chapter => {
    const section = matchBeatSection(sections, chapter)
    const marks = section && section.chars > 0 ? section.marks : { payoff: [], hook: 0, turn: 0 }
    return {
      id: chapter.id,
      title: chapter.title,
      hasBeats: Boolean(section && section.chars > 0),
      payoff: marks.payoff.length,
      labels: marks.payoff.map(item => item.label).filter(Boolean),
      hook: marks.hook > 0,
      turn: marks.turn,
    }
  })

  // 断档只算「已经写了章纲」的章：没有章纲的章不算断档，那是还没规划。
  let longestGap = 0
  let run = 0
  for (const item of perChapter) {
    if (!item.hasBeats) continue
    if (item.payoff > 0) run = 0
    else {
      run += 1
      if (run > longestGap) longestGap = run
    }
  }
  let currentGap = 0
  for (let i = perChapter.length - 1; i >= 0; i -= 1) {
    const item = perChapter[i]
    if (!item.hasBeats) continue
    if (item.payoff > 0) break
    currentGap += 1
  }

  return {
    perChapter,
    total: perChapter.length,
    withBeats: perChapter.filter(item => item.hasBeats).length,
    payoff: perChapter.reduce((sum, item) => sum + item.payoff, 0),
    withPayoff: perChapter.filter(item => item.payoff > 0).length,
    hooks: perChapter.filter(item => item.hook).length,
    turns: perChapter.reduce((sum, item) => sum + item.turn, 0),
    longestGap,
    currentGap,
    gapLimit,
  }
}

/** 计划层的「预算」：outline.md 的 `## 爽点节奏` 里写 `打脸×3` 这种，×N 求和。 */
function payoffBudget(outlineText) {
  const section = /(?:^|\n)##\s*爽点节奏[^\n]*\n([\s\S]*?)(?=\n##\s|$)/u.exec(String(outlineText ?? ''))
  if (!section) return null
  let total = 0
  const items = []
  for (const line of section[1].split('\n')) {
    const hit = /[×xX*]\s*(\d{1,3})/u.exec(line)
    if (!hit) continue
    const name = line.replace(/^\s*[-*+]\s*/u, '').split(/[×xX*]/u)[0].trim()
    total += Number(hit[1])
    items.push({ name, count: Number(hit[1]) })
  }
  return total > 0 ? { total, items } : null
}

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
  const exists = await fsp.access(target).then(() => true).catch(() => false)
  if (exists) return { path: target, created: false, bytes: 0 }
  await fsp.writeFile(target, body, 'utf8')
  return { path: target, created: true, bytes: Buffer.byteLength(body) }
}

async function persistBook(root, meta, chapterList) {
  const previous = (await readJson(path.join(root, BOOK_FILE))) ?? {}
  const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
  const next = {
    ...base,
    version: 1,
    title: meta.title,
    author: meta.author,
    genre: meta.genre,
    summary: meta.summary,
    chapters: chapterList.map(item => ({
      id: item.id,
      title: item.title,
      file: item.file,
      status: item.status,
      ...(item.targetChars > 0 ? { targetChars: item.targetChars } : {}),
      ...(item.note ? { note: item.note } : {}),
    })),
  }
  // 只有作者明确设过目标字数才落盘；默认值留在内存里用，不写进文件。
  if (meta.targetCharsSet) next.targetChars = meta.targetChars
  else delete next.targetChars
  await writeJson(path.join(root, BOOK_FILE), next)
}

// ---- 历史版本 ------------------------------------------------------------
//
// 一章的旧稿按「快照」留着：chapters/.history/<章id>-<stamp>.md，旁边一份同名 .json
// 记元数据（怎么改的、多少字、用的哪套文风）。永久保留、不做自动删除——作者删掉的
// 段落是最容易后悔的东西，磁盘比后悔便宜。
const HISTORY_DIR = '.history'

/** 紧凑 ISO 时间戳（YYYYMMDDHHmmss，UTC），也就是历史文件名的后缀。 */
function stampOf(date = new Date()) {
  return date.toISOString().replace(/[-:T]/gu, '').slice(0, 14)
}

/** 由 stamp 反解 ISO；没有 json 元数据的老文件靠它推时间。 */
function stampToIso(stamp) {
  const hit = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/u.exec(stamp)
  if (!hit) return ''
  return `${hit[1]}-${hit[2]}-${hit[3]}T${hit[4]}:${hit[5]}:${hit[6]}Z`
}

/** 内容指纹：用来跳过「什么都没改」的重复快照。 */
function shortHash(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12)
}

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
      else if (row.chars > goal * 1.35) add('warn', 'long', label + '：' + row.chars + '/' + goal + ' 字，超 ' + (row.chars - goal), row.id)
    }
    if (sections.length) {
      const section = matchBeatSection(sections, row)
      if (section) {
        const body = (await readText(path.join(root, row.file))) ?? ''
        const cover = beatCoverage(body, section.body)
        if (cover.total > 0 && cover.covered < cover.total) {
          add('warn', 'beats-gap', label + '：章纲 ' + cover.total + ' 场，正文只落到 ' + cover.covered + ' 场', row.id)
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
        add('warn', 'style-drift', label + '：节奏不像文风卡——' + worst.join('；'), row.id)
      }
      // 内心反应密度：整本书一起看，才能看出「越写越像机器人」的趋势。
      const refAudit = fitSampleAudit && fitSampleAudit.present && fitSampleAudit.chars > 3000 ? fitSampleAudit.text : styleAnchorText(styleRawAudit)
      const baselineAudit = interiorStats(refAudit).ratio
      if (baselineAudit >= 1) {
        const act = interiorStats(chapterBody)
        if (act.paras >= 8 && act.ratio < baselineAudit * 0.5) {
          add('warn', 'no-interior', label + '：内心反应 ' + act.ratio + '%（基准 ' + baselineAudit + '%）——只有动作，看不见他在想什么', row.id)
        }
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
  const registerTool = definition => {
    const execute = definition.execute
    return ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined
        const root = await rootOf(header ? header.id : undefined, exec)
        return await rootContext.run(root, () => execute(args, exec))
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
      '目标字数是全书默认（每章可单独覆盖），写章自查按它判「偏短 / 超长」。' +
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
          description: '在工作区根目录写一份 AGENTS.md（写作规范：目录结构、人物卡/章纲/伏笔/文风卡格式、六步流程、红线）。已存在则不覆盖。',
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
              : `${value.scaffold.path} 已经存在，没有覆盖（要重写就自己改那个文件）。`,
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
        if (scaffold.created) changed.push('AGENTS.md（写作规范）')
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
      '写一章正文。不给 chapter 就自动新建下一章；mode=replace 覆盖整章（默认，覆盖前会把旧稿备份到 chapters/.history/），mode=append 追加到章末。写完会同步 book.json，字数随之更新。' +
      '\n改写一章的标准动作：novel_context({ chapter, mode: "rewrite" }) 拿装配包；ready=false 时先调整预算或分段。优先传 rewriteStart/rewriteLimit 局部改写，再用 novel_write({ chapter, content, mode: "patch", start, end, baseHash }) 保存，旧稿自动备份。',
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
        status: { type: 'string', enum: CHAPTER_STATUS, description: '写完后的章节状态，默认 draft' },
        note: { type: 'string', description: '一句话说明这次改动（写进历史时间线，例如「按文风重写」「补了结尾」）' },
      },
      required: ['content'],
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
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const gap = value.target > 0 && value.chars < value.target ? `，距目标 ${value.target} 字还差 ${value.target - value.chars}` : ''
        return textRender(
          `${value.created ? '已新建' : '已写入'} ${value.id} ${value.title}，本章 ${value.chars} 字${gap}，全书 ${value.totalChars} 字。` +
            (value.backup ? `旧稿已备份到 ${value.backup}。` : '') +
            warnText(value.warnings),
        )
      },
    },
    execute: async args => {
      const { meta } = await loadBook(rootNow())
      const chapters = [...meta.chapters]
      const mode = args.mode === 'patch' ? 'patch' : args.mode === 'append' ? 'append' : 'replace'
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
      // 写完顺手对一遍章纲：漏掉的场景当场说出来，别等作者读完全章才发现。
      const warnings = validateChapterContent(args.content)
      const beat = await readBeats(rootNow(), chapter)
      if (beat.section && beat.section.chars > 0) {
        // 章纲有「场」有「位移」，却一条「心里」都没写：正文十有八九会写成流水线。
        const interiors = Array.isArray(beat.section.interiors) ? beat.section.interiors : []
        if (!interiors.length) {
          warnings.push(
            '章纲里一条「- 心里：」都没写。场景写的是"他做了什么"，心里写的是"他想到什么"——没有后者，' +
              '正文只能按动作往下推，读者看到的是流水线。给这一章补 1–2 条心里标签写进章纲，再重写这一章。',
          )
        }
        const gap = beatCoverage(body, beat.section.body)
        const skipped = gap.missing.map(item => `第 ${item.index} 场「${item.snippet}…」`)
        if (skipped.length) {
          warnings.push(
            `章纲里这 ${gap.total} 场，有 ${skipped.length} 场在正文里几乎找不到对应情节：${skipped.join('、')}。` +
              '要么补写，要么把章纲改掉——别让章纲和正文各说各的。',
          )
        }
        const infoList = beat.section.infos ?? []
        if (infoList.length) {
          const infoGap = beatCoverage(body, infoList.map(item => item.text).join('\n'))
          if (infoGap.missing.length) {
            warnings.push(
              `章纲里标了 ${infoList.length} 条「信息」，有 ${infoGap.missing.length} 条在正文里没落地：` +
                infoGap.missing.map(item => `第 ${item.index} 条「${item.snippet}…」`).join('、') +
                '。读者读完之后应该已经知道了——补一场把它演出来，或者改掉这条信息。',
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
                '先定位问题段落，用 novel_context({ chapter, mode: "rewrite", rewriteStart: 0, rewriteLimit: 1000 }) 获取对应范围并局部修订；起点按实际问题位置调整。',
            )
          }
        }
      }
      return {
        id: chapter.id,
        title: chapter.title,
        file: chapter.file,
        chars,
        target: chapter.targetChars > 0 ? chapter.targetChars : meta.targetChars,
        totalChars: after.totals.chars,
        created,
        status: chapter.status,
        backup,
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
    name: 'novel_context',
    description:
      '续写前的标准动作：一次拿到「本章大纲 + 上一章结尾 + 本章出场人物卡 + 未回收伏笔」的装配包，总长度受 budget 限制。写完这一章后可用 novel_write 落盘。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '要写的章 id 或标题；省略则取第一个未写的章（没有就取下一章）' },
        budget: { type: 'integer', description: '最终提示文本的 Unicode 字符上限（含空白、标题、指令，非 token），续写默认 2000、改写 6000，最多 20000' },
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

      // 改写比续写更吃上下文（要带上本章原文 + 全量锚点），默认给大三倍。
      const budget = clampInt(args.budget, args.mode === 'rewrite' ? 6000 : 2000, 300, 20000)
      const prev = chapters.slice(0, index).reverse().find(item => item.chars > 0)
      const prevText = prev ? (await readText(path.join(rootNow(), prev.file))) ?? '' : ''
      const prevTailText = tail(prevText, Math.max(300, Math.min(800, Math.round(budget * 0.3))))

      const outlineText = (await readText(path.join(rootNow(), OUTLINE_FILE))) ?? ''
      const outlinePart = outlineExcerpt(outlineText, current, Math.max(200, Math.min(900, Math.round(budget * 0.35))))

      // 章纲优先：有这一章的 beats 就按清单配额给它，大纲退成背景参考。
      const beats = await readBeats(rootNow(), current)
      const beatsText = beats.section
        ? beats.section.body
        : ''
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
      for (const card of picked.slice(0, 5)) {
        const content = await readCharacter(rootNow(), card.name)
        const state = stateAt(card.states, current.id)
        if (content !== null) {
          characters.push({
            name: card.name,
            state: state ? { chapter: state.chapter, label: state.label, dead: state.dead } : null,
            content: content.trim(),
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
      return assembleNovelContext({
        chapter: { id: current.id, title: current.title, target: current.target ?? meta.targetChars, status: current.status },
        beats: { present: Boolean(beats.section), heading: beats.section ? beats.section.heading : '', text: beatsText, infos: beats.section ? beats.section.infos ?? [] : [] },
        rhythm,
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
        warnings: contextWarnings,
        pass: deai ? 'deai' : '',
        rewriteRules: deai ? DEAI_RULES : '',
        aiTone: deai ? tone.signals : [],
        rewriteScope: selected.scope,
      }, budget)
    },
    presentCall: args => ({ card: 'generic', title: '取上下文装配包', kind: 'read', rawInput: args }),
  })

  registerTool({
    name: 'novel_card',
    description:
      '维护人物卡（工作区 characters/ 目录，一人一个 .md，文件名就是人物名）。不传参数 = 列出所有人物卡；给 name 不给 content = 读这张卡；给 name 且给 content = 写这张卡（覆盖）。' +
      '\n\n【格式约定·必须原样写这两节，否则关系图和生死判定都读不到】' +
      '\n## 关系' +
      '\n- 名字：说明                ← 从开篇就成立' +
      '\n- 名字 @0004：说明          ← 第 4 章起才成立（只记起点，不记终点；关系变了就改写这行）' +
      '\n## 状态' +
      '\n- @0003 去世（怎么死的）    ← 第 3 章起进入这个状态，一直持续到下一条状态为止' +
      '\n- @0050 现身（其实没死）    ← 不含死亡词的状态＝又活着了，这就是「复活」' +
      '\n死亡词：去世/死亡/死/殁/阵亡/身亡/牺牲/遇难/丧命/不在了；写「没死/假死/装死」不算死。' +
      '\n外貌、性格、口癖、禁忌等随便写，`- 字段：内容` 或普通段落都行；名字带 @ 的时间标记只能出现在「关系」和「状态」这两节里。',
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
      '写完一段后做机械自检（不联网、不改文件）：①人物卡里登记的旧称是否还在正文里 ②说话人是否有人物卡没登记 ③连续重复的句子 ④省略号/破折号半角写法 ⑤相对目标字数偏长偏短。给 chapter 读文件，给 text 直接查（两者都行）。只报告问题，修改由你决定。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: '章节 id 或标题；给了就读这一章的文件来查' },
        text: { type: 'string', description: '直接查这段文本（给了 text 就不读文件）' },
        aiTone: { type: 'boolean', description: '默认关。为 true 时额外查「AI 腔」（套话、段落整齐、三连排比、全完整句对话等），每条附原文片段' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
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
        const reviewLines = review ? [
          ...review.warnings.map(item => `格式提醒：${item}`),
          ...(review.limitedCount ? [`少用词命中 ${review.limitedCount} 处（仅提醒，不判违规）：`, ...review.limited] : []),
          ...(review.semantic.length ? ['语义禁忌待会话 AI 复核（尚未判定）：', ...review.semantic] : []),
        ] : []
        if (!value.issues.length) {
          return textRender([`自动检查未发现问题。${value.chars} 字${value.target ? `（目标 ${value.target}）` : ''}。`, ...reviewLines].join('\n'))
        }
        const lines = [`查到 ${value.issues.length} 类问题（${value.chars} 字${value.target ? `，目标 ${value.target}` : ''}）：`]
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
      if (args.aiTone === true) {
        const tone = detectAiTone(text)
        if (tone.signals.length > 0) {
          report.issues.push({
            kind: 'ai-tone',
            detail:
              `读到 ${tone.signals.length} 类「AI 腔」（共 ${tone.total} 处）：` +
              `${tone.signals.map(item => `${item.label}×${item.count}`).join('；')}。` +
              '要改就整章改：novel_context({ chapter, mode: "rewrite", pass: "deai" }) 会带上改写纪律和命中清单。',
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
            detail: '这一场的爽点标的是「打脸」，但章纲里没写对手当场怎么反应：补一行「- 反应：他把烟塞回兜里，笑了一下，说「行，你有种」」——写表情、手上动作或一句撑场面的话，不写他的内心。',
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
          report.issues.push({
            kind: 'beats-gap',
            detail:
              `章纲有 ${gap.total} 场，这版正文只落到 ${gap.covered} 场。疑似没写的有：` +
              gap.missing.map(item => `第 ${item.index} 场「${item.snippet}…」`).join('、'),
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
            report.issues.push({
              kind: 'info-missing',
              detail:
                `章纲里 ${infos.length} 条「信息」，这版正文里 ${infoGap.missing.length} 条没落地：` +
                infoGap.missing.map(item => `第 ${item.index} 条「${item.snippet}…」`).join('、'),
            })
          }
        }
      }
      // 章纲点了名要想到什么，正文却一段内心都没有——不管有没有文风卡都要查。
      const interiorRows = beat && beat.section && Array.isArray(beat.section.interiors) ? beat.section.interiors : []
      if (interiorRows.length) {
        const inner = interiorStats(text)
        if (inner.paras >= 5 && inner.hit === 0) {
          report.issues.push({
            kind: 'no-interior-plan',
            detail:
              `章纲里写了 ${interiorRows.length} 条内心材料，正文里一段都没落到：` +
              interiorRows.slice(0, 3).map(item => `「${item.text}」`).join('、') +
              '。这几条不是提示，是这一章必须出现的东西——挑一处写成他看到/想到的具体画面，别写成"他很后悔"。',
          })
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
          report.issues.push({
            kind: 'style-drift',
            detail: `这一章的节奏不像文风卡「${styleName}」：${worst.join('；')}。要么重写这一章，要么改文风卡——别两边都不动。`,
          })
        }
        // 内心反应：只比密度，不判好坏。基准优先用参考原文（够长才有代表性）。
        const refText = fitSample && fitSample.present && fitSample.chars > 3000 ? fitSample.text : styleAnchorText(styleRaw)
        const baseline = interiorStats(refText).ratio
        if (baseline >= 1) {
          const act = interiorStats(text)
          if (act.paras >= 8 && act.ratio < baseline * 0.5) {
            report.issues.push({
              kind: 'no-interior',
              detail:
                `内心/身体反应太少：这一章 ${act.hit}/${act.paras} 段（${act.ratio}%），文风基准是 ${baseline}%。` +
                '读者只看见他在做事、看不见他在想什么——得手、被压、丢脸之后，先给他一个身体感觉或一句念头，再写下一个动作。',
            })
          }
        }

        // 钱一动，人就该有反应：这是「像机器人」最典型的地方（钱到账 → 直接谈下一笔）。
        const moments = payoffMoments(text)
        if (moments.total >= 4 && moments.hit / moments.total < 0.3) {
          report.issues.push({
            kind: 'payoff-no-reaction',
            detail:
              `这一章有 ${moments.total} 段在写钱或得手，其中只有 ${moments.hit} 段带身体/念头反应（${Math.round((moments.hit / moments.total) * 100)}%）。` +
              '读者只看见他收钱、给钱、算账——钱一动，先给他一句身体感觉或一个念头，再写下一个动作。' +
              (moments.samples.length ? `比如这几段：「${moments.samples.join('」「')}」` : ''),
            count: moments.total - moments.hit,
            samples: moments.samples,
          })
        }
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

  // ---- 章纲（大纲之下、正文之上那一层）------------------------------------
  registerTool({
    name: 'novel_beats',
    description:
      '章纲：每章一节写在 beats.md（二级标题 `## <章 id> <标题>`），内容是这一章要拍的场景清单。不传参 = 看全书章纲覆盖情况；给 chapter = 读这一章的章纲；给 chapter + content = 覆盖写这一章（别的章一个字都不动）。写正文前先看章纲，比只看大纲更准。' +
      '\n\n【格式约定】`## 0003 第三章 标题` 开头，下面 3–6 条 `- 场景：谁 → 在哪 → 想干什么 → 结果撞上什么`；一章只推进一件事，不要在一章里塞三个转折。写章纲时不写对白和描写，那不是它的活。\n\n【没有行数上限】只有「场景」数有建议值（3–6 场，超过 8 场插件会提醒拆章）；`- 心里：`/`- 反应：`/`- 信息：`/`- 落点：`/`- 钩子：` 都不算「场」，写多少都原样保存，插件不会丢弃任何一行。' +
      '\n\n【- 心里：另起一行，紧跟在它所解释的那一场下面】格式 `- 心里：他想起…`，独立成条——' +
      '塞在「场景：」那一行里不会被统计，装配包也不会单独列出来。' +
      '①写主角（视角人物）的念头，不是配角的（写配角那是人物卡的事）；' +
      '②每章 1–2 条，位置不固定，但必须在它解释的那场之后——别全堆到章末，堆到章末就变成每章一样的收尾；' +
      '③**只写标签**：「- 心里：主角回忆」「- 心里：对比前世」「- 心里：算账」——具体画面让 AI 扩写时自己给，' +
      '不要写「他感到很后悔」这种概括——概括会被模型原样抄成口水话。' +
      '\n\n【- 反应：另起一行，紧跟在打脸 / 爽点那一场下面】格式「- 反应：他把烟塞回兜里，笑了一下，说「行，你有种」」。' +
      '**只写标签，不写整句**：「- 反应：反派尴尬」「- 反应：反派嘴硬」「- 反应：前妻维护」「- 反应：旁人看戏」——扩写正文时 AI 自己铺表情和台词；视角不在对方身上，所以只写看得见的，不写他的内心。' +
      '打脸的关键是对方那一瞬间露了怯；没有这一行，正文只会写「主角把烟推回去」，读者只觉得硬气，不觉得爽。' +
      '每场可以写 1–3 条，**分不同的人写**：当场那个人（反派尴尬）、旁观的人（群众愣住 / 有人笑出声）、对方自己人之间（同伙互相看 / 有人往后缩）。一场里只有一个反应是不够的——打脸要让人看见周围都变了。' +
      '\n\n【节奏标记·写在场景末尾，插件会统计】' +
      '\n- `→ 爽点（类型）`：这一场给了读者情绪回报。类型取一个：打脸 / 翻盘 / 揭秘 / 情感兑现 / 强强对话 / 信息压制。' +
      '\n- `→ 钩子`：章末留翻页理由，每章至少一个（也认 `钩子：…` 这种写法）。' +
      '\n- `→ 转折`：这一场把方向拐了个弯。' +
      '\n爽点是"这场戏怎么演"的属性，不是一本账：不要单独建爽点表、也不要只写在 outline 里。' +
      '补标记不用重写整章章纲——先 novel_beats({ chapter }) 读到原文，把标记插在对应场景句末，再整节写回。',
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
                rules: DEAI_RULES,
              })
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
              sendJson(res, 200, {
                present: board.present,
                chapter: chapter ? { id: chapter.id, title: chapter.title } : null,
                text: board.section ? board.section.body : '',
                chars: board.section ? board.section.chars : 0,
                sections: board.sections.map(section => ({
                  id: section.id,
                  heading: section.heading,
                  chars: section.chars,
                  text: section.body,
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
              sendJson(res, 200, { name: url.searchParams.get('name'), chars: countChars(content), content })
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
function parseCardAliases(text) {
  const aliases = []
  const pattern = /(?:^|\n)[\s>*\-]*?(?:旧称|旧名|别名|原名|曾用名|改名前)\s*[：:]\s*([^\n]+)/gu
  for (const match of String(text ?? '').matchAll(pattern)) {
    for (const part of match[1].split(/[、,，/／|]/u)) {
      // 先砍括号注释，再砍多余空白：`小满（父亲叫她小满…）` 只留「小满」。
      const name = part.split(/[（(]/u)[0].trim()
      if (name && name.length >= 1 && name.length <= 8) aliases.push(name)
    }
  }
  return aliases
}

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
const AI_TONE_PHRASES = [
  [/在[^。！？\n]{2,14}的(?:背景|时代|大环境|形势|浪潮)下/u, '空转开头「在…的背景下」'],
  [/值得一提的(?:是|还有)/u, '「值得一提的是」'],
  [/不仅[^。！？\n]{2,24}(?:而且|更是|还)/u, '机械递进「不仅…而且…」'],
  [/(?:无疑|毫无疑问)(?:是|地)/u, '判词「无疑是」'],
  [/(?:在一定程度|某种意义)上/u, '退让「在某种程度上」'],
  [/(?:注入|赋能|赋予)[^。！？\n]{0,8}(?:活力|动能|动力|生机)/u, '官腔「注入活力」'],
  [/(?:全方位|多维度|立体化|系统性地)/u, '「全方位 / 多维度」'],
  [/(?:映入眼帘|尽收眼底|扑面而来)/u, '「映入眼帘 / 扑面而来」'],
  [/(?:不禁|不由得)(?:让人|令人|使人)/u, '「不禁让人…」'],
  [/(?:彰显|折射出|折射着|昭示)/u, '「彰显 / 折射出」'],
  [/(?:总之|综上所述|总而言之)/u, '总结式收尾'],
  [/(?:仿佛|似乎)(?:在|是)(?:诉说|倾述|讲述|低语)/u, '「仿佛在诉说」'],
]

const aiSnippet = (body, index, length) => {
  const from = Math.max(0, index - 12)
  const to = Math.min(body.length, index + length + 12)
  return `${from > 0 ? '…' : ''}${body.slice(from, to).replace(/\s+/gu, ' ')}${to < body.length ? '…' : ''}`
}

const aiSentences = body => body.split(/[。！？!?…]/u).map(item => item.trim()).filter(item => item.length > 0)

/**
 * @returns {{ signals: Array<{ kind: string, label: string, count: number, samples: string[] }>, total: number }}
 */
function detectAiTone(text) {
  const body = String(text ?? '')
  const signals = []
  const add = (kind, label, samples) => {
    if (!samples || samples.length === 0) return
    signals.push({ kind, label, count: samples.length, samples: samples.slice(0, 3) })
  }
  if (!body.trim()) return { signals, total: 0 }

  for (const [pattern, label] of AI_TONE_PHRASES) {
    const hits = []
    for (const match of body.matchAll(new RegExp(pattern.source, 'gu'))) {
      hits.push(aiSnippet(body, match.index ?? 0, match[0].length))
    }
    add('cliche', label, hits)
  }

  const paragraphs = body.split(/\n+/u).map(item => item.trim()).filter(item => item.length > 0)
  const connectors = paragraphs.filter(item => /^(然而|因此|此外|同时|总之|首先|其次|再者|另外|与此)/u.test(item))
  if (paragraphs.length >= 4 && connectors.length / paragraphs.length >= 0.3) {
    add('connector-start', `有 ${connectors.length}/${paragraphs.length} 段以「然而 / 因此 / 同时」开头`, connectors.map(item => item.slice(0, 24)))
  }
  const paragraphLengths = paragraphs.map(item => countChars(item)).filter(item => item > 0)
  if (paragraphLengths.length >= 5) {
    const mean = paragraphLengths.reduce((sum, item) => sum + item, 0) / paragraphLengths.length
    const variance = paragraphLengths.reduce((sum, item) => sum + (item - mean) ** 2, 0) / paragraphLengths.length
    const deviation = mean > 0 ? Math.sqrt(variance) / mean : 0
    if (deviation > 0 && deviation < 0.12) {
      add('uniform-paragraph', `段落长度几乎一样（平均 ${Math.round(mean)} 字，波动只有 ${(deviation * 100).toFixed(0)}%）`, paragraphs.slice(0, 2).map(item => item.slice(0, 22)))
    }
  }

  const sentences = aiSentences(body)
  if (sentences.length >= 20) {
    const shorts = sentences.filter(item => countChars(item) <= 8)
    if (shorts.length / sentences.length < 0.05) {
      add('no-short', `${sentences.length} 句里只有 ${shorts.length} 句短句（≤8 字）：真人写作会有短句，甚至独立成段`, [])
    }
    const groups = []
    let bucket = [sentences[0]]
    for (let index = 1; index < sentences.length; index += 1) {
      const previous = bucket[bucket.length - 1]
      const current = sentences[index]
      const sameShift = current[0] === bucket[0][0] && Math.abs(countChars(current) - countChars(previous)) <= 2
      if (sameShift) bucket.push(current)
      else {
        groups.push(bucket)
        bucket = [current]
      }
    }
    groups.push(bucket)
    const parallels = groups.filter(group => group.length >= 3 && countChars(group[0]) >= 10)
    if (parallels.length > 0) {
      add('parallel-run', `有 ${parallels.length} 处连续三句以上字数齐平、开头相同`, parallels.slice(0, 3).map(group => group.slice(0, 3).join('｜')))
    }
  }

  const quotes = [...body.matchAll(/[「『"“]([^」』"”]{2,})[」』"”]/gu)].map(match => match[1].trim())
  if (quotes.length >= 5) {
    const clean = quotes.filter(item => !/[，,]|…|—/u.test(item) && countChars(item) > 12)
    if (clean.length / quotes.length >= 0.7) {
      add('clean-dialogue', `有 ${clean.length}/${quotes.length} 句对话是长而完整的一口气（没有打断、停顿、省略）`, clean.slice(0, 2))
    }
    if (quotes.length >= 8 && !/[—…]/u.test(body)) {
      add('no-pause', '有对话却一处破折号、省略号都没有：人说话会停顿、会抢话、会说不下去', [])
    }
  }

  const total = signals.reduce((sum, item) => sum + item.count, 0)
  return { signals, total }
}

/** 改写纪律（从 qu-ai-wei 的仲裁顺序与禁令压缩而来，控制在 600 字内）。 */
const DEAI_RULES = [
  '改写纪律（去 AI 味）：',
  '1. 事实优先：情节、对话内容、人名、数字、设定名一个字都不能变，只换句子。',
  '2. 不许补写：原文没写的因果、动机、结论，不能因为"读起来更顺"就添上。',
  '3. 不许升级：原文是「没有证据表明」，就不能改成「证实没有」；「可能是」不能改成「就是」。',
  '4. 受保护片段原样保留：引号里的对话、专名、数字、术语。',
  '5. 优先级：事实原意 > 作者声口 > 自然表达 > 原来的句式（句式可以全换，声音要留住）。',
  '6. 手法：删掉「在…的背景下」「不仅…而且」这类空转句，或把它落成具体动作；长短句交错，允许短句独立成段；对话允许打断、答非所问、省略主语。',
  '7. 自检：如果改完比原文更整齐、更对称，那是改错了方向。',
].join('\n')

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
    } else if (chars > target * 1.3) {
      issues.push({
        kind: 'length',
        detail: `比目标长：${chars}/${target} 字，超了 ${chars - target} 字`,
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

function findChapter(chapters, wanted) {
  const key = String(wanted ?? '').trim()
  if (!key) return undefined
  const lower = key.toLocaleLowerCase()
  return (
    chapters.find(item => item.id === key) ??
    chapters.find(item => item.id.toLocaleLowerCase() === lower) ??
    chapters.find(item => item.title === key) ??
    chapters.find(item => item.file.toLocaleLowerCase().endsWith(`${lower}.md`)) ??
    chapters.find(item => path.basename(item.file, '.md').toLocaleLowerCase() === lower)
  )
}

function chapterNumberOf(title) {
  const match = /第\s*([0-9]{1,4}|[零一二两三四五六七八九十百千]{1,8})\s*章/u.exec(String(title ?? ''))
  if (!match) return 0
  const raw = match[1]
  if (/^[0-9]+$/u.test(raw)) return Number(raw)
  let total = 0
  let number = 0
  for (const char of raw) {
    if (char === '百') {
      total += (number || 1) * 100
      number = 0
    } else if (char === '千') {
      total += (number || 1) * 1000
      number = 0
    } else if (char === '十') {
      total += (number || 1) * 10
      number = 0
    } else {
      number = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[char] ?? 0
    }
  }
  return total + number
}

function nextChapterId(chapters) {
  let max = 0
  for (const chapter of chapters) {
    const match = /^0*(\d+)/u.exec(chapter.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return String(max + 1).padStart(4, '0')
}

