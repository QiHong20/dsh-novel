import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { apply } from '../index.js'
import { moveScene, stageContext } from '../stage.js'
import { BEAT_SECTION_AMBIGUOUS, BEAT_SECTION_CHANGED, readBeats, writeBeats, writeBeatsBatch } from '../lib/beats.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-remediation-step1-'))
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

async function exists(file) {
  return fs.access(file).then(() => true).catch(() => false)
}

async function writeSource(root, name, content) {
  const file = path.join(root, name)
  await fs.writeFile(file, content, 'utf8')
  return file
}

test('原文先试读再首次导入，试读不写盘且 patch 不能新建章节', async t => {
  const { root, call, render } = await fixture(t)
  const source = await writeSource(root, 'source.txt', '第一章 旧客\n旧稿甲。\n第二章 归途\n旧稿乙。\n')

  const preview = await call('novel_import', { source, dryRun: true })
  assert.equal(preview.mode, 'dry-run')
  assert.equal(preview.chapters.length, 2)
  assert.equal(await exists(path.join(root, 'book.json')), false)
  assert.equal(await exists(path.join(root, 'chapters')), false)
  assert.match(render('novel_import', { source, dryRun: true }, preview), /默认不传 replace/u)

  const imported = await call('novel_import', { source, dryRun: false })
  assert.equal(imported.mode, 'import')
  assert.equal(imported.imported, 2)
  const book = JSON.parse(await fs.readFile(path.join(root, 'book.json'), 'utf8'))
  assert.deepEqual(book.chapters.map(chapter => chapter.id), ['0001', '0002'])
  assert.equal(await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8'), '旧稿甲。\n')
  assert.equal(await fs.readFile(path.join(root, 'chapters/.history/0001.last.md'), 'utf8'), '旧稿甲。\n')

  await assert.rejects(
    call('novel_write', { mode: 'patch', patches: [] }),
    /局部改写必须指定已有章节/u,
  )
})

test('默认导入保留已有章，混合批次仍可导入新章', async t => {
  const { root, call, render } = await fixture(t)
  const initial = await writeSource(root, 'initial.txt', '第一章 旧客\n原有正文。\n第二章 归途\n归途正文。\n')
  await call('novel_import', { source: initial })

  const mixed = await writeSource(root, 'mixed.txt', '第1章 旧客\n不应覆盖。\n第三章 新客\n新增正文。\n')
  const result = await call('novel_import', { source: mixed })
  assert.equal(result.imported, 1)
  assert.deepEqual(result.skipped, ['第1章 旧客'])
  assert.equal(await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8'), '原有正文。\n')
  assert.equal(await fs.readFile(path.join(root, 'chapters/0003.md'), 'utf8'), '新增正文。\n')
  assert.match(render('novel_import', { source: mixed }, result), /保留并跳过/u)
  assert.match(render('novel_import', { source: mixed }, result), /未启用覆盖/u)

  const skippedAgain = await call('novel_import', { source: mixed, replace: false })
  assert.equal(skippedAgain.imported, 0)
  assert.equal(skippedAgain.skipped.length, 2)
})

test('显式覆盖保持章节 ID，并在正文变化时先保存历史', async t => {
  const { root, call, render } = await fixture(t)
  const source = await writeSource(root, 'replace.txt', '第一章 旧客\n覆盖前正文。\n第二章 归途\n归途正文。\n')
  await call('novel_import', { source })
  await fs.writeFile(source, '第一章 旧客\n覆盖后正文。\n第二章 归途\n归途正文。\n', 'utf8')

  const replaced = await call('novel_import', { source, replace: true })
  assert.equal(replaced.imported, 2)
  assert.equal(await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8'), '覆盖后正文。\n')
  assert.equal(await fs.readFile(path.join(root, 'chapters/.history/0001.last.md'), 'utf8'), '覆盖后正文。\n')
  const historyDir = path.join(root, 'chapters/.history')
  const historyFiles = await fs.readdir(historyDir)
  const metadataFile = historyFiles.find(file => /^0001-.*\.json$/u.test(file))
  assert.ok(metadataFile, '覆盖前正文必须生成历史元数据')
  const metadata = JSON.parse(await fs.readFile(path.join(historyDir, metadataFile), 'utf8'))
  assert.equal(metadata.source, 'import:replace')
  const historyText = await fs.readFile(path.join(historyDir, metadataFile.replace(/\.json$/u, '.md')), 'utf8')
  assert.equal(historyText, '覆盖前正文。\n')
  assert.match(render('novel_import', { source, replace: true }, replaced), /显式启用 replace: true/u)

  const before = (await fs.readdir(historyDir)).filter(file => /^0001-.*\.json$/u.test(file)).length
  await call('novel_import', { source, replace: true })
  const after = (await fs.readdir(historyDir)).filter(file => /^0001-.*\.json$/u.test(file)).length
  assert.equal(after, before, '相同正文不能重复生成历史')
})

test('章纲始终优先匹配目标 ID，不让前置相似标题抢占', async t => {
  const { root } = await fixture(t)
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, '# 章纲\n\n## 0002 旧客归来\n内容 A\n\n## 0003 旧客\n内容 B\n', 'utf8')
  const chapter = { id: '0003', title: '旧客' }

  const before = await readBeats(root, chapter)
  assert.equal(before.section.body, '内容 B')
  await writeBeats(root, chapter, '更新后的内容 B')
  const updated = await fs.readFile(file, 'utf8')
  assert.match(updated, /## 0002 旧客归来\n内容 A/u)
  assert.match(updated, /## 0003 旧客\n\n更新后的内容 B/u)
  assert.equal((updated.match(/^## 0003 旧客$/gmu) ?? []).length, 1)
})

test('其他 ID 不参与标题回退，目标不存在时追加新小节', async t => {
  const { root } = await fixture(t)
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, '# 章纲\n\n## 0002 旧客归来\n原内容\n', 'utf8')
  const chapter = { id: '0003', title: '旧客' }

  const before = await readBeats(root, chapter)
  assert.equal(before.section, null)
  assert.equal(before.matchIssue, null)
  await writeBeats(root, chapter, '新内容')
  const updated = await fs.readFile(file, 'utf8')
  assert.match(updated, /## 0002 旧客归来\n原内容/u)
  assert.match(updated, /## 0003 旧客\n\n新内容/u)
})

test('唯一无 ID 旧标题可读写，并升级为规范 ID 标题', async t => {
  const { root } = await fixture(t)
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, '# 章纲\n\n## 旧客\n旧格式内容\n', 'utf8')
  const chapter = { id: '0003', title: '旧客' }

  const before = await readBeats(root, chapter)
  assert.equal(before.section.body, '旧格式内容')
  assert.equal(before.matchIssue, null)
  await writeBeats(root, chapter, '规范后的内容')
  const updated = await fs.readFile(file, 'utf8')
  assert.doesNotMatch(updated, /^## 旧客$/mu)
  assert.match(updated, /## 0003 旧客\n\n规范后的内容/u)

  await fs.writeFile(file, '# 章纲\n\n## 3 旧客\n短 ID 内容\n', 'utf8')
  assert.equal((await readBeats(root, chapter)).section.body, '短 ID 内容')
})

test('重复 ID 或重复旧标题只返回诊断，写入在落盘前拒绝', async t => {
  const { root, call, render } = await fixture(t)
  const file = path.join(root, 'beats.md')
  const chapter = { id: '0003', title: '旧客' }
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '匹配测试', chapters: [{ ...chapter, file: 'chapters/0003.md', status: 'planned' }] }), 'utf8')

  for (const content of [
    '# 章纲\n\n## 0003 旧客\n内容 A\n\n## 3 旧客副本\n内容 B\n',
    '# 章纲\n\n## 旧客\n内容 A\n\n## 旧客\n内容 B\n',
  ]) {
    await fs.writeFile(file, content, 'utf8')
    const board = await readBeats(root, chapter)
    assert.equal(board.section, null)
    assert.equal(board.matchIssue.code, BEAT_SECTION_AMBIGUOUS)
    await assert.rejects(
      writeBeats(root, chapter, '不得写入'),
      error => error?.code === BEAT_SECTION_AMBIGUOUS && /请核对/u.test(error.message),
    )
    assert.equal(await fs.readFile(file, 'utf8'), content)

    const value = await call('novel_beats', { chapter: '0003' })
    assert.equal(value.beats, undefined)
    assert.ok(value.warnings.some(warning => /请核对/u.test(warning)))
    assert.match(render('novel_beats', { chapter: '0003' }, value), /章纲目标存在歧义/u)
  }
})

test('全空导入仍登记 planned 章节，默认重复导入不改书目', async t => {
  const { root, call, render } = await fixture(t)
  const source = await writeSource(root, 'empty.txt', '第一章 空章\n第二章 空章\n')
  const imported = await call('novel_import', { source })
  assert.equal(imported.imported, 0)
  assert.equal(imported.empty.length, 2)
  const file = path.join(root, 'book.json')
  const saved = await fs.readFile(file, 'utf8')
  const chapters = JSON.parse(saved).chapters
  assert.equal(chapters.length, 2)
  assert.ok(chapters.every(chapter => chapter.status === 'planned' && chapter.note === '原文为空'))
  assert.match(render('novel_import', { source }, imported), /已建成 planned/u)
  assert.equal(await exists(path.join(root, 'chapters/0001.md')), false)
  await call('novel_import', { source })
  assert.equal(await fs.readFile(file, 'utf8'), saved)
})

test('无 ID 旧小节只能由书内唯一未匹配同名章节认领', async t => {
  const { root, call } = await fixture(t)
  const chapters = ['0002', '0003'].map(id => ({ id, title: '旧客', file: `chapters/${id}.md`, status: 'planned' }))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ chapters }), 'utf8')
  const file = path.join(root, 'beats.md')
  const original = '# 章纲\n\n## 旧客\n不能确定归属的内容\n'
  await fs.writeFile(file, original, 'utf8')
  for (const chapter of chapters) {
    const board = await readBeats(root, chapter, chapters)
    assert.equal(board.section, null)
    assert.equal(board.matchIssue.reason, 'shared-legacy-title')
    await assert.rejects(writeBeats(root, chapter, '不得认领', chapters), error => error?.code === BEAT_SECTION_AMBIGUOUS)
    const value = await call('novel_beats', { chapter: chapter.id })
    assert.ok(value.warnings.some(text => /不能唯一归属/u.test(text)))
    assert.equal(await fs.readFile(file, 'utf8'), original)
  }
  await fs.writeFile(file, '# 章纲\n\n## 0002 旧客\n明确的内容\n\n## 旧客\n剩余旧小节\n', 'utf8')
  assert.equal((await readBeats(root, chapters[1], chapters)).section.body, '剩余旧小节')
})

test('章纲顺延先核对两端，目标歧义时源章纲逐字不变', async t => {
  const { root, call } = await fixture(t)
  const chapters = ['0001', '0002'].map(id => ({ id, title: id === '0001' ? '源章' : '目标章', file: `chapters/${id}.md`, status: 'draft' }))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ chapters }), 'utf8')
  const file = path.join(root, 'beats.md')
  const original = '# 章纲\n\n## 0001 源章\n- 场景：甲在石桥前等人，拿出「铜钥匙」\n\n## 0002 目标章\n内容 A\n\n## 2 目标章副本\n内容 B\n'
  await fs.writeFile(file, original, 'utf8')
  const written = await call('novel_write', { chapter: '0001', content: '甲走出城门。', carryOver: true })
  assert.ok(written.warnings.some(text => /未顺延|源章纲保持不变/u.test(text)))
  assert.equal(await fs.readFile(file, 'utf8'), original)

  await assert.rejects(writeBeatsBatch(root, [
    { chapter: chapters[0], content: '' },
    { chapter: chapters[1], content: '待顺延条目' },
  ], chapters), error => error?.code === BEAT_SECTION_AMBIGUOUS)
  assert.equal(await fs.readFile(file, 'utf8'), original)
})

