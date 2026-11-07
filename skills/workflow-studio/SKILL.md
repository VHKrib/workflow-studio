---
name: workflow-studio
description: Use when changing the Workflow Studio (工作流开发平台) Electron app (画布/卡片/agent 集成/开源维护). 提供结构、验证方法与改法。
---

# 工作流开发平台 · 开发手册

## 何时用

改这个仓库的任何东西：界面、卡片模型、agent 调用、读取链路、导入导出、开源文件。
代码在仓库根目录（`renderer/` 是界面与全部状态，`main.js` 是主进程，`preload.js` 是桥）。

**先确定你在哪一份里改。** 默认在 dev 工作副本里改、验收通过再并进用户在用的那份；但用户说「以后你直接动手」以后，
**用户在用的那份就是你的工作副本**：改完就地 `git add -A && git commit`（别把改动留在工作区），然后重启窗口自测。
两条路径不能混：走派卡时不许碰 live；直接动手时每改一版就提交，否则下一个会话看见一屁殏未提交改动，
分不清是谁的。

## 启动与验证（每次改完都要做）

```bash
cd <仓库根目录>                                   # 在 dev 工作副本里改；正在用的那份不在里面改
node --check renderer/app.js && node --check main.js      # 语法
export CDP_PORT=9333                               # 实现 9333 / 验收 9334 / 主管 9335；9222 是用户在用的窗口：不连、不关
lsof -nP -iTCP:$CDP_PORT -sTCP:LISTEN -t | xargs kill 2>/dev/null; sleep 1   # 只关自己端口的实例；别用 pkill -f（见常见坑）
# 用 terminal(background=true) 起；前台命令里的 & 会被工具直接拒掉
env -u WF_LIVE_DIR ./node_modules/.bin/electron . --remote-debugging-port=$CDP_PORT --user-data-dir=$TMPDIR/wf-$CDP_PORT   # 隔离实例：独立端口 + 独立数据
sleep 8
# tools/shot.js 读 CDP_PORT（不写就是 9222 = 用户的窗口，所以先 export）；tools/eval.js 仍写死 9222，别用。有的 scripts/ 不设 CDP_PORT 也默认连 9222，所以先 export
node skills/workflow-studio/scripts/cdp-await.js probe.js         # 要 await 页面异步函数时
node skills/workflow-studio/scripts/cdp-canvas.js                 # 平移/缩放/拖动/贴边自动滚/重叠（自己还原位置）
node skills/workflow-studio/scripts/cdp-dock.js                   # 拖卡进插槽：悬停/接入/拒绝成圈/拔出/成果槽 + 动画收干净
node skills/workflow-studio/scripts/cdp-dock.js --record docs/dock.gif   # 同时录演示（.gif / .mp4，ffmpeg）
node tools/docshots.js                                                 # 重截 docs/read.png、docs/versions.png（中性示例，跑完会重载页面）
node skills/workflow-studio/scripts/cdp-version.js                # 版本与回滚：5 改 5 版 / 并版 / 只留 20 / 回滚 / 拖动不出新版本（不调 agent）
node skills/workflow-studio/scripts/cdp-edit.js                   # 编辑即版本：改正文/标题/内部实现/模块各一版 + 连打只 1 版 + 1 秒内同步（不调 agent）
node skills/workflow-studio/scripts/cdp-copy.js                   # 复制链路 / 选中标记与记忆 / 静态体检抓断链空卡两截（不调 agent）
node skills/workflow-studio/scripts/cdp-copy.js --preview         # 再加一次只读预演（真调执行方，一张卡一次）
node skills/workflow-studio/scripts/cdp-livewin.js --setup && node skills/workflow-studio/scripts/cdp-livewin.js   # 独立实时画布（配 WF_LIVE_DIR 样本库，见下）
node tools/verify-actmap.js                                       # 对话 → 卡片的离线映射（不联网、不调模型）
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

**先给效果，再跑长回归**（用户嫌过「测试时间太长，我要快速看到改动效果」）：顺序固定为——改完 → 重启实例 →
拿**真实对话/真实数据**截一张图发出去 → 再跑断言脚本与老功能回归。验收项再多也不许挡住「先看一眼对不对」；
脚本可以后补，截图不能等。截图前先想好自己要看什么（卡面上有没有命令/路径/JSON、链路连没连成一条），
一张图能省掉一整轮返工。

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
3 加载时 `LEGACY_PLAIN`：机器话正文 → 人话，技术要点写进 `impl`（**用中性说法写**，不把公开仓库里不该出现的
  字段名 / 文件名搬出去；表里左边一列老正文只当匹配键，界面上不显示）；
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
- **版本号只由「一次完整改动」涨**（见「版本与回滚」）：`saveStore(true)` 只是排队，300ms 后由
  `commitVersion()` 真正 +1；拖动卡片位置用 `saveStore(false)`（位置不算内容改动）。
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

## 独立实时画布：直播一条选定的 Hermes 对话（只读）

主窗口「⋯ → 实时画布」另开一个**只读**窗口：选一条最近有活动的对话，打开「跟随」，画布就把那条对话里真实发生的事一张张变成链路卡。

### 数据从哪来（只读，硬边界）

- `livefeed.js`（主进程）跨岗位列「最近有活动的对话」：`~/.hermes/state.db`（平台主管 default）+ `~/.hermes/profiles/<岗位>/state.db`（各岗位），列表只给「谁 / 什么时候 / 在做什么」三样；之后按消息 id 读增量。
- 会话库只用 `sqlite3 -readonly` + `file:…?mode=ro` 打开；`assertSelect()` 只放行 SELECT（写语句当场拒）；不读 `.env`、不写任何文件。窗口「⚙ 内部实现」里的路径是读会话内容得来的，不是我们写的。
- 上限：初次读最近 **200** 条，之后每次增量最多 200 条；一条正文最多读 600 字、工具参数最多 4000 字；卡片最多 **60** 张。到顶**只并同类**动作卡；「要求 / 回答 / 正在做」是链路主干、**不受上限约束**（卡掉它，最终回答就没了）；没有同类可并就淘汰最早的「正在做」、再淘汰最早的回答让位——交付物（写文件 / 派活）任何情况下都必须能上图。轮询 **800ms**（满足 ≤1 秒）。
- 主窗口是唯一写者：独立窗口调 `link:write` / `link:drop` / `version:push` / `version:drop` / `flow:save` 会被主进程直接拒（`liveSender(e)`），理由是「实时画布是只读窗口」。

### 动作 → 卡片（`actmap.js`，纯函数、不联网、不读库）

**口径（用户定，优先于任何实现草案）：链路 = 文件进 → 加工 → 文件出，不是对话记录。**

- **输入 = 这条工作流真正调用的文件/素材**（图片、数据文件、货号、画板、视频）。**用户说的话本身不是输入。**
- **加工 = 加工过程中实际采用的做法**（技能名、脚本、命令、工具）。「写文件」是产出，不是加工。
- **输出 = 按要求产出的文件**（写出的文件、渲染的图、导出的视频、成片）。
- **一次要求 = 一条链路**：这一轮用到的文件（`in`）→ 用到的加工方式（`proc`）→ 交回的文件（`out`），**最多三张卡**，哪类没有就不出那张。
- **只说话不动手 = 0 张卡**；寒暄闲聊更不上图（`isChatter`）。
- 机械归并（`flushTurn`）只是兜底；要让人读得懂，必须再走一步**模型分析**（见下面「主干 + 精修分叉」）。

旧口径（按对话逐句上图）已作废，别再按它改 `actmap.js`。

| 对话里 | 画布里 |
|---|---|
| 读文件 / 看图（`read_file` `vision_analyze`）、命令行里出现的素材文件、人发的图 | **输入卡**（标题「用的文件 N」，正文列文件名 + ×N） |
| `skill_view/skill_manage` 的名字、`terminal` 里的脚本、其它工具 | **加工卡**（标题「加工 N 种」，正文列做法名 + ×N） |
| `write_file/patch` 的目标文件、回答里出现的产出文件 | **输出卡**（标题「交回 N 个文件」，正文列文件名 + ×N） |

实现：`flushTurn(feed)`（`applyMessages` 结尾及下一条用户消息开头各调一次）把当前这轮攒的三张 Map 摆成 in/proc/out 三卡；正文用 `a ×N · b · c` 的 chip 形式，文件名允许出现（那是这条链路真用的东西），命令和绝对路径只进 `impl`。`feed.turnBuf` 存这一轮，`newTurn` 在每条工作型用户消息处开新一轮。

规则（改这块先看这几条）：

1. **文件类判据统一走 `CODE_EXT`**：代码文件（js/mjs/ts/sh/py/css/html）→ 加工方式（「怎么做的」）；图片/数据/货号/画板词 → 素材；写出的文件 → 结果。`read_file` 读代码算路径、读图片/数据算素材。
2. **同一轮内同名只涨计数**，不拆卡；跨轮不串（第二轮不背第一轮的文件）。
3. **`cd` 不算加工方式**；`写/改文件` 也不算加工方式（它们是产出）。命令行的加工方式只留人话标签（`TOOL_WORD`：切目录干活 / 跑脚本 / 抓网页…），不把整条命令摆到正面。
4. **最多三张卡/轮**；`MAX_CARDS` 满了**只并同类**（同 cat + 同 target），主干的 in/out 不受上限约束，没同类可并就淘汰最早的「正在做」/「回答」让位——交付物任何情况下必须能上图。
5. **外壳拆开 + 噪音丢掉**：`tool_call`（`calls` 数组）按里面真实的工具逐个记；`todo_list / todo_write` 不落卡；系统通知（后台进程退出 / 孤儿恢复 / 「INTERNAL NOTIFICATION」）不是人说的话，整条丢掉，不许冒输入卡。**派活型会话的外壳也要剥**：开头的 `# Kanban task t_xxx: <标题>` 只留标题，紧跟着的 `Assignee / Status / Workspace / Max runtime / Terminal timeout` 元信息行整行删；`New note on your kanban task…`、`You've reached the maximum …` 这类通知整条丢。不剥的话输入卡标题就是 `Kanban task t_c95bdcfd:`，链路第一格就是垃圾（实测）。
6. **正面只说人话**：`polish()` 去掉代码块 / 行内代码 / URL / 绝对路径 / **相对路径与目录串** / 光秃秃的文件名 / 英文标识串 / 表格行；命令、参数、JSON 全在 `impl`。
   - 只剥「含 ASCII 的」路径段：`读/写`、`输入/输出` 这类中文夹斜杠的短语必须留着（整段剥掉会把话改歪）。
   - **多后缀文件名最容易漏**：`\b[\w-]+\.(png|json…)\b` 只吃得掉最后一段（`input/images/(sku)/main-01.` 残留在大面上），要连目录一起匹配。
   - 整句都是技术、拆不出人话时：正面给剥干净的那句，**原话整段进 `impl`**——不能为了正面干净把用户的要求丢掉。
   - **系统/管道报错不是结果**：`Operation interrupted` / `Error:` / `Traceback` / `Request timed out` 这类开头的文本，不许落成「回答」卡。
   测试断言直接查「正面没有 `/路径/`、`{`、反引号、`--flag`、`x.json`」，以及「`kind` 只在 in/proc/out 里、且至少各有一张」（`verify-actmap.js` 的 `kinds-in-proc-out`——**别再写成「没有 proc 卡」**，加工卡现在是正常的一格）。

