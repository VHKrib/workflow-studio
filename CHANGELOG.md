# Changelog

## v0.6.0

Workflows stop being locked inside the app: any MCP-speaking agent can read them.

- **MCP server** (`mcp/workflow-studio.js`, stdio, no dependencies) exposing `list_workflows`, `get_workflow` and
  `get_versions` — works with Claude Code, Codex, OpenClaw and any other MCP client.
- **CLI** (`tools/workflow-cli.js`): `list` / `show <name>` / `versions <name> [--v N] [--json]` for harnesses
  that only have a shell.
- Both read the same files the app writes (`links/<id>.json`, `versions/<id>.json`), need no running app, and
  stay read-only: the canvas remains the only writer, so two agents can never race on one workflow.
- `WF_HOME` points the adapters at another data directory (isolated instance, copy, or test fixture).
- Regression test `npm run test:mcp` performs a real stdio handshake against a throwaway data directory.
- Setup snippets: [docs/integrations.md](docs/integrations.md).

## v0.5.0

This release puts the canvas on top of *someone else's conversation*: a separate read-only window picks one
running Hermes conversation and grows a chain card by card as it goes.

- **Standalone live canvas** — *⋯ → live canvas* opens a second window that holds only the board: conversation
  picker, one follow switch, current status. Nothing else.
- **Actions become cards** — what the person asked for is an input card; reads, commands, lookups, skill loads
  and API calls roll up into process cards (the body says "read 10 files"); a handoff to another agent is a
  process card naming the target; the answer and any written files become output cards.
- **Repeats merge in place** — ten reads in a row stay one card with a rising count; a repeated request and
  its follow-up answers fold back into the same card instead of flooding the board.
- **Plain language on the front** — commands, absolute paths, JSON and field names go into internal wiring;
  the card face shows intent and counts only.
- **Hard read-only boundary** — the session database is opened with `sqlite3 -readonly` and `?mode=ro`, SELECT
  only, newest 200 rows, never the whole file; the picker lists who / when / what it is doing, never private
  message bodies. The main window stays the only writer; writes from the second window are rejected.
- **Switch and status** — following reads an increment at most once a second; switching off stops immediately
  and leaves the board as it is; switching conversation clears and redraws with nothing left over. The last
  conversation and switch state survive a restart.
- **Window ownership** — closing the live window never affects the main window; closing the main window closes
  it too.

## v0.4.0

This release turns the board from "placing cards" into "building a chain with an agent": what you build
persists, rolls back, and can be checked before it runs.

- **Each workflow picks its own executor** — top bar, overview and run dialog stay in sync; the persistent
  dock at the bottom right talks to a fixed supervisor agent about the whole chain, never about one card.
- **Cards break into modules** — materials on input cards, tools on process cards, results on output cards,
  one short chip each; drag a card into a process card's socket to connect, drag the chip out to disconnect;
  a connection that would close a loop is refused.
- **Talk a workflow into existence** — a temporary canvas grows cards as the answer streams; save it as a real
  workflow when it looks right.
- **Read an agent's work chain** — a read-only pass over that agent's own description, skills and recent work
  records, turned into a card preview by the model; nothing lands until a person presses *put on canvas*.
  Runs can be cancelled, retried, and time out on their own.
- **Versions and rollback** — newest 20 per workflow, typing in a burst counts once; clicking a row in the side
  panel rolls the whole chain back, and the rollback is itself a version; a run in flight is stopped on rollback.
- **Editing is a version** — swapping materials, changing a tool, renaming a card, editing internal wiring or
  adding a module updates the canvas immediately, syncs the shared state file within a second, and records a
  version once you stop.
- **Copy a chain to experiment** — an independent copy; edits on either side never touch the other; the selected
  chain is marked in the side panel and remembered across restarts.
- **Tests run two passes first** — a local static pass (broken links, missing input/output, empty cards, loops,
  split chains, each with a fix) and a read-only rehearsal where the executor walks the cards and says what it
  would do and what is missing, with zero tools: no commands, no file writes, no messages, no publishing, no
  spending.
- **Plain language on cards** — what goes in, how it is processed, what comes out, concretely; commands,
  scripts, paths and field names move into internal wiring and stay off the card face.
- **Polish** — cards with a validation badge no longer push the *link* button out of the frame; seed content and
  public docs use neutral wording; at the narrowest window the top bar folds tests, copy, per-card validation,
  talk-a-workflow and read-chain into `⋯`, while *run* always stays clickable.

## v0.3.0

The previous release: three-colour card canvas, drag and zoom, per-card agent chat with "next step"
candidates, JSON import/export, per-card validation.
