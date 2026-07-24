# omp (oh-my-pi) customizations

Everything omp-specific lives here and gets wired into `~/.omp/` by the repo's
`Makefile` + `manifest` (run `make install` from the repo root; `make status`
shows the current state). Two wiring modes matter:

- **link / linkkids** — symlinked, so edits here are live immediately.
- **seed** — copied once if absent, never overwritten; per-machine files that
  may hold secrets and are never committed.

## Fresh machine setup

1. Install omp via mise: `mise use -g "github:can1357/oh-my-pi@latest"` —
   **must be ≥ 17.0.9** (16.x has a bug where any extension with a value-level
   `@oh-my-pi/*` import fails to load: "js worker-entry: missing parentPort").
2. `make install` from the repo root.
3. Fill in the seeded per-machine files:
   - `~/.omp/agent/.env` — API keys + streaming/caching knobs (template:
     [`agent/.env.example`](agent/.env.example)).
   - `~/.omp/agent/models.yml` — local model servers (Ollama/MLX) and their
     endpoints (template: [`agent/models.yml.example`](agent/models.yml.example)).

## What's here

### `agent/config.yml` → `~/.omp/agent/config.yml` (link)

Main omp config: `approvalMode: yolo` (the danger-guard extension is the real
safety net — see below), model roles (`plan`/`slow` Opus, `task` Sonnet,
`smol` Haiku, `default` may point at a local omlx/ollama model), disabled
providers, theme.

### `agent/extensions/` (linked per-file)

- **`omp-danger-guard.ts`** — argument-aware confirmation gate for the `bash`
  tool. Inspects the command string and asks for confirmation only on risky
  patterns (rm, dd/mkfs, git push/reset --hard/clean, sudo, secret-file paths,
  curl|sh, package publish, mutating `gh`/`acli` verbs, …). Fires even in yolo
  mode; blocks (fail-closed) when there's no UI to ask. Tune by
  commenting/adding rules in the file.
- **`omp-crew.ts`** — per-project agents view (the "crew"). Spawn named agents
  that run in-process with full tool access, watch them, enter them:
  - **Ctrl+A** or `/crew` — roster overlay: `↑↓/jk` select, `Enter/→` open
    (running → live detail pane; finished → switch into its session),
    `n` new agent, `Ctrl+R` rename, `Ctrl+X` kill/remove, `Esc` close.
  - `/crew new` — role picker → name → task. `/crew status` — quick summary.
  - State in `<project>/.crew/` (self-gitignoring; also in `~/.gitignore`):
    `crew.json` roster + `sessions/<id>.jsonl` transcripts.
  - Design + verified-API notes: [`docs/crew-extension-plan.md`](docs/crew-extension-plan.md).
    Uses `runSubprocess` from omp's package exports (not the sanctioned
    extension API) — re-verify on major omp upgrades.

### `agent/crew-roles/` → `~/.omp/agent/crew-roles/` (linkkids)

Reusable role presets for crew agents. One markdown file per role: frontmatter
`description` (shown in the picker) and `model` (per-role override), body =
system prompt. Starter roles:

| Role | Model | Behavior |
|---|---|---|
| `research` | Sonnet | Investigates, writes `docs/research/<topic>.md`, never edits code |
| `implement` | Opus | Builds end-to-end, verifies (mix compile/format/test for Elixir) |
| `review` | Opus | Reviews a diff, writes `REVIEW.md` with `file:line` findings, never edits code |

Add a `.md` file here (committed, synced) or directly in
`~/.omp/agent/crew-roles/` (machine-local) — picked up on next `/crew new`.

### `agent/agents/` → `~/.omp/agent/agents/` (linkkids)

Subagent definitions for omp's Task tool — cheap-model runners that keep noisy
output out of the main context:

- **mix-runner** — Elixir/mix build+test commands, compact pass/fail summary.
- **apple-runner** — xcodebuild/swift/simctl/fastlane, compact summary.
- **tracker-runner** — Jira (`acli`) and GitHub (`gh`) reads/writes; executes
  exact CLI calls, returns key/URL/state instead of raw JSON.
- **web-searcher** — web research on a cheap model, synthesized answer + URLs.

These mirror the same-named agents used in Claude Code (`claude/agents/`), so
delegation habits carry over between harnesses.

### `agent/commands/` → `~/.omp/agent/commands/` (link)

Slash commands. Currently **`/plan-build`** — plan on the high-end model, then
delegate execution to cheaper subagents.

### `docs/`

Design docs (not linked anywhere): currently the crew extension plan, which
doubles as the record of which omp internals were verified against which
version.

## Debugging

- Extension load failures: `~/.omp/logs/omp.<date>.log`, search
  `"Failed to load extension"`.
- Verifying omp internals: clone `can1357/oh-my-pi`, check out the tag matching
  `omp --version`, read the source (key areas: `packages/coding-agent/src/task/executor.ts`,
  `src/extensibility/extensions/types.ts`, `docs/extensions.md`, `docs/tui.md`).