7. **同类输出卡跨着中间动作也合并**：同一次要求下写文件 / 派活这类输出卡，按「同类 + 同接收人」找回这张卡往上加计数，**中间夹着命令、读文件也并**——连写 11 个文件对用户来说是「写好了 11 个文件」一张卡，不是十一张一样的卡。找法是从后往前扫 `feed.cards` 找 `cat` 与 `target` 都相同的最后一张，别只看 `feed.lastGroup`（它常被中间的「正在做」占着）。

卡片 id 用单调计数（`c1, c2, …`），撤卡不会重号；撤卡时把前后两张接回去，保证还是一条链。

### 只把「跟这次要的东西有关」的进画布（相关性 + 三类实体）

用户口径（2026-11）：链路判定以**这次要做的事**为单位。寒暄、应声、闲聊跟链路无关，不该在画布上占一张卡；
真正**反复动用**的是三样东西——**素材 / 实现路径 / 生成结果**，它们要单独列出来并带次数（同名涨计数），
因为「调整一条链路」实际上就是反复换这几样。

- `isChatter(text, pics)`（`actmap.js`，导出，可单测）：短句 + 寒暄/应声白名单（你好 / 谢谢 / 好的 / 收到 / 算了 / 继续 …）
  → **不落卡**，计入 `stats.chatter`；独立窗口状态栏写「· 忽略闲聊 N 条」，让人看见过滤真的生效。带图的永远算工作。
