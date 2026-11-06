---
name: workflow-studio
description: Use when changing the Workflow Studio (工作流开发平台) Electron app (画布/卡片/agent 集成/开源维护). 提供结构、验证方法与改法。
---

# 工作流开发平台 · 开发手册

## 何时用

改这个仓库的任何东西：界面、卡片模型、agent 调用、读取链路、导入导出、开源文件。
代码在仓库根目录（`renderer/` 是界面与全部状态，`main.js` 是主进程，`preload.js` 是桥）。

## 启动与验证（每次改完都要做）

```bash
cd <仓库根目录>                                   # 在 dev 工作副本里改；正在用的那份不在里面改
node --check renderer/app.js && node --check main.js      # 语法
export CDP_PORT=9333                               # 实现 9333 / 验收 9334 / 主管 9335；9222 是用户在用的窗口：不连、不关
pkill -f "remote-debugging-port=$CDP_PORT"; sleep 1        # 只关自己端口的实例——不带端口的 pkill 会把用户的窗口一起关掉
./node_modules/.bin/electron . --remote-debugging-port=$CDP_PORT --user-data-dir=$TMPDIR/wf-$CDP_PORT &   # 隔离实例：独立端口 + 独立数据
sleep 8
# tools/shot.js 读 CDP_PORT（不写就是 9222 = 用户的窗口，所以先 export）；tools/eval.js 仍写死 9222，别用。有的 scripts/ 不设 CDP_PORT 也默认连 9222，所以先 export
node skills/workflow-studio/scripts/cdp-await.js probe.js         # 要 await 页面异步函数时
node skills/workflow-studio/scripts/cdp-canvas.js                 # 平移/缩放/拖动/贴边自动滚/重叠（自己还原位置）
node skills/workflow-studio/scripts/cdp-dock.js                   # 拖卡进插槽：悬停/接入/拒绝成圈/拔出/成果槽 + 动画收干净
node skills/workflow-studio/scripts/cdp-dock.js --record docs/dock.gif   # 同时录演示（.gif / .mp4，ffmpeg）
```

`tools/eval.js` 只是同步求值（没有 `awaitPromise`），等不到 `chatSend` / agent 回答。要断言异步结果
（聊天回复、候选卡、异步改状态）用 `scripts/cdp-await.js`：探针可直接写成文件传进去，页面里抛错会
打出 `PAGE ERROR` 而不是一个空 `{}`。

**探针必须自成一体**：每个探针先自己 `openCard(flow().nodes[i])` 再读 DOM/状态，不要依赖上一次 CDP
调用留下的 `selId`。用户可能同时在窗口里点（点空白就取消选中），两次调用之间状态会变，症状是
`find(selId)` 为 undefined、`Cannot read properties of undefined (reading 'chat')` 或结果 `{}`。
读 `find(...)` 的返回值前先判空。

探针要调异步函数（`chatSend` / `dockSend` / `askAgent`）时，**整段用 `(async () => { … })()` 包起来**传进
`cdp-await.js`：`Runtime.evaluate` 不接顶层 `await`，直接写 `await dockSend(...)` 只会静默返回
`undefined`，看上去像“函数没生效”。

断言前先确认 `flow()` 是哪条工作流：用户会自己「新建工作流」并切过去，那时 `flow().nodes.length === 0`
是正常状态，不是画布炸了。要么断言 `store.workflows.find(w => w.name === '…')`，要么先切到目标
工作流、测完切回用户原来那条（同时不要清掉用户刚打的对话）。

**分不清是产品 bug 还是“用户也在点”时，别猜，开隔离实例复测**：

```bash
rm -rf /tmp/wf-probe
./node_modules/.bin/electron . --remote-debugging-port=9333 --user-data-dir=/tmp/wf-probe &
sleep 8   # 干净种子数据，不碰用户的 localStorage
CDP_PORT=9333 node skills/workflow-studio/scripts/cdp-click.js --card "找证据包" --mode double
```

独立 `--user-data-dir` 保证数据互不干扰（同一个 userData 两个实例会共享 localStorage），独立端口保证
CDP 不会连到用户那扇窗。`tools/shot.js` / `tools/eval.js` 把端口写死在 9222，对隔离实例用
`scripts/cdp-await.js` / `scripts/cdp-click.js`（都读 `CDP_PORT`）。隔离实例里稳定复现 = 真 bug；只在用户窗口复现 = 先怀疑是并发操作或旧实例
（用户可能自己重启过窗口，`ps -Ao pid,etime,command | grep Electron` 看进程存活时间就知道）。

点/双击一定要用**真鼠标事件**：`scripts/cdp-click.js`（CDP `Input.dispatchMouseEvent`，`clickCount` 1/2）。
合成 `MouseEvent('dblclick')` 直接派发到元素上会绕开命中测试，永远测不出“双击失效”。

交付时给：改了哪些文件（字节）+ 上面命令的真实输出 + 截图路径。正文说人话（先给“改了什么 / 现在能不能用”），
命令、路径、字节数放列表里，不要把实现细节堆在开头。界面有变化就顺手刷新
`docs/screenshot.png`（README 引用它）；`preview.png` 不进 git。

## 三层结构（不要混）

| 层 | 文件 | 能做什么 |
|---|---|---|
| 主进程 | `main.js` | 开窗、读 `~/.hermes/profiles`、调 `hermes -p X chat -q`、文件对话框 |
| 桥 | `preload.js` | 只暴露 `listAgents / askAgent / saveFlow / openFlow` |
| 渲染 | `renderer/*` | 全部 UI 与状态；**不直接 require**，只走 `window.tcflow` |

改 IPC 要三处同步：`main.js` 的 `ipcMain.handle` → `preload.js` 的 contextBridge → 前端调用。

## 卡片写作铁律：正文说人话 + 说具体，代码调用封装到内部

用户定的规矩（2026-11，长期有效）：**卡片正面只写人话，而且必须具体**——用哪些图（几张、什么图）、
哪些数据（哪个页面的哪个字段）、做什么加工（怎么挑/怎么比/怎么改）、交出什么文件（里面每条写什么）；
「处理一下数据」这种空话不算数；命令、脚本、路径、字段名一律进 `node.impl`（内部实现），卡片正面、概览、
运行弹层都不显示，只给执行方和 agent 评审看。

**通用口径：该做对的默认做对，不要为它加按钮/开关**（不要「改成人话」这类按钮）。用户指着现有的
几张卡说“改成 X”，就直接改现存数据（一次性对照表/迁移），不要先造一个功能再加。这条规矩靠四处保证（改文案/改提示词时四处一起检查）：

