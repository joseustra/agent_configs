---
name: devout-vault
description: Read and write an Obsidian vault with Devout — daily notes, PARA filing, frontmatter and tags, search, and bulk moves. Covers both the MCP tools and the devout-cli command line. Use whenever a task involves the user's notes or vault, or when you need to know which Devout tool or command to reach for.
---

# Devout vault

Devout exposes one Obsidian vault (a folder of `.md` files on disk) two ways: as **MCP
tools**, and as the **`devout-cli` command line**. Both run the same vault code, so the
behaviour below applies to both unless stated otherwise.

Every path is **vault-relative** — `01_Projects/Roadmap.md`, never `/Users/...` or `../`.
Paths are joined onto the vault root without a traversal guard, so an absolute path
silently escapes the vault. Always include the `.md` extension.

## Which surface to use

Use the **MCP tools** when they're available — they're wired to the user's configured
vault and need no path handling from you.

Use the **CLI** when you have a shell but no MCP connection, or when the work is bulk or
pipeline-shaped — filtering a listing, feeding paths into another command, scripting a
refile. The MCP tools have no equivalent of `| grep` or `| xargs`.

The two differ in one way that matters:

| | MCP tools | CLI |
|---|---|---|
| Failure | `Error: …` string, MCP-level success | non-zero exit, message on stderr |
| Success | JSON or prose on stdout | line-oriented text, or JSON with `--json` |

So with the CLI you can trust the exit code; with the MCP tools you must read the
response text.

## Call `get_vault_context` first

Before creating or updating anything, call `get_vault_context` (CLI: `devout-cli
context`). It returns the vault's `AGENTS.md` — the user's folder conventions, naming
rules, and command protocols. Filing a note without it means guessing at their structure
and usually putting it in the wrong folder. Reading is fine without it; writing is not.

## MCP: errors are strings, not protocol failures

Every tool returns a plain `String`. A failure comes back as text beginning with
`Error: …` and an MCP-level success. **Read the response before assuming a write
landed.** Return shapes differ per tool:

| Shape | Tools |
|---|---|
| JSON object | `get_note`, `get_daily_note`, `get_note_metadata` |
| JSON array | `list_notes`, `list_folders`, `search_notes`, `search_by_tag`, `list_notes_with_metadata` |
| Prose sentence | `create_note`, `update_note`, `append_to_note`, `delete_note`, `move_note`, `update_note_frontmatter` |
| Raw markdown | `get_vault_context` |

## Choosing a tool

**Finding notes.** `search_notes` reads every `.md` in the vault and returns *every
matching line* — case-insensitive substring, no ranking, no limit. On a real vault that
floods context. Reach for it only for genuine full-text needs. Prefer:

- `search_by_tag` — matches the `tags` key in YAML frontmatter only (array or bare
  string, case-insensitive, leading `#` optional). It does **not** see inline `#tags` in
  the body. Returns paths only.
- `list_notes_with_metadata` — path, title, tags, and modified timestamp for every note
  in one call. This is the triage tool: use it instead of `list_notes` followed by N
  `get_note_metadata` calls.
- `get_note_metadata` — frontmatter as JSON without pulling the body into context.
  Returns `{}` for a note that has no frontmatter block.

Note that `list_notes`, `search_notes`, and `search_by_tag` walk the whole vault
including the trash folder. Filter trashed paths out of results yourself.

**Writing.** The four write tools behave differently on a missing or existing file:

- `create_note` — refuses if the path already exists. Creates parent directories.
- `update_note` — blind overwrite. No existence check, no diff, no backup; it will
  happily create a new file, and it destroys whatever was there. Read first if you are
  modifying rather than replacing.
- `append_to_note` — requires the file to exist and errors if it doesn't. Appends bytes
  verbatim, so prepend your own `\n` if you need a line break.
- `update_note_frontmatter` — upserts keys into the YAML block, leaving the body alone.
  Creates the block if absent. `fields` must be a JSON object. **Upsert only** — there
  is no way to delete a key through it.

**Moving and deleting.**

- `move_note` errors if the source is missing or the destination exists, and creates
  parent directories. Use it for refiling; it's safer than create + delete.
- `batch_move_notes` runs moves one at a time and is **not** transactional despite what
  its description implies. A failure mid-list leaves earlier moves applied. Always read
  the returned `{succeeded, failed}` and handle partial completion.
- `delete_note` moves the file into the trash folder **by filename only**, discarding its
  directory. Two notes with the same name deleted from different folders means the second
  silently overwrites the first in trash. Rename before deleting when that's a risk.

## Daily notes

`get_daily_note` returns today's note, creating it from the configured template if it
doesn't exist yet. The folder, filename format, and template all come from the user's
config — don't hand-build a daily note path.

## Templates

`create_note` accepts an optional `template` (a vault-relative path to another note).
**When `template` is set, `content` is ignored entirely** — the new note is the template
with these substitutions applied:

| Placeholder | Becomes |
|---|---|
| `{{date}}` | today, `YYYY-MM-DD` |
| `{{title}}` | the new note's filename stem |
| `{{day_of_week}}` | today's weekday name, e.g. `Monday` |

To use a template *and* add content, create from the template, then `append_to_note`.

## The CLI

Every invocation needs a subcommand; a bare `devout-cli` prints help and exits 2. Serving
MCP is `devout-cli serve`, which is what an MCP client config must specify.

```
devout-cli note list [--folder F] [--metadata]   devout-cli search <query>
devout-cli note get|meta|delete <path>           devout-cli search --tag <tag> [--folder F]
devout-cli note create <path> [--content C] [--template T]
devout-cli note update|append <path> [text]      devout-cli daily [--path-only]
devout-cli note move <from> <to>                 devout-cli folders
devout-cli note frontmatter <path> '<json>'      devout-cli context
                                                 devout-cli config path|show
```

Global flags: `--json` for machine-readable output, `--config PATH` to point at a
different config file.

Three things worth knowing:

- **Write commands print only the path on stdout**, with progress on stderr. That's what
  makes `devout-cli note create a.md --content x | xargs ...` work.
- **Text arguments fall back to stdin when omitted** — `devout-cli note update n.md` with
  no text reads the body from the pipe. Handy for long content; surprising if you forget
  the argument, since the command will hang waiting on stdin.
- **`config path` works when the config file is missing** — it's the command you run to
  find out where the file should go. Every other command fails without one.

Bulk work is where the CLI earns its place:

```sh
# Refile every note tagged 'archive' into 04_Archive
devout-cli search --tag archive | while read -r p; do
  devout-cli note move "$p" "04_Archive/$(basename "$p")"
done
```

## Default vault layout (PARA)

`00_Inbox`, `01_Projects`, `02_Areas`, `03_Resources`, `04_Archive`, `05_Attachments`,
`06_Metadata`. Treat this as a fallback only — `get_vault_context` and `list_folders`
tell you what the vault actually looks like.