- `scanEntities(feed, text, at)` 扫三处输入：用户原话、agent 回答正文、工具参数。分流规则写死——
  **代码文件（js/mjs/ts/sh/py/css/html）→ 实现路径**（「怎么做的」，不是素材）；图片、数据文档、货号（11–20 位数字）、
  画板/分镜/主图这类词 → **素材**；`write_file`/`patch` 的目标文件 → **结果**；`skill_view`/`skill_manage` 的 `name` → 实现路径。
  同一份 `scanEntities` 也用于 `read_file` 的参数：读图片/数据算素材，读代码算路径。
- 别把泛指词算成实体：只写「素材」两个字不算（否则列表第一名永远是「素材×N」）；`素材|原图|白底图|主图|…` 里不带这些泛指词。
- 出口：`feedDoc()` 多一个 `entities: { materials, paths, results }`（各取前 8，每条 `{name, n}`）——
  独立窗口顶部 `#lents` 三栏渲染，空栏不占高度、内容没变不重绘（`dataset.html` 比对）。
- 验收：拿一条 500+ 条消息的真实对话跑，能直接看到「素材 preview.png×N / 路径 actmap.js×N / 结果 app.js×N」，
  而一句「你好」不产生卡、只让状态栏 +1。`tools/verify-actmap.js` 里补 `chatter-no-card`（「你好」×6 → 0 张卡）与 `kinds-in-proc-out` 两条断言；`entities` 那组按三栏名与计数断。

### 主干 + 精修分叉：让平台主管真的分析（而不是正则抽文件名）

机械归并能给出「用了哪些文件/哪些做法」，但用户读起来的链路是**语义**的（例：商品编号 → 找证据包 → 证据目录 → 出卖点卡 → 卖点卡），还带**精修**：同一素材换一种做法重做、得到不同结果。这两层只能靠模型分析。

- 入口：独立窗口的「解析链路」按钮 → `live:analyze`（`main.js`）→ 读最近 120 条消息 → `askAgentClean` 调平台主管（`-t todo,no_mcp`）→ `extractPlan()` → `renderDoc(doc, {analyzed:true})`。跟随中每 `ANALYZE_EVERY`（25s）自动再解析一次，消息少于 4 条不调。
- 提示词（`livePrompt`）必须把三件事说死：① 先认主干（素材→加工→文件出，标题 3–10 字、不用文件名当标题）；② 再认**精修**——同一素材换做法重做就从同一节点**分叉**，每条分支写「这次换了什么 / 效果差在哪」（`note`）；③ 给一个含「一对多 edges」的 JSON 示例，并把总卡数压在 8–16 张。
- 返回字段：`{cards:[{key,kind,title,body,note,branch}], edges:[[a,b]]}`。`extractPlan()` **先试 ```json 围栏（从后往前）、再试首尾花括号**，且只认 `cards` 是非空数组的那个候选——提示词里的示例 JSON 也长得合法，取第一个花括号会拿到示例。
- **调 agent 拿 JSON 必须走 `--format stream-json`，取 `result` 事件的 text**：非流式 `hermes chat -q` 的输出含提问回显 + 思考段，回显里的示例 JSON 会被当答案解析，表现为「分析跑了 48 秒但说没给出可用的链路」。`askAgentClean()` 就是为这件事写的。
- 结果取代粗版：已解析出正式链路后，粗版（跟随 tick 推来的 doc）不许再盖掉它——用 `renderDoc(d, {analyzed:true})` + `analyzedKey` 判，**别用「doc.name 有没有值」当标记**（模型不给名字时会把刚解析好的结果自己挡掉，表现为按钮跑完、画布不变）。

### 卡片长相对齐主画布（别自创一套）

用户嫌过「可读性太弱」：独立窗口的卡片必须长得和主画布一样，结构直接复刻 `nodeEl()`：
`<div class="node k-in|k-proc|k-out"><div class="hd"><span class="kind">输入</span><div class="t">标题</div><div class="st"></div></div><div class="body" data-ph>">正文</div>{mods}<div class="ft"><div class="checks">chips</div>⚙</div></div>`。

