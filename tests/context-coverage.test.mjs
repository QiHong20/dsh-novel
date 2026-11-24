import test from 'node:test'
import assert from 'node:assert/strict'
import { settingDependencies, resolveSettingDependencies, scopedAuthorMaterial, coverageReport } from '../lib/context-coverage.js'

test('显式设定依赖递归补齐，循环不重复，缺失不静默', async () => {
  const docs = { 甲: '- 依赖设定：乙、缺项\n规则甲', 乙: '- 依赖设定：甲\n规则乙' }
  assert.deepEqual(settingDependencies('- 所需设定：甲、乙\n- 依赖设定：甲'), ['甲', '乙'])
  const loaded = await resolveSettingDependencies(['甲'], Object.keys(docs).map(name => ({ name })), async name => docs[name] ?? null)
  assert.deepEqual(loaded.rows.map(r => r.name), ['甲', '乙'])
  assert.deepEqual(loaded.missing, ['依赖设定不存在：缺项'])
})

test('作者秘密及未来小节连同嵌套内容排除，不删除后续同级稳定资料', () => {
  const source = '# 人物\n身份\n## 作者侧秘密\n真相\n### 细节\n秘密细节\n## 外貌\n疤痕\n## 后续计划\n最终牺牲'
  const result = scopedAuthorMaterial(source)
  assert.match(result.text, /身份/u)
  assert.match(result.text, /疤痕/u)
  assert.doesNotMatch(result.text, /真相|秘密细节|最终牺牲/u)
  assert.equal(result.excluded.length, 2)
})

test('覆盖检查不把自由文本、缺少锚点、历史缺口认证为独立完整', () => {
  const result = coverageReport({ stage: { scenes: [{ id: 's', events: [], chapterEvents: ['event'], fields: {} }], warnings: [] }, characters: [{ name: '甲' }], historical: true })
  assert.equal(result.status, 'needs-material-review')
  assert.equal(result.certifiesSemantics, false)
  assert.match(result.missing.join('\n'), /分配到场景/u)
  assert.match(result.missing.join('\n'), /历史位置/u)
  assert.match(result.missing.join('\n'), /自由文本/u)
})
