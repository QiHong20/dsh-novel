// Only organize evidence and questions here; literary inference belongs to the writer.
export function presentationContext(stage, characters, partial = false) {
  const lines = [
    '明确要求以章纲原文为准；以下是有依据时可选展开的问题，不是必须填满的描写清单。资料不足标为未知，不补造稳定外貌、身世或隐秘动机。推演不自动成为章纲或人物历史。',
    '写前考虑：谁在观察、为什么注意此人；此刻在意什么→受到什么刺激→如何理解→想做什么→为何压住或改变行动。关键对白想让对方知道、相信或做什么，是否有依据需要掩饰，对方回应是否改变策略。不要每句对白后解释心理，不设数量或密度配额。',
    '区分读者首次见到与角色初次见面；没有呈现记录不代表从未描写。按距离、光线、遮挡和动作选择人物卡中可见的特征，让观察服务于当前处境。复见关注变化，不重复外貌扫描。',
    '直接内心遵守本场视角；非视角人物资料仅供作者参考，通过允许的对白与行为表现。历史情绪不自动延续到现在，正文候选须核对时序、身份和语境。',
  ]
  if (partial) lines.push('局部改写：以下全章材料仅供理解；只修改选定片段，不向范围外增加描写或改变事实。')
  const scenes = stage?.scenes || []
  if (!scenes.length) lines.push('旧版或无结构化章纲：不能可靠划分场景。结合剧情计划自行判断观察者与关键转折，不伪造场景归属。相关人物：' + (characters.map(c => c.name).join('、') || '未识别，先核对人物资料') )
  for (const scene of scenes) {
    lines.push(`### ${scene.id} ${scene.title}｜视角 ${scene.viewpoint || '待核对'}｜${scene.narration || '依文风核对'}`)
    for (const person of scene.characters || []) {
      const f = person.fields || {}
      const missing = []
      if (!f.描写重点) missing.push('描写：结合人物卡、观察动机和已有呈现选择可见特征')
      if (!f.心理内容) missing.push('心理：从目标、认知与关系依据推演关键选择，不预设情绪')
      if (!f.表达意图) missing.push('对白：核对本场诉求、声口与回应后的变化')
      lines.push(`- ${person.name} (${person.id})：明确要求见场景计划；${missing.join('；') || '已有表现字段，按触发时机自然呈现'}。`)
      const evidence = (person.history || []).filter(r => r.evidence)
      if (evidence.length) lines.push('  承接依据索引：' + evidence.map(r => `${r.chapter}/${r.scene} [${r.kind}] ${r.id}`).join('；') + '（原文证据见上方场景历史，不自动等于当前情绪）。')
    }
  }
  return lines.join('\n')
}

/** Caller supplies only chapters before the target. Matches are candidates, never history facts. */
export function selectPresentationExcerpts(chapters, names, limit = 12000) {
  const result = []
  let used = 0
  const counts = new Map()
  for (const chapter of [...chapters].reverse()) {
    const paragraphs = chapter.text.split(/\r?\n\s*\r?\n/u).map(s => s.trim()).filter(Boolean)
    const selected = new Set()
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const hits = names.filter(name => name && paragraphs[i].includes(name) && (counts.get(name) || 0) < 3)
      if (!hits.length || selected.has(i)) continue
      const from = Math.max(0, i - 1), to = Math.min(paragraphs.length, i + 2)
      if (Array.from({ length: to - from }, (_, n) => from + n).some(n => selected.has(n))) continue
      const text = paragraphs.slice(from, to).join('\n\n')
      const size = Array.from(text).length
      if (used + size > limit) continue // Never clip an evidence paragraph into a misleading fragment.
      used += size
      for (let n = from; n < to; n++) selected.add(n)
      for (const name of hits) counts.set(name, (counts.get(name) || 0) + 1)
      result.push({ chapter: chapter.id, title: chapter.title, paragraph: from + 1, names: hits, text })
    }
  }
  return result
}

export function renderPresentationExcerpts(excerpts) {
  return '以下按人物名字检索的前文原文候选，不认证关系、情绪或首次登场；同段出现不证明直接互动。章节顺序不等于故事时序：倒叙时不得把这些材料转为角色已知，认知仍以场景有效历史为准。优先结合已确认历史核对，未命中不代表没有发生。\n' +
    (excerpts.length ? excerpts.map(e => `### ${e.chapter} ${e.title}${e.scene ? '｜场景 ' + e.scene : ''}｜原文段落 ${e.paragraph} 起｜命中 ${e.names.join('、')}\n${e.text}`).join('\n\n') : '未选到可用原文候选，需按需补读。')
}
