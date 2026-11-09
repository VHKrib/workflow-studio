# 跨平台（macOS / Windows / Linux）

Electron 本身三平台都跑；这个应用没有原生模块、路径全走 `os.homedir()`/`path.join`、快捷键判 `metaKey || ctrlKey`、`window-all-closed` 已按 `darwin` 分支，所以同一份源码可以直接上 Windows/Linux。

## 唯一出口：仓库根 `platform.js`

- `hermesBin({platform, home, exists})` → `{ cmd, shell }`
  - mac/linux：`~/.hermes/hermes-agent/.hermes/bin/hermes`；
  - Windows：依次试 `hermes.cmd` / `.exe` / `.bat`，都没有就退回命令名 `hermes.cmd`；
  - **Windows 上 `.cmd/.bat` 必须 `shell: true`**（`execFile` 与 `spawn` 都不认批处理），其它平台保持 `false`。
- `hermesMissing()` 只在 `cmd` 含路径分隔符（`/[\\/]/`）时才 `existsSync`；纯命令名交给 PATH —— 否则「PATH 里有 hermes」会被误判成「入口不存在」。
- `sqliteBin()`：mac 优先 `/usr/bin/sqlite3`，Windows 查 `C:\Program Files\sqlite3\sqlite3.exe`、`C:\sqlite3\sqlite3.exe`、家目录，兜底 `sqlite3.exe`（找不到时的报错由调用方兜住）。
- `modKey(platform)`：`darwin → '⌘'`，其它 `→ 'Ctrl+'`。

## 渲染层文案

- 源码里照旧写 `⌘Z`；`app.js` 与 `live.js` 各有一份 `IS_MAC / KEYMOD / localizeKeys()`，启动时把 `[title*="⌘"]` 里的 `⇧⌘`、`⌘` 换成 `Shift+Ctrl+`、`Ctrl+`，mac 上原样返回。
- 新写的提示/toast 用 `KEYMOD` 拼，别再把 `⌘` 写进字符串。

## 启动器与协议

- mac：`打开工作流开发平台.command`；Windows：`打开工作流开发平台.bat`（`cd /d "%~dp0"`、`node_modules` 不存在才 `npm install`、失败提示 Node 18+、`chcp 65001`）；Linux：`npm start`。
- `workflow-studio://` 在 mac/Windows 可登记；Linux 开发态没有 `.desktop`，`registerProtocol()` 直接跳过并打一行说明，别刷失败日志。
- 开发态取调试口仍要走启动脚本，裸 Electron 不带 9222。

## 测试与冒烟

- `node tools/test-platform.js`（或 `npm run test:platform`）：纯 Node 断言 mac/linux/win32 三套解析结果，不启 Electron。
- **夹具用中性路径**（`/home/demo`、`C:\demo`）：`tools/scan-public.js` 按字面 `/Users/`、部门名等命中，拿 `'/Users/x'` 当夹具会让公开扫描冒出假命中。
- 改完在 mac 上重启一次用户实例做冒烟：agent 列表能读到（证明 hermes 桥接没坏）、编辑分屏与实时视图能进、控制台无异常、`[title*=⌘]` 仍是 `⌘`。
- 真实 Windows/Linux 机器不在本机，只有单测覆盖；对外说「支持三平台」时要讲清这一点，需要时再补真机验证或 electron-builder 打包。