1 提示词 `PLAIN_RULE`（三条 askAgent 共用）：要求人话 + **具体四要素**（用哪些图 / 哪些数据 /
  怎么加工 / 交出什么文件里有什么）+ 技术细节只放 `impl`；改它等于改所有卡片与候选卡的产出质量；
2 解析器 `cleanCard()` + `splitTech()` 兜底：正文里夹着的整句命令搬进 `impl`（句级、保守，
  拆不干净就原样保留，绝不硬改写中文）；
3 加载时 `LEGACY_PLAIN`：机器话正文 → 人话，原技术串一字不丢进 `impl`；
4 加载时 `PLAIN_SPECIFIC`：人话但空泛的正文 → 具体正文（图/数据/加工/产物）。

两张表都按 `body` **逐字匹配**（只改没被人改过的卡）、可重复执行、在 `loadStore()` 末尾统一跑并
`saveStore()`；`createWorkflow` 的种子卡直接写具体文案，不靠事后转换。要再改一批现有卡片的措辞，
**往表里加一条**，不要写一次性脚本、也不要手工改 localStorage。

`⚙` 徽标 = 有内部实现，点开左栏对话面板的 `<details>` 看/改。

## 状态模型

```js
store = { workflows: [ { id, name, agent, nodes: [], edges: [], chat: [] } ], current: workflowId }
node  = { id, kind: 'in'|'proc'|'out', title, body, impl, checks: [], chat: [], x, y, status }
edge  = [fromId, toId]
msg   = { role: 'me'|'agent', text, at, think?, steps?: [{label,time}], secs?, opts?: [候选卡] }
```

- `node.chat` = 这张卡和**该流程执行方**的对话；`workflow.chat` = 右下角和**平台主管**的对话。两边都只留
  最后 30 条，`node.chat` 随卡片导出、`workflow.chat` 随工作流导出。
- `think / steps / secs` 由 `parseAgentOutput()` 填；老消息没有这几个字段，气泡按纯文本渲染即可（别写 `m.think.length`
  这种不带空值的取值，历史数据会炸）。

- 持久化：`localStorage['tcflow.v4']`（v3 首次加载自动迁移：补 `impl`、改老文案）
- 顺序：`chainOrder(w)` 从无入边节点做 DFS，面板与运行弹层都用它
- 画布：`#canvas` 上 `transform: scale(zoom)`；平移靠 `#wrap` 的 scrollLeft/Top；
  节点坐标用「设计像素」，屏幕位移要除以 `zoom`；卡片 DOM 定位要加原点偏移 `ORIGIN`（6000/4000，
  画板 12000×8000 的正中），这样四个方向都能一直拖，拖到 (0,0) 也不会贴死画框。
  **改 nodeEl / dragCard 时两处都要带这个偏移**。
- 缩放锚在视口中心：`applyZoom()` 记住缩放前视口中心的画布坐标，缩放后再把 scrollLeft/Top 调回去；
  `render()` 里必须先 `applyZoom()` 再 `drawEdges()`，否则缩放后连线错位。
- 拖动边界：**别用 `Math.max(0, …)`**——逻辑原点在画板正中，坐标允许为负；只按画板边界夹
  (`CANVAS.w/h - ORIGIN`)。以前钉在 0 时，屏幕上会出现一条「看不见的框」，卡片拖到那儿就卡住。
- 拖动要**按画布坐标**算（`toCanvas()` 把 scrollLeft/Top 和 zoom 算进去，再记抓取偏移），
  不要只累加鼠标位移，否则指针贴边自动滚时卡片会跟手脱节。
- 指针进视口 80px 内要**自动滚**（rAF 逐帧），否则卡片会被拖到看不见的地方；松手时
  `keepInView()` 把卡片滚回眼前。
- 图例给 `pointer-events:none`（它是装饰），否则底部那条 994px 宽的横条会压住画布、抓不起卡片。
- 图例/缩放条不能放在滚动容器里（会跟着画布滚走，滚到 6000 就看不见了）。结构是
  `.canvaswrap`（`position:relative;overflow:hidden`，只做定位）> `#wrap`（真正的滚动/平移层）,
  浮层与 `#wrap` 平级。
- 画板一大就必须 `centerView()`：首屏和 `switchWorkflow()` 都把视口对准**这条流程的卡片包围盒**（放得下就居中，
  放不下从左上角开始；没卡才回 `ORIGIN`），否则打开就看到 scroll 0 处的空地（卡片在 6000px 外）。`applyZoom()` 里**只在缩放值真变了时才写 scrollLeft/Top**，
  否则每次 `render()` 都会把视野拉回中心。改完用 `scripts/cdp-canvas.js` 跑一遍（pan / anchor / drag / edge / layout 五条）。

## 模块与插槽（拖卡连线）

用户要的口径：卡片里用到的东西拆成模块——**输入卡 = 素材、加工卡 = 工具、输出卡 = 成果**，每块是一个人话短词
（≤8 字左右，`.mod.t-mat/t-tool/t-res` 三色同卡片色）；**连线方式 = 把卡拖进加工卡的插槽**。

- 数据：`node.mods = [{id, type:'mat'|'tool'|'res', name}]`，type 跟卡片 kind 走（`KIND_MOD`），改卡片类型时
  一起改 type。**插槽里显示什么不单独存**，由 `edges` 推出来（`modsHTML()`：上游卡的模块进「素材」槽、下游卡的
  模块进「成果」槽；加工卡接加工卡时没有模块，用卡名、按成果色）。别再造一份「插槽内容」字段，两份数据迟早对不上。
- 老卡补模块走 `MODS_SEED`（按 body 逐字匹配、只补没有 `mods` 的卡，`loadStore()` 末尾跑），和 `LEGACY_PLAIN`
  同一套规矩：要给一批现有卡补模块就往表里加一行。新卡在左栏「素材/工具/成果」里加（回车加、点字改、✕ 删），
  编辑时只调 `paintNodes()` 重画画布，**不要 `render()`**（会重建左栏、抢走输入框焦点）。
- 协议：候选卡多一个 `mods` 字段，提示词里的 `MODS_RULE` 与解析器 `normMods()` 成对改；示例占位 `模块短词` 会被滤掉。
- 拖卡接入（`dragCard` → `findDock` → `dockInto/denyDock`）：只有输入/输出卡能插；输入卡只插「素材」，输出卡看离哪个
  槽近；已经接着的当普通拖动；**会绕成圈就拒绝**——用 `reaches(b, a)` 做整条链的可达判断，只查直接反向边会漏掉
  长环（卖点卡→找证据包这种）。拒绝时卡片回到拖起的位置。
- 接入后卡片落点 `dockSpot()`：素材在加工卡左边、成果在右边，撞到别的卡就往下挪；候选卡「确认添加」也用它，
  不再是固定的 `+40/+200`（那样会压在别的卡上）。
