import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { stageContext } from '../stage.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-timeline-rules-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const chapters = [
    { id: '0001', title: '初见', file: 'chapters/0001.md', status: 'draft' },
    { id: '0002', title: '次日', file: 'chapters/0002.md', status: 'draft' },
    { id: '0003', title: '交货', file: 'chapters/0003.md', status: 'planned' },
  ]
  await fs.mkdir(path.join(root, 'chapters'))
  await fs.mkdir(path.join(root, 'characters'))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '时间线测试', chapters }))
  await fs.writeFile(path.join(root, 'characters/a.md'), '# 主角\n- ID：a\n- 定位：主角\n')
  await fs.writeFile(path.join(root, 'chapters/0001.md'), '约定的交货期限是五日之后。五日之内，必见分晓。\n')
  await fs.writeFile(path.join(root, 'chapters/0002.md'), '他估算了一下，还剩三个时辰。\n')
  await fs.writeFile(path.join(root, 'ledger.md'), `# 台账

| 类别 | 项目 | 当前状态 | 变更章 | 备注 |
| --- | --- | --- | --- | --- |
| 时间 | 交货期限 | 距今五日 | 0001 | 次日为第二日 |
| 时间 | 到港时间 | 已到港 | 0003 | |
| 时间 | 旧期限 | 作废 | 0001 | |
`)
  await fs.writeFile(path.join(root, 'beats.md'), `# 章纲

## 0001 初见

### 场景 s1：定约
- 时序：10
- 故事时间：第一日午后
- 出场：a
#### 人物 a
- 目标：接下修剑单

## 0002 次日

### 场景 s2：开工
- 时序：20
- 故事时间：第二日清晨
- 出场：a
#### 人物 a
- 目标：赶工修剑
`)
  const tools = new Map()
  apply({
    tools: { register: definition => tools.set(definition.name, definition) },
    effect: fn => fn(),
    webServer: { register: () => {} },
  }, { root })
  const call = (name, args = {}) => tools.get(name).execute(args)
  const render = (name, args, value) => tools.get(name).output.render(args, value).map(part => part.text).join('\n')
  return { root, chapters, call, render }
}

test('stageContext 在场景头展示故事时间，novel_context 指令包含自然时间表达纪律', async t => {
  const { root, chapters, call } = await fixture(t)
  const stage = await stageContext(root, chapters, '0002')
  assert.match(stage.text, /时序 20；故事时间 第二日清晨/u)

  const ctx = await call('novel_context', { chapter: '0002' })
  assert.match(ctx.prompt, /时间线纪律/u)
  assert.match(ctx.prompt, /自然相对时间/u)
  assert.match(ctx.prompt, /设定明确允许文内计日/u)
})

test('novel_deai_pack 包含上一章与本章的故事时间及台账时间锚点', async t => {
  const { call, render } = await fixture(t)
  const pack = await call('novel_deai_pack', { chapter: '0002' })
  assert.equal(pack.timelineContext.previousScenes[0].storyTime, '第一日午后')
  assert.equal(pack.timelineContext.currentScenes[0].storyTime, '第二日清晨')
  assert.equal(pack.timelineContext.ledgerTime.length, 1)

  const rendered = render('novel_deai_pack', { chapter: '0002' }, pack)
  assert.match(rendered, /跨章时间线锚点参考/u)
  assert.match(rendered, /上一章 0001\/s1（时序 10）：第一日午后/u)
  assert.match(rendered, /本章 0002\/s2（时序 20）：第二日清晨/u)
  assert.match(rendered, /台账\[时间\] 交货期限：距今五日（@0001｜次日为第二日）/u)
  assert.match(rendered, /novel_read\(\{chapter:"0001"\}\)/u)
  assert.match(rendered, /当前状态快照/u)
  assert.doesNotMatch(rendered, /到港时间|旧期限/u)
})

