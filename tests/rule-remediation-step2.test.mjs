import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const BODY = '七号炉的炉皮在跳。\n\n他把手按上去。\n'
const CHANGED_BODY = '七号炉的炉皮在跳。\n\n他收回手，退到门边。\n'
const ASPECTS = ['continuity', 'timing', 'voice', 'narration', 'rhythm', 'facts']

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-remediation-step2-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const body = options.body === undefined ? BODY : options.body
  const status = options.status ?? 'draft'
  const chapters = body === null ? [] : [{ id: '0001', title: '第一章', file: 'chapters/0001.md', status, targetChars: 3000 }]
  await fs.mkdir(path.join(root, 'chapters'), { recursive: true })
  if (body !== null) await fs.writeFile(path.join(root, 'chapters/0001.md'), body, 'utf8')
  if (options.style) {
    await fs.mkdir(path.join(root, 'styles'), { recursive: true })
    await fs.writeFile(path.join(root, `styles/${options.style}.md`), options.styleContent ?? '# 文风\n\n## 规则\n- 少总结。\n', 'utf8')
  }
  await fs.writeFile(path.join(root, 'book.json'), `${JSON.stringify({
    title: '状态测试',
    targetChars: 3000,
    ...(options.style ? { style: options.style } : {}),
    chapters,
  }, null, 2)}\n`, 'utf8')

  const tools = new Map()
  let handler
  apply({
    tools: { register: definition => tools.set(definition.name, definition) },
    effect: fn => fn(),
    webServer: { register: value => { handler = value.handler } },
  }, { root })
  const call = (name, args = {}) => {
    const tool = tools.get(name)
    assert.ok(tool, `没有注册工具 ${name}`)
    return tool.execute(args)
  }
  const request = async (url, payload) => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
    Object.assign(req, {
      url,
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? {} : { 'x-novel-action': '1' },
    })
    let raw = ''
    const res = {
      statusCode: 200,
      destroyed: false,
      writeHead(code) { this.statusCode = code },
      end(value) { raw += value ? String(value) : '' },
    }
    await handler(req, res)
    return { status: res.statusCode, value: raw ? JSON.parse(raw) : null }
  }
  const render = (name, args, value) => {
    const tool = tools.get(name)
    assert.ok(tool, `没有注册工具 ${name}`)
    return tool.output.render(args, value).map(part => part.text).join('\n')
  }
  const readBook = async () => JSON.parse(await fs.readFile(path.join(root, 'book.json'), 'utf8'))
  return { root, call, request, render, readBook }
}

const baseChecks = () => Object.fromEntries(ASPECTS.map(aspect => [aspect, {
  verdict: 'supported',
  detail: '本维度已核对。',
  counterargument: '最可能推翻结论的是段落顺序，已按段号复核。',
  evidence: [{ source: 'chapter', index: 1, quote: '七号炉的炉皮在跳' }],
}]))

const fullReview = (checks, extra = {}) => ({
  chapter: '0001',
  checks,
  observations: [],
  timeBudgets: [],
  scenes: [{
    startIndex: 1,
    endIndex: 2,
    layout: '炉坑：他站在炉前。',
    mechanism: '炉皮在跳，他按手确认。',
    timeline: '贴壳，再按手。',
    actions: [],
  }],
  paragraphs: [
    { index: 1, reason: '开场异常。' },
    { index: 2, reason: '承接动作。' },
  ],
  ...extra,
})

async function registerReview(call, checks = baseChecks(), extra = {}) {
  const packed = await call('novel_deai_pack', { chapter: '0001' })
  return call('novel_deai_review', { ...fullReview(checks, extra), baseHash: packed.baseHash, styleHash: packed.style.hash })
}

async function finalize(call, checks = baseChecks(), extra = {}) {
  await registerReview(call, checks, extra)
  return call('novel_write', { chapter: '0001', content: BODY, status: 'final' })
}

function conflictReview() {
  const checks = baseChecks()
  const evidence = [
    { source: 'chapter', index: 1, quote: '七号炉的炉皮在跳' },
    { source: 'chapter', index: 2, quote: '他把手按上去' },
  ]
  checks.continuity = {
    verdict: 'conflict',
    detail: '动作前提互相矛盾。',
    counterargument: '可能存在正文未写出的防护条件。',
    evidence,
  }
  return {
    checks,
    observations: [{
      aspect: 'continuity',
      classification: 'conflict',
      detail: '同一动作的安全前提冲突。',
      counterargument: '若有防护条件则可推翻。',
      comparison: { entity: '他的手', property: '能否接触炉皮', timeScope: '同一场景' },
      evidence,
    }],
  }
}

async function assertCurrentState({ call, request }, status, reviewStatus) {
  const checked = await call('novel_check', { chapter: '0001', aiTone: false })
  assert.equal(checked.deaiReview.status, reviewStatus)
  assert.equal(checked.deaiReview.certifiesSemantics, false)
  assert.equal((await call('novel_status')).chapters.find(chapter => chapter.id === '0001').status, status)
  const snapshot = await request('/novel-api/state')
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.value.chapters.find(chapter => chapter.id === '0001').status, status)
  assert.equal((await request('/novel-api/history-all')).value.chapters.find(chapter => chapter.id === '0001').status, status)
}

