import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('function parseStyleRestrictions(')
const end = source.indexOf('// ---- 伏笔表', start)
const { parse, matches } = vm.runInNewContext(`${source.slice(start, end)}; ({ parse: parseStyleRestrictions, matches: styleRestrictionMatches })`)

test('旧模板多词、长行、整句及重复词均可解析', () => {
  const result = parse('## 禁忌\r\n- 词：氤氲 / 缱绻 / 心中暗道 / 心头一紧 / 弥漫着 / 洋溢着 / 令人窒息\r\n- 整句（模板腔）：他拿起笔。 / 三分钟。\r\n- 氤氲')
  assert.equal(result.banned.length, 9)
  assert.ok(result.banned.includes('心头一紧'))
  assert.ok(result.banned.includes('他拿起笔。'))
  assert.equal(result.warnings.length, 2)
})

test('整句保留标点，语义规则与少用词不进入禁止清单', () => {
  const result = parse('## 禁忌\n- 整句：甲、乙走了。\n- 不要替人物解释情绪\n## 少用词\n- 不由得\n## 语义禁忌\n- 不得越过限知视角\n## 锚点原文\n- 氤氲')
  assert.deepEqual(Array.from(result.banned), ['甲、乙走了。'])
  assert.deepEqual(Array.from(result.limited), ['不由得'])
  assert.equal(result.semantic.length, 2)
})

test('命中保留每次出现的位置，Unicode 列号与 CRLF 正确', () => {
  const result = matches('😀氤氲，氤氲。\r\n无关\r\n他拿起笔。', ['氤氲', '他拿起笔。'])
  assert.equal(result.length, 3)
  assert.match(result[0], /第 1 行第 2 列/)
  assert.match(result[1], /第 1 行第 5 列/)
  assert.match(result[2], /第 3 行第 1 列/)
})

test('实际模板说明不成为禁用词', () => {
  const card = readFileSync(new URL('../templates/style-card.md', import.meta.url), 'utf8')
  const result = parse(card)
  assert.equal(result.banned.length, 4)
  assert.equal(result.limited.length, 1)
  assert.equal(result.semantic.length, 2)
  assert.equal(result.warnings.length, 0)
})
