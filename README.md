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
and `~/.omp/agent/extensions/omp-danger-guard.ts` into the container (its Makefile resolves
the symlinks here via `realpath`), so the omp danger-guard runs in the container too — same
single source as the host. The per-host model overlays in `~/.pi-devcontainer/` (`host.internal`
endpoints) are likewise mounted in. Nothing omp-related is baked into the image anymore.
