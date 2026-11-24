import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson, loadBook, BOOK_FILE, BEATS_FILE } from './book.js'
import { withFileLock } from './file-lock.js'
import { stageBook, resolveHistorySceneBinding, hash } from '../stage.js'

const FILE = '.novel/state-history.json'
const nonempty = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少${label}`)
  return value.trim()
}
const scalar = value => typeof value === 'string' && value.trim() !== '' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
const sameKey = (a, b) => a.entity === b.entity && a.property === b.property

/** State facts share the prose/scene binding protocol with character history. */
export async function stateBook(root, book) {
  const stored = await readJson(path.join(root, FILE)) ?? { entities: [], records: [] }
  const entities = [...book.cards.map(c => ({ id: c.id, name: c.name, type: 'character' })), ...stored.entities]
  const records = stored.records.map(record => {
    const scene = book.scenes.find(s => s.id === record.scene)
    const binding = resolveHistorySceneBinding(book.chapters, book.scenes, book.sources, record, { requireStored: true })
    const reasons = []
    if (entities.filter(e => e.id === record.entity).length !== 1) reasons.push('实体不存在或重复')
    if (!scene || scene.time !== record.time || scene.chapter !== record.chapter || hash(scene.raw) !== record.sceneHash) reasons.push('场景或时序已变化')
    if (hash(book.sources.get(record.chapter) || '') !== record.sourceHash) reasons.push('正文已变化')
    if (binding.status !== 'bound') reasons.push(binding.reason)
    if (record.event && (!scene?.events.includes(record.event) || !book.events.has(record.event))) reasons.push('事件关联已变化')
    return { ...record, binding, invalidReasons: reasons, valid: record.status === 'confirmed' && !reasons.length }
  })
  for (let i = 0; i < records.length; i++) for (const r of records) {
    if (r.valid && r.previous && !records.some(p => p.id === r.previous && p.valid && sameKey(p, r) && p.time < r.time)) {
      r.valid = false
      r.invalidReasons.push('前置状态证据已失效')
    }
  }
  return { entities, records, stored }
}

export function statesAt(state, book, scene) {
  const ids = new Set([...scene.cast, ...(scene.fields.状态对象 || '').split(/[、,，]/u).filter(Boolean)])
  const targetOrder = book.scenes.findIndex(s => s.id === scene.id)
  const eligible = state.records.filter(r => r.valid && ids.has(r.entity) && scene.time !== null && r.time < scene.time && book.scenes.findIndex(s => s.id === r.scene) < targetOrder)
  const replaced = new Set(eligible.map(r => r.previous).filter(Boolean))
  const current = eligible.filter(r => !replaced.has(r.id))
  const conflicts = current.filter(r => current.some(other => other.id !== r.id && sameKey(other, r) && other.value !== r.value))
  return { scene: scene.id, records: current, conflicts: conflicts.map(r => r.id), missingEntities: [...ids].filter(id => !state.entities.some(e => e.id === id)), invalid: state.records.filter(r => r.status === 'confirmed' && !r.valid && ids.has(r.entity)).map(r => ({ id: r.id, reasons: r.invalidReasons })) }
}

export async function stateContext(root, chapters, scenes) {
  const book = await stageBook(root, chapters)
  const state = await stateBook(root, book)
  const views = scenes.map(scene => statesAt(state, book, scene))
  const text = views.map(view => `### 状态入场 ${view.scene}\n` +
    (view.records.map(r => `- ${r.entity} / ${r.property}：${JSON.stringify(r.value)}${r.unit ? ' ' + r.unit : ''}；证据 ${r.chapter}/${r.scene} 第 ${r.evidenceIndex} 段「${r.evidence}」；记录 ${r.id}`).join('\n') || '未记录：不代表零值或从未发生。') +
    (view.conflicts.length ? `\n状态冲突待核对：${view.conflicts.join('、')}` : '') +
    (view.missingEntities.length ? `\n实体引用不存在：${view.missingEntities.join('、')}` : '') +
    (view.invalid.length ? `\n失效记录不得继承：${view.invalid.map(r => r.id + ' ' + r.reasons.join('；')).join('\n')}` : '')).join('\n\n')
  return { views, text: text ? '仅继承故事时间更早且此前叙述中已出现的有效事实；本场计划不是事实。人物认知／误信由 novel_character_history 管理，不以世界状态代替人物已知。\n' + text : '' }
}

