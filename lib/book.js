import { readBeatStorage, writeBeatStorage } from './beat-storage.js'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { countChars, isPlaceholderText, numberFromToken } from './text.js'

// book.js：书模型、章节读写与落盘。

export const BOOK_FILE = 'book.json'

export const CHAPTERS_DIR = 'chapters'

export const DEFAULT_CHAPTER_TARGET = 3000

export function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export async function readText(file) {
  if (path.basename(file) === 'beats.md') return readBeatStorage(path.dirname(file))
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export async function readJson(file) {
  const raw = await readText(file)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${path.basename(file)} 不是合法 JSON，请先修好它再继续`)
  }
}

export async function writeFileAtomic(file, text) {
  if (path.basename(file) === 'beats.md') return writeBeatStorage(path.dirname(file), text)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await fsp.writeFile(temp, text, 'utf8')
  await fsp.rename(temp, file)
}

/** 原子写：先写同目录临时文件再 rename，读方不会看到被截断的 JSON。 */
export async function writeJson(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function normalizeFile(file, id) {
  const raw = typeof file === 'string' && file.trim() ? file.trim() : `${id}.md`
  const posix = raw.replace(/\\/gu, '/')
  return posix.includes('/') ? posix : `${CHAPTERS_DIR}/${posix}`
}

export const CHAPTER_STATUS = ['planned', 'draft', 'final']

export function normalizeChapter(entry) {
  const file = typeof entry.file === 'string' && entry.file.trim() ? entry.file : ''
  const fallbackId = path.basename(file || 'chapter', path.extname(file || ''))
  const id = String(entry.id ?? fallbackId)
  const status = CHAPTER_STATUS.includes(entry.status) ? entry.status : 'draft'
  return {
    id,
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : id,
    file: normalizeFile(entry.file, id),
    status,
    targetChars: Number.isFinite(Number(entry.targetChars)) ? Math.max(0, Math.round(Number(entry.targetChars))) : 0,
    ...(typeof entry.note === 'string' && entry.note.trim() ? { note: entry.note } : {}),
    ...(entry.deaiReview && typeof entry.deaiReview === 'object' ? { deaiReview: entry.deaiReview } : {}),
  }
}

export async function loadBook(root) {
  const bookPath = path.join(root, BOOK_FILE)
  const raw = await readJson(bookPath)
  const meta = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const declared = Array.isArray(meta.chapters) ? meta.chapters.filter(item => item && typeof item === 'object') : []

  let chapters = declared.map(normalizeChapter)

  if (chapters.length === 0) {
    let names = []
    try {
      names = await fsp.readdir(path.join(root, CHAPTERS_DIR))
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    chapters = names
      .filter(file => /\.md$/iu.test(file))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map(file => {
        // 没有 book.json 时按文件名猜：`0003.md`、`0003 第三章 湖心亭.md`、`第三章.md` 都要认。
        // 开头是数字就把数字当章 id（补齐四位），剩下的当标题；否则整段文件名叫章节名。
        const stem = path.basename(file, path.extname(file)).trim()
        const numbered = /^(\d{1,4})\s*[-_.、:：]?\s*(.*)$/u.exec(stem)
        if (numbered) {
          return normalizeChapter({
            id: numbered[1].padStart(4, '0'),
            title: numbered[2].trim() || `第 ${Number(numbered[1])} 章`,
            file,
          })
        }
        return normalizeChapter({ id: stem, title: stem, file })
      })
  }

  return {
    exists: raw !== null || chapters.length > 0,
    bookPath,
    raw: meta,
    meta: {
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : '未命名作品',
      author: typeof meta.author === 'string' ? meta.author : '',
      genre: typeof meta.genre === 'string' ? meta.genre : '',
      summary: typeof meta.summary === 'string' ? meta.summary : '',
      targetChars: clampInt(meta.targetChars, DEFAULT_CHAPTER_TARGET, 200, 50000),
      // 「没写」和「写了 3000」是两件事：前者是插件默认值，不该被当成作者的决定。
      targetCharsSet: Number.isFinite(Number(meta.targetChars)) && Number(meta.targetChars) > 0,
      style: typeof meta.style === 'string' ? meta.style.trim() : '',
      chapters,
    },
  }
}

/** 作者声明不能越过正文与当前复核的状态上限；复核有效不自动定稿。 */
export function deriveChapterStatus(text, declaredStatus, reviewStatus) {
  if (countChars(text) === 0 || isPlaceholderText(text)) return 'planned'
  return declaredStatus === 'final' && reviewStatus === 'recorded' ? 'final' : 'draft'
}

export async function chapterStats(root, chapter, fallbackTarget, resolveReviewStatus) {
  const text = (await readText(path.join(root, chapter.file))) ?? ''
  const chars = countChars(text)
  const target = chapter.targetChars > 0 ? chapter.targetChars : fallbackTarget
  const placeholder = isPlaceholderText(text)
  // 纯统计调用不读取资料，也不能把落盘的 final 当作有效复核。
  const reviewStatus = resolveReviewStatus ? await resolveReviewStatus(chapter, text) : 'pending'
  return {
    ...chapter,
    chars,
    target,
    missing: chars === 0,
    placeholder,
    written: chars > 0 && !placeholder,
    status: deriveChapterStatus(text, chapter.status, reviewStatus),
  }
}

export async function persistBook(root, meta, chapterList) {
  const previous = (await readJson(path.join(root, BOOK_FILE))) ?? {}
  const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
  const next = {
    ...base,
    version: 1,
    title: meta.title,
    author: meta.author,
    genre: meta.genre,
    summary: meta.summary,
    chapters: chapterList.map(item => ({
      id: item.id,
      title: item.title,
      file: item.file,
      status: item.status,
      ...(item.targetChars > 0 ? { targetChars: item.targetChars } : {}),
      ...(item.note ? { note: item.note } : {}),
      ...(item.deaiReview ? { deaiReview: item.deaiReview } : {}),
    })),
  }
  // 只有作者明确设过目标字数才落盘；默认值留在内存里用，不写进文件。
  if (meta.targetCharsSet) next.targetChars = meta.targetChars
  else delete next.targetChars
  await writeJson(path.join(root, BOOK_FILE), next)
}

export function findChapter(chapters, wanted) {
  const key = String(wanted ?? '').trim()
  if (!key) return undefined
  const lower = key.toLocaleLowerCase()
  return (
    chapters.find(item => item.id === key) ??
    chapters.find(item => item.id.toLocaleLowerCase() === lower) ??
    chapters.find(item => item.title === key) ??
    chapters.find(item => item.file.toLocaleLowerCase().endsWith(`${lower}.md`)) ??
    chapters.find(item => path.basename(item.file, '.md').toLocaleLowerCase() === lower)
  )
}

export function chapterNumberOf(title) {
  const match = /第\s*([0-9]{1,4}|[零一二两三四五六七八九十百千]{1,8})\s*章/u.exec(String(title ?? ''))
  if (!match) return 0
  const raw = match[1]
  if (/^[0-9]+$/u.test(raw)) return Number(raw)
  let total = 0
  let number = 0
  for (const char of raw) {
    if (char === '百') {
      total += (number || 1) * 100
      number = 0
    } else if (char === '千') {
      total += (number || 1) * 1000
      number = 0
    } else if (char === '十') {
      total += (number || 1) * 10
      number = 0
    } else {
      number = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[char] ?? 0
    }
  }
  return total + number
}

export function nextChapterId(chapters) {
  let max = 0
  for (const chapter of chapters) {
    const match = /^0*(\d+)/u.exec(chapter.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return String(max + 1).padStart(4, '0')
}

export const CHARACTERS_DIR = 'characters'

export const CHARACTER_EXT = '.md'

export const BEATS_FILE = 'beats.md'

export function parseSceneCadence(outlineText) {
  const body = String(outlineText ?? '')
  const patterns = [
    /每\s*([一二三四五六七八九十两\d]{1,3})\s*章\s*(?:至少)?\s*(?:一次)?\s*爽点/u,
    /([一二三四五六七八九十两\d]{1,3})\s*章\s*一\s*爽点/u,
  ]
  for (const pattern of patterns) {
    const hit = pattern.exec(body)
    if (!hit) continue
    const value = numberFromToken(hit[1])
    if (value >= 1 && value <= 20) return value
  }
  return 0
}

export const OUTLINE_FILE = 'outline.md'

export function stampOf(date = new Date()) {
  return date.toISOString().replace(/[-:T]/gu, '').slice(0, 14)
}

export function stampToIso(stamp) {
  const hit = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/u.exec(stamp)
  if (!hit) return ''
  return `${hit[1]}-${hit[2]}-${hit[3]}T${hit[4]}:${hit[5]}:${hit[6]}Z`
}

export function shortHash(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12)
}