- 拔出：在插槽里按住模块拖出加工卡外松手 = 删那条边（`unplugDrag`）；没拖出卡就飞回原位；只是点一下不拦截，
  双击照常开卡片信息。

### 接入动画（顺序与时长都量过，别随手拉长）

1 悬停：卡片缩成 0.46 的小块、**浮在指针正上方**（`--dx/--dy` 在拖起时按抓取点算好），加工卡亮起，目标槽高亮并放
  虚线预览块，另一个槽变淡；接不了的槽标红写「会绕成圈，接不了」。小块不能盖住插槽——曾经以指针为中心缩放，
  预览块全被挡住，`cdp-dock.js` 的 hover 断言现在会查 `被小块挡住 0`。
2 松手：小块弹回原大落到旁边（480ms 回弹曲线）；模块从小块的位置一块块飞进插槽（480ms，间隔 60ms，落地放大
  1.22 再回弹）；连线从起点「描」出来（`drawIn`，stroke-dashoffset 480ms）→ 光点沿线跑（`pulseAlong`，按线长
  280–560ms）→ 终点涟漪 + 插槽闪一圈（520ms）。全套约 1.6s，测试等 2.1s 后断言「动画 0 个、#fx 空、飞行块 0」。
3 拔出：模块替身跟手、离开卡片变红划线、那根线变红虚线；松手线往拔出的方向缩回去（300ms）再删边。

实现要点（踩过）：
- CSS 里 `.node{transition:transform …}` 会**压过** WAAPI 的 transform 动画：松手前先 `el.style.transition='none'`，
  拒绝回弹结束后再清掉（`denyDock` 的 onfinish/oncancel）。
- 飞行块挂在 `body` 上（`makeFlyer`），画布在缩放层里，替身要 `scale(zoom)` 才和原块一样大。
- 动画期间 `render()` 会换掉连线 DOM：`pulseAlong(key)` 每帧按 `data-k` 重新取 path，线没了就收，别拿旧 path 引用跑。
- 每个动画都配 `setTimeout` 兜底收尾（onfinish 在窗口隐藏时可能不触发），否则会留下透明块/光点。
- `prefers-reduced-motion` 时全部跳过动画，结果一样。
- 光点/涟漪画在 `#fx`（`#canvas` 里、盖在卡片上面的第二个 SVG），连线仍在 `#edges` 底层；`drawEdges()` 给每条线
  标 `class="edge" data-k="a>b"`，悬停插槽里的模块会高亮那条线和来源卡（`.peer`）。

## 三条交互不变量

1 **空白处拖动＝平移画板**，卡片区域拖动＝移动卡片（`e.target.closest('.node')` 分流）
2 **卡上不提供任何编辑**（用户明确要求：卡上能改字会抢掉拖拽）。标题/正文都是只读 div；
   改名/改字只在左栏对话面板；**单击只选中（`selId`），双击才打开卡片信息（`panelCardId`）**。
   两个状态必须分开：拖动/单击不得换掉或弹出面板；面板只认双击、卡上 `? 问`/`✦ 下一步`/`⚙`。
3 **右键按住 180ms 出转盘**，松手执行、回中心取消；空格也能调出

## 右下角常驻对话框（整条流程级）

- `.dock`（352×420，画布区内 `right:14;bottom:52`，避开 zoombar）+ 收起后的 `.dock-fab` 药丸；
  状态 `dockOpen`，消息存 `workflow.chat`（每块画布各自一份，和 `node.chat` 分开）。
- 提示词 `dockPrompt()` 给的是整条链路（`chainOrder` + `cardLine`），不绑定单张卡。
- 气泡渲染与卡片对话共用 `bubblesHTML()/wireBubbles()`，确认态各自一个变量（`confirmAdd` / `dockConfirm`）。
- 从 dock 加卡没有「上一张卡」→ `addFromDock()` 放在链路最后一张卡的右下方、**不自动连线**。
- dock 里只有标题、消息、输入框——不加说明文案（见「界面文案：越少越好」）。
- `dockSend()` **不检查** `workflow.agent`（它固定走 `DOCK_AGENT`）；只有卡片对话 `chatSend()` 需要
  `workflow.agent`，未指派时才提示去顶栏选。别把同一个前置检查复制到两条链路上。
- **`default` 这个执行方在选择器和列表里都显示「平台主管」**：`agentOptionsHTML()` 会把 `DOCK_AGENT` 补成一条可选
  （它不在 `~/.hermes/profiles/` 下，但仍得能选中；漏了就会「数据是 default、界面显示 — 未指派 —」），
  右栏列表用 `execName()` 不用 `agentName()`。

## 人确认才落盘（agent 不得自己改画布）

agent 给的候选卡在聊天气泡里只能是**preview**：点一下展开（内容 / ⚙ 内部实现 / 连到哪张）；
只有按「确认添加」才 `addFromOption` 真的加卡连线（取消则什么都不发生）。同理，以后任何
agent 驱动的写操作（改卡片、删卡片）都要先放进这个确认层，不要一点就落地。

实现位置：未确认态是 `confirmAdd = {mi, oi}`（不持久化，`renderChat()` 按它渲染 `.optconfirm` 块）；
**加卡入口只有 `addFromOption()` 一处**，别在别处直接调它——一旦多一个入口，这条确认就被绕过了。
「逐卡验证」只写状态点和聊天记录、不改卡片内容，所以不需要确认。

**候选卡提示不许顶掉原回答**：流结束时 `runStream()` 只写 `live.human = '给你 N 个候选卡…'`，
原回答留在 `live.text`（气泡显示 human，原话进「看原话」折叠块）。以前把 `live.text` 整段换成那句提示，
结果「这条链路第几版、几张卡」这种纯事实问答在界面上看不到它答了什么，验收也断不到。`dockPrompt()` 另有一句
「问事实直接回答，不要给候选卡」。

## 左栏（对话栏）：默认收起，双击卡片 = 聊天框

- 布局（`#layout` 是 grid）：展开 `364px 1fr 242px`，收起 `0 1fr 242px` ——
  **左＝对话栏（卡片信息＋聊天），中＝画布，右＝工作流列表**。收展只改第一列宽度，
  面板用 `overflow:hidden;visibility:hidden` 压成 0 宽，**不要 `display:none`**（见常见坑）。
- 没选卡片时左栏（对话栏）自动收起（`.layout.collapsed` + 左侧竖向「概览」把手 `#panelTab`）；
  点空白处/Esc/删卡都要 `selId=null; panelCardId=null; panelOpen=false`，状态统一走 `applyPanelState()`。
