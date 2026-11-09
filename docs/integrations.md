# Use your workflows from other agents

Workflow Studio keeps every workflow on disk as plain JSON. Two thin adapters expose that to other tools:

| Adapter | Speaks | Use it from |
|---|---|---|
| `mcp/workflow-studio.js` | MCP over stdio | Claude Code, Codex, OpenClaw, or any MCP client |
| `tools/workflow-cli.js` | plain stdout / JSON | scripts, cron jobs, agents that only have a terminal |

Both are dependency-free (`node` only) and neither needs the app to be running. The MCP server can read and
write; add `--read-only` when you only want the reading half.

## What you get

| Tool | Returns |
|---|---|
| `list_workflows` | every workflow: id, name, current version, executor, card/edge counts, last change |
| `get_workflow` | one workflow in full: cards (kind, title, plain body, internal wiring, modules) and edges resolved to `A -> B` |
| `get_versions` | kept versions (newest first: number, time, who, what changed); pass `v` for that version's snapshot |
| `save_workflow` | replace cards/edges (or name/executor) and record a new version — needs `expected_version` |
| `update_card` | change one card's title / body / internal wiring / modules and record a new version |
| `rollback_workflow` | restore a kept version and record the rollback as a new version |

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

## How writing works

The canvas is the only primary writer; this adapter follows the same rules so the two can coexist:

- **Optimistic concurrency.** Every write takes `expected_version` — the version you just read. If the workflow
  moved on (the app, another agent, a person), the write is refused, nothing changes, and the reply carries the
  current version so you can re-read and retry.
- **A write is a version.** Cards, edges and the new snapshot are written atomically (temp file + rename), the
  version number goes up by one, and a version entry lands in the history — so anything an agent writes can be
  rolled back in the app, and shows up as "changed via MCP".
- **Validation before writing.** Cards need unique ids, a kind from `in|proc|out` and a title; edges must point
  at existing cards and cannot self-loop. A refused write leaves the file byte-identical.
- **One writer at a time.** A lock file (`<data>/.locks/<id>.lock`) serialises concurrent writers; a second
  writer waits up to two seconds and then reports the conflict instead of interleaving.
- **The newest 20 versions are kept**, same window as the app.

Pass `--read-only` when starting the server to publish the three read tools only — useful when you want an
agent to look without ever touching the workflows.