async function seedVersion(root, content, version = '20261120090000') {
  const dir = path.join(root, 'chapters/.history')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `0001-${version}.md`), content, 'utf8')
  return version
}

test('无有效复核时 final 在写盘前拒绝', async t => {
  const { root, call, readBook } = await fixture(t)
  const before = await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8')
  await assert.rejects(
    call('novel_write', { chapter: '0001', content: CHANGED_BODY, status: 'final' }),
    /缺少有效审稿记录|阻塞项/u,
  )
  assert.equal(await fs.readFile(path.join(root, 'chapters/0001.md'), 'utf8'), before)
  assert.equal((await readBook()).chapters[0].status, 'draft')
})

test('有效复核只开放显式定稿，同文写回不会误降级', async t => {
  const { call, readBook } = await fixture(t)
  const review = await registerReview(call)
  assert.equal(review.status, 'recorded')
  assert.equal((await readBook()).chapters[0].status, 'draft')

  const finalized = await call('novel_write', { chapter: '0001', content: BODY, status: 'final' })
  assert.equal(finalized.status, 'final')
  const repeated = await call('novel_write', { chapter: '0001', content: BODY })
  assert.equal(repeated.status, 'final')
  assert.equal((await readBook()).chapters[0].status, 'final')
})

test('阻塞复核会撤销已有 final，不能再次定稿', async t => {
  const { call, readBook } = await fixture(t)
  await finalize(call)
  const blocked = conflictReview()
  const result = await registerReview(call, blocked.checks, { observations: blocked.observations })
  assert.equal(result.status, 'blocked')
  assert.equal((await readBook()).chapters[0].status, 'draft')
  await assert.rejects(
    call('novel_write', { chapter: '0001', content: BODY, status: 'final' }),
    /缺少有效审稿记录|阻塞项/u,
  )
})

test('正文变化后工具状态、章节列表和 HTTP 状态同步降为 draft', async t => {
  const { root, call, request, readBook } = await fixture(t)
  await finalize(call)
  await fs.writeFile(path.join(root, 'chapters/0001.md'), CHANGED_BODY, 'utf8')

  const checked = await call('novel_check', { chapter: '0001', aiTone: false })
  assert.equal(checked.deaiReview.status, 'pending')
  const status = await call('novel_status')
  assert.equal(status.chapters[0].status, 'draft')
  assert.equal((await request('/novel-api/state')).value.chapters[0].status, 'draft')
  assert.equal((await request('/novel-api/history-all')).value.chapters[0].status, 'draft')
  const context = await call('novel_context', { chapter: '0001', budget: 20000 })
  assert.equal(context.chapter.status, 'draft')
  assert.equal((await readBook()).chapters[0].status, 'final', '只读状态投影不能改写作者的定稿声明')
})

test('启用文风即使未作为引文，也会绑定内容指纹', async t => {
  const style = '简练'
  const { root, call } = await fixture(t, { style })
  const checks = baseChecks()
  checks.narration.verdict = 'not-applicable'
  checks.rhythm.verdict = 'not-applicable'
  await finalize(call, checks)

  await fs.writeFile(path.join(root, `styles/${style}.md`), '# 文风\n\n## 规则\n- 少总结。\n- 少排比。\n', 'utf8')
  const checked = await call('novel_check', { chapter: '0001', aiTone: false })
  assert.equal(checked.deaiReview.status, 'pending')
  assert.equal((await call('novel_status')).chapters[0].status, 'draft')
})

test('首次导入的非空正文是 draft，显式 final 在导入前拒绝', async t => {
  const first = await fixture(t, { body: null })
  const source = path.join(first.root, 'source.txt')
  await fs.writeFile(source, '第一章 旧客\n正文甲。\n第二章 归途\n正文乙。\n', 'utf8')
  const imported = await first.call('novel_import', { source })
  assert.equal(imported.imported, 2)
  assert.deepEqual((await first.readBook()).chapters.map(chapter => chapter.status), ['draft', 'draft'])

  const second = await fixture(t, { body: null })
  const blockedSource = path.join(second.root, 'blocked.txt')
  await fs.writeFile(blockedSource, '第一章 旧客\n正文甲。\n第二章 归途\n正文乙。\n', 'utf8')
  await assert.rejects(
    second.call('novel_import', { source: blockedSource, status: 'final' }),
    /先导入|复核|final/u,
  )
  assert.equal((await second.readBook()).chapters.length, 0)
  assert.equal(await fs.access(path.join(second.root, 'chapters/0001.md')).then(() => true).catch(() => false), false)
})

