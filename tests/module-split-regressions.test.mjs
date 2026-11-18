import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { numberFromToken } from '../lib/text.js'
import { parseSceneCadence } from '../lib/book.js'
import { appearanceIndex, parseCadence } from '../lib/people.js'
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
  await fs.writeFile(path.join(root, 'characters/陆昭.md'), '# 陆昭\n\n- ID：lu-zhao\n- 定位：男主\n- 重要程度：核心\n')
  const chapters = [{ id: '0001', title: '开场', file: 'chapters/0001.md', status: 'draft', targetChars: 0 }]
  const cards = [{ name: '陆昭', file: 'characters/陆昭.md' }]
  const first = await appearanceIndex(root, chapters, cards, 3000)
  const second = await appearanceIndex(root, chapters, cards, 3000)
  assert.equal(first.last.get('陆昭'), '0001')
  assert.equal(first.latestId, '0001')
  assert.equal(second, first)

  // Exercise the registered tools too: both failures originally surfaced here.
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '缓存测试', targetChars: 3000, chapters }))
  await fs.writeFile(path.join(root, 'outline.md'), '每 3 章至少一次爽点')
  await fs.appendFile(path.join(root, 'characters/陆昭.md'), '- 戏份：每 1 章至少出场一次\n')
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
