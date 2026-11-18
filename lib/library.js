import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { readText, writeFileAtomic, stampOf, stampToIso, shortHash, CHARACTERS_DIR, CHARACTER_EXT } from './book.js'
import { countChars } from './text.js'
import { safeCharacterName } from './people.js'
import { matchBeatSection } from './beats.js'
// library.js：书模型、章节读写与落盘。

export const THREADS_FILE = 'threads.md'

export const EVENTS_FILE = 'events.md'

export const SETTINGS_DIR = 'settings'

export function settingCategory(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = /^\s*[-*+]?\s*分类\s*[：:]\s*(.+)$/u.exec(line)
    if (match) return match[1].replace(/[*`]/gu, '').trim()
  }
  return ''
}

export function settingSummary(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#{1,6}\s/u.test(trimmed)) continue
    if (/^\s*[-*+]\s*分类\s*[：:]/u.test(trimmed)) continue
    return Array.from(trimmed.replace(/^[-*+]\s*/u, '')).slice(0, 60).join('')
  }
  return ''
}

export async function listSettings(root) {
  let names = []
  try {
    names = await fsp.readdir(path.join(root, SETTINGS_DIR))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
    return []
  }
  const items = []
  for (const file of names.filter(item => item.toLocaleLowerCase().endsWith(CHARACTER_EXT)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const name = path.basename(file, CHARACTER_EXT)
    const text = (await readText(path.join(root, SETTINGS_DIR, file))) ?? ''
    items.push({
      name,
      file: `${SETTINGS_DIR}/${file.replace(/\\/gu, '/')}`,
      chars: countChars(text),
      summary: settingSummary(text),
      category: settingCategory(text),
    })
  }
  return items
}

export async function readSetting(root, name) {
  const file = path.join(root, SETTINGS_DIR, `${safeCharacterName(name)}${CHARACTER_EXT}`)
  return (await readText(file)) ?? null
}

export async function writeSetting(root, name, content) {
  const safe = safeCharacterName(name)
  const file = path.join(root, SETTINGS_DIR, `${safe}${CHARACTER_EXT}`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
  return { name: safe, file: `${SETTINGS_DIR}/${path.basename(file)}`, chars: countChars(content) }
}

export const SETTING_VOID_RE = /^\s*[-*+]?\s*状态\s*[：:]\s*(作废|废弃|停用|不用了|已废)/mu

export async function setSettingStatus(root, name, status) {
  const safe = safeCharacterName(name)
  const file = path.join(root, SETTINGS_DIR, `${safe}${CHARACTER_EXT}`)
  const current = (await readText(file)) ?? ''
  const lines = current.replace(/\r\n/gu, '\n').split('\n').filter(line => !SETTING_VOID_RE.test(line))
  if (status === 'deprecated') {
    const categoryAt = lines.findIndex(line => /^\s*[-*+]?\s*分类\s*[：:]/u.test(line))
    const at = categoryAt >= 0 ? categoryAt + 1 : Math.min(1, lines.length)
    lines.splice(at, 0, '- 状态：作废')
  }
  const body = lines.join('\n').replace(/\n{3,}/gu, '\n\n')
  await fsp.writeFile(file, body, 'utf8')
  return { name: safe, status: status === 'deprecated' ? 'deprecated' : 'active', chars: countChars(body) }
}

export async function deleteSetting(root, name) {
  const safe = safeCharacterName(name)
  const file = path.join(root, SETTINGS_DIR, `${safe}${CHARACTER_EXT}`)
  const stamp = stampOf()
  const trashDir = path.join(root, SETTINGS_DIR, '.trash')
  await fsp.mkdir(trashDir, { recursive: true })
  const target = path.join(trashDir, `${safe}-${stamp}${CHARACTER_EXT}`)
  await fsp.rename(file, target)
  return { name: safe, file: `${SETTINGS_DIR}/.trash/${path.basename(target)}` }
}

export function parseThreads(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim())
    if (cells.length < 2) continue
    if (cells.every(cell => /^:?-{2,}:?$/u.test(cell) || cell === '')) continue
    if (cells[0] === '伏笔' || cells[0] === 'thread') continue
    const [label, planted = '', payoff = '', status = ''] = cells
    if (!label) continue
    const state = status ? status.toLocaleLowerCase() : 'open'
    rows.push({
      thread: label,
      planted: planted || '',
      payoff: payoff || '',
      status: state,
      open: state !== 'closed' && state !== 'done',
    })
  }
  return rows
}

export function latestWrittenId(chapters) {
  let latest = ''
  for (const chapter of chapters) {
    if (!chapter.chars) continue
    if (chapter.id > latest) latest = chapter.id
  }
  return latest
}

export function decorateThreads(rows, latest) {
  return rows.map(item => ({
    ...item,
    due: Boolean(item.open && item.payoff && latest && item.payoff <= latest),
  }))
}

export async function loadThreads(root) {
  const text = (await readText(path.join(root, THREADS_FILE))) ?? ''
  return { present: text !== '', chars: countChars(text), rows: parseThreads(text) }
}

export async function writeThread(root, patch) {
  const file = path.join(root, THREADS_FILE)
  const existing = (await readText(file)) ?? '# 伏笔表\n\n| 伏笔 | 埋设 | 回收 | 状态 |\n| --- | --- | --- | --- |\n'
  const lines = existing.replace(/\r\n/gu, '\n').split('\n')
  const isRow = line => /^\s*\|/u.test(line)
  const isSeparator = line => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/u.test(line)
  const splitCells = line =>
    line
      .trim()
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map(cell => cell.trim())

  let headerIndex = lines.findIndex(line => isRow(line) && !isSeparator(line) && /伏笔|thread/u.test(line))
  if (headerIndex < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('')
    lines.push('| 伏笔 | 埋设 | 回收 | 状态 |', '| --- | --- | --- | --- |')
    headerIndex = lines.length - 2
  }

  let start = headerIndex + 1
  if (isSeparator(lines[start] ?? '')) start += 1
  let lastRow = start - 1
  for (let i = start; i < lines.length; i++) {
    if (!isRow(lines[i]) || isSeparator(lines[i])) break
    lastRow = i
  }

  // 先清掉模板留下的空占位行（|  |  |  |  |），否则新伏笔会追加在它下面
  for (let i = lastRow; i >= start; i--) {
    if (!isRow(lines[i]) || isSeparator(lines[i])) continue
    if (splitCells(lines[i]).every(cell => cell === '')) {
      lines.splice(i, 1)
      lastRow -= 1
    }
  }

  const target = String(patch.thread).trim()
  let touched = -1
  for (let i = start; i <= lastRow; i++) {
    if (!isRow(lines[i]) || isSeparator(lines[i])) continue
    if (splitCells(lines[i])[0] === target) {
      touched = i
      break
    }
  }

  const previous = touched >= 0 ? splitCells(lines[touched]) : [target, '', '', '']
  const cells = [
    target,
    patch.planted ?? previous[1] ?? '',
    patch.payoff ?? previous[2] ?? '',
    patch.status ?? previous[3] ?? '',
  ]
  const row = `| ${cells.map(cell => String(cell).trim() || ' ').join(' | ')} |`
  if (touched >= 0) lines[touched] = row
  else lines.splice(lastRow + 1, 0, row)

  const next = lines.join('\n').replace(/\n{3,}/gu, '\n\n')
  await fsp.writeFile(file, next, 'utf8')

  const rows = parseThreads(next)
  return { thread: target, row: rows.find(item => item.thread === target) ?? null, rows, replaced: touched >= 0 }
}

export function validateThreadPatch(patch) {
  const warnings = []
  const checkId = (value, label) => {
    if (value === undefined || value === '') return
    if (!/^\d{3,4}$/u.test(String(value))) warnings.push(`${label}不是四位章 id（如 0003）：「${value}」这一列右栏读不到。`)
  }
  checkId(patch.planted, '埋设章')
  checkId(patch.payoff, '回收章')
  if (patch.status !== undefined && patch.status !== '' && !['open', 'done', 'closed'].includes(String(patch.status))) {
    warnings.push(`状态只认 open / done / closed，收到「${patch.status}」会按 open 处理（留空＝open，收掉了才写 done）。`)
  }
  return warnings
}

export function parseChapterRange(text) {
  const hit = String(text ?? '').match(/(\d{1,4})\s*(?:[-–—~～至到]\s*(\d{1,4}))?/u)
  if (!hit) return { from: '', to: '' }
  const from = hit[1].padStart(4, '0')
  const to = hit[2] ? hit[2].padStart(4, '0') : from
  return { from, to: to < from ? from : to }
}

export function parseEventLines(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const lines = []
  let line = null
  let event = null
  const closeEvent = () => {
    if (!line || !event) {
      event = null
      return
    }
    const body = event.raw.trim()
    const pick = label => {
      const hit = new RegExp('^\\s*[-*+]?\\s*' + label + '\\s*[：:]\\s*(.+)$', 'mu').exec(body)
      return hit ? hit[1].trim() : ''
    }
    line.events.push({
      id: event.id,
      title: event.title,
      from: event.from,
      to: event.to,
      because: pick('因为'),
      so: pick('所以'),
      irreplaceable: pick('不可替代'),
      body,
      chars: countChars(body),
    })
    event = null
  }
  for (const raw of source.split('\n')) {
    if (/^###\s/u.test(raw)) {
      closeEvent()
      if (!line) continue
      const title = raw.replace(/^###\s*/u, '').trim()
      const head = /^([^\s（(]+)\s*(.*)$/u.exec(title) ?? [title, title, '']
      const rest = head[2] ?? ''
      const range = parseChapterRange(rest)
      event = {
        id: head[1].trim(),
        title: rest.replace(/[（(][^）)]*[）)]/gu, '').trim(),
        from: range.from,
        to: range.to,
        raw: '',
      }
      continue
    }
    if (/^##\s/u.test(raw)) {
      closeEvent()
      const title = raw.replace(/^##\s*/u, '').trim()
      const split = /^([^：:]{1,10})[：:]\s*(.+)$/u.exec(title)
      line = {
        id: (split ? split[1] : title).trim(),
        name: (split ? split[2] : title).trim(),
        goal: '',
        span: '',
        raw: '',
        events: [],
      }
      lines.push(line)
      continue
    }
    if (event) { event.raw += raw + '\n'; continue }
    if (line) line.raw += raw + '\n'
  }
  closeEvent()
  for (const item of lines) {
    const body = item.raw.trim()
    const goal = /^\s*[-*+]?\s*目标\s*[：:]\s*(.+)$/mu.exec(body)
    const span = /^\s*[-*+]?\s*(?:起点|跨度|区间)[^\n：:]*[：:]\s*(.+)$/mu.exec(body)
    item.goal = goal ? goal[1].trim() : ''
    item.span = span ? span[1].trim() : ''
    delete item.raw
  }
  return lines
}

export async function readEvents(root) {
  const text = (await readText(path.join(root, EVENTS_FILE))) ?? ''
  const lines = parseEventLines(text)
  const events = []
  for (const line of lines) {
    for (const event of line.events) events.push({ ...event, lineId: line.id, lineName: line.name })
  }
  return { present: text.trim().length > 0, chars: countChars(text), text, lines, events }
}

export function eventTimeline(board, chapters, beatSections) {
  const lookup = new Map()
  for (const line of board.lines) {
    for (const event of line.events) lookup.set(event.id, { ...event, lineId: line.id, lineName: line.name })
  }
  const warnings = []
  const perChapter = chapters.map(item => {
    const section = beatSections ? matchBeatSection(beatSections, item) : null
    const anchors = section && Array.isArray(section.events) ? section.events : []
    return { id: item.id, title: item.title, written: item.written === true, anchors, hits: [] }
  })
  const byId = new Map(perChapter.map(item => [item.id, item]))
  for (const item of perChapter) {
    for (const id of item.anchors) {
      const event = lookup.get(id)
      if (!event) {
        warnings.push(item.id + ' 锚了「' + id + '」，但 events.md 里没有这条事件')
        continue
      }
      if (event.from && (item.id < event.from || item.id > event.to)) {
        warnings.push(item.id + ' 锚了「' + id + '」，可它标的是 ' + event.from + '–' + event.to + ' 章')
      }
      item.hits.push({ lineId: event.lineId, lineName: event.lineName, eventId: event.id, title: event.title })
    }
    if (item.anchors.length > 4) {
      warnings.push(item.id + ' 一章推了 ' + item.anchors.length + ' 条线，容易写成摘要而不是戏')
    }
  }
  const lines = board.lines.map(line => {
    const events = line.events.map(event => {
      const covered = []
      for (const item of perChapter) {
        const inRange = event.from !== '' && item.id >= event.from && item.id <= event.to
        if (inRange || item.anchors.includes(event.id)) covered.push(item.id)
      }
      const done = covered.filter(id => byId.get(id) && byId.get(id).written).length
      return {
        id: event.id,
        title: event.title,
        from: event.from,
        to: event.to,
        because: event.because,
        so: event.so,
        irreplaceable: event.irreplaceable,
        chapters: covered,
        written: done,
        total: covered.length,
        status: covered.length === 0 ? '未开始' : done === covered.length ? '已写完' : done === 0 ? '未动笔' : '进行中',
      }
    })
    return {
      id: line.id,
      name: line.name,
      goal: line.goal,
      span: line.span,
      events,
      covered: events.filter(item => item.written > 0).length,
      total: events.length,
    }
  })
  return {
    present: board.present,
    lines,
    chapters: perChapter,
    warnings,
    lineCount: lines.length,
    eventCount: lines.reduce((sum, line) => sum + line.total, 0),
    done: lines.reduce((sum, line) => sum + line.covered, 0),
  }
}

export async function writeEventLine(root, lineId, content) {
  const file = path.join(root, EVENTS_FILE)
  const existing =
    (await readText(file)) ??
    '# 事件线\n\n> 一条线一个 ## 小节，一个事件一个 ### 小节；事件标题写「### 主线-1 真相落地（1–3）」。\n'
  const normalized = String(content ?? '').replace(/\r\n/gu, '\n').trim()
  const blockText = /^##\s/u.test(normalized) ? normalized : '## ' + lineId + '\n\n' + normalized
  const source = existing.replace(/\r\n/gu, '\n')
  const rows = source.split('\n')
  const heads = []
  rows.forEach((row, index) => { if (/^##\s/u.test(row)) heads.push(index) })
  const target = heads.find(index => rows[index].replace(/^##\s*/u, '').trim().startsWith(lineId))
  let next
  if (target === undefined) {
    next = source.trimEnd() + '\n\n' + blockText + '\n'
  } else {
    const after = heads.filter(index => index > target)[0]
    const head = rows.slice(0, target)
    const tail = after === undefined ? [] : rows.slice(after)
    next = head.concat(blockText.split('\n')).concat(tail).join('\n')
  }
  next = next.replace(/\n{3,}/gu, '\n\n')
  await writeFileAtomic(file, next)
  return { line: lineId, chars: countChars(blockText) }
}
