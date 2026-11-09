# 画布、卡片与对话交互

修改前用 `read_file`、`search_files` 追定义及调用点；函数名用于定位，最终以当前分支为准。视觉数值与 Hermes 对话样式另读 `references/hermes-chat-visual.md`。

## 状态与坐标

- 工作流、节点和边由渲染层维护；通常以 `tcflow.v4` 持久化，加载旧结构先走迁移。工作流对话与节点对话分别存放，不串到其他卡或画布。
- 区分 `selId` 与 `panelCardId`：选中/拖动只改选中态，双击和显式操作才打开详情。空白处/Esc/删除时统一清状态。
- 节点使用画布设计坐标；屏幕位移除以 zoom，并同时计入滚动与原点偏移。节点位置、拖动换算、连线端点和画板尺寸必须一致。
- 允许设计坐标为负，不用零作为隐形拖动边界；仅按真实画板边界限制。拖动时按当前画布坐标重算，不能只累加鼠标位移，否则贴边自动滚动时会脱手。
- 缩放以视口中心为锚，只有 zoom 真变时才重算滚动；先应用缩放再画连线。切工作流时对准卡片包围盒，无卡才回画板原点。
- 平移滚动层与浮动工具条分开，装饰层不给鼠标命中。拖卡靠近视口边缘时逐帧自动滚，松手将卡保持在可见处。

### 视野锚定与边界（更新不跳、也丢不了）

实时画布每收到一份新 doc 都会 `layoutChain` 重排；再叠一个「视口里没卡就 `fit()`」的兜底，用户看到的就是「新卡一长出来整张画布跳走」。又因为 `transform: scale()` 不改变滚动区（画布仍是 12000×8000 的布局尺寸），缩小到几十百分比后可视内容只占左上角，随手一拖就进空白，看起来像工作流丢了。

- **更新前锚定、更新后还原**：`renderDoc` 里先取「与视口相交、且离视口中心最近」的那张卡，记它的 `getBoundingClientRect()` 的 left/top；等 `layoutChain` + 渲染 + 连线都跑完，用新 rect 与记忆值的差补回 `wrap.scrollLeft/scrollTop`。只有首次载入、切对话（`conv.key` 变了）、或视口里确实一张卡都没有时才 `fit()`。
- **切对话不要锚**：换了一条图本来就该整体对准，锚旧位置会把新图对到画外；切的时候顺手清掉 `fitted`。
- **滚动夹紧到内容包围盒**：范围取节点 `style.left/top` 加 `offsetWidth/Height`（含 ORIGIN 偏移），按 zoom 换算后夹紧：`a = max(0, lo - view + m)`、`b = max(a, hi - m)`，`m` 取 `max(160, view * 0.45)`。固定 160px 的边距在极限处会只剩一条缝，用户仍说找不到；45% 视口保证拖到底还有近半屏卡片。
- **夹紧要挂在三处**：`applyZoom()` 末尾、拖动 `pointermove` 里、`renderDoc` 收尾。只挂一处等于没挂——滚轮缩放和拖拽是两条不同的路径。
- `zoomReset`（⌂）仍然是「复位并看全」的兜底：`zoom = 1 → layoutChain → fit`。
- **验据**：给实时页留一个只有 `location.hash === '#selftest'` 才挂的钩子（暴露 `renderDoc / fit / clampScroll / scroll`），灌三张假卡再追加两张，断言同一张卡的屏幕 rect 前后位移 0px；再合成 2400px 拖拽后断言可见卡数量不为 0。钩子按 hash 开关，正常使用无副作用。

### 连线曲率（拖动只改端点，不改弯法）

原实现每次重画都按两端中点现算控制点：`c1=(mx,y1)`、`c2=(mx,y2)`、`mx=(x1+x2)/2`，等价于 `dx=(x2-x1)/2`。拖动时每帧都调 `drawEdges()`，于是曲率跟着指针连续变化——用户看到的是「线在重新计算曲度」，随后会明确要求拖完不要再算。

