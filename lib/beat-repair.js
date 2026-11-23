import { assertValidBeatStructure, beatDocumentSections, BeatStructureError, changedBeatSections } from './beat-structure.js'

const SCENE_HEADING = /^(?:###[ \t]+场景[ \t]*|-[ \t]+场景[ \t]*[：:][ \t]*)([^\r\n]+)$/gmu
const ROLE_HEADING = /^####[ \t]+人物[ \t]+([\w-]+)[ \t]*[：:]?[ \t]*$/gmu
const REQUIRED_FIELD = /^-[ \t]+(时序|出场)[ \t]*[：:][ \t]*([^\r\n]*)$/gmu

function paragraphs(text) {
  return text.split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line.trim())
}

function readScene(text) {
  const roles = [...text.matchAll(ROLE_HEADING)]
  const head = text.slice(0, roles[0]?.index ?? text.length)
  const fields = [...head.matchAll(REQUIRED_FIELD)]
  return {
    content: paragraphs(head.replace(REQUIRED_FIELD, '')),
    fields: Object.fromEntries(['时序', '出场'].map(key => [
      key, [...new Set(fields.filter(field => field[1] === key).map(field => field[2].trim()).filter(Boolean))],
    ])),
    roles: roles.map((role, index) => ({
      id: role[1], content: paragraphs(text.slice(role.index + role[0].length, roles[index + 1]?.index ?? text.length)),
    })),
  }
}

function readRepairSection(text) {
  const headings = [...text.matchAll(SCENE_HEADING)]
  return {
    intro: paragraphs(text.slice(0, headings[0]?.index ?? text.length)),
    scenes: headings.map((heading, index) => {
      const idAndTitle = /^([\w-]+)[ \t]*[：:]\s*(.*)$/u.exec(heading[1].trim())
      return {
        id: idAndTitle?.[1] ?? '',
        title: (idAndTitle?.[2] ?? heading[1]).trim(),
        ...readScene(text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length)),
      }
    }),
  }
}

const same = (first, second) => JSON.stringify(first) === JSON.stringify(second)

class MissingStructureBasis extends Error {
  constructor(chapter, title, field) {
    super(`章纲缺少 ${chapter}「${title}」的明确${field}依据`)
    this.question = {
      basis: this.message,
      text: `请确认 ${chapter}「${title}」的${field}，或给出有依据的原文。`,
      options: [
        { label: '提供明确值', effect: '按你提供的值补齐该场结构' },
        { label: '暂缓修订', effect: '保留清单，暂停起稿' },
      ],
    }
  }
}

function assertStructureOnly(section, body, original) {
  const before = readRepairSection(section.body)
  const after = readRepairSection(body)
  const previous = readRepairSection(original?.body ?? '')
  if (!same(before.intro, after.intro) || !before.scenes.length || before.scenes.length !== after.scenes.length) {
    throw new Error(`章纲结构修复改变了 ${section.key} 的章级内容或场景数量，请先核对资料`)
  }
  for (const [index, scene] of before.scenes.entries()) {
    const repaired = after.scenes[index]
    if ((scene.id && repaired.id !== scene.id) || repaired.title !== scene.title || !same(scene.content, repaired.content)) {
      throw new Error(`章纲结构修复改变了 ${section.key} 的场景标题、已有 ID 或剧情内容，请先核对资料`)
    }
    const candidates = previous.scenes.filter(item => scene.id ? item.id === scene.id : item.title === scene.title)
    const prior = candidates.length === 1 ? candidates[0] : null
    for (const key of ['时序', '出场']) {
      const known = scene.fields[key].length ? scene.fields[key] : prior?.fields[key]
      if (known?.length !== 1) throw new MissingStructureBasis(section.key, scene.title, key)
      if (!same(known, repaired.fields[key])) {
        throw new Error(`章纲结构修复未保留 ${section.key}「${scene.title}」已有的${key}，资料尚未写入`)
      }
    }
    const existingRoles = new Set(scene.roles.map(role => role.id))
    const cast = new Set(repaired.fields.出场[0].split(/[、,，]/u).map(id => id.trim()))
    if (!same(scene.roles, repaired.roles.filter(role => existingRoles.has(role.id))) ||
        repaired.roles.some(role => !existingRoles.has(role.id) && (role.content.length || !cast.has(role.id)))) {
      throw new Error(`章纲结构修复改变了 ${section.key} 的人物约束，请先核对资料`)
    }
  }
}

export async function prepareBeatStructure(original, candidate, repair) {
  try {
    return { content: candidate, warnings: assertValidBeatStructure(candidate, original) }
  } catch (error) {
    if (!(error instanceof BeatStructureError) || !repair) throw error
    const changed = changedBeatSections(original, candidate)
    const issues = error.issues.filter(issue => issue.severity === 'error')
    const targets = new Set(issues.flatMap(issue => [issue.chapter, issue.relatedChapter]).filter(key => changed.has(key)))
    const sections = beatDocumentSections(candidate).filter(section => targets.has(section.key))
    const originalSections = beatDocumentSections(original)
    if (!sections.length || sections.length !== targets.size) throw error
    const proposals = await repair({
      issues,
      sections: sections.map(section => ({
        chapter: section.key, heading: section.heading, body: section.body,
        original: originalSections.find(item => item.key === section.key)?.body ?? '',
      })),
    })
    if (proposals?.question) return { question: proposals.question, issues }
    if (!Array.isArray(proposals?.sections) || !proposals.sections.length) throw error

    const proposed = new Map()
    for (const item of proposals.sections) {
      const section = sections.find(entry => entry.key === item?.chapter)
      if (!section || proposed.has(item.chapter) || typeof item.body !== 'string' || beatDocumentSections(item.body).length) throw error
      const newline = candidate.slice(section.start, section.headingEnd).endsWith('\r\n') ? '\r\n' : '\n'
      const body = item.body.trim().replace(/\r?\n/gu, newline) + (section.end < candidate.length ? newline + newline : newline)
      const previous = originalSections.filter(entry => entry.key === section.key)
      try {
        assertStructureOnly(section, body, previous.length === 1 ? previous[0] : null)
      } catch (unsafe) {
        if (unsafe instanceof MissingStructureBasis) return { question: unsafe.question, issues }
        throw unsafe
      }
      proposed.set(section.key, body)
    }
    const structureRepairs = sections.filter(section => proposed.has(section.key)).map(section => ({
      chapter: section.key, start: section.headingEnd, end: section.end, before: section.body, after: proposed.get(section.key),
    }))
    const content = [...structureRepairs].reverse().reduce((value, edit) =>
      value.slice(0, edit.start) + edit.after + value.slice(edit.end), candidate)
    return { content, warnings: assertValidBeatStructure(content, original), structureRepairs }
  }
}
