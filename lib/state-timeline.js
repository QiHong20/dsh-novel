// Planned state only: never backfill from the current ledger or infer arithmetic.
export function stateTimeline(chapterMatches) {
  const current = new Map()
  return Object.fromEntries(chapterMatches.map(match => {
    if (match.status !== 'matched') {
      current.clear()
      return [match.id, []]
    }
    const changes = new Map()
    for (const scene of match.section.scenes || []) {
      const fields = scene.fields || {}
      const ids = (fields.状态对象 || '').split(/[、,，]/u).map(s => s.trim()).filter(Boolean)
      if (!ids.length) continue
      // Explicit field is preferred. Existing single-object outlines may carry a numeric transition in 结果.
      const explicit = fields.状态变化
      const source = explicit || (ids.length === 1 ? fields.结果 || '' : '')
      const rows = [...source.matchAll(/([^\s；;：:，,。]+)[：:]?\s+(-?\d+(?:\.\d+)?)\s*→\s*(-?\d+(?:\.\d+)?)/gu)]
      for (const id of ids) {
        const row = rows.find(r => r[1] === id) || (ids.length === 1 && rows.length === 1 ? rows[0] : null)
        const prior = current.get(id)
        const item = { id, name: row?.[1] || prior?.name || id, before: row?.[2] || null, value: row?.[3] || null,
          chapter: match.id, scene: scene.id, title: scene.title,
          warning: !row ? '已关联状态对象，但未记录明确变化' : prior?.value != null && prior.value !== row[2] ? `起值与上次 ${prior.value} 不一致` : '',
          source: source || '待补充状态变化' }
        current.set(id, item)
        changes.set(id, [...(changes.get(id) || []), item])
      }
    }
    return [match.id, [...current.values()].map(item => ({ ...item, inherited: !changes.has(item.id), changes: changes.get(item.id) || [] }))]
  }))
}
