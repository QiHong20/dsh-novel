/**
 * dsh-novel —— 小说助手 · 客户端半边（浏览器 / Web 壳侧）
 *
 * 这是「已构建的客户端 bundle」格式，不是普通 ES 模块：宿主把它作为
 * `<pkg>/client` 导出路由到 /plugins/??<combo>&rev=<revision>，浏览器侧由
 * window.__ModuleLoader__ 惰性求值。factory 收到的 require 只能命中平台基座
 * （react / react-dom / cordis / 静态 UI 库），所以这里不 import 任何别的包。
 *
 * 两个座位：
 *   1. conversation.input.dock —— 一条常驻状态：书名 / 章数 / 字数
 *   2. sidebar.right.pane.tab  —— 「小说章节」页：章节树 + 字数 + 点开看正文
 * 数据统一来自宿主注册的只读路由 /novel-api（见 index.js）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-novel',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const TAB_ID = 'dsh-novel/chapters'
    const TAB_KIND = 'novel-chapters'
    const API = '/novel-api'

    // 一个 dsh web 进程里可能有多个工作区/会话。宿主按「会话 cwd」找书，
    // 所以每个请求都要告诉它「我是哪个会话」——否则右栏只会显示进程目录那本书。
    let currentSessionId = ''
    function noteSession(id) {
      if (typeof id !== 'string' || id === '' || id === currentSessionId) return
      currentSessionId = id
      try {
        window.dispatchEvent(new Event('nvl-session'))
      } catch {}
    }
    function apiPath(pathname) {
      if (!currentSessionId) return pathname
      // 已经带过就别重复追加（getJson 里有的调用自己拼过 session）
      if (pathname.includes('session=')) return pathname
      const join = pathname.includes('?') ? '&' : '?'
      return `${pathname}${join}session=${encodeURIComponent(currentSessionId)}`
    }

    /** 右栏内部「上一步」：每开一屏压一格历史，返回键先退这一格，退完才离开页面。 */
    const navSteps = []
    let navSkip = 0

    function onNovelPopState() {
      if (navSkip > 0) {
        navSkip -= 1
        return
      }
      const step = navSteps.pop()
      if (!step) return
      try {
        step.close()
      } catch (error) {
        // 单屏回退失败不该把页面顶掉
      }
    }

    function pushNavStep(close) {
      const entry = { close }
      navSteps.push(entry)
      try {
        window.history.pushState({ dshNovelStep: navSteps.length }, '')
      } catch (error) {
        // 内嵌 WebView 可能禁 pushState：退化成没有历史栈，不报错
      }
      return entry
    }

    function dropNavStep(entry) {
      const index = navSteps.lastIndexOf(entry)
      if (index < 0) return
      const isTop = index === navSteps.length - 1
      navSteps.splice(index, 1)
      if (!isTop) return
      navSkip += 1
      try {
        window.history.back()
      } catch (error) {
        navSkip = Math.max(0, navSkip - 1)
      }
    }

    /** open 为真时占一格历史；返回键或自己关掉都会把这一格收回去。 */
    const READING_KEY = 'dsh-novel:reading'
    const READING_DEFAULT = { size: 16, line: 1.9, theme: 'auto', padding: 'normal' }
    const READING_THEMES = ['auto', 'sepia', 'dark']
    const READING_PADDING = ['compact', 'normal', 'wide']

    function pickNumber(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, number))
    }

    function readReading() {
      try {
        const raw = window.localStorage.getItem(READING_KEY)
        if (!raw) return { ...READING_DEFAULT }
        const value = JSON.parse(raw)
        return {
          size: pickNumber(value.size, 13, 24, READING_DEFAULT.size),
          line: pickNumber(value.line, 1.4, 2.6, READING_DEFAULT.line),
          theme: READING_THEMES.includes(value.theme) ? value.theme : 'auto',
          padding: READING_PADDING.includes(value.padding) ? value.padding : 'normal',
        }
      } catch (error) {
        return { ...READING_DEFAULT }
      }
    }

    /** 阅读设置是全局的：所有右栏页共用一份，改完广播出去让别的屏同步。 */
    function useReading() {
      const [value, setValue] = useState(readReading)
      useEffect(() => {
        const sync = () => setValue(readReading())
        window.addEventListener('nvl-reading', sync)
        return () => window.removeEventListener('nvl-reading', sync)
      }, [])
      const update = useCallback(patch => {
        const next = { ...readReading(), ...patch }
        try {
          window.localStorage.setItem(READING_KEY, JSON.stringify(next))
        } catch (error) {
          // 隐私模式下 localStorage 可能不可写，那就只在本次会话生效
        }
        setValue(next)
        try {
          window.dispatchEvent(new Event('nvl-reading'))
        } catch (error) {
          // 广播失败不影响本屏
        }
      }, [])
      return [value, update]
    }

    function Segmented({ label, options, value, onPick }) {
      return h(
        'div',
        { className: 'nvl-tool-group' },
        h('span', { className: 'nvl-tool-label' }, label),
        h(
          'div',
          { className: 'nvl-seg' },
          options.map(option =>
            h(
              'button',
              {
                key: option.value,
                type: 'button',
                className: 'nvl-seg-btn',
                'data-active': String(option.value) === String(value),
                onClick: () => onPick(option.value),
              },
              option.label,
            ),
          ),
        ),
      )
    }

    function useBackStep(open, close) {
      const latest = React.useRef(close)
      latest.current = close
      React.useEffect(() => {
        if (!open) return undefined
        const entry = pushNavStep(() => latest.current())
        return () => dropNavStep(entry)
      }, [open])
    }

    const CSS = `
.nvl-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 420px;
  padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
}
.nvl-pill-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-pill-dot[data-state="empty"] { background: var(--dsw-alias-label-secondary); }
.nvl-pill-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary, #d9534f); }
.nvl-pill-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nvl-pill-strong { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }

.nvl-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
/* 平台的 tab 条：可横向滚动，但 touch-action:none 让手机上根本滑不动，
   九个页面挤成一条时最左边的「章节」会被顶出屏幕、也够不回来。 */
/* 注意：不要用 *:has([data-dockkit-tab]) 这类宽选择器去改 overflow ——
   body / 布局根节点都「含有」chip，会被一起改成可滚容器，窄屏下连打开右栏的按钮都被裁掉。
   滚动能力只在 wireTabStrip() 里对那一条条子（inline style + nvl-tabstrip 类）单独打开。 */
/* chip 默认 min-width:80px，九个就是 720px：窄屏下允许压窄，别把首项挤出屏。 */
[data-dockkit-tab] { min-width: 0 !important; }
/* 让条上有一条细滚动条，至少看得出「还有东西在右边/左边」 */
.nvl-tabstrip { scrollbar-width: thin !important; touch-action: pan-x !important; -webkit-overflow-scrolling: touch; }
@media (max-width: 480px) {
  [data-dockkit-tab] { padding: 0 6px !important; font-size: 12px !important; }
}
.nvl-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.nvl-title { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.nvl-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-left: auto; }
.nvl-body { flex: 1; min-height: 0; overflow: auto; padding: 6px 0 12px; }
.nvl-row {
  display: flex; align-items: baseline; gap: 8px;
  width: 100%; padding: 6px 12px; border: 0; background: none;
  text-align: left; cursor: pointer; color: inherit; font: inherit;
}
.nvl-row:hover { background: var(--dsw-alias-bg-layer-1); }
.nvl-row-id { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; font-size: 12px; flex: none; }
.nvl-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nvl-row-chars { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: none; font-variant-numeric: tabular-nums; }
.nvl-row-drift { flex: none; margin-right: 6px; padding: 0 5px; border-radius: 999px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-error-primary, #e0483e); border: 1px solid currentColor; }
.nvl-row[data-status="planned"] { opacity: 0.64; }
.nvl-row[data-placeholder="true"] { opacity: 0.8; }
.nvl-row[data-placeholder="true"] .nvl-row-chars { color: var(--dsw-alias-label-secondary); font-style: italic; }
.nvl-row[data-placeholder="true"] .nvl-row-title { color: var(--dsw-alias-label-secondary); }
.nvl-row[data-status="planned"] .nvl-row-chars { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-row:disabled { cursor: default; opacity: 0.5; }
.nvl-row[data-status="final"] .nvl-row-id { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-row[data-empty="true"] .nvl-row-title { color: var(--dsw-alias-label-secondary); }
.nvl-empty { padding: 16px 12px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }
.nvl-empty code { font-size: 12px; }
.nvl-err { color: var(--dsw-alias-state-error-primary, #d9534f); }
.nvl-reader { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.nvl-reader-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.nvl-back {
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: inherit; font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 8px; cursor: pointer;
}
.nvl-reader-body {
  flex: 1; min-height: 0; overflow: auto; padding: 14px 16px;
  padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  white-space: pre-wrap; line-height: 1.9; color: var(--dsw-alias-label-primary, inherit);
  -webkit-text-size-adjust: 100%;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.nvl-reader-body[data-padding="compact"] { padding: 8px 10px calc(12px + env(safe-area-inset-bottom, 0px)); }
.nvl-reader-body[data-padding="wide"] { padding: 20px 24px calc(24px + env(safe-area-inset-bottom, 0px)); }
.nvl-reader-body[data-theme="sepia"] { background: #f6ecd9; color: #3a2f1f; }
.nvl-reader-body[data-theme="sepia"] .nvl-md, .nvl-reader-body[data-theme="sepia"] .nvl-md a { color: #3a2f1f; }
.nvl-reader-body[data-theme="dark"] { background: #17181b; color: #d6d6da; }
.nvl-reader-body[data-theme="dark"] .nvl-md { color: #d6d6da; }
.nvl-reader-body[data-theme="dark"] .nvl-md a { color: #8fa6ff; }
.nvl-reader-body .nvl-md p { text-align: justify; text-justify: inter-ideograph; }
.nvl-reader-tools {
  display: flex; flex-wrap: wrap; gap: 8px 14px; padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.nvl-tool-group { display: flex; align-items: center; gap: 6px; }
.nvl-tool-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nvl-aa {
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: inherit; font: inherit; font-size: 13px; font-weight: 600; padding: 2px 9px;
  border-radius: 8px; cursor: pointer; margin-left: auto;
}
.nvl-aa[data-active="true"] { border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-aa:disabled { opacity: .55; cursor: default; }
@media (pointer: coarse) {
  .nvl-back, .nvl-aa { min-height: 34px; padding: 4px 12px; font-size: 13px; }
  .nvl-seg-btn { min-height: 32px; padding: 4px 11px; font-size: 12.5px; }
/* 「更多」页顶部的分段切换：贴着面板上沿，别抢正文字数 */
.nvl-seg-top { margin: 0 0 6px; flex: none; flex-wrap: wrap; gap: 4px; }
.nvl-meta { font-size: 12px; color: var(--dsw-alias-text-secondary); padding: 0 0 6px; }
.nvl-audit-tally { font-size: 12px; padding: 4px 0 8px; color: var(--dsw-alias-text-secondary); }
.nvl-audit-tally[data-tone="err"] { color: var(--dsw-alias-state-error-primary); }
.nvl-audit-row { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 13px; line-height: 1.5; }
.nvl-audit-kind { flex: none; min-width: 82px; font-size: 11px; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.nvl-audit-row[data-level="error"] .nvl-audit-kind { color: var(--dsw-alias-state-error-primary); }
.nvl-audit-text { flex: 1; min-width: 0; word-break: break-word; }
.nvl-seg-top .nvl-seg-btn { min-height: 26px; padding: 2px 9px; font-size: 12px; }
  .nvl-reader-head { padding: 10px 12px; }
}
@media (max-width: 480px) {
  .nvl-reader-head .nvl-meta { display: none; }
  .nvl-reader-tools { gap: 6px 10px; }
  .nvl-ask-input { min-height: 40px; }
  .nvl-ask-btn { min-height: 36px; padding: 0 14px; }
}
.nvl-bar { height: 3px; background: var(--dsw-alias-bg-layer-1); border-radius: 2px; overflow: hidden; margin-top: 6px; }
.nvl-bar-fill { height: 100%; background: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-seg { display: flex; gap: 4px; flex: none; }
.nvl-seg-btn {
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
}
.nvl-seg-btn[data-active="true"],
.nvl-seg-btn[data-on="true"] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-brand-primary-bg, rgba(77, 107, 254, 0.10));
}
.nvl-seg-btn[data-on="true"] { font-weight: 600; }
.nvl-seg-btn:disabled { opacity: 0.5; cursor: default; }
.nvl-card {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start; width: 100%;
  border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: inherit; font: inherit; text-align: left; padding: 8px 12px; cursor: pointer;
}
.nvl-card:hover { background: var(--dsw-alias-bg-layer-1); }
.nvl-card-name { font-weight: 600; }
.nvl-card-sum { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.nvl-card-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.nvl-graph { padding: 8px 4px 12px; }
.nvl-svg { width: 100%; height: auto; display: block; }
.nvl-edge { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
.nvl-edge { stroke-width: 1; }
.nvl-arrow { fill: var(--dsw-alias-border-l1); }
.nvl-edge-label-bg { fill: var(--dsw-alias-bg-layer-1); opacity: .88; }
.nvl-edge-label { fill: var(--dsw-alias-label-secondary); font-size: 8px; }
.nvl-graph-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; }
.nvl-graph-bar { display: flex; align-items: center; gap: 6px; padding: 2px 8px 0; flex: none; }
.nvl-select {
  font: inherit; font-size: 11px; padding: 2px 4px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary, inherit);
}
.nvl-node { fill: var(--dsw-alias-brand-primary, #4d6bfe); cursor: pointer; }
.nvl-node-ghost { fill: none; stroke: var(--dsw-alias-label-secondary); stroke-dasharray: 3 2; stroke-width: 1.2; }
.nvl-node-dead { fill: var(--dsw-alias-label-secondary); opacity: .5; }
.nvl-edge-dead { stroke-dasharray: 4 3; opacity: .55; }
.nvl-card-dead { margin-left: 6px; padding: 0 4px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1); font-size: 10px; font-weight: 400; color: var(--dsw-alias-label-secondary); vertical-align: middle; }
  .nvl-card-due { margin-left: 6px; padding: 0 4px; border-radius: 3px; border: 1px solid var(--dsw-alias-brand-primary, #4d6bfe); font-size: 10px; font-weight: 400; color: var(--dsw-alias-brand-primary, #4d6bfe); vertical-align: middle; }
.nvl-node-label { fill: var(--dsw-alias-label-primary, inherit); font-size: 9px; }
.nvl-hint { padding: 0 12px 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.nvl-hint[data-tone="ok"] { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-hint[data-tone="err"] { color: #d9534f; }
.nvl-editor {
  flex: 1; min-height: 200px; width: 100%; box-sizing: border-box; resize: none;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px;
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 13px;
  line-height: 1.7; outline: none;
}
.nvl-editor:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-outline { flex: 1; min-height: 0; padding: 4px 12px 12px; overflow: auto; }
.nvl-outline-sec { padding: 8px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.nvl-outline-sec:last-child { border-bottom: 0; }
.nvl-outline-title { font-weight: 600; margin-bottom: 4px; }
.nvl-outline-body { white-space: pre-wrap; line-height: 1.7; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.nvl-chapter-nav { display: flex; align-items: center; gap: 8px; padding: 6px 12px 0; flex: none; }
.nvl-nav-btn { flex: 1 1 0; min-height: 32px; padding: 4px 10px; font-size: 13px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: inherit; cursor: pointer; }
.nvl-nav-btn:disabled { opacity: .38; cursor: default; }
.nvl-nav-pos { flex: none; font-size: 11px; color: var(--dsw-alias-text-secondary); font-variant-numeric: tabular-nums; }
@media (pointer: coarse) { .nvl-nav-btn { min-height: 38px; font-size: 14px; } }
.nvl-exp { flex: none; display: flex; flex-direction: column; gap: 6px; margin: 0 12px 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, transparent); }
.nvl-exp-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.nvl-exp-label { flex: none; min-width: 34px; font-size: 12px; color: var(--dsw-alias-text-secondary); }
.nvl-exp-note { font-size: 12px; color: var(--dsw-alias-text-secondary); }
.nvl-exp-input { flex: 1 1 90px; min-width: 0; height: 30px; }
.nvl-exp-dash { color: var(--dsw-alias-text-secondary); }
.nvl-download { display: inline-flex; align-items: center; justify-content: center; min-height: 30px; padding: 4px 14px; border-radius: 8px; font-size: 13px; text-decoration: none; }
.nvl-ask { border-top: 1px solid var(--dsw-alias-border-l1); padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 6px; flex: none; }
.nvl-ask-input {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 40px; max-height: 120px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 9px;
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; font-size: 13px;
  line-height: 1.6; outline: none;
}
.nvl-ask-input:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-ask-row { display: flex; align-items: center; gap: 8px; }
.nvl-ask-btn {
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; flex: none;
}
.nvl-ask-btn[data-kind="primary"] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.nvl-ask-btn:disabled { opacity: 0.45; cursor: default; }
.nvl-ask-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; }
.nvl-ask-hint[data-tone="ok"] { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-ask-hint[data-tone="err"] { color: #d9534f; }
.nvl-beats {
  flex: none; margin: 10px 12px 0; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.nvl-beats-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.nvl-beats-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: 0.02em; }
.nvl-beats-body { white-space: pre-wrap; font-size: 12.5px; line-height: 1.7; }
.nvl-beats-body[data-empty="true"] { color: var(--dsw-alias-label-secondary); }
.nvl-beats-edit {
  width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px;
  background: transparent; color: inherit; font: inherit; font-size: 12.5px; line-height: 1.7; outline: none;
}
.nvl-beats-edit:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-beats-foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.nvl-beat-sec { padding: 9px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.nvl-beat-sec:last-child { border-bottom: 0; }
.nvl-beat-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.nvl-beat-title { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.nvl-beat-body { white-space: pre-wrap; font-size: 12.5px; line-height: 1.75; }
.nvl-beat-body[data-empty="true"] { color: var(--dsw-alias-label-secondary); }
.nvl-mark {
  margin-left: auto; margin-right: 6px; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; line-height: 16px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
}
.nvl-rhythm { padding: 0 12px 6px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.nvl-rhythm[data-tone="err"] { color: var(--dsw-alias-state-error-primary, #d2483f); }
/* 事件线：章纲页右缘的窄泳道 + 图例 */
.nvl-lanes { display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; flex: none; }
.nvl-lane-dot { width: 7px; height: 7px; border-radius: 999px; border: 1.4px solid; box-sizing: border-box; }
.nvl-lanes-legend {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 0 12px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary);
}
.nvl-lanes-label { opacity: .7; }
.nvl-lane-chip { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.nvl-lane-swatch { width: 8px; height: 8px; border-radius: 3px; display: inline-block; flex: none; }
/* 事件线页 */
.nvl-ev-line { padding: 10px 0 6px; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.nvl-ev-line:last-child { border-bottom: 0; }
.nvl-ev-head { display: flex; align-items: center; gap: 6px; }
.nvl-ev-name { font-weight: 600; font-size: 13px; }
.nvl-ev-meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nvl-ev-goal { margin: 2px 0 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.nvl-ev-row { padding: 6px 0 4px 12px; border-left: 2px solid var(--dsw-alias-border-l1); margin: 4px 0 0 3px; }
.nvl-ev-row[data-status="已写完"] { border-left-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-ev-row-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.nvl-ev-id { font-size: 11px; padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.nvl-ev-title { font-size: 12.5px; font-weight: 600; }
.nvl-ev-span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nvl-ev-status { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.nvl-ev-why { font-size: 11.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); padding-left: 2px; }
.nvl-ev-chapters { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.nvl-ev-chapter {
  font-size: 10.5px; padding: 0 5px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
}
.nvl-ev-chapter[data-written="true"] { color: var(--dsw-alias-brand-primary, #4d6bfe); border-color: currentColor; }
.nvl-set-sec { padding: 8px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.nvl-set-sec:last-child { border-bottom: 0; }
.nvl-scroll { flex: 1; min-height: 0; overflow: auto; }
.nvl-input {
  flex: 1; min-width: 0; padding: 4px 8px; font: inherit; font-size: 12.5px;
  color: inherit; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
}
.nvl-primary, .nvl-ghost {
  padding: 2px 10px; font: inherit; font-size: 12px; line-height: 20px;
  border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1);
  background: none; color: inherit;
}
.nvl-primary { background: var(--dsw-alias-brand-primary, #4d6bfe); border-color: transparent; color: #fff; }
.nvl-danger {
  padding: 2px 10px; font: inherit; font-size: 12px; line-height: 20px;
  border-radius: 6px; cursor: pointer; background: none;
  border: 1px solid var(--dsw-alias-state-error-primary, #e0483e);
  color: var(--dsw-alias-state-error-primary, #e0483e);
}
.nvl-danger[disabled] { opacity: .5; cursor: default; }
.nvl-primary[disabled], .nvl-ghost[disabled] { opacity: .5; cursor: default; }
.nvl-style-sec { padding: 8px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.nvl-style-sec:last-child { border-bottom: 0; }
.nvl-style-head {
  display: flex; align-items: baseline; gap: 6px; width: 100%;
  padding: 0; border: 0; background: none; cursor: pointer; text-align: left;
  font: inherit; color: inherit;
}
.nvl-style-name { font-size: 12.5px; font-weight: 600; }
.nvl-style-head[data-open="true"] .nvl-style-name { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-style-on {
  padding: 0 5px; border-radius: 4px; font-size: 10.5px; line-height: 15px;
  color: #fff; background: var(--dsw-alias-brand-primary, #4d6bfe);
}
.nvl-style-chars { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nvl-style-chip { margin-left: 6px; padding: 0 6px; font-size: 10.5px; line-height: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); }
.nvl-style-sample { margin-top: 8px; padding: 8px 10px; border-left: 2px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 4px; }
.nvl-style-sample-head { margin-bottom: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nvl-style-sum { margin-top: 2px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.nvl-style-body { margin-top: 6px; }
.nvl-style-editor { width: 100%; min-height: 220px; }
.nvl-style-actions { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.nvl-style-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nvl-style-new { display: flex; gap: 6px; align-items: center; padding: 10px 0 4px; }
.nvl-set-head {
  display: flex; align-items: baseline; gap: 6px; width: 100%;
  padding: 0; border: 0; background: none; cursor: pointer; text-align: left;
  font: inherit; color: inherit;
}
.nvl-set-name { font-size: 12.5px; font-weight: 600; }
.nvl-set-head[data-open="true"] .nvl-set-name { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-set-cat {
  padding: 0 5px; border-radius: 4px; font-size: 10.5px; line-height: 15px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
}
.nvl-set-chars { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.nvl-set-sum {
  margin-top: 2px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nvl-set-body { margin-top: 6px; }
.nvl-set-text { white-space: pre-wrap; font-size: 12.5px; line-height: 1.75; }
.nvl-set-text[data-empty="true"] { color: var(--dsw-alias-label-secondary); }
/* 小说伏笔页 */
.nvl-th-list { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.nvl-th-warn { font-size: 11.5px; color: #c2410c; background: rgba(194, 65, 12, 0.09); border-radius: 6px; padding: 6px 8px; }
.nvl-th-sec { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 6px 0 2px; }
.nvl-th-sec[data-done="true"] { opacity: .72; margin-top: 6px; }
.nvl-th-row { display: flex; align-items: flex-start; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 9px; }
.nvl-th-row[data-due="true"] { border-color: rgba(194, 65, 12, 0.45); }
.nvl-th-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; flex: 1; }
.nvl-th-name { font-size: 12.5px; font-weight: 600; word-break: break-word; }
.nvl-th-due { font-size: 10px; color: #c2410c; border: 1px solid rgba(194, 65, 12, 0.45); border-radius: 999px; padding: 0 5px; }
.nvl-th-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nvl-th-btn { flex: none; font-size: 11px; padding: 2px 8px; border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); }
.nvl-th-btn:hover { color: var(--dsw-alias-brand-primary, #4d6bfe); border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-th-btn:disabled { opacity: .5; cursor: default; }

.nvl-md { white-space: normal; line-height: 1.8; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.nvl-md > * + * { margin-top: 8px; }
.nvl-md h1, .nvl-md h2, .nvl-md h3, .nvl-md h4 { margin: 14px 0 6px; line-height: 1.35; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.nvl-md h1 { font-size: 1.32em; }
.nvl-md h2 { font-size: 1.16em; }
.nvl-md h3 { font-size: 1.08em; }
.nvl-md h4 { font-size: 1em; }
.nvl-md p { margin: 0; }
.nvl-reader-body .nvl-md p + p { margin-top: 0.55em; }
.nvl-md ul, .nvl-md ol { margin: 0; padding-left: 20px; }
.nvl-md li + li { margin-top: 3px; }
.nvl-md code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; background: var(--dsw-alias-bg-layer-1); padding: 1px 4px; border-radius: 4px; }
.nvl-md pre { background: var(--dsw-alias-bg-layer-1); padding: 8px 10px; border-radius: 6px; overflow: auto; }
.nvl-md pre code { background: none; padding: 0; }
.nvl-md blockquote { margin: 0; padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.nvl-md table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
.nvl-md th, .nvl-md td { border: 1px solid var(--dsw-alias-border-l1); padding: 4px 6px; text-align: left; vertical-align: top; }
.nvl-md th { background: var(--dsw-alias-bg-layer-1); font-weight: 600; }
.nvl-md a { color: var(--dsw-alias-brand-primary, #4d6bfe); text-decoration: none; }
.nvl-md a:hover { text-decoration: underline; }
.nvl-md hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1); margin: 12px 0; }
.nvl-outline-body.nvl-md, .nvl-beat-body.nvl-md, .nvl-set-text.nvl-md { white-space: normal; line-height: 1.8; color: var(--dsw-alias-label-primary, inherit); font-size: 13px; }
/* 阅读页：字号与行距由 .nvl-reader-body 的行内样式决定，这里只做继承 */
.nvl-reader-body .nvl-md { white-space: normal; font-size: inherit; line-height: inherit; color: inherit; }
.nvl-head .nvl-select { max-width: 150px; }
.nvl-tl { flex: 1; min-height: 0; overflow: auto; padding: 8px 12px 12px; }
.nvl-tl-item { position: relative; padding: 0 0 10px 18px; }
.nvl-tl-item::before { content: ''; position: absolute; left: 4px; top: 10px; bottom: -2px; width: 1px; background: var(--dsw-alias-border-l1); }
.nvl-tl-item:last-child::before { display: none; }
.nvl-tl-dot { position: absolute; left: 0; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-border-l1); }
.nvl-tl-item[data-open="true"] .nvl-tl-dot, .nvl-tl-dot[data-first="true"] { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-tl-main { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); }
.nvl-tl-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.nvl-tl-time { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.nvl-tl-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.nvl-tl-badge[data-kind="style"] { border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe); }
.nvl-tl-note { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.nvl-tl-actions { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.nvl-tl-body { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1); max-height: 46vh; overflow: auto; }
.nvl-diff-bar { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
.nvl-diff-row { display: flex; gap: 6px; padding: 2px 4px; border-radius: 4px; font-size: 12px; line-height: 1.7; }
.nvl-diff-mark { flex: none; width: 10px; color: var(--dsw-alias-label-secondary); }
.nvl-diff-text { white-space: pre-wrap; word-break: break-word; }
.nvl-diff-add { background: rgba(46, 160, 67, 0.12); }
.nvl-diff-del { background: rgba(248, 81, 73, 0.12); }
.nvl-diff-same { opacity: .62; }
`

    async function getJson(url) {
      // 这里以前漏了 apiPath：列表走 useJson 带了 session，详情走 getJson 没带，
      // 于是同一个进程里「列表能看、点进去 404」。所有读请求统一补上会话参数。
      const response = await fetch(apiPath(url), { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** 通用轮询钩子：窗口重新获得焦点时也刷一次，写完切回来就能看到新内容。 */
    function useJson(pathname, intervalMs = 10000) {
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const [sessionVersion, setSessionVersion] = useState(0)

      // 会话 id 变了（切工作区/切会话）就整页重取一次。
      useEffect(() => {
        const onSession = () => setSessionVersion(value => value + 1)
        window.addEventListener('nvl-session', onSession)
        return () => window.removeEventListener('nvl-session', onSession)
      }, [])

      const load = useCallback(async () => {
        try {
          const data = await getJson(`${API}${apiPath(pathname)}`)
          setState({ status: 'ready', data, error: null })
        } catch (error) {
          setState({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [pathname])

      useEffect(() => {
        let alive = true
        const tick = () => {
          void load()
        }
        tick()
        const timer = setInterval(tick, intervalMs)
        const onFocus = () => {
          if (alive) tick()
        }
        window.addEventListener('focus', onFocus)
        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [intervalMs, load, sessionVersion])

      return { ...state, reload: load }
    }

    function useNovel(intervalMs = 10000) {
      return useJson('/state', intervalMs)
    }

    function formatChars(value) {
      return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(value)
    }

    /**
     * 极简 Markdown 渲染：只做写小说真正会用到的几样
     * （标题 / 列表 / 粗体 / 斜体 / 行内码 / 引用 / 代码块 / 表格 / 分割线 / 链接）。
     * 平台没把官方 Markdown 渲染器暴露给第三方 bundle，所以这里自己实现，不引第三方库。
     */
    function renderInline(text, keyBase) {
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/gu
      const nodes = []
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        const key = `${keyBase}-${index++}`
        if (token.startsWith('`')) nodes.push(h('code', { key }, token.slice(1, -1)))
        else if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)))
        else if (token.startsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)))
        else {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token)
          nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]))
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function MarkdownView({ text, className }) {
      const lines = String(text ?? '').split(/\r?\n/u)
      const blocks = []
      let paragraph = []
      const flush = () => {
        if (!paragraph.length) return
        const key = `p${blocks.length}`
        const kids = []
        paragraph.forEach((line, li) => {
          if (li > 0) kids.push(h('br', { key: `br${li}` }))
          const parts = renderInline(line, `${key}-${li}`)
          if (Array.isArray(parts)) kids.push(...parts)
          else kids.push(parts)
        })
        blocks.push(h('p', { key, style: { whiteSpace: 'pre-wrap' } }, kids))
        paragraph = []
      }
      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        if (/^\s{0,3}```/u.test(line)) {
          flush()
          const code = []
          i += 1
          while (i < lines.length && !/^\s{0,3}```/u.test(lines[i])) {
            code.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(h('pre', { key: `c${blocks.length}` }, h('code', null, code.join('\n'))))
          continue
        }
        const heading = /^\s{0,3}(#{1,4})\s+(.*)$/u.exec(line)
        if (heading) {
          flush()
          const key = `h${blocks.length}`
          const level = Math.min(4, heading[1].length)
          blocks.push(h(`h${level}`, { key }, renderInline(heading[2], key)))
          i += 1
          continue
        }
        if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
          flush()
          blocks.push(h('hr', { key: `r${blocks.length}` }))
          i += 1
          continue
        }
        if (/^\s*\|/u.test(line)) {
          flush()
          const rows = []
          while (i < lines.length && /^\s*\|/u.test(lines[i])) {
            rows.push(lines[i])
            i += 1
          }
          const cells = row =>
            row
              .trim()
              .replace(/^\|/u, '')
              .replace(/\|$/u, '')
              .split('|')
              .map(cell => cell.trim())
          const body = rows.filter(row => !/^\s*\|?[\s:|-]+\|?\s*$/u.test(row))
          if (body.length) {
            blocks.push(
              h(
                'table',
                { key: `t${blocks.length}` },
                h('thead', null, h('tr', null, cells(body[0]).map((cell, ci) => h('th', { key: ci }, renderInline(cell, `th${ci}`))))),
                h(
                  'tbody',
                  null,
                  body.slice(1).map((row, ri) => h('tr', { key: ri }, cells(row).map((cell, ci) => h('td', { key: ci }, renderInline(cell, `td${ri}-${ci}`))))),
                ),
              ),
            )
          }
          continue
        }
        if (/^\s{0,3}>/u.test(line)) {
          flush()
          const inner = []
          while (i < lines.length && /^\s{0,3}>/u.test(lines[i])) {
            inner.push(lines[i].replace(/^\s{0,3}>\s?/u, ''))
            i += 1
          }
          const qkey = `q${blocks.length}`
          const qkids = []
          inner.forEach((line, li) => {
            if (li > 0) qkids.push(h('br', { key: `qbr${li}` }))
            const parts = renderInline(line, `${qkey}-${li}`)
            if (Array.isArray(parts)) qkids.push(...parts)
            else qkids.push(parts)
          })
          blocks.push(h('blockquote', { key: qkey, style: { whiteSpace: 'pre-wrap' } }, qkids))
          continue
        }
        const bullet = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/u.exec(line)
        if (bullet) {
          flush()
          const ordered = /\d/u.test(bullet[1])
          const items = []
          while (i < lines.length) {
            const item = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/u.exec(lines[i])
            if (!item || /\d/u.test(item[1]) !== ordered) break
            items.push(item[2])
            i += 1
          }
          const key = `l${blocks.length}`
          blocks.push(h(ordered ? 'ol' : 'ul', { key }, items.map((item, ii) => h('li', { key: ii }, renderInline(item, `${key}-${ii}`)))))
          continue
        }
        if (!line.trim()) {
          flush()
          i += 1
          continue
        }
        paragraph.push(line.replace(/\s+$/u, ''))
        i += 1
      }
      flush()
      return h('div', { className: `nvl-md ${className || ''}`.trim() }, blocks)
    }

    function StatusPill(props) {
      const { status, data, error } = useNovel()
      noteSession(props && props.sessionId)

      // 顺手抓住输入框的公开动作面，供右栏「问 AI」使用（见 sendToComposer）。
      const actions = props && props.inputActions
      useEffect(() => {
        if (!actions || typeof actions.insertText !== 'function') return
        composerActions = actions
        return () => {
          if (composerActions === actions) composerActions = null
        }
      }, [actions])

      const dotState = status === 'error' ? 'error' : data && data.exists ? 'ok' : 'empty'
      let text
      if (status === 'loading') text = '小说助手 · 读取中…'
      else if (status === 'error') text = `小说助手 · 未连上宿主（${error}）`
      else if (!data || !data.exists) text = '小说助手 · 当前工作区还没有书稿'
      else {
        const opened = data.threads ? data.threads.opened : 0
        text = `《${data.book.title}》 ${data.totals.written}/${data.totals.chapters} 章 · ${formatChars(data.totals.chars)} 字`
        if (opened > 0) text += ` · 伏笔 ${opened}`
        if (data.settings && data.settings.length) text += ` · 设定 ${data.settings.length}`
        if (data.style) text += ` · 文风 ${data.style}`
        const rhythm = data.rhythm
        if (rhythm && rhythm.withBeats && rhythm.currentGap >= (rhythm.gapLimit || 2)) text += ` · ⚠ 断爽 ${rhythm.currentGap} 章`
      }

      return h(
        'div',
        { className: 'nvl-pill', role: 'status', title: data ? data.root : undefined },
        h('span', { className: 'nvl-pill-dot', 'data-state': dotState }),
        h('span', { className: 'nvl-pill-text' }, text),
      )
    }

    /** 点 planned 章节 = 让它变成能写的章：建空文件 + 登记 book.json + 状态转 draft。 */
    async function postJson(url, body) {
      const response = await fetch(apiPath(url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-novel-action': '1' },
        body: JSON.stringify(body),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }

    // ------------------------------------------------------------ 和主对话打通
    //
    // DSH 没有给插件公开的「发送消息」接口，但会话输入框的公开动作面
    // （InputActions: captureInsertion / insertText / insertQuote）会作为 props
    // 传给 composer 区域的座位组件。我们在输入框上方的状态条里把它存下来，
    // 右栏就能把提示词塞进输入框（不提交，回车由用户按）。
    let composerActions = null

    /** 把文本写进主对话输入框。返回 'composer' | 'copied' | 'failed'。 */
    async function sendToComposer(text) {
      const actions = composerActions
      if (actions && typeof actions.insertText === 'function' && typeof actions.captureInsertion === 'function') {
        try {
          if (actions.insertText(text, actions.captureInsertion())) return 'composer'
        } catch (error) {
          // 落到剪贴板
        }
      }
      try {
        await navigator.clipboard.writeText(text)
        return 'copied'
      } catch (error) {
        return 'failed'
      }
    }

    /** 截断长文本：塞进输入框的内容不宜过长，上下文只带最相关的一段。 */
    function clipText(text, max) {
      const flat = String(text ?? '').trim()
      if (flat.length <= max) return flat
      return `${flat.slice(0, max)}\n…（已截断，原文 ${flat.length} 字）`
    }

    /** 拼一段「带上下文的问题」写进主对话：head 说明哪个视图在问，context 是那一屏看到的内容。 */
    function composePrompt({ head, book, context, question, fallback }) {
      const lines = [`【${head}】${book ? `《${book}》` : '这本书'}`]
      if (context) {
        lines.push('')
        lines.push(String(context).trim())
      }
      lines.push('')
      lines.push(`我的问题：${(question || '').trim() || fallback}`)
      return lines.join('\n')
    }

    /**
     * 每一页底部共用的「问 AI」条：把这一屏的内容 + 你的问题写进主对话输入框。
     * 只填不发——回车由人来按，避免把半句话直接发给模型。
     */
    function AskBar(props) {
      const { head, book, context, fallback, placeholder, hint } = props
      const [question, setQuestion] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)

      const ask = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const how = await sendToComposer(composePrompt({ head, book, context, question, fallback }))
          if (how === 'failed') {
            setNotice({ tone: 'err', text: '没抓到输入框，也复制不了' })
            return
          }
          setQuestion('')
          setNotice({
            tone: 'ok',
            text: how === 'composer' ? '已放进输入框，按回车发送' : '没抓到输入框，问题已复制到剪贴板',
          })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'nvl-ask' },
        h('textarea', {
          className: 'nvl-ask-input',
          value: question,
          rows: 1,
          spellCheck: false,
          placeholder: placeholder || '想问我什么？（留空就问默认问题）',
          onChange: event => setQuestion(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void ask()
            }
          },
        }),
        h(
          'div',
          { className: 'nvl-ask-row' },
          h(
            'button',
            { type: 'button', className: 'nvl-ask-btn', 'data-kind': 'primary', disabled: busy || undefined, onClick: () => void ask() },
            busy ? '发送中…' : '问 AI',
          ),
          h(
            'span',
            { className: 'nvl-ask-hint', 'data-tone': notice ? notice.tone : undefined },
            notice ? notice.text : hint || '带上这一屏的内容发到主对话（Ctrl+Enter）',
          ),
        ),
      )
    }

    /**
     * 只为抓 inputActions 而存在的座位：不渲染任何东西。
     * 挂在 conversation.input.activity（官方语音输入用的就是这一格，props 一定带 inputActions），
     * 给状态条那条路做个保险。
     */
    function ComposerBridge(props) {
      noteSession(props && props.sessionId)
      const actions = props && props.inputActions
      useEffect(() => {
        if (!actions || typeof actions.insertText !== 'function') return
        composerActions = actions
        return () => {
          if (composerActions === actions) composerActions = null
        }
      }, [actions])
      return null
    }

    function ChapterRow({ chapter, onOpen, busy, drift }) {
      const empty = chapter.chars === 0
      const placeholder = chapter.placeholder === true
      const target = chapter.target || 0
      const progress = target > 0 ? Math.min(100, Math.round((chapter.chars / target) * 100)) : 0
      const planned = chapter.status === 'planned'
      return h(
        'button',
        {
          type: 'button',
          className: 'nvl-row',
          'data-empty': empty ? 'true' : 'false',
          'data-placeholder': placeholder ? 'true' : 'false',
          'data-status': chapter.status ?? 'draft',
          disabled: busy ? true : undefined,
          title: placeholder
            ? `这章只有「（待写）」梗概 ${chapter.chars} 字，点开可以写正文`
            : planned
              ? '点一下建章（建空文件并登记到 book.json）'
              : target > 0
                ? `${chapter.chars}/${target} 字（${progress}%）`
                : undefined,
          onClick: () => onOpen(chapter),
        },
        h('span', { className: 'nvl-row-id' }, chapter.id),
        h('span', { className: 'nvl-row-title' }, chapter.title),
        drift ? h('span', { className: 'nvl-row-drift', title: drift }, '漂') : null,
        h(
          'span',
          { className: 'nvl-row-chars' },
          busy
            ? '建章中…'
            : empty
              ? planned
                ? '未写 +'
                : '未写'
              : placeholder
                ? `梗概 ${chapter.chars} 字`
                : `${chapter.chars}/${target}`,
        ),
      )
    }

    // ── 自动重连：替用户点掉「连接异常，点击立即重连」 ──────────────
    // 只认「立即重连」这几个字，绝不碰「刷新重试」（那个会整页重载，点错就是死循环）。
    function autoReconnect() {
      let clicked = 0
      const pick = () => {
        const nodes = document.querySelectorAll('button, [role="button"], a')
        for (const node of nodes) {
          const text = (node.textContent || '').trim()
          if (!text || text.length > 24) continue
          if (text.includes('刷新重试')) continue
          if (text.includes('立即重连') || text.startsWith('重连')) return node
        }
        return null
      }
      const tick = () => {
        if (clicked >= 3) return
        if (document.visibilityState !== 'visible') return
        const target = pick()
        if (!target) return
        clicked += 1
        try { target.click() } catch { /* 点不动就算了 */ }
      }
      const timer = window.setInterval(tick, 2000)
      const onVisible = () => { if (document.visibilityState === 'visible') tick() }
      document.addEventListener('visibilitychange', onVisible)
      const first = window.setTimeout(tick, 1500)
      return () => {
        window.clearInterval(timer)
        window.clearTimeout(first)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }

    // ── 右栏 tab 条：自己接管横向拖动 ────────────────────────────────
    // 平台的条是 overflow-x:auto + touch-action:none + 隐藏滚动条：九个页面挤成一条时，
    // 最左边那个在手机上滑不回来。这里用 touch 事件自己改 scrollLeft（touch-action 管不到我们）。
    const tabStripOf = start => {
      let node = start
      while (node && node !== document.body) {
        if (node.nodeType === 1) {
          const style = window.getComputedStyle(node)
          const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll'
          if (scrollable && node.querySelector('[data-dockkit-tab]')) return node
        }
        node = node.parentElement
      }
      return null
    }

    function wireTabStrip() {
      let strip = null
      let startX = 0
      let startY = 0
      let startLeft = 0
      let decided = false

      const stripFor = element => {
        const chip = element && element.closest ? element.closest('[data-dockkit-tab]') : null
        if (!chip) return null
        const found = tabStripOf(chip)
        if (!found || found.scrollWidth <= found.clientWidth + 2) return null
        found.classList.add('nvl-tabstrip')
        return found
      }

      const begin = event => {
        const touch = event.touches && event.touches[0]
        if (!touch) return
        strip = stripFor(event.target)
        if (!strip) return
        startX = touch.clientX
        startY = touch.clientY
        startLeft = strip.scrollLeft
        decided = false
      }

      const move = event => {
        if (!strip) return
        const touch = event.touches && event.touches[0]
        if (!touch) return
        const dx = touch.clientX - startX
        const dy = touch.clientY - startY
        if (!decided) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
          if (Math.abs(dy) > Math.abs(dx)) {
            strip = null
            return
          }
          decided = true
        }
        strip.scrollLeft = startLeft - dx
        if (event.cancelable) event.preventDefault()
      }

      const end = () => {
        strip = null
        decided = false
      }

      document.addEventListener('touchstart', begin, { passive: true })
      document.addEventListener('touchmove', move, { passive: false })
      document.addEventListener('touchend', end, { passive: true })
      document.addEventListener('touchcancel', end, { passive: true })

      // 挂载时把位置回正：上次的滚动位置会把最左边那格藏到屏幕外。
      const reset = () => {
        const chip = document.querySelector('[data-dockkit-tab]')
        const target = chip ? tabStripOf(chip) : null
        if (!target) return false
        target.classList.add('nvl-tabstrip')
        // 只对这条条子开滚动（inline style），别动祖先节点
        target.style.setProperty('touch-action', 'pan-x', 'important')
        target.style.setProperty('scrollbar-width', 'thin')
        if (target.scrollWidth > target.clientWidth + 2) target.scrollLeft = 0
        return true
      }
      reset()
      const timer = window.setTimeout(reset, 400)

      return () => {
        window.clearTimeout(timer)
        document.removeEventListener('touchstart', begin)
        document.removeEventListener('touchmove', move)
        document.removeEventListener('touchend', end)
        document.removeEventListener('touchcancel', end)
      }
    }

    function ChapterReader({ chapter, book, chapters, onPick, onBack }) {
      const [state, setState] = useState({ status: 'loading', content: '', error: null })
      const [reading, setReading] = useReading()
      const [showTools, setShowTools] = useState(false)
      const [toneNotice, setToneNotice] = useState('')
      const [toneBusy, setToneBusy] = useState(false)

      useBackStep(Boolean(showTools), () => setShowTools(false))

      const bodyRef = React.useRef(null)
      const chapterList = Array.isArray(chapters) ? chapters : []
      const at = chapterList.findIndex(item => item.id === chapter.id)
      const prevChapter = at > 0 ? chapterList[at - 1] : null
      const nextChapter = at >= 0 && at < chapterList.length - 1 ? chapterList[at + 1] : null
      React.useEffect(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = 0
      }, [chapter.id])

      const navRow = h(
        'div',
        { className: 'nvl-chapter-nav' },
        h(
          'button',
          {
            type: 'button',
            className: 'nvl-nav-btn',
            disabled: !prevChapter || typeof onPick !== 'function',
            title: prevChapter ? `上一章：${prevChapter.title}` : '已经是第一章',
            onClick: () => prevChapter && typeof onPick === 'function' && onPick(prevChapter),
          },
          '← 上一章',
        ),
        h('span', { className: 'nvl-nav-pos' }, at >= 0 ? `${at + 1} / ${chapterList.length}` : ''),
        h(
          'button',
          {
            type: 'button',
            className: 'nvl-nav-btn',
            disabled: !nextChapter || typeof onPick !== 'function',
            title: nextChapter ? `下一章：${nextChapter.title}` : '已经是最后一章',
            onClick: () => nextChapter && typeof onPick === 'function' && onPick(nextChapter),
          },
          '下一章 →',
        ),
      )

      async function askDeai() {
        if (toneBusy) return
        setToneBusy(true)
        setToneNotice('检测中…')
        try {
          const data = await getJson(`${API}/ai-tone?chapter=${encodeURIComponent(chapter.id)}`)
          const hits = (data.signals || [])
            .map(item => `- ${item.label}（${item.count} 处）${item.samples && item.samples[0] ? `：${item.samples[0]}` : ''}`)
            .join('\n')
          const text = composePrompt({
            head: '去 AI 味',
            book,
            context:
              `【待审章节】${chapter.id} ${chapter.title}；先调用 novel_deai_pack({ chapter: ${JSON.stringify(chapter.id)} }) 阅读磁盘上的完整正文、人物声口与文风卡。\n\n` +
              `【宿主检测到的 AI 腔（${(data.signals || []).length} 类 / ${data.total || 0} 处）】\n${hits || '（没检测到可指认的套话）'}\n\n` +
              `【改写纪律】\n${data.rules || ''}`,
            question: `审查 ${chapter.id} 全文的时间压力、人物声口、细节堆叠、旁白解释和句段模板。机械命中仅作线索，正常表达可以保留。有问题才用 novel_write({ chapter: ${JSON.stringify(chapter.id)}, mode: "patch", baseHash, patches: [{ start, end, content }] }) 一次保存多个修改。修改后重新获取 novel_deai_pack，对最终全文逐段说明保留理由，提交 novel_deai_review 的五项 checks 和全部 paragraphs，再运行 novel_check。不要根据片段覆盖整章，不改变事实和人物意图。`,
          })
          const how = await sendToComposer(text)
          setToneNotice(
            how === 'composer' ? '已放进输入框，按回车发送' : how === 'copied' ? '没抓到输入框，问题已复制到剪贴板' : '没抓到输入框，也复制不了',
          )
        } catch (error) {
          setToneNotice(`检测失败：${error.message}`)
        } finally {
          setToneBusy(false)
        }
      }

      useEffect(() => {
        let alive = true
        getJson(`${API}/chapter?id=${encodeURIComponent(chapter.id)}`)
          .then(value => {
            if (alive) setState({ status: 'ready', content: value.content ?? '', error: null })
          })
          .catch(error => {
            if (alive) setState({ status: 'error', content: '', error: error.message })
          })
        return () => {
          alive = false
        }
      }, [chapter.id])

      const sizeOptions = [14, 16, 18, 20, 22].map(size => ({ value: size, label: String(size) }))
      const lineOptions = [{ value: 1.6, label: '紧' }, { value: 1.9, label: '中' }, { value: 2.2, label: '松' }]
      const themeOptions = [{ value: 'auto', label: '跟随' }, { value: 'sepia', label: '纸黄' }, { value: 'dark', label: '深色' }]
      const padOptions = [{ value: 'compact', label: '窄' }, { value: 'normal', label: '标准' }, { value: 'wide', label: '宽' }]

      const tools = showTools
        ? h(
            'div',
            { className: 'nvl-reader-tools' },
            h(Segmented, {
              label: '字号',
              options: sizeOptions,
              value: reading.size,
              onPick: size => setReading({ size: Number(size) }),
            }),
            h(Segmented, {
              label: '行距',
              options: lineOptions,
              value: reading.line,
              onPick: line => setReading({ line: Number(line) }),
            }),
            h(Segmented, {
              label: '底色',
              options: themeOptions,
              value: reading.theme,
              onPick: theme => setReading({ theme }),
            }),
            h(Segmented, {
              label: '边距',
              options: padOptions,
              value: reading.padding,
              onPick: padding => setReading({ padding }),
            }),
          )
        : null

      return h(
        'div',
        { className: 'nvl-reader' },
        h(
          'div',
          { className: 'nvl-reader-head' },
          h('button', { type: 'button', className: 'nvl-back', onClick: onBack }, '← 章节'),
          h('span', { className: 'nvl-title' }, chapter.title),
          h('span', { className: 'nvl-meta' }, `${chapter.chars}/${chapter.target || 0} 字`),
          h(
            'button',
            {
              type: 'button',
              className: 'nvl-aa',
              title: '先检测这一章的「AI 腔」，再把命中清单和改写纪律放进输入框',
              disabled: toneBusy,
              onClick: askDeai,
            },
            toneBusy ? '…' : '去AI味',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'nvl-aa',
              'data-active': String(showTools),
              title: '阅读设置（字号 / 行距 / 底色 / 边距）',
              onClick: () => setShowTools(!showTools),
            },
            'Aa',
          ),
        ),
        tools,
        toneNotice
          ? h('div', { className: 'nvl-hint', 'data-tone': toneNotice.startsWith('检测失败') ? 'err' : 'ok' }, toneNotice)
          : null,
        h(
          'div',
          {
            className: 'nvl-reader-body',
            ref: bodyRef,
            'data-theme': reading.theme,
            'data-padding': reading.padding,
            style: { fontSize: `${reading.size}px`, lineHeight: reading.line },
          },
          state.status === 'loading'
            ? '读取中…'
            : state.status === 'error'
              ? h('span', { className: 'nvl-err' }, `读取失败：${state.error}`)
              : state.content
                ? h(MarkdownView, { text: state.content, className: 'nvl-reader-md' })
                : '（这一章还是空的）',
        ),
        navRow,
        state.status === 'ready'
          ? h(AskBar, {
              head: `章节复盘 ${chapter.id}`,
              book: book || '',
              context: `《${chapter.title}》正文：\n${clipText(state.content, 1400)}`,
              fallback: '这一章有什么问题？哪几段该删、哪几段该展开？',
              placeholder: '想问我什么？例如「结尾这段是不是太快了」',
              hint: '带上这一章正文发到主对话（Ctrl+Enter）',
            })
          : null,
      )
    }
    /** 右栏「小说章节」页。useTabInfo 由框架注入，这里只用到它存在与否，不依赖其内容。 */
    function ChaptersPane(props) {
      const { status, data, error, reload } = useNovel()
      const [open, setOpen] = useState(null)
      const [busy, setBusy] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [exportOpen, setExportOpen] = useState(false)
      const [expScope, setExpScope] = useState('all')
      const [expFormat, setExpFormat] = useState('txt')
      const [expMode, setExpMode] = useState('single')
      const [expFrom, setExpFrom] = useState('')
      const [expTo, setExpTo] = useState('')
      const [exportBusy, setExportBusy] = useState(false)
      const [exportResult, setExportResult] = useState(null)
      const [exportError, setExportError] = useState(null)

      // 文风漂移红标：巡检里已经算过每一章的 style-drift，直接拿来用，不重复算。
      const auditFeed = useJson('/audit', 60000)
      const driftMap = {}
      const auditIssues = (auditFeed.data && auditFeed.data.issues) || []
      for (const item of auditIssues) {
        if (!item || item.kind !== 'style-drift' || !item.chapter) continue
        if (!driftMap[item.chapter]) driftMap[item.chapter] = item.detail || '节奏偏离文风卡'
      }

      useBackStep(Boolean(open), () => setOpen(null))

      // 注意：handleOpen 必须声明在「打开正文」的早退 return 之前。
      // 否则那一轮 render 提前 return，下面的 const 永远不会初始化，
      // 上一章/下一章按钮拿到的闭包会踩 TDZ（点下去毫无反应）。
      const handleOpen = async chapter => {
        // planned 的章：先建章（幂等），再打开正文。
        if (chapter.status !== 'planned') {
          setOpen(chapter)
          return
        }
        setBusy(chapter.id)
        setActionError(null)
        try {
          const started = await postJson(`${API}/start-chapter`, { id: chapter.id })
          await reload()
          setOpen({ ...chapter, ...started, chars: started.chars ?? chapter.chars })
        } catch (failure) {
          setActionError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      if (open)
        return h(ChapterReader, {
          chapter: open,
          book: data && data.book ? data.book.title : '',
          chapters: (data && data.chapters) || [],
          onPick: item => {
            handleOpen(item)
          },
          onBack: () => setOpen(null),
        })

      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, data ? `《${data.book.title}》` : '小说章节'),
        h(
          'button',
          {
            type: 'button',
            className: 'nvl-aa',
            'data-active': String(exportOpen),
            title: '把书稿导出成文件（给你自己用，不走 AI）',
            onClick: () => setExportOpen(!exportOpen),
          },
          '导出',
        ),
        h(
          'span',
          { className: 'nvl-meta' },
          data && data.exists
            ? [
                `${data.totals.written}/${data.totals.chapters} 章 · ${formatChars(data.totals.chars)} 字`,
                data.threads && data.threads.opened > 0 ? `伏笔 ${data.threads.opened}` : '',
                data.beats ? `章纲 ${data.beats.covered}/${data.beats.total}` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : '',
        ),
      )

      async function runExport() {
        if (exportBusy) return
        setExportBusy(true)
        setExportError(null)
        setExportResult(null)
        try {
          const payload = { format: expFormat, mode: expMode }
          if (expScope === 'range') {
            if (expFrom.trim()) payload.from = expFrom.trim()
            if (expTo.trim()) payload.to = expTo.trim()
          }
          const value = await postJson(`${API}/export`, payload)
          setExportResult(value)
        } catch (failure) {
          setExportError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setExportBusy(false)
        }
      }

      const segButton = (label, on, pick) =>
        h('button', { type: 'button', className: 'nvl-seg-btn', 'data-on': String(on), onClick: pick }, label)

      const exportPanel = !exportOpen
        ? null
        : h(
            'div',
            { className: 'nvl-exp' },
            h('div', { className: 'nvl-exp-row' },
              h('span', { className: 'nvl-exp-label' }, '范围'),
              segButton('全书', expScope === 'all', () => setExpScope('all')),
              segButton('指定区间', expScope === 'range', () => setExpScope('range')),
            ),
            expScope === 'range'
              ? h(
                  'div',
                  { className: 'nvl-exp-row' },
                  h('input', {
                    className: 'nvl-input nvl-exp-input',
                    placeholder: '起始章，如 0001',
                    value: expFrom,
                    onChange: event => setExpFrom(event.target.value),
                  }),
                  h('span', { className: 'nvl-exp-dash' }, '—'),
                  h('input', {
                    className: 'nvl-input nvl-exp-input',
                    placeholder: '结束章，如 0080',
                    value: expTo,
                    onChange: event => setExpTo(event.target.value),
                  }),
                )
              : null,
            h('div', { className: 'nvl-exp-row' },
              h('span', { className: 'nvl-exp-label' }, '格式'),
              segButton('纯文本 .txt', expFormat === 'txt', () => setExpFormat('txt')),
              segButton('Markdown .md', expFormat === 'md', () => setExpFormat('md')),
            ),
            h('div', { className: 'nvl-exp-row' },
              h('span', { className: 'nvl-exp-label' }, '方式'),
              segButton('合成一本', expMode === 'single', () => setExpMode('single')),
              segButton('按章拆开', expMode === 'per-chapter', () => setExpMode('per-chapter')),
            ),
            h('div', { className: 'nvl-exp-note' }, expMode === 'single' ? '合成一本：export/ 下一个 .txt，章标题单独成行' : '按章拆开：export/ 下每章一个 <时间戳>-0001.txt'),
            h('div', { className: 'nvl-exp-row' },
              h('button', { type: 'button', className: 'nvl-primary', disabled: exportBusy, onClick: runExport }, exportBusy ? '导出中…' : '开始导出'),
              h('button', { type: 'button', className: 'nvl-ghost', onClick: () => setExportOpen(false) }, '收起'),
            ),
            exportResult
              ? h('div', { className: 'nvl-hint', 'data-tone': 'ok' },
                  `已导出 ${exportResult.chapters} 章 / ${exportResult.words} 字 → ${exportResult.file || exportResult.dir || ''}`)
              : null,
            exportResult && exportResult.download
              ? h(
                  'a',
                  {
                    className: 'nvl-primary nvl-download',
                    href: apiPath(exportResult.download),
                    download: '',
                  },
                  '下载到本机',
                )
              : null,
            exportError ? h('div', { className: 'nvl-hint', 'data-tone': 'err' }, `导出失败：${exportError}`) : null,
          )

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h(
          'div',
          { className: 'nvl-empty nvl-err' },
          `读不到书稿：${error}`,
          h('div', null, h('button', { type: 'button', className: 'nvl-back', onClick: reload }, '重试')),
        )
      } else if (!data || !data.exists) {
        body = h(
          'div',
          { className: 'nvl-empty' },
          '这个工作区里还没有书稿。',
          h('div', null, '让助手写第一章，会自动生成 ', h('code', null, 'book.json'), ' 与 ', h('code', null, 'chapters/0001.md'), '。'),
          h('div', null, h('code', null, data ? data.root : '')),
        )
      } else {
        body = h(
          'div',
          { className: 'nvl-body' },
          ...data.chapters.map(chapter =>
            h(ChapterRow, {
              key: chapter.id,
              chapter,
              busy: busy === chapter.id,
              onOpen: handleOpen,
              drift: driftMap[chapter.id] || '',
            }),
          ),
        )
      }

      const ratio =
        data && data.totals
          ? typeof data.totals.progress === 'number'
            ? data.totals.progress
            : data.totals.chapters > 0
              ? data.totals.written / data.totals.chapters
              : 0
          : 0
      const progress = Math.round(ratio * 100)

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        exportPanel,
        actionError ? h('div', { className: 'nvl-empty nvl-err' }, `建章失败：${actionError}`) : null,
        data && data.exists
          ? h('div', { style: { padding: '0 12px 8px' } }, h('div', { className: 'nvl-bar' }, h('div', { className: 'nvl-bar-fill', style: { width: `${progress}%` } })))
          : null,
        body,
        data && data.exists
          ? h(AskBar, {
              head: '全书节奏',
              book: data.book.title,
              context: `当前章节清单（id 标题｜字数/目标｜状态）：\n${data.chapters
                .map(chapter => `${chapter.id} ${chapter.title}｜${chapter.chars}/${chapter.target || 0} 字｜${chapter.status}`)
                .join('\n')}`,
              fallback: '这本书的节奏有什么问题？哪些章该合并、哪些该拆成一章？',
              placeholder: '想问我什么？例如「第三章是不是写太满了」',
              hint: '带上章节清单发到主对话（Ctrl+Enter）',
            })
          : null,
      )
    }

    // ---------------------------------------------------------------- 人物页
    //
    // 两种看法共用一份数据：`/novel-api/characters` 同时给卡片（列表）和有向关系
    // （关系图）。关系不是我猜的，是人物卡里「## 关系」下 `- 名字：说明` 的行。

    function CharacterDetail({ name, onBack }) {
      const [state, setState] = useState({ status: 'loading', content: '', chars: 0, error: null })
      const novel = useNovel(30000)

      useEffect(() => {
        let alive = true
        getJson(`${API}/character?name=${encodeURIComponent(name)}`)
          .then(value => {
            if (alive) setState({ status: 'ready', content: value.content ?? '', chars: value.chars ?? 0, error: null })
          })
          .catch(error => {
            if (alive) setState({ status: 'error', content: '', chars: 0, error: error.message })
          })
        return () => {
          alive = false
        }
      }, [name])

      return h(
        'div',
        { className: 'nvl-reader' },
        h(
          'div',
          { className: 'nvl-reader-head' },
          h('button', { type: 'button', className: 'nvl-back', onClick: onBack }, '← 人物'),
          h('span', { className: 'nvl-title' }, name),
          h('span', { className: 'nvl-meta' }, `${state.chars} 字`),
        ),
        h(
          'div',
          { className: 'nvl-reader-body' },
          state.status === 'loading'
            ? '读取中…'
            : state.status === 'error'
              ? h('span', { className: 'nvl-err' }, `读取失败：${state.error}`)
              : state.content
                ? h(MarkdownView, { text: state.content, className: 'nvl-reader-md' })
                : '（这张卡是空的）',
        ),
        state.status === 'ready'
          ? h(AskBar, {
              head: `人物卡讨论 ${name}`,
              book: novel && novel.data && novel.data.book ? novel.data.book.title : '',
              context: clipText(state.content, 1000),
              fallback: `${name} 这个人物有什么问题？动机、声音、还是出场时机？`,
              placeholder: '想问我什么？例如「她说的话不像这个人」',
              hint: '带上这张人物卡发到主对话（Ctrl+Enter）',
            })
          : null,
      )
    }

    /** 有多少条关系带时间标记（`- 名字 @0007：…`），用来提示这个图能按章看。 */
    /** 人物在该章（含）之前的最新状态；没写过状态就是活着。 */
    function stateAt(card, upto) {
      const limit = upto ? String(upto).padStart(4, '0') : ''
      let current = null
      for (const item of (card && card.states) || []) {
        if (limit && item.chapter > limit) break
        current = item
      }
      return current
    }

    function edgesWithMarks(graph) {
      const edges = (graph && graph.edges) || []
      return edges.filter(edge => edge.fromChapter).length
    }

    /** 关系图：纯 SVG 环形布局，不引第三方库。幽灵节点＝没建卡但被提到的人。 */
    function CharacterGraph({ graph, onOpen }) {
      const nodes = graph.nodes || []
      const edges = graph.edges || []
      const size = 340
      const center = size / 2
      const ring = center - (nodes.length > 7 ? 46 : 56)
      const positions = new Map()
      nodes.forEach((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length) - Math.PI / 2
        positions.set(node.id, { x: center + ring * Math.cos(angle), y: center + ring * Math.sin(angle) })
      })

      const key = (a, b) => `${a}\u0000${b}`
      const existing = new Set(edges.map(edge => key(edge.from, edge.to)))
      const shapes = []

      // 箭头画在目标端，省得靠颜色猜方向。
      shapes.push(
        h(
          'defs',
          { key: 'defs' },
          h(
            'marker',
            { id: 'nvl-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
            h('path', { d: 'M0,0 L8,4 L0,8 z', className: 'nvl-arrow' }),
          ),
        ),
      )

      edges.forEach((edge, index) => {
        const from = positions.get(edge.from)
        const to = positions.get(edge.to)
        if (!from || !to || edge.from === edge.to) return
        const dx = to.x - from.x
        const dy = to.y - from.y
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len
        const uy = dy / len
        // 双向关系各偏 6px，两条线不会叠成一条。
        const offset = existing.has(key(edge.to, edge.from)) ? 6 : 0
        const nx = -uy * offset
        const ny = ux * offset
        const gap = 13
        const x1 = from.x + ux * gap + nx
        const y1 = from.y + uy * gap + ny
        const x2 = to.x - ux * gap + nx
        const y2 = to.y - uy * gap + ny
        shapes.push(
          h('line', {
            key: `e${index}`,
            x1,
            y1,
            x2,
            y2,
            className: edge.dead ? 'nvl-edge nvl-edge-dead' : 'nvl-edge',
            'marker-end': 'url(#nvl-arrow)',
          }),
        )
        if (!edge.label) return
        const short = edge.label.length > 10 ? `${edge.label.slice(0, 10)}…` : edge.label
        const mx = (x1 + x2) / 2
        const my = (y1 + y2) / 2 - 3
        // 底衬：先把线盖住再写字，短标签也能读清。
        shapes.push(
          h('rect', {
            key: `eb${index}`,
            x: mx - (short.length * 4.6 + 3),
            y: my - 8,
            width: short.length * 9.2 + 6,
            height: 11,
            rx: 2,
            className: 'nvl-edge-label-bg',
          }),
        )
        const tip = edge.fromChapter ? `${edge.label}（自第 ${Number(edge.fromChapter)} 章）` : edge.label
        shapes.push(
          h('text', { key: `el${index}`, x: mx, y: my + 1, className: 'nvl-edge-label', textAnchor: 'middle' }, short, h('title', null, tip)),
        )
      })
      nodes.forEach(node => {
        const point = positions.get(node.id)
        shapes.push(
          h('circle', {
            key: `c${node.id}`,
            cx: point.x,
            cy: point.y,
            r: node.ghost ? 6 : 11,
            className: node.ghost ? 'nvl-node-ghost' : node.dead ? 'nvl-node nvl-node-dead' : 'nvl-node',
            onClick: node.ghost ? undefined : () => onOpen(node.id),
          }),
        )
        const nodeTip = node.stateChapter ? `${node.name}（第 ${Number(node.stateChapter)} 章 ${node.stateLabel}）` : node.name
        shapes.push(
          h(
            'text',
            { key: `n${node.id}`, x: point.x, y: point.y - (node.ghost ? 11 : 15), className: 'nvl-node-label', textAnchor: 'middle' },
            node.dead ? `${node.name} †` : node.name,
            h('title', null, nodeTip),
          ),
        )
      })

      return h(
        'div',
        { className: 'nvl-graph' },
        h('svg', { viewBox: `0 0 ${size} ${size}`, className: 'nvl-svg' }, shapes),
        h('div', { className: 'nvl-hint' }, `${nodes.length} 个人物 · ${edges.length} 条关系`),
        edges.some(edge => nodes.find(node => node.id === edge.to && node.ghost))
          ? h('div', { className: 'nvl-hint' }, '空心点＝还没有人物卡（可以让助手补一张）')
          : null,
      )
    }

    function CharactersPane() {
      const [upto, setUpto] = useState('')
      const { status, data, error, reload } = useJson(`/characters${upto ? `?chapter=${upto}` : ''}`, 15000)
      const novel = useNovel(30000)
      const [mode, setMode] = useState('list')
      const [openName, setOpenName] = useState(null)

      useBackStep(Boolean(openName), () => setOpenName(null))
      if (openName) return h(CharacterDetail, { name: openName, onBack: () => setOpenName(null) })

      const cards = (data && data.characters) || []
      const appearance = (data && data.appearance) || {}
      const graph = (data && data.graph) || { nodes: [], edges: [] }

      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, '人物'),
        h(
          'div',
          { className: 'nvl-seg' },
          h(
            'button',
            { type: 'button', className: 'nvl-seg-btn', 'data-active': mode === 'list' ? 'true' : 'false', onClick: () => setMode('list') },
            '列表',
          ),
          h(
            'button',
            { type: 'button', className: 'nvl-seg-btn', 'data-active': mode === 'graph' ? 'true' : 'false', onClick: () => setMode('graph') },
            '关系图',
          ),
        ),
      )

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h(
          'div',
          { className: 'nvl-empty nvl-err' },
          `读不到人物卡：${error}`,
          h('div', null, h('button', { type: 'button', className: 'nvl-back', onClick: reload }, '重试')),
        )
      } else if (!cards.length) {
        body = h(
          'div',
          { className: 'nvl-empty' },
          '还没有人物卡。',
          h('div', null, '跟助手说「新建人物卡：名字 + 设定」，会写到 ', h('code', null, 'characters/名字.md'), '。'),
        )
      } else if (mode === 'graph') {
        const ids = (data && data.chapterIds) || []
        const marked = edgesWithMarks(data && data.graph)
        const deadCount = ((data && data.graph && data.graph.nodes) || []).filter(node => node.dead).length
        body = h(
          'div',
          { className: 'nvl-graph-wrap' },
          h(
            'div',
            { className: 'nvl-graph-bar' },
            h('span', { className: 'nvl-hint' }, '关系截至'),
            h(
              'select',
              { className: 'nvl-select', value: upto, onChange: event => setUpto(event.target.value) },
              h('option', { value: '' }, '全部'),
              ids.map(id => h('option', { key: id, value: id }, `第 ${Number(id)} 章`)),
            ),
            marked ? h('span', { className: 'nvl-hint' }, `（${marked} 条带时间标记）`) : null,
            deadCount ? h('span', { className: 'nvl-hint' }, `· ${deadCount} 人已殁`) : null,
          ),
          h(CharacterGraph, { graph, onOpen: setOpenName }),
        )
      } else {
        body = h(
          'div',
          { className: 'nvl-body' },
          ...cards.map(card =>
            h(
              'button',
              { key: card.name, type: 'button', className: 'nvl-card', onClick: () => setOpenName(card.name) },
              h('span', { className: 'nvl-card-name' }, card.name, stateAt(card, upto) && stateAt(card, upto).dead ? h('span', { className: 'nvl-card-dead' }, '殁') : null, appearance[card.name] && appearance[card.name].due ? h('span', { className: 'nvl-card-due', title: appearance[card.name].last ? `上次出场第 ${Number(appearance[card.name].last)} 章，已经 ${appearance[card.name].gap} 章没露面（卡上写每 ${appearance[card.name].cadence} 章一次）` : `正文里还没出现过（卡上写每 ${appearance[card.name].cadence} 章一次）` }, '欠场') : null),
              h('span', { className: 'nvl-card-sum' }, card.summary || '（没有摘要）'),
              h(
                'span',
                { className: 'nvl-card-meta' },
                `${card.chars} 字${card.relations && card.relations.length ? ` · 关系 ${card.relations.length}` : ''}`,
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        body,
        cards.length
          ? h(AskBar, {
              head: '人物讨论',
              book: novel && novel.data && novel.data.book ? novel.data.book.title : '',
              context: `当前人物卡（名字｜摘要｜关系）：\n${cards
                .map(
                  card =>
                    `${card.name}｜${card.summary || '（无摘要）'}｜${(card.relations || []).map(item => `${item.target}${item.label ? `(${item.label})` : ''}`).join('、') || '无'}`,
                )
                .join('\n')}`,
              fallback: '这套人物关系有什么问题？谁还缺动机、谁的戏被浪费了？',
              placeholder: '想问我什么？例如「老周这个角色是不是太工具」',
              hint: '带上人物清单发到主对话（Ctrl+Enter）',
            })
          : null,
      )
    }

    // ---------------------------------------------------------------- 大纲页

    function OutlinePane() {
      const { status, data, error, reload } = useJson('/outline', 20000)
      const novel = useNovel(30000)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)

      const startEdit = () => {
        setDraft((data && data.text) || '')
        setActionError(null)
        setEditing(true)
      }

      const save = async () => {
        setBusy(true)
        setActionError(null)
        try {
          await postJson(`${API}/outline`, { content: draft })
          await reload()
          setEditing(false)
        } catch (failure) {
          setActionError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, '大纲'),
        h(
          'div',
          { className: 'nvl-seg' },
          editing
            ? [
                h('button', { key: 'save', type: 'button', className: 'nvl-seg-btn', 'data-active': 'true', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
                h('button', { key: 'cancel', type: 'button', className: 'nvl-seg-btn', onClick: () => setEditing(false) }, '取消'),
              ]
            : h('button', { type: 'button', className: 'nvl-seg-btn', onClick: startEdit }, '编辑'),
        ),
      )

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h(
          'div',
          { className: 'nvl-empty nvl-err' },
          `读不到大纲：${error}`,
          h('div', null, h('button', { type: 'button', className: 'nvl-back', onClick: reload }, '重试')),
        )
      } else if (editing) {
        body = h('textarea', {
          className: 'nvl-editor',
          value: draft,
          spellCheck: false,
          onChange: event => setDraft(event.target.value),
        })
      } else if (!data || !data.present) {
        body = h(
          'div',
          { className: 'nvl-empty' },
          '还没有大纲。',
          h('div', null, '跟助手说「先列个大纲」，或者点右上角「编辑」自己写。'),
        )
      } else {
        body = h(
          'div',
          { className: 'nvl-outline' },
          ...(data.sections || []).map((section, index) =>
            h(
              'div',
              { key: `s${index}`, className: 'nvl-outline-sec' },
              section.title ? h('div', { className: 'nvl-outline-title' }, section.title) : null,
              section.body ? h(MarkdownView, { text: section.body, className: 'nvl-outline-body' }) : null,
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        actionError ? h('div', { className: 'nvl-empty nvl-err' }, `保存失败：${actionError}`) : null,
        body,
        editing ? null : h(AskBar, {
          head: '大纲讨论',
          book: novel.data && novel.data.book ? novel.data.book.title : '',
          context: clipText((data && data.text) || '', 1600),
          fallback: '这份大纲有什么问题？给我三个具体的改法。',
          placeholder: '想问我什么？例如「主线第三拍太赶了」',
          hint: '带上这份大纲发到主对话（Ctrl+Enter）',
        }),
      )
    }

    // 客户端 inject 只认字符串数组（官方插件都写 inject = ['slots', 'sessions', ...]）。
    // 右栏服务是可选的：写进数组会让插件在没装右栏时永远 pending，所以只依赖 slots，
    // 右栏到了再用 ctx.inject 延迟订阅（见 apply 末尾）。
    const inject = ['slots']

    /** 右栏「小说章纲」页：按章节顺序列出每章的拍摄清单，可就地写 / 改（单独成页，不塞进正文页）。 */
    function BeatsPane() {
      const { data } = useNovel()
      const { status, data: board, error, reload } = useJson('/beats')
      const eventsFeed = useJson('/events', 20000)
      const [editing, setEditing] = useState(null)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)

      const byId = {}
      for (const section of (board && board.sections) || []) byId[section.id] = section
      const chapters = (data && data.chapters) || []
      const coverage = (board && board.coverage) || { total: chapters.length, covered: [] }
      const editingId = editing ? editing.id : null
      const laneLines = (eventsFeed.data && eventsFeed.data.lines) || []
      const laneHits = {}
      for (const item of (eventsFeed.data && eventsFeed.data.chapters) || []) laneHits[item.id] = item.hits || []

      const save = async () => {
        if (!editing) return
        setSaving(true)
        setNotice(null)
        try {
          const value = await postJson(`${API}/beats`, { chapter: editing.id, content: editing.text })
          await reload()
          setEditing(null)
          setNotice(`已保存 ${editing.id}（${value.chars} 字）`)
        } catch (failure) {
          setNotice(`保存失败：${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          setSaving(false)
        }
      }

      const rhythm = (board && board.rhythm) || null
      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, '小说章纲'),
        h('span', { className: 'nvl-meta' }, `章纲 ${coverage.covered.length}/${coverage.total} 章`),
      )
      const laneLegend = h(LaneLegend, { lines: laneLines })
      // 节奏台账：不存盘，每次都从章纲那几行标记现算 —— 所以它永远不会和章纲打架。
      const rhythmBar = rhythm
        ? h(
            'div',
            { className: 'nvl-rhythm', 'data-tone': rhythm.currentGap >= (rhythm.gapLimit || 2) ? 'err' : 'ok' },
            `爽点 ${rhythm.payoff}${rhythm.budget ? ` / 计划 ${rhythm.budget}` : ''}` +
              ` · 有爽点的章 ${rhythm.withPayoff}/${rhythm.withBeats} · 钩子 ${rhythm.hooks} 章 · 最长断档 ${rhythm.longestGap} 章` +
              (rhythm.currentGap >= (rhythm.gapLimit || 2) ? ` · ⚠ 已连续 ${rhythm.currentGap} 章没有爽点（每 ${rhythm.gapLimit || 2} 章至少要一次）` : ''),
          )
        : null

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h('div', { className: 'nvl-empty' }, h('span', { className: 'nvl-err' }, `读取失败：${error}`))
      } else if (!chapters.length) {
        body = h('div', { className: 'nvl-empty' }, '还没有章节：先让我建一本书')
      } else {
        body = chapters.map(chapter => {
          const section = byId[chapter.id]
          const filled = Boolean(section && section.chars > 0)
          const isEditing = editingId === chapter.id
          return h(
            'div',
            { className: 'nvl-beat-sec', key: chapter.id },
            h(
              'div',
              { className: 'nvl-beat-head' },
              h('span', { className: 'nvl-beat-title' }, `${chapter.id} ${chapter.title}`),
              h(LaneStrip, { hits: laneHits[chapter.id] || [], lines: laneLines, written: Boolean(chapter.written) }),
              filled
                ? h(
                    'span',
                    { className: 'nvl-mark', title: (section.labels || []).join('、') || '章纲里没有写爽点类型' },
                    `爽×${section.payoff ?? 0}${section.hook ? ' 钩' : ''}${section.infos && section.infos.length ? ` 信×${section.infos.length}` : ''}`,
                  )
                : null,
              isEditing
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'nvl-ask-btn',
                      onClick: () => {
                        setNotice(null)
                        setEditing({ id: chapter.id, text: filled ? section.text : '' })
                      },
                    },
                    filled ? '编辑' : '写章纲',
                  ),
            ),
            isEditing
              ? h(
                  'div',
                  null,
                  h('textarea', {
                    className: 'nvl-beats-edit',
                    value: editing.text,
                    placeholder: '- 开场：…\n- 中段：…\n- 收尾：…',
                    onChange: event => setEditing({ id: chapter.id, text: event.target.value }),
                  }),
                  h(
                    'div',
                    { className: 'nvl-beats-foot' },
                    h(
                      'button',
                      { type: 'button', className: 'nvl-ask-btn', 'data-kind': 'primary', disabled: saving || undefined, onClick: save },
                      saving ? '保存中…' : '保存',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'nvl-ask-btn',
                        disabled: saving || undefined,
                        onClick: () => {
                          setEditing(null)
                          setNotice(null)
                        },
                      },
                      '取消',
                    ),
                  ),
                )
              : filled
            ? h(MarkdownView, { text: section.text, className: 'nvl-beat-body' })
            : h('div', { className: 'nvl-beat-body', 'data-empty': 'true' }, '（还没有章纲）'),
          )
        })
      }

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        rhythmBar,
        laneLegend,
        notice
          ? h('div', { className: 'nvl-hint', 'data-tone': notice.startsWith('保存失败') ? 'err' : 'ok' }, notice)
          : null,
        h('div', { className: 'nvl-outline' }, body),
        h(AskBar, {
          head: editing ? `章纲讨论 ${editing.id}` : '章纲讨论',
          book: data && data.book ? data.book.title : '',
          context: editing
            ? `这一章的拍摄清单：\n${clipText(editing.text, 1000)}`
            : `当前章纲（每章一节）：\n${clipText(
                ((board && board.sections) || []).map(section => `## ${section.heading}\n${section.text}`).join('\n\n'),
                1400,
              )}`,
          fallback: '这套章纲的节奏有什么问题？哪一章的规划太满或太空？',
          placeholder: '想问我什么？例如「第三章是不是缺一个转折」',
          hint: '带上章纲发到主对话（Ctrl+Enter）',
        }),
      )
    }

    /** 事件线颜色：按线在 events.md 里的顺序取色，图例和泳道点共用一套。 */
    const LANE_COLORS = ['#4d6bfe', '#e0483e', '#2f9e69', '#b7791f', '#7c5cff', '#0e7490']

    function laneColor(index) {
      return LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]
    }

    /** 章纲页右缘的窄泳道：一条线一个点，实心=这一章有正文，空心=只有章纲。 */
    function LaneStrip(props) {
      const hits = props.hits || []
      const lines = props.lines || []
      if (!hits.length) return h('span', { className: 'nvl-lanes', title: '这一章没挂事件线' })
      return h(
        'span',
        { className: 'nvl-lanes' },
        hits.map(hit => {
          const index = lines.findIndex(item => item.id === hit.lineId)
          return h('span', {
            key: hit.eventId,
            className: 'nvl-lane-dot',
            style: {
              background: props.written ? laneColor(index) : 'transparent',
              borderColor: laneColor(index),
            },
            title: `${hit.lineName} · ${hit.eventId} ${hit.title}` + (props.written ? '' : '（这一章还没有正文）'),
          })
        }),
      )
    }

    /** 事件线图例：哪条线是什么颜色，以及这条线写了几个事件。 */
    function LaneLegend(props) {
      const lines = props.lines || []
      if (!lines.length) return null
      return h(
        'div',
        { className: 'nvl-lanes-legend' },
        h('span', { className: 'nvl-lanes-label' }, '事件线'),
        lines.map((line, index) =>
          h(
            'span',
            { className: 'nvl-lane-chip', key: line.id, title: line.goal || line.name },
            h('span', { className: 'nvl-lane-swatch', style: { background: laneColor(index) } }),
            `${line.name}${line.total ? ` ${line.covered}/${line.total}` : ''}`,
          ),
        ),
      )
    }

    /** 右栏「小说事件」页：事件线台账 —— 一条线跨多章，一章也可以推好几条线。 */
    function EventsPane() {
      const novel = useNovel(30000)
      const { status, data, error } = useJson('/events', 15000)

      const lines = (data && data.lines) || []
      const warnings = (data && data.warnings) || []
      const written = {}
      for (const item of (data && data.chapters) || []) written[item.id] = item.written === true

      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, '小说事件'),
        h(
          'span',
          { className: 'nvl-meta' },
          data ? `${data.lineCount || 0} 条线 · ${data.eventCount || 0} 个事件` : '读取中…',
        ),
      )

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h('div', { className: 'nvl-empty' }, h('span', { className: 'nvl-err' }, `读取失败：${error}`))
      } else if (!lines.length) {
        body = h(
          'div',
          { className: 'nvl-empty' },
          '还没有事件线：跟老师说「把主线拆成事件链：因为 → 所以 → 不可替代」，插件会写进 events.md',
        )
      } else {
        body = lines.map((line, index) =>
          h(
            'div',
            { className: 'nvl-ev-line', key: line.id },
            h(
              'div',
              { className: 'nvl-ev-head' },
              h('span', { className: 'nvl-lane-swatch', style: { background: laneColor(index) } }),
              h('span', { className: 'nvl-ev-name' }, line.name || line.id),
              h('span', { className: 'nvl-ev-meta' }, `${line.covered}/${line.total} 个事件有正文`),
            ),
            line.goal ? h('div', { className: 'nvl-ev-goal' }, `目标：${line.goal}`) : null,
            line.events.map(event =>
              h(
                'div',
                { className: 'nvl-ev-row', key: event.id, 'data-status': event.status },
                h(
                  'div',
                  { className: 'nvl-ev-row-head' },
                  h('span', { className: 'nvl-ev-id' }, event.id),
                  h('span', { className: 'nvl-ev-title' }, event.title),
                  h('span', { className: 'nvl-ev-span' }, `${event.from || '?'}–${event.to || '?'}`),
                  h('span', { className: 'nvl-ev-status' }, event.status),
                ),
                event.because ? h('div', { className: 'nvl-ev-why' }, `因为：${event.because}`) : null,
                event.so ? h('div', { className: 'nvl-ev-why' }, `所以：${event.so}`) : null,
                event.chapters && event.chapters.length
                  ? h(
                      'div',
                      { className: 'nvl-ev-chapters' },
                      event.chapters.map(id =>
                        h(
                          'span',
                          { className: 'nvl-ev-chapter', key: id, 'data-written': written[id] ? 'true' : 'false' },
                          `${id}${written[id] ? '✓' : '○'}`,
                        ),
                      ),
                    )
                  : h('div', { className: 'nvl-ev-why' }, '（区间里没有章节，也没有章纲锚点）'),
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        warnings.length
          ? h(
              'div',
              { className: 'nvl-rhythm', 'data-tone': 'err' },
              `⚠ ${warnings.length} 处对不上：${warnings.slice(0, 2).join('；')}`,
            )
          : null,
        h('div', { className: 'nvl-outline' }, body),
        h(AskBar, {
          head: '事件线讨论',
          book: novel && novel.book ? novel.book.title : '',
          context: `当前事件线：\n${clipText((data && data.text) || '', 1600)}`,
          fallback: '主线的因果链有什么断裂？哪几个事件其实可以合并、哪一章该加一个转折？',
          placeholder: '想问我什么？例如「第 20 章到 30 章之间主线为什么停了」',
          hint: '带上事件线发到主对话（Ctrl+Enter）',
        }),
      )
    }

    /** 右栏「小说设定」页：世界观条目（地点 / 规矩 / 物品 / 术语），一条一行，点开可读可改。 */
    function SettingsPane() {
      const { status, data, error, reload } = useJson('/settings')
      const novel = useNovel(30000)
      const [open, setOpen] = useState(null)
      useBackStep(Boolean(open), () => {
        setOpen(null)
        setEditing(null)
      })
      const [detail, setDetail] = useState({ status: 'idle', content: '', error: null })
      const [editing, setEditing] = useState(null)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)

      const items = (data && data.settings) || []

      const toggle = async name => {
        if (open === name) {
          setOpen(null)
          setEditing(null)
          return
        }
        setOpen(name)
        setEditing(null)
        setDetail({ status: 'loading', content: '', error: null })
        try {
          const value = await getJson(`${API}/setting?name=${encodeURIComponent(name)}`)
          setDetail({ status: 'ready', content: value.content ?? '', error: null })
        } catch (failure) {
          setDetail({ status: 'error', content: '', error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      const save = async () => {
        if (!editing) return
        setSaving(true)
        setNotice(null)
        try {
          const value = await postJson(`${API}/setting`, { name: editing.name, content: editing.text })
          await reload()
          setDetail({ status: 'ready', content: editing.text, error: null })
          setEditing(null)
          setNotice(`已保存「${editing.name}」（${value.chars} 字）`)
        } catch (failure) {
          setNotice(`保存失败：${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          setSaving(false)
        }
      }

      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, '小说设定'),
        h('span', { className: 'nvl-meta' }, `设定 ${items.length} 条`),
      )

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h('div', { className: 'nvl-empty' }, h('span', { className: 'nvl-err' }, `读取失败：${error}`))
      } else if (!items.length) {
        body = h(
          'div',
          { className: 'nvl-empty' },
          '还没有设定。',
          h('div', null, '跟助手说「记一条设定：雾天不点灯，灯亮着雾里的人就知道屋里有人」。'),
        )
      } else {
        body = items.map(item => {
          const expanded = open === item.name
          const isEditing = Boolean(editing) && editing.name === item.name
          return h(
            'div',
            { className: 'nvl-set-sec', key: item.name },
            h(
              'button',
              { type: 'button', className: 'nvl-set-head', 'data-open': expanded ? 'true' : 'false', onClick: () => void toggle(item.name) },
              h('span', { className: 'nvl-set-name' }, item.name),
              item.category ? h('span', { className: 'nvl-set-cat' }, item.category) : null,
              h('span', { className: 'nvl-set-chars' }, `${item.chars} 字`),
            ),
            expanded
              ? h(
                  'div',
                  { className: 'nvl-set-body' },
                  isEditing
                    ? [
                        h('textarea', {
                          key: 'editor',
                          className: 'nvl-beats-edit',
                          value: editing.text,
                          spellCheck: false,
                          onChange: event => setEditing({ name: item.name, text: event.target.value }),
                        }),
                        h(
                          'div',
                          { key: 'foot', className: 'nvl-beats-foot' },
                          h(
                            'button',
                            { type: 'button', className: 'nvl-ask-btn', 'data-kind': 'primary', disabled: saving || undefined, onClick: save },
                            saving ? '保存中…' : '保存',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'nvl-ask-btn',
                              disabled: saving || undefined,
                              onClick: () => {
                                setEditing(null)
                                setNotice(null)
                              },
                            },
                            '取消',
                          ),
                        ),
                      ]
                    : [
                        h(
                          'div',
                          {
                            key: 'text',
                            className: 'nvl-set-text',
                            'data-empty': detail.status === 'ready' && detail.content ? 'false' : 'true',
                          },
                          detail.status === 'loading'
                            ? '读取中…'
                            : detail.status === 'error'
                              ? `读取失败：${detail.error}`
                              : detail.content
                                ? h(MarkdownView, { text: detail.content })
                                : '（这条设定还是空的）',
                        ),
                        detail.status === 'ready'
                          ? h(
                              'div',
                              { key: 'foot', className: 'nvl-beats-foot' },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'nvl-ask-btn',
                                  onClick: () => {
                                    setNotice(null)
                                    setEditing({ name: item.name, text: detail.content })
                                  },
                                },
                                '编辑',
                              ),
                            )
                          : null,
                      ],
                )
              : h('div', { className: 'nvl-set-sum' }, item.summary || '（无摘要）'),
          )
        })
      }

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        notice
          ? h('div', { className: 'nvl-hint', 'data-tone': notice.startsWith('保存失败') ? 'err' : 'ok' }, notice)
          : null,
        h('div', { className: 'nvl-outline' }, body),
        h(AskBar, {
          head: open ? `设定讨论 ${open}` : '设定讨论',
          book: novel && novel.data && novel.data.book ? novel.data.book.title : '',
          context:
            open && detail.status === 'ready'
              ? `「${open}」这条设定：\n${clipText(detail.content, 900)}`
              : `当前设定清单：\n${items.map(item => `${item.name}${item.category ? `（${item.category}）` : ''}：${item.summary || '（无摘要）'}`).join('\n')}`,
          fallback: '这套设定有什么问题？哪里自相矛盾、哪里还缺规矩？',
          placeholder: '想问我什么？例如「雾天不点灯会不会和第三章矛盾」',
          hint: '带上设定发到主对话（Ctrl+Enter）',
        }),
      )
    }

    /**
     * 右栏「小说伏笔」页：埋了什么、计划第几章收、哪些已经到期还没收。
     * 数据全在书根的 threads.md，这里只负责显示与「收回 / 重开」两个动作。
     */
    function ThreadsPane() {
      const { status, data, error, reload } = useJson('/threads')
      const novel = useNovel(30000)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)

      const rows = (data && data.rows) || []
      const opened = rows.filter(item => item.open)
      const closed = rows.filter(item => !item.open)
      const due = opened.filter(item => item.due)

      const setStatusOf = async (item, next) => {
        setBusy(item.thread)
        setNotice(null)
        try {
          await postJson(`${API}/thread`, { thread: item.thread, status: next })
          await reload()
          setNotice({ tone: 'ok', text: next === 'open' ? `已重开「${item.thread}」` : `已收回「${item.thread}」` })
        } catch (failure) {
          setNotice({ tone: 'err', text: `没改成：${failure instanceof Error ? failure.message : String(failure)}` })
        } finally {
          setBusy(null)
        }
      }

      const rowOf = (item, done) =>
        h(
          'div',
          { className: 'nvl-th-row', key: item.thread, 'data-due': item.due ? 'true' : 'false' },
          h(
            'div',
            { className: 'nvl-th-main' },
            h('span', { className: 'nvl-th-name' }, item.thread),
            item.due ? h('span', { className: 'nvl-th-due' }, '到期') : null,
            h(
              'span',
              { className: 'nvl-th-meta' },
              `${item.planted || '?'} 埋${item.payoff ? ` · 计划 ${item.payoff} 收` : ' · 未定回收章'}`,
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'nvl-th-btn',
              disabled: busy === item.thread || undefined,
              onClick: () => void setStatusOf(item, done ? 'open' : 'done'),
            },
            busy === item.thread ? '…' : done ? '重开' : '收回',
          ),
        )

      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, '小说伏笔'),
        h(
          'span',
          { className: 'nvl-meta' },
          `未回收 ${opened.length} · 已回收 ${closed.length}` + (data && data.latest ? ` · 已写到 ${data.latest}` : ''),
        ),
      )

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h('div', { className: 'nvl-empty' }, h('span', { className: 'nvl-err' }, `读取失败：${error}`))
      } else if (!rows.length) {
        body = h(
          'div',
          { className: 'nvl-empty' },
          '还没有伏笔。跟老师说「埋一条伏笔：投币箱里多出的硬币，第 1 章埋，计划第 4 章收」。',
        )
      } else {
        body = h(
          'div',
          { className: 'nvl-th-list' },
          due.length ? h('div', { className: 'nvl-th-warn' }, `⚠ ${due.length} 条到了计划回收章还没收`) : null,
          opened.length ? h('div', { className: 'nvl-th-sec' }, '未回收', opened.map(item => rowOf(item, false))) : null,
          closed.length
            ? h('div', { className: 'nvl-th-sec', 'data-done': 'true' }, '已回收', closed.map(item => rowOf(item, true)))
            : null,
        )
      }

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        notice ? h('div', { className: 'nvl-hint', 'data-tone': notice.tone }, notice.text) : null,
        body,
        h(AskBar, {
          head: '伏笔清单',
          book: (novel.data && novel.data.book && novel.data.book.title) || '未命名',
          context: rows
            .map(
              item =>
                `${item.thread}｜${item.planted} 埋${item.payoff ? ` · 计划 ${item.payoff} 收` : ''}｜${item.status}` +
                (item.due ? '｜到期未收' : ''),
            )
            .join('\n'),
          fallback: '这份伏笔表有什么问题？哪些该收、哪些该合并、哪些埋得太晚？',
          placeholder: '想问我什么？比如「这几条伏笔是不是太碎了」',
        }),
      )
    }

    // 文风页：一套文风一张卡，卡里放统计出来的句法/用词 + 逐字锚点原文 + 禁忌清单。
    function AuditPane() {
  const audit = useJson('/audit', 15000)
  const novel = useNovel(30000)
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const data = (audit.data && audit.data.summary) ? audit.data : null
  const issues = data ? data.issues : []
  async function doExport() {
    if (busy) return
    setBusy(true)
    setNotice('导出中…')
    try {
      const result = await postJson('/export', { format: 'md' })
      setNotice('已导出 ' + result.chapters + ' 章 / ' + result.words + ' 字 → ' + result.file)
    } catch (failure) {
      setNotice('导出失败：' + (failure && failure.message ? failure.message : failure))
    }
    setBusy(false)
  }
  const head = h('div', { className: 'nvl-head' },
    h('span', { className: 'nvl-title' }, '全书巡检'),
    h('button', { className: 'nvl-aa', onClick: () => audit.reload(), disabled: audit.loading }, audit.loading ? '…' : '重扫'),
    h('button', { className: 'nvl-aa', onClick: doExport, disabled: busy }, busy ? '导出中…' : '导出全书'))
  if (!data) {
    return h('div', { className: 'nvl-pane' }, head,
      h('div', { className: 'nvl-hint' }, audit.error ? '没连上宿主：' + audit.error : '正在巡检…'))
  }
  const summary = data.summary
  const meta = h('div', { className: 'nvl-meta' },
    (summary.chapters || 0) + ' 章 · 已写 ' + (summary.written || 0) + ' · 占位 ' + (summary.placeholders || 0)
    + ' · ' + (summary.words || 0) + ' / ' + (summary.target || 0) + ' 字')
  const tally = h('div', { className: 'nvl-audit-tally', 'data-tone': (summary.errors || 0) > 0 ? 'err' : '' },
    (summary.errors || 0) + ' 个问题 · ' + (summary.warns || 0) + ' 个提醒 · 爽点断档阈值 ' + (summary.gapLimit || 2) + ' 章')
  const rows = issues.length
    ? issues.map(item =>
        h('div', { key: item.kind + (item.chapter || '') + item.detail, className: 'nvl-audit-row', 'data-level': item.level },
          h('span', { className: 'nvl-audit-kind' }, item.kind),
          h('span', { className: 'nvl-audit-text' }, item.detail)))
    : [h('div', { key: 'clean', className: 'nvl-hint' }, '没有发现能算出来的问题。')]
  const body = h('div', { className: 'nvl-scroll' }, rows)
  return h('div', { className: 'nvl-pane' }, head, meta, tally, body,
    notice ? h('div', { className: 'nvl-hint', 'data-tone': notice.indexOf('失败') >= 0 ? 'err' : 'ok' }, notice) : null,
    h(AskBar, { head: '巡检报告', book: (novel.data && novel.data.book && novel.data.book.title) || '',
      context: issues.slice(0, 40).map(item => item.kind + ' ' + item.detail).join(String.fromCharCode(10)),
      placeholder: '想问哪一条？',
      fallback: '这些提醒里，哪些必须先修？按顺序给我改法。' }))
}
function StylesPane() {
      const { status, data, error, reload } = useJson('/styles', 20000)
      const novel = useNovel(30000)
      const [open, setOpen] = useState(null)
      useBackStep(Boolean(open), () => {
        setOpen(null)
        setEditing(null)
      })
      const [detail, setDetail] = useState({ status: 'idle', content: '', error: null })
      const [editing, setEditing] = useState(null)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(null)
      const [draftName, setDraftName] = useState('')
      const [draftSource, setDraftSource] = useState('')
      const [cloning, setCloning] = useState(false)
      const [sample, setSample] = useState(null)
      const [confirmDelete, setConfirmDelete] = useState('')

      const items = (data && data.styles) || []
      const active = (data && data.active) || ''

      const toggle = async name => {
        if (open === name) {
          setOpen(null)
          setEditing(null)
          return
        }
        setOpen(name)
        setEditing(null)
        setDetail({ status: 'loading', content: '', error: null })
        try {
          const value = await getJson(`${API}/style?name=${encodeURIComponent(name)}`)
          setDetail({ status: 'ready', content: value.content ?? '', error: null })
        } catch (failure) {
          setDetail({ status: 'error', content: '', error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      const loadSample = async name => {
        if (sample && sample.name === name) {
          setSample(null)
          return
        }
        setSample({ name, status: 'loading', text: '', chars: 0, error: null })
        try {
          const value = await getJson(`${API}/style-sample?name=${encodeURIComponent(name)}`)
          setSample({ name, status: 'ready', text: value.text ?? '', chars: value.chars ?? 0, error: null })
        } catch (failure) {
          setSample({ name, status: 'error', text: '', chars: 0, error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      const use = async name => {
        setNotice(null)
        try {
          await postJson(`${API}/style-active`, { name })
          await reload()
          setNotice(`已切到「${name}」——之后每章上下文都会带上它`)
        } catch (failure) {
          setNotice(`切换失败：${failure instanceof Error ? failure.message : String(failure)}`)
        }
      }

      const save = async () => {
        if (!editing) return
        setSaving(true)
        setNotice(null)
        try {
          const value = await postJson(`${API}/style`, { name: editing.name, content: editing.text })
          await reload()
          setDetail({ status: 'ready', content: editing.text, error: null })
          setEditing(null)
          setNotice(`已保存「${editing.name}」（${value.chars} 字）`)
        } catch (failure) {
          setNotice(`保存失败：${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          setSaving(false)
        }
      }

      const create = async () => {
        const name = draftName.trim()
        if (!name) return
        const template = `# 文风卡：${name}\n\n- 来源：\n- 一句话：\n- 视角与时态：\n\n## 句法\n\n- \n\n## 用词\n\n- \n\n## 对话\n\n- \n\n## 意象\n\n- \n\n## 禁忌（不要出现）\n\n- \n\n## 锚点原文\n\n### 锚点 1\n\n\n### 锚点 2\n\n\n### 锚点 3\n`
        setNotice(null)
        try {
          await postJson(`${API}/style`, { name, content: template })
          await reload()
          setDraftName('')
          setOpen(name)
          setEditing({ name, text: template })
          setNotice(`已新建「${name}」，先把锚点原文粘进去再保存`)
        } catch (failure) {
          setNotice(`新建失败：${failure instanceof Error ? failure.message : String(failure)}`)
        }
      }

      // 一条龙克隆：给个原文路径，插件自己读原文、算节奏、切锚点、写卡、存原文、设为当前。
      // 名字留空就用文件名。
      const cloneFromSource = async () => {
        const source = draftSource.trim()
        if (!source) return
        setCloning(true)
        setNotice(null)
        try {
          const value = await postJson(`${API}/style-clone`, {
            source,
            ...(draftName.trim() ? { name: draftName.trim() } : {}),
          })
          await reload()
          setDraftName('')
          setDraftSource('')
          setOpen(value.name)
          setEditing(null)
          setDetail({ status: 'loading', content: '', error: null })
          try {
            const card = await getJson(`${API}/style?name=${encodeURIComponent(value.name)}`)
            setDetail({ status: 'ready', content: card.content ?? '', error: null })
          } catch (failure) {
            setDetail({ status: 'error', content: '', error: failure instanceof Error ? failure.message : String(failure) })
          }
          const warns = (value.warnings || []).length
          setNotice(
            `已克隆「${value.name}」→ ${value.chars} 字，原文留档 ${value.sample ? value.sample.chars : 0} 字` +
              (value.active ? '，已设为当前文风' : '') +
              (warns ? `（${warns} 条格式提醒，展开看看）` : '——缺的只有「视角与时态」，补一句就好'),
          )
        } catch (failure) {
          setNotice(`克隆失败：${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          setCloning(false)
        }
      }

      // 删除：点第一次变成「再点一次确认删」，3 秒内不点就复原（和版本页一个手感）。
      const remove = async name => {
        if (confirmDelete !== name) {
          setConfirmDelete(name)
          window.setTimeout(() => {
            setConfirmDelete(current => (current === name ? '' : current))
          }, 3000)
          return
        }
        setConfirmDelete('')
        setNotice(null)
        try {
          const value = await postJson(`${API}/style-delete`, { name })
          await reload()
          if (open === name) {
            setOpen(null)
            setEditing(null)
            setSample(null)
          }
          setNotice(
            `已删除「${name}」：${(value.removed || []).length} 个文件挪进了 styles/.trash/` +
              (value.wasActive ? '；这本书现在是「没有启用文风」状态' : ''),
          )
        } catch (failure) {
          setNotice(`删除失败：${failure instanceof Error ? failure.message : String(failure)}`)
        }
      }

      const header = h(
        'div',
        { className: 'nvl-head' },
        h('span', { className: 'nvl-title' }, '小说文风'),        h('span', { className: 'nvl-meta' }, items.length ? `文风 ${items.length} 套${active ? ` · 在用「${active}」` : ' · 还没启用'}` : '还没有文风卡'),
      )

      let body
      if (status === 'loading') {
        body = h('div', { className: 'nvl-empty' }, '读取中…')
      } else if (status === 'error') {
        body = h('div', { className: 'nvl-empty' }, h('span', { className: 'nvl-err' }, `读取失败：${error}`))
      } else if (!items.length) {
        body = h(
          'div',
          { className: 'nvl-empty' },
          '还没有文风卡。',
          h('div', null, '跟助手说「照这本书的写法给我做一套文风：D:\\books\\某某.txt」，它会读样本、算句长和对话比例、抄几段原文，写成一张卡。'),
        )
      } else {
        body = items.map(item => {
          const expanded = open === item.name
          const isEditing = Boolean(editing) && editing.name === item.name
          return h(
            'div',
            { className: 'nvl-style-sec', key: item.name },
            h(
              'button',
              { type: 'button', className: 'nvl-style-head', 'data-open': expanded ? 'true' : 'false', onClick: () => void toggle(item.name) },
              h('span', { className: 'nvl-style-name' }, item.name),
              item.active ? h('span', { className: 'nvl-style-on' }, '在用') : null,
              item.sampleChars ? h('span', { className: 'nvl-style-chip' }, `原文 ${item.sampleChars} 字`) : null,
              h('span', { className: 'nvl-style-chars' }, `${item.chars} 字`),
            ),
            item.summary ? h('div', { className: 'nvl-style-sum' }, item.summary) : null,
            expanded
              ? h(
                  'div',
                  { className: 'nvl-style-body' },
                  isEditing
                    ? h('textarea', {
                        className: 'nvl-editor nvl-style-editor',
                        value: editing.text,
                        spellCheck: false,
                        onChange: event => setEditing({ name: editing.name, text: event.target.value }),
                      })
                    : detail.status === 'loading'
                      ? h('div', { className: 'nvl-empty' }, '读取中…')
                      : detail.status === 'error'
                        ? h('div', { className: 'nvl-empty' }, h('span', { className: 'nvl-err' }, `读取失败：${detail.error}`))
                        : h(MarkdownView, { text: detail.content, className: 'nvl-set-text nvl-md' }),
                  sample && sample.name === item.name
                    ? h(
                        'div',
                        { className: 'nvl-style-sample' },
                        h('div', { className: 'nvl-style-sample-head' }, sample.status === 'loading' ? '读取参考原文…' : `参考原文（${sample.chars} 字）`),
                        sample.status === 'error'
                          ? h('span', { className: 'nvl-err' }, `读不到：${sample.error}`)
                          : sample.text
                            ? h(MarkdownView, { text: sample.text, className: 'nvl-set-text nvl-md' })
                            : null,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'nvl-style-actions' },
                    item.active
                      ? h('span', { className: 'nvl-style-hint' }, '当前在用')
                      : h('button', { type: 'button', className: 'nvl-ghost', onClick: () => void use(item.name) }, '用这套'),
                    isEditing
                      ? [
                          h('button', { type: 'button', className: 'nvl-primary', disabled: saving, onClick: () => void save(), key: 'save' }, saving ? '保存中…' : '保存'),
                          h('button', { type: 'button', className: 'nvl-ghost', onClick: () => setEditing(null), key: 'cancel' }, '取消'),
                        ]
                      : [
                          h(
                            'button',
                            { type: 'button', className: 'nvl-ghost', onClick: () => setEditing({ name: item.name, text: detail.content }), key: 'edit' },
                            '编辑',
                          ),
                          item.sampleChars
                            ? h(
                                'button',
                                { type: 'button', className: 'nvl-ghost', onClick: () => void loadSample(item.name), key: 'sample' },
                                sample && sample.name === item.name ? '收起原文' : '看原文',
                              )
                            : null,
                          h(
                            'button',
                            {
                              type: 'button',
                              className: confirmDelete === item.name ? 'nvl-danger' : 'nvl-ghost',
                              onClick: () => void remove(item.name),
                              key: 'delete',
                            },
                            confirmDelete === item.name ? '再点一次确认删' : '删除',
                          ),
                        ].filter(Boolean),
                  ),
                )
              : null,
          )
        })
      }

      const context = items.length
        ? `当前在用：${active || '（还没有启用）'}\n` +
          (detail.status === 'ready' && open ? `正在看的这套「${open}」全文：\n${clipText(detail.content, 1200)}\n\n` : '') +
          `全部文风卡：\n${items.map(item => `${item.name}（${item.chars} 字）${item.active ? '｜在用' : ''}${item.summary ? `｜${item.summary}` : ''}`).join('\n')}`
        : '（还没有文风卡）'

      return h(
        'div',
        { className: 'nvl-pane' },
        header,
        h('div', { className: 'nvl-scroll' }, body,
          h(
            'div',
            { className: 'nvl-style-new' },
            h('input', {
              className: 'nvl-input',
              value: draftSource,
              placeholder: '原文路径，例如 D:\\books\\某本.txt（名字留空就用文件名）',
              onChange: event => setDraftSource(event.target.value),
            }),
            h(
              'button',
              { type: 'button', className: 'nvl-primary', disabled: !draftSource.trim() || cloning, onClick: () => void cloneFromSource() },
              cloning ? '克隆中…' : '克隆文风',
            ),
          ),
          h(
            'div',
            { className: 'nvl-style-new' },
            h('input', {
              className: 'nvl-input',
              value: draftName,
              placeholder: '新文风的名字，例如「湖城夜行」',
              onChange: event => setDraftName(event.target.value),
            }),
            h('button', { type: 'button', className: 'nvl-ghost', disabled: !draftName.trim(), onClick: () => void create() }, '新建空卡'),
          ),
          notice ? h('div', { className: 'nvl-hint', 'data-tone': notice.includes('失败') ? 'err' : 'ok' }, notice) : null,
        ),
        h(AskBar, {
          head: '文风讨论',
          book: (novel.data && novel.data.book && novel.data.book.title) || '',
          context,
          fallback: '这套文风哪里不像？给我三条能立刻改的具体做法。',
          placeholder: '想问我什么？比如「对话是不是太书面了」',
        }),
      )
    }

    // ------------------------------------------------------------ 第八页：版本
    /** 时间线用的相对时间：今天 14:04 / 昨天 23:10 / 3 天前 09:22 / 11-10 09:22。 */
    function shortTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value).slice(0, 14)
      const pad = n => String(n).padStart(2, '0')
      const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
      const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      const days = Math.round((dayStart(new Date()) - dayStart(date)) / 86400000)
      if (days === 0) return `今天 ${hhmm}`
      if (days === 1) return `昨天 ${hhmm}`
      if (days > 1 && days < 7) return `${days} 天前 ${hhmm}`
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`
    }

    const SOURCE_LABEL = { 'write:replace': '覆盖写', 'write:append': '追加', restore: '恢复', external: '外部改动', legacy: '旧备份' }

    /** 段落级 diff：作者关心「改了哪几段」，不关心第 17 个字。 */
    function diffParagraphs(before, after) {
      const split = text =>
        String(text || '')
          .replace(/\r\n/gu, '\n')
          .split(/\n{2,}/u)
          .map(item => item.trim())
          .filter(Boolean)
      const a = split(before)
      const b = split(after)
      const rows = []
      const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
      }
      let i = 0
      let j = 0
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
          rows.push({ kind: 'same', text: a[i] })
          i++
          j++
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          rows.push({ kind: 'del', text: a[i] })
          i++
        } else {
          rows.push({ kind: 'add', text: b[j] })
          j++
        }
      }
      while (i < a.length) rows.push({ kind: 'del', text: a[i++] })
      while (j < b.length) rows.push({ kind: 'add', text: b[j++] })
      return rows
    }

    function DiffView({ before, after }) {
      const rows = diffParagraphs(before, after)
      const added = rows.filter(row => row.kind === 'add').length
      const removed = rows.filter(row => row.kind === 'del').length
      return h(
        'div',
        { className: 'nvl-diff' },
        h('div', { className: 'nvl-diff-bar' }, `这段差异：+${added} 段 / −${removed} 段（绿色是这一版有、当前没有；红色相反）`),
        rows.map((row, index) =>
          h(
            'div',
            { key: `d${index}`, className: `nvl-diff-row nvl-diff-${row.kind}` },
            h('span', { className: 'nvl-diff-mark' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '·'),
            h('span', { className: 'nvl-diff-text' }, row.kind === 'same' ? clipText(row.text, 90) : row.text),
          ),
        ),
      )
    }

    /** 第八页「小说版本」：一章改过哪些版、每版什么来源、能不能回去。 */
    function HistoryPane() {
      const novel = useNovel(20000)
      const chapters = (novel.data && novel.data.chapters) || []
      const [picked, setPicked] = useState('')
      const activeId = picked || (chapters[0] ? chapters[0].id : '')
      const history = useJson(activeId ? `/history?chapter=${encodeURIComponent(activeId)}` : '/history-all', 20000)
      const [openVersion, setOpenVersion] = useState('')
      useBackStep(Boolean(openVersion), () => {
        setOpenVersion('')
        setDiffing(false)
      })
      const [versionText, setVersionText] = useState('')
      const [currentText, setCurrentText] = useState('')
      const [diffing, setDiffing] = useState(false)
      const [confirm, setConfirm] = useState('')
      const [notice, setNotice] = useState('')

      const versions = (history.data && history.data.versions) || []
      const current = (history.data && history.data.current) || { chars: 0 }

      async function openVersionAt(version) {
        if (openVersion === version) {
          setOpenVersion('')
          return
        }
        try {
          const value = await getJson(`${API}/version?chapter=${encodeURIComponent(activeId)}&version=${encodeURIComponent(version)}`)
          setVersionText(value.content || '')
          setOpenVersion(version)
          setDiffing(false)
          setNotice('')
        } catch (error) {
          setNotice(`读不到这一版：${error.message}`)
        }
      }

      async function toggleDiff(version) {
        try {
          const value = await getJson(`${API}/chapter?id=${encodeURIComponent(activeId)}`)
          setCurrentText(value.content || '')
          if (openVersion !== version) {
            const snapshot = await getJson(`${API}/version?chapter=${encodeURIComponent(activeId)}&version=${encodeURIComponent(version)}`)
            setVersionText(snapshot.content || '')
            setOpenVersion(version)
          }
          setDiffing(true)
        } catch (error) {
          setNotice(`对比失败：${error.message}`)
        }
      }

      async function restore(version) {
        if (confirm !== version) {
          setConfirm(version)
          setTimeout(() => setConfirm(value => (value === version ? '' : value)), 3000)
          return
        }
        try {
          const value = await postJson(`${API}/restore`, { chapter: activeId, version })
          setNotice(`已恢复到 ${version}（${value.chars} 字）${value.snapshot ? '，恢复前的内容也留了一版' : ''}`)
          setConfirm('')
          setOpenVersion('')
          setDiffing(false)
          await history.reload()
        } catch (error) {
          setNotice(`恢复失败：${error.message}`)
        }
      }

      return h(
        'div',
        { className: 'nvl-pane' },
        h(
          'div',
          { className: 'nvl-head' },
          h('span', { className: 'nvl-title' }, '小说版本'),
          h(
            'select',
            {
              className: 'nvl-select',
              value: activeId,
              onChange: event => {
                setPicked(event.target.value)
                setOpenVersion('')
                setDiffing(false)
                setNotice('')
              },
            },
            chapters.length
              ? chapters.map(item => h('option', { key: item.id, value: item.id }, `${item.id} ${item.title}`))
              : h('option', { value: '' }, '还没有章节'),
          ),
          h('span', { className: 'nvl-meta' }, `当前 ${current.chars} 字 · ${versions.length} 个版本`),
        ),
        h(
          'div',
          { className: 'nvl-tl' },
          notice ? h('div', { className: 'nvl-hint', 'data-tone': /失败|读不到/.test(notice) ? 'err' : 'ok' }, notice) : null,
          history.status === 'error' ? h('span', { className: 'nvl-err' }, `读取失败：${history.error}`) : null,
          !versions.length && history.status === 'ready'
            ? h('div', { className: 'nvl-empty' }, '这一章还没有历史版本。第一次覆盖写（或按文风重写）时会自动留一版。')
            : null,
          versions.map((item, index) =>
            h(
              'div',
              { key: item.version, className: 'nvl-tl-item', 'data-open': openVersion === item.version ? 'true' : 'false' },
              h('span', { className: 'nvl-tl-dot', 'data-first': index === 0 ? 'true' : 'false' }),
              h(
                'div',
                { className: 'nvl-tl-main' },
                h(
                  'div',
                  { className: 'nvl-tl-head' },
                  h('span', { className: 'nvl-tl-time' }, shortTime(item.createdAt)),
                  h('span', { className: 'nvl-tl-badge' }, `${item.chars} 字`),
                  h('span', { className: 'nvl-tl-badge', 'data-kind': 'source' }, SOURCE_LABEL[item.source] || item.source),
                  item.style ? h('span', { className: 'nvl-tl-badge', 'data-kind': 'style' }, item.style) : null,
                ),
                item.note ? h('div', { className: 'nvl-tl-note' }, `被「${item.note}」替换`) : null,
                h(
                  'div',
                  { className: 'nvl-tl-actions' },
                  h('button', { type: 'button', className: 'nvl-ghost', onClick: () => openVersionAt(item.version) }, openVersion === item.version ? '收起' : '看这版'),
                  h('button', { type: 'button', className: 'nvl-ghost', onClick: () => toggleDiff(item.version) }, diffing && openVersion === item.version ? '只看正文' : '和当前对比'),
                  h(
                    'button',
                    { type: 'button', className: 'nvl-primary nvl-tl-restore', onClick: () => restore(item.version) },
                    confirm === item.version ? '确认恢复？' : '恢复到这版',
                  ),
                ),
                openVersion === item.version
                  ? h(
                      'div',
                      { className: 'nvl-tl-body' },
                      diffing
                        ? h(DiffView, { before: currentText, after: versionText })
                        : h(MarkdownView, { text: versionText, className: 'nvl-reader-md' }),
                    )
                  : null,
              ),
            ),
          ),
        ),
        h(AskBar, {
          head: '版本讨论',
          book: (novel.data && novel.data.book && novel.data.book.title) || '',
          context: `《${(novel.data && novel.data.book && novel.data.book.title) || ''}》${activeId} 的时间线（当前 ${current.chars} 字）：\n${clipText(
            versions.map(item => `${shortTime(item.createdAt)}｜${item.chars} 字｜${SOURCE_LABEL[item.source] || item.source}${item.note ? `｜被「${item.note}」替换` : ''}`).join('\n'),
            1200,
          )}`,
          fallback: '这几版之间，哪一版的方向最好？下一章该怎么接着写？',
          placeholder: '想问我什么？比如「第二版和第一版差在哪」',
        }),
      )
    }

    // 右栏：五个常驻页 + 一个「更多」。九格 chip 在窄屏上必然被裁掉最左边那格
    // （平台条是 overflow-x:auto + touch-action:none + 隐藏滚动条，手指滑不动），
    // 所以事件 / 伏笔 / 文风 / 版本收进「更多」里用分段切换 —— 六个 chip 任何屏宽都放得下。
    const TAB_DEFS = [
      { id: TAB_ID, kind: TAB_KIND, title: '小说章节', chip: '章节', description: '章节清单、字数与正文', Pane: ChaptersPane },
      { id: 'dsh-novel/beats', kind: 'novel-beats', title: '小说章纲', chip: '章纲', description: '每章要拍的场景清单', Pane: BeatsPane },
      { id: 'dsh-novel/events', kind: 'novel-events', title: '小说事件', chip: '事件', description: '主线 / 感情 / 反派几条线怎么推进', Pane: EventsPane },
      { id: 'dsh-novel/characters', kind: 'novel-characters', title: '小说人物', chip: '人物', description: '人物卡与人物关系图', Pane: CharactersPane },
      { id: 'dsh-novel/settings', kind: 'novel-settings', title: '小说设定', chip: '设定', description: '地点、规矩、物品、术语', Pane: SettingsPane },
      { id: 'dsh-novel/outline', kind: 'novel-outline', title: '小说大纲', chip: '大纲', description: '查看与就地编辑大纲', Pane: OutlinePane },
      { id: 'dsh-novel/threads', kind: 'novel-threads', title: '小说伏笔', chip: '伏笔', description: '埋了什么、该在哪章收', Pane: ThreadsPane },
      { id: 'dsh-novel/style', kind: 'novel-style', title: '小说文风', chip: '文风', description: '照一本书的句子写', Pane: StylesPane },
      { id: 'dsh-novel/audit', kind: 'novel-audit', title: '小说巡检', chip: '巡检', description: '全书一次扫完：漏写、断档、欠场、到期', Pane: AuditPane },
      { id: 'dsh-novel/history', kind: 'novel-history', title: '小说版本', chip: '版本', description: '每章改过哪些版、回到哪一版', Pane: HistoryPane },
    ]

    // 右栏只有一格「小说」：九个分区收进页内的一排（会自动换行）——平台的 tab 条
    // 在窄屏只有两三百像素，注册几个就裁掉几个，与其和它抢宽度，不如自己在页内分栏。
    function NovelSections(props) {
      const [picked, setPicked] = React.useState(TAB_DEFS[0].id)
      const def = TAB_DEFS.find(item => item.id === picked) || TAB_DEFS[0]
      return h(
        'div',
        { className: 'nvl-pane' },
        h(
          'div',
          { className: 'nvl-seg nvl-seg-top', role: 'tablist' },
          TAB_DEFS.map(item =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'nvl-seg-btn',
                'data-on': item.id === def.id ? 'true' : 'false',
                onClick: () => setPicked(item.id),
              },
              item.chip,
            ),
          ),
        ),
        h(def.Pane, props),
      )
    }

    const TOP_TABS = [
      {
        id: TAB_ID,
        kind: TAB_KIND,
        title: '小说助手',
        chip: '小说',
        description: '章节 / 章纲 / 事件 / 人物 / 设定 / 伏笔 / 文风 / 版本 / 大纲',
        Pane: NovelSections,
      },
    ]

    // chip 一律用两字标题：九个页面挤一条时，长标题只会一起被裁。
    const chipTitle = def => def.chip || def.title

    function mountTabs(ctx) {
      const tabs = ctx.sidebarRightTabs
      if (!tabs || typeof tabs.register !== 'function') return

      for (const def of TOP_TABS) {
        ctx.effect(
          () =>
            tabs.register({
              id: def.id,
              kind: def.kind,
              // 页类型的标题是个函数（注册表按 definition.title(address) 取文本）。
              title: () => chipTitle(def),
              // guide 卡片的 title / description 同样要求是函数。
              guide: [{ id: def.id, title: () => def.title, description: () => def.description }],
            }),
          `dsh-novel: tab type ${def.id}`,
        )

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: def.id }, props => h(def.Pane, props)),
            ),
          `dsh-novel: tab body ${def.id}`,
        )
      }
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-novel')
        style.setAttribute('data-plugin-css', 'dsh-novel/client.css')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-novel: styles')

      ctx.effect(() => {
        window.addEventListener('popstate', onNovelPopState)
        return () => window.removeEventListener('popstate', onNovelPopState)
      }, 'novel: back step')

      // 右栏 tab 条：平台把它设成 overflow-x:auto + touch-action:none + 隐藏滚动条，
      // 于是九个页面挤成一条时，最左边那个在手机上永远滑不回来。这里自己接管横向拖动。
      ctx.effect(() => wireTabStrip(), 'novel: tab strip drag')

      // 平台在 rc 版里有个毛病：页面刚加载时连接状态会停在「连接异常，点击立即重连」，
      // 手动点一下才好。这里替用户点（只点「立即重连」，绝不点「刷新重试」以免死循环）。
      ctx.effect(() => autoReconnect(), 'novel: auto reconnect')

      // 座位一：输入框上方的常驻状态条。props 里带着输入框的动作面（inputActions），
      // 右栏「问 AI」要靠它把提示词塞进输入框，所以 props 必须透传。
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'dsh-novel.status',
                order: 20,
                // 会话级座位：让框架把当前会话 id 注入进来，接口请求才能带上 ?session=，
                // 否则书根只能退回到进程 cwd（一个进程一本书的老毛病）。
                inject: sessionId => ({ sessionId }),
              },
              props => h(StatusPill, props),
            ),
          ),
        'dsh-novel: dock entry',
      )

      // 座位一·保险：工具栏里的隐形座位，只负责抓 inputActions（不渲染任何 UI）。
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.activity', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.activity',
                id: 'dsh-novel.bridge',
                order: 90,
                inject: sessionId => ({ sessionId }),
              },
              props => h(ComposerBridge, props),
            ),
          ),
        'dsh-novel: composer bridge',
      )

      // 座位二：右栏 tab（类型 + 正文两段式）。右栏服务不是必需的，
      // 用 ctx.inject 延迟订阅；没有它插件其余部分照常工作。
      if (typeof ctx.inject === 'function') ctx.inject(['sidebarRightTabs'], inner => mountTabs(inner))
      else mountTabs(ctx)
    }

    exports.name = 'novel'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})


