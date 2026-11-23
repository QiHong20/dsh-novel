import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { prepareBeatStructure } from './beat-repair.js'
import { parseBeatSections, resolveBeatSection } from './beats.js'
import { stageContext } from '../stage.js'
import { findChapter, loadBook, nextChapterId, readJson, readText, writeFileAtomic, writeJson } from './book.js'
import { withFileLock } from './file-lock.js'
import { archivePreflightGrill, grill, GRILL_NOT_FOUND, GRILL_PARAMETERS } from './grill.js'
import { listSettings, matchesSettingMention, SETTINGS_DIR, SETTING_VOID_RE } from './library.js'
import { listCharacters, matchesCharacterMention, safeCharacterName } from './people.js'
import { isPlaceholderText, readStyleCalibration } from './text.js'

const PLAN_FILES = /^(?:(?:outline|beats|events|threads)\.md|(?:characters|settings)\/[^/\\]+\.md)$/u
const CHAPTER_PREFLIGHT_RULE_VERSION = 2
const MAIN_FILES = ['outline.md', 'beats.md', 'events.md', 'threads.md', 'ledger.md']
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stateFile = (root, chapter) => path.join(root, '.novel', 'chapter-preflight', digest(chapter.id) + '.json')
const hasText = value => typeof value === 'string' && Boolean(value.trim())

export function hasDraftProse(value) {
  const body = (value ?? '').replace(/^\s*#\s+[^\n]+(?:\n|$)/u, '').trim()
  return Boolean(body) && !isPlaceholderText(body)
}

async function materialFile(root, name) {
  const file = path.resolve(root, name)
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('资料路径超出书稿目录')
  const base = await fs.realpath(root)
  const parent = await fs.realpath(path.dirname(file)).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (parent && parent !== path.join(base, path.dirname(relative))) throw new Error('资料目录不能通过符号链接访问')
  const stat = await fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat && !stat.isFile()) throw new Error('章前资料必须是书稿目录中的普通文件')
  return file
}

async function readMaterial(root, name) {
  return readText(await materialFile(root, name))
}

export async function preflightChapter(root, meta, wanted, title) {
  const nextId = nextChapterId(meta.chapters)
  if (wanted) {
    const chapter = findChapter(meta.chapters, wanted)
    if (chapter) return chapter
    if (String(wanted) !== nextId) throw new Error('找不到指定章节，请先核对章节清单')
  } else {
    for (const chapter of meta.chapters) {
      if (!hasDraftProse(await readMaterial(root, chapter.file))) return chapter
    }
  }
  const explicitTitle = title?.trim()
  const state = explicitTitle ? null : await readJson(stateFile(root, { id: nextId }))
  return { id: nextId, title: explicitTitle || state?.chapter?.title || `第 ${Number(nextId)} 章`, file: `chapters/${nextId}.md` }
}

