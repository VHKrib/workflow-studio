# Workflow analysis: raw evidence, card consistency and verification order

Used when reading an agent, mapping a live conversation, and comparing cards between entry points. This is a
diagnostic and verification procedure; it endorses no parser or layout algorithm that has not been through an
independent review of its own.

## 1. Fix one real business sample first

- Agree on the target business, the target conversation and the current code branch. Do not guess the
  conversation from role names or a recent-activity list.
- Against cards the user already accepts, write down what each cell means: input material, process method,
  delivered result. The main canvas and the live window may cover different scopes, but card granularity must
  never degrade into message or tool log lines.
- Write the minimal relationship sample first: source material/version → process → product/version; separately
  record which product the user asked to change and which step was adjusted. Do not build a generic versioning
  framework first and look for a sample afterwards.

## 2. Check that the material was read completely before touching the prompt

1. Use a read-only connection to the target session database. Confirm the real schema with
   `sqlite3 -readonly "file:<db path>?mode=ro" "PRAGMA table_info(messages);"`, then query by session id with
   bound parameters, limited to the target range — never dump the whole database.
2. Check whether the target was pushed out of a cross-role global ordering. "Not selectable in the list" does
   not mean the conversation is missing; locate the record first, then judge the analysis entry point.
3. Compare raw body, tool arguments and tool result lengths against the actual read limit; check both the
   upstream SQL `substr` and the downstream `slice` — fixing only one is not enough.
4. Decode `tool_calls` completely before summarising. A truncated string that fails JSON decoding must not
   silently become an empty array. For long scripts, check trailing copy, export and output paths especially.
5. State truncation, undecodable data, missing tool results and out-of-window context as evidence limits. Read
   more context only within authorisation and redact first; "not read" is not "did not happen", and raising the
   limit alone is not "complete".

## 3. Verify entities, success states and relationships

| What | Must be distinguished |
|---|---|
| material identity | same name in different directories; same path with different contents over time; relative paths of unknown origin |
| material reuse | actually used by a process vs mentioned in text, re-read for QA, or polled repeatedly |
| product attribution | the tool call and its matching result; an async result does not belong to whatever step happened to be nearest when it arrived |
| product version | changes backed by fingerprints/bytes vs assumed edits; keep it unknown when evidence is missing |
| execution state | explicit success, failure, no result yet, proposal only; no error does not mean success |
| reason for change | which product was evaluated and which step was asked to change, distinct from which product was actually read |
| adoption state | latest, agent-claims-done, user-confirmed — none substitutes for another |

A variable assignment, a path appearing in a command, or a claim of output in a reply is not proof that a file
was read or written; verify against the actual run, the matching tool result and the delivery evidence. When an
older output is genuinely used as material, reuse its entity; when it merely triggered an opinion, record an
adjustment relationship instead of inventing a material edge.

Keep material flow, process output, version evolution and feedback reason apart. A file rewritten at the same
path does not imply the user saw the older version and asked for a change based on it; and do not wire
cause-and-effect to the nearest node just to make the graph connected.

## 4. Compare fields and rendering across both entry points

Walk prompt → raw model answer → parsed object → IPC → card component, checking title, body, mods, impl and
relationships at every layer.

- If the prompt asks for modules but the parser clears them, editing the prompt further is pointless.
- A process card's materials and results must be derived from real upstream/downstream relationships; its
  method module describes the approach, not generic "ran commands" or "wrote files".
- The read-only window may drop edit buttons, but it must not drop material, tool and result information.
- Paths, commands and evidence identifiers go into internal wiring; business numbers in the body (version
  numbers, sizes, frame positions) stay — do not delete every long number just to clean evidence ids.
- The same CSS class or similar JSON does not prove consistent semantics; compare meaning, modules and
  source/result relationships card by card on the same business sample.

## 5. Verify the graph and the interface afterwards

1. Independent cases must cover material reuse, material revision, same name from different sources, rewriting
   the same path, reusing an old result, failure/not-executed/in-progress, truncation and duplicate messages.
2. Validate unknown references, self-loops, mutual references and temporally impossible adjustments; check
   material dependencies separately from feedback/version relationships. A broken graph must not make layout
   loop or produce far-away coordinates.
3. In an isolated instance, generate the full graph from a real target conversation plus any necessary local
   views, and inspect card meaning, modules, branches, key text and overlap with your own eyes. Do not re-run
   repeatedly and pick a good-looking result while claiming stability.
4. Bind command output, raw parsing, the comparison table and screenshots to the same code version. Any later
   change to parsing or layout invalidates the earlier evidence.
5. Screenshot evidence stays unverified until reviewed; final independent acceptance still follows its own full
   responsibility. A branch delivering a script that can expose errors, or a branch finishing a query, does not
   mean the product passed.
