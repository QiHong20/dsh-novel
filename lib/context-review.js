import path from 'node:path'
import { createHash } from 'node:crypto'
import { readJson, writeJson } from './book.js'
import { withFileLock } from './file-lock.js'

const digest = value => createHash('sha256').update(value).digest('hex')
export const CONTEXT_REVIEW_CHECKS = ['dependencies', 'timeline', 'knowledge', 'revelation', 'continuity']
const file = (root, packHash) => path.join(root, '.novel/context-reviews', `${packHash}.json`)

/** Only a free-text temporal review gap can be resolved by a semantic attestation. */
export function contextBlockers(pack) {
  return (pack.missingMaterials || []).filter(item => item !== '人物卡／设定为自由文本：未标注段落的生效及揭示边界尚未核实')
}

export function validateContextReview(pack, checks) {
  if (!pack.full || !pack.ready || !pack.packHash || digest(pack.prompt) !== pack.packHash) throw new Error('只能核对当前可用的完整包')
  if (contextBlockers(pack).length) throw new Error(`存在未解决的资料缺项：${contextBlockers(pack).join('；')}`)
  for (const key of CONTEXT_REVIEW_CHECKS) {
    const check = checks?.[key]
    if (!check || !['supported', 'conflict', 'uncertain'].includes(check.verdict) ||
      ['detail', 'counterargument'].some(k => typeof check[k] !== 'string' || !check[k].trim()) ||
      !Array.isArray(check.quotes) || !check.quotes.length || check.quotes.some(q => typeof q !== 'string' || !q.trim() || !pack.prompt.includes(q))) {
      throw new Error(`${key} 必须提交结论、解释、反证及包内逐字 quotes`)
    }
  }
  return CONTEXT_REVIEW_CHECKS.every(key => checks[key].verdict === 'supported')
}

export async function recordContextReview(root, pack, args) {
  if (args.packHash !== pack.packHash) throw new Error('装配包已变化，请重新取包再核对')
  const supported = validateContextReview(pack, args.checks)
  const record = { version: 1, packHash: pack.packHash, chapter: pack.chapter.id, scene: pack.scene?.id || '',
    status: supported ? 'reviewed' : 'blocked', checks: args.checks, reviewedAt: new Date().toISOString(),
    certifiesSemantics: false, prompt: pack.prompt }
  await withFileLock(file(root, pack.packHash), () => writeJson(file(root, pack.packHash), record))
  return { ...record, prompt: undefined, selfContained: false, semanticSupported: supported, meaning: '当前完整包的语义核对已登记，材料覆盖和边界覆盖须分别检查；工具不认证语义正确。' }
}

export async function contextReviewStatus(root, pack) {
  if (!pack.full || !pack.ready || !pack.packHash) return { status: 'unreviewed', selfContained: false }
  const record = await readJson(file(root, pack.packHash))
  if (!record) return { status: 'unreviewed', selfContained: false }
  try {
    if (record.version !== 1 || record.packHash !== pack.packHash || record.prompt !== pack.prompt) throw new Error('版本不同')
    const supported = validateContextReview(pack, record.checks)
    return { status: supported ? 'reviewed' : 'blocked', selfContained: false, semanticSupported: supported, reviewedAt: record.reviewedAt,
      certifiesSemantics: false, checks: record.checks }
  } catch { return { status: 'stale', selfContained: false } }
}
