import { createHash } from 'node:crypto'
import { scanBeatHeadings } from './beat-match.js'

export const hash = value => createHash('sha256').update(value).digest('hex')

export const PSYCHOLOGY_FIELDS = ['心理触发', '心理内容', '叙事作用', '表达方式', '展开程度', '视角权限', '保留心声原句']
export const APPEARANCE_FIELDS = ['登场性质', '观察者', '描写重点', '呈现时机', '第一印象', '已呈现与新增', '不描写原因']
export const ROLE_FIELDS = ['已知', '未知', '误信', '怀疑', '目标', '关系与情绪', '表达意图', '触发', '计划变化', '必须表现', ...PSYCHOLOGY_FIELDS, ...APPEARANCE_FIELDS]
export const SCENE_FIELDS = ['故事时间', '时序', '地点', '视角', '叙述方式', '出场', '提及', '事件', '本场推进', '本场允许结果', '禁止提前兑现', '状态对象', '所需设定', '冲突', '结果', '转折', '落点', '钩子']
export const CHAPTER_FIELDS = ['本章目标', '收尾']
export const BEAT_STRUCTURE_INVALID = 'BEAT_STRUCTURE_INVALID'

export const parseStageFields = text => Object.fromEntries(
  [...String(text ?? '').matchAll(/^- ([^：\n]+)：([^\n]*)$/gm)].map(match => [match[1], match[2].trim()]),
)

const parseList = text => String(text ?? '').split(/[、,，]/u).map(value => value.trim()).filter(Boolean)
const pick = (fields, keys) => Object.fromEntries(keys.filter(key => fields[key]).map(key => [key, fields[key]]))
const issue = (code, severity, message, location = {}) => ({ code, severity, message, ...location })
const fieldMatches = (text, name) => [...text.matchAll(new RegExp(`^- ${name}：([^\\n]*)$`, 'gm'))]

const afterLine = (source, index, length) => {
  const at = index + length
  if (source.startsWith('\r\n', at)) return at + 2
  if (source.startsWith('\n', at)) return at + 1
  return at
}

// 场景标题的唯一扫描入口：局部编辑与解析共用同一偏移，避免两套正则各算边界。
export function scanSceneHeadings(text) {
  const source = String(text ?? '')
  const matches = [...source.matchAll(/^### 场景 ([\w-]+)[ \t]*[：:][ \t]*([^\r\n]*)\r?$/gm)]
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length
    return {
      index: match.index,
      end,
      bodyStart: afterLine(source, match.index, match[0].length),
      id: match[1],
      title: match[2].trim(),
      line: match[0],
    }
  })
}