test('双小节批量更新成功时同时移除源条目并保留目标原内容', async t => {
  const { root } = await fixture(t)
  const chapters = [{ id: '0001', title: '源章' }, { id: '0002', title: '目标章' }]
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, '# 章纲\n\n## 0001 源章\n待顺延条目\n\n## 0002 目标章\n目标原内容\n', 'utf8')
  await writeBeatsBatch(root, [
    { chapter: chapters[0], content: '' },
    { chapter: chapters[1], prepend: '待顺延条目' },
  ], chapters)
  assert.equal((await readBeats(root, chapters[0], chapters)).section.body, '')
  assert.equal((await readBeats(root, chapters[1], chapters)).section.body, '待顺延条目\n目标原内容')
})

test('顺延保存会拒绝覆盖读取后出现的新修改', async t => {
  const { root } = await fixture(t)
  const chapters = [{ id: '0001', title: '源章' }, { id: '0002', title: '目标章' }]
  const file = path.join(root, 'beats.md')
  const original = '# 章纲\n\n## 0001 源章\n旧版源内容\n\n## 0002 目标章\n目标内容\n'
  await fs.writeFile(file, original, 'utf8')
  const board = await readBeats(root, chapters[0], chapters)
  const changed = original.replace('旧版源内容', '并发写入的新版源内容')
  await fs.writeFile(file, changed, 'utf8')
  await assert.rejects(writeBeatsBatch(root, [
    { chapter: chapters[0], content: '' },
    { chapter: chapters[1], prepend: '待顺延条目' },
  ], chapters, board.baseHash), error => error?.code === BEAT_SECTION_CHANGED && /已变化/u.test(error.message))
  assert.equal(await fs.readFile(file, 'utf8'), changed)
})

