import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('const LONE_SURROGATE =')
const end = source.indexOf('/** 一次调用作用域里的书根', start)
assert.ok(start > 0 && end > start, '没找到 toLosslessJson 所在的代码段')
const { toLosslessJson } = vm.runInNewContext(
  `${source.slice(start, end)}; ({ toLosslessJson })`,
)

// vm 里取出来的对象与本模块不是同一个 realm，比较前先过一遍 JSON，避免原型不同导致的假失败。
const plain = value => JSON.parse(JSON.stringify(value))
const roundTrips = value => JSON.stringify(plain(value)) === JSON.stringify(value)

test('值为 undefined 的键被丢掉，工具结果仍是无损 JSON', () => {
  const sanitized = toLosslessJson({ ok: true, checkVerdicts: undefined, findings: [] })
  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)), { ok: true, findings: [] })
  assert.ok(!Object.hasOwn(sanitized, 'checkVerdicts'))
  assert.ok(roundTrips(sanitized))
})

test('novel_check 的待审稿分支把六维结论落成 null 而不是 undefined', () => {
  assert.match(source, /checkVerdicts: reviewState\.checkVerdicts \?\? null/)
})

test('非有限数落成 null，布尔与整数原样保留', () => {
  const sanitized = toLosslessJson({ nan: NaN, inf: Infinity, neg: -Infinity, zero: 0, flag: false })
  assert.deepEqual(plain(sanitized), { nan: null, inf: null, neg: null, zero: 0, flag: false })
})

test('数组里的 undefined 落成 null，保持下标对齐', () => {
  assert.deepEqual(toLosslessJson([1, undefined, 3]), [1, null, 3])
})

test('落单代理项被替换，成对的 emoji 不动', () => {
  const broken = 'a\uD800b'
  assert.equal(toLosslessJson(broken), 'a\uFFFDb')
  assert.equal(toLosslessJson('😀'), '😀')
})

test('循环引用落成 null 而不是抛错或无限递归', () => {
  const node = { name: '循环' }
  node.self = node
  const sanitized = toLosslessJson(node)
  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)), { name: '循环', self: null })
})

test('Date 落成 ISO 字符串，无效 Date 落成 null', () => {
  assert.equal(toLosslessJson(new Date('2026-11-18T00:00:00.000Z')), '2026-11-18T00:00:00.000Z')
  assert.equal(toLosslessJson(new Date('nope')), null)
})
