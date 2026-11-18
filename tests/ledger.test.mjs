import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LEDGER_FILE,
  LEDGER_CATEGORIES,
  parseLedger,
  loadLedger,
  writeLedger,
  validateLedgerPatch,
} from '../lib/library.js'

test('parseLedger parses active and inactive rows and pads chapter ids', () => {
  const md = [
    '# 状态台账',
    '',
    '| 类别 | 项目 | 当前状态 | 变更章 | 备注 |',
    '| --- | --- | --- | --- | --- |',
    '| 资产 | 陆昭灵石 | 3 枚下品灵石 | 1 | 贴身内袋 |',
    '| 道具 | 破阵楔 | 已消耗（嵌在废炉阵眼） | 0002 | 不可回收 |',
    '| 作废 | 旧草图 | 撕毁 | 3 | |',
  ].join('\n')

  const rows = parseLedger(md)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    category: '资产',
    item: '陆昭灵石',
    state: '3 枚下品灵石',
    chapter: '0001',
    note: '贴身内袋',
    active: true,
  })
  assert.equal(rows[1].active, false)
  assert.equal(rows[2].active, false)
})

test('writeLedger creates, updates, and deletes entries atomically', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-novel-ledger-'))
  try {
    const empty = await loadLedger(dir)
    assert.equal(empty.present, false)
    assert.deepEqual(empty.rows, [])

    const first = await writeLedger(dir, {
      category: '境界',
      item: '陆昭修为',
      state: '炼气二层',
      chapter: '1',
      note: '五相废灵根',
    })
    assert.equal(first.replaced, false)
    assert.equal(first.deleted, false)
    assert.equal(first.row.chapter, '0001')
    assert.equal(first.row.active, true)

    const updated = await writeLedger(dir, {
      item: '陆昭修为',
      state: '炼气三层',
      chapter: '0005',
    })
    assert.equal(updated.replaced, true)
    assert.equal(updated.row.category, '境界')
    assert.equal(updated.row.state, '炼气三层')
    assert.equal(updated.row.note, '五相废灵根')

    await writeLedger(dir, {
      category: '道具',
      item: '稳相胆',
      state: '已消耗（并入丹田外侧）',
      chapter: '0006',
    })

    const loaded = await loadLedger(dir)
    assert.equal(loaded.present, true)
    assert.equal(loaded.rows.length, 2)
    assert.equal(loaded.rows.filter(r => r.active).length, 1)

    const removed = await writeLedger(dir, { item: '稳相胆', delete: true })
    assert.equal(removed.deleted, true)
    assert.equal(removed.row, null)
    assert.equal(removed.rows.length, 1)

    const raw = await fsp.readFile(path.join(dir, LEDGER_FILE), 'utf8')
    assert.match(raw, /炼气三层/)
    await assert.rejects(() => writeLedger(dir, { item: '   ', state: 'x' }))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('validateLedgerPatch warns on bad chapter id or unknown category', () => {
  assert.deepEqual(
    validateLedgerPatch({ category: LEDGER_CATEGORIES[0], chapter: '0003' }),
    [],
  )
  const warnings = validateLedgerPatch({ category: '未知分类', chapter: '第3章' })
  assert.equal(warnings.length, 2)
})
