# 小说助手 · dsh-novel


DSH（DeepSeekRuntime）插件：把「写长篇小说」变成一条模型能稳定接管的流水线——
章节结构、资料连续性、续写时的上下文装配、进度与字数反馈。

- 包名 / 目录：`dsh-novel` ｜ 插件短名（cordis row id）：`novel` ｜ 显示名：小说助手
- 两个半边：`index.js`（宿主 / Node 进程）、`client.js`（Web 壳 / 浏览器）
- **路线图与数据契约见 [docs/功能规划.md](docs/功能规划.md)**（写代码前先读它）
- 历史决策考古见 [docs/design.md](docs/design.md)

> 一句话定位：**一个工作区 = 一本书**。插件不存正文，正文永远是工作区里的 `chapters/NNNN.md`。

## 目标字数：book.json 说了算

每章目标字数的唯一真相是 `book.json` 的 `targetChars`。**没写**时插件用默认 3000，只在状态里标「默认值」，不会替你写进文件；要定下来就调 `novel_book({ targetChars })`。作者在大纲里写的「4 章 × 1000 字」只是散文，需要被翻译成 `targetChars: 1000` 才算数——否则会出现「大纲说 1000、自查按 3000 报偏短」的假警报。

目标字数是参考篇幅，不是上限。超出不报警、不导致自检失败，也不触发删减、缩写、提前收尾或强制分章；保留字数统计。是否分章由情节自然节点决定，关键动作、空间过渡和信息因果需要完整呈现。工具的上下文预算只限制装配包，不限制正文长度。

## 目录结构

```
dsh-novel/
  package.json        # manifest：main + dsh.bundle.patch + dsh.client.platform=web + exports "./client"
  cordis.patch.yml    # 插件层：insert 一行 { id: novel, name: dsh-novel }
  index.js            # 宿主半边：书模型 + 十八个工具 + /novel-api 路由（只读 + 十二个写接口）
  client.js           # 客户端半边：状态条 + 右栏一格「小说」，页内十个分区（章节 / 章纲 / 事件 / 人物 / 设定 / 伏笔 / 文风 / 版本 / 大纲）
  docs/功能规划.md     # 路线图 / 数据契约 / 技术红线（唯一真相）
  docs/design.md      # 最初的切面草案（保留作决策记录）
  README.md
```

## 它现在能干什么（v0.2 宿主 + 界面）

工作区里有一本书时（`book.json` + `chapters/*.md` + 可选 `outline.md`、`beats.md`、`events.md`、`characters/`、`threads.md`、`settings/`、`styles/`）：

> 没有 `book.json` 也能读：章 id 从文件名里认（`0003 第三章 湖心亭.md` → id `0003`、标题「第三章 湖心亭」），第一次 `novel_write` 时会自动补出 `book.json`。

- 输入框下方一条状态：`《雾港旧事》 2/3 章 · 597 字 · 伏笔 4`
- 右栏「小说章节」页：按**目标字数**的总进度条 + 章节行（`已写/目标`，`planned` 灰显「未写 +」，**点一下即建章并打开**）+ 点开读正文
- 右栏「小说人物」页：**列表 / 关系图**切换。列表是卡片（摘要 + 关系数），关系图是 SVG 环形布局，边取自人物卡 `## 关系` 小节的 `- 目标：说明` 行；没建卡的人物画成空心虚线点
- 关系图按时间回放：人物卡 `## 关系` 的行可以写 `- 老周 @0007：开始怀疑她`（自第 7 章起；不写就是从开篇就有，只记起点不记终点），图上选「关系截至 第 N 章」就能看关系网怎么长出来的网怎么长出来的；不写标记＝一直成立
- 人物生死时间线：人物卡加一节 ## 状态，写 - @0003 去世（雾港码头失足）、- @0004 现身（其实没死）；关系图把「截至第 N 章已死」的人画成灰色 + 名字带 †，跟死人相连的线变虚线，切章节能看到「死了又活」
- 新建一本书时，把 templates/AGENTS.md 拷到书目录根并改书名——它是给 AI 的作业规范（人物卡 ## 关系 / ## 状态 怎么写、设定首行 - 分类：、章纲 ## 0003 开头），DSH 会把它当项目指令自动注入，模型不用猜格式
- 右栏正文按 Markdown 渲染：标题、列表、粗体、行内码、引用、代码块、表格、分割线都能显示（渲染器是自带的 120 行实现，因为平台没把官方 Markdown 组件暴露给第三方插件）；**中文正文的单个换行当硬换行**（段落不粘连），行首全角缩进保留
- **手机返回键先退右栏一步**：章节正文 / 人物详情 / 展开的设定或文风 / 某一版历史，各占一格浏览器历史；按返回先回上一层（比如「正文 → 章节列表」），退到页面顶层才真的离开。实现在 `client.js` 的 `useBackStep` + `popstate`
- 右栏「小说大纲」页：按 `##` 分节显示，「编辑」可就地改并保存；底部「问 AI」把大纲全文 + 你的问题写进主对话输入框，回车即发
- 右栏「小说章纲」页：**单独一页**，按章节顺序列出每章要拍的场景清单（`beats.md` 每章一节），没写就「写章纲」，有就就地编辑保存；顶部显示覆盖进度，还有一行**节奏台账**（`爽点 N / 计划 M · 有爽点的章 X/Y · 钩子 K 章 · 最长断档 G 章`），每章标题右侧一个 `爽×2 钩` 徽标。台账是**从章纲标记现算的，不存盘**——所以不会和章纲打架
- 右栏「小说事件」页：**事件线台账**（`events.md`，一条线一节：`## 主线：远离与反扑` + `### 主线-1 真相落地（1–3）`，每个事件写 `- 因为：` / `- 所以：` / `- 不可替代：`）。一条线跨多章，一章也可以推好几条线；章纲里用 `- 事件：主线-1、感情-1` 锚定，区间只是默认值、锚点做修正。页面上按线分组，事件展开显示因果与覆盖章（`0001✓` 已写 / `0003○` 只有章纲）。**章纲页右缘还有一排窄泳道**，与每一章逐行对齐，一条线一列点，一眼看出「哪一章推了哪几条线、哪条线断了」
- 右栏「小说设定」页：世界观条目（`settings/` 一条一文件，地点/规矩/物品/术语），一行一条带分类徽标，点开读全文、可就地编辑保存
- 右栏「小说伏笔」页：未回收 / 已回收两段，每行「伏笔名 + 埋设章 · 计划回收章」，到期的标「到期」并给一条橙色提醒，「收回 / 重开」一键改状态（写回 `threads.md`）
- **每一页底部都有「问 AI」条**（章节列表 / 章节正文 / 章纲 / 人物列表 / 人物卡 / 设定 / 伏笔 / 大纲）：把这一屏的内容 + 你的问题写进主对话输入框，留空则问该页的默认问题；只填不发，回车由人按
- 右栏「小说文风」页：一套文风一行（名字 + 在用徽标 + 字数 + 一句话），点开读全卡，「编辑」就地改，「用这套」写进 book.json 的 style；底部可新建空卡。启用后 
ovel_context 会把文风卡一起装配给 AI，
ovel_check 会按卡里的 ## 禁忌 查禁用词（style-banned）。
ovel_check 命中后会提示「照着这套句子写」，不是靠形容词叮嘱。