test('空来源命中已有章时保留正文、状态和备注', async t => {
  const { root, call, render } = await fixture(t)
  const source = await writeSource(root, 'existing-empty.txt', '第一章 旧客\n已有正文。\n第二章 归途\n归途正文。\n')
  await call('novel_import', { source })
  const bookFile = path.join(root, 'book.json')
  const book = JSON.parse(await fs.readFile(bookFile, 'utf8'))
  book.chapters[0].status = 'draft'
  book.chapters[0].note = '作者备注'
  await fs.writeFile(bookFile, `${JSON.stringify(book, null, 2)}\n`, 'utf8')
  await fs.writeFile(source, '第一章 旧客\n第二章 归途\n归途正文。\n', 'utf8')

  const result = await call('novel_import', { source, replace: true, limit: 1 })
  assert.equal(result.imported, 0)
  assert.deepEqual(result.skipped, ['第一章 旧客'])
  assert.equal(await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8'), '已有正文。\n')
  const after = JSON.parse(await fs.readFile(bookFile, 'utf8')).chapters[0]
  assert.equal(after.status, 'draft')
  assert.equal(after.note, '作者备注')
  assert.match(render('novel_import', { source, replace: true }, result), /保留已有章节/u)
  assert.ok(result.warnings.some(text => /保留已有章节的正文、状态和备注/u.test(text)))
})

test('并发保存共用文件锁：不同章纲目标不会互相覆盖', async t => {
  const { root, call } = await fixture(t)
  const chapters = [
    { id: '0001', title: '一章', file: 'chapters/0001.md', status: 'planned' },
    { id: '0002', title: '二章', file: 'chapters/0002.md', status: 'planned' },
  ]
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ chapters }), 'utf8')
  await fs.writeFile(path.join(root, 'beats.md'), '# 章纲\n\n## 0001 一章\n\n### 场景 s0001-old：旧一\n- 时序：1\n- 出场：a\n\n#### 人物 a\n- 目标：旧目标\n\n## 0002 二章\n\n### 场景 s0002-old：旧二\n- 时序：2\n- 出场：a\n\n#### 人物 a\n- 目标：旧目标\n', 'utf8')
  const content = id => `### 场景 s${Number(id)}-new：并发新${id === '0001' ? '一' : '二'}\n- 时序：10\n- 出场：a\n\n#### 人物 a\n- 目标：并发新目标 ${id}\n`
  await Promise.all([
    call('novel_beats', { chapter: '0001', content: content('0001') }),
    call('novel_beats', { chapter: '0002', content: content('0002') }),
  ])
  const board = await readBeats(root, null)
  const one = board.sections.find(section => section.id === '0001')
  const two = board.sections.find(section => section.id === '0002')
  assert.match(one.body, /s1-new/u)
  assert.match(one.body, /并发新目标 0001/u)
  assert.match(two.body, /s2-new/u)
  assert.match(two.body, /并发新目标 0002/u)
})

