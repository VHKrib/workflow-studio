# Bringing Hermes' chat look into this app (no React, no build)

When the user says "make it look like Hermes", **read Hermes' source for the real values — do not tune CSS from
memory**.

## Where the values come from

- The user runs the **packaged** Hermes (`~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app`).
  The packaged build **does not open CDP**, so the `inspecting-hermes-desktop-dom` approach cannot attach; don't
  poke 9222 either — that port is this app, so you would be inspecting our own page.
- Read the source directory `~/.hermes/hermes-agent/apps/desktop/` instead:

| File | What to take |
|---|---|
| `src/styles.css` | design tokens: `--conversation-tool-base-size: 0.6875rem`, `--conversation-base-line-height: 1.125rem`, `--conversation-scaffold-text: color-mix(in srgb, var(--ui-base) 64%, transparent)`, `--conversation-scaffold-meta: … 44% …`, `--ui-text-tertiary: … 54% …` |
| `src/components/chat/scaffold-row.tsx` | semantics and sizes of scaffold rows (tool / thinking headers), right-margin rules |
| `src/components/chat/disclosure-row.tsx` | disclosure interaction: no leading caret, **caret appears on hover**, hover background is a pill hugging the text |
| `src/components/assistant-ui/thread/message-parts.tsx` | `ThinkingDisclosure` / `ReasoningAccordionGroup`: "Thought for 5s" label, body `text-xs leading-snug muted/85` |
| `src/components/assistant-ui/thread/user-message-text.tsx` | inline `code` = `rounded bg-current/8 mono 0.92em`; code block = `rounded-md border stroke-tertiary bg-current/5 mono 0.86em` |

## Porting rules (values and structure only, no React)

- Do not add React or Tailwind, and do not copy compiled CSS (preflight would wreck this app's styles). Translate
  tokens into the variables we already have: Hermes' `color-mix(in srgb, var(--ui-base) 64%, transparent)` is
  roughly `color-mix(in srgb, var(--ink) 64%, transparent)` here.
- **Assistant messages have no bubble** (plain text blocks); only the user's messages get a light bubble on the
  right (`color-mix(ink 7%)`).
- **One tool row per step**: status dot (breathing while running / green when done / red on error) + name +
  right-aligned duration; click to see arguments and result. Not a coloured pill.
- **The thinking block is `<details open>`, expanded by default** (the user asked to see the reasoning), with a
  summary like "thinking 16s · 6095 chars", body at 11.5px, 68% foreground and a 1px rule on the left.
- Answers over 900 characters collapse behind "show full text (N chars)"; body uses `overflow-wrap:anywhere`.
- The agent picker is a borderless `<select>` with a small CSS caret and a 6% hover background — the native white
  box inside an orange pill was explicitly called ugly.

## Chat density (the user once said it felt cramped)

Do not use compact values. The settled set (safe to copy):

| Item | Value |
|---|---|
| dock size | 392×480 (`right:14;bottom:52`) |
| message gap | 18px (same for `.chat-log` in card chat) |
| body text | 13px / line-height 1.72 |
| user bubble | padding 9px 13px, radius 16, background `color-mix(ink 7%)` |
| tool row | 11.5px / 22px line height, status dot + name + right-aligned duration |
| thinking summary | 11.5px / 22px, brightens on hover, caret on the right |
| thinking body | 11.5px / 1.6, 68% foreground, 1px left rule + 12px indent, `max-height:190px` |
| markdown paragraph gap | 10px |
| long-answer threshold | 900 characters (first 600 shown + "show full text (N chars)") |

When adding content, add whitespace before shrinking type; after a change, measure `gap / lineHeight / fontSize
/ dock width` in the DOM to confirm.

## Two easy confusions

- "Looks like Hermes" and "gets Hermes' data" are different things: real streaming uses `--format stream-json`,
  which **does not carry the reasoning text**; reasoning only appears with `--format text`. `USE_STREAM` picks
  one — never promise both at once.
- During streaming, `text` staying at length 0 for the first 10 seconds is normal: the model runs tools first and
  only then starts producing text. `len:0 / steps:0` is not a sign that streaming failed — start timing at the
  first `tool_use` or `text` event.
