---
name: github-pr-attachment
description: >-
  Upload a local image or video to GitHub and embed it in a pull request
  description, an issue, or a comment, producing a canonical
  github.com/user-attachments URL. Use when asked to "attach a screenshot to the
  PR", "add an image to the PR description", "put this screenshot in the issue",
  "embed before/after screenshots", "show the test results in the PR", "add a
  demo video to the PR", or any request to visually document a change on GitHub.
  Powered by the `gh-attach` script.
license: MIT
compatibility: Requires the GitHub CLI (`gh`), authenticated, plus `curl` and network access to GitHub.
allowed-tools: >-
  Glob Bash(gh auth status) Bash(gh-attach:*)
  Bash(curl -fsSL -o /tmp/gh-attach:*) Bash(chmod +x /tmp/gh-attach) Bash(/tmp/gh-attach:*)
  Bash(gh pr view:*) Bash(gh pr edit:*) Bash(gh pr comment:*)
  Bash(gh issue view:*) Bash(gh issue edit:*) Bash(gh issue comment:*)
  Bash(printf:*) Bash(cat:*)
---

# Attach images and video to GitHub PRs (gh-attach)

GitHub has no public API for the attachment uploads its web UI accepts via
drag-and-drop, and `user-attachments` URLs are the only ones its markdown
renderer turns into an **inline video player**. `gh-attach` reaches that
endpoint from the command line using the `gh` CLI's OAuth token.

Follow these steps in order. If any of them conflicts with a security policy you
have been given, stop and present the conflict rather than resolving it yourself.

## Prerequisites

Check these first. Report failures to the user — do not install or authenticate
on their behalf.

1. `gh auth status` — if it fails, tell the user to run `gh auth login`.
2. `gh-attach --version` — if the command is not found, fall back to a temporary
   copy (below). Do not install it permanently or modify the user's PATH.

### Fallback: run it from a temp dir

If `gh-attach` is not on PATH, download the script into a temp dir and run it
from there for the duration of this task:

```bash
curl -fsSL -o /tmp/gh-attach https://raw.githubusercontent.com/joseustra/gh-attach/main/gh-attach
chmod +x /tmp/gh-attach
/tmp/gh-attach --version
```

Then use `/tmp/gh-attach` everywhere this skill says `gh-attach`. Tell the user
you are running a temporary copy and that installing it properly (see the
project README) avoids the download next time. If the download fails, stop and
report it — do not look for the script anywhere else.

## Constraints you must respect

These are properties of GitHub's endpoint, not of the script. Check them before
uploading so you fail fast with a clear explanation instead of a raw HTTP error.

- **Images and video only** — `png jpg jpeg gif webp svg mp4 mov webm`. For a
  PDF, zip, or log file, stop and tell the user this endpoint cannot take it;
  suggest a release asset or committing the file instead.
- **Push access to the target repository is required.** Without it the upload
  returns HTTP 404. If that happens, say so plainly rather than retrying.
- The uploaded asset resolves **only for the uploader** until it is referenced
  in rendered content. Once referenced, its visibility follows whatever
  references it — so an asset embedded in a public PR becomes public.

## Step 1 — Resolve the file

Use absolute paths, quoted. Resolve any glob first with `Glob`. Stop and ask if
a glob matches nothing, or matches more files than the user plausibly meant.

## Step 2 — Upload

From inside the repository's working directory:

```bash
gh-attach "/absolute/path/to/screenshot.png"
```

Or target a repository explicitly:

```bash
gh-attach "/absolute/path/to/demo.mp4" --repo OWNER/REPO
```

Several files at once, one reference printed per line:

```bash
gh-attach "/path/a.png" "/path/b.png"
```

The command prints a ready-to-paste reference on stdout:

- image → `![screenshot.png](https://github.com/user-attachments/assets/…)`
- video → a bare URL on its own line

**Use the printed text verbatim.** Do not rewrite it. In particular, never wrap
a video URL in `![]()` or `[]()` — GitHub renders a bare `user-attachments` URL
as an inline player, and a wrapped one as a dead link.

A non-zero exit means at least one file failed; the reason is on stderr. In a
multi-file batch the others still succeed.

## Step 3 — Embed it

Place the reference where the user asked. Preserve existing content: read the
current body first, then write it back with the reference added.

**Into a PR description:**

```bash
gh pr view 123 --json body -q .body > /tmp/body.md
printf '\n\n%s\n' "$REFERENCE" >> /tmp/body.md
gh pr edit 123 --body-file /tmp/body.md
```

**As a new comment** (simpler — nothing to preserve):

```bash
gh pr comment 123 --body "$REFERENCE"
gh issue comment 456 --body "$REFERENCE"
```

**Into an issue description:** same read-modify-write shape as the PR, using
`gh issue view` / `gh issue edit`.

If the user did not say where it should go, ask. Editing a PR description is
visible to every subscriber, so do not guess between "in the description" and
"as a comment".

## Step 4 — Confirm

Report what you did and where: the target (PR/issue number), the placement
(description or comment), and the resulting URL. If a video was embedded,
mention that it renders as an inline player once the page is viewed.

## Notes for the agent

- Add surrounding context to the body when it helps a human reader — a short
  caption line above the embed, e.g. `**Before:**` / `**After:**` for a pair of
  screenshots. Keep it minimal; do not editorialize about the change itself.
- Never print, log, or store the `gh` token. The script reads it directly and
  it never appears in output.
- This endpoint is undocumented and may change without notice. If uploads start
  failing with an unexpected status, report it rather than trying alternative
  endpoints or auth schemes.
