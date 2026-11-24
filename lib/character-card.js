import { parseStageFields } from './beat-structure.js'

const cardHeader = text => String(text ?? '').split(/^[ \t]{0,3}#{2,6}[ \t]+/mu, 1)[0]
const removeBold = text => text.replace(/\*\*/gu, '')

export function cardIdentity(text) {
  const header = cardHeader(text)
  const fields = parseStageFields(header)
  const roles = removeBold(header).matchAll(/^[ \t]*(?:[-*+][ \t]*)?定位[ \t]*[：:]([^\r\n]*)/gmu)
  let role = ''
  for (const match of roles) role = match[1].trim()
  return { id: fields.ID || '', role, importance: fields.重要程度 || '未设置' }
}

export const ROLE_RANK = { '主角': 1, '男主': 1, '女主': 2, '男二': 3, '女二': 3, '重要配角': 4, '男配': 4, '女配': 4, '反派': 5, '龙套': 6 }

function normalizeCardRole(role) {
  const [name] = role.split(/[\s\p{P}]+/u, 1)
  if (name === '男主角') return '男主'
  if (name === '女主角') return '女主'
  return Object.hasOwn(ROLE_RANK, name) ? name : ''
}

export function parseCardRole(text) {
  return normalizeCardRole(cardIdentity(text).role)
}

export function rankForCardRole(role) {
  return ROLE_RANK[normalizeCardRole(role)] ?? 9
}

export function cardRank(text) {
  return rankForCardRole(cardIdentity(text).role)
}

const metadataField = /^(?:ID|定位|重要程度)[ \t]*[：:]/iu
const summaryField = /^(?:[-*+][ \t]+)?(?:一句话(?:简介)?|简介|身份)[ \t]*[：:][ \t]*(.*)$/u

export function characterSummary(text) {
  const line = String(text ?? '').split(/\r?\n/u)
    .map(item => item.trim())
    .find(item => item && !item.startsWith('#'))
  if (!line) return ''
  let summary = removeBold(line).replace(/^[-*+]\s*/u, '').trim()
  if (metadataField.test(summary)) {
    const introduction = removeBold(cardHeader(text)).split(/\r?\n/u).map(item => item.trim())
    const prose = introduction.find(item => item && !/^[#>*+-]/u.test(item) && !metadataField.test(item) && !summaryField.test(item))
    const field = introduction.map(item => item.match(summaryField)?.[1].trim()).find(Boolean)
    summary = prose || field || ''
  }
  return Array.from(summary).slice(0, 60).join('')
}