- 模块行：`素材 / 工具 / 成果` 三个标签（`MOD_LAB`）+ `.mod.t-mat/t-tool/t-res` chips；分析结果没带 mods 时，把正文按 `·` 拆成前 4 个 chip。
- 精修理由用 `.ft .checks` 里的 `chip`：「改 · 为什么改」；内部实现仍进折叠的 `details.limpl`，正面不露命令。
- **分支卡加 `.branch`（虚线边）**，主干实线——一眼分得出哪条是最终采用。
- 复用的是主画布的 class 与 `style.css`（`live.html` 已 link 它），改卡片样式先改主画布那一份，不要在 `live.css` 里另写一套。

### 树形排布（分支不能被拍平成流水账）

`layout()` 按「从入口走了几步」分列：先从无入边的节点 BFS 算 `depth`，同列按出现顺序上下堆（`ROWGAP` 隔开）。分叉自然在同一列上下错开，读起来是树枝。旧的一行 5 张折行排法会把分叉压成一条线，已废弃。

### 这一块踩过的坑

- **按钮监听必须绑在初始化处**，不能塞进 `follow()`：塞进去只会在拨开关时绑一次，用户直接点「解析链路」没反应（按钮文字都不变）。
- **新开窗口的 IPC 别在 evaluate 里 `awaitPromise`**：`openLive()` / `liveAnalyze` 这类会新开窗口或长跑的调用，`awaitPromise:true` 会把 CDP 连接挂死（整条命令超时）；fire-and-forget + 另起进程 `curl /json` 数页面。
- **探针里的嵌套模板字符串会炸**：CDP 表达式用 `[...]`/单引号拼，别在外层反引号里再套反引号（`SyntaxError: missing ) after argument list`）。
- **一次解析约 60 秒**：状态栏要当场写「解析中…」，按钮置灰；跑完写「已解析：N 张卡 · 链路名」。不要让它看着像卡死。

### 窗口与状态

- `main.js` 的 `openLiveWindow()`：`parent: 主窗口`（关主窗口它跟着关）、无侧栏/无按钮、只留「选对话 + 跟随开关 + 状态」；`live:open` 已开着就 `show()+focus()`。
- 关独立窗口不影响主窗口：`closed` 里 `stopLiveTimer()`，选中的对话与开关状态留在 `<userData>/live.json`，重开窗口由 `live.js` 读 `liveState()` 自动接着跟。
- 换对话：主进程重置 feed 重读，画布先清空再长新的（0 残留）；开关关着也会给一份快照（`live:snapshot`，不起定时器）。
- 关开关：`liveFollow({on:false})` 立刻 `clearInterval`，画布留在原地、不清空、不重置。
- 排布：一行 5 张、换行接着排；视野跟着最后一张卡走（`keepLastInView`），不折缩放。

### 跑验收

```bash
export CDP_PORT=9333
node skills/workflow-studio/scripts/cdp-livewin.js --setup     # 造样本会话库（示例内容），并清掉应用数据目录
WF_LIVE_DIR="$TMPDIR/wf-live-fixture" ./node_modules/.bin/electron . --remote-debugging-port=9333 --user-data-dir="$TMPDIR/wf-9333" &
node skills/workflow-studio/scripts/cdp-livewin.js             # 21 条 PASS、末行「全部通过」
node skills/workflow-studio/scripts/cdp-livewin.js --shot docs/live.png   # 顺手刷新文档图（样本内容，中性）
node tools/verify-actmap.js                                    # 离线映射：真实历史对话前 N 条 → 卡片，末行「全部通过」
```

改 `actmap.js` 的映射规则（哪些动作上图、卡片怎么并）时，`cdp-livewin.js` 与 `tools/verify-actmap.js` 的断言
必须一起改：它们断言的是「几张卡、卡上写什么」，不改断言就只剩代码自嗨。两条都要重跑到「全部通过」。
断言里别钉死具体计数（「读了 10 份资料」这类），一律钉**规则**（没有 `kind: proc` 的卡、正文里有人话计数、
细节在 `impl` 里且带「共 N 次」）——样本库每跑一次都会长新消息，钉死数字的断言必然假失败。

下面四类断言是踩过实钉的，改 `polish()` / `pushCard()` / `SKIP` 时必须都在：

| 断言 | 构造 | 期望 |
|---|---|---|
| 相对路径不进正面 | 用户原话里带 `input/images/(sku)/main-01.03.jpg` | 正面看不到路径；原话整段在 `impl` |
| 满上限不串味 | 35 轮对话（每轮 要求→动作→回答）顶满 60 张，再喂 `write_file` 和一段回答 | 写文件独立成卡 `n=1`；回答仍落在最后；不同类不被并 |
| 待办不落卡 | 连续 4 次 `todo_write / todo_list` | 卡片与正文里都不出现「用工具」「todo」 |
| 系统报错不亮成回答 | 一条 `Operation interrupted: …` | 不生成「回答」卡 |
| 闲聊不占卡 | 连发 6 次「你好」 | 0 张卡，`stats.chatter` 记 6 |
| 链路三格齐全 | 一句要求 + 若干工具调用 + 一段回答 | `kind` 只在 in/proc/out，且至少各有 1 张 |

`--setup` 会连 `$TMPDIR/wf-9333` 一起清（状态要从「第一次打开」开始，第一条卡的计时才有意义）；实机验证去掉 `WF_LIVE_DIR` 就是真库。
样本库里加新消息由脚本自己写（那是我们自己的临时库，应用那侧始终只读）。只读证据（可直接重跑）：

```bash
sqlite3 -readonly "file:$HOME/.hermes/state.db?mode=ro" "insert into sessions(id) values('probe')"
# → Error: stepping, attempt to write a readonly database (8)
```



## 版本与回滚（最近 20 版）

