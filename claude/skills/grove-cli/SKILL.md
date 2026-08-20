---
name: grove-cli
description: Create, open, list and tear down per-ticket development workspaces with the `grove` command — new/dev/list/destroy/cleanup/login/tunnel/config. Use whenever a ticket needs an isolated worktree with its own port and generated files, when asking which workspaces exist or what port one holds, when a setup/teardown command needs the GROVE_* environment, or when a workspace behaves as if it read someone else's config.
---

# grove

`grove` gives one ticket one workspace: a git worktree, a claimed port, copied
build artifacts, rendered config files, and a terminal session — created and
torn down with one command. It provisions; a **workspace tool** (tmux, Orca or
Helm) owns the terminal.

## Quick start

```sh
grove config                      # which tool is in force, and every key resolved here
grove new CORE-123 "Lock the row" # worktree + branch + port + files, then opens it
grove list                        # every workspace: ticket, status, port, branch
grove destroy CORE-123            # teardown commands, files, state, worktree, branch
```

`new` must run **inside the repository**. `list` and `destroy` run from
anywhere. Read the next section before running `new` or `dev`.

## The rule that matters: `new` and `dev` may never return

Under **tmux** — the default, and what you get with no config at all — `grove
new` and `grove dev` end by `exec`ing into tmux. The grove process is
*replaced*. From an agent's non-interactive shell that means the command never
returns, and whatever you piped it to hangs until the tool times out.

The escape hatch is the shape of that exec: with `$TMUX` set grove execs `tmux
switch-client`, which does its job and exits, so the command returns normally.
With `$TMUX` unset it execs `tmux attach-session`, which sits there forever.
That is why "run it inside a tmux session" works — but note that
`switch-client` moves the user's own tmux view to the new session, so it is not
a silent operation.

So before running either, know which tool is configured:

```sh
grove config   # names the tool in force, and the two files it was resolved from
```

That is the binary's own answer, so it settles both questions at once: which
tool, and whether this binary is new enough to be asked. `Unknown command:
config` means it is not — fall back to `grep -o '"tool"[^,}]*'
~/.config/grove/config.json` (absent ⇒ tmux) and read Troubleshooting, because
the config states an intent and only the binary decides the behaviour.

| tool | `new` / `dev` ends by | safe to run unattended |
|---|---|---|
| `tmux` | `switch-client` inside tmux, `attach-session` outside | **only inside a tmux session** |
| `orca` | asking the Orca app to focus the terminal | yes |
| `helm` | writing Helm's spool and printing where | yes |

Everything else — `list`, `destroy`, `cleanup`, `login` — returns normally on
every tool. When you only need the workspace to *exist*, `grove new` under Orca
or Helm is fine; under tmux, create it and let the user enter it.

## Commands

| Command | Notes |
|---|---|
| `grove new <ticket> <title>` | branch named by `branchTemplate` (default `<ticket>-<kebab title>`), worktree, port, artifacts, generated files, setup commands, then opens it. Must run **inside the repository**. Refuses if the ticket already has a workspace |
| `grove dev [<ticket>\|<path>]` | opens an existing workspace, reusing the port in its state file. No argument means the current directory |
| `grove dev --dir <path>` | same, when the path could be mistaken for a ticket |
| `grove list` | every workspace: ticket, status, port, branch |
| `grove destroy <ticket>` | teardown commands, generated files, state, worktree, branch. Runs from anywhere |
| `grove cleanup` | destroys every workspace whose branch is merged into `origin/<defaultBranch>` — **prompts `[y/N]` on stdin** |
| `grove login` | opens `loginUrl` for the workspace you are standing in |
| `grove tunnel <vm> [local[:remote]]...` | reconnecting SSH tunnel to ports on a VM; each argument is one forward, defaulting to `tunnel.localPort`/`tunnel.remotePort`. Long-running |
| `grove config` | the config resolved for the repository you are standing in, the two files it came from, and the tool in force. Read-only, and the one command that runs without a working workspace tool |
| `grove version` | also `--version`, `-v`. Prints version, commit and build date. Answered before the config is even read, so it is the one command a broken config cannot stop |