test('覆盖导入只在原复核仍有效时保留 final', async t => {
  const { root, call, readBook } = await fixture(t)
  await finalize(call)
  const same = path.join(root, 'same.txt')
  await fs.writeFile(same, `第一章\n${BODY.trim()}\n第二章\n新章正文。\n`, 'utf8')
  await call('novel_import', { source: same, replace: true })
  assert.equal((await readBook()).chapters.find(chapter => chapter.id === '0001').status, 'final')

  const changed = path.join(root, 'changed.txt')
  await fs.writeFile(changed, `第一章\n${CHANGED_BODY.trim()}\n第二章\n新章正文。\n`, 'utf8')
  await call('novel_import', { source: changed, replace: true })
  assert.equal((await readBook()).chapters.find(chapter => chapter.id === '0001').status, 'draft')
  assert.equal((await call('novel_check', { chapter: '0001', aiTone: false })).deaiReview.status, 'pending')
})

test('恢复外部改写前的已复核版本时保留显式 final', async t => {
  const { root, call, request, readBook } = await fixture(t)
  await finalize(call)
  const version = await seedVersion(root, BODY)
  await fs.writeFile(path.join(root, 'chapters/0001.md'), CHANGED_BODY, 'utf8')

  const restored = await call('novel_restore', { chapter: '0001', version })
  assert.equal(restored.status, 'final')
  assert.equal((await readBook()).chapters[0].status, 'final')
  assert.equal((await call('novel_check', { chapter: '0001', aiTone: false })).deaiReview.status, 'recorded')
  assert.equal((await request('/novel-api/state')).value.chapters[0].status, 'final')
})

test('空正文不能显示 final，有正文的旧 planned 统一显示 draft', async t => {
  const empty = await fixture(t, { body: '', status: 'final' })
  assert.equal((await empty.call('novel_status')).chapters[0].status, 'planned')

  const written = await fixture(t, { status: 'planned' })
  assert.equal((await written.call('novel_status')).chapters[0].status, 'draft')
})

test('取包后换成同名文风卡或切换启用文风，旧审稿不能登记到新卡', async t => {
  const style = '简练'
  const current = await fixture(t, { style })
  const checks = baseChecks()
  checks.narration.verdict = 'not-applicable'
  checks.rhythm.verdict = 'not-applicable'
  const packed = await current.call('novel_deai_pack', { chapter: '0001' })
  await fs.writeFile(path.join(current.root, `styles/${style}.md`), '# 文风\n\n## 规则\n- 少总结。\n- 少排比。\n', 'utf8')
  await assert.rejects(
    current.call('novel_deai_review', { ...fullReview(checks), baseHash: packed.baseHash, styleHash: packed.style.hash }),
    /启用文风在取包后已变化|重新调用 novel_deai_pack/u,
  )
  const unchanged = await current.call('novel_deai_pack', { chapter: '0001' })
  assert.notEqual(unchanged.style.hash, packed.style.hash)

  await current.call('novel_write', { chapter: '0001', content: BODY, status: 'draft' })
  await fs.writeFile(path.join(current.root, 'styles/另一套.md'), '# 另一套\n\n- 多停顿。\n', 'utf8')
  await current.request('/novel-api/style-active', { name: '另一套' })
  await assert.rejects(
    current.call('novel_deai_review', { ...fullReview(checks), baseHash: packed.baseHash, styleHash: packed.style.hash }),
    /启用文风在取包后已变化/u,
  )
  await assert.rejects(
    current.call('novel_deai_review', { ...fullReview(checks), baseHash: packed.baseHash }),
    /未提交启用文风/u,
  )
  assert.equal((await current.readBook()).chapters[0].deaiReview, undefined)

  await fs.rm(path.join(current.root, 'styles/另一套.md'))
  const fresh = await current.call('novel_deai_pack', { chapter: '0001' })
  const registered = await current.call('novel_deai_review', { ...fullReview(checks), baseHash: fresh.baseHash, styleHash: fresh.style.hash })
  assert.equal(registered.status, 'blocked')
  assert.ok(registered.findings.some(item => /缺失或为空/u.test(item.detail)), '新启用卡缺失时登记也必须阻塞')
})

test('启用文风卡缺失或空白时，not-applicable 也不能取得定稿资格', async t => {
  for (const content of [null, ' \n\t']) {
    const current = await fixture(t, { style: '简练' })
    const card = path.join(current.root, 'styles/简练.md')
    if (content === null) await fs.rm(card)
    else await fs.writeFile(card, content, 'utf8')
    const checks = baseChecks()
    checks.narration.verdict = 'not-applicable'
    checks.rhythm.verdict = 'not-applicable'
    const result = await registerReview(current.call, checks)
    assert.equal(result.status, 'blocked')
    assert.ok(result.findings.some(item => item.aspect === 'rhythm' && /缺失或为空/u.test(item.detail)))
    assert.ok((await current.call('novel_deai_pack', { chapter: '0001' })).materialPreflight.missingSources.length > 0)
    await assert.rejects(
      current.call('novel_write', { chapter: '0001', content: BODY, status: 'final' }),
      /阻塞项/u,
    )
    await assertCurrentState(current, 'draft', 'blocked')
  }
})

