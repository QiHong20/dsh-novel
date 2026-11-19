import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-ledger-tool-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const tools = new Map()
  apply({ tools: { register: definition => tools.set(definition.name, definition) }, effect() {} }, { root })
  const tool = name => {
    const found = tools.get(name)
    assert.ok(found, `没有注册工具 ${name}`)
    return found
  }
  const call = (name, args) => tool(name).execute(args)
  const render = (name, args, value) => tool(name).output.render(args, value).map(part => part.text).join('\n')
  return { root, call, render }
}

/**
 * output.schema 把 row 声明成 object：删除条目后那一行已经不在台账里，
 * 若把 writeLedger 的 row: null 原样交出去，运行时会判成
 * 「tool "novel_ledger" returned invalid output: "value.row" must be an object」。
 * 所以这里按 schema 的约束卡住：row 要么是对象，要么整个字段不出现。
 */
const rowIsSchemaSafe = value => !('row' in value) || (typeof value.row === 'object' && value.row !== null && !Array.isArray(value.row))

test('删除台账条目时不再把 row: null 交给 output.schema', async t => {
  const { root, call } = await fixture(t)

  const created = await call('novel_ledger', {
    item: '稳相胆',
    category: '道具',
    state: '帆布裹好，贴身内衬袋',
    chapter: '0002',
    note: '白青囊给的',
  })
  assert.equal(created.mode, 'write')
  assert.equal(created.deleted, false)
  assert.equal(created.replaced, false)
  assert.equal(created.row.item, '稳相胆')

  const orphan = await call('novel_ledger', { item: '稳相胆', delete: true })
  assert.equal(orphan.deleted, true)
  assert.ok(rowIsSchemaSafe(orphan), 'row 必须是对象或缺省，不能是 null')
  assert.equal(orphan.row, undefined)
  assert.equal(orphan.rows.filter(row => row.item === '稳相胆').length, 0)

  const ledger = await fs.readFile(path.join(root, 'ledger.md'), 'utf8')
  assert.ok(!ledger.includes('稳相胆'), '台账文件里不该再留着这一行')
})

test('删不存在的条目时如实说没有可删的，而不是报成已登记', async t => {
  const { call, render } = await fixture(t)
  const args = { item: '从来没登记过的东西', delete: true }

  const value = await call('novel_ledger', args)
  assert.equal(value.mode, 'write')
  assert.equal(value.deleted, false)
  assert.ok(rowIsSchemaSafe(value))

  const text = render('novel_ledger', args, value)
  assert.match(text, /没有「从来没登记过的东西」/)
  assert.match(text, /没有可删的条目/)
  assert.doesNotMatch(text, /已登记台账条目/)
})

test('登记与更新的返回仍然带 row，且行内容读得出来', async t => {
  const { call, render } = await fixture(t)
  const args = { item: '陆昭现金', category: '资产', state: '20 文铜钱', chapter: '0001' }

  const created = await call('novel_ledger', args)
  assert.equal(created.replaced, false)
  assert.equal(created.row.state, '20 文铜钱')
  assert.match(render('novel_ledger', args, created), /已登记台账条目：- \[资产\] 陆昭现金：20 文铜钱（@0001）/u)

  const updated = await call('novel_ledger', { ...args, state: '17 文铜钱（买了伤药）' })
  assert.equal(updated.replaced, true)
  assert.equal(updated.row.state, '17 文铜钱（买了伤药）')
  assert.equal(updated.rows.filter(row => row.item === '陆昭现金').length, 1, '更新不能写出重复行')
  assert.match(render('novel_ledger', { ...args, state: 'x' }, updated), /已更新台账条目/u)
})

test('伏笔工具走同一条守卫：有行才带 row 字段', async t => {
  const { call } = await fixture(t)
  const written = await call('novel_threads', {
    thread: '废料堆里会心跳的阵盘残片',
    planted: '0001',
    payoff: '0023',
  })
  assert.equal(written.mode, 'write')
  assert.ok(rowIsSchemaSafe(written))
  assert.equal(written.row.thread, '废料堆里会心跳的阵盘残片')
})