Exit **1** on any failure, with the reason on stderr. `grove` with no arguments
— or `help`, `-h`, `--help` — prints usage and exits 0.

## The workspace

Each workspace root holds **`.grove.json`** — `{ticket, branch, port}` — and
that file is authoritative. The tool stores nothing of grove's, so killing a
session loses no state; the port stays claimed and `dev` reopens on it. Read it,
never write it: `destroy` is what retires a port.

Every command grove runs in a workspace gets these, and they are a published
interface rather than a detail:

```
GROVE_TICKET  GROVE_BRANCH  GROVE_DIR  GROVE_PROJECT  GROVE_PORT
```

`GROVE_DIR` is the worktree root; `GROVE_PROJECT` is the directory inside it
where the app lives (`projectSubdir`), which is where setup and teardown
commands run. The same five are available to `setupCommands`,
`teardownCommands`, `generatedFiles` templates and the URLs as the placeholders
`{ticket} {branch} {dir} {project} {port}` — but the environment variables are
the quoting-safe form, and placeholders splice into a shell string textually.
**In a command, prefer `$GROVE_PORT` over `{port}`.**

## Configuration

Two JSON files, layered:

1. **Global** — `$GROVE_CONFIG`, else `$XDG_CONFIG_HOME/grove/config.json`, else
   `~/.config/grove/config.json`. The machine's answers.
2. **Project** — `grove.json` at the **main worktree root**, read from there and
   nowhere else. Untracked, never committed. One repository's answers, layered
   over the global config.

Two environment variables reach in without editing either file, which is what
makes them the knob to use for a single invocation:

| variable | effect |
|---|---|
| `GROVE_CONFIG` | path to the global config. Set but missing is an error, not a fallback |
| `GROVE_WORKTREE_ROOT` | overrides **both** `tmux.worktreeRoot` and `helm.worktreeRoot`, whichever tool is in force |

### The keys

| key | scope | default | means |
|---|---|---|---|
| `tool` | global-only | `tmux` | `tmux`, `orca` or `helm` |
| `tmux.worktreeRoot` / `helm.worktreeRoot` | global-only | `~/Developer/grove_wt` | where per-ticket worktrees live |
| `tmux.windowName` | project | `work` | name of the window grove creates; `""` leaves tmux to name it |
| `helm.project` | project | repository's directory name | the Helm project new sessions join |
| `projectSubdir` | project | `""` | where the app lives inside the worktree; `""` is the worktree root |
| `copyDirs` | project | none | project-relative dirs copied from the main worktree (build/dep caches) |
| `portStart` | project | `0` | first port tried. **`0` disables port assignment entirely** |
| `generatedFiles` | project | none | `[{path, template}]`, written on `new` — and on `dev` only when `.grove.json` is missing — removed on `destroy` |
| `setupCommands` | project | none | run in the project dir on `new`; a failure aborts `new` |
| `teardownCommands` | project | none | run in the project dir on `destroy`; a failure only warns |
| `browserUrl` | project | none | opened at the end of `new`/`dev`; `""` opens nothing |
| `loginUrl` | project | none | what `grove login` opens |
| `defaultBranch` | project | `main` | the trunk `cleanup` compares against, as `origin/<branch>` |
| `branchTemplate` | project | `{ticket}-{title}` | see Branch names; ignored under Orca |
| `zoxide` | project | `false` | register new worktrees with `zoxide add` |
| `openCommand` | project | `open` | how URLs are opened; `xdg-open` on Linux |
| `tunnel.vmTool` | project | `fv` | CLI that resolves VMs for `grove tunnel` |
| `tunnel.alias` | project | `grove-tunnel` | ssh host alias |
| `tunnel.localPort` / `.remotePort` | project | `5432` | the pair a bare `grove tunnel <vm>` forwards |
| `tunnel.holdSeconds` / `.maxFailures` | project | `600` / `40` | reconnect behaviour |
| `tunnel.compression` / `.ipQoS` | project | `false` / `""` | `ssh -C`, and the DSCP marking |

