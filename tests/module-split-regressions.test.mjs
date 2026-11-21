import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { numberFromToken } from '../lib/text.js'
import { parseSceneCadence } from '../lib/book.js'
import { appearanceIndex, appearanceReport, parseCadence } from '../lib/people.js'
import { apply } from '../index.js'

test('数字规格在拆分后的模块中可供爽点和戏份解析共用', () => {
  assert.equal(numberFromToken('十二'), 12)
  assert.equal(numberFromToken('3'), 3)
  assert.equal(parseSceneCadence('每 3 章至少一次爽点'), 3)
  assert.equal(parseSceneCadence('三章一爽点'), 3)
  assert.equal(parseCadence('- 戏份：每 12 章至少出场一次'), 12)
})

test('人物出场索引的缓存归 people 模块所有并可正常读取正文', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-appearance-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.mkdir(path.join(root, 'characters'))
  await fs.writeFile(path.join(root, 'chapters/0001.md'), '陆昭走进炉坑。')
  await fs.writeFile(path.join(root, 'characters/陆昭.md'), '# 陆昭\n\n- ID：lu-zhao\n- 定位：男主\n- 重要程度：核心\n- 戏份：每 1 章至少出场一次\n')
  await fs.writeFile(path.join(root, 'beats.md'), '## 0001 开场\n\n### 场景 furnace：入场\n- 时序：10\n- 出场：lu-zhao\n#### 人物 lu-zhao\n- 目标：查看炉坑\n')
  const chapters = [{ id: '0001', title: '开场', file: 'chapters/0001.md', status: 'draft', targetChars: 0 }]
  const cards = [{ name: '陆昭', file: 'characters/陆昭.md', id: 'lu-zhao', cadence: 1, states: [] }]
  const first = await appearanceIndex(root, chapters, cards)
  const second = await appearanceIndex(root, chapters, cards)
  // 章纲 cast 只是计划；没有正文侧确认记录时不能清零欠场。
  assert.equal(appearanceReport(first, cards, '0001').陆昭.last, '')
  assert.equal(appearanceReport(first, cards, '0001').陆昭.plannedLast, '0001')
  assert.equal(first.latestId, '0001')
  assert.equal(second, first)

  // Exercise the registered tools too: both failures originally surfaced here.
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '缓存测试', targetChars: 3000, chapters }))
  await fs.writeFile(path.join(root, 'outline.md'), '每 3 章至少一次爽点')
  const tools = new Map()
  apply({ tools: { register: definition => tools.set(definition.name, definition) }, effect() {} }, { root })
  const call = (name, args) => tools.get(name).execute(args)
  const status = await call('novel_status', {})
  assert.equal(status.rhythm.gapLimit, 3)
  const audit = await call('novel_audit', {})
  assert.ok(Array.isArray(audit.issues))
  const check = await call('novel_check', { chapter: '0001' })
  assert.ok(Array.isArray(check.issues))
})