test('登记期间另一请求写入阻塞，不能靠旧书目快照抹掉新记录', async t => {
  const current = await fixture(t)
  const packed = await current.call('novel_deai_pack', { chapter: '0001' })
  const blocked = conflictReview()
  const first = registerReview(current.call, blocked.checks, { observations: blocked.observations })
  const second = current.call('novel_write', { chapter: '0001', content: BODY, status: 'draft' })
  const [reviewResult] = await Promise.all([first, second])
  assert.equal(reviewResult.status, 'blocked')
  const chapter = (await current.readBook()).chapters[0]
  assert.ok(Number.isInteger(chapter.deaiReview.version))
  assert.equal(chapter.status, 'draft')
  assert.equal((await current.call('novel_check', { chapter: '0001', aiTone: false })).deaiReview.status, 'blocked')

  const target = path.join(current.root, 'beats.md')
  await fs.appendFile(target, '\n- 备注：新增依据\n', 'utf8')
  const staleWrite = current.call('novel_write', { chapter: '0001', content: BODY })
  const freshReview = registerReview(current.call, baseChecks(), { resolutions: { continuity: '重新核对后更正先前判断。' } })
  await Promise.all([staleWrite, freshReview])
  const after = (await current.readBook()).chapters[0]
  assert.ok(after.deaiReview.checks.continuity.verdict === 'supported', '后完成的写入不能回滚新登记')
  assert.equal(after.status, 'draft')
  assert.equal(packed.baseHash, (await current.call('novel_deai_pack', { chapter: '0001' })).baseHash)
})

test('恢复不能覆盖并发登记的阻塞审稿', async t => {
  const current = await fixture(t)
  await finalize(current.call)
  const version = await seedVersion(current.root, BODY)
  const blocked = conflictReview()
  const restore = current.call('novel_restore', { chapter: '0001', version })
  const review = registerReview(current.call, blocked.checks, { observations: blocked.observations })
  await Promise.all([restore, review])
  const chapter = (await current.readBook()).chapters[0]
  assert.equal(chapter.deaiReview.checks.continuity.verdict, 'conflict')
  assert.equal(chapter.status, 'draft')
  await assertCurrentState(current, 'draft', 'blocked')
})

test('切换到内容相同的另一张文风卡时，旧包不能冒充新卡审稿', async t => {
  const current = await fixture(t, { style: '甲卡' })
  const checks = baseChecks()
  checks.narration.verdict = 'not-applicable'
  checks.rhythm.verdict = 'not-applicable'
  const packed = await current.call('novel_deai_pack', { chapter: '0001' })
  await fs.copyFile(path.join(current.root, 'styles/甲卡.md'), path.join(current.root, 'styles/乙卡.md'))
  await current.request('/novel-api/style-active', { name: '乙卡' })
  const fresh = await current.call('novel_deai_pack', { chapter: '0001' })
  assert.notEqual(fresh.style.hash, packed.style.hash, '同内容不同名称必须得到不同指纹')

  await assert.rejects(
    current.call('novel_deai_review', { ...fullReview(checks), baseHash: packed.baseHash, styleHash: packed.style.hash }),
    /启用文风在取包后已变化/u,
  )
  assert.equal((await current.readBook()).chapters[0].deaiReview, undefined)
  const registered = await current.call('novel_deai_review', { ...fullReview(checks), baseHash: fresh.baseHash, styleHash: fresh.style.hash })
  assert.equal(registered.status, 'recorded')
  await current.call('novel_write', { chapter: '0001', content: BODY, status: 'final' })
  await assertCurrentState(current, 'final', 'recorded')
})

test('启用文风缺失时文本审稿包仍显示可提交的指纹', async t => {
  const current = await fixture(t, { style: '简练' })
  await fs.rm(path.join(current.root, 'styles/简练.md'))
  const checks = baseChecks()
  checks.narration.verdict = 'not-applicable'
  checks.rhythm.verdict = 'not-applicable'
  const packed = await current.call('novel_deai_pack', { chapter: '0001' })
  assert.ok(packed.style.hash)
  assert.equal(packed.style.text, '')
  const text = current.render('novel_deai_pack', { chapter: '0001' }, packed)
  assert.match(text, /缺失或为空/u)
  assert.match(text, new RegExp(`styleHash: ${packed.style.hash}`, 'u'))
  const registered = await current.call('novel_deai_review', { ...fullReview(checks), baseHash: packed.baseHash, styleHash: packed.style.hash })
  assert.equal(registered.status, 'blocked')
  assert.match(current.render('novel_deai_review', { chapter: '0001' }, registered), /存在矛盾、依据不足或工具校验阻塞项/u)
})

