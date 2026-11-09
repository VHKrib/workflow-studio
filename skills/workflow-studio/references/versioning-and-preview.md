# Edits become versions; rollback, copy and read-only rehearsal

Check the current branch state and scripts first, then act within your own responsibility; this page documents
product behaviour and the evidence used to verify it.

## 1. One content change records one version

- A complete content snapshot covers name, executor, node kinds/body/internal wiring/modules/checks, edges and
  version metadata. Coordinates may live in the snapshot but do not take part in the content fingerprint.
- A burst of typing, or one batch of card additions with their edges, produces one version. Dragging, zooming,
  opening panels, selecting, chatting and viewing results are not content changes.
- Only the newest 20 versions are kept — this is not a full audit history. A version entry names which card
  changed and what changed, phrased per kind (input: swapped materials; process: changed method; output:
  changed deliverable), not just "edited".
- Every edit updates memory and the canvas first, then debounce-writes local storage and the shared structure;
  blur, switching cards or closing flushes pending edits. Resetting a timer is not the same as saving.
- Never rebuild the detail panel while the user is typing. A title may be temporarily empty and normalised on
  submit; renaming a module must update content, record a version and keep focus.
- Record whoever actually confirmed the change: an agent proposal applied by a person is not the agent writing
  to the canvas directly.

## 2. Rollback restores structure without erasing what came after

- A rollback also creates a version, recording where it went back to; later records are not deleted, so you can
  return to them.
- Restore nodes, edges, modules, body, internal wiring, checks, executor and name. Existing nodes keep their
  current position; restored nodes use snapshot coordinates, so position never becomes a hidden content version.
- Stop the workflow's running conversation first, then apply the old structure. Output arriving after a cancel
  must not be parsed into candidates or mutate cards.
- The next agent call injects the current version, the rollback fact and the new structure. If the chain was
  edited again afterwards, stop claiming "just rolled back and everything after is void".
- External claims and rollbacks keep local chat, status and rehearsal per node id; the shared structure never
  overwrites those local records.

## 3. A copy is an independent workflow

- Copy content, modules, checks, coordinates, executor and edges; nodes and modules get new ids and edges are
  remapped, so editing one copy never touches the other.
- No node conversations and no rehearsal results come along. De-duplicate the name, and start versioning from a
  clear copy baseline.
- The selected workflow is the one on the canvas; it needs a visible marker and must persist. If `current`
  points at something deleted or missing after load, fall back to a valid one instead of keeping a dead
  reference.
- Verify selection memory with a normal close and reopen — not with a force-kill, whose delayed Chromium write
  does not prove the feature broken.

## 4. Tests only run against the selected workflow

The static pass calls no model and at least checks:

- no executor assigned; empty workflow or empty card;
- an edge referencing a missing node, a self-loop, a long cycle;
- an input with nowhere to go or fed backwards, a process step missing a source or a product, an output with no
  producer;
- several unrelated fragments.

Name the cards involved and how to fix them; a bare failure flag is not enough.

Real business steps that failed, are in progress, are only proposed or lack evidence must be explained by their
state — never invent products just to make all three kinds present.

A read-only rehearsal must be limited by the main process to a zero-tool group; the current implementation uses
`context_engine,no_mcp`, and you must confirm it resolves to no executable tools in this version. Ask each card
what it would do and what it lacks; never generate, pay, publish, message or write files.

- Results may be written back to local nodes and the test dialog; they do not bump content versions and never
  enter the shared structure.
- Record the real tool-call count each time; it should be zero — the word "read-only" in a prompt is not proof
  of permissions.
- Clearing results must also remove node markers, details and dialog content.
- Closing the test dialog, switching workflow, creating a new one, rolling back or closing the window stops a
  rehearsal in flight; finished verdicts may stay.

## 5. Isolated regression

Run inside your own instance with `CDP_PORT` set:

- `skills/workflow-studio/scripts/cdp-version.js` — versioning, batching, keeping only the newest, rollback, and
  position changes not creating versions.
- `skills/workflow-studio/scripts/cdp-edit.js` — a version per field, burst merging, focus, sync, flush on card
  switch, rollback.
- `skills/workflow-studio/scripts/cdp-copy.js` — copies are independent, naming and selection, static pass, top
  bar and menu.
- Optional modes (`--chat`, `--preview`, simulated hang) need their current script and environment variables
  read first. Report real calls and offline tests separately; an option that was not run is not a pass.

Compare canvas, local records, shared state file and what the agent sees. After changing the last field or the
layout, re-run the matching check — an earlier run does not prove an unverified tail change.
