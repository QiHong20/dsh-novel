import { hash } from './beat-structure.js'
import { extractIndexedParagraphs } from './text.js'
import { sceneCoverageProblem } from './scene-review.js'

/** 只从通过分场和版本校验的场景提取完整段落。 */
export function priorContext(book, targets, names) {
  const missing = [], excluded = [], blocks = []
  const position = scene => book.scenes.findIndex(s => s.id === scene.id)
  if (!targets.length || targets.some(t => t.time === null || position(t) < 0)) {
    return { excerpts: [], tail: { id: '', title: '', text: '' }, missing: ['前文目标场景或时序未明确'], excluded, status: 'incomplete' }
  }
  const firstPosition = Math.min(...targets.map(position))
  const minimumTime = Math.min(...targets.map(t => t.time))
  const relevantChapters = new Set(book.scenes.slice(0, firstPosition).map(s => s.chapter))
  // A prior written chapter without scene mapping is a gap, even if no name search would hit it.
  const firstChapter = Math.min(...targets.map(t => book.chapters.findIndex(c => c.id === t.chapter)))
  for (const c of book.chapters.slice(0, firstChapter)) relevantChapters.add(c.id)
  for (const chapter of book.chapters.filter(c => relevantChapters.has(c.id))) {
    const text = book.sources.get(chapter.id) || ''
    if (!text.trim()) continue
    const paragraphs = extractIndexedParagraphs(text)
    const scenes = book.scenes.filter(s => s.chapter === chapter.id)
    const review = chapter.deaiReview
    if (!review || review.baseHash !== hash(text) || !Array.isArray(review.scenes) ||
      !scenes.length || sceneCoverageProblem(review.scenes, paragraphs.length, scenes.map(s => s.id))) {
      missing.push(`${chapter.id}：前文缺少当前版本的完整正文分场，未装配`)
      continue
    }
    for (const range of review.scenes) {
      const scene = scenes.find(s => s.id === range.sceneId)
      if (position(scene) >= firstPosition) continue
      if (!Number.isSafeInteger(scene.time) || scene.time >= minimumTime) {
        excluded.push({ chapter: chapter.id, scene: scene.id, reason: '故事时间未明确或不早于目标；不能作为历史承接' })
        continue
      }
      if (review.priorSceneBindings?.[scene.id] !== hash(scene.raw)) {
        missing.push(`${chapter.id}/${scene.id}：前文场景版本未绑定或已变化，需重新登记分场复核`)
        continue
      }
      const items = paragraphs.filter(p => p.index >= range.startIndex && p.index <= range.endIndex)
      blocks.push({ chapter: chapter.id, title: chapter.title, scene: scene.id, time: scene.time, items,
        sourceHash: review.baseHash, sceneHash: hash(scene.raw), order: position(scene) })
    }
  }
  blocks.sort((a, b) => a.order - b.order)
  const excerpts = []
  // 承接只能来自相邻前场，至少保留最后一个完整段落。
  const immediate = book.scenes[firstPosition - 1]
  const tailBlock = blocks.find(b => b.scene === immediate?.id)
  const tailItems = []
  let tailSize = 0
  for (const paragraph of (tailBlock?.items ?? []).slice().reverse()) {
    const size = Array.from(paragraph.text).length + (tailItems.length ? 2 : 0)
    if (tailItems.length && tailSize + size > 6000) break
    tailSize += size
    tailItems.unshift(paragraph)
  }
  const tailStart = tailItems[0]?.index ?? Infinity
  for (const block of [...blocks].reverse()) {
    for (const p of block.items) {
      if (block === tailBlock && p.index >= tailStart) continue
      const hits = names.filter(name => name && p.text.includes(name))
      if (!hits.length) continue
      excerpts.push({ ...block, items: undefined, paragraph: p.index, names: hits, text: p.text })
    }
  }
  return { excerpts, tail: tailBlock && tailItems.length ? { id: tailBlock.chapter, title: tailBlock.title, scene: tailBlock.scene,
    sourceHash: tailBlock.sourceHash, sceneHash: tailBlock.sceneHash, text: tailItems.map(p => p.text).join('\n\n') } : { id: '', title: '', text: '' },
    missing: [...new Set(missing)], excluded, status: missing.length ? 'incomplete' : 'scene-time-filtered',
    policy: '仅筛选来源场景的时间与版本；引文中的传闻、回忆和预告不自动成为事实，角色认知仍以已确认人物历史为准。' }
}
