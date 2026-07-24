# omp-crew — per-session agent roster for oh-my-pi

**Status:** implementing vertical slice · **Date:** 2026-07-24 · **omp version verified against:** v16.1.19 (tag checked out from can1357/oh-my-pi)

## Goal

Reproduce the Claude Code "Agents View" workflow inside omp: from a project folder,
spawn named agents (research / implementation / review / …), watch them in a central
view (running vs completed), enter a finished agent's session to keep talking to it,
create new agents, rename and kill them.

omp's built-in Agent Hub (`ctrl+s`) lists agents the *model* spawns via the Task tool,
but its live registry (`AgentRegistry`), `focusAgentSession`, and kill are internal —
not reachable from extensions. So crew takes the "own the roster" approach: every
agent is spawned *by the extension*, which therefore owns names, statuses, kill,
rename, and session files outright.

## Verified API surface (v16.1.19)

All confirmed by reading the tagged source; the compiled binary remaps
`@oh-my-pi/*` imports in user extensions to its bundled modules
(`extensibility/plugins/legacy-pi-compat.ts`, covers pi-coding-agent, pi-tui,
pi-utils, pi-ai, pi-agent-core, pi-natives).

| Need | API | Where verified |
|---|---|---|
| Spawn an in-process agent | `runSubprocess(options: ExecutorOptions): Promise<SingleResult>` — exported from package root (`export * from "./task/executor"`) | `task/executor.ts:1695`, `index.ts:56` |
| Worker session transcript | `artifactsDir` option ⇒ session JSONL at `<artifactsDir>/<id>.jsonl` | `task/executor.ts:1742-1744` |
| Live progress | `onProgress(p: AgentProgress)` — status, lastIntent, currentTool, recentTools, recentOutput, tokens, cost, durationMs | `task/types.ts:261` |
| Kill | `signal: AbortSignal` per spawn | `ExecutorOptions.signal` |
| Full-screen view | `ctx.ui.custom<T>(factory, { overlay: true })` — factory `(tui, theme, keybindings, done)` returns a `Component` (`render(width)`, optional `handleInput(data)`) | `extensions/types.ts:214`, `docs/tui.md` |
| Keys inside the view | `matchesKey(data, "enter"/"up"/"ctrl+r"/…)` from `@oh-my-pi/pi-tui`; live refresh via `tui.requestRender()` | `tui/src/keys.ts:547`, `tui/src/tui.ts` |
| Opener keybinding | `pi.registerShortcut(keyId, { handler })` — typed `ExtensionContext`, but interactive mode passes `runner.createCommandContext()`, so `switchSession` IS available (cast) | `input-controller.ts:1647-1666` |
| Enter a finished agent | `ctx.switchSession(sessionPath)` on `ExtensionCommandContext` | `extensions/types.ts:394` |
| Model/auth plumbing | `modelRegistry: ctx.modelRegistry`, `settings: pi.pi.settings` (same as first-party swarm-extension) | `swarm-extension/src/extension.ts:150-151` |
| Status widget above editor | `ctx.ui.setWidget(key, lines \| undefined)` | `extensions/types.ts:202` |

## Design

Single file: `omp/agent/extensions/omp-crew.ts` (canonical here, shipped to
`~/.omp/agent/extensions/` like omp-danger-guard).

### State

- In-memory roster `Map<id, CrewAgent>`: name, task, status
  (`running | done | failed | aborted | stale`), timestamps, `AbortController`,
  latest `AgentProgress`, `SingleResult`, session file path.
- Persisted metadata (no live handles) at `<cwd>/.crew/crew.json` for traceability
  across omp restarts. On reload, previous `running` entries become `stale`
  (in-process agents don't survive the host); their session files remain enterable.
- Worker sessions at `<cwd>/.crew/sessions/<id>.jsonl` (via `artifactsDir`).

### Interactions

- **Ctrl+A** or **/crew** → roster overlay:
  - `↑/↓/j/k` select · `Enter/→` open · `n` new agent · `Ctrl+R` rename ·
    `Ctrl+X` kill/remove · `Esc/q` close
  - `Enter` on a **running** agent → live detail pane (lastIntent, current tool,
    recent output tail, tokens/cost), refreshed from `onProgress` via
    `tui.requestRender()`; `Esc/←` back to list.
  - `Enter` on a **finished** agent → `switchSession` into its transcript; the main
    prompt becomes that agent's session (get back with omp's session picker/resume).
  - Rename/new/kill run as dialogs (`ui.input`/`ui.editor`/`ui.confirm`) after the
    overlay closes, then the overlay reopens (loop) — keeps the component dumb.
