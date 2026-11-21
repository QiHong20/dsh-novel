// 章纲目标章节匹配：读写入口共用一套规则，避免不同入口各自解析标题。
// 本模块不依赖 stage.js / beats.js，供两者同时引用，避免循环依赖。

export const BEAT_SECTION_AMBIGUOUS = 'BEAT_SECTION_AMBIGUOUS'

export function beatHeading(chapter) {
  return `${chapter.id} ${chapter.title}`
}

// 章纲二级标题的唯一扫描入口：逐行判定，避免全文正则在 `##` 空行上把换行当成分隔。
// 偏移量供解析和整场移动共用，标题判定与 parseBeatSections 必须一致。
export function scanBeatHeadings(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const hits = []
  let offset = 0
  for (const line of source.split('\n')) {
    if (/^##\s/u.test(line)) {
      const heading = line.replace(/^##\s*/u, '').trim()
      const id = /^(\d{1,6})\b/u.exec(heading)
      hits.push({
        index: offset,
        end: Math.min(offset + line.length + 1, source.length),
        line,
        heading,
        id: id ? id[1].padStart(4, '0') : '',
      })
    }
    offset += line.length + 1
  }
  return hits
}

export function normalizeBeatId(value) {
  const id = String(value ?? '').trim()
  return /^\d{1,6}$/u.test(id) ? id.padStart(4, '0') : id
}

function ambiguousBeatMatch(chapter, reason, candidates) {
  const target = `${chapter.id}「${String(chapter.title ?? '').trim()}」`
  const basis = reason === 'duplicate-id' ? `章 ID ${normalizeBeatId(chapter.id)}` : `无 ID 完整标题「${String(chapter.title ?? '').trim()}」`
  return {
    kind: 'ambiguous',
    reason,
    candidates: candidates.map(section => section.heading),
    message: `beats.md 中有 ${candidates.length} 个小节按${basis}匹配目标 ${target}；请核对并为目标小节保留唯一章 ID`,
  }
}

export function resolveBeatSection(sections, chapter, chapters = [chapter]) {
  if (!chapter) return { kind: 'missing', section: null }
  const id = normalizeBeatId(chapter.id)
  const byId = id ? sections.filter(section => section.id === id) : []
  if (byId.length === 1) return { kind: 'matched', matchedBy: 'id', section: byId[0] }
  if (byId.length > 1) return ambiguousBeatMatch(chapter, 'duplicate-id', byId)

  const title = String(chapter.title ?? '').trim()
  if (!title) return { kind: 'missing', section: null }
  const byLegacyTitle = sections.filter(section => !section.id && section.heading.trim() === title)
  if (byLegacyTitle.length > 1) return ambiguousBeatMatch(chapter, 'duplicate-title', byLegacyTitle)
  if (byLegacyTitle.length === 1) {
    const claimants = chapters.filter(item => item && String(item.title ?? '').trim() === title &&
      !sections.some(section => section.id === normalizeBeatId(item.id)))
    if (claimants.length !== 1 || normalizeBeatId(claimants[0].id) !== id) {
      return {
        kind: 'ambiguous',
        reason: 'shared-legacy-title',
        candidates: claimants.map(item => beatHeading(item)),
        message: `beats.md 的无 ID 小节「${title}」不能唯一归属目标 ${beatHeading(chapter)}；候选章节：${claimants.map(item => beatHeading(item)).join('、') || '无'}。请核对并补上唯一章 ID`,
      }
    }
    return { kind: 'matched', matchedBy: 'title', section: byLegacyTitle[0] }
  }
  return { kind: 'missing', section: null }
}

export function matchBeatSection(sections, chapter, chapters = [chapter]) {
  const result = resolveBeatSection(sections, chapter, chapters)
  return result.kind === 'matched' ? result.section : null
}