- 对话里我可以用十八个工具替你写书：

| 工具 | 作用 |
|---|---|
| `novel_status` | 看整体：书名、章数、总字数/目标、人物卡张数、未回收伏笔、每章 `字数/目标 · 状态` |
| `novel_book` | 书的元信息：书名 / 作者 / 类型 / 一句话简介 / **每章目标字数**；`targetChars` 是全书默认（每章可单独覆盖），写章自查按它判长短 |
| `novel_read` | 读某一章正文 |
| `novel_write` | 写正文（`mode: append` 默认 / `replace`，可带 `status`；省略 `chapter` 自动建下一章并登记进 `book.json`） |
| `novel_outline` | 读 / 写 `outline.md` |
| `novel_context` | **续写前的标准动作**：一次拿到本章章纲、上章末、出场人物、台账适用范围、伏笔与文风。续写默认预算 60000、改写 80000 Unicode 字符，最多 200000；不限制正文长度。`ready: true` 保证全部 `[必选]` 文风规则已装配；旧章不会装入当前台账值。 |
| `novel_character_history` | 人物历史：`propose` 使用 `novel_deai_pack` 的 `evidenceIndex` 与逐字引文绑定实际场景；无法可靠归属时保持待核对，`confirm` 后才会从来源场景结束后继承。 |
| `novel_ledger` | 当前状态快照：查询或覆盖资产、境界、道具、伤势、位置和时间。更新同名项目会覆盖旧值，不保存历史版本；回改旧章须查前文或已有证据。 |
| `novel_card` | 人物卡：无参列清单 / 给 `name` 读 / 再加 `content` 写 |
| `novel_check` | 写完自检（只报告不改）：旧称残留 / 未登记说话人 / 重复句 / 半角标点 / 参考篇幅统计与偏短提示（超出不报错） / **章纲场次字面匹配候选（`beats-gap`，非阻塞）** / **这一章没有爽点（`no-payoff`，会带「已连续 N 章没有」）/ 章末没有钩子（`no-hook`）** |
| `novel_beats` | 章纲：无参看全书覆盖 / 给 `chapter` 读这一章的拍摄清单 / 给 `content` 覆盖写（只动这一节） |
| `novel_events` | 事件线：无参看全书事件线与推进情况 / 给 `line` 读那条线（含覆盖章、已写数）/ 给 `line` + `content` 整段替换这一条线（别的线不动） |
| `novel_threads` | 伏笔：无参看清单（未回收 / 已回收 / 到期未收）/ 给 `thread` + `planted`/`payoff`/`status` 登记或改状态 |
| `novel_style` | 文风：无参列卡 / **`clone: true` + `source`（原文路径）＝一键克隆**（取样后调用当前会话模型，保存有原文证据的规则和待校准卡片，默认启用）/ 给 `source` 或 `text` 只做**量化分析**（句长、段长、含引号段落占比、标点密度、高频双字组合和最多 5 段原文锚点）/ 给 `name` 读卡或写卡（`content`）/ `active: true` 顺手启用 |
| `novel_audit` | 全书巡检：`{ level?, limit? }`。把逐章检查横向扫一遍（空章 / 字数偏差 / 章纲漏写 / 伏笔到期 / 配角欠场 / 事件未锚 / 断爽），按严重度排序。**只报能算出来的事实，不给评语**；写完一批章跑一次，比逐章 `novel_check` 省事。 |
| `novel_export` | 导出正文：`{ from?, to?, format?, mode?, out? }`。全书或区间 → `export/` 下一个 txt/md，或按章拆开；返回章数、字数、落盘文件名。 |
| `novel_history` | 历史版本：`{ chapter }` 列这一章的时间线（时间 / 字数 / 来源 / 被什么替换 / 用的是哪套文风），`{ chapter, version }` 读那一版全文 |
| `novel_restore` | 恢复到某一版（`{ chapter, version }`）；**恢复前先把当前内容也留一版**，所以恢复本身能撤销 |