export async function updateState(root, args) {
  return withFileLock(path.join(root, BOOK_FILE), () => withFileLock(path.join(root, BEATS_FILE), () => withFileLock(path.join(root, FILE), async () => {
    const book = await stageBook(root, (await loadBook(root)).meta.chapters)
    const state = await stateBook(root, book)
    if (!args.action || args.action === 'inspect') return { entities: state.entities, records: state.records }
    if (args.action === 'entity') {
      const id = nonempty(args.entity, '实体 ID')
      if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error('实体 ID 必须为英文、数字、下划线或连字符')
      if (state.entities.some(e => e.id === id)) throw new Error('实体 ID 已存在；人物沿用人物卡 ID')
      state.stored.entities.push({ id, name: nonempty(args.name, '实体名称'), type: nonempty(args.type, '实体类型') })
    } else if (args.action === 'propose') {
      if (state.entities.filter(e => e.id === args.entity).length !== 1) throw new Error('实体不存在或重复')
      const scene = book.scenes.find(s => s.id === args.scene)
      if (!scene || book.scenes.filter(s => s.id === args.scene).length !== 1 || scene.time === null) throw new Error('需要唯一场景和明确时序')
      if (!scalar(args.value)) throw new Error('状态值须为非空文本、有限数值或布尔值；未知不可填写为零')
      if (args.event && (!book.events.has(args.event) || !scene.events.includes(args.event))) throw new Error('事件必须存在且显式关联本场')
      const previous = args.previous ? state.records.find(r => r.id === args.previous && r.valid && r.entity === args.entity && r.property === args.property && r.time < scene.time) : null
      if (args.previous && !previous) throw new Error('前置状态必须为同一实体属性的更早有效记录')
      if (previous && (previous.unit || '') !== (args.unit || '')) throw new Error('状态迁移单位不同，请先核对，工具不自动换算')
      const record = { id: randomUUID(), entity: args.entity, property: nonempty(args.property, '属性'), value: args.value,
        unit: args.unit || '', previous: args.previous || '', event: args.event || '', trigger: nonempty(args.trigger, '触发依据说明'),
        scene: scene.id, chapter: scene.chapter, time: scene.time, evidenceIndex: args.evidenceIndex, evidence: nonempty(args.evidence, '正文证据'),
        sourceHash: hash(book.sources.get(scene.chapter) || ''), sceneHash: hash(scene.raw), status: 'candidate' }
      const binding = resolveHistorySceneBinding(book.chapters, book.scenes, book.sources, record)
      if (binding.status !== 'bound') throw new Error(`状态候选需要可靠正文分场：${binding.reason}`)
      Object.assign(record, { sourceSceneId: binding.sceneId, sourceSceneStart: binding.startIndex, sourceSceneEnd: binding.endIndex })
      state.stored.records.push(record)
    } else {
      const record = state.records.find(r => r.id === args.id)
      if (!record) throw new Error('状态记录不存在')
      if (!['confirm', 'revoke'].includes(args.action)) throw new Error('操作无效')
      if (args.action === 'confirm' && (record.invalidReasons.length || record.previous && !state.records.some(r => r.id === record.previous && r.valid))) throw new Error('依据已失效，不能确认')
      state.stored.records.find(r => r.id === args.id).status = args.action === 'confirm' ? 'confirmed' : 'revoked'
    }
    await writeJson(path.join(root, FILE), state.stored)
    return { entities: state.stored.entities, records: state.stored.records }
  })))
}

export const stateParameters = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['inspect', 'entity', 'propose', 'confirm', 'revoke'] },
    ...Object.fromEntries(['entity', 'name', 'type', 'property', 'unit', 'previous', 'event', 'trigger', 'scene', 'evidence', 'id'].map(key => [key, { type: 'string' }])),
    value: { type: ['string', 'number', 'boolean'] }, evidenceIndex: { type: 'integer', minimum: 1 },
  },
}