Five keys grove used to honour are now a hard error in either file, with no
shim: `mcp` (say `generatedFiles`), `panes` and `layout` (the tool owns terminal
layout — configure it there), and top-level `worktreeRoot` / `windowName` (say
`tmux.worktreeRoot` / `tmux.windowName`). One of these in the **global** config
fails *every* command except `version`, `grove config` included.

The three global-only keys are an error in a `grove.json` — grove needs all
three before it knows which repository it is acting on. Lists replace wholesale,
so `"copyDirs": []` means genuinely none. An unknown key is a hard error, not a
silent no-op.

### Presence is the whole test

**A key that is present wins, even at its zero value.** Every layer is decoded
*onto* the one below it, so `"projectSubdir": ""` overrides a global `"backend"`
and means the worktree root, and `"browserUrl": ""` overrides a global URL and
means open nothing. To inherit, omit the key; there is no way to write "inherit"
explicitly. That holds even where the empty value names nothing: `"tool": ""` is
rejected as an unknown tool rather than falling back to tmux.

So **blanking is not resetting**: to restore the inherited or default value,
*delete* the key; to choose the empty value, *state* it. `grove config` prints
the result of that layering — prefer it to reading either file, which states an
intent rather than what the binary understood.

## The browser

`new` and `dev` both end by opening `browserUrl` — the workspace's own URL, with
`{ticket}` and `{port}` substituted. On a project with no web server that is
pure noise; set `"browserUrl": ""` in the repository's `grove.json` to stop it.

## Branch names

Under **tmux** and **Helm** grove names the branch, and `branchTemplate` says
what to call it. It is project-scoped, so a repository states its own convention
in its `grove.json` and every workspace grove makes there follows it. Under
**Orca** the key is ignored — Orca names its own branches and grove records the
name.

```jsonc
"branchTemplate": "{ticket}-{title}"            // default
"branchTemplate": "{ticket}"                    // ticket already reads like a title
"branchTemplate": "joseustra/{ticket}-{title}"  // a convention with a namespace
```

Only `{ticket}` and `{title}` (kebab-cased) render here — not `{port}`,
`{branch}`, `{dir}` or `{project}`. A `/` goes into the branch name **only**:
the worktree is still `<worktreeRoot>/<ticket>`. A template rendering to nothing
is an error naming the key.

So when a repository's `CLAUDE.md` mandates a branch shape, grove can now follow
it: write the `branchTemplate` rather than hand-renaming the branch afterwards.

## What this cannot do

- **Create a workspace for a ticket that already has one.** `new` refuses and
  points at `dev` or `destroy`. There is no `--force`.
- **Name one branch differently from the rest.** `branchTemplate` is a
  repository-wide rule; there is no `--branch` flag for a one-off. Note too that
  the default still stutters when the ticket already reads like the title —
  `send-messages-to-agents "Send messages to agents"` gives
  `send-messages-to-agents-send-messages-to-agents` — so set
  `"branchTemplate": "{ticket}"` in such a repository rather than fighting the
  title.
- **Name the workspace directory.** It is always `<worktreeRoot>/<ticket>`,
  whatever the branch is called.
- **Branch off the trunk.** `new` branches off whatever HEAD the invoking
  worktree is on. Check you are on the trunk first.
- **Name workspaces per repository.** One worktree root is a flat namespace for
  every repository on the machine, so ticket names collide across repos.
- **Roll back a failed setup.** A `new` whose `setupCommands` fail leaves the
  workspace standing, fully registered and holding its port. Fix and `grove dev
  <ticket>`, or `grove destroy <ticket>`.