用户口径：只留最近 **20** 版（不要全量历史）；连续打字 / 连着拖按一次算；拖动卡片位置**不算**内容改动。
三处一起看：`versions.js`（主进程存快照）/ `main.js` 的 `version:*` IPC / `renderer/app.js` 的
`verSnapshot / verContent / verWhat / scheduleVersion / commitVersion / rollbackTo / verHead`。

### 一版是什么

- 快照 `verSnapshot(w)` = 链路名 + 执行方 + 卡片（id / 类型 / 名字 / 正文 / 内部实现 / 模块 / 校验 / 坐标）+ 连线。
  **能整条带回去**，不只正文。
- 内容指纹 `verContent()` **不含坐标**：只挪位置 → 指纹一样 → 不产生版本（`saveStore(false)` 也走这条）。
- `saveStore(true)` 只 `scheduleVersion()` 排队：300ms 内的连续改动并成一版（`commitVersion()` 才 `w.version+1`）；
  一批里「加了卡 + 连线 + 改正文」也只算一版；`what` 由 `verWhat()` 对比上一版算出人话
  （加了/删了哪张卡、改了哪张卡的哪个环节、几条线、执行方、链路名）。
- 谁改的：`by: 'me' | 'agent'`。agent 提议、人点确认后落地的那几处（`addFromOption` / `addFromDock` /
  `placeChain` / `promoteTemp`）用 `saveAs('agent')`，其余是人。改这些入口时别漏 `saveAs`。
- 落地文件：`<userData>/versions/<链路 id>.json`，`list` 升序、主进程 `trim()` 统一裁到 20 条（同一个版号再推覆盖）。
  链路删掉时 `deleteWorkflow()` 一起 `versionDrop()`。临时画布不记版本（不进列表、没有回滚）。

### 回滚

- 入口只有 `rollbackTo(v)` 一处，UI 在**左栏「概览」面板底部的版本列表**（一条一行：第几版 / 时间 / 改了什么 / 人|agent，
  点一行就回滚）。别在别处再造入口。
- 带回的内容：卡片 / 连线 / 模块 / 正文 / 内部实现 / 校验 / 执行方 / 链路名。**坐标不回到旧版**：现在还在的卡留在原地，
  被回滚带回来的卡用快照里的坐标（位置本来就不算改动）。
- 回滚**也记一版**（`what: 回滚到 vX`，带 `rollback:{to}`），不删后面的版本 → 回得去、也再回得来。
- 回滚时把这条链路上正在跑的对话停掉：`cancelRunsFor(flowId)` → `window.tcflow.cancelAgent(runId)`
  （主进程 `SIGTERM` + 日志 `[取消] …`）。被停的那次 `live.cancelled = true`，气泡只留一句
  「这条链路被回滚了，这次运行已经停掉」，**不再解析候选卡**、不往画布写东西。
- 回滚后只 `centerView()`，不改缩放（`fitView` 会把画面缩掉，别在这里用）。

### agent 怎么知道（只注入上下文，不改任何岗位配置）

- `verHead(w)` 放在五条提示词（`buildChatPrompt` / `dockPrompt` / `askFlow` / `validateAll`；
  临时画布 `tempPrompt` 不带）的**第一行**：
  `【版本状态 · 必须出现在你回答的第一句话里】当前链路版本 vN；用户在 HH:MM 把它回滚到了 vX，vX 之后的改动已作废。`
- `w.rollback = {at, from, to, v, settled}` 存在工作流上（随 localStorage 走）；回滚之后又有新改动时
  `commitVersion()` 把它标成 `settled`，提示词改成「曾在 HH:MM 回滚到 vX，之后又改过」。
- `linkBrief()` 多一行版本记录文件路径，状态文件里也有 `rollback` / `versions_path`（agent 想核查可以直接读）。

### 跑验收

```bash
export CDP_PORT=9333                                     # 隔离实例先起来（见「启动与验证」）
node skills/workflow-studio/scripts/cdp-version.js       # 不花钱：5 改 5 版 / 并版 / 只留 20 / 回滚/再回来 / 拖动不出新版本
node skills/workflow-studio/scripts/cdp-version.js --chat  # 加一次真实调用：回滚后 agent 复述「现在第几版、回滚到哪版」
# 验「对话跑着的时候回滚，运行被停掉」：实例用 WF_CHAT_FAKE=hang 起，再跑
./node_modules/.bin/electron . --remote-debugging-port=9333 --user-data-dir=$TMPDIR/wf-9333 &   # 前面加 WF_CHAT_FAKE=hang
node skills/workflow-studio/scripts/cdp-version.js --fake
```

`--fake` 靠主进程的 `WF_CHAT_FAKE=hang`（`agent:stream` 起 `/bin/sleep 600` 冒充对话，平时不设就照常调 agent）；
断言 `RUNS` 里这次运行被摘掉、消息打了 `cancelled`、最新一版写「回滚到 vX（停掉 1 个正在跑的对话）」，
主进程日志有 `[取消] 停掉正在跑的运行 …`。

## 编辑即版本（改一张卡里面的东西）

用户口径（2026-11）：换输入元素、换加工方式、加删模块、改内部实现，和加卡连线一样，
**要立刻反映到画布和共享底稿、记一版、agent 下次知道**。以前这些只在失焦时 `saveStore()` 一次，
打字过程中既不落盘也不记版本（Esc/切卡还可能丢掉没失焦的那几个字）。

### 三条时间线（改这块先看这里）