只读接口（供界面取数）：`/novel-api/state`、`/novel-api/chapter?id=`、`/novel-api/characters?chapter=`（含关系图 `graph`、人物 `states`）、`/novel-api/character?name=`、`/novel-api/threads`、`/novel-api/outline`、`/novel-api/beats?chapter=`、`/novel-api/settings`、`/novel-api/setting?name=`、`/novel-api/events?chapter=`、`/novel-api/event?line=`、`/novel-api/history?chapter=`、`/novel-api/history-all`、`/novel-api/version?chapter=&version=`、`/novel-api/styles`、`/novel-api/style?name=`、`/novel-api/style-sample?name=`、`/novel-api/audit`。
十二个写接口（都要求头 `x-novel-action: 1`，其余方法一律 405）：
`POST /novel-api/start-chapter`（`{ id }`，右栏点 `planned` 章节时建章）、`POST /novel-api/outline`（`{ content }`，大纲页保存）、`POST /novel-api/beats`（`{ chapter, content }`，章纲页保存）、`POST /novel-api/setting`（`{ name, content }`，设定页保存）、`POST /novel-api/thread`（`{ thread, planted?, payoff?, status? }`，伏笔页「收回 / 重开」与登记）、`POST /novel-api/style`（`{ name, content }`，文风页保存）、`POST /novel-api/style-active`（`{ name }`，切换在用文风，空名字＝取消）、`POST /novel-api/style-clone`（文风页选择 TXT 或 Markdown 文件，最多 32 MB。桌面端优先通过 `{ source, name? }` 交由宿主读取；网页端通过 `{ file: { name, data }, name? }` 上传，`data` 为原文字节的 Base64）、`POST /novel-api/style-delete`（`{ name }`，删一张文风卡：卡和参考原文一起挪进 `styles/.trash/`，删的正好是在用的那套就顺手取消启用）、`POST /novel-api/event`（`{ line, content }`，整段替换一条事件线）、`POST /novel-api/export`（`{ from?, to?, format?, mode? }`，把全书或区间导出到 `export/`）、`POST /novel-api/restore`（`{ chapter, version }`，恢复到某一版，先给当前内容留一版）。

**写入时会做格式校验**：章纲的全部写入入口共用严格结构校验；无结构化场景、缺失或非法时序、缺出场、缺人物块时会拒绝整次写入，文件保持不变。超过 8 场及语义核对线索仍只返回 `warnings`。`novel_card` / `novel_setting` / `novel_write` / `novel_threads` 继续按各自规则返回格式提醒。

书库根目录解析顺序：`config.root`（钉死）→ **会话自己的工作目录** → 环境变量 `DSH_NOVEL_ROOT` → 进程 `cwd`（兜底）。

## 安装（本机实测过的两条命令）

```powershell
# 装进试验 profile（独立进程，不碰桌面 App 里正在跑的会话）
dsh plugin --profile web add link:E:\workspace\idea-workspace\dsh-novel
# → 会自动往 web profile 的 dsh.profile.bundles 里追加 "dsh-novel"
```

`link:` 是跨盘符号链接，改源码 = 改已装包，不用重装。

> `desktop` profile **CLI 管不了**：`error: profile "desktop" is managed exclusively by the Electron application`。
> 装进桌面版要走 设置 → 插件 → 添加插件（填本地绝对路径），或 agent 侧的 `plugin_manager` 工具。

## 开发闭环

```powershell
# 起服务（工作目录 = 那本书）
cd E:\workspace\idea-workspace\novel-demo
dsh web --port 18080 --no-open        # 打印带 token 的 URL，例如 http://127.0.0.1:18080/?token=...

# 自检：插件有没有进启动图
$t = "<token>"
(Invoke-WebRequest "http://127.0.0.1:18080/?token=$t").Content | Select-String 'dsh-novel'
# 看 rev 有没有变：变了 = 新代码已生效

# 接口自检
curl.exe -s "http://127.0.0.1:18080/novel-api/state"
```

生效速度（实测）：

| 改什么 | 多久 |
|---|---|
| `client.js` | **保存即热替换**（dsh-client-hmr 500ms 轮询，SSE 推送），不用刷新 |
| `index.js` | 下一次「重组合」生效（动一下 profile 的 `cordis.patch.yml`，或在插件页开关一次），**不用重启 App** |
| `cordis.patch.yml` | 立即（`patchReload: live`） |

## 踩过的坑（都写进 功能规划.md 第八节了）

1. 客户端 `exports.inject` 只认**字符串数组**；写 `{required, optional}` 会被当成两个服务名，插件永远 pending。
2. 可选服务不要写进 `inject` 数组，用 `ctx.inject(['sidebarRightTabs'], inner => ...)`。
3. 右栏 `guide` 卡片的 `title` / `description` 必须是**函数**。
4. 宿主侧不要 import `@deepseek-ai/dsh-tools`（link: 装的插件解析不到），手写等价对象，但必须带 `output.render`。
5. 端口被占先查归属：`Get-NetTCPConnection -LocalPort 18080`；**54081 是桌面 App，别杀**。

## 占位梗概不算正文

`chapters/0001.md` 里只写一行 `（待写）重生在 1998 年…` 时，它只是结构，不是章节：

- `novel_status` 把它标成「待写（占位）」，不计入「已写 N 章」，另起一行告诉你「有 N 章还是占位」；
- `novel_check` 只报一条 `[placeholder]`，不再拿字数和章纲去制造噪音；
- `novel_write` 写入这种内容也不会把章节状态转成 `draft`。

## 设定为 0 时会主动喊

`novel_status` 与 `novel_context` 在 `settings/` 为空时都会提醒：世界规则只写在 `outline.md` 里等于没建，先用 `novel_setting` 建 3–8 条（地点 / 规矩 / 物品 / 术语）。这不是提示词，是宿主代码里的判断，模型绕不过去。

