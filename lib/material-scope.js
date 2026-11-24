import path from 'node:path'
import { createHash } from 'node:crypto'
import { readJson, writeJson, readText, loadBook } from './book.js'
import { withFileLock } from './file-lock.js'
import { stageBook } from '../stage.js'

const hash = text => createHash('sha256').update(text).digest('hex')
const storeFile = root => path.join(root, '.novel/material-scopes.json')
function sourcePath(root, source) {
  if (typeof source !== 'string' || !/^(characters|settings)\/[^/\\]+\.md$/u.test(source) || source.includes('..')) throw new Error('仅支持 characters/名称.md 或 settings/名称.md')
  return path.join(root, source)
}
async function sourceText(root, source) {
  const text = await readText(sourcePath(root, source))
  if (text === null) throw new Error('资料文件不存在')
  return text
}
export function materialUnits(text) {
  return text.split(/\r?\n/u).map((quote, i) => ({ line: i + 1, quote })).filter(r => r.quote.trim())
}
function validateEntries(entries, text, book) {
  if (!Array.isArray(entries)) throw new Error('entries 必须为数组')
  const units = materialUnits(text), seen = new Set()
  for (const entry of entries) {
    if (!units.some(u => u.line === entry.line && u.quote === entry.quote) || seen.has(entry.line)) throw new Error('每个资料行须唯一登记并保留逐字 quote')
    seen.add(entry.line)
    if (!['stable', 'fact', 'knowledge', 'plan', 'private'].includes(entry.kind)) throw new Error('资料性质无效')
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error('每条范围需要依据说明 reason')
    for (const key of ['from', 'until', 'reveal']) if (entry[key] && book.scenes.filter(s => s.id === entry[key]).length !== 1) throw new Error(`${key} 需要唯一场景 ID`)
    if (['fact', 'knowledge', 'plan'].includes(entry.kind) && !entry.from) throw new Error('事实、认知、计划需要生效场景 from')
    if (entry.kind === 'knowledge' && !book.cards.some(c => c.id === entry.observer)) throw new Error('认知需要有效 observer 人物 ID')
    if (entry.kind !== 'private' && !entry.reveal) throw new Error('非私有资料须明确允许揭示的场景 reveal')
    if (entry.until && entry.from && book.scenes.find(s => s.id === entry.until).time <= book.scenes.find(s => s.id === entry.from).time) throw new Error('until 必须晚于 from')
  }
  if (seen.size !== units.length) throw new Error('资料还有未标记行；必须覆盖全部非空行，未知内容可标 private 暂不装配')
}
function boundaries(entries, book) {
  return hash(JSON.stringify(entries.map(e => ({ line: e.line, points: ['from', 'until', 'reveal'].map(k => {
    const s = book.scenes.find(s => s.id === e[k]); return s ? [s.id, s.chapter, s.time, book.scenes.indexOf(s)] : null
  }), observer: e.observer ? book.cards.filter(c => c.id === e.observer).map(c => c.id) : [] }))))
}

export async function manageMaterialScope(root, args) {
  return withFileLock(path.join(root, 'book.json'), () => withFileLock(path.join(root, 'beats.md'), () => withFileLock(storeFile(root), async () => {
    const text = await sourceText(root, args.source)
    const sourceHash = hash(text)
    const store = await readJson(storeFile(root)) ?? {}
    const book = await stageBook(root, (await loadBook(root)).meta.chapters)
    if (!args.action || args.action === 'inspect') return { source: args.source, sourceHash, units: materialUnits(text), record: store[args.source] ?? null,
      instructions: '逐行提出范围候选；同一行混合不同时间或权限时先用资料编辑工具拆行。工具不自动猜测范围。' }
    if (args.sourceHash !== sourceHash) throw new Error('资料已变化，请重新 inspect')
    if (args.action === 'propose') {
      validateEntries(args.entries, text, book)
      store[args.source] = { status: 'candidate', sourceHash, entries: args.entries, boundaryHash: boundaries(args.entries, book) }
    } else if (args.action === 'confirm') {
      const record = store[args.source]
      if (!record || record.sourceHash !== sourceHash) throw new Error('没有当前版本候选')
      validateEntries(record.entries, text, book)
      if (record.boundaryHash !== boundaries(record.entries, book)) throw new Error('场景时间或顺序已变化，需重新 propose')
      record.status = 'confirmed'
    } else if (args.action === 'revoke') delete store[args.source]
    else throw new Error('操作无效')
    await writeJson(storeFile(root), store)
    return { source: args.source, record: store[args.source] ?? null }
  })))
}

export async function scopedMaterial(root, source, book, target) {
  const text = await sourceText(root, source)
  const record = (await readJson(storeFile(root)))?.[source]
  const gap = reason => ({ text: '', status: 'unscoped', missing: `${source}：${reason}`, included: [], excluded: [] })
  if (!record || record.status !== 'confirmed' || record.sourceHash !== hash(text)) return gap('缺少当前版本已确认范围，完整包不装入自由文本')
  try { validateEntries(record.entries, text, book) } catch { return gap('范围或引用已失效') }
  if (record.boundaryHash !== boundaries(record.entries, book)) return gap('场景时序或叙述顺序已变化')
  if (!target || target.time === null) return gap('目标场景不明确')
  const included = [], excluded = []
  for (const e of record.entries) {
    const from = book.scenes.find(s => s.id === e.from), until = book.scenes.find(s => s.id === e.until), reveal = book.scenes.find(s => s.id === e.reveal)
    const allowed = e.kind !== 'private' && reveal && book.scenes.indexOf(reveal) <= book.scenes.findIndex(s => s.id === target.id) &&
      (!from || (e.kind === 'plan' ? from.id === target.id : from.time < target.time)) &&
      (!until || target.time < until.time) && (e.kind !== 'knowledge' || e.observer === target.viewpoint)
    if (allowed) included.push(e); else excluded.push(e.line)
  }
  return { text: included.map(e => `${e.kind === 'plan' ? '[本场计划，非事实] ' : ''}${e.quote}`).join('\n'), status: 'scoped', included: included.map(e => e.line), excluded }
}

export const materialScopeParameters = { type: 'object', additionalProperties: false, properties: {
  action: { type: 'string', enum: ['inspect', 'propose', 'confirm', 'revoke'] }, source: { type: 'string' }, sourceHash: { type: 'string' },
  entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    line: { type: 'integer', minimum: 1 }, kind: { type: 'string', enum: ['stable', 'fact', 'knowledge', 'plan', 'private'] },
    ...Object.fromEntries(['quote', 'reason', 'from', 'until', 'reveal', 'observer'].map(k => [k, { type: 'string' }])),
  }, required: ['line', 'quote', 'kind', 'reason'] } },
}, required: ['source'] }