test('全书章纲正文与哈希来自同一快照，提交旧哈希会在锁内被拒绝', async t => {
  const { root } = await fixture(t)
  const chapters = [{ id: '0001', title: '一章', file: 'chapters/0001.md', status: 'planned' }]
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ chapters }), 'utf8')
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, '# 章纲\n\n## 0001 一章\n旧内容\n', 'utf8')
  const snapshot = await readBeats(root, chapters[0], chapters)
  assert.equal(snapshot.baseHash, createHash('sha256').update(await fs.readFile(file, 'utf8')).digest('hex'))
  await fs.writeFile(file, '# 章纲\n\n## 0001 一章\n别人刚保存的新内容\n', 'utf8')
  await assert.rejects(
    writeBeats(root, chapters[0], '旧哈希提交', chapters, snapshot.baseHash),
    error => error?.code === BEAT_SECTION_CHANGED,
  )
  assert.equal(await fs.readFile(file, 'utf8'), '# 章纲\n\n## 0001 一章\n别人刚保存的新内容\n')
})

test('整场移动用常规匹配规则定位目标并插在紧邻小节之前', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0002', title: '目标章', file: 'chapters/0002.md' },
    { id: '0004', title: '四章', file: 'chapters/0004.md' },
  ]
  const file = path.join(root, 'beats.md')
  const scene = '### 场景 move-me：待移动\n- 时序：5\n- 出场：a\n\n#### 人物 a\n- 目标：搬走\n'
  await fs.writeFile(file, `# 章纲\n\n## 0001 源章\n${scene}\n## 0002 目标章\n目标原内容\n\n## 归途\n无 ID 旧小节\n\n## 0004 四章\n四章内容\n`, 'utf8')

  await moveScene(root, [...chapters, { id: '0001', title: '源章', file: 'chapters/0001.md' }], 'move-me', '0002')
  const text = await fs.readFile(file, 'utf8')
  const targetAt = text.indexOf('## 0002 目标章')
  const legacyAt = text.indexOf('## 归途')
  const movedAt = text.indexOf('### 场景 move-me')
  assert.ok(targetAt < movedAt && movedAt < legacyAt, '场景必须落在目标章与无 ID 旧小节之间')
  assert.match(text.slice(targetAt, legacyAt), /### 场景 move-me/u)
  assert.match(text.slice(legacyAt), /无 ID 旧小节/u)
})

