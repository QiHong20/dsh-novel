import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { stageBook } from '../stage.js'
import { cardIdentity, characterSummary, rankForCardRole } from './character-card.js'
import { countChars, isPlaceholderText, numberFromToken } from './text.js'
import { readText, writeFileAtomic, CHARACTERS_DIR, CHARACTER_EXT } from './book.js'
import { readBeats, resolveBeatSection } from './beats.js'
import { withFileLock } from './file-lock.js'

export { cardRank, characterSummary, parseCardRole, ROLE_RANK } from './character-card.js'

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

const digest = value => createHash('sha256').update(String(value ?? '')).digest('hex')

export async function appearanceIndex(root, chapters, cards) {
  const chapterRows = []
  for (const chapter of chapters) {
    const body = chapter.file ? (await readText(path.join(root, chapter.file))) ?? '' : ''
    const written = chapter.written === false || chapter.placeholder === true
      ? false
      : countChars(body) > 0 && !isPlaceholderText(body)
    chapterRows.push({ id: chapter.id, chapter, body, written, bodyHash: digest(body) })
  }

  const cardRows = []
  const identityCounts = new Map()
  for (const card of cards) {
    const text = card.file ? (await readText(path.join(root, card.file))) ?? '' : ''
    const identity = card.id || cardIdentity(text).id
    const row = {
      card,
      id: identity,
      textHash: digest(text),
      names: [...new Set([card.name, ...parseCardAliases(text)].filter(Boolean))],
    }
    cardRows.push(row)
    if (identity) identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1)
  }

  const beatBoard = await readBeats(root, null, chapters)
  // 只认「登场」：人物本人实际出场。「呈现」、认知记录和章纲计划都可能只是画像、转述或安排。
  const stage = await stageBook(root, chapters)
  const recorded = new Map()
  for (const record of stage.records) {
    if (!record.valid || !record.character || record.kind !== '登场' || record.onStage !== true) continue
    if (!recorded.has(record.character)) recorded.set(record.character, [])
    const list = recorded.get(record.character)
    if (!list.includes(record.chapter)) list.push(record.chapter)
  }
  const key = digest(JSON.stringify({
    root,
    chapters: chapterRows.map(row => [row.id, row.chapter.file, row.written, row.bodyHash, row.chapter.deaiReview?.baseHash ?? '']),
    beats: beatBoard.baseHash,
    cards: cardRows.map(row => [row.card.name, row.card.file, row.id, row.textHash, row.card.cadence ?? 0]),
    recorded: [...recorded].map(([character, list]) => [character, list]),
  }))
  if (appearanceCache.key === key) return appearanceCache.value

  const planned = new Map()
  const confirmed = new Map()
  const candidates = new Map()
  const sceneIdCounts = new Map()
  for (const section of beatBoard.sections) {
    for (const scene of section.scenes) sceneIdCounts.set(scene.id, (sceneIdCounts.get(scene.id) ?? 0) + 1)
  }
  const add = (target, characterId, chapterId) => {
    if (!target.has(characterId)) target.set(characterId, [])
    const chaptersForCharacter = target.get(characterId)
    if (!chaptersForCharacter.includes(chapterId)) chaptersForCharacter.push(chapterId)
  }

  for (const row of chapterRows) {
    if (!row.written) continue
    const resolved = resolveBeatSection(beatBoard.sections, row.chapter, chapters)
    const section = resolved.kind === 'matched' ? resolved.section : null
    const sectionKey = section?.id || section?.heading
    const hasStructureError = section && beatBoard.issues.some(item => item.severity === 'error' && item.chapter === sectionKey)
    if (section && !hasStructureError) {
      const cast = new Set(section.scenes.filter(scene => sceneIdCounts.get(scene.id) === 1).flatMap(scene => scene.cast))
      for (const characterId of cast) {
        if (identityCounts.get(characterId) === 1) add(planned, characterId, row.id)
      }
    }
    // 章纲 cast 只是计划；只有已确认且来源仍有效的记录才清零欠场。
    for (const [characterId, list] of recorded) {
      if (identityCounts.get(characterId) === 1 && list.includes(row.id)) add(confirmed, characterId, row.id)
    }
    for (const cardRow of cardRows) {
      if (cardRow.names.some(name => row.body.includes(name))) add(candidates, `name:${cardRow.card.name}`, row.id)
    }
  }

  const identities = new Map(cardRows.map(row => [row.card.name, {
    id: row.id,
    status: !row.id ? 'missing' : identityCounts.get(row.id) === 1 ? 'stable' : 'ambiguous',
  }]))
  const written = chapterRows.filter(row => row.written).map(row => row.id)
  const value = {
    chapters: chapterRows.map(row => ({ id: row.id, written: row.written })),
    written,
    latestId: written.at(-1) ?? '',
    planned,
    confirmed,
    candidates,
    identities,
  }
  appearanceCache = { key, value }
  return value
}

