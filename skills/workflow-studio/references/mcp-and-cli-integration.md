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

## Writing back

Reads are safe; writes need the same rules the canvas follows, or two writers race with no arbiter. The
protocol that works (implemented in `mcp/workflow-studio.js`):

- **`expected_version` is mandatory.** The caller passes the version it just read. If the file moved on (the
  app, a person, another agent), refuse, change nothing, and return `current_version` so the caller can re-read
  and retry. Assert byte-identical file content after a refused write — that is the property, not just the
  error string.
- **A write is a version.** Bump `version`, set `updated_at`, append `{v, at, by: 'mcp', what, snapshot}` to
  `versions/<id>.json`, keep the newest 20. That is what makes an agent's edit visible in the app's version
  list and rollable-back like any other change. Recomputing `summary` keeps the list view honest.
- **Write atomically** (temp file + rename) exactly like `linkstore.js`. Readers must never see half a file.
- **Serialise writers with a lock file** (`<data>/.locks/<id>.lock`, `open(…, 'wx')`, retry ~2s then report a
  conflict). Two clients hitting save at once must queue, not interleave.
- **Validate before touching disk**: cards need unique ids, `kind ∈ in|proc|out`, a non-empty title; edges must
  point at existing cards and cannot self-loop. A failed validation must leave the file unchanged.
- **Mutations, not a document editor**: `save_workflow` (replace cards/edges/name/executor), `update_card` (patch
  one card's title/body/impl/mods), `rollback_workflow` (restore a kept snapshot as a new version). Callers are
  LLM agents — asking them to round-trip a whole document invites dropped fields.
- **`--read-only` at launch** hides the write tools entirely (not just refuses them), for "let it look, never
touch" setups.

**Adoption by the running app is the real acceptance test.** The canvas polls the state file and adopts a
foreign edit only when the version is higher, so after a write the open window should show the new card text
and the bumped version within ~1s. If it does not, the write is not compatible with the app (wrong field names,
missing `summary`, same version number) — fix the adapter, do not "restart the app to make it notice".

## Verifying (this is the part that catches real breakage)

1. **Fixture test, no user data**: `tools/test-mcp.js` creates a temp `WF_HOME` with one `links/` and one
   `versions/` file, spawns the server, then asserts the handshake, `tools/list` names, `list_workflows`
   counts, `get_workflow` edge resolution, `get_versions` order + snapshot, an error result, a `ping` after
   the error, and that the CLI reads the same fixture. For writes it must also assert: successful save bumps
   the version and appends a snapshot, a stale `expected_version` is refused **with the file byte-identical**,
   `update_card` touches only that card, invalid cards/edges write nothing, rollback restores the old snapshot
   as a new version, and the 20-version window holds. Run `npm run test:mcp`.
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
- **Do not smoke-test write tools against the user's real workflows.** Launch a throwaway instance
  (`--remote-debugging-port=<own port> --user-data-dir=<temp dir>`), point `WF_HOME` at that same directory,
  write one card there, watch the open canvas adopt it, then kill the instance and delete the temp tree. Same
  proof, zero risk to their data.
- **`what` is whatever the caller wrote in `note`.** Assertions that expect a canned string ("rolled back …")
  fail the moment a note is passed — assert the note itself, or the resulting snapshot.
