// Optional real-browser QA. Install react/react-dom/esbuild/playwright in an external
// directory, then: node tests/stage-v2-browser.mjs <that-directory> [browser-executable]
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const qa = path.resolve(process.argv[2])
const require = createRequire(path.join(qa, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-v2-browser-'))
let browser
let server
try {
  for (const dir of ['characters', 'chapters']) await fs.mkdir(path.join(root, dir))
  const chapters = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1).padStart(4, '0'), title: `客栈对质 ${i + 1}`, file: `chapters/${String(i + 1).padStart(4, '0')}.md` }))
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify({ title: '界面验收', chapters }))
  for (const c of chapters) await fs.writeFile(path.join(root, c.file), '她接过茶，露出旧手表。')
  for (const [id, name] of [['a', '主角'], ['b', '女主']]) await fs.writeFile(path.join(root, 'characters', `${name}.md`), `# ${name}\n- ID：${id}\n- 定位：${name}\n- 重要程度：核心`)
  await fs.writeFile(path.join(root, 'events.md'), '## main：主线\n### main-1 追问信物\n- 目标：追查来源\n')
  await fs.writeFile(path.join(root, 'beats.md'), chapters.map((c, i) => `## ${c.id} ${c.title}
- 本章目标：让女主怀疑救援与家族有关。
### 场景 scene-${c.id}：信物出现
- 时序：${i * 10}
- 视角：a
- 叙述方式：限知
- 出场：a、b
- 事件：main-1
- 冲突：主角追问，女主回避。
- 结果：双方暂时达成合作。
#### 人物 a
- 目标：找到线索
#### 人物 b
- 心理内容：担心对方识破来意。
- 视角权限：仅作者参考
- 登场性质：首次正式登场
- 描写重点：旧手表
- 自定义备注：保留我
`).join('\n'))
  let handler
  apply({ tools: { register() {} }, effect: fn => fn(), webServer: { register: value => { handler = value.handler } } }, { root })
  let source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
  source = source.replace("    exports.name = 'novel'", "    window.__BeatTest = { BeatsPane, CSS };\n    exports.name = 'novel'")
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
window.__ModuleLoader__={load: def=>def.factory(name=>{if(name==='react') return React; throw Error(name)})};
${source}
const style=document.createElement('style');style.textContent=window.__BeatTest.CSS;document.head.append(style);
createRoot(document.getElementById('root')).render(React.createElement(window.__BeatTest.BeatsPane));`, resolveDir: qa }, bundle: true, write: false, format: 'iife' })
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/novel-api')) { void handler(req, res); return }
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><style>html,body,#root{height:100%;margin:0}body{font-family:Arial;color:#222;background:#fff;--dsw-alias-border-l1:#ddd;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666}</style><div id="root"></div><script src="/app.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) })
  const page = await browser.newPage({ viewport: { width: 360, height: 760 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: '人物 2', exact: true }).last().waitFor()
  assert.equal(await page.getByText('担心对方识破来意。', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '人物 2', exact: true }).last().scrollIntoViewIfNeeded()
  const position = await page.locator('.nvl-outline').first().evaluate(el => el.scrollTop)
  assert.ok(position > 0)
  await page.screenshot({ path: path.join(qa, 'v2-outline.png') })
  await page.getByRole('button', { name: '人物 2', exact: true }).last().click()
  await page.getByRole('button', { name: '女主 · 女主', exact: true }).click()
  await page.getByRole('button', { name: '编辑本场人物 / 恢复草稿' }).click()
  await page.getByLabel('心理内容', { exact: true }).fill('怕牵连对方，决定先试探。')
  await page.getByRole('button', { name: '← 返回', exact: true }).click()
  await page.getByRole('button', { name: '← 返回', exact: true }).click()
  assert.ok(Math.abs(await page.locator('.nvl-outline').first().evaluate(el => el.scrollTop) - position) < 2)
  await page.getByRole('button', { name: '人物 2', exact: true }).last().click()
  await page.getByRole('button', { name: '女主 · 女主', exact: true }).click()
  await page.getByRole('button', { name: '编辑本场人物 / 恢复草稿' }).click()
  assert.equal(await page.getByLabel('心理内容', { exact: true }).inputValue(), '怕牵连对方，决定先试探。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByLabel('心理内容', { exact: true }).waitFor({ state: 'detached' })
  const changed = await fs.readFile(path.join(root, 'beats.md'), 'utf8')
  assert.match(changed, /怕牵连对方，决定先试探/)
  assert.equal((changed.match(/自定义备注：保留我/g) || []).length, 12)
  await page.screenshot({ path: path.join(qa, 'v2-person.png') })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.getByRole('button', { name: '← 返回', exact: true }).click()
  await page.getByRole('button', { name: '← 返回', exact: true }).click()
  await page.getByRole('button', { name: '事件线 1', exact: true }).last().click()
  await page.getByRole('heading', { name: '追问信物' }).waitFor()
  await page.getByRole('button', { name: '关联场景：信物出现' }).click()
  await page.getByLabel('冲突', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: 360px outline, secondary navigation, scroll restoration, draft retention, field save, event→scene; no browser errors.')
  console.log(`Screenshots: ${qa}`)
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await fs.rm(root, { recursive: true, force: true })
}