## 爽点 / 钩子：写在章纲里，不另建表

章纲的每一场末尾可以标三种东西：

```markdown
- 场景：江野 → 把批条推过去 → 柜员脸色变了 → 爽点（信息压制）
- 落点：出门时有人叫住他。钩子：王厂长在车里等着。
```

- `→ 爽点（类型）`：这一场给了读者情绪回报（打脸 / 翻盘 / 揭秘 / 情感兑现 / 强强对话 / 信息压制）。
- `→ 钩子`：章末留翻页理由，每章至少一个。老写法 `钩子：…` 也认。
- `→ 转折`：这一场把方向拐了个弯。

**没有 `爽点.md`，也不需要。** 爽点只有一个端点（发生在哪一场），是场景属性；单独建表必然和章纲形成双份真相，而且模型写正文时装配的是章纲，表在写作路径上看不见。所以台账由宿主现算：

| 看哪里 | 显示什么 |
|---|---|
| 章纲页顶部 | `爽点 12 / 计划 15 · 有爽点的章 8/12 · 钩子 11 章 · 最长断档 3 章`，断档 ≥2 章时变红 |
| 章纲页每章 | `爽×2 钩` 徽标 |
| 输入框上方状态条 | `· ⚠ 断爽 3 章` |
| `novel_status` | 全书节奏一行 + 断档提醒 |
| `novel_check` | `no-payoff` / `no-hook` |
| `novel_context` | 装配包里一段「## 节奏（这一章怎么给读者回报）」 |

预算（`打脸×3` 这种）写在 `outline.md` 的 `## 爽点节奏` 里，属于计划层；实际有几处永远以章纲标记为准。

## 导入旧稿：读文件的能力归插件，判断边界归 AI

不另设「导入」工具 —— 它无非是现有工具的编排。插件只负责 AI 做不好的那件事：**编码和分页**。

```js
novel_read({ source: 'D:\\books\\旧稿.txt', limit: 4000 })            // 自动认 UTF-8 / GBK / UTF-16
novel_read({ source: 'D:\\books\\旧稿.txt', offset: 4000, limit: 4000 }) // 接着读
```

返回里带 `encoding` / `chars` / `nextOffset` / `done`，所以不分页也不会读漏。剩下的交给会话里的 AI：

1. `novel_read({ source })` 扫几屏，看清章节标题长什么样（有没有「第N章」、有没有目录页）
2. **它自己判断边界** —— 插件不猜，猜错一次要重导
3. 逐章 `novel_write({ chapter, title, content })` 落盘（自动留历史版本）
4. `novel_status` 核对章数与字数
5. 需要的话再逆向提炼：`novel_outline` / `novel_card` / `novel_setting` / `novel_style({ clone: true, source })`

长篇别让它一口气读完：每 8–10 章派一个 subagent 只读原文、只返回摘要，主上下文负责汇总。

## 去 AI 味与全文语义复核

生成或改写前，`novel_context` 现在自动带上 `materialPreflight`；也可用只读的 `novel_preflight({ chapter })` 单独查看。预检对照本章章纲与启用文风的字面规则，展示语义约束、章纲原文及本章备忘，候选命中不等于确认矛盾。启用文风缺失会明确提示。上下文预算不足时应增加装配预算或分次读取资料，不能压缩正文来迁就。

资料按用途区分：正文是当前表述，设定是声明规则，人物卡是人物资料，文风是表达约束，章纲、大纲、事件线是计划，`threads.md` 可能含计划和旧备忘。备忘不自动高于正文，来源差异须先核实。章纲中的内心台词默认保留意图与情绪并按文风表达，移除了默认“逐字写进正文”的指令；作者明确要求逐字引用时遵从作者要求。预检不自动修改任何资料，也不认证材料没有冲突。

审稿协议升级至版本 6，必须提交 `observations`（无发现填 `[]`）。每条填写 `aspect/classification/detail/evidence/counterargument`：`conflict` 为确定矛盾，另填 `comparison: { entity, property, timeScope }` 并提供至少两条不同证据；`missing-basis` 为依据不足；`preference` 为可选表达偏好，单列 `preferenceNotes`，不阻塞定稿。六项汇总中的 conflict/uncertain 必须有对应观察；仅凭正文与历史备忘不同不能自动判正文写错。引用新增支持 `threads`、`events`，逐字校验并绑定来源哈希。旧版记录需按新协议重新登记，字段完整仍不代表推论正确。

去味由机械线索检测和会话语义审稿共同完成；插件不会自动改稿，也不会把检测通过当作自然度认证。

