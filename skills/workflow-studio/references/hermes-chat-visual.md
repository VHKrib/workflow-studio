# 把 Hermes 的对话视觉搬到本应用（无 React / 无构建）

用户说「跟 Hermes 一样」时，**去读 Hermes 的源码取真值，不要凭印象调 CSS**。

## 值从哪来

- 用户跑的是**打包版** Hermes（`~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app`）。
  打包版**不开 CDP**，`inspecting-hermes-desktop-dom` 那套连不上；也别拿 9222 去撞——那个端口现在是
  工作流台自己，探到的会是本公司页面。
- 直接读源码目录 `~/.hermes/hermes-agent/apps/desktop/`：

| 文件 | 拿什么 |
|---|---|
| `src/styles.css` | 设计 token：`--conversation-tool-base-size: 0.6875rem`、`--conversation-base-line-height: 1.125rem`、`--conversation-scaffold-text: color-mix(in srgb, var(--ui-base) 64%, transparent)`、`--conversation-scaffold-meta: … 44% …`、`--ui-text-tertiary: … 54% …` |
| `src/components/chat/scaffold-row.tsx` | 脚手架行（工具/思考标题）的语义与字号、右边距规则 |
| `src/components/chat/disclosure-row.tsx` | 折叠行交互：无前置箭头、**hover 才出 caret**、hover 底色是贴合文字的小 pill |
| `src/components/assistant-ui/thread/message-parts.tsx` | `ThinkingDisclosure` / `ReasoningAccordionGroup`：思考标签「Thought for 5s」、正文 `text-xs leading-snug muted/85` |
| `src/components/assistant-ui/thread/user-message-text.tsx` | 行内 `code` = `rounded bg-current/8 mono 0.92em`；代码块 = `rounded-md border stroke-tertiary bg-current/5 mono 0.86em` |

## 搬运规则（只用数值与结构，不搬 React）

- 不要引入 React/Tailwind，也不要复制编译后的 CSS（preflight 会打乱本应用的样式）。把 token 翻成现有变量：
  Hermes 的 `color-mix(in srgb, var(--ui-base) 64%, transparent)` ≈ 这里的
  `color-mix(in srgb, var(--ink) 64%, transparent)`。
- **助手消息没有气泡**（纯文本块）；只有用户消息是右侧浅底气泡（`color-mix(ink 7%)`）。
- **工具行一行一步**：状态点（running 呼吸 / done 绿 / error 红）+ 名称 + 右对齐耗时；点开看参数/结果。
  不要做成彩色小胶囊。
- **思考块 `<details open>` 默认展开**（用户点名要看得见思考过程），summary 写「思考 16s · 6095 字」，
  正文 11.5px、68% 前景色、左侧 1px 细线缩进。
- 回答 > 900 字折叠「展开全文（N 字）」，正文 `overflow-wrap:anywhere`。
- agent 选择器用无边框 `<select>` + CSS 小三角 + hover 6% 底；原生白框套橘色胶囊被点名嫌丑。

## 对话区密度（用户点名嫌过「有点挤」）

不要用紧凑值。当前落定的一套（可直接照查）：

| 项 | 值 |
|---|---|
| dock 尺寸 | 392×480（`right:14;bottom:52`） |
| 消息间距（`gap`） | 18px（卡片对话 `.chat-log` 同值） |
| 正文 | 13px / line-height 1.72 |
| 用户气泡 | padding 9px 13px，圆角 16，底色 `color-mix(ink 7%)` |
| 工具行 | 11.5px / 22px 行高，状态点 + 名称 + 右对齐耗时 |
| 思考行 summary | 11.5px / 22px，hover 才亮、caret 在右 |
| 思考正文 | 11.5px / 1.6、68% 前景色、左 1px 细线 + 12px 缩进，`max-height:190px` |
| markdown 段落空行 | 10px |
| 长回答折叠阀 | 900 字（前 600 字展示 + 「展开全文（N 字）」） |

加新内容时先加空白、再考虑压字号；改完用 DOM 量 `gap / lineHeight / fontSize / dock 宽度` 四值确认。

## 两个容易搞混的点

- 「视觉跟 Hermes 一样」与「拿到 Hermes 的那份数据」是两件事：真流式走 `--format stream-json`，里面
  **没有思考正文**；思考只在 `--format text` 里。用 `USE_STREAM` 二选一，别承诺两者同时有。
- 流式采样时前 10 秒 `text` 长度一直是 0 是正常的：模型先跑工具，工具结束才开始吐字。看到
  `len:0 / steps:0` 不要判「流式没生效」，等 `tool_use` 或首个 `text` 事件再计时。
