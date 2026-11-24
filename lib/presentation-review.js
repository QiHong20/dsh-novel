import { hash } from './beat-structure.js'

/** Explicit author requirements are separate from optional craft suggestions. */
export function presentationRequirements(scenes = []) {
  const items = []
  for (const scene of scenes) {
    const add = (character, code, level, detail) => {
      const id = `${scene.id}/${character || 'scene'}/${code}`
      items.push({ id, scene: scene.id, character, code, level, required: level !== 'suggestion', detail,
        fingerprint: hash(JSON.stringify([id, level, detail, scene.raw])) })
    }
    for (const role of scene.roles || []) {
      const f = role.fields || {}
      if (f.必须表现) add(role.id, 'explicit', 'requirement', f.必须表现)
      if (f.保留心声原句) add(role.id, 'literal-thought', 'requirement', `保留心声原句：${f.保留心声原句}；仍须遵守视角权限，冲突时报告而非强行写入。`)
      if (f.视角权限 === '仅作者参考') add(role.id, 'author-only', 'boundary', '本人物心理材料仅作者参考，不可直接写为该人物内心。')
      if (scene.narration === '限知' && scene.viewpoint && scene.viewpoint !== role.id && f.心理内容) add(role.id, 'viewpoint', 'boundary', `限知视角为 ${scene.viewpoint}；不得直接读取 ${role.id} 的内心。`)
      if (f.心理内容) add(role.id, 'psychology', 'suggestion', '考虑关键心理材料如何自然影响行为或对白；不要求写内心独白，不重复解释。')
      if (f.描写重点 || /首次正式登场|初次正式登场/u.test(f.登场性质 || '')) add(role.id, 'appearance', 'suggestion', '按观察动机自然呈现可见特征；可说明不采用，不要求完整外貌扫描。')
    }
    for (const [field, code] of [['本场允许结果', 'event-result'], ['禁止提前兑现', 'event-boundary']]) {
      if (scene.fields?.[field]) add('', code, field === '禁止提前兑现' ? 'boundary' : 'requirement', `${field}：${scene.fields[field]}；事件关联：${scene.events?.join('、') || '未明确，需核对'}`)
    }
  }
  return items
}

export function validatePresentationReviews(requirements, submitted = [], scenes = [], paragraphs = []) {
  if (!Array.isArray(submitted)) throw new Error('presentationReviews 必须是数组')
  const seen = new Set(), findings = [], evidence = []
  for (const entry of submitted) {
    const requirement = requirements.find(r => r.id === entry?.id)
    if (!requirement || seen.has(entry.id)) throw new Error('表现核对存在未知或重复要求 ID')
    seen.add(entry.id)
    if (entry.fingerprint !== requirement.fingerprint) throw new Error(`表现要求已变化：${entry.id}，请重新取审稿包`)
    if (!['supported', 'conflict', 'uncertain', 'not-applicable'].includes(entry.verdict) ||
      ['detail', 'counterargument'].some(k => typeof entry[k] !== 'string' || !entry[k].trim())) throw new Error(`表现核对 ${entry.id} 必须填写结论、说明和反证`)
    if (!Array.isArray(entry.evidence) || !entry.evidence.length) throw new Error(`表现核对 ${entry.id} 缺少本场正文证据`)
    const range = scenes.find(s => s.sceneId === requirement.scene)
    for (const ref of entry.evidence) {
      if (ref.source !== 'chapter' || !Number.isInteger(ref.index) || !range || ref.index < range.startIndex || ref.index > range.endIndex ||
        typeof ref.quote !== 'string' || !ref.quote.trim() || !paragraphs.find(p => p.index === ref.index)?.text.includes(ref.quote)) throw new Error(`表现核对 ${entry.id} 必须引用对应场景的逐字正文，不能借其他场景`)
      evidence.push({ aspect: 'narration', reference: ref })
    }
    if (requirement.required && ['conflict', 'uncertain'].includes(entry.verdict)) findings.push({ aspect: 'narration', verdict: entry.verdict, detail: `[${entry.id}] ${entry.detail}`, evidence: entry.evidence, counterargument: entry.counterargument })
  }
  const missing = requirements.filter(r => r.required && !seen.has(r.id))
  if (missing.length) throw new Error(`必要表现要求未核对：${missing.map(r => r.id).join('、')}；提交 presentationReviews，建议项不要求清零`)
  return { findings, evidence }
}

export function presentationReviewView(requirements, review, baseHash) {
  const results = requirements.map(item => {
    const saved = review?.presentationReviews?.find(r => r.id === item.id)
    const current = saved && review.baseHash === baseHash && saved.fingerprint === item.fingerprint
    return { ...item, status: !saved ? item.required ? 'pending' : 'optional' : !current ? 'stale' : saved.verdict,
      ...(current ? { result: saved } : {}) }
  })
  return { items: results, required: results.filter(r => r.required).length, optional: results.filter(r => !r.required).length,
    pending: results.filter(r => r.required && ['pending', 'stale'].includes(r.status)).length,
    reviewed: results.filter(r => r.required && ['supported', 'not-applicable'].includes(r.status)).length,
    conflicts: results.filter(r => r.required && r.status === 'conflict').length,
    uncertain: results.filter(r => r.required && r.status === 'uncertain').length }
}