1. **写作前约束**：普通 `novel_context({ chapter })` 和改写装配包都包含场景审稿纪律与最新交付流程，已有小说无需重建规范文件。`pass: "deai"` 额外带上机械命中线索。
2. **阅读全文**：`novel_deai_pack({ chapter })` 返回全部非空正文段落、原文坐标、整章 `baseHash`、人物声口和完整文风卡。语义审稿先还原空间、动作、工具、时间、安全约束与技术因果，再检查对白、紧张场景的设定投放、格言式总结和无设定依据的逐项感官报幕。包内附设定索引，涉及机制时按需读取完整条目；缺失前因或存在矛盾时先修订或澄清，不能以脑补步骤登记完成。
3. **按需修改**：`novel_write({ chapter, mode: "patch", baseHash, patches: [{ start, end, content }] })` 一次提交多个不重叠修改，所有坐标基于同一版原文。原有单片段写法仍可用；每次写入后需要重新取包，不能复用旧哈希和坐标。
4. **登记复核**：对最终审稿包全部段落提交 `{ index, reason }`。带对话标签的段落另填 `dialogue.kind` 区分实际对白（`speech`）、内心（`thought`）、引用（`quotation`）或无法确定（`uncertain`）；实际对白必须填写 `speaker`、`listener`、`intent`、`pressure`、`assessment`，结合章纲和现场判断表达目的、听者、时间压力与措辞。按场景提交 `scenes`：连续的 `startIndex/endIndex` 必须覆盖全文，每场填写 `layout`（布局）、`mechanism`（主要因果链）、`timeline`（完整时间线）与 `actions`。关键动作逐条记录 `index` 和 `actor/from/to/action/tools/prerequisites/result/timing/safety`，核对位置、工具来源、前提、结果、耗时和危险禁令。同段多动作逐条记录；静态场景可用空动作数组，但须说明依据。再填写 `checks` 的 `continuity`、`timing`、`voice`、`narration`、`rhythm`、`facts`，调用 `novel_deai_review({ chapter, baseHash, styleHash, checks, observations, timeBudgets, scenes, paragraphs })`。启用文风时 `styleHash` 必填，取包后换卡或切换文风会拒绝登记。每项 `checks` 使用 `{ verdict, detail, evidence, counterargument }`，不再接受一句肯定话。`verdict` 为 `supported`、`conflict`、`uncertain` 或 `not-applicable`；至少一条正文逐字引文，确认矛盾至少两条不同引文。正文证据写 `{ source: "chapter", index, quote }`；其他来源为 `beats`、`outline`、`events`、`threads`，或带实际条目名 `name` 的 `character`、`setting`、`style`。工具验证引文存在、正文段号准确，并记录来源哈希。`counterargument` 说明最可能推翻结论的证据或缺失依据，不将推测当原文。记录保存在 `book.json` 对应章节的 `deaiReview` 中；正文、被引用资料或启用文风变化后失效。旧版无证据记录需重新提交。整章段落多、payload 很长时，可先把 `checks`、`observations`、`timeBudgets`、`scenes`、`paragraphs`（以及 `resolutions`）写成一个 JSON 对象文件，用 `novel_deai_review({ chapter, baseHash, payloadFile })` 传入：工具按同一套规则校验，直接传的字段优先于文件里的同名字段。多个写工具（如 `write`、shell heredoc）都可以拼出这份文件，从而避免单次工具调用过长被截断成非法 JSON。

**报错定位**：`checks` 六维必须各带至少一条正文逐字引文；缺哪一维、缺哪一项会逐条列出（如 `voice.evidence 需至少一条 chapter 引文（段号 index ＋ 逐字 quote）`）。引文校验失败会给出具体来源与段落（如 `chapter 第 2 段 里找不到「…」`），不再只回一个来源键。
5. **最后自查**：`novel_check({ chapter })` 默认开启机械线索检测；`aiTone: false` 仅关闭该检测，不跳过语义复核。当前版本未复核会报 `deai-review-pending`。`conflict` 和 `uncertain` 会实际保存为 `blocked`，按连续性、时间、信息缺失、对白、叙述和句段顺序回显；即使其余字段完整也不能标记 `final`。旧阻塞项转为通过时必须填写对应 `resolutions`，说明修复依据或更正原因，旧问题和处理理由保留在 `resolvedFindings`。机械结果与已登记语义问题分别显示；模型未登记的问题不会被伪称为自动检出。
6. **右栏入口与旧书**：「去AI味」按钮提示先读取完整审稿包并局部修改，不再截取 1200 字要求整章覆盖。`novel_book({ scaffold: true })` 可为旧书追加或更新插件管理的复核小节，保留原有自定义内容。

`ai-tone` 报零类不代表自然，出现线索也不必强改。正常重复、长句、对比和角色口癖可以保留；不通过统一粗口、抢话或短句来消除线索。当前版本已登记完整语义复核后，机械线索仍会展示，作为复核参考而不再单独判失败；正文变化后需重新复核。复核记录表示会话提交了审稿依据，不能证明其判断一定正确。

审稿机制的通用验收场景见 [审稿验收](docs/review-acceptance.md)。引文存在校验不等于推论成立；物理、因果和文风判断仍需会话模型复核，不能用字段齐全证明审稿质量。

`beats-gap` 与 `info-missing` 使用字面近似匹配，只表示待对照的场景或信息，现放入非阻塞 `heuristicNotes`，不据此认定漏写。保存及全书巡检也会注明匹配局限；若模型确认必要信息确实缺失，仍可用逐字证据登记语义问题。

登记与检查的可见回执直接显示 `status`、`certifiesSemantics: false` 及 conflict/uncertain 计数。有阻塞时状态为 `blocked`，“已登记”只描述保存动作。检查将机械及资料项、审稿阻塞、待登记提示分别计数，并列出机械及资料项的种类；这些数量不是已经确认的正文错误数。阶段内没有单步耗时不单独构成缺陷，也不要求为验收补计时句。

### 章节状态与显式定稿