test('整场移动的目标章 ID 重复时拒绝而不是取第一条', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '源章', file: 'chapters/0001.md' },
    { id: '0002', title: '目标章', file: 'chapters/0002.md' },
  ]
  const file = path.join(root, 'beats.md')
  const original = '# 章纲\n\n## 0001 源章\n### 场景 move-me：待移动\n- 时序：5\n- 出场：a\n\n#### 人物 a\n- 目标：搬走\n\n## 0002 目标章\n内容 A\n\n## 2 目标章副本\n内容 B\n'
  await fs.writeFile(file, original, 'utf8')
  await assert.rejects(moveScene(root, chapters, 'move-me', '0002'), /请核对|未移动/u)
  assert.equal(await fs.readFile(file, 'utf8'), original)
})

test('整场移动的截断边界接受制表符标题，不会剪走下一章', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '源章', file: 'chapters/0001.md' },
    { id: '0002', title: '目标章', file: 'chapters/0002.md' },
    { id: '0003', title: '三章', file: 'chapters/0003.md' },
  ]
  const file = path.join(root, 'beats.md')
  const original = '# 章纲\n\n## 0001 源章\n### 场景 tail：本章末场\n- 时序：5\n- 出场：a\n\n#### 人物 a\n- 目标：搬走\n\n##\t0003 三章\n三章正文\n\n### 场景 keep：三章场景\n- 时序：9\n- 出场：a\n\n#### 人物 a\n- 目标：留下\n\n## 0002 目标章\n目标原内容\n'
  await fs.writeFile(file, original, 'utf8')
  await moveScene(root, chapters, 'tail', '0002')
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /### 场景 keep：三章场景/u, '下一章的场景不能被一起剪走')
  assert.match(text, /目标原内容/u)
  const three = text.slice(text.indexOf('##\t0003 三章'))
  assert.ok(three.includes('三章正文') && three.includes('### 场景 keep'), '下一章内容必须原地保留')
})

