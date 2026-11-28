import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const scene = (id, goal, order) => `### 场景 ${id}：${goal}\n- 时序：${order}\n- 出场：a\n\n#### 人物 a\n- 目标：${goal}\n`

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-beats-delete-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const tools = new Map()
  apply({ tools: { register: definition => tools.set(definition.name, definition) }, effect() {} }, { root })
  const book = {
    version: 1,
    title: '删纲测试',
    targetChars: 3000,
    chapters: [
      { id: '0001', title: '第一章 试笔', file: 'chapters/0001.md', status: 'planned' },
      { id: '0002', title: '第二章 试账', file: 'chapters/0002.md', status: 'planned' },
    ],
  }
  await fs.mkdir(path.join(root, 'chapters'), { recursive: true })
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify(book, null, 2), 'utf8')
  const beats = [
    '# 章纲',
    '',
    '## 0001 第一章 试笔',
    '',
    scene('s0001-a', '进门', 1),
    scene('s0001-b', '拿到账本', 2),
    '## 0002 第二章 试账',
    '',
    scene('s0002-a', '对账', 3),
    scene('s0002-b', '翻脸', 4),
  ].join('\n')
  await fs.writeFile(path.join(root, 'beats.md'), beats, 'utf8')
  const tool = name => {
    const found = tools.get(name)
    assert.ok(found, `没有注册工具 ${name}`)
    return found
  }
  return {
    root,
    tool,
    call: (name, args) => tool(name).execute(args),
    render: (name, args, value) => tool(name).output.render(args, value).map(part => part.text).join('\n'),
    beatsText: () => fs.readFile(path.join(root, 'beats.md'), 'utf8'),
  }
}

const exists = file => fs.access(file).then(() => true).catch(() => false)

test('novel_beats delete 只删这一节，别的章原样保留', async t => {
  const { root, call, render, beatsText } = await fixture(t)

  const deleted = await call('novel_beats', { chapter: '0001', delete: true })
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.written, false)
  assert.equal(deleted.chapter.id, '0001')
  assert.ok(deleted.removed.chars > 0, '应报告被删小节字数')
  assert.ok(deleted.backup, '应返回备份路径')
  assert.equal(await exists(path.join(root, deleted.backup)), true)

  const after = await beatsText()
  assert.doesNotMatch(after, /## 0001/u)
  assert.match(after, /## 0002 第二章 试账/u)
  assert.match(after, /### 场景 s0002-b：翻脸/u)

  const text = render('novel_beats', { chapter: '0001', delete: true }, deleted)
  assert.match(text, /删掉了整节/u)
  assert.match(text, /旧文件备份/u)

  const gone = await call('novel_beats', { chapter: '0001', delete: true })
  assert.match(gone.error, /没有可删的内容/u, '删过的章再删要报错而不是静默成功')

  await assert.rejects(
    call('novel_beats', { chapter: '0001', delete: true, dropScenes: ['s0001-a'] }),
    /只能给一个/u,
  )
})

test('novel_beats dropScenes 只删指定场景，其余场与人物块保留', async t => {
  const { root, call, render, beatsText } = await fixture(t)

  const dropped = await call('novel_beats', { chapter: '0001', dropScenes: ['s0001-a'] })
  assert.equal(dropped.deleted, true)
  assert.deepEqual(dropped.dropped, ['s0001-a'])
  assert.ok(await exists(path.join(root, dropped.backup)))

  const after = await beatsText()
  assert.doesNotMatch(after, /s0001-a/u)
  assert.match(after, /### 场景 s0001-b：拿到账本/u)
  assert.match(after, /#### 人物 a/u, '被删场景之外的人物块要留着')
  assert.match(after, /## 0002 第二章 试账/u)

  assert.match(render('novel_beats', { chapter: '0001', dropScenes: ['s0001-a'] }, dropped), /删掉了 1 场/u)
  const wrongChapter = await call('novel_beats', { chapter: '0002', dropScenes: ['s0001-a'] })
  assert.match(wrongChapter.error, /这些场景不在这章里/u)
})