- 空、纯空白或待写占位正文为 `planned`；其他非空正文通常为 `draft`，不能因导入时传 `planned` 而继续显示未写。
- `recorded` 只开放定稿资格，不自动把草稿提升为 `final`。如需定稿，把当前完整正文原样作为 `content`，用 `novel_write({ chapter, content, status: "final" })` 明确请求；没有当前有效复核或仍有阻塞项时，整次写入在落盘前拒绝。
- 已定稿章逐字写回且复核仍有效时保留 `final`；明确传 `draft` 则保持草稿。正文、引用资料、来源覆盖要求或启用文风变化后，章节列表、上下文与历史列表按当前有效性显示 `draft`，与 `novel_check` 的待复核/阻塞结果对应。
- 新导入的非空原文为 `draft`，不能在正式 `novel_import` 中直接请求 `final`；先导入、审稿，再显式定稿。默认 skip 和空来源保护不改已有章节；覆盖后的旧 `final` 必须重新满足复核门槛。
- 恢复历史正文仍先留存恢复前内容。仅已有 `final` 声明且恢复内容的复核仍有效时保留定稿；原本是草稿则不自动晋级，空/占位恢复为 `planned`。工具与 HTTP 恢复回执均返回实际 `status`。
- 启用文风卡的完整指纹独立绑定，不因某一维度登记 `not-applicable` 而漏掉同名卡变化。`novel_deai_pack` 返回 `style.hash`；启用文风时登记必须提交 `styleHash`，取包后更换同名卡、切换到正文相同但名称不同的卡，或切换启用文风都会拒绝登记，要求重新取包。即使启用卡缺失或为空，审稿包也会显示可提交的指纹并标明资料不足。旧记录可沿用已引用文风的哈希；没有可验证指纹的旧记录需重新审稿。
- 启用文风卡缺失或为空时，资料预检、登记和复核失效检查共用同一判定：即使 `narration`/`rhythm` 登记为 `not-applicable`，也会作为资料不足阻塞定稿，不能把缺资料当成无约束。
- 正文保存、审稿登记、导入、恢复、建章、改书信息和切换文风都在同一把 `book.json` 写锁内读取当前书目、校验并提交；并发请求不会用旧快照覆盖新登记的阻塞审稿或状态。书目和文风启用都用同目录临时文件加原子替换写入，读取方不会解析到写了一半的 JSON。
- 列表读取只投影当前有效状态，不重写作者的定稿声明或历史复核。`book.json` 中保存的 `deaiReview.status` 是登记时结果，当前复核以 `novel_check` 为准；正文与资料逐字恢复后，内容指纹匹配的记录可以重新有效。

### 登记校验（版本 6）

版本 5 及更早记录需要重新取包、登记，不会自动视为符合新版校验。工具新增的阻塞项不能被模型提交的 supported 覆盖。

- `timeBudgets` 无窗口填 `[]`；有窗口提交 `label/unit/availableText/evidence/phases`。阶段通过 `parallel` 声明串并行，任务按 `stated/estimated/unknown` 标明依据。明示 `duration` 必须与逐字 `durationText` 及窗口单位一致；未知耗时不填数字，不换算单位。阶段顺序相加，并行阶段取最长值。明示下界超限报矛盾，无效耗时引用或缺少并行依据产生校验阻塞；估算或未知只记录计算局限，不单凭它们自动阻塞，也不认证动作可行。具体动作疑点仍由模型逐条登记。发现候选时间窗口却没有预算时，不能仅凭文字宣告确定通过。
- 登记结果的 `evidenceContexts` 回显所有引文所在的完整段落，包括 supported 项。正文按段号定位；其他资料中重复的引文回显所有匹配段落。`novel_check` 的结构化语义状态也包含完整上下文和预算结果。
- 审稿包返回 `sourceRequirements`：voice 引用实际出场人物卡，narration/rhythm 引用启用文风卡，facts 引用正文点名的设定。引用必须属于对应维度；其他维度引用不抵扣，缺少来源会保存为 uncertain。来源覆盖要求变化后，旧记录失效。

时间数量还要区分经过时间、剩余量和时点：“还剩六息”不能被登记成“操作耗时六息”，“第九息”不能直接当持续九息。工具结合被引位置的完整上下文识别常见标记，角色不明时保存 uncertain；即使数值恰好相加等于窗口，也不能因此确定通过。当前版本记录在检查时会按当前规则重新计算，不沿用旧的已存计算结论。

数值可容纳不代表动作没有遗漏；来源类型覆盖不代表引文支持推论。工具仍不能自动证明并行关系、物理机制和文风判断正确。

审稿有效记录的状态使用 `recorded`，不再使用容易误读为通过的 `reviewed`；`certifiesSemantics` 固定为 false。旧记录在读取时按当前规则重算状态，不需手工改 book.json。时间报告标记 `scope: "arithmetic-only"` 和 `feasibility: "not-automatically-verified"`：即使在正文中补齐三、四、两息，使 3+4+2=9，也只说明记账一致，不能自动认证动作可行。

`style-drift`、`no-interior`、`payoff-no-reaction` 在 `novel_check` 中归入 `heuristicNotes`，只作非阻塞提示，不导致检查失败。反应检测使用当前段及后两段全文，只有展示样例被截短；0% 代表词表未命中，不代表人物缺少自然反应。不要为了清除提示添加发抖、喉咙发紧等动作，或把句号机械改成逗号。作者只要求检查时保持正文不变。

## 节奏与戏份：规格写在数据里，不是写死在代码里

- **爽点断档阈值**取 `outline.md` 里的「三章一爽点」/「每 3 章至少一次爽点」，中文数字也认；读不到才退回默认 2。状态条的「断爽 N 章」、章纲页红字、`novel_check` 的 `no-payoff` 都按这个数。
- **戏份承诺**写在人物卡：`- 戏份：每 8 章至少出场一次`。插件按正文统计出场（含卡里的「旧称」），超期报 `absent-role`，人物页挂「欠场」徽标，`/novel-api/characters` 的 `appearance` 字段带 `{last, gap, cadence, due}`。
- 出场统计按「书的内容指纹」缓存，轮询不会把几十章反复读一遍；只看「有正文的章」，占位梗概不算出场。
## 右栏只有一个 tab

