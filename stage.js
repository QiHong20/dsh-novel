import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const hash = value => createHash('sha256').update(value).digest('hex')
const safeId = value => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value || '')) throw new Error('ID 必须为字母、数字、下划线或连字符')
  return value
}
const read = async file => { try { return await fs.readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return ''; throw e } }
const fields = text => Object.fromEntries([...text.matchAll(/^- ([^：\n]+)：([^\n]*)$/gm)].map(m => [m[1], m[2].trim()]))
const list = text => (text || '').split(/[、,，]/).map(s => s.trim()).filter(Boolean)

export const PSYCHOLOGY_FIELDS = ['心理触发', '心理内容', '叙事作用', '表达方式', '展开程度', '视角权限', '保留心声原句']
export const APPEARANCE_FIELDS = ['登场性质', '观察者', '描写重点', '呈现时机', '第一印象', '已呈现与新增', '不描写原因']
export const ROLE_FIELDS = ['已知', '未知', '误信', '怀疑', '目标', '关系与情绪', '表达意图', '触发', '计划变化', ...PSYCHOLOGY_FIELDS, ...APPEARANCE_FIELDS]
export const SCENE_FIELDS = ['故事时间', '时序', '地点', '视角', '叙述方式', '出场', '提及', '事件', '冲突', '结果', '转折', '落点', '钩子']
export const CHAPTER_FIELDS = ['本章目标', '收尾']
export const PRESENTATION_RULES = '小说心理与登场原则：按关键决定、误解或认知转变安排心理材料，不设数量和密度配额，不在每句对白后解释。主配角均可有心理，但直接呈现必须遵守本场叙述视角；仅作者参考不写成可直接读取的内心。允许联想、短回忆、间接叙述，只有「保留心声原句」要求保留原句。重要人物首次正式登场应考虑体态、面容、衣着、声音等可辨认特征，融入观察和动作；暗处、伪装等可说明不描写原因。后续出场以唤起特征或变化为主，不用外貌篇幅代替人物重要性。计划不是已经向读者呈现的事实。'
const pick = (f, keys) => Object.fromEntries(keys.filter(key => f[key]).map(key => [key, f[key]]))

export function presentationChecks(scene, cards = []) {
  const items = []
  for (const role of scene.roles) {
    const f = role.fields
    const card = cards.find(c => c.id === role.id)
    const add = (code, detail) => items.push({ code, scene: scene.id, character: role.id, type: '语义待核对', detail })
    if (f.心理内容) {
      add('psychology-plan', '核对关键心理材料是否自然呈现、是否重复解释对白；仅作者参考的内容应通过允许的方式表达。')
      if (!f.视角权限 || (scene.narration !== '全知' && scene.viewpoint !== role.id && f.视角权限 === '可直接呈现')) add('perspective', '核对本场视角权限；非视角人物不能因地位重要就直接展示内心。全知叙述须明确标记。')
    }
    if (/首次正式登场|初次正式登场/.test(f.登场性质 || '') && /核心|重要/.test(card?.importance || '') && !f.描写重点 && !f.不描写原因) add('appearance-plan', '重要人物首次正式登场：考虑描写重点，或注明不描写原因；这是提示，不要求完整外貌扫描。')
    if (f.描写重点) add('appearance-review', '核对描写是否融入动作与观察、是否重复已有描写。计划不能代表读者已见过。')
  }
  return items
}

export function chapterOverview(text, chapter = '') {
  const scenes = parseScenes(text, chapter)
  return { fields: fields(text.split(/^### /m)[0]), scenes: scenes.map(s => ({
    id: s.id, title: s.title, cast: s.cast, events: s.events, fields: s.fields,
    summary: ['冲突', '结果', '转折', '落点', '钩子'].filter(k => s.fields[k]).map(k => `${k}：${s.fields[k]}`).join('\n'),
  })), cast: [...new Set(scenes.flatMap(s => s.cast))], events: [...new Set(scenes.flatMap(s => s.events))] }
}

