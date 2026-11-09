# Workflow Studio

**Parallel workflow development for a one-person company.**
Run a team of agents on [Hermes Agent](https://hermes-agent.nousresearch.com/docs); Workflow Studio is the
board where several of their workflows are drawn, edited and rolled back — live, while the work is running.

![screenshot](docs/screenshot.png)

Electron + vanilla JS. No bundler, no framework, no database. `npm install && npm start`.

[中文说明](README.zh-CN.md)

---

## What it is

Work rarely arrives one workflow at a time. A solo operator runs several lanes at once: research, capture,
production, publishing — each with its own agent, each changing while it runs.

Workflow Studio treats a workflow as a **living document**:

- **A workflow is a canvas of typed cards.** Each card is an input, a process step, or an output.
  Cards carry plain language; the commands, paths and field names go into the card's internal wiring.
- **Several workflows live side by side.** Every workflow has its own cards, edges and executing agent;
  switching between them is one click, copying one gives you an independent copy to experiment on.
- **Editing is hot.** Change a card while the workflow is in use — the canvas, the shared state file and
  the agent's next turn all see the new version immediately. No export, no rebuild, no restart.
- **Rolling back is hot.** Every complete change becomes a version (last 20 kept). One click restores the
  whole workflow — cards, edges, modules, wording, internal wiring, executor. The rollback is itself a
  version, so you can roll forward again. A run that is still going is stopped when you roll back, so it
  never continues on a chain that no longer exists.
- **Workflows can be read off a running agent.** Point it at one of your agents and it inspects that
  agent's own notes, skills and recent work records (read-only), then draws the chain it finds as cards
  you can accept into a new workflow.
- **Nothing is written behind your back.** Agent proposals arrive as candidate cards and land only after
  you press *confirm*. The board is yours; the agent suggests.

## Why it's shaped this way

1. **Cards are typed** — input (blue), process (orange), output (green). Colour is meaning: does this stage
   consume, transform, or produce?
2. **Assignment is per workflow, not per node.** One board, one owner. No "which agent runs step 4".
3. **The agent is a collaborator, not a black box.** Any card can ask it a question, and any card can ask
   *"what comes next?"* and get 2–4 candidate cards back.
4. **People read the card, agents read the wiring.** A card shows what goes in, what happens, what comes
   out; the executable detail lives one layer down (⚙).

## Features

- **Infinite-feel canvas** — logical origin in the middle of a 12000×8000 board, so you can pan ~6000px in
  every direction. `⌘/Ctrl` + wheel or the zoom pill zooms around the viewport centre; legend and controls
  live outside the scroll layer.
- **Cards are never trapped** — dragging is computed in canvas space, so a card follows the cursor while the
  board auto-scrolls, and releasing brings it back into view.
- **Three card types** with coloured header bands and per-card checks (`sha256`, `schema`, …).
- **Cards break down into modules** — an input card lists its materials, a process card its tools, an output
  card its results. Each module is a short plain-language chip, edited in the side panel.
- **Plug a card into a process card to connect it** — drag an input card onto the *materials* socket (or an
  output card onto *results*): the card shrinks into a token, the socket previews what will land there, and
  on release the chips fly in and the edge draws itself. A drop that would close a loop is rejected. Drag a
  chip back out to disconnect. Motion respects `prefers-reduced-motion`.
- **Cards are read-only on the canvas** — the whole card is a drag handle; a single click selects,
  double-click opens that card's info and chat in the side panel.
- **Drag-to-connect** — sockets first, or `↗ link` on any card and drop it on another.
- **Two different agents, on purpose** — each workflow picks its own executing agent; the bottom-right dock
  always talks to the platform supervisor (planning, dispatch, cross-team review, never card-level work).
- **Real streaming** — runs go through `hermes chat --format stream-json`: tool calls appear row by row
  (spinner → `✓ 0.2s`, click for arguments/result), the reply types in as it is produced, and a folded
  reasoning block stays put while the run streams. The CLI's JSON stream carries tool events and text, not
  the model's thinking; flip `USE_STREAM` off for one-shot prose.
- **Hermes-style answers** — quiet scaffold rows, a reasoning disclosure, plain text replies, bubbles only
  for your own messages, `show full text` for long answers.
- **The side panel is an agent chat** — type anything, or hit a chip (*review this card* / *next-step
  candidates* / *look at the whole chain*). Card, wiring and chain ride along as context.
- **Next-step cards need confirmation** — candidates render as buttons; clicking one expands it, and it is
  added and wired only after *confirm*.
- **Per-card validation pass** — walks the chain in edge order, marks each card `ok` / `needs work`, and
  writes the verdict into that card's chat.
- **Talk a workflow into existence** — a temporary canvas: your sentence becomes a draft input card, the
  plan grows card by card while it streams, then *save as workflow* (or throw it away).
- **Copy a workflow** — one click makes an independent copy (cards, edges, modules, wording, executor).
- **Watch a real conversation turn into a chain** — a separate read-only window follows one Hermes
  conversation: a card per request, with reads/commands folded into one plain line and the delivered file
  or answer as the output. The database is opened `sqlite3 -readonly` + `?mode=ro`, SELECT only.
- **Check before running** — a local static pass flags broken links, process cards missing an input or
  output, empty cards and split chains; a **read-only rehearsal** then asks the executor, card by card,
  what it would do — with **zero tools** (no commands, no writes, no messages, no publishing, no spending).
- **Radial menu** — press and hold right mouse button (or `Space`) for add / ask / duplicate / delete /
  validate / run.

## Read an agent's work chain

The top bar has **read agent chain**. Pick one of the agents installed on this machine and it:

1. reads that agent's own description, its installed skills and its recent work records — read-only,
   never credentials, never login data;
2. hands that material to the supervisor agent, which draws the work it keeps repeating as a three-part
   chain: **inputs** (what it receives and from whom), **process** (how it does it — which skill, how it
   picks, compares, revises), **outputs** (what it hands over, to whom);
3. streams the cards in as they are produced (usually tens of seconds to a few minutes).

Press **put on canvas** and it becomes a new workflow: named after the work, executor preset to that agent,
cards laid out input → process → output with the edges already drawn. *Retry* recomputes; switching agents
mid-run really stops the previous run; nothing is written to the agent's records.

![read window](docs/read.png)

## Versions and rollback

Every complete change leaves a version — typing in a burst counts once, a nudge of position does not count
at all. The newest 20 are kept.

The version list sits at the bottom of the overview panel: version number, time, which card and which part
changed, and whether a person or an agent proposal made it. Click a row and the whole workflow goes back —
cards, edges, modules, body, internal wiring, executor. The rollback is recorded as a new version, so the
later versions are still there and you can return to them.

If a run is in flight when you roll back, it is stopped — it will not keep working on a chain that has been
superseded. The next agent turn starts with "current chain version vN; it was rolled back to vX at HH:MM".

![versions](docs/versions.png)

## Checks before you run

- **Static pass** (local, no model): broken links, process cards missing an input or output, empty cards,
  chains split in two, loops — each item naming the card and how to fix it.
- **Read-only rehearsal**: the executor walks the cards in order and says, per card, what it would do and
  what it is missing. It has **no tools at all** — cannot run commands, read/write files, send messages,
  publish or spend. Results are written back onto the cards and can be cleared in one click.

## Quickstart

```bash
git clone https://github.com/VHKrib/workflow-studio.git
cd workflow-studio
npm install
npm start
```

Requires Node 18+. The agent features need the [Hermes Agent CLI](https://hermes-agent.nousresearch.com/docs)
on `PATH`; without it the app still runs as a pure canvas.

### macOS / Windows / Linux

Electron is cross-platform and this app has no native modules, so the same source runs on all three.

| | how to start |
|---|---|
| macOS | double-click `open-workflow-studio.command`, or `npm start` |
| Windows | double-click `open-workflow-studio.bat` (installs deps on first run), or `npm start` |
| Linux | `npm start` |

Platform differences are resolved in `platform.js` and covered by `npm run test:platform`:

- the Hermes CLI path (`.../bin/hermes` on macOS/Linux, `hermes.cmd` on Windows — spawned through a shell);
- `sqlite3` lookup (`/usr/bin/sqlite3` when present, `sqlite3.exe` or a common install path on Windows);
- shortcut labels — `⌘Z` on macOS, `Ctrl+Z` elsewhere;
- the `workflow-studio://` protocol is registered on macOS/Windows; on Linux it applies once packaged.

### Packaging

`npm i && npm start` stays the default path — packaging is opt-in and downloads `electron-builder` on
demand (`npx`), so the dependency list stays one package.

```bash
npm run dist:mac     # -> dist/*.dmg
npm run dist:win     # -> dist/*.exe (NSIS installer; build it on Windows)
npm run dist:linux   # -> dist/*.AppImage
```

Output goes to `dist/` (git-ignored); config lives in `package.json` under `build`. Builds are unsigned by
default — add signing credentials via the usual electron-builder env vars (`CSC_LINK`,
`CSC_KEY_PASSWORD`, `WIN_CSC_LINK`). The icon falls back to Electron's until you add `build/icon.icns`
(macOS) or `build/icon.ico` (Windows).

## How the agent bridge works

The renderer never touches a shell. It talks to the main process through `preload.js`:

| Channel | Purpose |
|---|---|
| `agents:list` | scan `~/.hermes/profiles/*/profile.yaml` for available agents |
| `agent:ask` | `hermes -p <profile> chat -q "<prompt>"` — one-shot, **read-only Q&A, never executes tools** |
| `agent:stream` / `agent:cancel` | streaming run (`--format stream-json`), event by event; cancel really kills the child |
| `agent:chain` | read-only scan of one agent's own records (`state.db` opened `?mode=ro`) |
| `link:read` / `link:write` / `link:drop` | the shared per-workflow state file (`<userData>/links/<id>.json`, atomic write) |
| `version:list` / `version:push` / `version:drop` | snapshots for the last 20 versions and rollback |
| `flow:save` / `flow:open` | export / import a workflow as JSON |

Because questions are one-shot `chat -q` calls with an explicit *"do not execute, do not write files, do not
spend money"* instruction, wiring this to a production agent stays a deliberate separate step.

## Cards speak plain language; code stays inside

| Layer | Field | What goes there | Shown on the canvas? |
|---|---|---|---|
| plain language | `body` | which images, which data → what transformation → what file comes out and what is in it; no commands, paths, field names | **yes** |
| internal wiring | `impl` | the actual commands, scripts, paths, field names | no — only the ⚙ panel and the agent |

Enforced in three places: the **prompt** asks for plain-but-concrete wording, the **parser** (`cleanCard()`)
moves a lingering command/path sentence into `impl`, and **loading** converts old machine-ish bodies through
a legacy table. A ⚙ chip means "there is wiring behind this sentence".

## The "next step" protocol

```json
[{ "kind": "proc", "title": "short title", "body": "what goes in / what happens / what comes out",
   "impl": "what actually runs: command / script / path / fields", "mods": ["short module words"] }]
```

`kind` is `in` | `proc` | `out`; `mods` are the card's modules in plain words. The parser searches for the
**last** bracket span that parses as a card array (the CLI echoes the prompt first, and the prompt contains
an example), drops placeholder cards, and falls back to line parsing (`[process] title: body`) when a model
does not return JSON. `agentAnswer()` strips the echo and the trailing session block.

## Checks

Offline — no app, no network, no model call:

```bash
node --check renderer/app.js && node --check main.js && node --check chain.js
node skills/workflow-studio/scripts/check-plan.js        # card-splitting rules
node skills/workflow-studio/scripts/check-fixtures.js    # replay archived real answers
node tools/scan-public.js                                # public-repo hygiene scan
npm run test:platform                                    # macOS / Windows / Linux resolution
```

Against a running instance — start your own instance on its own port *and* its own data dir, then point
`CDP_PORT` at it:

```bash
./node_modules/.bin/electron . --remote-debugging-port=9333 --user-data-dir=$TMPDIR/wf-9333 &
export CDP_PORT=9333
node skills/workflow-studio/scripts/cdp-canvas.js    # pan / zoom anchor / drag / auto-scroll
node skills/workflow-studio/scripts/cdp-dock.js      # plug, reject a loop, unplug
node skills/workflow-studio/scripts/cdp-version.js   # versions, merges, keep 20, rollback
node skills/workflow-studio/scripts/cdp-edit.js      # editing inside a card is a version too
node skills/workflow-studio/scripts/cdp-live.js      # temp canvas + shared state file
node skills/workflow-studio/scripts/cdp-read.js --agent <id>
```

## Data model

```js
store = { workflows: [{ id, name, agent, nodes: [], edges: [] }], current: workflowId }
node  = { id, kind: 'in'|'proc'|'out', title, body, impl, mods: [], checks: [], chat: [], x, y, status }
mod   = { id, type: 'mat'|'tool'|'res', name }
edge  = [fromId, toId]
chat  = [{ role: 'me'|'agent', text, at, opts? }]
preview = { at, ok, secs, steps, text }   // rehearsal verdict; local only
```

Persisted to `localStorage['tcflow.v4']` (v3 boards migrate on first load). Execution order is derived
(`chainOrder`): a DFS from every node with no incoming edge. Nothing is stored server-side — export JSON if
you want it in git.

## Project layout

```
main.js            Electron main: window, agent list, chat bridge, file dialogs
platform.js        cross-platform bits: hermes CLI path, sqlite3 path, shortcut labels
preload.js         contextBridge -> window.tcflow
chain.js           read-only scan of another agent's records (profile, skills, state.db)
livefeed.js        read-only session feed: recent conversations across profiles
actmap.js          conversation actions -> chain cards (pure functions)
linkstore.js       the shared per-workflow state file
versions.js        version snapshots, newest 20 kept
renderer/          index.html / app.js / live.html / live.js / style.css / live.css
tools/             CDP helpers, platform tests, public-repo scan
docs/              screenshots and the socket animation
skills/            development handbook, CDP checks, archived fixtures
```

## Design notes

Cream paper, near-black ink, one orange accent; three semantic colours on the header band only — the body
stays paper-white so text keeps contrast. Nothing animates on hover except a 1px border and a soft ring;
motion is reserved for one moment: plugging a card into a socket. The canvas is a dot grid at 22px.

## Roadmap

- [ ] real execution: run a card against a tool, with an approval gate per paid action
- [ ] workflow-level checks (schema between cards, not just per card)
- [ ] a library of reusable cards
- [ ] optional HTTP transport instead of the CLI for the agent bridge

## License

MIT — see [LICENSE](LICENSE).