- **缓存控制点偏移**：`EDGE_DX` 以 `"a>b"` 为键存 `dx`；绘制时 `c1 = x1 + dx`、`c2 = x2 - dx`。端点照旧按卡片/插槽实时取，只有弯法被冻结。
- **只在结构变化时重算**：`layoutChain` 收尾 `drawEdges({recalc: true})`（排完版不重算会留旧弯法、看着歪）、新建连线（键不存在自动算）、导入/换工作流。默认路径（拖动、缩放、局部重绘、保存后重画）一律复用。
- **顺手清理**：每轮把不在当前 `w.edges` 里的键删掉，否则删掉的连线会留下陈旧 dx，同名边重连时弯法是老的。
- **两个画布都要改**：主画布 `renderer/app.js` 与共享脚本 `renderer/cardsys.js` 各有一份同名 `drawEdges`，只改一份等于没改。改前先数重复（见 SKILL.md 的重复定义陷阱）。
- **验据（不碰用户数据）**：
  - 实时页：`tools/test-edge-shape.js` + `tools/test-stub-preload.js` 起一个带桩 `window.tcflow` 的隔离窗口，加载 `live.html#selftest`，`__lc.renderDoc(假 doc)` 后用 `sendInputEvent` 拖 180/90px，解析 `path[data-k="a>b"]` 的 `d`（`M x1,y1 C c1x,y1 c2x,y2 x2,y2`），断言 `c1x-x1`、`x2-c2x` 不变而 `x2` 变了；再 `renderDoc` 一次验证排版会重算。
  - 主画布：在页面里只改 `el.style.left`（不写文档、不调 `saveStore`），调全局 `drawEdges()`，比对控制点偏移不变，随后把 `style.left` 复原再画一次——全程不会落盘。
  - 自测时容易误判：拖动的目标是 `b`，`a>b` 这条边的 `x1`（来自 `a`）本来就不该动，要看 `x2` 或 `b>c` 那条。

## 卡片模块与连线

- 输入卡模块是素材，加工卡自身模块是做法/工具，输出卡模块是成果；模块名用具体短词，不用整段正文切片代替。
- 加工卡的素材与成果插槽由边和上下游卡模块推导，不另存一份插槽内容；否则外部状态和画布迟早分歧。
- 输入/输出卡可拖入合适插槽；接入前检查整条可达关系以拒绝长环，不能只查一条反向边。拒绝时回原位，成功后避开其他卡摆放。
- 从插槽拖出才删除对应边；普通点击或双击不应触发拔出。悬停关联模块时可高亮来源卡和对应边。
- 连线端点按真实模块/插槽位置计算，不写死在卡片中心；面板展开、缩放和窗口尺寸变化后重画。
- 更新节点签名时包含所有可见字段：正文、模块、状态、修改理由、分支和版本。只改理由或分支也必须刷新，不能被旧签名过滤掉。

## 动画与渲染生命周期

- 流式或拖动期间只更新变化节点，不能每帧重建整块 DOM；否则鼠标按下/抬起落到不同元素，折叠和双击都会失效。
- 不在 pointerup 里整页 render；拖动收尾仅保存位置，保留 DOM 以接住随后的双击。
- 动画替身考虑画布缩放，不遮住目标插槽；CSS transition 不得压过正在使用的 Web Animations transform。
- 动画均设兜底收尾；窗口隐藏时完成事件可能不触发。重绘后按键重新取连线，不持有已失效 path；reduced-motion 时跳过动画但保持最终状态。
- 验动画既查最终关系，也查临时层、飞行块和高亮已清空，不只等待固定时间。

## 面板、文本与顶栏

- Grid 收栏用零列宽、overflow 和 visibility，不用 display:none 把列从布局中移走。
- 内容编辑只在详情面板，输入回调不重建面板；否则焦点与光标跳动。画布上的文字保持只读。
- **`pointerdown` 里调 `preventDefault()` 会连带吃掉随后的 click/dblclick。** 加拖拽时最容易踩：卡片能拖了，双击却再也打不开面板，且控制台没有任何报错。做法是 pointerdown 不 preventDefault，用「移动超过 3px 才算拖、否则当点击」的阈值区分，pointerup 判定未移动就只清状态、不写位置。
- 流式消息用稳定节点做局部更新；重绘非流式日志时按唯一 key 还原 details.open。工具过程与思考正文使用不同 key。
- 不伪造模型思考。文本格式有思考段时按真实内容展示；流事件没有推理正文时不制造一个折叠块。工具结果、原回答和候选卡分开保留。
- 保留候选卡出现前的原回答；摘要不能覆盖原话。候选只展开预览，明确确认后才落入正式画布。
- 留白优先于压字号；正文可断长词，工具名可省略号。卡底药丸允许换行，不能被圆角或 overflow 裁掉。
- 顶栏按实际 rect 和剩余内边距折叠低频动作进已有菜单；同时检查 scrollWidth 与最右控件，前者可能漏掉侵入 padding 的部分。名称容器允许收缩，菜单搬同一 DOM 保留事件。
- 不加长引导文案或额外设置项；默认行为做对。真实业务内容和本机路径不得进入公开截图。

