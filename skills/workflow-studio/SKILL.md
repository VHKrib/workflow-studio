---
name: workflow-studio
description: Use when changing the TC 工作流台 Electron app (画布/卡片/agent 集成/开源维护). 提供结构、验证方法与改法。
---

# TC 工作流台 · 开发手册

## 何时用

改 `<REPO>` 的任何东西：界面、卡片模型、agent 调用、导入导出、开源文件。

## 启动与验证（每次改完都要做）

```bash
cd <REPO>
node --check renderer/app.js && node --check main.js      # 语法
pkill -f "工作流台/node_modules/electron"; sleep 1       # 关旧实例
./node_modules/.bin/electron . --remote-debugging-port=9222 &   # 起新实例
sleep 6
node tools/shot.js                                        # 存 preview.png（CDP 截图）
node tools/eval.js "document.querySelectorAll('.node').length"   # 无头查 DOM
```

交付时给：改了哪些文件（字节）+ 上面命令的真实输出 + preview.png 路径。

## 三层结构（不要混）

| 层 | 文件 | 能做什么 |
|---|---|---|
| 主进程 | `main.js` | 开窗、读 `~/.hermes/profiles`、调 `hermes -p X chat -q`、文件对话框 |
| 桥 | `preload.js` | 只暴露 `listAgents / askAgent / saveFlow / openFlow` |
| 渲染 | `renderer/*` | 全部 UI 与状态；**不直接 require**，只走 `window.tcflow` |

改 IPC 要三处同步：`main.js` 的 `ipcMain.handle` → `preload.js` 的 contextBridge → 前端调用。

## 状态模型

```js
store = { workflows: [ { id, name, agent, nodes: [], edges: [] } ], current: workflowId }
node  = { id, kind: 'in'|'proc'|'out', title, body, checks: [], x, y, status }
edge  = [fromId, toId]
```

- 持久化：`localStorage['tcflow.v3']`（改结构就升版本号，别复用旧 key）
- 顺序：`chainOrder(w)` 从无入边节点做 DFS，面板与运行弹层都用它
- 画布：`#canvas` 上 `transform: scale(zoom)`；平移靠 `#wrap` 的 scrollLeft/Top；
  节点坐标用「设计像素」，屏幕位移要除以 `zoom`

## 三条交互不变量

1 **空白处拖动＝平移画板**，卡片区域拖动＝移动卡片（`e.target.closest('.node')` 分流）
2 **右键按住 180ms 出转盘**，松手执行、回中心取消；空格也能调出
3 **卡片三个动作**：`? 问`（单卡评审）、`✦ 下一步`（agent 给候选卡）、`↗ 连线`（拖到另一张卡）

## agent 集成

```js
const r = await window.tcflow.askAgent({ profile: flow.agent, prompt });   // 只读，不执行
```

「✦ 下一步」协议：要求 agent **只输出 JSON 数组**
`[{"kind":"proc","title":"…","body":"…"}]`；
`parseOptions()` 先 JSON 后按行兜底。**改协议必须同时改提示词与解析器**。

## 视觉规范（不要自创）

取自 `项目工作台/tokens.css`：奶油纸 `#f5f3ef`、墨 `#111`、橘 `#ff5a1f`、白卡 `#fffefa`、
圆角 18 / 10、阴影 `--shadow-1`。卡片三色：输入 `#2f6f95`、加工 `#ff5a1f`、输出 `#2f7d5b`，
色带做在卡片头部（整条），不要在卡片里再堆色块。

## 常见坑

- 改完不重启等于没改：Electron 主进程代码不会热加载。
- 节点宽度变了要同步 `chainOrder` 之外的两处：连线的 `x1` 偏移、插入按钮定位。
- 截图前先 `pkill` 旧实例，否则 `9222` 端口连到旧进程，看到的还是上一版。
- 不要把 `localStorage` 里的旧 schema 直接读进新代码；升 key 版本。

## 开源

仓库根有 `README.md` / `LICENSE(MIT)` / `.gitignore`。提交前跑：

```bash
git status --short && git diff --stat
```

不要提交 `node_modules/`、`preview.png`、任何 `.env` 或含密钥的文件。
