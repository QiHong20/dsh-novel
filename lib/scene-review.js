// 审稿分场结构校验：覆盖全文、稳定场景认领与动作字段；审稿登记、失效和人物历史共用。

export const SCENE_ACTION_FIELDS = {
  actor: '执行动作的人物或设备；同段多个执行者分别记录',
  from: '动作前的位置、姿态及接触对象，引用段号说明来源',
  to: '动作后的位置和状态；原地操作也要说明，不用瞬移跳过通路',
  action: '具体做了什么，动作如何完成',
  tools: '使用物件、手持状态、拿取或交接来源及对应段号；未使用工具则明确说明',
  prerequisites: '动作成立的先决条件、通路与既有设定依据，引用相应段号或已读取的设定条目',
  result: '直接产生的可见结果及如何承接下一步，状态变化必须有前因',
  timing: '动作与移动、取物、对白的先后或并行关系，是否容得进已知时间窗口',
  safety: '与已出现的危险和禁令是否相容，接触危险物的防护或例外是否已有依据；无此约束也需说明',
}

/** 分场覆盖检查：范围连续完整、稳定场景 ID 合法且每个场景恰被认领一次。 */
export function sceneCoverageProblem(scenes, totalItems, sceneIds = []) {
  if (!Array.isArray(scenes) || !scenes.length) return 'scenes 不能为空：按正文顺序提交全部场景'
  const expected = sceneIds.filter(Boolean)
  const claimed = new Set()
  let nextIndex = 1
  for (const [position, scene] of scenes.entries()) {
    const label = `第 ${position + 1} 场（startIndex=${scene?.startIndex ?? '缺失'}）`
    if (!scene || typeof scene !== 'object') return `${label} 不是对象`
    if (scene.startIndex !== nextIndex) return `${label} 起点必须是 ${nextIndex}：场景要从上一场 endIndex+1 开始，连续覆盖全文且不重叠`
    if (!Number.isInteger(scene.endIndex) || scene.endIndex < scene.startIndex || scene.endIndex > totalItems) return `${label} endIndex 必须是 ${scene.startIndex}—${totalItems} 之间的整数`
    // 有结构化章纲时必须显式声明稳定场景 ID，不能靠数组下标把正文顺序当成章纲顺序。
    if (expected.length) {
      if (typeof scene.sceneId !== 'string' || !scene.sceneId.trim()) return `${label} 缺少 sceneId：本章有结构化章纲，须声明该段范围对应的场景 ID`
      if (!expected.includes(scene.sceneId)) return `${label} 的 sceneId=${scene.sceneId} 不属于本章结构化章纲`
      if (claimed.has(scene.sceneId)) return `${label} 重复认领场景 ${scene.sceneId}：每个结构化场景只能对应一个正文范围`
      claimed.add(scene.sceneId)
    }
    nextIndex = scene.endIndex + 1
  }
  if (nextIndex !== totalItems + 1) return `最后一场 endIndex 应为 ${totalItems}（当前只覆盖到 ${nextIndex - 1}）`
  const unclaimed = expected.filter(id => !claimed.has(id))
  return unclaimed.length ? `以下结构化场景未被正文分场认领：${unclaimed.join('、')}` : null
}

/** 返回第一条具体原因（null 表示通过），让调用方一眼看到是哪一场、哪个字段、哪个段号出了问题。 */
export function sceneReviewProblem(scenes, totalItems, sceneIds = []) {
  const coverage = sceneCoverageProblem(scenes, totalItems, sceneIds)
  if (coverage) return coverage
  for (const [position, scene] of scenes.entries()) {
    const label = `第 ${position + 1} 场（startIndex=${scene?.startIndex ?? '缺失'}）`
    const emptyField = ['layout', 'mechanism', 'timeline'].find(key => typeof scene[key] !== 'string' || !scene[key].trim())
    if (emptyField) return `${label} 缺少 ${emptyField}`
    if (!Array.isArray(scene.actions)) return `${label} 缺少 actions 数组`
    if (scene.reaction !== undefined) {
      const reaction = scene.reaction
      if (!scene.sceneId) return `${label} 的反应判断缺少 sceneId，不能按数组下标绑定场景`
      if (!reaction || typeof reaction !== 'object' || !['supported', 'conflict', 'uncertain'].includes(reaction.verdict)) return `${label} 的 reaction.verdict 必须是 supported/conflict/uncertain`
      if (['detail', 'counterargument'].some(key => typeof reaction[key] !== 'string' || !reaction[key].trim())) return `${label} 的 reaction 必须填写 detail 和 counterargument`
      if (!Array.isArray(reaction.evidence) || !reaction.evidence.length) return `${label} 的 reaction.evidence 至少一条`
      const local = reaction.evidence.find(reference => reference?.source === 'chapter'
        && Number.isInteger(reference.index)
        && reference.index >= scene.startIndex
        && reference.index <= scene.endIndex
        && typeof reference.quote === 'string'
        && reference.quote.trim())
      if (!local) return `${label} 的 reaction.evidence 至少一条须来自本场 ${scene.startIndex}—${scene.endIndex} 段正文`
      if (reaction.evidence.some(reference => reference?.source === 'chapter'
        && (!Number.isInteger(reference.index) || reference.index < scene.startIndex || reference.index > scene.endIndex))) return `${label} 的反应引文超出本场 ${scene.startIndex}—${scene.endIndex} 段，不能借用下一场反应`
      if (reaction.verdict === 'conflict') {
        const distinct = new Set(reaction.evidence.map(reference => JSON.stringify([reference?.source, reference?.name, reference?.index, reference?.quote])))
        if (distinct.size < 2) return `${label} 的反应判为 conflict 时需要两条不同引文`
      }
    }
    let actionIndex = scene.startIndex
    for (const [order, action] of scene.actions.entries()) {
      const actionLabel = `${label} 第 ${order + 1} 个动作`
      if (!action || !Number.isInteger(action.index)) return `${actionLabel} 缺少数值 index`
      if (action.index < actionIndex) return `${actionLabel} index=${action.index} 小于上一个动作的 ${actionIndex}：动作须按段号顺序排列`
      if (action.index > scene.endIndex) return `${actionLabel} index=${action.index} 超出本场 ${scene.startIndex}—${scene.endIndex}：放进该段所在的那一场`
      const missing = Object.keys(SCENE_ACTION_FIELDS).find(key => typeof action[key] !== 'string' || !action[key].trim())
      if (missing) return `${actionLabel} 缺少 ${missing}`
      actionIndex = action.index
    }
  }
  return null
}

export function hasCompleteSceneReviews(scenes, totalItems, sceneIds = []) {
  return sceneReviewProblem(scenes, totalItems, sceneIds) === null
}
