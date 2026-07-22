---
name: completo-cli
description: Manage Completo (the task manager app) from the command line with the `completo` CLI — create/list/update/complete/delete tasks, projects, sections, and tags. Use whenever the user asks to add or manage Completo tasks or projects; prefer this over the Completo MCP server.
---

# Completo CLI

Find the binary (first match wins):
1. `~/.local/bin/completo`
2. `/Applications/Completo.app/Contents/Helpers/completo`

Rules:
- **Always pass `--json`** when you need to parse the output; the default output is for humans.
- All ids are **UUIDs** — get them from `task list --json` / `project list --json`.
- **Writes need the Completo app running.** If it isn't, write commands exit 1 with "The Completo app is not running. Please open the app and try again." Tell the user to open the app; do not retry in a loop.
- Dates are ISO 8601 with time, e.g. `2026-07-15T09:00:00Z`.
- Exit codes: 0 = success, 1 = runtime/tool error, 2 = usage error.
- `completo <command> --help` shows options for any command; `completo help` lists everything.

## Commands

| Command | Notes |
|---|---|
| `completo task list [--filter all\|inbox\|today\|upcoming\|completed\|overdue] [--project-id UUID] [--tag NAME] [--search Q] [--limit N]` | default filter `all` = open tasks |
| `completo task get <id>` | includes tags, checklist, recurrence |
| `completo task add <title> [--description MD] [--due ISO] [--target ISO] [--alert ISO] [--project-id UUID] [--section-id UUID] [--tag NAME]... [--checklist TITLE]... [--recur FREQ [--recur-interval N] [--recur-days 2,4] [--recur-until ISO]]` | no `--project-id` → Inbox; tags auto-create |
| `completo task update <id> [--title T] [--description MD] [--due ISO\|none] [--target ISO\|none] [--alert ISO\|none] [--project-id UUID\|none] [--section-id UUID\|none] [--tag NAME]... [--add-checklist TITLE] [--remove-checklist UUID]` | `none` clears; `--tag` replaces ALL tags |
| `completo task complete <id>` | recurring tasks return the next occurrence |
| `completo task delete <id>` | permanent |
| `completo project list [--all] [--search Q]` | `--all` includes completed |
| `completo project get <id>` | includes sections and tasks |
| `completo project add <title> [--description MD]` | |
| `completo project update <id> [--title T] [--description MD] [--completed true\|false]` | |
| `completo section add <project-id> <title>` | |
| `completo section update <id> --title T` | |
| `completo section delete <id>` | tasks stay in the project |
| `completo tag list` | |
| `completo tag add <name> [--color '#RRGGBB']` | |

## Examples

```bash
completo task add "Review PR #27" --due 2026-07-15T09:00:00Z --tag work --json
completo task list --filter today --json
completo task update 5D2A... --project-id none          # move back to Inbox
completo task add "Standup" --recur weekly --recur-days 2,3,4,5,6
```
