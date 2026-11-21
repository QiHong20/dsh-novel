import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BEAT_SECTION_CHANGED, mutateBeatsFile, parseBeatSections } from './lib/beats.js'
import { beatHeading, normalizeBeatId, resolveBeatSection, scanBeatHeadings } from './lib/beat-match.js'
import { findChapter, loadBook } from './lib/book.js'
import {
  APPEARANCE_FIELDS,
  CHAPTER_FIELDS,
  PSYCHOLOGY_FIELDS,
  ROLE_FIELDS,
  SCENE_FIELDS,
  hash,
  parseScenes,
  parseStageFields,
  scanSceneHeadings,
} from './lib/beat-structure.js'

export { APPEARANCE_FIELDS, CHAPTER_FIELDS, PSYCHOLOGY_FIELDS, ROLE_FIELDS, SCENE_FIELDS, hash, parseScenes }
export const BEAT_REQUEST_INVALID = 'BEAT_REQUEST_INVALID'
const safeId = value => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value || '')) throw new Error('ID 必须为字母、数字、下划线或连字符')
  return value
}
const read = async file => { try { return await fs.readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return ''; throw e } }
const fields = parseStageFields
const stageEditError = (message, code = BEAT_REQUEST_INVALID) => Object.assign(new Error(message), { code })

export const PRESENTATION_RULES = '小说心理与登场原则：按关键决定、误解或认知转变安排心理材料，不设数量和密度配额，不在每句对白后解释。主配角均可有心理，但直接呈现必须遵守本场叙述视角；仅作者参考不写成可直接读取的内心。允许联想、短回忆、间接叙述，只有「保留心声原句」要求保留原句。重要人物首次正式登场应考虑体态、面容、衣着、声音等可辨认特征，融入观察和动作；暗处、伪装等可说明不描写原因。后续出场以唤起特征或变化为主，不用外貌篇幅代替人物重要性。计划不是已经向读者呈现的事实。'

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