function reviewInput(pack, sceneId, quote) {
  const check = { verdict: 'supported', detail: '已核对。', counterargument: '已对照本段完整语境。', evidence: [{ source: 'chapter', index: 1, quote }] }
  return {
    chapter: pack.chapter.id,
    baseHash: pack.baseHash,
    checks: { continuity: check, timing: check, voice: check, narration: check, rhythm: check, facts: check },
    observations: [],
    timeBudgets: [],
    scenes: [{ sceneId, startIndex: 1, endIndex: 1, layout: '铺内', mechanism: '无', timeline: '核对时间起点与期限。', actions: [] }],
    paragraphs: [{ index: 1, reason: '正常叙述' }],
  }
}

for (const [chapter, sceneId, quote, availableText, unit, available, content] of [
  ['0001', 's1', '五日之内', '五日', '日', 5],
  ['0002', 's2', '还剩三个时辰', '三个时辰', '时辰', 3],
  ['0002', 's2', '还剩一个半时辰', '一个半时辰', '时辰', 1.5, '他算出离交货还剩一个半时辰。\n'],
  ['0002', 's2', '两个半小时以内', '两个半小时', '小时', 2.5, '须在两个半小时以内交货。\n'],
]) {
  test(`审稿识别并核算「${quote}」时间窗口`, async t => {
    const { root, call } = await fixture(t)
    if (content) await fs.writeFile(path.join(root, 'chapters', `${chapter}.md`), content)
    const pack = await call('novel_deai_pack', { chapter })
    const input = reviewInput(pack, sceneId, quote)
    const candidate = await call('novel_deai_review', input)
    assert.ok(candidate.findings.some(item => item.aspect === 'timing' && item.verdict === 'uncertain' && /候选时间窗口/u.test(item.detail) && item.evidence.some(reference => reference.quote.includes(quote))))

    const evidence = input.checks.timing.evidence
    const result = await call('novel_deai_review', {
      ...input,
      resolutions: { timing: '已逐字引用窗口，未明示的任务耗时按未知登记。' },
      timeBudgets: [{ label: '期限', unit, availableText, evidence, phases: [
        { parallel: false, evidence: [], tasks: [{ label: '核对后续任务', basis: 'unknown', evidence }] },
      ] }],
    })
    assert.equal(result.status, 'recorded')
    assert.equal(result.timingReports[0].available, available)
  })
}

test('跨章时间矛盾可引用前章正文，前章修改后审稿失效', async t => {
  const { root, call } = await fixture(t)
  await fs.writeFile(path.join(root, 'chapters/0002.md'), '次日清晨，他盘算离交货还有五日。\n')
  const pack = await call('novel_deai_pack', { chapter: '0002' })
  const input = reviewInput(pack, 's2', '次日清晨，他盘算离交货还有五日')
  const prior = { source: 'prior-chapter', name: '0001', quote: '约定的交货期限是五日之后' }
  const detail = '同一交货期限在次日仍按五日计算，多算了一日。'
  const counterargument = '前章约定后未见延期，本章明确是次日。'
  const evidence = [...input.checks.timing.evidence, prior]
  input.checks.timing = { verdict: 'conflict', detail, counterargument, evidence }
  input.observations = [{
    aspect: 'timing', classification: 'conflict', detail, counterargument, evidence,
    comparison: { entity: '交货约定', property: '剩余天数', timeScope: '定约当日至次日' },
  }]

  await assert.rejects(call('novel_deai_review', {
    ...input,
    checks: { ...input.checks, timing: { ...input.checks.timing, evidence: [evidence[0], { ...prior, name: '0003' }] } },
  }), /当前章之前的章节 ID/u)
  const result = await call('novel_deai_review', input)
  assert.equal(result.status, 'blocked')
  assert.ok(result.evidenceContexts.some(item => item.source === 'prior-chapter' && item.name === '0001' && item.context.includes(prior.quote)))
  assert.equal((await call('novel_check', { chapter: '0002' })).deaiReview.status, 'blocked')
  await fs.writeFile(path.join(root, 'chapters/0001.md'), '交货日期改到六日之后。\n')
  assert.equal((await call('novel_check', { chapter: '0002' })).deaiReview.status, 'pending')
})