test('书目与文风启用先在临时文件写完再替换，读取方不会解析到半份 JSON', async t => {
  const current = await fixture(t, { style: '简练' })
  const original = fs.writeFile
  let release = () => {}
  let markStalled = () => {}
  const released = new Promise(resolve => { release = resolve })
  const stalling = new Promise(resolve => { markStalled = resolve })
  let paused = false
  fs.writeFile = async (file, data, ...rest) => {
    if (!paused && String(file).startsWith(path.join(current.root, 'book.json.tmp-'))) {
      paused = true
      // 模拟写到一半卡住：目标 book.json 此时应仍是上一份完整内容。
      await original(file, String(data).slice(0, Math.floor(String(data).length / 2)), ...rest)
      markStalled()
      await released
    }
    return original(file, data, ...rest)
  }
  t.after(() => { fs.writeFile = original; release() })

  const write = current.call('novel_book', { title: '新书名' })
  let timer
  const stalled = await Promise.race([
    stalling.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000) }),
  ])
  clearTimeout(timer)
  assert.equal(stalled, true, '书目写入必须经过同目录临时文件，否则读取方可能读到半份 JSON')
  assert.equal((await current.readBook()).title, '状态测试', '临时文件写一半时目标文件必须仍是完整旧版')
  assert.equal((await current.request('/novel-api/state')).status, 200)
  release()
  await write
  assert.equal((await current.readBook()).title, '新书名')

  const activate = current.request('/novel-api/style-active', { name: '简练' })
  await activate
  assert.equal((await current.readBook()).style, '简练')
  const leftovers = (await fs.readdir(current.root)).filter(name => name.startsWith('book.json.tmp-'))
  assert.deepEqual(leftovers, [], '原子替换后不留下临时文件')
})

test('正文变更会持久化撤销 final，旧复核记录仍保留用于审计', async t => {
  const { call, readBook } = await fixture(t)
  await finalize(call)
  const result = await call('novel_write', { chapter: '0001', content: CHANGED_BODY })
  assert.equal(result.status, 'draft')
  const chapter = (await readBook()).chapters[0]
  assert.equal(chapter.status, 'draft')
  assert.equal(chapter.deaiReview.baseHash, createHash('sha256').update(BODY).digest('hex'))
})

test('新章 final 被拒后不创建正文或历史，明确 draft 保留作者选择', async t => {
  const empty = await fixture(t, { body: null })
  const bookBefore = await fs.readFile(path.join(empty.root, 'book.json'), 'utf8')
  await assert.rejects(empty.call('novel_write', { content: BODY, status: 'final' }), /有效审稿记录/u)
  assert.equal(await fs.readFile(path.join(empty.root, 'book.json'), 'utf8'), bookBefore)
  assert.deepEqual(await fs.readdir(path.join(empty.root, 'chapters')), [])

  const existing = await fixture(t)
  await finalize(existing.call)
  const draft = await existing.call('novel_write', { chapter: '0001', content: BODY, status: 'draft' })
  assert.equal(draft.status, 'draft')
  await assertCurrentState(existing, 'draft', 'recorded')
})

for (const mode of ['append', 'patch']) {
  test(`${mode} 改稿保留哈希守卫并使已定稿正文待复核`, async t => {
    const current = await fixture(t)
    await finalize(current.call)
    const packed = await current.call('novel_deai_pack', { chapter: '0001' })
    const args = mode === 'append'
      ? { mode, content: '他跨过门槛。\n' }
      : {
          mode,
          baseHash: packed.baseHash,
          start: Array.from(BODY.slice(0, BODY.indexOf('他'))).length,
          end: Array.from(BODY).length - 1,
          content: '他收回手，退到门边。',
        }
    const result = await current.call('novel_write', { chapter: '0001', ...args })
    assert.equal(result.status, 'draft')
    assert.ok(result.backup)
    assert.match(result.warnings.join('\n'), /当前版本待复核/u)
    await assertCurrentState(current, 'draft', 'pending')
    if (mode === 'patch') {
      await assert.rejects(current.call('novel_write', { chapter: '0001', ...args }), /正文已变化/u)
    }
  })
}

test('uncertain 和 supported 下的工具阻塞都不能越过定稿门槛', async t => {
  const uncertain = await fixture(t)
  const checks = baseChecks()
  checks.facts.verdict = 'uncertain'
  const observations = [{
    aspect: 'facts',
    classification: 'missing-basis',
    detail: '缺少炉皮跳动的原因。',
    counterargument: '也可能只是背景声，无须解释。',
    evidence: checks.facts.evidence,
  }]
  assert.equal((await registerReview(uncertain.call, checks, { observations })).status, 'blocked')
  await assert.rejects(uncertain.call('novel_write', { chapter: '0001', content: BODY, status: 'final' }), /阻塞项/u)
  await assertCurrentState(uncertain, 'draft', 'blocked')

  const coverage = await fixture(t)
  await fs.mkdir(path.join(coverage.root, 'settings'))
  await fs.writeFile(path.join(coverage.root, 'settings/七号炉.md'), '# 七号炉\n\n炉皮禁止直接接触。\n', 'utf8')
  const blocked = await registerReview(coverage.call)
  assert.equal(blocked.status, 'blocked')
  assert.ok(blocked.findings.some(item => item.aspect === 'facts'))
  await assert.rejects(coverage.call('novel_write', { chapter: '0001', content: BODY, status: 'final' }), /阻塞项/u)
  await assertCurrentState(coverage, 'draft', 'blocked')
})