## 隔离验证

用 `terminal` 在已设置 `CDP_PORT` 的隔离实例运行当前仓库脚本：

- `skills/workflow-studio/scripts/cdp-canvas.js`：平移、缩放锚点、拖动、贴边滚动、连线与重叠。
- `skills/workflow-studio/scripts/cdp-dock.js`：悬停、接入、拒绝环、拔出、成果槽、动画清理；需要文档动图时使用脚本实际支持的 `--record`。
- `skills/workflow-studio/scripts/cdp-click.js --card "<目标标题>" --mode double`：真实鼠标的单击/双击分工。
- `skills/workflow-studio/scripts/cdp-await.js <探针文件>`：等待异步页面函数，表达式用异步 IIFE，不能顶层 await。

探针自己定位工作流并打开目标卡，取值前判空；render 后重新取元素，等布局稳定再量 rect。缩放后先把目标滚进视口，再发真实鼠标事件。变动只用于自有测试数据，并还原临时坐标/状态。

- 合成拖拽的 `mouseMoved` 必须带 `buttons: 1`，否则页面收到的是无按键移动，拖动逻辑不启动、坐标一动不变——先怀疑这个，别怀疑产品代码。
- 量展开/收起后的宽度，要等过渡结束（约 400ms）再取 rect；展开瞬间量到的是折叠宽度（常是 1px），会误判成「样式没生效」。
- 视图复位（`zoomReset` → fit）后 `scrollLeft/scrollTop` 按 `(ORIGIN + 卡坐标 - pad) * zoom` 算：卡画在原点偏移之后，漏掉 ORIGIN 会滚到左上角空白，随后所有「卡在视口外」的点击都落空。

## 共享一套卡片系统（两个窗口同源）

实时窗口要和主画布「完整照搬」时，不要去追两套实现，而是把源实现抽成共享脚本 `renderer/cardsys.js`，两边都在自己的主脚本之前用 `<script>` 引入：

- 搬函数：`nodeEl`、`modsHTML`、`chipHTML`、`plugChips`、`plugKey`、`peer`、`statusDot`、`drawEdges`、`dragCard`、`startLink`、`hit`。用 `skills/workflow-studio/scripts/extract-shared.js` 按括号配对整段切出（`--src renderer/app.js --out renderer/cardsys.js --fn …`），不要手改内部。
- 宿主适配器（缺一个就静默失效）：`flow()` 返回 `{nodes, edges}`（本宿主的边只保留两端）、`find()`、`modsOf()`、`implOf()`、`nodeSig()`、`saveStore()`、`openCard()`、`chatAsk()`、`markSel()`、`unplugDrag()`、`findDock()`（恒 null）、`startLink()`（覆盖成只读提示）。
- `dragCard` 松手处加 `n.manual = true`；宿主的 `layout()` 只在 `!c.manual` 时算坐标。
- 只读宿主没有的交互（插槽接入、`✦ 下一步`、`↗ 连线`）保留按钮但换成一句提示，不改共享代码。

### 抽取这类代码时的四个坑

1. **同名全局声明会让整个宿主脚本不解析。** 共享脚本用 `function findDock()`、宿主用 `const findDock = () =>…` 时，经典 `<script>` 同一全局作用域直接 SyntaxError，症状是宿主里每个函数都「is not defined」，而共享脚本的函数却存在——看到这种不对称先查重复声明，别怀疑加载顺序。宿主侧一律用函数声明覆盖。
2. **模板切片要按区内末尾标记取最后一次出现。** `src.index('b.innerHTML = `')` 会抓到另一个函数的同款语句，切出的块跨越两个函数；用 `rindex(..., 0, 结束标记下标)`。切完立刻 `node --check`。
3. **搬来的模板里指向源作用域的表达式要删干净。** `${n.preview ? …}`、`${n.preview.at}` 这类在宿主里没有 `n`，渲染时抛 `ReferenceError: n is not defined`，面板只是打不开、不报在控制台——把整行/整段删掉，别改成 `n.` → `card.` 就以为完了。
4. **卡片复制了，宿主还会缺 handler 依赖。** 源 `nodeEl` 的 `pointerdown` 调 `markSel()`，拖插槽调 `unplugDrag()`；宿主没定义就抛错在事件里，表现为「拖不动」。先把 handler 里调到的名字全列一遍、逐个补 stub，再测拖动。