export function parseScenes(text, chapter = '') {
  const source = String(text ?? '')
  return scanSceneHeadings(source).map(hit => {
    const raw = source.slice(hit.index, hit.end).trim()
    const head = raw.split(/^#### /m)[0]
    const fields = parseStageFields(head)
    const roles = [...raw.matchAll(/^#### 人物 ([\w-]+)[ \t]*\r?$/gm)].map((role, roleIndex, all) => {
      const constraints = raw.slice(role.index + role[0].length, all[roleIndex + 1]?.index ?? raw.length).trim()
      const roleFields = parseStageFields(constraints)
      return {
        id: role[1],
        constraints,
        fields: roleFields,
        psychology: pick(roleFields, PSYCHOLOGY_FIELDS),
        appearance: pick(roleFields, APPEARANCE_FIELDS),
      }
    })
    return {
      id: hit.id,
      title: hit.title,
      chapter,
      raw,
      fields,
      viewpoint: fields.视角 || '',
      narration: fields.叙述方式 || '',
      cast: parseList(fields.出场),
      mentioned: parseList(fields.提及),
      time: /^-?\d+$/u.test(fields.时序 || '') ? Number(fields.时序) : null,
      storyTime: fields.故事时间 || '',
      events: parseList(fields.事件),
      roles,
    }
  })
}

export function validateBeatStructure(text) {
  const source = String(text ?? '').replace(/\r\n/gu, '\n')
  const headings = scanBeatHeadings(source)
  const issues = []
  const sceneOwners = new Map()
  const chapterIds = new Set()

  for (let chapterIndex = 0; chapterIndex < headings.length; chapterIndex += 1) {
    const heading = headings[chapterIndex]
    const chapter = heading.id || heading.heading
    const body = source.slice(heading.end, headings[chapterIndex + 1]?.index ?? source.length).trim()
    const scenes = parseScenes(body, chapter)
    const sceneHeadings = [...body.matchAll(/^###[ \t]+[^\n]*$/gmu)]

    if (heading.id && chapterIds.has(heading.id)) {
      issues.push(issue('chapter-id-duplicate', 'error', `章 ID ${heading.id} 重复`, { chapter }))
    }
    if (heading.id) chapterIds.add(heading.id)
    if (!scenes.length) {
      issues.push(issue(
        'chapter-scenes-required',
        'error',
        `章节 ${chapter} 没有结构化场景`,
        { chapter },
      ))
      continue
    }
    if (sceneHeadings.length !== scenes.length) {
      issues.push(issue(
        'scene-heading-invalid',
        'error',
        `章节 ${chapter} 存在无法解析的场景标题`,
        { chapter },
      ))
    }
    if (scenes.length > 8) {
      issues.push(issue(
        'chapter-scene-limit',
        'warning',
        `章节 ${chapter} 写了 ${scenes.length} 场，超过 8 场，建议拆分`,
        { chapter },
      ))
    }

    for (const scene of scenes) {
      const location = { chapter, scene: scene.id }
      if (!scene.title) {
        issues.push(issue('scene-heading-invalid', 'error', `场景 ${scene.id} 缺少标题`, location))
      }
      const owner = sceneOwners.get(scene.id)
      if (owner) {
        issues.push(issue(
          'scene-id-duplicate',
          'error',
          `场景 ID ${scene.id} 在章节 ${owner} 与 ${chapter} 重复`,
          { ...location, relatedChapter: owner },
        ))
      } else {
        sceneOwners.set(scene.id, chapter)
      }

      const head = scene.raw.split(/^#### /m)[0]
      const timeFields = fieldMatches(head, '时序')
      const timeValue = timeFields[0]?.[1]?.trim() ?? ''
      const time = /^-?\d+$/u.test(timeValue) ? Number(timeValue) : Number.NaN
      if (timeFields.length !== 1 || !Number.isSafeInteger(time)) {
        issues.push(issue(
          'scene-time-required',
          'error',
          `场景 ${scene.id} 必须有且只有一个安全整数「时序」`,
          location,
        ))
      }

      const castFields = fieldMatches(head, '出场')
      const cast = parseList(castFields[0]?.[1] ?? '')
      if (castFields.length !== 1 || !cast.length) {
        issues.push(issue(
          'scene-cast-required',
          'error',
          `场景 ${scene.id} 必须有且只有一个非空「出场」`,
          location,
        ))
      }
      if (new Set(cast).size !== cast.length) {
        issues.push(issue(
          'scene-cast-duplicate',
          'error',
          `场景 ${scene.id} 的「出场」包含重复人物 ID`,
          location,
        ))
      }

      const roleCounts = new Map()
      for (const role of scene.roles) roleCounts.set(role.id, (roleCounts.get(role.id) ?? 0) + 1)
      // 人物块标题的合法性与解析结果无关：损坏标题会让其下的字段并入上一块，必须拒绝。
      const roleHeadings = [...scene.raw.matchAll(/^####[ \t]+人物(?:[ \t：:]|$)[^\r\n]*$/gmu)]
      if (roleHeadings.length !== scene.roles.length) {
        issues.push(issue(
          'scene-character-heading-invalid',
          'error',
          `场景 ${scene.id} 存在无法解析的人物块标题`,
          location,
        ))
      }
      for (const [character, count] of roleCounts) {
        if (count === 1) continue
        issues.push(issue(
          'scene-character-block-duplicate',
          'error',
          `场景 ${scene.id} 的人物 ${character} 有 ${count} 个人物块`,
          { ...location, character },
        ))
      }
      for (const character of new Set(cast)) {
        if (roleCounts.has(character)) continue
        issues.push(issue(
          'scene-character-block-required',
          'error',
          `场景 ${scene.id} 的出场人物 ${character} 必须有且只有一个人物块`,
          { ...location, character },
        ))
      }
    }
  }
  return issues
}

export class BeatStructureError extends Error {
  constructor(issues) {
    const errors = issues.filter(item => item.severity === 'error')
    super(`章纲结构校验失败，未写入：${errors.map(item => item.message).join('；')}`)
    this.name = 'BeatStructureError'
    this.code = BEAT_STRUCTURE_INVALID
    this.issues = issues
  }
}

export function beatDocumentSections(text) {
  const source = text ?? ''
  const headings = scanBeatHeadings(source)
  return headings.map((heading, index) => ({
    key: heading.id || heading.heading,
    heading: heading.heading,
    headingEnd: heading.end,
    start: heading.index,
    end: headings[index + 1]?.index ?? source.length,
    body: source.slice(heading.end, headings[index + 1]?.index ?? source.length),
  }))
}

export function changedBeatSections(original, candidate) {
  const byChapter = sections => {
    const values = new Map()
    for (const section of sections) {
      const body = section.body.replace(/\r\n/gu, '\n').trim()
      values.set(section.key, [...(values.get(section.key) ?? []), [section.heading, body]])
    }
    return values
  }
  const before = byChapter(beatDocumentSections(original))
  const after = byChapter(beatDocumentSections(candidate))
  return new Set([...before.keys(), ...after.keys()].filter(key =>
    JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))))
}

export function assertValidBeatStructure(text, original) {
  const issues = validateBeatStructure(text)
  if (original === undefined) {
    if (issues.some(item => item.severity === 'error')) throw new BeatStructureError(issues)
    return issues
  }
  const changed = changedBeatSections(original, text)
  const baseline = new Map()
  for (const item of validateBeatStructure(original)) {
    if (item.severity !== 'error') continue
    const key = JSON.stringify(item)
    baseline.set(key, (baseline.get(key) ?? 0) + 1)
  }
  const errors = []
  const warnings = []
  for (const item of issues) {
    if (item.severity !== 'error') {
      warnings.push(item)
      continue
    }
    const key = JSON.stringify(item)
    const previous = baseline.get(key) ?? 0
    if (previous) baseline.set(key, previous - 1)
    if (!previous || changed.has(item.chapter) || changed.has(item.relatedChapter)) errors.push(item)
    else warnings.push({ ...item, severity: 'warning', historical: true })
  }
  if (errors.length) throw new BeatStructureError([...errors, ...warnings])
  return warnings
}