- 选中卡片后，左栏（对话栏）从上到下：卡片名（无框大标题）→ 类型 → 内容（人话）→ **agent 聊天框** →
  折叠的「⚙ 内部实现 · 校验」。聊天框 = 消息气泡 + 快捷问句 chips + 输入框（Enter 发送）。
- 每张卡自己存对话：`node.chat = [{role:'me'|'agent', text, at, opts?}]`，只留最后 30 条；
  发问时把卡片 + 整条链路 + 最近几轮对话拼成一条 prompt（`buildChatPrompt`），CLI 是一次性的，
  上下文靠重放，不靠会话。
- 回答里能解析出候选卡时，把 JSON 换成一句人话 + 气泡内按钮：**点一下只展开预览**（内容 / ⚙ /
  会连到哪张），必须按「确认添加」才 `addFromOption` 落地，按「取消」什么都不发生（见「人确认才落盘」）。
  不要把整段 JSON 糊在气泡里。
- 「逐卡验证」的结果写进每张卡自己的聊天，不另开报告面板。

## 两种 agent：流程执行方（可指定）+ 平台主管（固定在对话框）

- **每条工作流自己指定执行方**：`workflow.agent`，顶栏 `#flowAgent`、概览 `#pFlowAgent`、运行弹层 `#mAgent`
  三处同步。别把它固定死——用户明确要能指定。
- **只在被点名的那一面收权**：用户说「这个对话框是平台主管」时，改的只是对话框；流程执行方的可选性
  必须留回去。曾把整条产品线固定成一个 agent 被纠正过——收权收过头和没收一样是错。
- **右下角对话框固定对接平台主管**：`DOCK_AGENT = 'default'`（`hermes -p default`，roster 里的 @hermes 主管；
  profile 名 `hermes` 是保留字，不能用）。`dockPrompt()` 用主管口径：规划与派工、跨部门一次复核、不代做
  部门交付；气泡 who 用 `dockAgentName()`（平台主管）。卡片级对话仍走 `flow().agent`。
- `bubblesHTML(..., whoLabel)` 的 who 由调用方给：卡片对话传执行方名字，对话框传「平台主管」。
- `hermes chat -q` 的输出结构：`Query: 提问回显` → 分隔线 → **思考段（含 📚 Skill / 🔎 Grep 工具行，各带耗时）**
  → `☤ Hermes` → **正式回答** → 分隔线 → `Resume this session`。`parseAgentOutput(raw)` 拆成
  `{answer, think, steps:[{label,time}], secs}`；聊天消息存 `think/steps/secs`，气泡按 Hermes 的样式渲染
  （谁 + 用时 · 步数 → 折叠的「思考」→ 回答 → 候选卡）。`agentAnswer()` 只是取 answer，用于验证结果这种纯文本场景。
- 视觉照 Hermes：助手消息**没有气泡**（纯文本块），只有用户消息是右侧浅底气泡；工具步骤是**一条行一步**
  的静默行（标签 55% 前景色、右侧耗时 44%、11px，左侧 1px 细线分组），思考用 `<details open>` **默认展开**
  （用户明确要看见思考过程，别默认收起），summary 写「思考 16s · 6095 字」。去 Hermes 源码对数值：
  `apps/desktop/src/styles.css` 的 `--conversation-*`、`scaffold-row.tsx`、`message-parts.tsx`。
- 长文本：回答 > 900 字折叠成「展开全文（N 字）」；气泡 `.msg/.txt` 必须 `overflow-wrap:anywhere`，
  工具名用 ellipsis——否则长字符串会把面板撑破。
- agent 选择器不要用原生 `<select>` 套橘色胶囊（丑）；用无边框 select + CSS 画的小三角，hover 才给 6% 底色。
- **改了解析器/提示词先跑 `scripts/parse-agent-output.js`**（吃一份 CLI 原始输出文件，或 `--live "提问"`
  现场跑一次），看 `secs / steps / think 字数 / answer 首尾` 对不对；别靠肉眼看气泡判断拆分是否正确。
- 等待时给气泡打 `data-since`，全局 1s 定时器刷新「正在想… Ns」。

## 真流式（Hermes 的对话效果）

- 三条链路要一起改：`main.js` 的 `ipcMain.handle('agent:stream')`（spawn `hermes -p X chat --format stream-json -q …`，
  逐行 JSON 转发到 `agent:event`）→ `preload.js` 的 `askAgentStream / onAgentEvent / cancelAgent` → 前端 `runStream()`。
- 事件形状：`{type:'system'|'tool_use'|'tool_result'|'text'|'result'}`；`tool_use` 带 `name/input/tool_call_id`，
  `tool_result` 带 `output/duration_ms/is_error`，`text` 是增量，`result` 是收尾（含完整 text 与 tokens）。
- 前端把工具行渲成 `<details class="step running|done|error">`（运行中是呼吸点），点开看参数/结果；文本按
  `requestAnimationFrame` 节流重渲，`mdToHTML()` 只支持 **粗体**/`code`/标题/列表/代码块（先 esc 再套标签）。
- **流式期间不能整段重建 DOM**：每帧 `innerHTML` 换掉整块日志，鼠标按下/抬起会落在不同元素上（点了没反应），
  展开状态和滚动位置也丢。做法：流式那条消息打 `data-live="1"`，`patchLive()` 只更新它（追加步骤行、更新
  文本、改 meta），其它节点不动；非流式时才整段重绘，且用 `keepDetails()` 还原每块 `<details>` 的 open。
- **折叠块**：工具步骤收进一个 `details.think.process`（标题「思考过程 · N 步」，默认展开），行内每个步骤
  仍是独立 `details.step`（点开看参数/结果）；思考正文是另一块 `data-k="reason"`。key 必须区分，否则两块撞键。
- **流里没有思考正文**：`--format text` 才有 `∴ Thought …` 段落；`stream-json` 只给工具事件与回答。
  `USE_STREAM = false` 可切回一次性文本模式拿到思考（`parseAgentOutput`），但没有逐字效果——这是取舍，别同时要。
  流模式下气泡里**根本没有「思考」那一行**；上面「思考默认展开」指的是文本模式（以及未来 provider 真发
  `reasoning/thinking` 事件时）。
- 收尾三件套，少一件 UI 就卡在「进行中」：`live.live = false`、把仍为 `running` 的步骤标成 `error`、
  并**一定执行 `off()` 注销事件监听**（放在 try/catch 之后、无论成败都跑，否则下一次 run 的事件会追写到
  上一条消息里）。
- 文本兜底：流事件可能一条 `text` 都没产出，收尾时用 `result.text`（IPC 返回的完整文本）补进 `live.text`；
  候选卡也用 `parseCardArray(r.text || live.text)` 取，不要只查 `live.text`。