async function collectSources(root, meta, chapter, extraSources, direction) {
  const index = meta.chapters.findIndex(item => item.id === chapter.id)
  const raw = await Promise.all(MAIN_FILES.map(file => readMaterial(root, file)))
  const [outline, beats] = raw
  const chapters = index < 0 ? [...meta.chapters, chapter] : meta.chapters
  const matched = resolveBeatSection(parseBeatSections(beats), chapter, chapters)
  const beatsText = matched.kind === 'matched' ? `## ${matched.section.heading}\n${matched.section.body}` : null
  const sources = MAIN_FILES.map((file, position) => ({ file, text: file === 'beats.md' ? beatsText : raw[position] }))
  const current = await readMaterial(root, chapter.file)
  sources.push({ file: chapter.file, text: current })
  let previous = ''
  for (const item of meta.chapters.slice(0, index < 0 ? meta.chapters.length : index).reverse()) {
    const text = await readMaterial(root, item.file)
    if (!hasDraftProse(text)) continue
    previous = text.slice(-12000)
    const includeFullText = extraSources.includes(item.file)
    sources.push({ file: item.file, text: includeFullText ? text : previous, scope: includeFullText ? '上一已写章全文' : '上一已写章末尾' })
    break
  }
  const [characters, settings] = await Promise.all([listCharacters(root), listSettings(root)])
  const focus = [beatsText, outline, previous, current, direction].filter(Boolean).join('\n')
  const cast = new Set((matched.section?.scenes ?? []).flatMap(scene => scene.cast))
  const relevantCharacters = characters.filter(item => cast.has(item.id) || matchesCharacterMention(focus, item))
  const relevantSettings = settings.filter(item => matchesSettingMention(focus, item.name))
  const activeStyle = meta.style ? `styles/${safeCharacterName(meta.style)}.md` : null
  const relevantFiles = [...relevantCharacters, ...relevantSettings].map(item => item.file)
  const files = new Set([...extraSources, ...relevantFiles, ...(activeStyle ? [activeStyle] : [])])
  for (const file of [...files].sort()) {
    if (sources.some(item => item.file === file)) continue
    const text = await readMaterial(root, file)
    if (file.startsWith(SETTINGS_DIR + '/') && SETTING_VOID_RE.test(text ?? '')) continue
    sources.push({ file, text: file === activeStyle && text !== null ? readStyleCalibration(text).content : text })
  }
  if (index >= 0 && hasDraftProse(current)) {
    for (const item of meta.chapters.slice(index + 1)) {
      if (!hasDraftProse(await readMaterial(root, item.file))) continue
      const ledger = sources.find(source => source.file === 'ledger.md')
      ledger.text = null
      ledger.scope = '目标为历史章节，当前快照不适用'
      break
    }
  }
  if (matched.section?.scenes?.length) {
    const stage = await stageContext(root, chapters, chapter.id)
    const history = stage.scenes.map(scene => ({
      scene: scene.id,
      characters: scene.characters.map(character => ({
        name: character.name,
        facts: character.history.map(record => ({ content: record.content, evidence: record.evidence, chapter: record.chapter })),
      })),
    }))
    sources.push({ file: '本章有效人物历史', text: JSON.stringify(history), scope: '场景入场时的已确认记录，附来源正文引文' })
  }
  if (direction) sources.push({ file: '本次作者要求', text: direction })
  return { sources, matchIssue: matched.kind === 'ambiguous' ? matched.message : '', hash: digest([CHAPTER_PREFLIGHT_RULE_VERSION, chapter.id, chapter.title, sources, matched.kind === 'ambiguous' ? matched.message : '']) }
}

function outlineExampleRanges(text) {
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+([^\r\n]+)/gmu)]
  return headings.flatMap((heading, index) => {
    if (!/范本|范例|示范段落|样稿|试写/u.test(heading[2])) return []
    const next = headings.slice(index + 1).find(item => item[1].length <= heading[1].length)
    return [[heading.index, next?.index ?? text.length]]
  })
}

function quoteOccursOnlyInExamples(outline, ranges, quote) {
  if (!ranges.length) return false
  for (let start = outline.indexOf(quote); start >= 0; start = outline.indexOf(quote, start + 1)) {
    if (!ranges.some(([from, to]) => start >= from && start + quote.length <= to)) return false
  }
  return true
}

const PREFLIGHT_REPORT_INVALID = 'PREFLIGHT_REPORT_INVALID'

function invalidReport(message, rejected) {
  const error = new Error(message)
  error.code = PREFLIGHT_REPORT_INVALID
  error.feedback = message
  if (hasText(rejected?.quote)) {
    const quote = Array.from(rejected.quote).slice(0, 160).join('')
    error.feedback += `上次提交的可疑引文：${quote}。请从已提供的资料里重新逐字摘录。`
  }
  return error
}

