# Card-splitting fixtures (offline regression)

Real splitting answers, frozen into files: **no network, no model call**. After touching the parser or the
prompt, one command tells you whether splitting got worse.

```bash
node skills/workflow-studio/scripts/check-fixtures.js        # every fixture (good + bad)
node skills/workflow-studio/scripts/check-fixtures.js <dir>  # one directory only (break a fixture to prove the assertions really fail)
```

## Good fixtures (real answers, redacted)

| File | Content | Source |
|---|---|---|
| `01-product-data-normalize.json` | Product data normalisation · 9 cards, 11 edges (2 in / 4 process / 3 out) | raw archive of one real answer |
| `02-storyboard-to-video.json` | Storyboard to finished video · 9 cards, 11 edges (3 in / 4 process / 2 out) | raw archive of one real answer |
| `03-selling-point-cards.json` | Selling-point card chain · 9 cards, 11 edges (2 in / 3 process / 4 out) | raw archive of one real answer |

All three are runs that really landed on a canvas (card and edge counts match the state file afterwards).
Redaction only swaps words: anything pointing at a specific team, role, machine or product is replaced; card
kinds, edges, modules and body wording stay as they were. `answer` is stored as a JSON object (content
untouched); the script serialises it for the parser.

## Bad fixtures (hand-made, `bad/`)

| File | What it fakes | Current behaviour (assertions follow this) |
|---|---|---|
| `bad-01-two-islands.json` | two unrelated mini chains | quality gate blocks: `chain split into pieces` |
| `bad-02-in-to-in.json` | an input card wired into an input card | auto-fixed: that edge is dropped, the unfed process card gets an edge, the orphan input card is attached; gate passes |
| `bad-03-truncated.json` | half-written JSON (stream cut off) | no complete plan, gate reports `no cards`; the streaming preview shows 2 cards first |
| `bad-04-proc-only.json` | process cards only | quality gate blocks: `cards incomplete (need input, process and output)` |
| `bad-05-no-edges.json` | no edges at all | auto-fixed: edges added in card order (in → process → out), gate passes |

"Blocks" and "auto-fixes" are existing behaviour; assertions describe the present. **Do not bend the parsing
rules to make a fixture pass** — changing a rule needs a named symptom and a reason.

## File format

```jsonc
{
  "meta":   { "id": "…", "title": "…", "from": "which review / when / which card", "note": "redaction note" },
  "expect": {
    "cards": 9,                        // parsed card count; null = expects no plan
    "kinds": { "in": 2, "proc": 4, "out": 3 },
    "titles": ["…"],                   // card order and titles
    "edges": [["c1", "c3"]],           // parsed edges (order counts)
    "gate": "",                        // planProblem verdict, empty = passes
    "autoFix": false,                  // parsed edges differ from the answer's
    "partial": 2,                      // optional: cards visible in the streaming preview
    "wired": false, "single": false    // optional: bad fixtures meant to stay unwired / split
  },
  "answer": { "name": "…", "cards": [], "edges": [] }   // or a string (truncated fixture)
}
```

Per fixture the script asserts: card count, order, all three kinds present, edges one by one, no edge into an
input card, every card connected, one single component, the quality-gate verdict, and redaction (no absolute
local paths, no 9+ digit numbers, no emails, no team/role words, no local profile ids).

Profile ids are matched as whole words against the directory names under `~/.hermes/profiles` (short ids never
hit ordinary English words); on a machine without that directory the check is skipped and the rest still runs.

**The easiest thing to miss is a filename inside `impl`**: something like `cards/<batch>.<some-executor>.json`
looks like a neutral path but carries an executor id into the repo. Redact directory and file names in `impl`
too.

## Adding a fixture

1. Save the real answer as `NN-<short-name>.json`, redact it, and add `meta` and `expect` in the format above
   (write `expect` as what the answer *should* become, not a copy of what the parser currently outputs).
2. Run `node skills/workflow-studio/scripts/check-fixtures.js`.
3. Add a row to the table above with the source (when + which card).