- 采样验收的方式：起一次真实调用后每 ~800ms 读一次 `(flow().chat).slice(-1).text.length / steps`，
  期望看到「先出工具行 → 再涨字数 → 收尾 live 消失」；一次采样为 0 不代表失败。
- 候选卡：流结束后用 `parseCardArray()` 从完整回答里取，仍走「确认添加」闸门。

## agent 集成

```js
const r = await window.tcflow.askAgent({ profile: flow.agent, prompt });   // 只读，不执行
```

「✦ 下一步」协议：要求 agent **只输出 JSON 数组**
`[{"kind":"proc","title":"…","body":"人话","impl":"命令/路径/字段"}]`；
`parseOptions()` 先 JSON 后按行兜底。**改协议必须同时改提示词与解析器**。

**坑（踩过）：`hermes chat -q` 会把提问原文回显在答案前面，末尾还有 `Resume this session` 会话块。**
所以：
- `parseOptions()` 用 `jsonArrays()` **从后往前**找「能解析成卡片数组」的 JSON（第一个 `[` 落在回显里，
  回显里的格式示例也是能解析的数组 → 必须取最靠后 + `validOpt()` 滤掉「短标题」占位）；
- 展示与判定一律先过 `agentAnswer()` 去回显/去尾巴；`validateAll()` 的 `需补` 判定也用它，
  否则回显里提示词自带的「需补」会让每张卡都判 fail。

## 读取 agent 的工作链路（只读 → 分析 → 人点确认才落卡）

顶栏「⇣ 读取 agent 链路」→ `#readModal` → 选一个 agent → 预览 → 「放进画布」。
改这块只动 `chain.js` / `main.js` / `renderer/app.js` 三处，别把职责搅在一起。

### 三层结构

| 层 | 文件 | 管什么 | 不许做什么 |
|---|---|---|---|
| 读原料 | `chain.js` | 读 `profile.yaml`（显示名/分组/职责）、`SOUL.md`、它自己的 `skills/` 与 `config.yaml` 里的 `external_dirs`；`state.db` 用 `sqlite3 -readonly` + `?mode=ro` 打开，算出干的活、技能使用次数、上下游、读写目录、常用工具；所有文本先过 `redact()` | 不写任何文件、不改 `state.db`、不 spawn 除 `sqlite3` 之外的东西、不读 `.env`/凭据；返回的东西要能直接进提示词（所以脱敏在 `chain.js` 做，不在前端做） |
| 起进程 | `main.js` | `ipcMain.handle('agent:chain')` 转给 `readChain`；`agent:stream` spawn `hermes -p <id> chat --format stream-json -t <toolsets> -q <prompt>`，逐行转 `agent:event`，子进程存进 `runs`；`agent:cancel` 真 `kill('SIGTERM')`；超时也 SIGTERM | 不解析卡片、不判断拆得好不好、不碰画布状态（它不知道什么是卡） |
| 预览与落卡 | `renderer/app.js` | `rd` 状态 + `openRead/paintRead/pickRead/analyzeChain/parseChainPlan/planProblem/layoutChain/placeChain/playArrival`；流式只追加预览格子，不重建 DOM | 不许绕过 `planProblem()` 闸门、不许在按钮之外调 `placeChain()`、不许自己决定执行方（`placeChain` 里执行方 = 被读的 agent） |

读多少条：默认最近 80 条会话；**真干过活（`tool_call_count > 0`）的记录少于 30 次**的 agent（记录很少的那种），
窗口放到 300 条，免得稀疏的几条干活记录被一堆闲聊挤出窗口；记录多的照旧 80，不拖慢。上限写在
`chain.js` 的 `READ_LIMIT / READ_LIMIT_MORE / READ_WORK_SMALL`，在 SQL 里用 `CASE` 算（不读两次库）。
每次读取在主进程日志打一行 `[读取链路] <agent>：本次读取 N 条 / 上限 80|300`，窗口「⚙ 读到的线索」里也有。

### 五条不变量（验过的，改代码必须保住）

1. **分析用的 agent 只给 `todo,no_mcp`**（`READ_TOOLSETS`）：跑不了命令、读写不了文件、发不了消息、碰不到任何 MCP 接口。`cdp-read.js` 的 `stream` 断言会查工具组就是这两个、且这次真的只调过 `todo_list`。
2. **agent 永远不能直接往画布写东西**：落卡只在人按「放进画布」之后发生，入口只有 `placeChain()` 一处。预览、日志、重试都只改 `rd`。
3. **取消必须真把子进程杀掉**：`cancelRead()` → `window.tcflow.cancelAgent(runId)` → `main.js` 的 `child.kill('SIGTERM')`。换 agent（`pickRead` 开头先 `cancelRead`）、关窗（`closeRead`）、Esc 都走它。只把 `busy` 置 false 让它继续跑 = 错。
4. **同一时刻只允许一个分析在跑**：`analyzeChain()` 用 `rd.busy` 挡重入，`pickRead()` 先取消旧的再开新的；`rd.token` 让旧的结果回来时自己作废。
5. **读别人的记录一律只读**：`state.db` 只读 URI 打开，不写不改；派活原文里夹着的密钥先 `redact()` 抹掉再进分析（`chainSQL` 取出的 `ask`/`done`/标题都过一遍）。

### 卡住要收场、能重来（验收：`cdp-read-stability.js`）

- **总预算 `READ_BUDGET_MS` = 150 秒**（`preload.js` 从 `WF_READ_TIMEOUT_MS` 读，默认 150000；界面没有开关）。
  一次分析 + 自动重来一次共用这个预算。三条真实链路（最长那次还自动重来了一次）都能在 2 分半里拆完；
  留这档余量是给慢一档的模型，又不至于让人对着「正在拆卡」干等 4 分钟。
- **两道刹车**：主进程 `agent:stream` 到点 SIGTERM（回包带 `timedOut: true`）；渲染层再兜一层
  `Promise.race`（预算 +3 秒），万一 IPC 不回来也不会一直转圈，并把 runId 杀掉。
- **断流/超时/取消都不留半张卡**：`analyzeChain()` 在 `ok=false`（断了/到点）时**不自动重来**，
  直接清预览（`clearReadPreview()`）、写一句人话、开「重来」；`cancelRead()` 只收正在跑的那次
  （`rd.msgs=[]`、`rd.plan=null`、清预览），已经拆好的结果不动。
- **重来真重来**：`analyzeChain()` 开头先 `killReadRun()`；每次尝试用新的 `runId`，`active` 标志让
  上一轮晚到的事件不往预览里写——同时只允许一个进程往预览里写。