function validateReport(report, snapshot) {
  if (!Array.isArray(report?.issues) || !Array.isArray(report?.facts)) throw new Error('模型未返回完整的章前核对结果')
  const sources = new Map(snapshot.sources.map(item => [item.file, item.text]))
  const matchesSource = (file, quote) => sources.get(file)?.includes(quote)
  const resolveEvidence = entry => {
    if (!hasText(entry?.quote) || !sources.has(entry.file)) return entry
    if (matchesSource(entry.file, entry.quote)) return { file: entry.file, quote: entry.quote }
    const candidates = [...sources.keys()].filter(file => matchesSource(file, entry.quote))
    if (candidates.length !== 1) return entry
    return { file: candidates[0], quote: entry.quote, reportedFile: entry.file }
  }
  const invalidEvidenceIndex = entries => Array.isArray(entries)
    ? entries.findIndex(entry => !hasText(entry?.quote) || !matchesSource(entry.file, entry.quote))
    : -1
  const describeEvidence = entry => hasText(entry?.file)
    ? `「${entry.file}」中找不到对应的逐字引文`
    : '引文缺少有效来源'
  const outline = sources.get('outline.md') ?? ''
  const exampleRanges = outlineExampleRanges(outline)
  const facts = []
  const exampleNotes = []
  for (const [index, fact] of report.facts.entries()) {
    const evidence = Array.isArray(fact?.evidence) ? fact.evidence.map(resolveEvidence) : fact?.evidence
    const invalid = invalidEvidenceIndex(evidence)
    const rejected = evidence?.[invalid]
    let detail = ''
    if (!hasText(fact?.text)) detail = '缺少事实说明'
    else if (!Array.isArray(evidence) || !evidence.length) detail = '未提供引文'
    else if (invalid >= 0) detail = describeEvidence(rejected)
    if (detail) {
      throw invalidReport(`章前事实第 ${index + 1} 条缺少可核对的原文依据：${detail}。首章可引用章纲、大纲或本次作者要求，无须引用已有正文。`, rejected)
    }
    if (evidence.every(entry => entry.file === 'outline.md' &&
      quoteOccursOnlyInExamples(outline, exampleRanges, entry.quote))) {
      exampleNotes.push({ kind: 'note', detail: `总纲范本供对照，当前资料未单独支持以下写作事实：${fact.text}`, evidence })
    } else {
      facts.push({ text: fact.text, evidence })
    }
  }
  const issues = report.issues.map((issue, index) => {
    const evidence = Array.isArray(issue?.evidence) ? issue.evidence.map(resolveEvidence) : issue?.evidence
    const invalid = invalidEvidenceIndex(evidence)
    const rejected = evidence?.[invalid]
    let detail = ''
    if (!['conflict', 'missing-basis', 'note'].includes(issue?.kind)) detail = '分类须为 conflict、missing-basis 或 note'
    else if (!hasText(issue.detail)) detail = '缺少问题说明'
    else if (!Array.isArray(evidence)) detail = 'evidence 须为引文数组，缺失项无原文可引用时可传空数组'
    else if (invalid >= 0) detail = describeEvidence(rejected)
    else if (issue.kind === 'conflict' && new Set(evidence.map(entry => entry.file + '\n' + entry.quote)).size < 2) {
      detail = '确认冲突需要两条不同的逐字引文'
    } else if (issue.kind !== 'note' && (!hasText(issue.question) || !Array.isArray(issue.options) ||
        issue.options.length < 2 || issue.options.length > 4 ||
        issue.options.some(option => !hasText(option?.label) || !hasText(option.effect)))) {
      detail = '阻塞项须给出问题和两到四个说明后果的选项'
    }
    if (detail) throw invalidReport(`章前问题第 ${index + 1} 条未通过校验：${detail}。`, rejected)
    return { ...issue, evidence, id: String(index + 1) }
  })
  if (snapshot.matchIssue) {
    issues.push({
      id: String(issues.length + 1), kind: 'missing-basis', detail: snapshot.matchIssue, evidence: [],
      question: '本章应采用哪一份章纲？',
      options: [
        { label: '合并到当前章 ID', effect: '按本章 ID 合并正确的剧情段落，移除产生歧义的重复小节' },
        { label: '重新指定章纲归属', effect: '按作者指定的章 ID 重新标记对应小节' },
      ],
    })
  }
  for (const note of exampleNotes) issues.push({ ...note, id: String(issues.length + 1) })
  if (!issues.some(issue => issue.kind !== 'note') && !facts.length) {
    if (!exampleNotes.length) throw new Error('模型未提供可用于起稿的已核对事实')
    throw invalidReport('模型返回的写作依据全部来自总纲范本。请从本章章纲、总纲的正式计划或本次作者要求引用依据；依据不足时请返回缺失项。')
  }
  return { issues, facts }
}