test('明示时间预算超限即使 checks 全为 supported 也阻塞 final', async t => {
  const body = '七号炉的炉皮在跳，还剩三息。\n\n他把手按上去，用了四息。\n'
  const current = await fixture(t, { body })
  const result = await registerReview(current.call, baseChecks(), { timeBudgets: [{
    label: '炉前窗口',
    unit: '息',
    availableText: '三息',
    evidence: [{ source: 'chapter', index: 1, quote: '还剩三息' }],
    phases: [{
      parallel: false,
      evidence: [],
      tasks: [{
        label: '按手',
        basis: 'stated',
        duration: 4,
        durationText: '四息',
        evidence: [{ source: 'chapter', index: 2, quote: '用了四息' }],
      }],
    }],
  }] })
  assert.equal(result.status, 'blocked')
  assert.ok(result.findings.some(item => item.aspect === 'timing' && item.verdict === 'conflict'))
  await assert.rejects(current.call('novel_write', { chapter: '0001', content: body, status: 'final' }), /阻塞项/u)
  await assertCurrentState(current, 'draft', 'blocked')
})

test('非阻塞表达偏好可登记并显式定稿，修复阻塞仍要求 resolutions', async t => {
  const preference = await fixture(t)
  const observations = [{
    aspect: 'narration',
    classification: 'preference',
    detail: '可酌情调整开场声音。',
    counterargument: '当前表述也能成立。',
    evidence: [{ source: 'chapter', index: 1, quote: '七号炉的炉皮在跳' }],
  }]
  assert.equal((await finalize(preference.call, baseChecks(), { observations })).status, 'final')
  await assertCurrentState(preference, 'final', 'recorded')

  const blocked = await fixture(t)
  const review = conflictReview()
  await registerReview(blocked.call, review.checks, { observations: review.observations })
  await assert.rejects(registerReview(blocked.call), /resolutions/u)
  const fixed = await registerReview(blocked.call, baseChecks(), { resolutions: { continuity: '核对原文后更正此前判断，引用的是不同属性。' } })
  assert.equal(fixed.status, 'recorded')
  assert.equal((await blocked.readBook()).chapters[0].status, 'draft')
  assert.ok((await blocked.readBook()).chapters[0].deaiReview.resolvedFindings.length > 0)
  await blocked.call('novel_write', { chapter: '0001', content: BODY, status: 'final' })
  await assertCurrentState(blocked, 'final', 'recorded')
})

const CITED_SOURCES = [
  { source: 'outline', file: 'outline.md' },
  { source: 'beats', file: 'beats.md' },
  { source: 'threads', file: 'threads.md' },
  { source: 'ledger', file: 'ledger.md' },
  { source: 'events', file: 'events.md' },
  { source: 'character', name: '旁人', file: 'characters/旁人.md' },
  { source: 'setting', name: '炉具', file: 'settings/炉具.md' },
  { source: 'style', name: '资料文风', file: 'styles/资料文风.md' },
]

for (const { source, name, file } of CITED_SOURCES) {
  test(`已引用 ${source} 资料变化后，检查与所有章节列表即时失效`, async t => {
    const current = await fixture(t)
    const target = path.join(current.root, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '# 资料\n\n需要核对的资料。\n', 'utf8')
    const checks = baseChecks()
    checks.facts.evidence.push({ source, ...(name ? { name } : {}), quote: '需要核对的资料。' })
    await finalize(current.call, checks)
    await assertCurrentState(current, 'final', 'recorded')
    await fs.appendFile(target, '\n新的适用条件。\n', 'utf8')
    await assertCurrentState(current, 'draft', 'pending')
    assert.equal((await current.readBook()).chapters[0].status, 'final')
    assert.equal((await current.readBook()).chapters[0].deaiReview.status, 'recorded')
  })
}

test('来源覆盖要求变化会失效，未引用且不相关的资料不误伤复核', async t => {
  const current = await fixture(t)
  await finalize(current.call)
  await fs.mkdir(path.join(current.root, 'settings'))
  await fs.writeFile(path.join(current.root, 'settings/无关设定.md'), '# 无关设定\n\n一个不在正文中的地方。\n', 'utf8')
  await assertCurrentState(current, 'final', 'recorded')
  await fs.writeFile(path.join(current.root, 'settings/七号炉.md'), '# 七号炉\n\n运行条件。\n', 'utf8')
  await assertCurrentState(current, 'draft', 'pending')
})

test('人物别名新增正文命中时，来源覆盖要求也必须重新复核', async t => {
  const current = await fixture(t)
  const card = path.join(current.root, 'characters/旁人.md')
  await fs.mkdir(path.dirname(card))
  await fs.writeFile(card, '# 旁人\n\n- ID：bystander\n', 'utf8')
  await finalize(current.call)
  await fs.appendFile(card, '- 别名：他\n', 'utf8')
  await assertCurrentState(current, 'draft', 'pending')
})

