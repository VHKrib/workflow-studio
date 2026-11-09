# Use your workflows from other agents

Workflow Studio keeps every workflow on disk as plain JSON. Two thin adapters expose that to other tools:

| Adapter | Speaks | Use it from |
|---|---|---|
| `mcp/workflow-studio.js` | MCP over stdio | Claude Code, Codex, OpenClaw, or any MCP client |
| `tools/workflow-cli.js` | plain stdout / JSON | scripts, cron jobs, agents that only have a terminal |

Both are read-only and dependency-free (`node` only). Neither needs the app to be running.

## What you get

| Tool | Returns |
|---|---|
| `list_workflows` | every workflow: id, name, current version, executor, card/edge counts, last change |
| `get_workflow` | one workflow in full: cards (kind, title, plain body, internal wiring, modules) and edges resolved to `A -> B` |
| `get_versions` | kept versions (newest first: number, time, who, what changed); pass `v` for that version's snapshot |

Lookups accept an id, an exact name, or part of a name — `get_workflow("隔板")` is fine.

## Setup

### Claude Code

```bash
claude mcp add workflow-studio -- node /absolute/path/to/workflow-studio/mcp/workflow-studio.js
claude mcp list          # should show workflow-studio connected
```

Then ask: *"list my workflows and get the newest one"*.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.workflow-studio]
command = "node"
args = ["/absolute/path/to/workflow-studio/mcp/workflow-studio.js"]
```

### OpenClaw

```bash
openclaw mcp add workflow-studio --command node --arg /absolute/path/to/workflow-studio/mcp/workflow-studio.js
openclaw mcp list
```

(OpenClaw probes the server before saving. If its own gateway config is invalid, `openclaw doctor --fix` first.)

### Anything else

Anything that can spawn a process can use the CLI:

```bash
node tools/workflow-cli.js list
node tools/workflow-cli.js show "part of a name"
node tools/workflow-cli.js versions "part of a name" --v 3 --json
```

## Where the data comes from

| Platform | Data directory |
|---|---|
| macOS | `~/Library/Application Support/workflow-studio` |
| Windows | `%APPDATA%\workflow-studio` |
| Linux | `$XDG_CONFIG_HOME/workflow-studio` (or `~/.config/workflow-studio`) |

Inside it: `links/<id>.json` (current state) and `versions/<id>.json` (newest 20 snapshots). Set `WF_HOME` to
point the adapter at another directory — an isolated instance, a copy, or a test fixture.

## Why read-only

The canvas is the only writer. It writes atomically (temp file + rename), and if something else edits a state
file it only adopts the change when the version number is higher. Exposing writes through MCP would let two
agents race on the same workflow with no way for the canvas to arbitrate, so the adapter deliberately stops at
reading. Writing back is a separate design (version bump + conflict rules), not a flag.