function publicState(state) {
  return {
    status: state.status, chapter: state.chapter, preflightId: state.id, issues: state.issues, facts: state.facts,
    ...(state.grillId ? { grillId: state.grillId } : {}),
    ...(state.message ? { message: state.message } : {}),
    ...(state.lastRepair ? { lastRepair: state.lastRepair } : {}),
    ...(state.plan ? {
      planId: state.plan.id, changes: state.plan.edits, applied: state.applied ?? [],
      structureRepairs: state.plan.files.flatMap(file => file.structureRepairs ?? []),
      structureWarnings: state.plan.files.flatMap(file => file.warnings ?? []),
    } : {}),
  }
}

async function inspectPreflightGrill(root, id) {
  if (!id) return null
  try {
    const interview = await grill(root, { action: 'inspect', id })
    return interview.session.status === 'archived' ? null : interview
  } catch (error) {
    if (error.code === GRILL_NOT_FOUND) return null
    throw error
  }
}

async function requirePreflightGrill(root, id) {
  const interview = await inspectPreflightGrill(root, id)
  if (!interview) throw new Error('章前拷问会话已失效，请重新预检')
  return interview
}

async function withGrillQuestions(root, value) {
  if (value.status !== 'blocked') return value
  const interview = await inspectPreflightGrill(root, value.grillId)
  if (!interview) return { status: 'stale' }
  return { ...value, questions: interview.session.questions, grillBaseHash: interview.baseHash }
}

export async function chapterPreflightStatus(root, meta, chapter, includeFacts = true) {
  const state = await readJson(stateFile(root, chapter))
  if (!state) return { status: 'pending' }
  if (['applying', 'write-failed', 'recheck', 'stale'].includes(state.status)) return publicState(state)
  const current = await collectSources(root, meta, chapter, state.extraSources, state.direction)
  if (state.sourceHash !== current.hash) return { status: 'stale' }
  const value = publicState(state)
  if (!includeFacts) return { status: value.status, preflightId: value.preflightId }
  return value
}

async function archiveSupersededGrill(root, file, state) {
  if (!state?.supersededGrillId) return
  await archivePreflightGrill(root, state.supersededGrillId)
  delete state.supersededGrillId
  await writeJson(file, state)
}

async function check(root, file, chapter, config, snapshot, review, previous) {
  const { extraSources, direction } = config
  let report
  try {
    report = validateReport(await review(chapter, snapshot, previous), snapshot)
  } catch (error) {
    if (error.code !== PREFLIGHT_REPORT_INVALID) throw error
    try {
      report = validateReport(await review(chapter, snapshot, previous, error.feedback), snapshot)
    } catch (retryError) {
      if (retryError.code !== PREFLIGHT_REPORT_INVALID) throw retryError
      retryError.message = `章前预检已自动纠正一次，核对结果仍未通过校验，起稿已暂停。${retryError.message}`
      throw retryError
    }
  }
  const { meta: latest } = await loadBook(root)
  const target = await preflightChapter(root, latest, chapter.id, chapter.title)
  const current = await collectSources(root, latest, target, extraSources, direction)
  if (snapshot.hash !== current.hash) throw new Error('资料在预检期间发生变化，请重新预检')
  const blockers = report.issues.filter(issue => issue.kind !== 'note')
  const state = {
    status: blockers.length ? 'blocked' : 'ready', chapter: { id: chapter.id, title: chapter.title },
    id: randomUUID(), sourceHash: snapshot.hash,
    ...config, ...report,
    supersededGrillId: previous?.grillId,
    lastRepair: previous?.status === 'recheck' ? { planId: previous.plan.id, files: previous.applied } : previous?.lastRepair,
  }
  if (blockers.length) {
    const interview = await grill(root, {
      action: 'start', mode: 'plot', depth: 'quick', topic: `第 ${chapter.id} 章章前预检`, sources: [],
      preflightQuestions: blockers.map(issue => ({
        issueId: issue.id,
        text: issue.question,
        basis: [issue.detail, ...issue.evidence.map(entry => `${entry.file}「${entry.quote}」`)].join('\n'),
        options: issue.options,
      })),
    })
    state.grillId = interview.session.id
    state.questions = interview.session.questions
  }
  await writeJson(file, state)
  await archiveSupersededGrill(root, file, state)
  return withGrillQuestions(root, publicState(state))
}