- **进度说人话**：气泡和底部提示每秒刷新 `readProgress()`——「还在拆，已经理出 N 张（已等 N 秒）」；
  20 秒（`READ_STALL_MS`）没有新内容就改说「这一步有点慢：N 秒没有新内容，它还在想，不是卡住了」。

### 这次踩过的坑（现象 → 现在的做法）

- **拆出来的连线把两张输入卡连在一起，链路断成两截** → `parseChainPlan()` 的 `add()` 直接拒绝「连进输入卡」和「输入→输入」；再给没人喂的加工卡补线（接前面最近的输入/加工）、给没人接的加工卡接后面最近的输出，落单的输入/输出也补一下。`planProblem()` 最后查整条是否连成一片，断成几截就判不过、自动重来。
- **卡片压在右下角对话框底下** → `placeChain()` 之后走 `fitView(true)`：挨着对话框放不下（要缩到 0.5 以下）就把对话框自动收成药丸，卡片不铺到它下面。
- **分析吐出一张卡之后停住** → 现象是流里只冒出一张卡就没了下文（模型把 JSON 写断）。现在：总预算 150 秒
  （`READ_BUDGET_MS`，主进程到点 SIGTERM + 渲染层兜底），`analyzeChain()` 在跑完但拆得不好时最多自动重跑一次
  （`attempt < 2`）；中途断了/到点就不重跑，直接「这次没拆全 / 到点了」+ 重来。第 2 张卡会去治根（提示词/时长/上限）。
- **只限制工具组时，被读 agent 挂着的 MCP 接口仍然可见可调** → 工具组写的是 `todo,no_mcp`：`no_mcp` 把 MCP 连接一起关掉，不只是收窄常规工具。

### 跑验收

```bash
node --check renderer/app.js && node --check main.js     # 语法
node skills/workflow-studio/scripts/check-plan.js        # 拆卡规则离线用例（不调 agent）：每条 PASS，最后一行「全部通过」
export CDP_PORT=9333                                     # 隔离实例先起来（见「启动与验证」）
CDP_PORT=9333 node skills/workflow-studio/scripts/cdp-read.js --agent <agent-id>
#   agent 必须显式传（脚本没有默认值）。期望 PASS：open / layout / read / stream / plan / place / arrive / esc / errors
#   stream = 卡一张张冒出来、只调 todo_list；place = 新工作流、执行方=被读的 agent、不重叠不压对话框；arrive = 动画收干净
#   这条会真实调用分析用的 agent：同一张卡最多跑 2 次
node skills/workflow-studio/scripts/cdp-read-stability.js --agent <agent-id> --mode kill
#   正常上限实例：跑到一半杀子进程 →「这次没拆全」+ 重来 + 预览清空；重来后同时只有 1 个分析进程；关窗 0 个
#   小上限实例（WF_READ_FAKE=hang WF_READ_TIMEOUT_MS=12000）跑 --mode hang / --mode timeout（或 --mode all = 这两个）：
#   不出声也到点自己收场、重来可用、预览不留半张卡；kill 不在 all 里，小上限实例跑 --mode kill 会打一行 SKIP 跳过
#   正常上限实例 --mode stall：20 秒没有新内容时，气泡和底部都写「它在想，不是卡住了」
node skills/workflow-studio/scripts/cdp-canvas.js        # 老功能回归：平移/缩放锚点/拖动/连线/布局
node skills/workflow-studio/scripts/cdp-dock.js          # 老功能回归：拖卡进插槽、拒绝成圈、拔出、成果槽、动画收干净
node skills/workflow-studio/scripts/cdp-click.js --card "<卡片标题>" --mode double   # 老功能回归：单击只选中、双击开卡
```

## 拆卡离线样本（不联网、不调模型查退步）

真实拆卡回答钉在 `fixtures/`：三份好样本（商品资料标准化 / 分镜画板到成片 / 卖点卡出卡链路，来自第 1 张卡验收时
真正落进画布的那几次）+ 五份自己写坏的（断成两截、输入连输入、半截 JSON、只有加工、没给连线）。一条命令跑完，几毫秒：

```bash
node skills/workflow-studio/scripts/check-fixtures.js         # 期望最后一行「全部通过」+ 用时远小于 2 秒
node skills/workflow-studio/scripts/check-fixtures.js <目录>   # 把样本改坏成两截再跑：必须 FAIL、退出码 1
```

每份样本断言：卡片数 / 卡片顺序 / 输入加工输出三类都有 / 连线逐条 / 没有连进输入卡的线 / 每张卡都接上 /
整条连成一片 / 质量闸结论 / 不含本机绝对路径、团队角色字样与**本机 profile id**（`~/.hermes/profiles` 下的目录名，
整词比对；换台机器没这个目录就跳过这条）。坏样本按**现有行为**断言「被质量闸挡住」还是
「被自动修好」——理由写在 `fixtures/README.md` 的表格里。改解析或改提示词之后先跑它；样本只用来查退步，
**不许拿样本反推解析规则**。

## 实时链路：共享状态文件 + 临时对话画布

让画布跟着 agent 的动作实时长出来，而且这条链路是「人和 agent 共用的一份状态」。三处要一起看：
`linkstore.js`（主进程）/ `main.js` 的 `link:*` IPC / `renderer/app.js` 的 `linkDoc/queueLinkWrite/applyLinkDoc/patchNodesDiff`。

### 状态文件（`<userData>/links/<链路 id>.json`，临时画布固定 `__temp__.json`）

- 一条链路的完整状态：卡片、连线、每张卡的模块、正文（输入元素/加工方式）、内部实现、执行方、版本号 + `summary`（几卡几线、按类计数、执行方、链路清单）。
- 写：`writeFileSync` 临时文件 + `renameSync` 原子换名；记内容 hash，**自己写的不当成外部改动**（否则画布和文件互相推）。
- 读：解析不了就退回 `lastGood`（上一份好的），坏文件绝不推给画布；`mtime:size` 变了才读，`fs.watch` + 400ms 轮询两条腿。
- 画布改动 → `saveStore()`（350ms 防抖）→ 文件，实测 **515ms**（要求 1s 内）。
- **只有链路结构变了才算新版本**：聊天、逐卡验证的「已读」状态用 `saveStore(false)`——不涨版本、不写文件。
  踩过的坑：发一条消息也涨版本，agent 读文件答「第 20 版」而画布是 19，验收判定不一致。
- 文件被外面改（版本 ≥ 当前）→ `applyLinkDoc()` 认领回来，`patchNodesDiff()` 只换变了的那张卡；别的卡 DOM 不动（拖拽顺）；
  正在拖卡时推迟 400ms 再认领。版本号只由画布涨，外部改要自己写更大的 `version`。
