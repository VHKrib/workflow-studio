# Workflow Studio · 工作流台

> A desktop canvas for composing agent workflows out of **input / process / output** cards.
> One workflow = one canvas. One agent per workflow. Cards can ask the agent for the next step and add it with one click.

![screenshot](docs/screenshot.png)

Electron + vanilla JS. No bundler, no framework, no database. `npm install && npm start`.

---

## Why

Most "agent workflow" tools are forms with a run button. This one starts from the way the work
actually flows: **a card is a thing that goes in, a thing that happens, or a thing that comes out.**
You lay the cards out, draw the arrows, and assign one agent to the whole board.

Three ideas it is built around:

1. **Cards are typed** — input (blue), process (orange), output (green). Colour is not decoration:
   it tells you at a glance whether a stage consumes, transforms, or produces.
2. **Assignment is per workflow, not per node.** One board, one owner. No "which agent runs step 4".
3. **The agent is a collaborator, not a black box.** Every card can ask it a question; every card can
   ask it *"what comes next?"* and get 2–4 candidate cards back — click one and it is added and wired in.

## Features

- **Pan & zoom canvas** — drag empty space to pan, `⌘/Ctrl` + wheel or the ± control to zoom.
- **Three card types** with coloured header bands, inline editing, per-card checks (`sha256`, `schema`, …).
- **Drag-to-connect** — hit `↗ 连线` on a card and drop it on another to create an edge.
- **Workflow-level agent assignment** — top bar pill, right panel select, and the run dialog all set the same field.
- **Ask the agent** — `? 问` on any card (single-card review) or *"let the agent read the whole flow"* (chain review).
- **Suggest next step** — `✦ 下一步` asks the agent for candidate cards as strict JSON; picking one
  creates the card and connects it automatically.
- **Per-card validation pass** — walks the chain in edge order and marks each card `ok` / `needs work`.
- **Multiple canvases** — left sidebar lists workflows; each has its own cards, edges and agent; export/import as JSON.
- **Radial menu** — press and hold right mouse button (or `Space`) for add / ask / duplicate / delete / validate / run.

## Quickstart

```bash
git clone <this repo> workflow-studio
cd workflow-studio
npm install
npm start
```

Requires Node 18+ and the [Hermes Agent CLI](https://hermes-agent.nousresearch.com/docs) on `PATH`
if you want the agent features. Without it the app still runs as a pure canvas.

### How the agent bridge works

The renderer never touches a shell. It calls three IPC channels exposed by `preload.js`:

| Channel | Purpose |
|---|---|
| `agents:list` | scan `~/.hermes/profiles/*/profile.yaml` for available agents |
| `agent:ask` | `hermes -p <profile> chat -q "<prompt>"` — **read-only Q&A, never executes tools** |
| `flow:save` / `flow:open` | export / import a workflow as JSON |

Because questions are one-shot `chat -q` calls with an explicit *"do not execute, do not write files,
do not spend money"* instruction, wiring this to a real production agent is a deliberate separate step.

### The "next step" protocol

Ask for cards, get strict JSON:

```json
[{ "kind": "proc", "title": "短标题", "body": "这张卡要什么 / 做什么 / 产出什么" }]
```

`kind` is `in` | `proc` | `out`. The parser (`parseOptions` in `renderer/app.js`) tries JSON first, then
falls back to line parsing, so a chatty model still produces something usable.

## Data model

```js
store = { workflows: [{ id, name, agent, nodes: [], edges: [] }], current: workflowId }
node  = { id, kind: 'in'|'proc'|'out', title, body, checks: [], x, y, status }
edge  = [fromId, toId]
```

Persisted to `localStorage['tcflow.v3']`. Execution order is derived (`chainOrder`): a DFS from every
node with no incoming edge. Nothing is stored server-side; export the JSON if you want it in git.

## Project layout

```
main.js            Electron main: window, agent list, chat -q bridge, file dialogs
preload.js         contextBridge -> window.tcflow
renderer/
  index.html       top bar, canvas, side panel, run dialog, radial menu
  app.js           state, card render, edges, pan/zoom, radial menu, option parsing
  style.css        design tokens (paper #f5f3ef / ink #111 / orange #ff5a1f)
tools/shot.js      CDP screenshot helper (needs --remote-debugging-port=9222)
tools/eval.js      CDP evaluate helper (headless DOM assertions)
skills/            workflow-studio: development handbook for agent contributors
```

## Design notes

The palette and radius come from the same design tokens as the rest of the TC tool suite
(cream paper, near-black ink, one orange accent). Cards use three semantic colours on the header band
only — the body stays paper-white so text keeps contrast. Nothing animates on hover except a 1px border
and a soft ring; the canvas itself is a dot grid at 22px.

## Roadmap

- [ ] real execution: run a card against a tool, with an approval gate per paid action
- [ ] workflow-level checks (schema between cards, not just per card)
- [ ] import/export of a library of reusable cards
- [ ] optional HTTP transport instead of CLI for the agent bridge

## 中文说明

把业务链路画成卡片：**输入（蓝）→ 加工（橙）→ 输出（绿）**，一张卡一个环节，箭头连成流程。
一条工作流只指派一个 agent；任何卡片都能问 agent，也能让它给「下一步」候选卡，点一下自动加卡并连线。
界面：空白处拖动＝平移画板，`⌘`+滚轮＝缩放，右键按住＝转盘菜单。

## License

MIT — see [LICENSE](LICENSE).
