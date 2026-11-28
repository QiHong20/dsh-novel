import fsp from 'node:fs/promises'
import path from 'node:path'
import { assertValidBeatStructure, BeatStructureError, hash as hashText, parseScenes, validateBeatStructure } from './beat-structure.js'
import { readText, writeFileAtomic, BEATS_FILE, parseSceneCadence, OUTLINE_FILE } from './book.js'
import { countChars } from './text.js'
import { withFileLock } from './file-lock.js'
import { beatHeading, matchBeatSection, normalizeBeatId, resolveBeatSection, scanBeatHeadings, BEAT_SECTION_AMBIGUOUS } from './beat-match.js'
// 匹配器已拆到 beat-match.js；这里转出，保持既有引用路径不变。
export { beatHeading, matchBeatSection, normalizeBeatId, resolveBeatSection, scanBeatHeadings, BEAT_SECTION_AMBIGUOUS } from './beat-match.js'
export { BEAT_STRUCTURE_INVALID } from './beat-structure.js'
// beats.js：书模型、章节读写与落盘。

export function parseBeatSections(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const headings = scanBeatHeadings(source)
  return headings.map((hit, index) => {
    const body = source.slice(hit.end, headings[index + 1]?.index ?? source.length).trim()
    return {
      id: hit.id,
      heading: hit.heading,
      body,
      chars: countChars(body),
      marks: parseBeatMarks(body),
      infos: parseBeatInfos(body),
      shifts: parseBeatShifts(body),
      interiors: parseBeatInteriors(body),
    cognition: parseBeatCognition(body),
    reactions: parseBeatReactions(body),
      events: parseBeatEventRefs(body),
      scenes: parseScenes(body, hit.id),
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

const FACE_SLAP_PAYOFF = /爽点\s*[（(]\s*打脸/u
const EXPLICIT_REACTION = /^\s*[-*+]?\s*(?:反应|对方反应)\s*[：:]\s*\S/u
const LEGACY_SCENE = /^\s*[-*+]?\s*场景\s*[：:]/u

function reactionCandidatesInLines(lines, boundary, identity) {
  const candidates = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!FACE_SLAP_PAYOFF.test(lines[index])) continue
    let explicit = false
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (boundary(lines[cursor])) break
      if (EXPLICIT_REACTION.test(lines[cursor])) {
        explicit = true
        break
      }
    }
    if (!explicit) candidates.push({ ...identity, line: index + 1 })
  }
  return candidates
}

/** 打脸反应只在所属场景块内查找；旧逐行章纲保留原有 `- 场景：` 边界。 */
export function beatReactionCandidates(section) {
  if (!section) return []
  const scenes = Array.isArray(section.scenes) ? section.scenes : parseScenes(section.body ?? '')
  if (scenes.length) {
    return scenes.flatMap(scene => reactionCandidatesInLines(
      String(scene.raw ?? '').split(/\r?\n/u),
      () => false,
      { sceneId: scene.id, title: scene.title, format: 'structured', beatHash: hashText(scene.raw ?? '') },
    ))
  }
  const lines = String(section.body ?? '').split(/\r?\n/u)
  return reactionCandidatesInLines(lines, line => LEGACY_SCENE.test(line), { sceneId: '', title: '', format: 'legacy', beatHash: hashText(section.body ?? '') })
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

export const BEAT_SECTION_CHANGED = 'BEAT_SECTION_CHANGED'

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

export async function readBeats(root, chapter, chapters = [chapter]) {
  const text = (await readText(path.join(root, BEATS_FILE))) ?? ''
  const sections = parseBeatSections(text)
  const resolved = resolveBeatSection(sections, chapter, chapters)
  const section = resolved.kind === 'matched' ? resolved.section : null
  return {
    present: text.trim().length > 0,
    baseHash: hashText(text),
    issues: validateBeatStructure(text),
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
    matchIssue: resolved.kind === 'ambiguous'
      ? { code: BEAT_SECTION_AMBIGUOUS, reason: resolved.reason, candidates: resolved.candidates, message: resolved.message }
      : null,
  }
}

function beatWriteError(message, code = BEAT_SECTION_AMBIGUOUS) {
  const error = new Error(`${message}；章纲未写入`)
  error.code = code
  return error
}

function normalizeBeatBody(content) {
  const raw = String(content ?? '').replace(/\r\n/gu, '\n').trim()
  // 节标题由插件生成；只移除开头的章标题，内部章标题必须拒绝。
  const body = raw.replace(/^#{1,6}[ \t]*\d{3,4}[^\n]*(?:\n+|$)/u, '').trim()
  if (scanBeatHeadings(body).length) {
    throw new BeatStructureError([{ code: 'chapter-heading-unexpected', severity: 'error', message: '整章内容不能包含其他章节标题' }])
  }
  return body
}

// 所有章纲修改都在同一临界区内计算、校验与原子替换。
export async function mutateBeatsFile(root, transform, baseHash) {
  const file = path.join(root, BEATS_FILE)
  return withFileLock(file, async () => {
    const original = await readText(file)
    if (baseHash !== undefined && baseHash !== hashText(original ?? '')) {
      throw beatWriteError('章纲已变化，请重新读取后保存', BEAT_SECTION_CHANGED)
    }
    const candidate = await transform(original)
    const issues = assertValidBeatStructure(candidate.text, original ?? '')
    await writeFileAtomic(file, candidate.text)
    return {
      ...candidate,
      baseHash: hashText(candidate.text),
      issues,
      warnings: issues.filter(item => item.severity === 'warning').map(item => item.message),
    }
  })
}

// 先核对全部目标，再一次原子写入，避免顺延只改了源章或目标章。
export async function writeBeatsBatch(root, updates, chapters = updates.map(item => item.chapter), baseHash) {
  const saved = await mutateBeatsFile(root, original => {
    const existing = original ?? '# 章纲\n\n> 每章一节，标题写 `## <章 id> <标题>`，正文写这一章要拍的场景。\n'
    const sections = parseBeatSections(existing)
    const prepared = updates.map(item => {
      const resolved = resolveBeatSection(sections, item.chapter, chapters)
      const prefix = item.prepend === undefined ? '' : normalizeBeatBody(item.prepend)
      const previous = resolved.kind === 'matched' ? resolved.section.body : ''
      return {
        chapter: item.chapter,
        content: item.prepend === undefined ? normalizeBeatBody(item.content) : [prefix, previous].filter(Boolean).join('\n'),
        resolved,
      }
    })
    const ambiguous = prepared.find(item => item.resolved.kind === 'ambiguous')
    if (ambiguous) throw beatWriteError(ambiguous.resolved.message)
    const claimed = new Set()
    for (const item of prepared) {
      if (item.resolved.kind !== 'matched') continue
      if (claimed.has(item.resolved.section)) throw beatWriteError('多个章纲更新指向同一个旧小节，请先核对章 ID')
      claimed.add(item.resolved.section)
    }

    const headings = scanBeatHeadings(existing)
    const newline = existing.includes('\r\n') ? '\r\n' : '\n'
    const block = item => `## ${beatHeading(item.chapter)}${newline}${newline}${item.content.replace(/\n{3,}/gu, '\n\n').replace(/\n/gu, newline)}${newline}`
    const replacements = prepared
      .filter(item => item.resolved.kind === 'matched')
      .map(item => {
        const index = sections.indexOf(item.resolved.section)
        return { item, start: headings[index].index, end: headings[index + 1]?.index ?? existing.length }
      })
      .sort((a, b) => b.start - a.start)
    let output = existing
    for (const { item, start, end } of replacements) {
      output = output.slice(0, start) + block(item) + (end < existing.length ? newline : '') + output.slice(end)
    }
    for (const item of prepared.filter(entry => entry.resolved.kind === 'missing')) {
      if (output) output += output.endsWith(newline) ? newline : newline + newline
      output += block(item)
    }
    // 写盘前按稳定章 ID 读回一次：标题尾部空白等边界不能等到落盘后才发现回执缺失。
    const writtenSections = parseBeatSections(output)
    const written = prepared.map(item => {
      const section = matchBeatSection(writtenSections, item.chapter, chapters)
      if (!section) throw new BeatStructureError([{ code: 'chapter-heading-unexpected', severity: 'error', message: `无法按章 ID ${item.chapter.id} 生成章纲小节` }])
      return { chapter: item.chapter, heading: section.heading, text: section.body, chars: section.chars }
    })
    return { text: output, written }
  }, baseHash)
  return saved.written.map(item => ({ heading: item.heading, text: item.text, chars: item.chars, baseHash: saved.baseHash, issues: saved.issues, warnings: saved.warnings }))
}

export async function writeBeats(root, chapter, content, chapters = [chapter], baseHash) {
  const [written] = await writeBeatsBatch(root, [{ chapter, content }], chapters, baseHash)
  return written
}

// 删掉某一章的整节章纲：整节搬走，别的章一个字不动。
export async function deleteBeats(root, chapter, chapters = [chapter], baseHash) {
  const saved = await mutateBeatsFile(root, original => {
    const existing = original ?? ''
    const sections = parseBeatSections(existing)
    const resolved = resolveBeatSection(sections, chapter, chapters)
    if (resolved.kind === 'ambiguous') throw beatWriteError(resolved.message)
    if (resolved.kind !== 'matched') {
      throw beatWriteError(`章纲里没有「${chapter.id} ${chapter.title}」这一节，没有可删的内容`)
    }
    const headings = scanBeatHeadings(existing)
    const index = sections.indexOf(resolved.section)
    const start = headings[index].index
    const end = headings[index + 1]?.index ?? existing.length
    const removedText = existing.slice(start, end).trim()
    const output = `${existing.slice(0, start)}${existing.slice(end)}`.replace(/\n{3,}/gu, '\n\n').trimEnd()
    return {
      text: output ? `${output}\n` : output,
      removed: { heading: resolved.section.heading, chars: resolved.section.chars, text: removedText },
    }
  }, baseHash)
  return {
    heading: saved.removed.heading,
    chars: saved.removed.chars,
    removedText: saved.removed.text,
    baseHash: saved.baseHash,
    issues: saved.issues,
    warnings: saved.warnings,
  }
}

// 删掉一章里的若干场（按场景 id），其余的场连同人物块原样保留。
export async function dropBeatsScenes(root, chapter, sceneIds, chapters = [chapter], baseHash) {
  const wanted = new Set((sceneIds ?? []).map(item => String(item).trim()).filter(Boolean))
  if (!wanted.size) throw beatWriteError('要删哪些场景？给 dropScenes（场景 id 列表）')
  const board = await readBeats(root, chapter, chapters)
  if (!board.section) throw beatWriteError(`章纲里还没有「${chapter.id} ${chapter.title}」这一节，没有可删的场景`)
  const kept = []
  const removed = []
  let skipping = false
  for (const line of board.section.body.split('\n')) {
    if (/^###\s/u.test(line)) {
      const matched = /^###\s+场景\s+([^\s：:]+)/u.exec(line)
      const id = matched ? matched[1].trim() : ''
      skipping = Boolean(id) && wanted.has(id)
      if (skipping) {
        removed.push(id)
        continue
      }
    }
    if (!skipping) kept.push(line)
  }
  if (!removed.length) {
    throw beatWriteError(`这些场景不在这章里：${[...wanted].join('、')}；先 novel_beats({ chapter }) 看现有的场景 id`)
  }
  const content = kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
  const written = await writeBeats(root, chapter, content, chapters, baseHash ?? board.baseHash)
  return { ...written, removed }
}

export function beatsCoverageFromSections(chapters, sections) {
  const covered = []
  const warnings = []
  for (const chapter of chapters) {
    const resolved = resolveBeatSection(sections, chapter, chapters)
    if (resolved.kind === 'matched' && resolved.section.chars > 0) covered.push(chapter.id)
    if (resolved.kind === 'ambiguous' && !warnings.includes(resolved.message)) warnings.push(resolved.message)
  }
  return {
    present: sections.length > 0,
    total: chapters.length,
    covered,
    missing: chapters.filter(chapter => !covered.includes(chapter.id)).map(chapter => chapter.id),
    warnings,
  }
}

export async function beatsCoverage(root, chapters) {
  const { sections } = await readBeats(root, null)
  return beatsCoverageFromSections(chapters, sections)
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

export function calculateBeatRhythm(chapters, sections, requestedLimit = 2) {
  const gapLimit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 2
  const warnings = []
  let run = 0
  let longestGap = 0
  const breaches = []
  const perChapter = chapters.map(chapter => {
    const resolved = resolveBeatSection(sections, chapter, chapters)
    if (resolved.kind === 'ambiguous' && !warnings.includes(resolved.message)) warnings.push(resolved.message)
    // 歧义章纲是未知边界：不能当作无爽点继续累加，否则后面的确定告警可能依赖了错误计数。
    const unknown = resolved.kind === 'ambiguous'
    const section = resolved.kind === 'matched' && resolved.section.chars > 0 ? resolved.section : null
    const marks = section?.marks ?? { payoff: [], hook: 0, turn: 0 }
    const hasPayoff = marks.payoff.length > 0
    const gapBefore = run
    if (unknown) run = 0
    else if (section) run = hasPayoff ? 0 : run + 1
    if (run > longestGap) longestGap = run
    const thresholdReached = Boolean(section && !hasPayoff && run === gapLimit)
    const item = {
      id: chapter.id,
      title: chapter.title,
      matchStatus: resolved.kind,
      hasBeats: Boolean(section),
      hasPayoff,
      payoff: marks.payoff.length,
      labels: marks.payoff.map(mark => mark.label).filter(Boolean),
      hook: marks.hook > 0,
      turn: marks.turn,
      gapBefore,
      gap: unknown ? gapBefore : section ? run : gapBefore,
      breached: Boolean(section && !hasPayoff && run >= gapLimit),
      thresholdReached,
    }
    if (thresholdReached) breaches.push({ id: chapter.id, title: chapter.title, gap: run })
    return item
  })
  // 当前状态只取最后一段可确认的连续统计；歧义章之后再出现的无标记章不能单独证明历史断档。
  const current = [...perChapter].reverse().find(item => item.hasBeats && item.matchStatus === 'matched')
  return {
    perChapter,
    total: perChapter.length,
    withBeats: perChapter.filter(item => item.hasBeats).length,
    payoff: perChapter.reduce((sum, item) => sum + item.payoff, 0),
    withPayoff: perChapter.filter(item => item.hasPayoff).length,
    hooks: perChapter.filter(item => item.hook).length,
    turns: perChapter.reduce((sum, item) => sum + item.turn, 0),
    longestGap,
    currentGap: current?.gap ?? 0,
    currentChapter: current?.id ?? '',
    currentBreached: current?.breached ?? false,
    gapLimit,
    breaches,
    complete: warnings.length === 0,
    warnings,
  }
}

export async function beatRhythm(root, chapters, options = {}) {
  const sections = options.sections ?? (await readBeats(root, null)).sections
  const outlineText = options.outlineText ?? (await readText(path.join(root, OUTLINE_FILE))) ?? ''
  return calculateBeatRhythm(chapters, sections, parseSceneCadence(outlineText) || 2)
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

// 删章纲前留一份原文：删是不可逆动作，至少要能翻回来看。
export async function backupBeatsFile(root) {
  const file = path.join(root, BEATS_FILE)
  const text = await readText(file)
  if (!text || !text.trim()) return ''
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)
  const dir = path.join(root, '.trash')
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, `beats-${stamp}.md`)
  await writeFileAtomic(target, text)
  return path.relative(root, target).split(path.sep).join('/')
}