- 合成双击要发两轮 `Input.dispatchMouseEvent`：先 `clickCount:1` 的 pressed+released，再 `clickCount:2` 的 pressed+released；只发一次 `clickCount:2` 不会产生 dblclick。
- 坐标必须落在**可见**元素上：卡片在视口外时 rect 为负，事件落到别处——文档级 dblclick 计数会加，卡片自己的处理器却不触发，看着像「双击没绑」。先把视野复位（缩放复位或滚进视口）再点；用文档级计数器区分「没点到」与「处理器没绑」，别急着改产品代码。

截图必须亲眼检查关键文字、卡片和浮层的交集；数据正确不代表可见。解析或布局改变后重取对应证据，不沿用旧截图。

## 「确定工作流」：复制一份可编辑的，原图退成只读参考

- 入口在实时画布顶栏（「解析链路」右边）。点击 → `live.js` 把 doc 深拷贝后 `tcflow.liveConfirm()` → 主进程转发 `live:confirm-to-app` 给主窗口。
- 主窗口 `adoptLiveFlow(doc)`：新建一条工作流（名字加 ` · 已确定`，`nodes` 全部标 `manual:true` 保留解析时的位置，`fromLive` 记住来源岗位/会话），入 store、落 localStorage、选中它。
- 分屏是**上下**、不是左右（用户明确纠正过「横向分开」）：`.canvaswrap` 加 `split` 类后，上半 `#liveView` 只读参考、下半 `#wrap` 可编辑；`.liveview{top:0;bottom:50%}`、`#wrap{inset:50% 0 0 0}`，zoombar 留在下半的右下角（`bottom:14px`）。
- 只读靠三层：`#canvas.ro .node{pointer-events:none}`（禁拖动/双击）、`openCard` 直接 return、⌘Z/⌘S/Delete 在 `readOnly` 时短路，`persist()` 也不写。
- **fitView 必须在分屏之后、下一帧再跑**：分屏前 `#wrap` 还是 `display:none`、尺寸为 0，先算会把缩放压到下限、可编辑那半看着是空的。半个画布更矮，`fitView(true, 0.2)` 允许比 0.3 更小，才能一眼看全。
- 退出分屏：点右栏任意别的（或同一条已确定）工作流走 `exitLive()` → 去掉 `split` 并把 webview 的只读解除；重新进实时视图会恢复可编辑的解析视图。

### 编辑工作流（原「确定工作流」）与 AI 通用化

- 实时画布那颗按钮叫**「编辑工作流」**：点了才把解析结果复制成一条正式工作流（名字用原名、`round=1`），并进入上下分屏。
- 下半区顶部有操作条 `.splitbar`（只在 `.canvaswrap.live.split` 时显示）：
  - **保留工作流**＝`saveStore()`：落 localStorage、推版本、写共享状态文件，状态栏回报时间。
  - **AI 通用化**＝把「这一类活儿的做法」写进卡片，而不是这一次的具体实例。
- 通用化的 prompt 要写死这几条：三类卡（输入/加工/输出）都要有、标题用通称、正文写做法与合格标准、加工工具写通用能力、禁止商品名/货号/人名/本机路径/一次性参数；只允许输出 JSON。
- **解析 JSON 前必须先 `agentAnswer(r.text)`**：`hermes -p <profile> chat -q` 的 stdout 会先回显 `Query: <提问原文>`，而提问里就带着 JSON 模板——直接取第一个 `{` 会解析到回显里的模板而不是答案；尾巴还有 `Resume this session with …` 会话块。
- 应用结果时按 `id` 合并：老卡沿用 id 保留位置与历史，新卡用 `uid()` 新建，返回里没有的卡删掉；连线只留两端都存在的，若给不出连线就按 in→proc→out 顺序兜底串起来；最后 `layoutChain → render → fitView(true, 0.2) → saveStore()`（生成一版可回滚的版本）。
- 失败一律不动原图：解析失败、无卡、抛错都只在下半区状态条回一句，画布保持原样。

### 编辑态：描述收起、参考框在下（用户口径）

- 进入「编辑工作流」的分屏后，卡片**不再显示原来的描述**：`#canvas.editing .node .body{display:none}`。
- 每张卡底部常驻一个 `.note` 文本框（默认 `display:none`，编辑态才显示，靠类切换而不重建节点）：人在这里写「这张卡要写清什么」的参考。
  输入即写 `n.note` 并 `saveLocal()`；不要把它纳入 `nodeSig`，否则每敲一个字就整卡重建、光标丢。
