import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

// 测试纯装配函数，无需启动 DSH 或改变生产模块导出。
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('function assembleStylePrompt(')
const end = source.indexOf('// 视角只能', start)
const assemble = vm.runInNewContext(`${source.slice(start, end)}; assembleStylePrompt`)
const card = `# 文风卡：测试
- 视角与时态：第三人称限知，不得读取旁人的思想
## 对话
- 第一条
- 第二条
- 第三条：避免解释台词
- 正例：他说：“走吧。”
## 反例
- “他很悲伤。”不要直接总结
## 锚点原文
### 锚点 1
> “走。”
> 他站起来，推开门。
### 锚点 2
> 她没有回答。
## 禁忌
- 氤氲`

test('保留顶部视角、第三条规则、正反例和全部锚点', () => {
  const result = assemble(card.replaceAll('\n', '\r\n'), 2000)
  for (const text of ['第三人称限知', '第三条', '他说', '不要直接总结', '推开门', '她没有回答']) {
    assert.ok(result.text.includes(text), text)
  }
  assert.equal(result.omitted.length, 0)
})

test('后置必选规则优先，省略条目有原因，锚点不截断', () => {
  const result = assemble(`${card}\n## 其他\n- [必选] 不得改变人称`, 95)
  assert.ok(result.text.includes('第三人称限知'))
  assert.ok(result.text.includes('不得改变人称'))
  assert.ok(result.omitted.length > 0)
  assert.ok(result.omitted.every(item => item.reason))
  assert.ok(Array.from(result.text).length <= 95)
  if (result.text.includes('锚点 1')) assert.ok(result.text.includes('推开门。'))
})

test('极小预算不截断要求，旧卡及空卡可用', () => {
  const tiny = assemble(card, 1)
  assert.equal(tiny.text, '')
  assert.ok(tiny.omitted.length > 0)
  assert.equal(assemble('', 100).included.length, 0)
  assert.ok(assemble('只使用第一人称。', 100).text.includes('只使用第一人称'))
  const anchor = '## 锚点原文\n> 短句。\n> 第二句。'
  assert.equal(assemble(anchor, 100).text, anchor)
})
