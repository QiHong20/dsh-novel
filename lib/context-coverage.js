/** Explicit dependencies supplement name matching; no inferred relevance certification. */
export function settingDependencies(text) {
  return [...new Set([...String(text || '').matchAll(/^- (?:依赖设定|所需设定)：([^\n]*)/gm)]
    .flatMap(m => m[1].split(/[、,，]/u).map(s => s.trim()).filter(Boolean)))]
}

export async function resolveSettingDependencies(initial, list, read) {
  const queue = [...initial], seen = new Set(), rows = [], missing = []
  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const item = list.find(s => s.name === name)
    const content = item ? await read(name) : null
    if (content === null) { missing.push(`依赖设定不存在：${name}`); continue }
    rows.push({ ...item, content: content.trim() })
    queue.push(...settingDependencies(content))
  }
  return { rows, missing }
}

/** Unstructured source text has no reliable temporal boundary. Exclude known private sections and report uncertainty. */
export function scopedAuthorMaterial(text) {
  const lines = String(text || '').split(/\r?\n/u), kept = [], excluded = []
  let hiddenLevel = 0
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      if (hiddenLevel && heading[1].length <= hiddenLevel) hiddenLevel = 0
      if (/作者侧秘密|未来|后续计划|终局|结局/u.test(heading[2])) {
        hiddenLevel = heading[1].length
        excluded.push(heading[2])
      }
    }
    if (!hiddenLevel) kept.push(line)
  }
  return { text: kept.join('\n'), excluded }
}

export function coverageReport({ missing = [], stage, settings = [], characters = [], historical = false }) {
  const gaps = [...missing]
  if (!stage?.scenes?.length) gaps.push('缺少结构化场景，无法确认事件和状态边界')
  for (const scene of stage?.scenes || []) {
    if (!scene.events.length && scene.chapterEvents?.length) gaps.push(`${scene.id}：章级事件尚未分配到场景`)
    if (scene.events.length && (!scene.fields.本场推进 || !scene.fields.本场允许结果)) gaps.push(`${scene.id}：事件推进边界未明确`)
  }
  gaps.push(...(stage?.warnings || []))
  if (historical) gaps.push('历史位置状态未完整恢复，不能以当前快照独立起稿')
  // Legacy author files may contain future assertions outside recognized headings.
  if (settings.length || characters.length) gaps.push('人物卡／设定为自由文本：未标注段落的生效及揭示边界尚未核实')
  return { version: 1, status: gaps.length ? 'needs-material-review' : 'selected-sources-covered', missing: [...new Set(gaps)], certifiesSemantics: false }
}