- **Migrate anything when the config changes.** Existing workspaces keep the
  checkout, branch, port and `.grove.json` they were made with. Switching
  `tool` in particular strands them: tmux workspaces sit under the worktree
  root where Orca will not list them, and vice versa — so `destroy` them under
  the tool that made them, *before* switching.
- **Run `cleanup` unattended.** It reads `[y/N]` from stdin; give it an answer
  or leave it to the user.

## Habits

- **`list` first.** It is the cheap, side-effect-free way to learn what exists,
  what port each workspace holds, and whether one is running.
- **`destroy` is the only correct teardown.** `git worktree remove` by hand
  skips the teardown commands and strands whatever they were meant to undo.
- Under **tmux**, `dev <ticket>` resolves `<tmux.worktreeRoot>/<ticket>`; under
  **Helm**, `helm.worktreeRoot`. Under **Orca**, pass the path `list` printed —
  ticket lookup is not wired up there yet.
- `login` makes no backend call — it walks up to `.grove.json` — so it behaves
  identically on every tool, including in a workspace whose session is dead. It
  still needs the tool to be *usable*: grove checks that once, ahead of every
  command bar `config` and `version`, and gives up on what the check says — for
  tmux and Helm that means installed, for Orca the app actually running.
- Grove owns provisioning **exclusively**. If a workspace is missing a file,
  the answer is a `generatedFiles` entry or a `setupCommand`, not a hand-written
  file that the next `destroy` will not know to remove.

## A worked example: a large gitignored artifact

Some repositories cannot build without a file too big to copy into every
workspace — Helm needs a 374 MB `Vendor/GhosttyKit/ghostty-internal.a` that git
never sees. Borrow it with a symlink from a `setupCommand`, not a `copyDirs`
entry, and resolve the source with `pwd -P` so the link survives the main
checkout later retiring a symlink of its own:

```json
{
  "projectSubdir": "",
  "copyDirs": [],
  "setupCommands": [
    "ln -sfn \"$(cd /path/to/main/Vendor/GhosttyKit && pwd -P)\" Vendor/GhosttyKit"
  ]
}
```

## Troubleshooting

| Symptom | Meaning | Remedy |
|---|---|---|
| `Project folder not found at .../<subdir>` | the global `projectSubdir` belongs to a different repository | confirm with `grove config`, then write a `grove.json` at this repository's main worktree root setting its own `projectSubdir` — `""` for the worktree root |
| `Opening browser: ...` in a repository that serves nothing | the global `browserUrl` belongs to a different repository | the same shape, and the same fix: `"browserUrl": ""` in this repository's `grove.json`. Stating it empty is the off switch, not a thing to avoid |
| no port in `.grove.json`, `$GROVE_PORT` empty | `portStart` is `0`, which disables port assignment | set `portStart` in the repository's `grove.json` if the project needs a port |
| `new` refuses | the ticket already has a workspace | `grove dev <ticket>` or `grove destroy <ticket>` |
| every command fails with `"<key>" is no longer supported` | the global config still states `mcp`, `panes`, `layout`, or a top-level `worktreeRoot`/`windowName` | apply the replacement the error names; `grove version` still works while you do |
| `unknown tool ""` | the config blanks `tool` instead of omitting it | drop the key from the global config |
| `grove config` or `grove version` is an unknown command, or `config` prints values neither file states, or `list` reports a `worktreeRoot` nobody configured | the binary predates the key you are asking about, and silently ignores every key it does not know — including `tool`, so it will `exec` into `tmux attach` whatever the config says | report the symptom and let the user update their install; treat nothing above about tools as trustworthy until they do |

**When the config and the binary disagree, believe the binary** — and ask it
directly: `grove config` prints what it actually resolved, `grove version`
prints the commit and date that say how old it is.