test('移入无 ID 或短 ID 旧标题后，目标章能按 ID 读回场景', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '源章', file: 'chapters/0001.md' },
    { id: '0002', title: '归途', file: 'chapters/0002.md' },
    { id: '0003', title: '短号', file: 'chapters/0003.md' },
  ]
  const file = path.join(root, 'beats.md')
  const scene = '### 场景 move-me：待移动\n- 时序：5\n- 出场：a\n\n#### 人物 a\n- 目标：搬走\n'
  await fs.writeFile(file, `# 章纲\n\n## 0001 源章\n${scene}\n## 归途\n旧内容\n\n## 3 短号\n短号旧内容\n`, 'utf8')

  await moveScene(root, chapters, 'move-me', '0002')
  let text = await fs.readFile(file, 'utf8')
  assert.match(text, /^## 0002 归途$/mu, '无 ID 目标小节必须在同次保存中规范化')
  assert.equal((await stageContext(root, chapters, '0002')).scenes.find(scene => scene.id === 'move-me')?.chapter, '0002')

  await moveScene(root, chapters, 'move-me', '0003')
  text = await fs.readFile(file, 'utf8')
  assert.match(text, /^## 0003 短号$/mu, '短 ID 目标小节必须在同次保存中补零')
  assert.equal((await stageContext(root, chapters, '0003')).scenes.find(scene => scene.id === 'move-me')?.chapter, '0003')
})

