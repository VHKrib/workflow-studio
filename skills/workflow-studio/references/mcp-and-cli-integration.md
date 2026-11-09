# Exposing workflow data to other agents (MCP server + CLI)

The product's workflows live as plain JSON on disk. Two thin adapters let tools that are *not* this app read
them, without adding a dependency or requiring the app to run.

| Adapter | Speaks | Used from |
|---|---|---|
| `mcp/workflow-studio.js` | MCP over stdio | Claude Code, Codex, OpenClaw, any MCP client |
| `tools/workflow-cli.js` | plain stdout / `--json` | scripts, cron, agents that only have a terminal |

## Data source (single source of truth)

| Platform | Directory |
|---|---|
| macOS | `~/Library/Application Support/workflow-studio` |
| Windows | `%APPDATA%\workflow-studio` |
| Linux | `$XDG_CONFIG_HOME/workflow-studio` (or `~/.config/workflow-studio`) |

`links/<id>.json` is the current state; `versions/<id>.json` holds the newest 20 snapshots. `WF_HOME`
overrides the directory — that is how the test harness runs against a throwaway fixture instead of the
user's real workflows.

## Building the server (keep it dependency-free)

- **No SDK.** MCP over stdio is newline-delimited JSON-RPC 2.0: read `stdin` by lines, dispatch
  `initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`, write one JSON object
  plus `\n` per reply. Any JSON-RPC library would be a second dependency for the sake of forty lines.
- **`initialize` must answer** with `protocolVersion`, `capabilities.tools` and `serverInfo`; notifications
  (no `id`) get no reply at all. Unknown methods answer `-32601`, tool errors come back as a normal result
  with `isError: true` so the client can show the message instead of dying.
- **Never let one bad line kill the process**: wrap dispatch in try/catch and skip unparsable lines. A
  harness that crashes on a stray newline looks like "the server is broken".
- **Guard `main()` behind `require.main === module` and export the readers**, so the CLI reuses exactly the
  same lookup code (`allWorkflows`, `findWorkflow`, `versionsOf`, `outline`) instead of a second copy that
  drifts.
- **Resolve lookups loosely**: id, exact name, case-insensitive name, then name fragment. Agents pass what
  the user said ("the 隔板 one"), not ids.
- **Return agent-shaped JSON**, not raw documents: edges resolved to `A -> B` titles, cards as
  `{kind,title,body,mods}`, versions as `{v,at,by,what}`. Raw dumps waste the client's context.

## Read-only by design

The canvas is the only writer: it writes atomically and adopts an external edit only when the version number
is higher. Exposing writes over MCP would let two agents race with no arbiter. Keep the adapters read-only;
write-back needs its own design (version bump + conflict rules), not a flag.

## Verifying (this is the part that catches real breakage)

1. **Fixture test, no user data**: `tools/test-mcp.js` creates a temp `WF_HOME` with one `links/` and one
   `versions/` file, spawns the server, then asserts the handshake, `tools/list` names, `list_workflows`
   counts, `get_workflow` edge resolution, `get_versions` order + snapshot, an error result, a `ping` after
   the error, and that the CLI reads the same fixture. Run `npm run test:mcp`.
2. **Real data smoke**: `node tools/workflow-cli.js list` and `show "<fragment>"` against the real data dir.
3. **Register in a real client and prove a call**: `claude mcp add workflow-studio -- node <abs path>/mcp/workflow-studio.js`,
   then `claude mcp list` must report `✔ Connected`, and one actual tool call must return data
   (`claude -p "Call list_workflows …" --allowedTools mcp__workflow-studio__list_workflows`). Registration
   alone only proves the process starts.
4. Snippets for the other clients live in `docs/integrations.md` (Codex `~/.codex/config.toml`
   `[mcp_servers.<name>]`, OpenClaw `openclaw mcp add … --command node --arg <path>`).

## Pitfalls

- **Absolute paths in client config.** MCP stdio servers are spawned from the client's own working directory;
  a relative script path fails silently as "server exited". Always register the absolute path.
- **Registrations are per-client config files** (`~/.claude.json`, `~/.codex/config.toml`, OpenClaw's own
  config). Adding one is fine when the user asked for integration; note that it is reversible and how.
- **A broken client config is not a code problem.** If the host's own gateway/config fails validation, the
  server never gets probed — fix the host first, and say so instead of rewriting the adapter.
- **Clean up test debris in the data dir.** Synthetic workflows created through the app leave
  `links/<id>.json` and `versions/<id>.json` behind even after the in-memory store is cleaned. Delete exactly
  the ids you created (loop the files, match `id`/`name`), never a name-prefix glob over the whole directory.
- **Test assertions and CLI output are data, not prose** — a fixture can be Chinese and still be correct; do
  not "translate" fixtures to satisfy an English-docs rule.
