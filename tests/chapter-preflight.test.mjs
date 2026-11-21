import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

const wrongPrice = '这口炉子值三块下品？'
const compensation = '料钱两块，误期一块，三块下品。'
const correctedLine = '料钱两块，加上误期一块，共索赔三块下品？'

test('章前剧情冲突须经拷问和确认修订，复检通过后方可保存正文', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-chapter-preflight-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const chapter = '0001'
  const outline = path.join(root, 'outline.md')
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({
    chapters: [{ id: chapter, title: '问价', file: 'chapters/0001.md' }],
  }))
  await fs.writeFile(outline, `# 总纲\n\n## 附一\n${wrongPrice}\n`)
  await fs.writeFile(path.join(root, 'beats.md'), `## 0001 问价
### 场景 dispute：索赔
- 时序：10
- 出场：chen
- 冲突：${compensation}
#### 人物 chen
- 目标：索赔
`)

  let selected = []
  let reviewCount = 0
  const tools = new Map()
  const userQuestions = { async ask({ questions }) {
    const [question] = questions
    assert.match(question.question, /炉子值三块下品/u)
    assert.ok(question.question.includes(correctedLine))
    return { answers: [{ id: question.id, selected }] }
  } }
  apply({
    tools: { register: tool => tools.set(tool.name, tool) },
    get: name => name === 'userQuestions' ? userQuestions : undefined,
    effect() {},
    llm: { async *stream({ messages }) {
      reviewCount += 1
      const materials = JSON.parse(messages[0].content[0].text).sources
      const priorOutline = materials.find(item => item.file === 'outline.md').text
      const evidence = [{ file: 'beats.md', quote: compensation }]
      const issues = priorOutline.includes(wrongPrice) ? [{
        kind: 'conflict', detail: '总纲范本把三块索赔写成炉价',
        evidence: [...evidence, { file: 'outline.md', quote: wrongPrice }],
        question: '三块下品应按什么口径？',
        options: [{ label: '索赔', effect: '修订总纲范本' }, { label: '炉价', effect: '改写本章冲突' }],
      }] : []
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify({
        facts: [{ text: compensation, evidence }], issues,
      }) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }, { root })
  const exec = {
    agent: { model: { current: () => ({ provider: 'test', model: 'test' }) }, session: { id: 'test' } },
    callId: 'approval',
  }
  const call = (name, args) => tools.get(name).execute(args, exec)
  const preflight = (action, args = {}) => call('novel_chapter_preflight', { action, chapter, ...args })
  const write = preflightId => call('novel_write', { chapter, content: '陈麻子把料钱和误期损失一笔笔报清。', preflightId })

  await assert.rejects(write(), /章前剧情预检/u)
  const blocked = await preflight('check')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.questions.length, 1)
  assert.equal((await preflight('check')).grillId, blocked.grillId)
  assert.equal(reviewCount, 1)
  const edits = [{ file: 'outline.md', before: wrongPrice, after: correctedLine, reason: '更正本章费用含义', issueIds: ['1'] }]
  await assert.rejects(preflight('preview', { preflightId: blocked.preflightId, edits }), /未获明确回答/u)
  const { baseHash } = await call('novel_grill', { action: 'inspect', id: blocked.grillId })
  await call('novel_grill', {
    action: 'answer', id: blocked.grillId, baseHash, questionId: blocked.questions[0].id,
    disposition: 'decided', selected: ['A'], answer: '按索赔写，改总纲范本。',
  })
  const { planId } = await preflight('preview', { preflightId: blocked.preflightId, edits })
  assert.equal((await preflight('apply', { planId })).status, 'blocked')
  assert.ok((await fs.readFile(outline, 'utf8')).includes(wrongPrice))

  selected = ['确认应用']
  const ready = await preflight('apply', { planId })
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.lastRepair.files, ['outline.md'])
  assert.equal(reviewCount, 2)
  assert.equal((await call('novel_grill', { action: 'list' })).sessions.length, 1)
  const context = await call('novel_context', { chapter })
  assert.equal(context.chapterPreflight.preflightId, ready.preflightId)
  assert.ok(context.prompt.includes(compensation))

  await fs.appendFile(outline, '\n附记更新。\n')
  await assert.rejects(write(ready.preflightId), /stale/u)
  const checked = await preflight('check')
  assert.equal(checked.status, 'ready')
  assert.ok((await write(checked.preflightId)).chars > 0)
})