function replacePassages(text, edits) {
  const ranges = edits.map(({ before, after }) => {
    if (typeof before !== 'string' || typeof after !== 'string' || before === after) throw new Error('每项修订都须提供不同的原文和替换文字')
    if (!before && text) throw new Error('已有内容的资料必须指定唯一原文')
    const start = text.indexOf(before)
    if (start < 0 || (before && text.indexOf(before, start + 1) >= 0)) throw new Error('待修改原文不存在或出现多次，请扩展定位范围')
    return { start, end: start + before.length, after }
  }).sort((first, second) => second.start - first.start)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].end > ranges[index - 1].start || ranges[index].start === ranges[index - 1].start) throw new Error('修订范围重叠')
  }
  return ranges.reduce((value, range) => value.slice(0, range.start) + range.after + value.slice(range.end), text)
}

async function plannedFiles(root, edits, forbidden, repair) {
  const groups = new Map()
  for (const edit of edits) {
    if (!PLAN_FILES.test(edit.file) || forbidden.has(path.resolve(root, edit.file)) || !hasText(edit.reason)) throw new Error('修订只允许修改资料，且每处须注明原因及影响范围')
    groups.set(edit.file, [...(groups.get(edit.file) ?? []), edit])
  }
  return Promise.all([...groups].map(async ([name, changes]) => {
    const file = await materialFile(root, name)
    const original = await readText(file)
    const content = replacePassages(original ?? '', changes)
    const candidate = name === 'beats.md' ? await prepareBeatStructure(original ?? '', content, repair) : { content }
    return { name, baseHash: digest(original), ...candidate }
  }))
}

function renderChanges(plan) {
  const edits = plan.edits.map(edit =>
    `${edit.file}｜${edit.reason}\n原文：\n${edit.before || '（空）'}\n改为：\n${edit.after || '（删除）'}`)
  const repairs = plan.files.flatMap(file => (file.structureRepairs ?? []).map(edit =>
    `${file.name}｜${edit.chapter} 自动结构修复（基于上方修订后的候选）\n修复前：\n${edit.before}\n修复后：\n${edit.after}`))
  return [...edits, ...repairs].join('\n\n')
}

async function confirmApply(confirm, chapter, plan) {
  return confirm({
    id: plan.id, header: '确认章前修订',
    question: `第 ${chapter.id} 章拟修订以下资料。确认后应用这一批改动并重新预检。\n\n${renderChanges(plan)}`,
    options: [{ label: '确认应用', description: '按清单修订并复检' }, { label: '暂不应用', description: '保留清单，暂停起稿' }],
  })
}

async function assertFresh(root, meta, chapter, state) {
  const sources = await collectSources(root, meta, chapter, state.extraSources, state.direction)
  if (sources.hash !== state.sourceHash) throw new Error('资料已变化，旧拷问及修订清单不能用于写入，请重新预检')
}

