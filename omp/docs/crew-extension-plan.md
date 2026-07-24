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

### Nested spawns / orchestrator workflow (added 2026-07-24)

Crew agents can spawn their own subagents via omp's task tool, enabling an
orchestrator pattern (one crew agent fans work out to children). Two pieces:

- `AgentDefinition.spawns: "*"` on every crew worker. Without it,
  `spawnsEnv` resolves to `""` and `resolveSpawnPolicy` disables the task tool
  ("Cannot spawn … spawns disabled for this agent" — confirmed live).
  Recursion depth is still capped by omp's `task.maxRecursionDepth` (default 2).
- The overlay mirrors those children: nested spawns register in the global
  `AgentRegistry` with `parentId` = the spawning agent's id
  (`structured-subagent.ts:430`), so the list view renders a `└`-indented
  subtree under each crew agent (status + activity gist from the registry).
  `Enter` on a child opens its transcript (`ref.sessionFile`), `m` queues a
  message on its live session; rename/kill stay crew-only (children are owned
  by their parent's task call). A 1 s repaint timer keeps child rows live —
  their progress otherwise only surfaces through the parent's `onProgress`.

### Full-height overlay (added 2026-07-24)

`showHookCustom` already mounts extension overlays with `width: "100%"`,
`maxHeight: "100%"`, `anchor: "bottom-center"`, `margin: 0`
(`modes/controllers/extension-ui-controller.ts`), so the view's height is simply
however many lines `render()` returns — it looked cramped only because it
returned a handful. Both panes now pad to `process.stdout.rows - 1` (top-aligned,
hints pinned to the last row). The list windows rows around the selection with
`… N more above/below` markers (same idea as the built-in Agent Hub), and the
detail pane's output tail grows to fill whatever the header leaves instead of a
fixed 14 lines. The existing 1 s repaint timer also covers terminal resizes.

Not used: `OverlayOptions.fullscreen` (alt-screen buffer) — the extension API
only exposes `{ overlay?: boolean }`, so that flag isn't reachable without
calling `tui.showOverlay` behind the controller's back.

### "Where am I?" indicator (added 2026-07-24)

Entering an agent (`o` in the detail pane) calls `ctx.switchSession`, which
loads that transcript into the **main** session: `AgentSession.switchSession`
replaces the message history and restores the model from the file, but keeps
your own system prompt (the only `#baseSystemPrompt` assignment on that path is
the rollback in the `catch`). So typing afterwards runs *your main agent* over
the worker's history — it does not talk to the worker process. Messaging the
worker itself is `m` (queue / follow-up turn), which is a different thing
entirely. Nothing on screen distinguished the two.

Now tracked via `session_before_switch` (carries `targetSessionFile`) plus
`session_switch` (carries `previousSessionFile`): if the target matches a roster
agent, a registry child, or any file in `.crew/sessions/`, the widget gains a
second line naming the transcript you are in, the list marks that row
"◂ your prompt is here", and `/crew back` switches to the session you came from
(anchored on the first hop, so crew→crew hops don't lose the way home).

### Attach-to-agent chat (added 2026-07-24)

The `m` (message) / `o` (open transcript) split was the wrong model: `m` sent
into a session whose output you couldn't see, and `o` (`switchSession`) showed
the transcript but answered from your main agent. Enter now **attaches** instead.

omp's own in-hub chat component, `AgentTranscriptViewer`
(`modes/components/agent-transcript-viewer.ts`), renders an agent's live
transcript with an `Editor` underneath; submitting calls
`session.prompt(text, { streamingBehavior: "steer" })` — steers a mid-turn agent,
prompts an idle one. The crew overlay mounts that component directly, so Enter on
any row (crew agent or nested child) is a normal conversation with that agent,
Esc/ctrl+a returns to the roster.

Two seams made this reachable:

- The component is at a *declared* subpath (`./modes/components/*` in
  `packages/coding-agent/package.json`), unlike `./registry/*`. It's still not
  the sanctioned ExtensionAPI, so the import is **dynamic + try/catch** and a
  failure degrades to the old read-only pane instead of breaking the extension.
- Sending needs an `AgentLifecycleManager` (`./registry/*`, unreachable). Crew
  passes a shim whose `ensureLive(id)` returns `registry.get(id).session` —
  enough because `runSubprocess` keeps workers registered after they finish.
  It can't revive a *parked* agent, which the real manager would.

Because those turns bypass `trackRun`, roster status can lag; `effectiveStatus()`
prefers the registry's `running` over our own bookkeeping when rendering.

**First-party alternative (no extension code):** crew workers register in the
global `AgentRegistry`, so omp's built-in Agent Hub (`app.agents.hub`, default
`alt+a`; also `ctrl+s` / ←← on an empty prompt) already lists them, and Enter
there calls `SessionFocusController.focusAgent` — a *true* attach that rebinds
the main editor/transcript/status to the agent's session, with ←← to detach.
That's stronger than the embedded viewer, but `focusAgentSession` is not on
`ExtensionCommandContext`, so crew cannot trigger it.

### Main-prompt parity (added 2026-07-24)

The viewer's editor is a bare `new Editor(...)` with no autocomplete, so typing
in the crew chat lost @file completion. It's a `#private` field, so crew patches
`Editor.prototype.setMaxHeight` for the duration of the viewer's constructor
(the one call it makes on the fresh editor) and attaches pi-tui's own
`CombinedAutocompleteProvider` — the class the main prompt's provider is built
on — then restores the prototype in a `finally`. Cheeky, but contained, and it
reuses omp's provider instead of hand-rolling completion.

Still not full parity: prompt history (ctrl+r), image paste, queue mode and
slash commands belong to the main editor's controller, not the `Editor` class.

`enableLsp: false` was also dropped from the spawn: a crew agent should be as
capable as a fresh omp session, and LSP/MCP/IRC all default on.

**The real parity path is `alt+a`.** `SessionFocusController.focusAgent` binds
the actual main editor AND the main transcript to an agent's session — literally
"a second omp instance" on the same screen, with every prompt feature. Crew
agents already appear there. If that's the desired daily flow, rebind
`app.agents.hub` to `ctrl+a` in `~/.omp/agent/keybindings.yml` and let crew keep
`/crew` for spawning, roles, rename and kill.

### Features → agents (added 2026-07-24) — crew as manager, hub as the way in

Settled shape of the tool, from how it's actually used:

```
▍ checkout flow      2 working · 1 done
  ◐ research      running 4m  ▸ read src/checkout.ts
  ◐ grilling      running 2m
  ● prototype     done 6m  12k tok · $0.04
▍ search revamp     1 working
  ◐ grilling      running 1m
    └ ◐ sub-2     running · scanning indexers
```

`CrewAgent.group` is the top level (persisted in `crew.json`); `/crew new` asks
for the feature first, picking from existing ones or starting a new one. Headers
are labels — the cursor steps over them — and carry a per-feature status tally.
The feature also goes into `AgentDefinition.name`
(`checkout-flow-research`), which is what omp's hub shows as `displayName`
(`agentDisplayName: agent.name`, `task/executor.ts:2609`), so the grouping is
legible from the hub too.

**Division of labour.** Crew owns the board: features, spawning with roles,
status, rename, kill, persistence. Going *inside* an agent is `ctrl+s` →
Enter — omp's Agent Hub, whose `focusAgent` binds the real editor and the real
transcript to that agent's session. Crew's embedded chat stays as a quick
in-place reply, but it is deliberately the lesser path; anything that needs the
full prompt (history, images, slash commands) should go through the hub.

Crew cannot open that attach itself — `focusAgentSession` lives on
`InteractiveMode`, not `ExtensionCommandContext`, and nothing bridges them. If
crew should ever *be* the hub, that's an upstream ask: expose
`focusAgentSession` (or a `ui.focusAgent(id)`) on the extension command context.

### Future ideas

- Worktree isolation per agent (omp has `task/worktree.ts` internally).
- Steer (interrupting) vs follow-up (queued) choice when messaging a busy agent.
- Auto-chain (start review when implementation completes).