test('整场移动首场时后续场景原地保留', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '源章', file: 'chapters/0001.md' },
    { id: '0002', title: '目标章', file: 'chapters/0002.md' },
  ]
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, '# 章纲\n\n## 0001 源章\n### 场景 first：首场\n- 时序：5\n- 出场：a\n\n#### 人物 a\n- 目标：搬走\n\n### 场景 second：第二场\n- 时序：9\n- 出场：a\n\n#### 人物 a\n- 目标：留下\n\n## 0002 目标章\n目标原内容\n', 'utf8')
  await moveScene(root, chapters, 'first', '0002')
  const text = await fs.readFile(file, 'utf8')
  const sourcePart = text.slice(text.indexOf('## 0001 源章'), text.indexOf('## 0002 目标章'))
  assert.match(sourcePart, /### 场景 second：第二场/u, '后续场景必须留在源章')
  assert.doesNotMatch(sourcePart, /### 场景 first：首场/u)
  const targetPart = text.slice(text.indexOf('## 0002 目标章'))
  assert.match(targetPart, /### 场景 first：首场/u)
  assert.doesNotMatch(targetPart, /### 场景 second：第二场/u, '第二场不能被一起搬走')
})

test('单独的 ## 空行不会让目标小节索引错位', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '源章', file: 'chapters/0001.md' },
    { id: '0002', title: '目标章', file: 'chapters/0002.md' },
  ]
  const file = path.join(root, 'beats.md')
  const scene = '### 场景 move-me：待移动\n- 时序：5\n- 出场：a\n\n#### 人物 a\n- 目标：搬走\n'
  await fs.writeFile(file, `# 章纲\n\n##\n\n## 0001 源章\n${scene}\n## 0002 目标章\n目标原内容\n`, 'utf8')
  await moveScene(root, chapters, 'move-me', '0002')
  const text = await fs.readFile(file, 'utf8')
  assert.equal((text.match(/## 0002 目标章/gu) ?? []).length, 1, '不能产生重复目标 ID')
  assert.doesNotMatch((await readBeats(root, chapters[0], chapters)).section.body ?? '', /### 场景 move-me/u, '源章不应再持有该场景')
  assert.match((await readBeats(root, chapters[1], chapters)).section.body, /### 场景 move-me/u)
})

test('多场与制表符标题混排时，移动只截取目标场景', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '源章', file: 'chapters/0001.md' },
    { id: '0002', title: '目标章', file: 'chapters/0002.md' },
    { id: '0003', title: '三章', file: 'chapters/0003.md' },
  ]
  const file = path.join(root, 'beats.md')
  await fs.writeFile(file, '# 章纲\n\n##\t0001 源章\n### 场景 a：甲\n- 时序：1\n- 出场：a\n\n#### 人物 a\n- 目标：甲\n\n### 场景 b：乙\n- 时序：2\n- 出场：a\n\n#### 人物 a\n- 目标：乙\n\n##\t0002 目标章\n目标原内容\n\n## 0003 三章\n三章内容\n', 'utf8')
  await moveScene(root, chapters, 'a', '0002')
  const text = await fs.readFile(file, 'utf8')
  const sourcePart = text.slice(text.indexOf('##\t0001 源章'), text.indexOf('## 0002 目标章'))
  assert.match(sourcePart, /### 场景 b：乙/u, '同章第二场必须原地保留')
  assert.doesNotMatch(sourcePart, /### 场景 a：甲/u)
  const targetPart = text.slice(text.indexOf('## 0002 目标章'), text.indexOf('## 0003 三章'))
  assert.match(targetPart, /### 场景 a：甲/u)
  assert.doesNotMatch(targetPart, /### 场景 b：乙/u)
})

test('移入带制表符的目标标题后仍规范化为普通空格并可按 ID 读回', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '源章', file: 'chapters/0001.md' },
    { id: '0002', title: '目标章', file: 'chapters/0002.md' },
  ]
  const file = path.join(root, 'beats.md')
  const scene = '### 场景 move-me：待移动\n- 时序：5\n- 出场：a\n\n#### 人物 a\n- 目标：搬走\n'
  await fs.writeFile(file, `# 章纲\n\n## 0001 源章\n${scene}\n##\t0002 目标章\n目标原内容\n`, 'utf8')
  await moveScene(root, chapters, 'move-me', '0002')
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /^## 0002 目标章$/mu, '制表符标题必须重写为普通空格')
  assert.doesNotMatch(text, /^##\t/mu)
  assert.equal((await stageContext(root, chapters, '0002')).scenes.find(scene => scene.id === 'move-me')?.chapter, '0002')
})

test('全书章纲接口返回逐章匹配：歧义无小节，唯一旧条目挂载真实章 ID', async t => {
  const { root } = await fixture(t)
  const chapters = [
    { id: '0001', title: '旧客', file: 'chapters/0001.md' },
    { id: '0002', title: '歧义章', file: 'chapters/0002.md' },
  ]
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ chapters }), 'utf8')
  await fs.writeFile(path.join(root, 'beats.md'), '# 章纲\n\n## 旧客\n唯一旧内容\n\n## 0002 歧义章\n内容 A\n\n## 2 歧义章副本\n内容 B\n', 'utf8')
  let handler
  apply({ tools: { register() {} }, effect: fn => fn(), webServer: { register: value => { handler = value.handler } } }, { root })
  const req = Readable.from([])
  Object.assign(req, { url: '/novel-api/beats', method: 'GET', headers: {} })
  let raw = ''
  const res = { statusCode: 200, destroyed: false, writeHead(status) { this.statusCode = status }, end(value) { raw += value || '' } }
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  const value = JSON.parse(raw)
  const matched = value.chapterMatches.find(item => item.id === '0001')
  assert.equal(matched.status, 'matched')
  assert.equal(matched.section.id, '0001')
  assert.equal(matched.section.text, '唯一旧内容')
  assert.equal(matched.needsNormalization, true)
  assert.match(matched.warning, /原始章纲/u)
  const ambiguous = value.chapterMatches.find(item => item.id === '0002')
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.section, undefined)
  assert.match(ambiguous.warning, /请核对/u)
  assert.ok(value.warnings.length)
})
