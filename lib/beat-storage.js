import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { scanBeatHeadings } from './beat-match.js'
import { withFileLock } from './file-lock.js'

const MARKER = '.novel/beats-storage.json'
const JOURNAL = '.novel/beats-transaction.json'
const digest = text => createHash('sha256').update(text).digest('hex')
async function read(file) { try { return await fs.readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function atomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${randomUUID()}`
  await fs.writeFile(temp, text, 'utf8')
  await fs.rename(temp, file)
}
function split(text) {
  const headings = scanBeatHeadings(text)
  const ids = new Set()
  const sections = headings.map((h, i) => {
    if (!h.id || !/^[a-zA-Z0-9_-]+$/u.test(h.id) || ids.has(h.id)) throw new Error('分章存储需要每章唯一明确 ID；请先修复旧章纲标题')
    ids.add(h.id)
    return { id: h.id, text: text.slice(h.index, headings[i + 1]?.index ?? text.length) }
  })
  return { preamble: text.slice(0, headings[0]?.index ?? text.length), sections }
}
async function marker(root) {
  const raw = await read(path.join(root, MARKER))
  if (!raw) return null
  const value = JSON.parse(raw)
  if (value.version !== 1 || !Array.isArray(value.ids) || value.ids.some(id => !/^[a-zA-Z0-9_-]+$/u.test(id)) || new Set(value.ids).size !== value.ids.length) throw new Error('章纲存储索引无效')
  return value
}

/** While a transaction is in flight, readers see its entire previous snapshot. */
export async function readBeatStorage(root) {
  const journal = await read(path.join(root, JOURNAL))
  if (journal) return JSON.parse(journal).before
  const meta = await marker(root)
  if (!meta) return read(path.join(root, 'beats.md'))
  const sections = []
  for (const id of meta.ids) {
    const text = await read(path.join(root, 'beats', `${id}.md`))
    if (text === null) throw new Error(`章纲文件缺失：beats/${id}.md`)
    const headings = scanBeatHeadings(text)
    if (headings.length !== 1 || headings[0].id !== id) throw new Error(`章纲文件归属错误：beats/${id}.md`)
    sections.push(text)
  }
  // Recheck after reads so a concurrent transaction cannot expose a partial aggregate.
  const pending = await read(path.join(root, JOURNAL))
  if (pending) return JSON.parse(pending).before
  const latest = await marker(root)
  if (latest.revision !== meta.revision) return readBeatStorage(root)
  return meta.preamble + sections.join('')
}

async function finish(root, transaction) {
  const layout = split(transaction.after)
  for (const section of layout.sections) await atomic(path.join(root, 'beats', `${section.id}.md`), section.text)
  await atomic(path.join(root, MARKER), JSON.stringify({ version: 1, revision: randomUUID(), preamble: layout.preamble, ids: layout.sections.map(s => s.id) }, null, 2))
  await fs.unlink(path.join(root, JOURNAL))
}

export async function writeBeatStorage(root, text) {
  return withFileLock(path.join(root, '.novel/beats-storage-lock'), async () => {
    const pending = await read(path.join(root, JOURNAL))
    if (pending) throw new Error('章纲有未完成事务，请调用 novel_beats_storage action:resume 后重新读取再编辑')
    if (!await marker(root)) { await atomic(path.join(root, 'beats.md'), text); return }
    split(text)
    const transaction = { before: await readBeatStorage(root), after: text }
    await atomic(path.join(root, JOURNAL), JSON.stringify(transaction))
    await finish(root, transaction)
  })
}

export async function manageBeatStorage(root, args = {}) {
  return withFileLock(path.join(root, 'book.json'), () => withFileLock(path.join(root, 'beats.md'), () => withFileLock(path.join(root, '.novel/beats-storage-lock'), async () => {
    const pending = await read(path.join(root, JOURNAL))
    if (args.action === 'resume') {
      if (pending) await finish(root, JSON.parse(pending))
      return { mode: await marker(root) ? 'chapters' : 'legacy', resumed: Boolean(pending) }
    }
    const text = await readBeatStorage(root) ?? ''
    const meta = await marker(root)
    const layout = split(text)
    const report = { mode: meta ? 'chapters' : 'legacy', baseHash: digest(text), pending: Boolean(pending), chapters: layout.sections.map(s => ({ id: s.id, file: `beats/${s.id}.md`, chars: [...s.text].length })) }
    if (!args.action || args.action === 'inspect') return report
    if (args.action !== 'migrate') throw new Error('存储操作无效')
    if (pending) throw new Error('请先恢复未完成事务')
    if (meta) return report
    if (args.baseHash !== report.baseHash) throw new Error('请先 inspect 审查迁移清单并携带当前 baseHash')
    const book = JSON.parse(await read(path.join(root, 'book.json')) || '{}')
    if (layout.sections.some(s => !book.chapters?.some(c => c.id === s.id))) throw new Error('章纲包含未登记章节，先核对书目')
    const existing = await fs.readdir(path.join(root, 'beats')).catch(e => { if (e.code === 'ENOENT') return []; throw e })
    if (existing.length) throw new Error('beats/ 已有文件，不能覆盖；请核对存储来源')
    const backup = `.novel/beats-legacy-${randomUUID()}.md`
    await atomic(path.join(root, backup), text)
    await atomic(path.join(root, JOURNAL), JSON.stringify({ before: text, after: text }))
    await finish(root, { after: text })
    // The marker selects the split files. The old file is retained for recovery only.
    return { ...report, mode: 'chapters', backup, preserved: digest(await readBeatStorage(root)) === report.baseHash }
  })))
}
