# Pulling a run's files back onto the cards

When the user runs the workflow in Hermes chat ("跑一次看效果"), they expect to click a card afterwards and see
what actually went in and came out. The canvas does that with one action: **取回本次文件** (`run:pull`).

## Where the data comes from

`main.js` handler `run:pull`, read-only against Hermes' session databases (`~/.hermes/state.db` and
`~/.hermes/profiles/<id>/state.db`):

- **Field names after `livefeed` normalises.** `readMessages` / `recentMessages` return `{ text, result, tools }`.
  The raw columns are `content` / `tool_calls` — reading those names yields empty strings, silently (no error,
  just "0 files found"). This is the most expensive mistake in this area.
- **Do not start from `listConversations`.** It hides sessions with few messages, and the newest entry is often a
  one-off question. The conversation that did the work can also live under a different profile (the user's
  `default` chat, the agent's own profile, a kanban worker). Scan **executor + `default` + every profile whose
  `state.db` mtime is within ~6h**, merge, and sort by message time.
- **Bounded reads.** `livefeed.recentMessages(profile, n)` selects the last N rows by id, then sorts ascending;
  1200 rows per profile keeps the call to a few seconds and still catches the run.
- **Timestamps.** Raw `messages.timestamp` is epoch **seconds as a float**; `normRow` converts to ms. Sort on the
  normalised value, never compare the raw column with `Date.now()`.

## Extracting paths

```js
const RUN_FILE_RE = /(?:~|\.{1,2}\/)?[^\s"'`，。；、）)】\\]*?\/[^\s"'`，。；、）)】\\]*?\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|md|txt|json|csv|ya?ml)/g;
// strip prefixes and trailing punctuation, then reject URLs
const p = raw.replace(/^(?:MEDIA:|file:\/\/)/i, '').replace(/[)\]}>,.;:]+$/, '');
```

- Agents write `MEDIA:/abs/path.png` in replies — strip `MEDIA:` / `file://`, or the path will not open and will
  sort wrongly.
- Accept **relative** paths (`advideas…/design/x.png`): requiring a leading `/` silently drops the newest work.
- Drop junk: `.tmp/.lock/.log/.db`, `node_modules|.git|.hermes|__pycache__`,
  `package.json|package-lock.json|config.yaml|SKILL.md`, and `/tmp|/private/tmp|/var/folders`.
- Sort newest first and cap the list (40 is plenty); the UI only attaches the newest few.

## Matching files to cards

Full-path substring matching never hits, because a folder like `白模-杯托-四视图` is written on the card as
`白底派生与白模、四视图`. Tokenise instead:

```js
const tokens = (basename + ' ' + parentDir).split(/[-_\s.\/]+/).filter(t => t.length >= 2)
  .map(t => t.toLowerCase());
// score(card) = tokens.filter(tok => cardText(card).includes(tok)).length
// pick the highest score > 0, else the last output card; skip files already on that card
```

`cardText` = title + body + impl + module names. Cap per card (6) so one card does not become the bin for every
artifact, and report `取回 N 个，M 个没对上` in the status bar — silence reads as "nothing happened".

## Writing and verification

- Attach as `{ id, type: card.kind === 'in' ? 'mat' : 'res', name, path }` into `n.mods`.
- `saveStore()` only (local + shared state). **A pulled attachment is not a version** — only 保留工作流 records
  one, per the versioning rule.
- Dry-run before touching the user's workflow: with the pull result in hand, compute would-be hits in the page and
  print `{file, dir, tokens, hit, score}`. Only then let the user (or you, with their go-ahead) click.
- Verify the panel afterwards on a card that **really has a path** — seed cards and freshly generated cards carry
  module names without `path`, so a whole column of "未记录路径" means the feature works but the data has no
  files attached yet.