- **状态文件只带结构**（卡片 / 模块 / 正文 / 内部实现 / 坐标 / 执行方 / 版本）。卡片自己的 `chat / checks / status`
  只活在这台机器上：`applyLinkDoc()` 按**卡片 id** 从旧节点认领回来，否则外面改一次正文就把卡片对话和校验点清空了。

### agent 看得到、但改不了

- 四条链路都带 `linkBrief(w)`：卡片对话 `buildChatPrompt`、右下角 `dockPrompt`、临时画布 `tempPrompt`，
  以及概览的 `askFlow`、`validateAll`。内容 = 第几版 / 执行方（`execName()`，`default` 显示成「平台主管」）/ 几卡几线 / 状态文件绝对路径 / `LINK_RULE`。
- `LINK_RULE` 明确：画布只读，想改就在回答里写「提议：…」，人点了才生效；**连状态文件也不许用工具改**。
- **硬不变量没破**：agent 仍然不能往画布写东西，落卡只在人点「确认添加 / 存成正式」之后。

### 临时对话画布

- 顶栏「对话建链路」→ `startTempCanvas()`：`tempFlow` 只在内存，`store.current='__temp__'`，不进列表、不写 localStorage。
- **第一张卡 0 秒上屏**：`dockSend()` 一发出就先 `seedDraft(msg)`——把你这句话立成这条链路的输入卡（标题「本次要求」、
  正文是你的原话、头部标「起草中」）。agent 的第一张真卡回来时 `adoptDraft()` 接管它（同一个 id、按它该在的列重摆，
  `seed` 清掉）；计划里自带输入卡就并进那张，别留两张输入（`finishTemp()` 里 `planIn` 优先）。
  **这不是编内容**：起草卡写的是人自己的要求，模型的第一张卡到了就换掉它。想看「模型自己的第一张卡什么时候到」看
  `cdp-live --chat` 的 `chat-agent-first-card`（实测 8–9s）。
- 流里每写完一张卡就长一张：`partialCardObjects()` 扫出完整 JSON 对象（跳过没写完的），`growTempFrom()` 只追加/替换单张卡
  （`paintOne()`），自动和上一张连线；**画布这一侧 1ms 内上屏**（同一帧）。结束时 `finishTemp()` 用完整计划再对齐一次。
- 卡长出来时如果**看不见或被右下角对话框盖住**，才调 `fitView(false)`（`anyCardOutOfView()` 判定）：长卡时视野跟着走，
  但不折对话框（人正在里面聊）。`fitView()` 的缩放下限放到 **0.3**（三列并排在对话框左边通常要 0.35 上下），
  所以要保证「卡不压在对话框底下」先看这个下限。
- 右栏 `.tempbar` 只在临时画布上出现：「存成正式」→ `promoteTemp()`（进列表、id 换新、清理 `draft/seed` 标记、文件跟着走）；
  `✕` → `dropTemp()`（删文件、回原工作流）。切工作流 / 新建 / 存成正式 / **`placeChain()`** 都会 `dropTemp()`；
  进程启动时 `links().drop('__temp__')` 抹掉上次没清干净的。漏了 `placeChain()` 这条的后果：先开临时画布、再去「读取链路」落卡，
  下一次「对话建链路」会把上一张草稿带回来（实测残留）。
- 临时画布的气泡**说人话**：`tempHuman()` 把流里的 JSON 换成「正在搭 / 搭好了：N 张卡 + 每张 类型｜标题：正文一句」，
  原始 JSON 留在 `msg.text`，气泡把它收进「看原话」折叠块（`bubblesHTML` 的 `details.more.raw`、`patchLive` 也读 `m.human`）。
  别把 `impl/key/mods` 糊给用户——和卡片正面「只写人话」是同一条规矩。
- **空画布按钮要跟着卡片数走，不能只在 `render()` 里切**：`#emptyRead`（「⇣ 读取 agent 链路」）的显隐统一走
  `syncEmptyRead()`，由 `render()` / `paintNodes()` / `paintOne()` / `patchNodesDiff()` 调。临时画布的卡是
  `paintOne()` 长出来的、不经过 `render()`，只在 `render()` 里切会留下一层挡在画布中央、点不到卡片（实测
  `hitAtCenter:"emptyRead"`）。
- 临时画布不写 localStorage：`saveStore()` 里 `current` 会写成列表第一条，重启不会把临时画布带回来。

```bash
export CDP_PORT=9333
node skills/workflow-studio/scripts/cdp-live.js            # 不花钱：起草卡/临时画布/状态文件/外部认领/坏文件/存成正式/落卡清草稿
node skills/workflow-studio/scripts/cdp-live.js --chat     # 再加两次真实 agent 调用（首卡时间 + 气泡人话 + 看得到/改不了）
# 期望全 PASS：temp-empty-read-hides 有卡后空画布按钮收掉（elementFromPoint 不再命中 #emptyRead）、
# chat-first-card-2s = 起草卡（10ms 级）、chat-agent-first-card = 模型第一张卡（实测 6–10s）、
# chat-cards-clear-of-dock 卡压对话框面积 0、chat-bubble-humane 气泡里没有原始 JSON、
# agent-sees-facts / agent-facts-kept = 问事实答得对且原回答没被「给你 N 个候选卡」顶掉
```

## 视觉规范（不要自创）

要「跟 Hermes 一样」时先读 `references/hermes-chat-visual.md`（源码路径 + 具体 token 数值 + 搬运规则），
不要凭印象调 CSS；打包版 Hermes 不开 CDP，探不到只能读源码。

**对话区别排太 tight（用户点名嫌过「有点挤」）**：消息间距 18px、正文 13px/1.72、工具行 11.5px/22px、
用户气泡 padding 9/13 圆角 16、dock 392×480。想加内容时先加空白再考虑压字号——具体数值见
`references/hermes-chat-visual.md` 的「对话区密度」表，别回退到 10px/12.8px 那套紧凑值。

平台统一设计 token：奶油纸 `#f5f3ef`、墨 `#111`、橘 `#ff5a1f`、白卡 `#fffefa`、
圆角 18 / 10、阴影 `--shadow-1`。卡片三色：输入 `#2f6f95`、加工 `#ff5a1f`、输出 `#2f7d5b`，
色带做在卡片头部（整条），不要在卡片里再堆色块。

### 界面文案：越少越好（用户点名要求过）

界面上不留说明性长文案：顶部副标题、侧栏整段说明、画布底部图例条、字段下方的灰色小字，
都被点名删过。信息靠控件本身表达——输入提示写进 `placeholder`，操作提示用 `title`，
真要解释就写 README。新功能不要顺手加引导文案或「点这里」气泡。