export function cardIdentity(text) {
  const f = fields(text.split(/^## /m)[0])
  return { id: f.ID || '', role: f.定位 || '', importance: f.重要程度 || '未设置' }
}

export function parseScenes(text, chapter = '') {
  const starts = [...text.matchAll(/^### 场景 ([\w-]+)：([^\n]*)$/gm)]
  return starts.map((m, i) => {
    const raw = text.slice(m.index, starts[i + 1]?.index ?? text.length).trim()
    const head = raw.split(/^#### /m)[0]
    const f = fields(head)
    const roles = [...raw.matchAll(/^#### 人物 ([\w-]+)[ \t]*\r?$/gm)].map((r, j, all) => {
      const constraints = raw.slice(r.index + r[0].length, all[j + 1]?.index ?? raw.length).trim()
      const rf = fields(constraints)
      return { id: r[1], constraints, fields: rf, psychology: pick(rf, PSYCHOLOGY_FIELDS), appearance: pick(rf, APPEARANCE_FIELDS) }
    })
    return { id: m[1], title: m[2].trim(), chapter, raw, fields: f, viewpoint: f.视角 || '', narration: f.叙述方式 || '', cast: list(f.出场), mentioned: list(f.提及),
      time: /^-?\d+$/.test(f.时序 || '') ? Number(f.时序) : null,
      storyTime: f.故事时间 || '', events: list(f.事件), roles }
  })
}

export async function stageBook(root, chapters) {
  const beats = await read(path.join(root, 'beats.md'))
  const sections = [...beats.matchAll(/^## (\d+)\b[^\n]*\n/gm)]
  const scenes = sections.flatMap((s, i) => parseScenes(beats.slice(s.index + s[0].length, sections[i + 1]?.index ?? beats.length), s[1]))
  scenes.sort((a, b) => chapters.findIndex(c => c.id === a.chapter) - chapters.findIndex(c => c.id === b.chapter))
  const cards = []
  for (const file of await fs.readdir(path.join(root, 'characters')).catch(e => { if (e.code === 'ENOENT') return []; throw e })) {
    if (!file.endsWith('.md')) continue
    const content = await read(path.join(root, 'characters', file))
    cards.push({ ...cardIdentity(content), name: file.slice(0, -3), content })
  }
  const records = []
  for (const file of await fs.readdir(path.join(root, 'character-history')).catch(e => { if (e.code === 'ENOENT') return []; throw e })) {
    if (!file.endsWith('.md')) continue
    const text = await read(path.join(root, 'character-history', file))
    for (const m of text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) records.push(JSON.parse(m[1]))
  }
  const sources = new Map()
  for (const chapter of chapters) sources.set(chapter.id, await read(path.resolve(root, chapter.file)))
  const warnings = []
  for (const [label, items] of [['人物', cards], ['场景', scenes]]) {
    const seen = new Set()
    for (const item of items) {
      if (!item.id || seen.has(item.id)) warnings.push(`${label} ID 缺失或重复：${item.id || item.name}`)
      seen.add(item.id)
    }
  }
  const eventText = await read(path.join(root, 'events.md'))
  const events = new Set([...eventText.matchAll(/^### (\S+)/gm)].map(m => m[1]))
  for (const scene of scenes) {
    if (scene.time === null) warnings.push(`${scene.id}：缺少整数时序，不能推断故事时间`)
    for (const id of scene.cast) if (!cards.some(c => c.id === id)) warnings.push(`${scene.id}：人物引用不存在 ${id}`)
    for (const id of scene.events) if (!events.has(id)) warnings.push(`${scene.id}：事件引用不存在 ${id}`)
    for (const role of scene.roles) if (!scene.cast.includes(role.id)) warnings.push(`${scene.id}：人物约束 ${role.id} 未列入出场`)
    for (const id of scene.cast) if (!scene.roles.some(r => r.id === id)) warnings.push(`${scene.id}：${id} 缺少本场目标与认知约束`)
  }
  for (const record of records) {
    const scene = scenes.find(s => s.id === record.scene)
    record.valid = record.status === 'confirmed' && !!scene && scenes.filter(s => s.id === record.scene).length === 1 &&
      cards.filter(c => c.id === record.character).length === 1 && scene.cast.includes(record.character) && scene.chapter === record.chapter &&
      scene.time === record.time && hash(scene.raw) === record.sceneHash &&
      hash(sources.get(record.chapter) || '') === record.sourceHash &&
      !!record.evidence && (sources.get(record.chapter) || '').includes(record.evidence)
  }
  // A correction is unusable if its source record was invalidated.
  for (let n = 0; n < records.length; n++) for (const r of records) {
    if (r.valid && r.supersedes && !records.some(p => p.id === r.supersedes && p.valid)) r.valid = false
  }
  for (const r of records) if (r.status === 'confirmed' && !r.valid) warnings.push(`认知 ${r.id} 来源或场景已变化，待复核；后续不得继承`)
  const impacts = records.filter(r => r.status === 'confirmed' && !r.valid).map(r => ({
    record: r.id, character: r.character, content: r.content,
    scenes: scenes.filter(s => s.cast.includes(r.character) && s.time !== null && s.time > r.time).map(s => ({ id: s.id, chapter: s.chapter, title: s.title })),
  }))
  const eventStarts = [...eventText.matchAll(/^### (\S+)([^\n]*)\n/gm)]
  const eventNodes = eventStarts.map((m, i) => ({ id: m[1], title: m[2].trim(),
    plan: eventText.slice(m.index + m[0].length, eventStarts[i + 1]?.index ?? eventText.length).split(/^## /m)[0].trim() }))
  return { scenes, cards, records, sources, warnings, events, impacts, eventNodes, baseHash: hash(beats) }
}

export function sceneState(book, scene) {
  return scene.cast.map(id => {
    const card = book.cards.find(c => c.id === id)
    const eligible = book.records.filter(r => r.kind !== '呈现' && r.character === id && r.valid && scene.time !== null && r.time < scene.time)
    const replaced = new Set(eligible.map(r => r.supersedes).filter(Boolean))
    const history = eligible.filter(r => !replaced.has(r.id)).sort((a, b) => a.time - b.time)
    const presented = book.records.filter(r => r.kind === '呈现' && r.character === id && r.valid &&
      book.scenes.findIndex(s => s.id === r.scene) < book.scenes.indexOf(scene))
    return { id, name: card?.name || id, role: card?.role || '', importance: card?.importance || '',
      history, presented, ...scene.roles.find(r => r.id === id),
      constraints: scene.roles.find(r => r.id === id)?.constraints || '',
      gap: history.length ? '' : '未记录：不代表明确未知。请核对正文或补充人物历史。' }
  })
}

export async function stageContext(root, chapters, chapter, sceneId) {
  const book = await stageBook(root, chapters)
  const scenes = book.scenes.filter(s => s.chapter === chapter && (!sceneId || s.id === sceneId))
  if (sceneId && scenes.length !== 1) throw new Error('场景不存在或 ID 重复')
  const views = scenes.map(scene => ({ ...scene, characters: sceneState(book, scene) }))
  const reviews = scenes.flatMap(scene => presentationChecks(scene, book.cards))
  const eventIds = [...new Set(scenes.flatMap(s => s.events))]
  const events = eventIds.map(id => ({ id, ...book.eventNodes.find(e => e.id === id),
    scenes: scenes.filter(s => s.events.includes(id)).map(s => s.id),
    confirmed: book.records.filter(r => r.valid && r.event === id && scenes.some(s => s.time !== null && r.time <= s.time)),
    note: '事件内容是规划；确认记录只证明所列人物变化，不代表整个事件已经完成。' }))
  const text = views.length ? [
    '以下入场历史仅包含已确认且来源有效的事实。作者秘密不等于人物已知；误信不等于客观事实。',
    '场景约束和离场变化均为计划；同章前场计划也不得冒充已确认历史。缺失资料先核对正文。场内变化仅在触发之后生效。',
    PRESENTATION_RULES,
    ...views.map(s => `### ${s.id} ${s.title}（时序 ${s.time ?? '未明确'}；视角 ${s.viewpoint || '待明确'}；叙述方式 ${s.narration || '依作品文风，需核对'}）\n${s.characters.map(c =>
      `人物 ${c.name} (${c.id})｜${c.role}｜${c.importance}\n${c.gap}\n已确认入场历史：\n${c.history.map(r => `- [${r.kind}] ${r.content}${r.target ? `；对象：${r.target}` : ''}；来源：${r.source}；记录 ${r.id}；证据 ${r.chapter}/${r.scene}：${r.evidence}`).join('\n') || '（无）'}\n读者此前已见的呈现（不等于角色已知）：\n${c.presented.map(r => `- ${r.content}（${r.chapter}/${r.scene}）`).join('\n') || '未记录，不代表从未描写'}\n本场计划约束：\n${c.constraints || '未填写'}`).join('\n\n')}`),
    ...book.warnings.map(w => `⚠ ${w}`),
  ].join('\n\n') : ''
  return { scenes: views, warnings: book.warnings, impacts: book.impacts, reviews, events,
    records: book.records.filter(r => r.chapter === chapter), baseHash: book.baseHash, text }
}

const locks = new Map()
export function patchStageText(text, args) {
  if (!args.baseHash || args.baseHash !== hash(text)) throw new Error('章纲已变化，请重新读取后保存；未覆盖其他修改')
  if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) throw new Error('需要 fields 字段对象')
  const chapters = [...text.matchAll(/^## (\d+)\b[^\n]*(?:\n|$)/gm)]
  const matches = chapters.filter(m => m[1] === args.chapter)
  if (matches.length !== 1) throw new Error('章节不存在或重复')
  const chapter = matches[0]
  let start = chapter.index + chapter[0].length
  let end = chapters[chapters.indexOf(chapter) + 1]?.index ?? text.length
  let allowed = CHAPTER_FIELDS
  if (args.scene) {
    const scenes = [...text.slice(start, end).matchAll(/^### 场景 ([\w-]+)：[^\n]*(?:\n|$)/gm)]
    const found = scenes.filter(m => m[1] === args.scene)
    if (found.length !== 1) throw new Error('场景不存在或重复')
    const scene = found[0]
    end = start + (scenes[scenes.indexOf(scene) + 1]?.index ?? (end - start))
    start += scene.index + scene[0].length
    allowed = SCENE_FIELDS
    if (args.character) {
      const roles = [...text.slice(start, end).matchAll(/^#### 人物 ([\w-]+)[ \t]*\r?(?:\n|$)/gm)]
      const foundRoles = roles.filter(m => m[1] === args.character)
      if (foundRoles.length !== 1) throw new Error('人物块不存在或重复，请在原始章纲中补充')
      const role = foundRoles[0]
      end = start + (roles[roles.indexOf(role) + 1]?.index ?? (end - start))
      start += role.index + role[0].length
      allowed = ROLE_FIELDS
    } else {
      const next = /^#### /m.exec(text.slice(start, end))
      if (next) end = start + next.index
    }
  } else {
    if (args.character) throw new Error('编辑人物需要指定场景')
    const next = /^### /m.exec(text.slice(start, end))
    if (next) end = start + next.index
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let body = text.slice(start, end)
  for (const [key, value] of Object.entries(args.fields)) {
    if (!allowed.includes(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`不支持的字段或多行值：${key}`)
    const re = new RegExp(`^- ${key}：[^\\n]*(?:\\n|$)`, 'gm')
    const found = [...body.matchAll(re)]
    if (found.length > 1) throw new Error(`字段 ${key} 重复，请在原始章纲中核对`)
    if (found.length) body = body.replace(re, () => value ? `- ${key}：${value}${newline}` : '')
    else if (value) body += (body && !body.endsWith('\n') ? newline : '') + `- ${key}：${value}${newline}`
  }
  return text.slice(0, start) + body + text.slice(end)
}

export async function editStageFields(root, args) {
  const previous = locks.get(root) || Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    const file = path.join(root, 'beats.md')
    const original = await read(file)
    const text = patchStageText(original, args)
    if (await read(file) !== original) throw new Error('章纲已变化，请重新读取')
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
    return { ok: true, baseHash: hash(text) }
  })
  locks.set(root, next)
  try { return await next } finally { if (locks.get(root) === next) locks.delete(root) }
}

export async function updateHistory(root, chapters, args) {
  const previous = locks.get(root) || Promise.resolve()
  const next = previous.catch(() => {}).then(() => updateUnlocked(root, chapters, args))
  locks.set(root, next)
  try { return await next } finally { if (locks.get(root) === next) locks.delete(root) }
}

async function updateUnlocked(root, chapters, args) {
  const book = await stageBook(root, chapters)
  if (args.action === 'inspect' || !args.action) return { records: book.records, warnings: book.warnings, impacts: book.impacts }
  const character = safeId(args.character)
  if (book.cards.filter(c => c.id === character).length !== 1) throw new Error('人物 ID 不存在或重复')
  let record
  if (args.action === 'propose') {
    const scene = book.scenes.find(s => s.id === args.scene)
    if (!scene || book.scenes.filter(s => s.id === args.scene).length !== 1 || !scene.cast.includes(character) || scene.time === null) throw new Error('需要唯一场景、出场人物和明确时序')
    const text = book.sources.get(scene.chapter) || ''
    if (!args.evidence?.trim() || !text.includes(args.evidence)) throw new Error('依据必须是该章正文的逐字引文')
    if (!args.content?.trim() || !args.source?.trim()) throw new Error('必须提供认知内容及信息来源')
    if (!['已知', '未知', '误信', '怀疑', '关系', '状态', '呈现'].includes(args.kind)) throw new Error('认知类型无效')
    if (args.target && !book.cards.some(c => c.id === args.target)) throw new Error('关系目标人物不存在')
    if (args.kind === '关系' && !args.target) throw new Error('关系变化必须指定目标人物 target')
    if (args.event && !book.events.has(args.event)) throw new Error('事件节点不存在')
    if (args.supersedes && !book.records.some(r => r.id === args.supersedes && r.character === character && r.valid && r.time < scene.time)) throw new Error('被修正记录必须是本人物此前的有效记录')
    record = { id: randomUUID(), character, scene: scene.id, chapter: scene.chapter, time: scene.time,
      content: args.content, kind: args.kind, source: args.source, evidence: args.evidence,
      target: args.target || '', event: args.event || '', supersedes: args.supersedes || '',
      status: 'candidate', sourceHash: hash(text), sceneHash: hash(scene.raw) }
    book.records.push(record)
  } else {
    record = book.records.find(r => r.id === args.id && r.character === character)
    if (!record) throw new Error('找不到认知记录')
    if (!['confirm', 'revoke'].includes(args.action)) throw new Error('操作无效')
    if (args.action === 'confirm') {
      const scene = book.scenes.find(s => s.id === record.scene)
      if (!scene || hash(scene.raw) !== record.sceneHash || hash(book.sources.get(record.chapter) || '') !== record.sourceHash) throw new Error('来源已变化，请重新提取候选，不得确认旧记录')
      if (record.supersedes && !book.records.some(r => r.id === record.supersedes && r.valid)) throw new Error('前置记录已失效')
    }
    record.status = args.action === 'confirm' ? 'confirmed' : 'revoked'
  }
  const rows = book.records.filter(r => r.character === character).map(({ valid, ...r }) => r)
  const dir = path.join(root, 'character-history')
  await fs.mkdir(dir, { recursive: true })
  const dest = path.join(dir, `${character}.md`)
  const tmp = `${dest}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, `# 人物经历：${character}\n\n${rows.map(r => `## ${r.id} · ${r.status}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``).join('\n\n')}\n`, 'utf8')
  await fs.rename(tmp, dest)
  return { record: rows.find(r => r.id === record.id), warnings: book.warnings }
}

export const historyParameters = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(['action', 'character', 'scene', 'id', 'kind', 'content', 'source', 'evidence', 'target', 'event', 'supersedes'].map(key => [key,
    key === 'action' ? { type: 'string', enum: ['inspect', 'propose', 'confirm', 'revoke'] } : { type: 'string' }])),
}

export async function moveScene(root, chapters, sceneId, targetChapter) {
  const book = await stageBook(root, chapters)
  const scene = book.scenes.find(s => s.id === sceneId)
  const target = chapters.find(c => c.id === targetChapter)
  if (!scene || book.scenes.filter(s => s.id === sceneId).length !== 1 || !target || scene.chapter === targetChapter) throw new Error('需要唯一场景和不同的有效目标章节')
  const file = path.join(root, 'beats.md')
  const original = await read(file)
  let text = original.replace(/\r\n/g, '\n')
  const start = text.indexOf(`### 场景 ${sceneId}：`)
  const endMatch = /^##(?:#)? /gm
  endMatch.lastIndex = start + 1
  const end = endMatch.exec(text)?.index ?? text.length
  const block = text.slice(start, end).trim()
  text = text.slice(0, start) + text.slice(end)
  const headings = [...text.matchAll(/^## (\d+)\b[^\n]*\n/gm)]
  const index = headings.findIndex(m => m[1] === targetChapter)
  if (index < 0) text += `\n\n## ${targetChapter} ${target.title}\n\n${block}\n`
  else {
    const at = headings[index + 1]?.index ?? text.length
    text = text.slice(0, at).trimEnd() + `\n\n${block}\n\n` + text.slice(at)
  }
  if (await read(file) !== original) throw new Error('章纲已变化，请重试')
  const tmp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
  return { moved: sceneId, chapter: targetChapter, warnings: ['场景已整块移动；人物入场状态按时序重新计算，原位置确认记录需重新提取核对。'] }
}
