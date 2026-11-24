import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-no-preflight-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const tools = new Map()
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect() {}, llm: { stream() { throw new Error('不应自动调用模型') } } }, { root })
  const exec = { agent: { session: { id: 'test' } } }
  return { root, tools, call: (name, args) => tools.get(name).execute(args, exec) }
}

test('不再注册章前预检；AI 新建、续写和扩写不需要预检编号', async t => {
  const { root, tools, call } = await fixture(t)
  assert.equal(tools.has('novel_chapter_preflight'), false)
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '测试', chapters: [] }))
  await call('novel_write', { chapter: '0001', title: '第一章', content: '他推开门，走进院子。' })
  await call('novel_write', { chapter: '0001', mode: 'append', content: '\n\n院子里的树倒了。他绕过树干，找到新的线索。' })
  await call('novel_write', { chapter: '0001', content: '他推开门。\n\n院子里的人递来信件。\n\n他读完后决定出发。', preflightId: 'obsolete' })
  const text = await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8')
  assert.match(text, /决定出发/u)
  await assert.rejects(call('novel_write', { chapter: '0001', content: text, status: 'final' }), /审稿|复核/u)
})

test('旧预检状态不参与新章标题和装配，模型上下文没有起稿门槛', async t => {
  const { root, call } = await fixture(t)
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '测试', chapters: [] }))
  const pack = await call('novel_context', { chapter: '0001', title: '新的标题' })
  assert.equal(pack.chapter.title, '新的标题')
  assert.equal(pack.chapterPreflight, undefined)
  assert.ok(!pack.prompt.includes('novel_chapter_preflight'))
  await call('novel_write', { title: '新的标题', content: '雨停了，他出门。' })
  const book = JSON.parse(await fs.readFile(path.join(root, 'book.json'), 'utf8'))
  assert.equal(book.chapters[0].title, '新的标题')
})
