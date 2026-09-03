# agent_configs

One repo for the configs of every coding agent I use — Claude Code, oh-my-pi (omp),
and OpenCode — instead of a scatter of dotfolders, some in git and some not. A `Makefile`
**symlinks** the shared config into each tool's real location and **seeds** the per-host /
secret files from templates.

## Layout

```
claude/            -> ~/.claude/         (CLAUDE.md, statusline.mjs, skills/, agents/, commands/; settings.json.example seed)
omp/               -> ~/.omp/            (agent/config.yml, agent/commands/, agent/agents/, agent/extensions/omp-danger-guard.ts; .env.example seed)
opencode/          -> ~/.config/opencode (opencode.json)
pi-devcontainer/   -> ~/.pi-devcontainer (settings.json; per-host model overlays)
manifest             the source -> target map make follows
Makefile             install / status / uninstall / doctor
```

## How it works

Three kinds of entries in `manifest`:

- **`link`** — `make install` symlinks the target back to the file in this repo. Single
  source of truth: edit here, every tool sees it instantly. An existing real file is moved
  to `*.bak` once, then replaced by the symlink.
- **`linkkids`** — the target is a **real directory**; each child of the repo dir is
  symlinked into it individually. Used for `skills/`, `agents/`, and `commands/`. This is
  what makes per-machine customization work: drop a machine-only skill or agent straight
  into `~/.claude/skills/` (etc.) as a plain directory and it lives alongside the linked
  ones without ever touching the repo. Links whose repo source was deleted are pruned on
  the next `make install`; `make status` reports linked / unlinked / local counts.
- **`seed`** — per-host or drifting files (`models.json`, `models.yml`,
  `claude/settings.json`). `make install` copies the `*.example` template into place
  **only if the target is absent** — it never overwrites your real file — and `chmod`s
  secrets to `600`. The repo only ever holds the `.example`; local edits (switching
  models, enabling plugins) never flow back into git. If the template gains something you
  want, merge it into your local file by hand.

## Per-machine customization

- **Skills / agents / commands**: create them directly in `~/.claude/skills/<name>`,
  `~/.claude/agents/<name>.md`, `~/.claude/commands/<name>.md`.
  Plain files and dirs there are local to the machine; symlinks are the shared base from
  this repo. To promote a local skill into the shared base: move it into `claude/skills/`
  here, commit, and re-run `make install` (it becomes a symlink in place).
- **Claude Code settings**: `~/.claude/settings.json` is yours per machine (seeded once
  from `claude/settings.json.example`). Deliberate shared changes go into the `.example`.

## Usage

```bash
make install     # symlink shared config; seed per-host files if missing
make status      # show each managed path: ok-link / missing / not-a-link / seeded
make uninstall   # remove our symlinks (restore *.bak); leaves seeded files alone
make doctor      # verify no secret/per-host file is tracked; list missing seeds
```

`make install` is idempotent — re-run it after editing the manifest or moving the repo.

## omp context gauge

`omp/agent/extensions/omp-context-gauge.ts` draws the context window as raw tokens —
`47K/1M █████░░░░░░░░░░░` — on a row below the editor, and `config.yml` sets
`statusLine.contextLine: percentage` with a custom preset (omp's `default` minus
`context_pct`/`context_total`) so the bar keeps its usage-colored line but no longer
prints `9%` / `1M`.

It is a separate row because the status line is closed to extensions: the gauge label is
hardcoded in `formatEmbeddedContextPercent`
(`packages/coding-agent/src/modes/components/status-line/component.ts` upstream), the
segment registry is internal, and the extension UI only offers `setStatus` (rows under
the bar), `setWidget` (a component above/below the editor) and `setEditorComponent`.
Colors mirror omp's own `getContextUsageLevel` thresholds — a level trips on a
percentage *or* an absolute token count, whichever comes first, so a 1M window warns on
absolute burn well before 50%. The widget appears once the session initializes, not on
the pre-session welcome screen.

## Secrets & per-host files

Never committed: `auth.json` (written by the tools at login), `models.json` /
`models.yml` (point at local servers + carry an API key), `.env` (the seeded
`~/.omp/agent/.env` may carry an API key), anything `*.key` / `*.pem`.
`.gitignore` enforces this and `make doctor` is the backstop. On a fresh machine,
`make install` seeds these from the `.example` templates — fill in the real values, then
`pi login` / `claude login` etc. for auth.

## New machine

```bash
git clone git@github.com:joseustra/agent_configs.git ~/Developer/agent_configs
cd ~/Developer/agent_configs && make install
# then edit the seeded ~/.omp/agent/models.yml etc. with real endpoints/keys,
# and log each tool in (claude login, ...)
```

## Relationship to the devcontainer

The devcontainer repo (`thesidejourney/devcontainer`) **bind-mounts** `~/.omp/agent/config.yml`
and `~/.omp/agent/extensions-container/omp-danger-guard.ts` into the container (its Makefile
resolves the symlinks here via `realpath`), so the omp danger-guard runs in the container too.
That path is now a second symlink to the *same* guard file as the host one: the guard detects
`/.dockerenv` at runtime and enables its sandbox-specific rules itself, so there is no separate
container variant to keep in sync. The devcontainer repo needs no change. The per-host model
overlays in `~/.pi-devcontainer/` (`host.internal` endpoints) are likewise mounted in. Nothing
omp-related is baked into the image anymore.

## Guardrails

Two layers, deliberately separate:

- **`omp/agent/extensions/omp-danger-guard.ts`** — the UX layer. Reads each `bash`/`write`/`edit`
  tool call and sorts it into allow / confirm / block around one boundary: the session root.
  Inside it the agent works freely; outside it, or anywhere the command can't be pinned to a
  location, it asks. Details in [`omp/README.md`](omp/README.md).
- **`git/githooks/pre-push`** — the guarantee. The extension only sees command *strings*, so
  `make deploy` or `bash ship.sh` hides a push from it. This hook is enforced by git itself and
  refuses direct, force, and delete pushes to `main`/`master`/`develop`/`production`/`release/*`
  however the push was invoked. `make install` points global `core.hooksPath` at `~/.githooks`.
  Override is yours alone: `git push --no-verify` (the extension blocks agent-issued ones).

A repo that sets its own `core.hooksPath` (husky, lefthook) shadows the global hook — in those
repos the extension is the only layer.
