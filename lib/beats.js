import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { parseScenes } from '../stage.js'
import { readText, BEATS_FILE, parseSceneCadence, OUTLINE_FILE } from './book.js'
import { countChars } from './text.js'
// beats.js：书模型、章节读写与落盘。

export function parseBeatSections(text) {
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
    cognition: parseBeatCognition(body),
    reactions: parseBeatReactions(body),
      events: parseBeatEventRefs(body),
      scenes: parseScenes(body, match ? match[1].padStart(4, '0') : ''),
    }
  })
}

export function parseBeatShifts(body) {
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

export function parseBeatReactions(body) {
  const lines = String(body ?? '').split(/\r?\n/u)
  const hits = []
  for (let index = 0; index < lines.length; index += 1) {
    const found = /^\s*[-*+]?\s*(?:反应|对方反应)\s*[：:]\s*(.+)$/u.exec(lines[index])
    if (found) hits.push({ index, text: found[1].trim() })
  }
  return hits
}

export function parseBeatCognition(body) {
  const rows = []
  String(body ?? '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .forEach((line, index) => {
      const match = /^\s*[-*+]?\s*(?:认知|知道什么|认知边界)\s*[：:]\s*(.+)$/u.exec(line)
      if (match) rows.push({ index, text: match[1].trim().slice(0, 200) })
    })
  return rows
}

export function parseBeatInteriors(body) {
  const rows = []
  String(body ?? '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .forEach((line, index) => {
      const match = /^\s*[-*+]?\s*(?:心里|心理|念头|回忆)\s*[：:]\s*(.+)$/u.exec(line)
      if (!match) return
      const raw = match[1].trim()
      const parts = raw.split(/[｜|]/u)
      const mood = parts.length > 1 ? parts[0].trim() : ''
      const words = (parts.length > 1 ? parts.slice(1).join('｜').trim() : raw).slice(0, 200)
      rows.push({ index, text: raw.slice(0, 200), mood, line: words })
    })
  return rows
}

export function parseBeatMarks(body) {
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

export function beatHeading(chapter) {
  return `${chapter.id} ${chapter.title}`
}

export function matchBeatSection(sections, chapter) {
  const id = String(chapter.id).padStart(4, '0')
  const byId = sections.find(section => section.id === id)
  if (byId) return byId
  if (!chapter.title) return null
  return sections.find(section => section.heading.includes(chapter.title)) ?? null
}

export function parseBeatInfos(body) {
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

export function parseBeatEventRefs(body) {
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

export async function readBeats(root, chapter) {
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
            interiors: section.interiors,
    cognition: section.cognition,
            reactions: section.reactions,
            shifts: section.shifts,
            scenes: section.scenes,
          }
      : null,
  }
}

export async function writeBeats(root, chapter, content) {
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

export async function beatsCoverage(root, chapters) {
  const { sections } = await readBeats(root, null)
  const covered = []
  for (const chapter of chapters) {
    const section = matchBeatSection(sections, chapter)
    if (section && section.chars > 0) covered.push(chapter.id)
  }
  return { present: sections.length > 0, total: chapters.length, covered, missing: chapters.filter(c => !covered.includes(c.id)).map(c => c.id) }
}

export function beatCoverage(text, beatsText) {
  const structured = parseScenes(String(beatsText || ''))
  if (structured.length) beatsText = structured.map(scene => '- 场景：' + (scene.raw.match(/^- 冲突：(.+)$/m)?.[1] || scene.title)).join('\n')
  const source = String(text ?? '')
  const markerPattern = /^(?:信息|落点|钩子|爽点|转折|位移|反应|心里|心理|念头|回忆|认知|备注|注)\s*[：:]/u
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

export async function beatRhythm(root, chapters) {
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

export function payoffBudget(outlineText) {
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

export const BEAT_MARK = /(?:→|->|—>|=>)\s*(爽点|钩子|转折)\s*(?:[（(]([^）)]{0,24})[）)])?/gu

export const BEAT_MARK_COLON = /(?:^|[\s、，,。；;])(爽点|钩子|转折)\s*[：:]\s*([^\n]{0,24})/u

export const BEAT_MARK_TAIL = /(?:^|[\s、，,。；;])(爽点|钩子|转折)\s*(?:[（(]([^）)]{0,24})[）)])?\s*$/u