test('启用与取消文风使用当前名称核验，精确恢复约束可重新有效', async t => {
  const current = await fixture(t)
  await finalize(current.call)
  await fs.mkdir(path.join(current.root, 'styles'))
  await fs.writeFile(path.join(current.root, 'styles/新文风.md'), '# 新文风\n\n- 少总结。\n', 'utf8')
  assert.equal((await current.request('/novel-api/style-active', { name: '新文风' })).status, 200)
  await assertCurrentState(current, 'draft', 'pending')
  assert.equal((await current.request('/novel-api/style-active', { name: '' })).status, 200)
  await assertCurrentState(current, 'final', 'recorded')
})

test('旧记录可沿用已引用文风指纹，无可验证指纹的旧记录为 pending', async t => {
  const style = '简练'
  const cited = await fixture(t, { style })
  const checks = baseChecks()
  for (const aspect of ['narration', 'rhythm']) checks[aspect].evidence.push({ source: 'style', name: style, quote: '少总结。' })
  await finalize(cited.call, checks)
  const book = await cited.readBook()
  assert.match(book.chapters[0].deaiReview.styleHash, /^[a-f0-9]{64}$/u)
  delete book.chapters[0].deaiReview.styleHash
  await fs.writeFile(path.join(cited.root, 'book.json'), JSON.stringify(book), 'utf8')
  await assertCurrentState(cited, 'final', 'recorded')
  await fs.appendFile(path.join(cited.root, `styles/${style}.md`), '\n- 少排比。\n', 'utf8')
  await assertCurrentState(cited, 'draft', 'pending')

  const uncited = await fixture(t, { style })
  const skippedChecks = baseChecks()
  skippedChecks.narration.verdict = 'not-applicable'
  skippedChecks.rhythm.verdict = 'not-applicable'
  await finalize(uncited.call, skippedChecks)
  const oldBook = await uncited.readBook()
  delete oldBook.chapters[0].deaiReview.styleHash
  await fs.writeFile(path.join(uncited.root, 'book.json'), JSON.stringify(oldBook), 'utf8')
  await assertCurrentState(uncited, 'draft', 'pending')
})

test('导入只增减末尾空白也按精确落盘正文使复核失效', async t => {
  const body = `${BODY}\n`
  const current = await fixture(t, { body })
  await registerReview(current.call)
  await current.call('novel_write', { chapter: '0001', content: body, status: 'final' })
  const source = path.join(current.root, 'source.txt')
  await fs.writeFile(source, `第一章\n${BODY}`, 'utf8')
  await current.call('novel_import', { source, ranges: [{ title: '第一章', from: 2, to: 4 }], replace: true })
  assert.equal(await fs.readFile(path.join(current.root, 'chapters/0001.md'), 'utf8'), BODY)
  assert.equal((await current.readBook()).chapters[0].status, 'draft')
  await assertCurrentState(current, 'draft', 'pending')
})

test('跳过和空来源覆盖不改已定稿正文、声明、备注或历史', async t => {
  const current = await fixture(t)
  await finalize(current.call)
  const book = await current.readBook()
  book.chapters[0].note = '作者批注'
  await fs.writeFile(path.join(current.root, 'book.json'), JSON.stringify(book), 'utf8')
  const before = await fs.readFile(path.join(current.root, 'book.json'), 'utf8')
  const historyBefore = await fs.readdir(path.join(current.root, 'chapters/.history'))
  const source = path.join(current.root, 'source.txt')
  await fs.writeFile(source, '第一章\n替代正文。\n', 'utf8')
  const skipped = await current.call('novel_import', { source, ranges: [{ title: '第一章', from: 2, to: 2 }], status: 'draft' })
  assert.equal(skipped.imported, 0)
  await fs.writeFile(source, '第一章\n\n', 'utf8')
  const empty = await current.call('novel_import', { source, ranges: [{ title: '第一章', from: 2, to: 2 }], replace: true, status: 'draft' })
  assert.equal(empty.imported, 0)
  assert.match(empty.warnings.join('\n'), /未覆盖/u)
  assert.equal(await fs.readFile(path.join(current.root, 'book.json'), 'utf8'), before)
  assert.equal(await fs.readFile(path.join(current.root, 'chapters/0001.md'), 'utf8'), BODY)
  assert.deepEqual(await fs.readdir(path.join(current.root, 'chapters/.history')), historyBefore)
  await assertCurrentState(current, 'final', 'recorded')
})

test('草稿恢复到有效复核正文仍需显式定稿，恢复前内容可撤销', async t => {
  const current = await fixture(t)
  await finalize(current.call)
  await current.call('novel_write', { chapter: '0001', content: CHANGED_BODY })
  const history = await current.call('novel_history', { chapter: '0001' })
  const restored = await current.call('novel_restore', { chapter: '0001', version: history.versions[0].version })
  assert.equal(restored.status, 'draft')
  assert.ok(restored.snapshot)
  const beforeRestore = await current.call('novel_history', { chapter: '0001', version: restored.snapshot.version })
  assert.equal(beforeRestore.content, CHANGED_BODY)
  await assertCurrentState(current, 'draft', 'recorded')
  await current.call('novel_write', { chapter: '0001', content: BODY, status: 'final' })
  await assertCurrentState(current, 'final', 'recorded')
})

