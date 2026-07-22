---
description: Plan a task on the high-end model, then delegate execution to cheaper subagents
argument-hint: <what you want built or changed>
---

# Plan, then build

Goal: $ARGUMENTS

If nothing was given above, ask what to build before doing anything else.

You are the **orchestrator**, running on the high-end model. Your job is to do the expensive
thinking yourself — planning, decomposition, integration, review — and to push the cheap,
mechanical execution down to smaller models through subagents. Spend the high-end tokens on
judgement, not on boilerplate. You choose the *agent*; the `modelRoles` config picks the *model*
(`task` → Sonnet, `smol` → Haiku, `plan`/`slow` → the high-end model).

## 1. Plan — you, on the high-end model

- Investigate enough to plan concretely, but delegate pure read-only scouting to `explore`
  (runs on the cheap `smol` model) so discovery doesn't burn high-end tokens. Read the specific
  files and callsites the change touches yourself.
- Produce a concrete plan: the change, the exact files/symbols affected, the order of work, and
  how each part will be verified. Break it into the **smallest independent units** that can run
  in parallel.
- Write the plan to `local://plan.md`, show it, then use `ask` to get my approval or edits.
  **Do not touch code until I approve.**

## 2. Delegate execution — cheaper subagents

Once approved, fan the units out, matching each to the cheapest agent that can do it well:

- **`quick_task`** (Haiku) — strictly mechanical, single-file, no judgement: renames, moves,
  mechanical edits, data collection, running a known command.
- **`task`** (Sonnet) — self-contained multi-step implementation that needs some reasoning but
  not deep architecture.
- **`oracle`** (high-end) — reserve for genuinely hard reasoning only: subtle bugs, design
  forks, anything where a wrong call is expensive.

Rules for delegation:

- Run independent units in parallel — one `task` call with several items, or several calls.
  Sequence only when one unit's output is another's input.
- Give every subagent a self-contained assignment: exact files, exact change, and acceptance
  criteria. Tell them to **skip** project-wide build/lint/format — you run those once at the end.
- Subagents don't verify or format. That's your job in step 3.

## 3. Integrate & verify — you

- Review each subagent's diff against the plan. Fix or re-delegate anything that's wrong.
- Run the build / typecheck / tests / lint **once**, over the union of changed files.
- Report what changed, what was verified, and anything still open.