平台 tab 条每个 chip 最小 80px、不换行、手机上还滑不动，十页放不下（试过合并、试过「更多」页、试过改 CSS 让条子能横滑，都被裁）。现在是**一格「小说」+ 页内九个分区**，分区按钮在页内自动换行，小屏也点得到。
## 文风闸门：写完当场比一次节奏（`style-fit`）

文风卡只在开头注入一次是不够的：实测一本 80 章的书，句均字数从 17 掉到 10.1、含对话段占比从 26% 涨到 64.5%、每千字句号从 46.8 涨到 89.7 —— **漂移是单调累积的**，写歪一章，下一章会照着歪掉的稿子继续歪。

所以插件在三个地方替他盯着（基准是文风卡的 `.sample.md` 原文，没有样本就退回卡里的 `## 锚点原文`）：

| 位置 | 行为 |
| --- | --- |
| `novel_write` | 写完自动比一次节奏，偏离就在返回的 `warnings` 里点名 |
| `novel_check({ chapter, aiTone: true })` | 返回非阻塞 `style-drift` 统计提示，写清与锚点的差异，不要求自动改稿 |
| 右栏章节列表 | 偏离的章挂一个「漂」红标（数据来自 `/novel-api/audit`） |
| `novel_audit` / `GET /novel-api/audit` | 全书一次扫，`style-drift` 与 `beats-gap` 一起列 |

这些都是可数的统计量，不自动判断写作质量。句均字数和每千字句号的偏差会产生复核线索；段均字数、对话比例、逗号、破折号和省略号保留为参考值。它们不构成必须改稿的硬判据，也不能作为把短句拼成长句或强添身体反应的理由。明确的字面禁用词与结构错误仍按原有规则检查。

正确用法：出现 `style-drift` 时先对照文风锚点和完整场景复核，确认问题后局部修订，再登记最终版本语义复核；不因统计偏差就直接整章重写。

## 文风上下文装配（2026-11-16）

- [x] 顶部视角与叙述权限优先注入；列表项开头的 `[必选]` 是硬约束，会进入总上下文最低预算，不受文风软份额静默裁剪。
- [x] 按完整条目选择规则、锚点与正反例；预算不足时不截断。条目在重排或省略后重新附上所属标题，「反例」「少用词」「语义禁忌」不会失去分类。
- [x] `novel_context` 返回 `requiredItems`、`missingRequired`、`minimumBudget` 与 `budgetUnit`；`ready: true` 时所有 `[必选]` 均在最终提示中。可选锚点仍整段纳入或整段省略。文风与总预算均按含空白及标题的 Unicode 字符计，不是 token。

验证：`node --test tests/style-context.test.mjs`；`node --check index.js`。宿主联调及真实生成效果尚未验证。


### 禁忌解析与检查（第二项）

- [x] 模板一行一项：`禁用词：氤氲`、`整句：他拿起笔。`；兼容旧卡的斜杠、顿号词表，以及带空格斜杠分隔的整句列表。整句内部标点保留。
- [x] `## 少用词` 只提醒；`## 语义禁忌` 交给会话 AI 复核。未标类型的“不要 / 不得 / 避免”等自然语言要求转入待复核，并提供格式提醒。
- [x] `novel_check` 禁用项返回命中总数与前 20 处行列、原文片段；新增 `styleReview` 返回少用词命中、语义待复核项和格式提醒。这些提醒不单独导致 `ok: false`，`ok` 仅反映自动检查结果。

验证：`node --test tests/*.test.mjs`（7 项通过）。


### 上下文预算与局部改写（第三项）

- [x] `novel_context.budget` 约束最终 `prompt`，以含空白、标题和指令的 Unicode 字符计量，不是模型 token 上限；结构化元数据与宿主封装不在此额度内。
- [x] 必要内容放不下时返回 `ready: false`、`minimumBudget` 和后续操作，不再截取长章前 6000 字符后引导整章覆盖。
- [x] 新增 `rewriteStart` / `rewriteLimit`，返回 `rewriteScope`（start、end、total、nextStart、baseHash）。索引按 Unicode 字符，start 包含、end 不包含。
- [x] `novel_write` 支持 `mode: "patch"`，必须提供 chapter、start、end、baseHash，仅替换指定范围，保留其余正文并沿用整章历史备份。原文哈希不一致拒绝写入。`replace` 可提供 baseHash；旧调用保持兼容。

```js
novel_context({ chapter: '0001', mode: 'rewrite', rewriteStart: 0, rewriteLimit: 1000, budget: 6000 })
// 仅在 ready=true 后，根据返回的 start/end/baseHash 提交修改：
novel_write({ chapter: '0001', mode: 'patch', start: 0, end: 1000, baseHash: '<返回值>', content: '<修改后的片段>' })
```

每次保存后重新读取上下文，重新确定下一段起点：修改会改变长度，旧 nextStart 和旧哈希不能直接复用。先核对事实、动作、信息点，再调整文风；这部分仍需会话 AI 复核。

验证：`node --test tests/*.test.mjs`（11 项）、`node --check index.js`。宿主联调尚未完成。


## 场景人物与认知契约（2026-11-18）

新章纲支持场景角色与认知历史，不提供旧数据迁移。人物页显示定位、重要程度与经历；章纲页展开“场景人物”可查看入场状态和确认候选。