| 什么时候 | 做什么 | 代码 |
|---|---|---|
| 每敲一个字 | 改内存 + 画布当场变（`syncCard` / `paintNodes`），**不重建左栏**（重建会抢焦点、光标跳） | `oninput → saveEditing()` |
| 停手 350ms / 连续打字每 350ms | 写共享状态文件（`queueLinkWrite`，1 秒内一定同步） | `saveEditing()` |
| 停手 300ms | 本地存储落盘（关窗口不丢字；`beforeunload` 再兜一次） | `saveEditing()` |
| 停手 1.5 秒 / 失焦 / 面板被重建 | 记一版（`EDIT_IDLE_MS`；`render()` 开头 `flushEditing()` 兜住 Esc、切卡、关面板） | `commitEditVersion()` |

- 版本仍走 B 卡那一套：`VER.pending` + `commitVersions()`，内容指纹没变（只是点了面板 / 挪了位置）就自己跳过。
  连打 30 个字只多 1 条：`saveEditing()` 每敲一下只重置 1.5 秒的定时器，不直接记。
- 版本条目说人话：`verWhat()` 现在写 `加工卡·出图：换了加工方式` / `…：改了内部实现` / `…：改了模块`
  （`BODY_WORD` 按卡片类型把「正文变了」翻译成换输入元素 / 换加工方式 / 换交付内容）。
- 改标题时输入框允许暂时为空，失焦才归一成默认名；模块名 `contenteditable` 打字时 250ms 节流重画画布，
  失焦/回车才提交版本，清空即删。
- agent 那边不用额外做：`cardLine()` 一直从画布读实时值，四条提示词（卡片对话 / 右下角 / 概览 / 逐卡验证）都带正文、
  模块、内部实现。`cdp-edit.js --chat` 会真问一次「这张加工卡的正文是什么」验这句话。

注意：`paintNodes()` 只重建画布上的卡（`#canvas .node`），面板不动，所以打字时不会掉焦点；
别图省事在输入回调里调 `render()`。

### 跑验收

```bash
export CDP_PORT=9333
node skills/workflow-studio/scripts/cdp-edit.js          # 17 条：各改一次都成版 / 连打 30 字只 1 版 / 光标与长任务 / 1 秒内落盘 /
                                                         # 回滚带回编辑 / 拖卡折叠换选中 0 版 / 提示词带新内容 / 收尾干净
node skills/workflow-studio/scripts/cdp-edit.js --chat   # 再加一次真实调用：agent 复述改过的加工方式（原样引用）
```

## 复制链路 + 选中一条来测（静态体检 / 只读预演）

用户口径（2026-11）：先把一条链路**复制成独立副本**改着试；画布上**选中的那条**要一眼认得出、关掉重开还记得；
测试先做两件不花钱/不动手的事——**静态体检**（本机算）和**只读预演**（执行方按卡片顺序说「会怎么做、缺什么」）。

### 复制链路（`duplicateWorkflow` / `copyName`）

- 入口两处：顶栏「复制链路」（复制当前这条）、右栏每条链路右上角的 `⧉`（复制任意一条）。两处都走同一个函数。
- 带过去：卡片（类型 / 名字 / 正文 / 内部实现 / 模块 / 校验 / 坐标）、连线、执行方、校验项。
  不带：卡片对话、预演结果（那是这台机器上的记录，不该跟着副本走）。
- 副本的**每张卡、每块模块**都换新 id，连线按 id 映射重接 —— 所以改副本不影响原件，反之亦然。
- 名字：`原名（副本）`，重名就`（副本 2）（副本 3）…`，绝不出现两条同名。
- 版本：副本插在原件后面，`version: 1`，先 `pushVersion` 一条基线 `复制自「原名」`，再 `saveStore()`；
  因为已经设好 `VER.sig`，这次 saveStore 不会再顺手记一版。状态文件按新 id 单独一份。

### 选中的链路

- 选中的就是画布当前那条（`store.current`）。右栏 `.wf.on` 有橘色竖条 + 行内「选中」徽标，别的行不标记。
- 记住：`saveLocal()` 每次都把 `current` 写进 `localStorage['tcflow.v4']`；`loadStore()` 末尾补一条
  「current 不在这份列表里就退回第一条」，所以删过链路也不会卡在一张空画布上。关窗重开还是上次那条。
- 测试对象 = 选中的那条（`flow()`）：一次只测一条，不做批量。

### 静态体检 `checkFlow(w)` → `checkText(w)`

纯本机计算，不调模型。逐条给 `{哪张卡, 什么问题, 怎么补, kind}`：

- 没指派执行方 / 一条卡片都没有；
- 连线指向不存在的卡（删卡残留）；
- 空卡：只有标题、正文为空；
- 输入卡没人接（没出边）、有东西连进输入卡；加工卡缺输入（没入边）、缺产出（没出边）；输出卡没人做（没入边）；
- 自连线 / 绕成圈（DFS 找回边，圈上卡片逐个点名）；
- 断成几截：按不分方向的连通块数，每多出来的一截单独一条，写清是哪几张卡。

报告在「测试」弹层里逐条渲染（`#tReport .trow`），`checkText()` 是同一份内容的纯文本版（验收贴原文用）。

### 只读预演 `startPreview()` / `clearPreviews()`

- 顺序走 `chainOrder(w)`，一张卡一次调用，提示词只问「按现在的写法，这一步你会怎么做、缺什么材料」，
  3 行以内；回答回填 `node.preview = {at, ok, secs, steps, text}`（`steps` 是这次真实发生的工具调用数）。
- **零工具**：`PREVIEW_TOOLSETS = 'context_engine,no_mcp'`（`context_engine` 解析不到任何工具，
  `no_mcp` 关掉 MCP 连接）—— 跑不了命令、读写不了文件、发不了消息、发布、付费。主进程 `agent:stream`
  在 `preview: true` 时**再强制盖一次**这个工具组，渲染层传错也拿不到别的工具。
