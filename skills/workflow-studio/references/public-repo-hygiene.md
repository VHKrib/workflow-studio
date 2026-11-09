# Public repo hygiene: scan, history scrub, bilingual docs

Everything here is for the one public-facing repo of this product. Run it before any push that goes to the
public remote, and re-read this page when a scan result disagrees with the working tree.

## The scanner reads the index, not the working tree

`tools/scan-public.js` lists tracked files with `git ls-files` and inspects those blobs. Consequences:

- Editing a file and re-running the scan reports the **old** content until you `git add`. Always `git add -A`
  (or `git add <paths>`) before judging the result; "file is clean but scan still hits" is almost always a
  stale index, not a wrong edit.
- A dirty tree makes the report ambiguous. When something looks off, compare the reported line against
  `git show :<path>` (index) rather than the file on disk.
- The scan is only meaningful for the exact tree you are about to push: stage, scan, then commit *that*
  content, then push the commit you scanned.

## Never write the forbidden literal into the documentation about it

A rule that greps for a home-directory prefix fires on any document that quotes the prefix — including the
page explaining the rule. Describe it instead of quoting it (`/home/…`, `C:\…`, "a home-directory path with a
user name"). Same for department/role names: refer to them as "department/role words" in prose.

Self-test that the hint survived the reword: after staging, the scan must be 0 hits, and grepping the file for
the literal must find nothing.

## History scrubs, in the order they are safe

### 1. Content (paths, names) in unpublished commits

1. Clean the working tree and commit normally; the tip tree is now clean.
2. Rewrite only the unpublished tail, so the remote still fast-forwards:
   `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --tree-filter '<script that replaces the string in every tracked file>' <published-sha>..HEAD`
3. Prove delivery did not change: `git diff <old-tip> <new-tip>` must be **0 lines**.
4. Prove the string is gone from every new commit: loop `git grep -l <string> <commit>` over
   `git rev-list <published-sha>..HEAD` — expect empty.
5. Re-run the scan (staged) for 0 hits, drop `refs/original` and any temporary backup branch so `--all` can
   never push them.

### 2. Author/committer identities in already-published history

Needs the user's explicit go-ahead, because it rewrites published commits and requires a force push.

```bash
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
if [ "$GIT_AUTHOR_EMAIL" = "<sensitive>" ]; then
  export GIT_AUTHOR_NAME="<public name>"; export GIT_AUTHOR_EMAIL="<public noreply>"
fi
if [ "$GIT_COMMITTER_EMAIL" = "<sensitive>" ]; then
  export GIT_COMMITTER_NAME="<public name>"; export GIT_COMMITTER_EMAIL="<public noreply>"
fi
' -- --all
```

Then, in this order:

1. `git diff <old-tip> <new-tip>` = 0 lines, and `git rev-list --count` is unchanged before/after.
2. Re-scan for 0 hits and re-run the offline checks (content is identical, but prove it).
3. `git push --force-with-lease=main:<old-sha> origin main` — lease, not a bare force.
4. Verify on the remote, not locally: GitHub API `commits?per_page=100` covers a history this size in one
   page; assert no remaining sensitive email and print the identity histogram.
5. Delete local backups (`refs/original`, temp branches) once verified.

Pitfalls:

- Substring filters such as `@local` also match `@localhost`; check the histogram, not just "any hit".
- `filter-branch` warns that tags were rewritten while the tag object was not. Verify with
  `git ls-remote --tags origin` that each tag's target is an ancestor of `main`; a tag pointing at a
  pre-rewrite orphan is cosmetic but should be reported, and re-pointing it is another force push that needs
  approval.
- After a force push, say plainly that existing clones must re-fetch or re-clone.

## Verifying a push actually landed (CDN cache ≠ failed push)

`raw.githubusercontent.com` is CDN-cached: right after a push it can still serve the previous content, which
looks exactly like "the push didn't take" and tempts a redundant commit or a second push.

- `git ls-remote origin main` is authoritative for the remote sha.
- Read the file at that exact sha through the API:
  `curl -s "https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<sha>"`, base64-decode, then grep.
  This bypasses the CDN window.
- Only when both disagree with the local tree is something actually wrong.

## Bilingual docs, without mixing

The shape the user asked for: repository files in English; the introduction exists in both languages as two
separate files.

| File | Language |
|---|---|
| `README.md` | English only |
| `README.zh-CN.md` | Chinese only |
| `CHANGELOG.md`, GitHub About description and topics | English only |

Checks that catch the usual leaks:

- No CJK left in the English README — assert it, don't eyeball it: count lines matching `[\u4e00-\u9fff]` and
  expect 0. Link labels count as prose: `[Chinese version](README.zh-CN.md)`, not a Chinese label.
- The Chinese file keeps code, commands, paths and identifiers in their original form; only prose is Chinese.
- File names themselves are part of the language: launchers, docs and scripts get English names, and every
  reference (README tables, skill pages, start-up commands) is updated in the same commit.
- The repo About (description, topics) is a single language; do not leave the previous language's description
  in place while the README changes.

## Stale assertions after a vocabulary change

When a check fails only because the product's vocabulary moved (for example a module type renamed from one
label to another, with both the renderer and the producer updated), fix the assertion to describe the new
contract — and say in a comment why both labels are accepted. Never bend product code to satisfy an outdated
test, and never delete the assertion to make the suite green.
