import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { cardIdentity } from '../stage.js'
import { countChars, numberFromToken } from './text.js'
import { chapterStats, readText, CHARACTERS_DIR, CHARACTER_EXT } from './book.js'

// people.js：书模型、章节读写与落盘。

// 出场索引按书的内容指纹缓存，避免人物页轮询时反复扫描全部正文。
let appearanceCache = { key: '', value: null }

export function safeCharacterName(name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('人物名不能为空')
  if (/[\\/:*?"<>|]/u.test(trimmed)) throw new Error(`人物名不能包含 \\ / : * ? " < > |：${trimmed}`)
  return trimmed
}

export const STATE_CODES = ['在世', '去世', '已故', '失踪', '假死', '复活', '远走']

export function parseStates(text) {
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
    // 先认状态码（唯一可靠判据），认不出才退回关键词，并标记为老格式
    const code = STATE_CODES.find(item => label.startsWith(item)) ?? ''
    const dead = code === '' ? DEAD_WORDS.test(label.replace(ALIVE_CLAUSE, '')) : code === '去世' || code === '已故'
    states.push({ chapter: split[1].padStart(4, '0'), label, code, legacy: code === '', dead })
  }
  states.sort((a, b) => a.chapter.localeCompare(b.chapter))
  return states
}

export function stateAt(states, limit) {
  let current = null
  for (const item of states ?? []) {
    if (limit && item.chapter > limit) break
    current = item
  }
  return current
}

export async function appearanceIndex(root, chapters, cards, target = 0) {
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

export function appearanceReport(lastMap, cards, uptoId) {
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

export const ROLE_RANK = { '主角': 1, '男主': 1, '女主': 2, '男二': 3, '女二': 3, '重要配角': 4, '男配': 4, '女配': 4, '反派': 5, '龙套': 6 }

export function parseCardRole(text) {
  const match = String(text ?? '').match(/^\s*[-*+]?\s*定位\s*[：:]\s*(\S+)/mu)
  if (!match) return ''
  const role = match[1].trim()
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, role) ? role : ''
}

export function cardRank(text) {
  const role = parseCardRole(text)
  return role ? ROLE_RANK[role] : 9
}

export function parseCardHook(text) {
  const match = String(text ?? '').match(/^\s*[-*+]?\s*记忆点\s*[：:]\s*(.+)$/mu)
  return match ? match[1].trim() : ''
}

export async function listCharacters(root) {
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
      ...cardIdentity(text),
      rank: cardRank(text),
      hook: parseCardHook(text),
    })
  }
  return cards
}

export function parseRelations(text) {
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

export function characterGraph(cards, upto) {
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

export async function readCharacter(root, name) {
  const file = path.join(root, CHARACTERS_DIR, `${safeCharacterName(name)}${CHARACTER_EXT}`)
  return (await readText(file)) ?? null
}

export async function writeCharacter(root, name, content) {
  const file = path.join(root, CHARACTERS_DIR, `${safeCharacterName(name)}${CHARACTER_EXT}`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
  return { name, file: `${CHARACTERS_DIR}/${path.basename(file)}`, chars: countChars(content) }
}

export function parseCardAliases(text) {
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

export function characterSummary(text) {
  const line = String(text ?? '')
    .split(/\r?\n/u)
    .map(item => item.trim())
    .find(item => item && !item.startsWith('#'))
  if (!line) return ''
  const plain = line.replace(/^[-*+]\s*/u, '').replace(/\*\*/gu, '')
  return Array.from(plain).slice(0, 60).join('')
}

export const DEAD_WORDS = /(去世|死亡|身亡|殁|阵亡|遇难|丧命|死去|丧生|断气|咽气|暴毙|被杀|身故)/u

export const ALIVE_CLAUSE = /(没死|未死|不死|假死|装死|没去世|未去世|没牺牲|没遇难|不是死|诈死)/gu

export function parseCadence(text) {
  const hit = /戏份[^\n]*?每\s*([一二三四五六七八九十百零两\d]{1,3})\s*章/u.exec(String(text ?? ''))
  if (!hit) return 0
  const value = numberFromToken(hit[1])
  return value >= 1 && value <= 60 ? value : 0
}