- 证据在主进程日志里：每次 `[预演] 起进程：… -t context_engine,no_mcp`，收尾
  `[预演] 结束：工具调用 N 次 · 退出码 0`（正常应为 0）。界面每条结论下面也写「工具调用 N 次」。
- 结果只属于这台机器：写 `saveStore(false)`（不涨版本、不写共享状态文件），`linkDoc()` 不带它；
  外部认领 / 回滚时按卡片 id 保留（`applyLinkDoc` / `applyVerSnapshot` 里的 `preview`）。
- 看得见：卡片底部挂 `预演 ✓`、左栏卡片里一块「预演结果」、测试弹层里每张卡一行。
  「清空预演」一次删掉全部 `node.preview`，卡片标、左栏那块、弹层行一起收干净。
- 收场：关弹层 / Esc / 切链路 / 新建 / 回滚 / 关窗口都 `stopPreview()`（`cancelAgent` 真杀子进程），
  已经问完的结论留着。同一时刻只允许跑一次（`PV.busy`）。

### 跑验收

```bash
node --check renderer/app.js && node --check main.js
export CDP_PORT=9333
node skills/workflow-studio/scripts/cdp-copy.js                   # 期望 13 条 PASS、末行「全部通过」
node skills/workflow-studio/scripts/cdp-copy.js --preview         # 再加 preview-cards / preview-readonly / preview-panel / preview-clear
```

「关掉重开窗口还记得选中」用**正常关窗**验（页面 `window.close()` 再退出进程）。别用 `kill -9` / 连着
`SIGTERM` 硬杀来判：Chromium 的 localStorage 是异步落盘的，硬杀会把最后一段写丢掉（这是环境行为，
不是这段代码的 bug；正常关窗 + 重开实测选中还在）。

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

### 顶栏宽度是有预算的（被打回过一次）

默认窗口 1380 宽，顶栏一排已经占满：`WF + 名字`、执行方选择器（最长选项 211px，控件 242）+
读取/加卡片/逐卡验证/对话建链路/新建/复制/测试/⋯/开始运行。所以：

- 名字框 `#flowName` 是 `width:100%;min-width:110px;max-width:220px`，`.brand` 可收缩但 `min-width:170px`；
  名字的父层 `.brand-name` 必须 `flex:1 1 auto;min-width:0`（少了它输入框会溢出品牌区、压在选择器上）。
- **导入 / 导出收在顶栏「⋯」菜单里**（`#btnMore` + `#moreMenu`，条目仍是 `#btnOpen / #btnSave`，处理函数不变）。
- 往顶栏加按钮前先量三条：名字与选择器 rect `overlap === 0`、名字中点 `elementFromPoint` 命中 `flowName`、
  最右按钮右边界 ≤ `innerWidth - 8`。这三条已经写进 `cdp-copy.js` 的 `topbar-no-overlap`，别等验收才看见。
  血的教训：24b04c0 新增「复制链路 / 测试」后 `#flowName` 还写死 220px，名字直接盖住执行方选择器 182px。

### 窄窗口：放不下的按钮收进 ⋯（别再切出窗外）

- 应用最小宽度是 1000（`main.js` 的 `minWidth`）。默认 1380 一排刚好；**1000 时曾经 1325 > 1000，右侧五个控件
  被窗口右缘切掉，「开始运行」完全点不到**（`.topbar{overflow:visible}` 是切掉不是可滚）。
- 现在的做法：`renderer/app.js` 的 `initTopbarFold() / fitTopbar()` 在启动和 `resize` 时量一次，按
  `TOP_FOLD`（测试 → 复制链路 → 逐卡验证 → 对话建链路 → 读取 agent 链路，从最不常用的开始）把按钮**搬进 `#moreMenu`**，
  窗口变宽再按原位注释插回。只搬 DOM、不移交事件，顶栏和菜单里是同一个 `onclick`；`.menu button` 有自己的条目样式。
- 放不下的判定要**两处都看**：`scrollWidth > clientWidth`，以及最右控件是否顶进右内边距
  （`scrollWidth` 只看 padding box，顶进 padding 的那几个像素它看不见，只量 scrollWidth 会漏 12px）。
- 回归：`cdp-copy.js` 现在三连（`topbar-no-overlap` 1380 / `topbar-min-width` 1000 视口模拟 / `topbar-fold-click`
  真鼠标点菜单里的「测试」/ `topbar-restore` 清掉模拟后还原）。视口模拟用 `Emulation.setDeviceMetricsOverride`，
  不动真窗口、不依赖 System Events 权限。
- 文档图跟界面一起走：`tools/docshots.js` 重截 `docs/read.png`（读取窗 + 一份中性示例预览）和
  `docs/versions.png`（示例链路 4 卡 + 真做出来的 v1–v5）；`docs/dock.gif` 用 `cdp-dock.js --record docs/dock.gif` 重录。
  这三张都上公开仓库，示例一律用「示例部门 / 示例岗位甲–丁 / 示例商品」这类中性说法。

## 常见坑

- **关实例别用会匹配到自己的 `pkill -f`**：模式串会命中正在执行这条命令的 shell 自己（工具把整条命令塞进
  `bash -c` 的 cmdline），结果是这条命令被 SIGTERM 掉（退出码 -15）、实例却没关干净。改用
  `lsof -nP -iTCP:9333 -sTCP:LISTEN -t | xargs kill`，或把模式写成 `[E]lectron .*9333` 这种方括号技巧。
  不带端口的 `pkill` 会连用户在用的窗口一起关，任何时候都不要。