1. 人物卡顶部填写 `- ID：hero`、`- 定位：男主`、`- 重要程度：核心`。稳定 ID 全书唯一，不随姓名变化。全局卡记录稳定设定；作者侧秘密不等于人物已知。
2. 章纲每章仍为 `## 0001 标题`；每场为 `### 场景 scene-id：标题`，必填 `- 时序：10`、`- 出场：hero、heroine`；记录故事时间、地点、视角、冲突、具体事件 ID。时序是故事先后顺序的整数，不是章号；倒叙用较小值，建议预留间隔。
3. 每位出场者用 `#### 人物 hero` 块，写已知/未知/误信/怀疑及来源、目标、关系与情绪、表达意图、触发、计划变化。仅被提及者写入 `- 提及：ID`，不算知情或出场。
4. 写前调用 `novel_context({chapter:"0001",scene:"scene-id"})`；认知只继承更早时序、已确认且来源有效的历史。本场变化在触发后才能用于对白。未记录不代表明确未知。
5. 写后先用 `novel_deai_pack` 取得非空正文段号，并在 `novel_deai_review.scenes` 中按正文顺序连续分场；本章有结构化章纲时每场用 `sceneId` 声明对应的稳定场景 ID。逐场提取实际变化时调用 `novel_character_history({action:"propose",character:"hero",scene:"scene-id",kind:"已知",content:"认知内容",source:"亲历/转述等信息来源",evidenceIndex:7,evidence:"第 7 段中的正文逐字引文"})`。关系变化 kind 为 `关系`，另给 `target` 人物 ID；可给具体事件 `event`，纠正旧认知用 `supersedes` 记录 ID。
6. 候选只有在正文哈希、逐字段号、显式 sceneId、实际分场范围和章纲场景都一致时才返回 `binding.status: "bound"`；无法可靠归属时保持待核对。核对实际含义后，经作者确认或已授权流程调用 `confirm`（character+id）；不接受的候选用 `revoke`。历史落盘 `character-history/人物ID.md`。正文、分场或章纲场景变化会使旧记录待复核，必须重新提取；不把章纲计划自动确认。
7. 整场顺延用 `novel_move_scene({scene:"scene-id",chapter:"0002"})`，整块保留人物约束；不用旧的逐行 carryOver 拆分结构化场景。
8. 同场需要明确先后获得信息时，在人物块写清触发点；若需要在中途保存可继承状态，把该场拆成两个稳定场景 ID。当前确认记录的生效点为场景结束。

模板见 `templates/character-card.md` 和 `templates/scene-outline.md`（插件仓库资源）。


## 章纲 v2：心理、登场与分层审核

章纲首页只显示章节目标、场景冲突/结果和收尾。点击“人物”审阅某角色在各场景中的认知、动机、心理安排与登场呈现；“事件线”查看本章关联节点及已确认变化；“表现核对”展示语义检查清单与来源问题。事件定义和描写计划不等于正文已落实。

人物块可按需填写：

```markdown
#### 人物 heroine
- 心理触发：听到主角道谢
- 心理内容：怕自己的来意被识破
- 叙事作用：解释回避
- 表达方式：通过停顿和收回目光间接表现
- 视角权限：仅作者参考
- 登场性质：首次正式登场
- 观察者：hero
- 描写重点：高挑体态、磨旧的袖口
- 呈现时机：伸手接茶时
```

场景写 `- 视角：人物ID` 和 `- 叙述方式：限知/全知/客观`。主配角都可有心理材料，但直接呈现须符合视角；不设数量或密度配额。只有 `- 保留心声原句：…` 要求原句保留。外貌可因暗处、伪装等填写 `- 不描写原因：…`，不要求全身扫描。

局部编辑可在界面完成，或调用 `novel_stage_edit({chapter,scene,character,baseHash,fields})`。`baseHash` 来自 `novel_context` 的 `stage.baseHash`；不提供 scene 时编辑章节目标/收尾，提供 scene 而不提供 character 时编辑场景。字段值为单行文本，空字符串删除该字段；保留未知字段与其他人物。版本冲突不覆盖，草稿保留在当前浏览器会话，重新核对后保存。

实际外貌呈现可通过 `novel_character_history` 的 `kind: "呈现"` 提交逐字正文依据并确认。它按章节阅读顺序供后文参考，不进入人物认知；来源变更后仍需复核。

验证：`node --test tests/*.test.mjs`。可选浏览器验收脚本 `tests/stage-v2-browser.mjs` 使用外部目录安装的 React、esbuild、Playwright，不增加插件运行时依赖；用法见脚本注释。


## 创作拷问（grill me）

对 AI 说“拷问一下这个角色”“这段剧情多问问我”即可启用 `novel_grill`。默认深入追问，每轮一个问题、2–4 个选项及各自后果，同时支持自定义回答、组合选项、留白、暂停和改答。当前通过聊天文字展示问题和选项，不需要专用按钮。

工具流程：`start({mode:"character"或"plot",topic,sources?})` → AI 根据资料调用 `ask` → 展示问题并等待用户 → `answer` → 继续深入。这里括号内容指对应 action 的参数；实际调用统一为 `novel_grill({action:"start",mode:"character",topic:"顾七的底线"})`。`sources` 是书稿内 Markdown 相对路径；不传时读取已有 outline.md、beats.md 及主题中点名的人物卡，其他相关资料可用 `refresh` 增加。深度可选 quick/deep/relentless，默认 deep。

`list` 查看访谈，`inspect` 恢复材料，`pause/resume` 控制状态，`revise` 改答并标记下游待核对，`summarize` 阶段总结但不结束，`finish` 保存角色卡或章纲草案。除 start/list/inspect 外均带最新 `baseHash`。相关资料改变时需核对后 refresh；只有明确决定的用户回答及其逐字引文可进入草案 decisions，未选方案和留白不能认证为决定。引文校验不代替语义核对。

访谈持久化在书稿 `.novel/grills/`，属于工作草稿，不是正式设定或正文。finish 不直接修改人物卡和章纲；AI 按用户授权通过现有编辑工具保存，无须对已有授权重复询问。访谈过程和未选方案不默认进入正文上下文。旧书无须更新 AGENTS.md，也能通过工具说明使用。