删完用 DOM 断言收口：`.brand-sub / .legend / .sidehint / .thin` 应该一个都查不到；
重启（只关自己端口的实例）后再断言一次（页面缓存会让你以为删了其实没生效）。

## 常见坑

- **折叠面板别用 `display:none`**：它会把自己从 grid 里摘掉，后面的列整体前移（画布被挤成 0 宽、
  点卡片命中的是别的元素，双击自然就"失效"了）。用 `grid-template-columns:0 …` + `overflow:hidden`
  + `visibility:hidden` 压成 0 宽，item 位置不动。
- **`pointerup` 里不要 `render()`**：重建卡片 DOM 会让浏览器认不出紧随其后的双击（第二次点击落在新元素上）。
  拖动收尾只 `saveStore()`，位置已经在拖动时写进 style 了。双击/单击行为用 `scripts/cdp-click.js` 验。
- **折叠块点不动，先查是不是在重建 DOM**：`<details>` 的 open 状态不在数据里，每帧 `innerHTML` 重建一次就
  被清零；而且鼠标按下/抬起会落在不同元素上，表现为“这个折叠打不开”。流式那条消息走 `patchLive()` 增量更新，
  非流式重绘用 `keepDetails()` 还原 open；验证方式是用真鼠标点它、再连续采样 `details.open` 是否保持。
- **布局一变，坐标全变**：对话栏（左）收展、缩放、窗口改尺寸都会让卡片屏幕坐标位移；`elementFromPoint` 返回的若是别的
  元素（比如右侧列表、topbar），先查列宽和 `#wrap` 的 rect，别急着怀疑事件绑定。

- **文案变长会撞车**：卡片固定 244px 宽、正文 `max-height:150px`，正文从一句话变三四行时
  手摆的位置很容易重叠。改完用 DOM 量一遍（两两求 rect 交集，期望 `overlaps: 0`），必要时按
  `chainOrder` 重排成两行，**并在交付里说明你动了位置**（位置是用户自己拖的，不能默默覆盖）。
- **验证探针不要污染用户的画布**：加删卡片一律用临时卡并当场删掉；改坐标/缩放/滚动前先记下来、
  测完写回（`scripts/cdp-canvas.js` 已经这么做）；不要顺手改用户的卡片正文/对话，真需要恢复
  （比如某张卡正文空了）先说明再动手。用户可能同时在窗口里操作，看到的状态变化未必是你的 bug——
  按「启动与验证」里的隔离实例复测再下结论。
- **探针在 `render()` 之后要重新取元素**：`render()` 会换掉所有 `.node`，之前拿到的引用量出来全是 0（曾因此把
  插槽坐标量成 (0,0)，误以为「拖进插槽没反应」）。
- **缩放后先把目标卡滚进视口再点**：缩放锚在视口中心，1.5 倍时靠左的卡会滑到视口外，`getBoundingClientRect`
  给出负坐标，点下去是空气（`cdp-canvas.js` 的 drag 曾因此误报）。
- **刚 render 完不要立刻量 layout**：列宽折叠、缩放、字体都会晚一帧生效，量到的 `getBoundingClientRect`
  是中间态（曾因此误报“双击失效”：实测点落到了已经移位的列表上）。探针里先 `wait(200~300)` 再量。

- **画板尺寸写在两处**：`CANVAS = {w:12000,h:8000}`（JS，拖动夹边界用）和 `#canvas{width/height}`（CSS，
  决定滚多远）必须同步改；只改一处会出现“能拖到的地方和能滚到的地方不一致”。同理 `ORIGIN` 必须
  是画板正中，否则某一侧能拖的距离会明显短。
- **不重启等于没改**：主进程和 `renderer/*` 都不会热加载。改完先关掉自己端口的实例再起（`pkill -f "remote-debugging-port=$CDP_PORT"`），否则连到的是旧进程、截图和 DOM 断言都是上一版。
- 节点宽度变了要同步 `chainOrder` 之外的两处：连线的 `x1` 偏移、插入按钮定位。
- 不要把 `localStorage` 里的旧 schema 直接读进新代码；升 key 版本（v4）。
- 左栏宽度/收起状态一变，卡片屏幕坐标就变，必须重新 `drawEdges()`；面板状态统一走
  `applyPanelState()`，`markSel()` 里也要调它，否则只改 `selId` 时对话栏不会跟着收/展。
- 卡片正文/标题是模板字符串拼进 `nodeEl()` 的：多敲一个反引号就是整页白屏，`node --check` 能先抓到。

## 开源

本手册和它的 `scripts/`（`cdp-await.js` / `cdp-click.js` / `cdp-canvas.js` / `cdp-dock.js` / `parse-agent-output.js`）就在仓库里：
`skills/workflow-studio/`。新增验证脚本直接放这里（`scripts/` 是可直接重跑的采集/断言，不要写成一次性探针），
并在 `git status` 里确认它们不是 `??` 漏提。

仓库根有 `README.md` / `LICENSE(MIT)` / `.gitignore`。提交前跑：

```bash
git status --short && git diff --stat
git grep -nEI "(ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|_API_KEY=)" -- . ':!node_modules' || echo "no secrets"
```

不要提交 `node_modules/`、`preview.png`、任何 `.env` 或含密钥的文件。

### 发布到 GitHub（已发布：`github.com/VHKrib/workflow-studio`，private）

`tools/publish-github.sh` 把「建库 + 推送」合成一条命令：

```bash
tools/publish-github.sh                 # 建私有仓库 workflow-studio 并 push
tools/publish-github.sh <name> public   # 换名字 / 公开
tools/publish-github.sh --push-only     # 以后只推新提交
```

脚本会先查 `gh auth status`，再用 `gh api user` 把本地 `user.name/email` 对齐账号，然后
`gh repo create --source=. --push`（不重新 clone、历史不丢），最后打印仓库地址。默认 **private**，
要公开必须显式写 `public`（可见性变更对外不可逆，别默认做）。

- 没有凭据时先登录：`gh auth login --web`（设备码）。从 agent 会话里驱动它的完整步骤在 `github` skill
  （software-development 分类）的 auth 参考文件里，别自己拼 OAuth。
- **第一次提交之前**就把 `git config user.name/email` 设成 GitHub 账号。占位身份（`*@localhost`）会永久
  留在历史里，事后只能改写历史 + 强推——那要先问用户，别默认做。
- 推送前确认密钥扫描干净、`preview.png` / `node_modules/` 未进暂存区；推送后用
  `gh repo view --json visibility,defaultBranchRef` 和 `git ls-remote --heads origin` 复核远端真的收到了，
  不要凭 push 输出里的一行 "new branch" 就宣布完成。