- **上一会话留下的后台循环会抢你的实例**：`process_manage list` 只列当前会话的作业，别处（kanban worker 起的
  `for i in 1 2; do pkill; 起实例; 跑脚本; done` 这类稳定性循环）可能还在跑——症状是实例自己重启、端口被占
  （`bind() failed: Address already in use`）、“真库”实例里冒出样本数据。起实例前先
  `ps -eo pid,ppid,etime,command | grep 9333` 看有没有同一个父进程下的兄弟进程，并翻 `/tmp/wf9333-*.log`、
  `/tmp/*.out` 这些上一轮留下的输出——那些日志往往已经是现成的证据，不用重跑。
- **环境变量跨调用留在 shell 里**：`export WF_LIVE_DIR=…` 之后每个 `terminal` 调用（包括 background 起的实例）
  都继承它，于是“真库实例”其实在读样本库——对话列表里出现「示例岗位甲/示例商品」就是它。要真库就显式
  `env -u WF_LIVE_DIR ./node_modules/.bin/electron …`，要样本库就显式带上（两边都写死，别靠继承）。
- **卡片底部一行塞不下四个药丸**：`.ft` 是 `flex-wrap:wrap`，校验徽标（`.checks`）`flex:1 1 100%` 自己占一行、
  `⚙ / ? 问 / ✦ 下一步 / ↗ 连线` 另起一行。以前徽标和药丸挤在一行（`.checks{flex:1}` + min-width:auto），
  带去两个校验项的卡会把「↗ 连线」挤出卡片右边缘、被 `overflow:hidden` 裁掉。别再改回单行。
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
- **开第二个窗口别在 `Runtime.evaluate` 里等返回值**：调 `window.tcflow.openLive()` 这类会新开窗口的 IPC，
  `awaitPromise:true` 的 evaluate 会一直不返回、把这条 CDP 连接挂死（表现为整条命令超时）。做法是 fire-and-forget
  （表达式写 `window.tcflow.openLive(); 1`，拿到回执就关 ws），由**另一个进程** `curl -s http://127.0.0.1:$PORT/json`
  数页面来确认窗口开没开。实时画布窗口的卡片类名是 **`k-in / k-proc / k-out`**（不是 `kind-*`），按类名统计别数错。
- **实时画布的下拉只列「最近有活动」的对话**：派活型会话（看板卡跑完就沉底）常常不在下拉里，只能看到那个岗位的
  `Bot Chat`。要解析那几条具体的任务会话，别在界面上找——直接 `sqlite3 -readonly "file:<profile>/state.db?mode=ro"`
  取消息喂 `actmap.js`（离线解析脚本就是这个形状），先把链路看对再谈界面。
- **缩放后先把目标卡滚进视口再点**：缩放锚在视口中心，1.5 倍时靠左的卡会滑到视口外，`getBoundingClientRect`
  给出负坐标，点下去是空气（`cdp-canvas.js` 的 drag 曾因此误报）。
- **刚 render 完不要立刻量 layout**：列宽折叠、缩放、字体都会晚一帧生效，量到的 `getBoundingClientRect`
  是中间态（曾因此误报“双击失效”：实测点落到了已经移位的列表上）。探针里先 `wait(200~300)` 再量。

- **画板尺寸写在两处**：`CANVAS = {w:12000,h:8000}`（JS，拖动夹边界用）和 `#canvas{width/height}`（CSS，
  决定滚多远）必须同步改；只改一处会出现“能拖到的地方和能滚到的地方不一致”。同理 `ORIGIN` 必须
  是画板正中，否则某一侧能拖的距离会明显短。
- **不重启等于没改**：主进程和 `renderer/*` 都不会热加载。改完先把 9333 上的实例关掉再起（用 `lsof … -sTCP:LISTEN -t | xargs kill`，别用会命中自己的 `pkill -f`），否则连到的是旧进程、截图和 DOM 断言都是上一版。
- 节点宽度变了要同步 `chainOrder` 之外的两处：连线的 `x1` 偏移、插入按钮定位。
- 不要把 `localStorage` 里的旧 schema 直接读进新代码；升 key 版本（v4）。
- 左栏宽度/收起状态一变，卡片屏幕坐标就变，必须重新 `drawEdges()`；面板状态统一走
  `applyPanelState()`，`markSel()` 里也要调它，否则只改 `selId` 时对话栏不会跟着收/展。
- 卡片正文/标题是模板字符串拼进 `nodeEl()` 的：多敲一个反引号就是整页白屏，`node --check` 能先抓到。

## 开源

本手册和它的 `scripts/`（`cdp-await.js` / `cdp-click.js` / `cdp-canvas.js` / `cdp-dock.js` / `cdp-version.js` / `cdp-edit.js` / `cdp-copy.js` / `cdp-livewin.js` / `parse-agent-output.js`）就在仓库里：
`skills/workflow-studio/`。新增验证脚本直接放这里（`scripts/` 是可直接重跑的采集/断言，不要写成一次性探针），
并在 `git status` 里确认它们不是 `??` 漏提。

仓库根有 `README.md` / `LICENSE(MIT)` / `CHANGELOG.md` / `.gitignore`。提交前跑：

```bash
git status --short && git diff --stat
git grep -nEI "(ghp_[A-Za-z0-9]{20,}|github_pat_|s[k]-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|_API_KEY=)" -- . ':!node_modules' || echo "no secrets"
node tools/scan-public.js          # 部门名 / 岗位名 / 本机路径 / 旧项目名：期望「0 命中」、退出码 0
```

（`s[k]-` 和两字母前缀写法等价：字符类里的 k 一样能命中，但仓库里不会出现连续的那个前缀，
于是这条命令不会自己命中自己。以后写防护正则和扫描命令都按这个写法。）

不要提交 `node_modules/`、`preview.png`、任何 `.env` 或含密钥的文件。

### 发布到 GitHub（已发布：`github.com/VHKrib/workflow-studio`，**public**）

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
