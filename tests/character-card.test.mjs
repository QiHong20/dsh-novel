import assert from 'node:assert/strict'
import test from 'node:test'
import { cardRank, characterSummary, parseCardRole } from '../lib/people.js'
import { cardIdentity } from '../stage.js'

test('人物摘要跳过顶部元数据并去掉简介中的加粗标记', () => {
  const metadata = '# 陆昭\n- **ID**：hero\n- 定位：主角\n- 重要程度：核心\n'
  assert.equal(characterSummary(metadata + '\n**能听懂炉火**的学徒。'), '能听懂炉火的学徒。')
  assert.equal(characterSummary(metadata + '- **一句话简介**：能听懂**炉火**。'), '能听懂炉火。')
  assert.equal(characterSummary(metadata + '- **身份**: **炼器铺**学徒。'), '炼器铺学徒。')
  assert.equal(characterSummary(metadata + '简介：**炼器铺**学徒。'), '炼器铺学徒。')
  assert.equal(characterSummary('# 陆昭\n**炼器铺**学徒。'), '炼器铺学徒。')
})

test('人物摘要在没有简介时留空，并按字符截断', () => {
  assert.equal(characterSummary(''), '')
  assert.equal(characterSummary('# 陆昭\n- ID：hero\n- 定位：主角\n- 简介：\n## 作者侧秘密\n隐藏身份'), '')
  const description = '炉'.repeat(59) + '𠮷'
  assert.equal(characterSummary(`# 陆昭\n- ID：hero\n- 身份：**${description}**学徒`), description)
})

test('人物卡保留显示用定位描述，并用统一的主定位计算排序', () => {
  const roles = [
    ['- 定位：主角（视角人物）', '主角（视角人物）', '主角', 1],
    ['  * 定位: 男主，前期藏拙', '男主，前期藏拙', '男主', 1],
    ['+ 定位：男主角', '男主角', '男主', 1],
    ['- **定位**：女主角 (群像)', '女主角 (群像)', '女主', 2],
    ['- 定位：反派 暂时合作', '反派 暂时合作', '反派', 5],
    ['- 定位：双面间谍', '双面间谍', '', 9],
  ]
  for (const [field, label, role, rank] of roles) {
    const card = `# 陆昭\r\n- ID：hero\r\n- 重要程度：核心\r\n${field}\r\n## 关系\r\n- 定位：龙套`
    assert.deepEqual(cardIdentity(card), { id: 'hero', role: label, importance: '核心' })
    assert.equal(parseCardRole(card), role)
    assert.equal(cardRank(card), rank)
  }
})

test('人物定位只取卡片头部，忽略后续小节中的同名字段', () => {
  const card = '# 陆昭\n- ID：hero\n  ## 作者侧秘密\n- 定位：反派'
  assert.equal(cardIdentity(card).role, '')
  assert.equal(parseCardRole(card), '')
  assert.equal(cardRank(card), 9)
})