- 点「保留工作流」＝把每张卡的 `note` 挪到 `body`（描述回到卡片上方，和读取链路得到的卡一致）、清空 `note`、退出编辑态；
  按钮随即变成「继续编辑」可以再进。一个字的参考都没有也不报错，只提示已保留。
- 编辑态点「AI 通用化」：结果写进每张卡的 `note`（供人再看一遍），不动 `body`；再点保留才上移成描述。
- 按钮文案与状态条都要跟着模式走，否则用户分不清「保留」是存盘还是定稿。

### 列表分组 与 编辑画布自己的撤销

- 右栏分两组：`#liveSlot`（「实时 · 正在跑」）只放实时入口，`#wfList`（「历史工作流」）放已存工作流；样式用 `.side .gh` 小标题 + 虚线分隔。
- 编辑副本建立时打 `pendingLive: true`，`renderWorkflowList` 跳过它——**点「保留工作流」才转正**、出现在历史组；没保留就退出实时视图（`exitLive`）会把这些草稿清掉。
- 撤销属于编辑画布：`editHist{undo,redo,last}` 存整份 `{name,nodes,edges}` 快照，`saveStore()` 里发现内容变了就压一版；⌘Z / ⇧⌘Z / ⌘Y 只在 `editMode` 且焦点不在输入框时接管；按钮在下半区操作条（`#splitUndo/#splitRedo`），不可用时置灰。
- **撤销恢复快照时不要再跑 `layoutChain`**：快照里已带坐标，自动排版会把卡挪走（实测撤销后卡片跑到画外）。只要 `render → fitView`。
- 实时那半边进入只读后，它自己的撤销/重做/保存按钮用 CSS 藏掉（`body.ro #lundo…`），避免用户以为还能在参考区改。

### 保留＝定稿：名字带版本号 + AI 只补内容

- 建副本时不改名字（`round = 1`）；点「保留工作流」才把名字写成 `基名 · v{round}`、`round++`，下次保留自然变 v2。**不要用「已确定」这种后缀**，用户要的是版本号。列表副标题显示 `vN · N 卡 · 执行方`。
- **「AI 补全」严格按现有结构**：卡片集合/顺序/连线一律不动（提示词里把所有 id 列出来，要求原样返回）；`applyGenerated` 只更新命中的 id，AI 没返回的卡原样保留，不新建也不删除卡，连线不采纳返回里的。
- 元素上限：**输出卡、输入卡只能在原有条目里改写措辞，不允许新增**（新名字一律丢掉）；**只有加工卡可以补工具/模型**（`proc` 分支合并新条目）。验收就看输出卡 mods 数量前后一致、加工卡可以变大。
- 名称由 AI 给通用名（去掉任何 ` · vN` 尾巴），版本号仍由「保留」那一步加。

### 历史工作流也能进同一套编辑（参考在上、编辑在下）

- 右栏每条工作流多了 `✎`：`editHistoryFlow(id)` 把**这一版**做成只读快照，`enterSplitRef(snapshot)` 进上下分屏——上面是参考、下面是同一条工作流的可编辑态（改完 `保留` 直接升级这一条，不产生副本）。
- 参考视图复用实时那块的 `<webview>`：`live.html?mode=ref`，`live.js` 里 `REF = /mode=ref/` 时只做 `bindCanvas` + 等 `ref:doc`，渲染后 `setReadOnly(true)`；给 `body` 加 `refmode` 把解析/跟随/撤销这些控件全部藏掉，品牌改成「参考 · 只读」。
- 主进程侧不需要新通道：`preload.js` 增 `onRefDoc`（监听 `ref:doc`），`app.js` 用 `wv.send('ref:doc', snapshot)` 把快照灌进去即可。
- 参考里的卡片 `openCard` 在 REF 模式走 `showRefPreview`：弹出只读预览（类型、标题、描述、元素、内部实现），不打开编辑面板。
- 从实时分屏切到历史编辑（或反过来）时，注意先把 webview 的 `src` 指回 `live.html`，否则会一直停在参考视图。
- **AI 补全不看旧描述**：提示词只给「类型 / 标题 / 工具元素 / 我的要求 / 在链路里的位置」，明确要求重新写描述；旧 `body` 不出现在 brief 里。
