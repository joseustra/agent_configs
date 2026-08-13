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

- **`omp-danger-guard.ts`** — policy gate for the `bash`, `write` and `edit`
  tools. Fires even in yolo mode. Three tiers around one spatial boundary:

  | Tier | What | Examples |
  |---|---|---|
  | **allow** (silent) | anything inside the **session root** (`ctx.cwd`), and any git/GitHub work on a non-protected branch | `rm -rf _build`, `rm -rf src/*`, `git reset --hard`, `git rebase`, force-push a feature branch, `gh pr create`, `gh issue comment` |
  | **confirm** | leaves the machine, touches another person, or escapes the root | `rm` outside the root, push to `main`, `npm publish`, `gh pr merge`, `gh release create`, `sudo`, `terraform apply`, secrets heading for a network sink |
  | **block** (no dialog) | unrecoverable, no legitimate agent form | force-push/delete `main`, `rm -rf .git`, `git reflog expire`, `mkfs`/`dd of=/dev/…`, `gh repo delete`, `git push --no-verify` |

  The boundary replaces the old "list every disposable build dir" approach:
  paths are resolved through symlinks and judged by *location*, so there is no
  `_build`/`node_modules` allowlist to maintain. Anything it can't resolve
  statically (`$VAR`, backticks, a dot-glob that could match `.git`) falls to
  **confirm** — it fails closed, never open.

  Block tier gets no dialog on purpose: a prompt you can click through is exactly
  what prompt-fatigue and prompt-injection defeat. Escape hatch is you, in your
  own terminal.

  Before any destructive **allow**, it writes a `refs/danger-guard/<ts>` snapshot
  commit (throwaway index, working tree untouched). That closes the gap in "git
  is my backup" — git recovers *committed* work, and the allow tier can destroy
  uncommitted edits and untracked files. Recover with
  `git log refs/danger-guard/*` then `git checkout <ref> -- <path>`. It respects
  `.gitignore`, which is why deleting a gitignored `.env` is *confirm*, not allow.

  **It is a speed bump, not containment.** It sees a command *string*, so
  `make deploy` / `npm run release` / `bash ship.sh` hide their contents from it.
  The real guarantee about protected branches is
  [`git/githooks/pre-push`](../git/githooks/pre-push) — git enforces that one no
  matter how the push was invoked, which is why the extension blocks agent-issued
  `--no-verify` and `core.hooksPath` overrides.

  Container: same single file. It detects `/.dockerenv` at runtime and switches
  on the sandbox rules (firewall, squid allowlist, read-only host mounts). There
  is no separate container variant to keep in sync any more — the manifest links
  the one file into both places.

  The prompt waits for you indefinitely: omp caps `tool_call` handlers at 30s, so
  the guard keeps ONE dialog open across that cap and blocks each attempt with a
  "re-run to keep waiting" reason until you answer.

  Policy is tested: `make test` (89 cases in
  [`extensions/__tests__`](agent/extensions/__tests__/danger-guard.test.ts)).
  Tune `PROTECTED_BRANCHES`, `SNAPSHOT_BEFORE_DESTRUCTIVE`, and the rule tables at
  the top of the file; add a case to the table when you do.
- **`omp-crew.ts`** — per-project agents view (the "crew"). Spawn named agents
  that run in-process with full tool access, watch them, talk to them:
  - **Ctrl+A** or `/crew` — roster overlay: `↑↓/jk` select, `Enter/→` open the
    detail pane (live output, tokens/cost), `m` message the agent, `n` new
    agent, `Ctrl+R` rename, `Ctrl+X` kill/remove, `Esc` close.
  - Detail pane: `m` message, `o` open the raw transcript, `Esc/←` back.
    Messages are queued if the agent is busy, or wake it for a new turn (full
    history retained) if it's idle. Agents from a previous omp run are
    read-only ("stale").
  - Crew agents can spawn their own subagents (task tool enabled via
    `spawns: "*"`), so an orchestrator agent can fan work out. Children show
    `└`-nested under their parent in the roster: `Enter` opens their
    transcript, `m` messages them; they're killed via their parent.
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