test('HTTP 恢复未复核正文返回 draft 并保留恢复前的完整正文', async t => {
  const current = await fixture(t)
  await finalize(current.call)
  const version = await seedVersion(current.root, CHANGED_BODY)
  const restored = await current.request('/novel-api/restore', { chapter: '0001', version })
  assert.equal(restored.status, 200)
  assert.equal(restored.value.status, 'draft')
  assert.ok(restored.value.snapshot)
  const kept = await current.call('novel_history', { chapter: '0001', version: restored.value.snapshot.version })
  assert.equal(kept.content, BODY)
  await assertCurrentState(current, 'draft', 'pending')
})

for (const body of ['\n\t  ', '（待写）炉前的交涉']) {
  test(`空白或占位正文写入和恢复均为 planned：${JSON.stringify(body)}`, async t => {
    const current = await fixture(t)
    await finalize(current.call)
    const version = await seedVersion(current.root, body)
    const restored = await current.request('/novel-api/restore', { chapter: '0001', version })
    assert.equal(restored.status, 200)
    assert.equal(restored.value.status, 'planned')
    assert.equal((await current.readBook()).chapters[0].status, 'planned')
    const written = await current.call('novel_write', { chapter: '0001', content: body, status: 'draft' })
    assert.equal(written.status, 'planned')
    assert.equal((await current.call('novel_status')).chapters[0].status, 'planned')
  })
}

const INVALID_REVIEWS = [
  ['旧协议', review => { review.version = 5 }],
  ['缺 checks', review => { delete review.checks.voice }],
  ['缺 observations', review => { delete review.observations }],
  ['缺 scenes', review => { review.scenes = [] }],
  ['缺 paragraphs', review => { delete review.paragraphs }],
  ['段落未覆盖全文', review => { review.paragraphs = [review.paragraphs[0]]; review.scenes[0].endIndex = 1 }],
  ['段号重复', review => { review.paragraphs[1].index = 1 }],
]

for (const [label, invalidate] of INVALID_REVIEWS) {
  test(`不完整的旧复核不能保持 final：${label}`, async t => {
    const current = await fixture(t)
    await finalize(current.call)
    const book = await current.readBook()
    invalidate(book.chapters[0].deaiReview)
    await fs.writeFile(path.join(current.root, 'book.json'), JSON.stringify(book), 'utf8')
    await assertCurrentState(current, 'draft', 'pending')
  })
}

test('建章入口保留有效 final，纠正失效 final 和缺失正文', async t => {
  const current = await fixture(t)
  await finalize(current.call)
  assert.equal((await current.request('/novel-api/start-chapter', { id: '0001' })).value.status, 'final')
  await fs.writeFile(path.join(current.root, 'chapters/0001.md'), CHANGED_BODY, 'utf8')
  assert.equal((await current.request('/novel-api/start-chapter', { id: '0001' })).value.status, 'draft')
  assert.equal((await current.readBook()).chapters[0].status, 'draft')

  const missing = await fixture(t, { body: '', status: 'final' })
  await fs.rm(path.join(missing.root, 'chapters/0001.md'))
  assert.equal((await missing.call('novel_status')).chapters[0].status, 'planned')
  const started = await missing.request('/novel-api/start-chapter', { id: '0001' })
  assert.equal(started.value.created, true)
  assert.equal(started.value.status, 'draft')

  const empty = await fixture(t, { body: '', status: 'planned' })
  const initialized = await empty.request('/novel-api/start-chapter', { id: '0001' })
  assert.equal(initialized.value.created, false)
  assert.equal(initialized.value.status, 'planned')
  assert.equal(await fs.readFile(path.join(empty.root, 'chapters/0001.md'), 'utf8'), '')
})

test('同文保存后顺延引用章纲，回执与落盘状态使用顺延后的复核', async t => {
  const current = await fixture(t)
  const beat = '- 场景：王桥拿蓝钥匙到石桥折断后留下暗号'
  await fs.writeFile(path.join(current.root, 'beats.md'), `# 章纲\n\n## 0001 第一章\n\n- 场景：七号炉的炉皮在跳\n${beat}\n`, 'utf8')
  const checks = baseChecks()
  checks.continuity.evidence.push({ source: 'beats', quote: beat })
  await finalize(current.call, checks)
  const result = await current.call('novel_write', { chapter: '0001', content: BODY, carryOver: true, status: 'final' })
  assert.ok(result.carriedOver)
  assert.equal(result.status, 'draft')
  assert.match(result.warnings.join('\n'), /当前版本待复核/u)
  assert.match(result.warnings.join('\n'), /final 声明未保留/u)
  const book = await current.readBook()
  assert.equal(book.chapters[0].status, 'draft')
  assert.equal(book.chapters[1].status, 'planned')
  await assertCurrentState(current, 'draft', 'pending')
})