export async function stageBook(root, chapters) {
  const beats = await read(path.join(root, 'beats.md'))
  // 场景归属沿用章纲读写的同一套匹配规则：章 ID 优先，无 ID 旧标题只在唯一认领时回退。
  const sections = parseBeatSections(beats)
  const claimed = new Set()
  const scenes = chapters.flatMap(chapter => {
    const resolved = resolveBeatSection(sections, chapter, chapters)
    if (resolved.kind !== 'matched') return []
    claimed.add(resolved.section)
    return parseScenes(resolved.section.body, chapter.id)
  })
  // 只回退书目中完全找不到对应章的数字小节；已登记章（含匹配歧义）保留诊断，不载入场景。
  const bookIds = new Set(chapters.map(chapter => normalizeBeatId(chapter.id)))
  for (const section of sections) {
    if (claimed.has(section) || !section.id || bookIds.has(section.id)) continue
    scenes.push(...parseScenes(section.body, section.id))
  }
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
  const diagnostics = []
  const warn = (detail, scope = {}) => {
    warnings.push(detail)
    diagnostics.push({ detail, ...scope })
  }
  // 匹配歧义不静默跳过：场景上下文与章纲接口给出同一诊断。
  for (const chapter of chapters) {
    const resolved = resolveBeatSection(sections, chapter, chapters)
    if (resolved.kind === 'ambiguous') warn(`${resolved.message}；本章场景未载入`, { chapter: chapter.id })
  }
  for (const [label, items] of [['人物', cards], ['场景', scenes]]) {
    const seen = new Set()
    for (const item of items) {
      if (!item.id || seen.has(item.id)) warn(`${label} ID 缺失或重复：${item.id || item.name}`, { global: true })
      seen.add(item.id)
    }
  }
  const eventText = await read(path.join(root, 'events.md'))
  const events = new Set([...eventText.matchAll(/^### (\S+)/gm)].map(m => m[1]))
  for (const scene of scenes) {
    if (scene.time === null) warn(`${scene.id}：缺少整数时序，不能推断故事时间`, { chapter: scene.chapter, scene: scene.id })
    for (const id of scene.cast) if (!cards.some(c => c.id === id)) warn(`${scene.id}：人物引用不存在 ${id}`, { chapter: scene.chapter, scene: scene.id })
    for (const id of scene.events) if (!events.has(id)) warn(`${scene.id}：事件引用不存在 ${id}`, { chapter: scene.chapter, scene: scene.id })
    for (const role of scene.roles) if (!scene.cast.includes(role.id)) warn(`${scene.id}：人物约束 ${role.id} 未列入出场`, { chapter: scene.chapter, scene: scene.id })
    for (const id of scene.cast) if (!scene.roles.some(r => r.id === id)) warn(`${scene.id}：${id} 缺少本场目标与认知约束`, { chapter: scene.chapter, scene: scene.id })
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
  for (const r of records) if (r.status === 'confirmed' && !r.valid) warn(`认知 ${r.id} 来源或场景已变化，待复核；后续不得继承`, { chapter: r.chapter, scene: r.scene, character: r.character, record: r.id, time: r.time, kind: r.kind })
  const impacts = records.filter(r => r.status === 'confirmed' && !r.valid).map(r => ({
    record: r.id, character: r.character, content: r.content,
    scenes: scenes.filter(s => s.cast.includes(r.character) && s.time !== null && s.time > r.time).map(s => ({ id: s.id, chapter: s.chapter, title: s.title })),
  }))
  const eventStarts = [...eventText.matchAll(/^### (\S+)([^\n]*)\n/gm)]
  const eventNodes = eventStarts.map((m, i) => ({ id: m[1], title: m[2].trim(),
    plan: eventText.slice(m.index + m[0].length, eventStarts[i + 1]?.index ?? eventText.length).split(/^## /m)[0].trim() }))
  return { scenes, cards, records, sources, warnings, diagnostics, events, impacts, eventNodes, baseHash: hash(beats) }
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
      historyStatus: history.length ? 'recorded' : book.scenes.some(s => s.time !== null && scene.time !== null && s.time < scene.time && s.cast.includes(id)) ? 'unrecorded' : 'no-prior-scene',
      gap: history.length ? '' : '未记录：不代表明确未知。请核对正文或补充人物历史。' }
  })
}

export async function stageContext(root, chapters, chapter, sceneId) {
  const book = await stageBook(root, chapters)
  const scenes = book.scenes.filter(s => s.chapter === chapter && (!sceneId || s.id === sceneId))
  if (sceneId && scenes.length !== 1) throw new Error('场景不存在或 ID 重复')
  const views = scenes.map(scene => ({ ...scene, characters: sceneState(book, scene) }))
  const scopedDiagnostics = book.diagnostics.filter(d => d.global ||
    (d.chapter === chapter && (!sceneId || d.scene === sceneId)) ||
    (d.record && scenes.some(s => s.id === d.scene || (s.cast.includes(d.character) &&
      (d.kind === '呈现'
        ? chapters.findIndex(c => c.id === d.chapter) <= chapters.findIndex(c => c.id === s.chapter)
        : s.time !== null && (d.time == null || d.time < s.time))))))
  const warnings = scopedDiagnostics.map(d => d.detail)
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
    ...warnings.map(w => `⚠ ${w}`),
  ].join('\n\n') : ''
  return { scenes: views, warnings, diagnostics: scopedDiagnostics, impacts: book.impacts, reviews, events,
    records: book.records.filter(r => r.chapter === chapter), baseHash: book.baseHash, text }
}

export function patchStageText(text, args, chapter = null, chapters = chapter ? [chapter] : []) {
  if (!args.baseHash || args.baseHash !== hash(text)) throw stageEditError('章纲已变化，请重新读取后保存；未覆盖其他修改', BEAT_SECTION_CHANGED)
  if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) throw stageEditError('需要 fields 字段对象')
  // 与章纲读写共用标题扫描和匹配规则：制表符标题、无 ID 旧小节都不会被误算进上一章。
  const headings = scanBeatHeadings(text)
  const sections = headings.map((hit, index) => ({ id: hit.id, heading: hit.heading, body: text.slice(hit.end, headings[index + 1]?.index ?? text.length) }))
  const target = chapter ?? { id: args.chapter }
  const resolved = resolveBeatSection(sections, target, chapters.length ? chapters : [target])
  if (resolved.kind === 'ambiguous') throw stageEditError(resolved.message, BEAT_SECTION_CHANGED)
  if (resolved.kind !== 'matched') throw stageEditError('章节不存在或重复', BEAT_SECTION_CHANGED)
  const chapterIndex = sections.indexOf(resolved.section)
  const chapterStart = headings[chapterIndex].end
  const chapterEnd = headings[chapterIndex + 1]?.index ?? text.length
  let start = chapterStart
  let end = chapterEnd
  let allowed = CHAPTER_FIELDS
  if (args.scene) {
    const scenes = scanSceneHeadings(text.slice(chapterStart, chapterEnd))
    const found = scenes.find(hit => hit.id === args.scene)
    if (!found || scenes.filter(hit => hit.id === args.scene).length !== 1) throw stageEditError('场景不存在或重复', BEAT_SECTION_CHANGED)
    const sceneIndex = scenes.indexOf(found)
    end = chapterStart + (scenes[sceneIndex + 1]?.index ?? (chapterEnd - chapterStart))
    start = chapterStart + found.bodyStart
    allowed = SCENE_FIELDS
    if (args.character) {
      const roles = [...text.slice(start, end).matchAll(/^#### 人物 ([\w-]+)[ \t]*\r?(?:\n|$)/gm)]
      const foundRoles = roles.filter(m => m[1] === args.character)
      if (foundRoles.length !== 1) throw stageEditError('人物块不存在或重复，请在原始章纲中补充', BEAT_SECTION_CHANGED)
      const role = foundRoles[0]
      end = start + (roles[roles.indexOf(role) + 1]?.index ?? (end - start))
      start += role.index + role[0].length
      allowed = ROLE_FIELDS
    } else {
      const next = /^#### /m.exec(text.slice(start, end))
      if (next) end = start + next.index
    }
  } else {
    if (args.character) throw stageEditError('编辑人物需要指定场景')
    const next = /^### /m.exec(text.slice(start, end))
    if (next) end = start + next.index
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let body = text.slice(start, end)
  for (const [key, value] of Object.entries(args.fields)) {
    if (!allowed.includes(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw stageEditError(`不支持的字段或多行值：${key}`)
    const re = new RegExp(`^- ${key}：[^\\n]*(?:\\n|$)`, 'gm')
    const found = [...body.matchAll(re)]
    if (found.length > 1) throw stageEditError(`字段 ${key} 重复，请在原始章纲中核对`)
    if (found.length) body = body.replace(re, () => value ? `- ${key}：${value}${newline}` : '')
    else if (value) body += (body && !body.endsWith('\n') ? newline : '') + `- ${key}：${value}${newline}`
  }
  return text.slice(0, start) + body + text.slice(end)
}

export async function editStageFields(root, args) {
  const { meta } = await loadBook(root)
  const chapter = findChapter(meta.chapters, args.chapter) ?? { id: args.chapter }
  const saved = await mutateBeatsFile(root, original => ({ text: patchStageText(original ?? '', args, chapter, meta.chapters) }), args.baseHash)
  return { ok: true, baseHash: saved.baseHash, issues: saved.issues, warnings: saved.warnings }
}

const locks = new Map()
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
  const saved = await mutateBeatsFile(root, original => {
    let text = (original ?? '').replace(/\r\n/g, '\n')
    const target = chapters.find(c => c.id === targetChapter)
    if (!target) throw new Error('需要唯一场景和不同的有效目标章节')
    // 目标章节沿用整章保存的匹配规则：ID 唯一优先，无 ID 旧条目只在唯一认领时回退。
    const sections = parseBeatSections(text)
    const resolved = resolveBeatSection(sections, target, chapters)
    if (resolved.kind === 'ambiguous') throw new Error(`${resolved.message}；未移动`)
    const targetIndex = resolved.kind === 'matched' ? sections.indexOf(resolved.section) : -1

    // 唯一性和原归属都以锁内实际要写入的版本为准，避免排队期间新增同 ID 场景后移错小节。
    const scenePattern = new RegExp(`^### 场景 ${sceneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]`, 'gm')
    const sceneHits = [...text.matchAll(scenePattern)]
    if (sceneHits.length !== 1) throw new Error('场景不存在或重复')
    const start = sceneHits[0].index
    const headings = scanBeatHeadings(text)
    const ownerIndex = headings.reduce((found, item, index) => item.index < start ? index : found, -1)
    if (ownerIndex < 0) throw new Error('在 beats.md 中找不到该场景的所属章节')
    if (targetIndex >= 0 && ownerIndex === targetIndex) throw new Error('需要唯一场景和不同的有效目标章节')

    // 结束位置取「下一场景 / 下一章 / 文件末尾」最早者，移动首场时后续场景必须留在原地。
    const nextScene = /^###\s[^\n]*(?:\n|$)/gm
    nextScene.lastIndex = start + 1
    const sceneEnd = nextScene.exec(text)?.index ?? text.length
    const end = Math.min(sceneEnd, headings[ownerIndex + 1]?.index ?? text.length)
    const block = text.slice(start, end).trim()
    text = text.slice(0, start) + text.slice(end)
    if (targetIndex < 0) text += `\n\n## ${beatHeading(target)}\n\n${block}\n`
    else {
      // 命中旧标题时同一次保存内规范化，否则 stageBook 仍按数字标题读不到这一章。
      const targetHit = scanBeatHeadings(text)[targetIndex]
      if (!targetHit) throw new Error('在 beats.md 中找不到目标章节')
      // 比较原始标题行：`##\t0002 目标章` 去掉标记后与规范文本相同，但 stageBook 仍读不到。
      const normalized = `## ${beatHeading(target)}`
      if (targetHit.line !== normalized) {
        text = text.slice(0, targetHit.index) + `${normalized}\n` + text.slice(targetHit.end)
      }
      // 插入边界取紧邻的下一个任意二级标题；无 ID 的旧小节也占据自己的标题行。
      const nextHeadings = scanBeatHeadings(text)
      const at = nextHeadings[targetIndex + 1]?.index ?? text.length
      text = text.slice(0, at).trimEnd() + `\n\n${block}\n\n` + text.slice(at)
    }
    return { text, moved: sceneId, chapter: targetChapter }
  })
  return {
    moved: saved.moved,
    chapter: saved.chapter,
    baseHash: saved.baseHash,
    issues: saved.issues,
    warnings: [...saved.warnings, '场景已整块移动；人物入场状态按时序重新计算，原位置确认记录需重新提取核对。'],
  }
}