export function appearanceReport(index, cards, uptoId) {
  const report = {}
  if (!uptoId) return report
  const cutoff = index.chapters.findIndex(chapter => chapter.id === uptoId)
  if (cutoff < 0) return report
  const written = index.chapters.slice(0, cutoff + 1).filter(chapter => chapter.written).map(chapter => chapter.id)
  for (const card of cards) {
    if (!card.cadence) continue
    const identity = index.identities.get(card.name) ?? { id: card.id || '', status: card.id ? 'stable' : 'missing' }
    const confirmed = identity.status === 'stable' ? (index.confirmed.get(identity.id) ?? []) : []
    const planned = identity.status === 'stable' ? (index.planned.get(identity.id) ?? []) : []
    const candidate = index.candidates.get(`name:${card.name}`) ?? []
    const firstState = Array.isArray(card.states) && card.states.length ? card.states[0].chapter : ''
    const firstStateIndex = firstState ? index.chapters.findIndex(chapter => chapter.id === firstState) : -1
    if (firstStateIndex >= 0 && cutoff < firstStateIndex) continue
    // 起算章仍按人物卡第一条状态；距离按书目顺序中的已写章数量计算，不用章号相减。
    const scope = firstStateIndex >= 0
      ? written.filter(id => index.chapters.findIndex(chapter => chapter.id === id) >= firstStateIndex)
      : written
    const lastId = [...scope].reverse().find(id => confirmed.includes(id)) ?? ''
    const plannedLast = [...scope].reverse().find(id => planned.includes(id)) ?? ''
    const candidateLast = [...scope].reverse().find(id => candidate.includes(id)) ?? ''
    const lastAt = lastId ? scope.indexOf(lastId) : -1
    const gap = lastAt >= 0 ? scope.length - lastAt - 1 : scope.length
    report[card.name] = {
      id: identity.id,
      identityStatus: identity.status,
      cutoff: uptoId,
      since: firstState || '',
      last: lastId,
      basis: lastId ? 'confirmed-appearance' : 'none',
      plannedLast,
      plannedBasis: plannedLast ? 'structured-plan' : 'none',
      candidateLast,
      candidateBasis: candidateLast ? 'literal-candidate' : 'none',
      gap,
      cadence: card.cadence,
      due: gap >= card.cadence,
    }
  }
  return report
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
    const identity = cardIdentity(text)
    cards.push({
      name,
      file: `${CHARACTERS_DIR}/${file.replace(/\\/gu, '/')}`,
      chars: countChars(text),
      aliases: parseCardAliases(text),
      summary: characterSummary(text),
      relations: parseRelations(text),
      states: parseStates(text),
      cadence: parseCadence(text),
      ...identity,
      rank: rankForCardRole(identity.role),
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
  await withFileLock(file, () => writeFileAtomic(file, content))
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

export function matchesCharacterMention(text, card) {
  return [card.name, ...card.aliases].some(name => name && text.includes(name))
}

export const DEAD_WORDS = /(去世|死亡|身亡|殁|阵亡|遇难|丧命|死去|丧生|断气|咽气|暴毙|被杀|身故)/u

export const ALIVE_CLAUSE = /(没死|未死|不死|假死|装死|没去世|未去世|没牺牲|没遇难|不是死|诈死)/gu

export function parseCadence(text) {
  const hit = /戏份[^\n]*?每\s*([一二三四五六七八九十百零两\d]{1,3})\s*章/u.exec(String(text ?? ''))
  if (!hit) return 0
  const value = numberFromToken(hit[1])
  return value >= 1 && value <= 60 ? value : 0
}