export async function runChapterPreflight(root, chapter, args, { review, confirm, repair }) {
  root = path.resolve(root)
  const file = stateFile(root, chapter)
  const locked = task => withFileLock(file, task)
  if (args.action === 'inspect') {
    const { meta } = await loadBook(root)
    const current = await preflightChapter(root, meta, chapter.id, chapter.title)
    return withGrillQuestions(root, await chapterPreflightStatus(root, meta, current))
  }
  if (args.action === 'apply') {
    const pending = await readJson(file)
    if (!pending?.plan || pending.plan.id !== args.planId || pending.status !== 'blocked') throw new Error('修订清单已失效，请查看当前章前状态')
    const { meta } = await loadBook(root)
    await assertFresh(root, meta, chapter, pending)
    const interview = await requirePreflightGrill(root, pending.grillId)
    if (interview.baseHash !== pending.plan.interviewHash) throw new Error('拷问回答已变化，请重新生成并确认清单')
    if (!await confirmApply(confirm, chapter, pending.plan)) return { ...publicState(pending), message: '作者暂未确认，未应用修订' }
  }
  return locked(async () => {
    const { meta } = await loadBook(root)
    const current = await preflightChapter(root, meta, chapter.id, chapter.title)
    const state = await readJson(file)
    await archiveSupersededGrill(root, file, state)
    if (args.action === 'check') {
      if (['applying', 'write-failed'].includes(state?.status)) throw new Error('上一批修订尚未完成，须先恢复该批写入')
      const direction = args.direction ?? state?.direction ?? ''
      const extraSources = [...new Set(args.sources ?? state?.extraSources ?? [])]
      const currentIndex = meta.chapters.findIndex(entry => entry.id === current.id)
      const availableProse = new Set(meta.chapters.slice(0, currentIndex < 0 ? undefined : currentIndex + 1).map(item => item.file))
      if (extraSources.some(name => !PLAN_FILES.test(name) && !availableProse.has(name))) {
        throw new Error('补充资料须是本书计划、人物、设定或目标章及之前的正文')
      }
      const snapshot = await collectSources(root, meta, current, extraSources, direction)
      if (['ready', 'blocked'].includes(state?.status) && state.sourceHash === snapshot.hash) {
        const cached = await withGrillQuestions(root, publicState(state))
        if (cached.status !== 'stale') return cached
      }
      return check(root, file, current, { direction, extraSources }, snapshot, review, state)
    }
    if (!state) throw new Error('请先执行章前预检')
    if (args.action === 'answer') {
      if (!hasText(args.chapter) || state.status !== 'blocked') throw new Error('请指定仍有待答拷问的章节，并先查看当前章前状态')
      await assertFresh(root, meta, current, state)
      const interview = await requirePreflightGrill(root, state.grillId)
      if (!interview.session.questions.some(question => question.id === args.questionId && question.status === 'pending')) {
        throw new Error('当前章前拷问找不到该待答问题，请使用 inspect 返回的 questions[].id')
      }
      const updated = await grill(root, {
        action: 'answer', id: interview.session.id, baseHash: interview.baseHash, questionId: args.questionId,
        answer: args.answer, selected: args.selected, disposition: args.disposition,
      })
      return { ...publicState(state), questions: updated.session.questions, grillBaseHash: updated.baseHash }
    }
    if (args.action === 'preview') {
      if (state.status !== 'blocked' || args.preflightId !== state.id) throw new Error('须基于当前阻塞的预检生成修订清单')
      await assertFresh(root, meta, current, state)
      const interview = await requirePreflightGrill(root, state.grillId)
      const answers = new Map(interview.session.questions.map(question => [question.id, question]))
      if (state.questions.some(question => answers.get(question.id)?.answer?.disposition !== 'decided')) throw new Error('仍有阻塞问题未获明确回答')
      if (interview.session.questions.some(question => question.status === 'pending' || question.issueId === undefined && question.answer?.disposition !== 'decided')) {
        throw new Error('仍有待处理的拷问，请先登记明确答复')
      }
      if (interview.session.questions.some(question => question.needsReview)) throw new Error('已有答复发生变化，请先复核受影响的答复并用拷问总结登记')
      const edits = args.edits ?? []
      if (!edits.length || state.questions.some(question => !edits.some(edit => Array.isArray(edit.issueIds) && edit.issueIds.includes(question.issueId))) ||
          edits.some(edit => !edit.issueIds?.length || edit.issueIds.some(id => !state.questions.some(question => question.issueId === id)))) {
        throw new Error('变更清单须覆盖全部阻塞问题，且每处须关联对应问题')
      }
      const files = await plannedFiles(root, edits, new Set(meta.chapters.map(item => path.resolve(root, item.file))), repair)
      await assertFresh(root, meta, current, state)
      const followup = files.find(item => item.question)
      if (followup) {
        const updated = await grill(root, {
          action: 'ask', id: interview.session.id, baseHash: interview.baseHash, question: followup.question,
        })
        if (state.plan) {
          delete state.plan
          await writeJson(file, state)
        }
        return {
          ...publicState(state), questions: updated.session.questions, grillBaseHash: updated.baseHash,
          structureIssues: followup.issues, message: '章纲结构修复需要作者补充依据，修订尚未应用。',
        }
      }
      for (const file of files) {
        if (digest(await readMaterial(root, file.name)) !== file.baseHash) {
          throw new Error(`${file.name} 在生成修订清单期间发生变化，请重新预检或预览`)
        }
      }
      state.plan = { id: randomUUID(), interviewHash: interview.baseHash, edits, files }
      await writeJson(file, state)
      return { ...publicState(state), preview: renderChanges(state.plan) }
    }
    if (!['apply', 'resume'].includes(args.action) || !state.plan || state.plan.id !== args.planId) throw new Error('修订清单已变化，请查看当前章前状态')
    if (args.action === 'apply') {
      if (state.status !== 'blocked') throw new Error('清单已经处理，请查看当前章前状态')
      await assertFresh(root, meta, current, state)
      const interview = await requirePreflightGrill(root, state.grillId)
      if (interview.baseHash !== state.plan.interviewHash) throw new Error('拷问回答已变化，请重新生成并确认清单')
      state.status = 'applying'
      state.message = ''
      state.applied = []
      await writeJson(file, state)
    } else if (!['applying', 'write-failed'].includes(state.status)) {
      throw new Error('没有待恢复的修订')
    }
    const lockFiles = [...state.plan.files].sort((first, second) => first.name.localeCompare(second.name))
    const apply = async index => {
      if (index < lockFiles.length) {
        return withFileLock(path.join(root, lockFiles[index].name), () => apply(index + 1))
      }
      const targets = await Promise.all(state.plan.files.map(async change => {
        const target = await materialFile(root, change.name)
        const original = await readText(target)
        const completed = original === change.content
        if (!completed && (state.applied.includes(change.name) || digest(original) !== change.baseHash)) {
          const error = new Error(`${change.name} 已变化，请先核对手动修改和待完成清单`)
          error.code = 'PREFLIGHT_TARGET_CHANGED'
          throw error
        }
        return { change, target, completed }
      }))
      for (const { change, target, completed } of targets) {
        if (!completed) await writeFileAtomic(target, change.content)
        if (!state.applied.includes(change.name)) state.applied.push(change.name)
        await writeJson(file, state)
      }
    }
    try {
      await apply(0)
    } catch (error) {
      state.status = error.code === 'PREFLIGHT_TARGET_CHANGED' && args.action === 'apply' && !state.applied.length ? 'stale' : 'write-failed'
      state.message = error.message
      await writeJson(file, state)
      return publicState(state)
    }
    state.status = 'recheck'
    state.message = ''
    state.extraSources = [...new Set([...state.extraSources, ...state.plan.files.map(item => item.name)])]
    await writeJson(file, state)
    const { meta: latest } = await loadBook(root)
    const target = await preflightChapter(root, latest, current.id, current.title)
    const config = { direction: state.direction, extraSources: state.extraSources }
    const snapshot = await collectSources(root, latest, target, config.extraSources, config.direction)
    return check(root, file, target, config, snapshot, review, state)
  })
}

export const CHAPTER_PREFLIGHT_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['check', 'inspect', 'answer', 'preview', 'apply', 'resume'] },
    chapter: { type: 'string', description: '章 ID 或标题；未登记的下一章可传下一章 ID' },
    title: { type: 'string', description: '尚未登记的下一章标题' },
    direction: { type: 'string', description: '作者本次明确给出的创作要求原文，不得替作者拟定' },
    sources: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: '补充相关资料在书内的相对路径' },
    preflightId: { type: 'string' },
    questionId: { type: 'string', description: 'answer 使用本章当前待答问题的 questions[].id' },
    answer: GRILL_PARAMETERS.properties.answer,
    selected: GRILL_PARAMETERS.properties.selected,
    disposition: GRILL_PARAMETERS.properties.disposition,
    planId: { type: 'string' },
    edits: {
      type: 'array', minItems: 1, items: {
        type: 'object', additionalProperties: false, required: ['file', 'before', 'after', 'reason', 'issueIds'],
        properties: {
          file: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' },
          reason: { type: 'string', description: '修订原因及受影响章节' },
          issueIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
        },
      },
    },
  },
}