- **/crew new** → name → task (multiline editor) → optional model → spawn.
- **/crew status** → one-shot summary notification.
- Widget above the editor summarizes the roster while agents exist; completion
  also fires `ui.notify`.

### Deliberate limits (v1)

- Only sees crew-spawned agents, not omp's own Task-tool subagents (by design).
- Left-arrow-on-empty-prompt opener not possible without replacing the editor
  component; Ctrl+A instead. (Note: shadows emacs-style beginning-of-line in the
  prompt editor — one-line change in the file if that hurts.)
- No messaging a *running* agent (watch-only); possible later via the in-process
  `AgentSession` handle.
- Concurrency/quota management is the user's concern (explicit decision).

### Risks

- `runSubprocess` and `ExecutorOptions` are package exports, not the sanctioned
  `ExtensionAPI` — same de-facto-supported path the first-party swarm extension
  uses, but an omp upgrade can break it. This file is verified against v16.1.19;
  re-check `task/executor.ts` on major bumps.
- `registerShortcut` handler context is *typed* `ExtensionContext`; the cast to
  `ExtensionCommandContext` relies on interactive mode's current behavior
  (`input-controller.ts:1654`).

### Role presets (added 2026-07-24)

Reusable role definitions at `<agent-dir>/crew-roles/*.md` (profile-aware via
`getAgentDir()`; canonical copies in `omp/agent/crew-roles/`, linked by the
manifest as `linkkids`). Frontmatter: `description` (shown in the role picker),
`model` (per-role model override). Body: the agent's system prompt. `/crew new`
starts with a role picker (plus a "blank agent" option that behaves like v1);
a role supplies system prompt + model, defaults the agent name (`review`,
`review-2`, …), and leaves only the task to type. Starter roles: research
(writes `docs/research/`, never edits code), implement (builds + verifies),
review (writes `REVIEW.md`, never edits code).

### Follow-up messaging (added 2026-07-24)

Crew agents are fully interactive, not fire-and-forget. `runSubprocess` keeps the
worker's `AgentSession` registered after it finishes (`keepAlive` defaults to
true), so "done" really means idle-and-revivable. In the overlay, `Enter` always
opens the detail pane and `m` (list or detail) composes a message:

- **running** → the live session is fetched from the global `AgentRegistry` and
  the text is queued via `session.prompt(text, { streamingBehavior: "followUp" })`
  (consumed after the current work; non-interrupting).
- **idle (done/failed)** → `runSubagentFollowUpTurn({ id, agent, message })`
  revives the session and runs a full monitored turn with the text as the user
  prompt, retaining all history. Completion is tracked exactly like the initial
  run (same `trackRun` bookkeeping).
- **stale** (previous omp run) → in-memory session is gone; read-only, `o` opens
  the transcript.

Import caveat (compiled binary): extensions can only resolve the package root
plus *declared* subpath exports — the `./*` catch-all is NOT expanded into the
bundled virtual modules (`scripts/legacy-pi-virtual-module.ts`: "root
catch-alls stay out"). `./registry/*` and `./irc/*` are not declared, so
`AgentRegistry` is reached indirectly via the declared `./modes/*` helper
`getRunningSubagentBadgeRegistry(undefined)` → `AgentRegistry.global()`.
`runSubagentFollowUpTurn` is a root-barrel export.

### Future ideas

- Worktree isolation per agent (omp has `task/worktree.ts` internally).
- Steer (interrupting) vs follow-up (queued) choice when messaging a busy agent.
- Auto-chain (start review when implementation completes).
