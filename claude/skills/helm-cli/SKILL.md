---
name: helm-cli
description: Create and manage Helm sessions, splits and projects from the shell with the `helm-cli` command — new/ls/rm/projects/current/prompt/warm/close. Use whenever a session needs to be created for an agent to work in, when an agent needs to be started in a session from a script, when a finished session needs its shells taken away and its descriptor removed, when asking which project the current pane belongs to, when sending a prompt to another agent's pane, when a session should be displayed as something other than its filename, or when scripting Helm's spool.
---

# Helm CLI

`helm-cli` writes Helm's spool: a session exists because a descriptor exists in
`~/.config/helm/sessions/<name>.json`, and this is what puts one there. Helm
notices within a second, **without taking focus** — nothing here opens a window,
and a session created this way stays cold until someone enters it.

It also speaks to a *running* Helm over `~/.config/helm/mcp.sock`, which is what
`prompt`, `warm` and `close` use — typing into another agent's pane, and giving
a session its shells or taking them away. Two doors, and they are not
interchangeable: the spool is what a session *is*, the socket is *do this now*.

Find the binary (first match wins):
1. `~/.local/bin/helm-cli`
2. `/Applications/Helm.app/Contents/MacOS/helm-cli`
3. `.build/debug/helm-cli` in a Helm checkout

## Ask where you are before you create anything

This is the rule that matters. Sessions belong to projects, and a project is
just a word several sessions share. If you create a session without asking, you
invent a new project of one instead of joining the one you are already in.

```sh
helm-cli current --project      # → helm
helm-cli new api-review --project "$(helm-cli current --project)"
```

`current` answers from `HELM_SESSION`, which Helm sets when it spawns a pane's
shell, so **inside a pane the answer is read, not guessed**. Outside one it falls
back to matching the working directory against session directories, nearest
session wins. `current` reports which of the two it used as `source: pane` or
`source: directory`.

Exit 1 from `helm-cli current --project` means there is no project to join —
create without `--project` rather than passing an empty string.

## Commands

| Command | Notes |
|---|---|
| `helm-cli new [name] [--dir PATH] [--project WORD] [--label WORD] [--pane CMD [--title T] [--width N]]...` | name defaults to the directory's basename, `--dir` to the working directory; prints the descriptor's path |
| `helm-cli ls [--project WORD] [--json]` | every session, alphabetical |
| `helm-cli rm <name>` | removes the descriptor and its comments; **never the directory, and never a shell** |
| `helm-cli projects [--json]` | the words in use, and how many sessions name each |
| `helm-cli current [--project] [--address] [--json]` | where you are standing |
| `helm-cli prompt <session[:pane]> <line>` | types a line into a pane and presses Return |
| `helm-cli prompt <session[:pane]> --file PATH` | the same, with the line read from a file |
| `helm-cli warm <session>` | gives a cold session its shells, showing nothing |
| `helm-cli close <session>` | takes them away again — the descriptor survives |
| `helm-cli help` | full usage |

Exit codes: **0** done or found · **1** nothing to report · **2** refused ·
**3** the arguments were not a command.

Pass `--json` when parsing; the default output is for people.

## Standing a worker up from a script

A session written here is **cold**: a descriptor and no shells. A prompt aimed at
a cold session exits 0 and types nowhere, because there is no pane to type into.
`warm` is what gives it one.

```sh
grove new 259-thing                                        # a workspace
helm-cli new feature --dir … --project "$(helm-cli current --project)"
helm-cli warm feature                                      # shells, no window
helm-cli prompt feature:1 'claude'                         # start the agent
helm-cli prompt feature:1 "start on #259, reply to me at $(helm-cli current --address)"
```

**There is no separate "send a command" verb, and none is needed.** `prompt` is
keystrokes into a pane, so a shell receiving `claude` starts Claude exactly as a
running agent receiving a sentence gets a prompt. The pane need not hold an agent.

**Both lines name `:1`, and the first one has to.** The pane-less form resolves to
the most recently reporting agent pane, and a freshly warmed session has none — a
bare shell has never reported, so there is no target, and the line is dropped
while `prompt` still exits 0. Name the pane until something in that session is
reporting; a row `warm` builds from a one-pane descriptor is pane 1, and nothing
has split it yet.

`warm` spawns shells and **runs nothing**. A `--pane` command in the descriptor
is still only offered on a key, as it is after a relaunch; whatever should run is
typed in. It takes a session and never `session:pane` — a session goes warm
whole. Warming one that is already warm does nothing and is not an error, and
exit 0 claims what it claims for `prompt`: Helm took the line.

### Wait after `warm`, then verify. Do not re-send blind.

**A prompt into a just-warmed session can arrive half-typed.** `warm` returns
before the shell is ready to read, and a line typed into a shell still starting
up loses characters from the middle — observed, not theoretical: `claude "read
/tmp/orchestrator-skill-brief.md …"` arrived as `claude Read /tmp/orche…` and the
shell ran the corruption, starting a process against a path that does not exist.

This is the one place Helm's usual advice does not hold. Everywhere else a nudge
either lands or is swallowed, so sending again is free. Here the first line may
have **already started something**, and the second line becomes input to that
rather than a fresh command.

So:

```sh
helm-cli warm feature
sleep 4                                  # let the shell finish starting
helm-cli prompt feature:1 'claude "…"'
ps -axo pid,command | grep '[c]laude'    # confirm the line arrived whole
```

Four seconds makes it unlikely, not impossible — there is no readiness signal to
wait on, so **the check is what makes it safe**. If the line arrived mangled,
kill what it started before sending anything else. Keep the line short: less text
is less to corrupt, and a long brief belongs in a file the prompt names.

## Retiring a session when the work is done

```sh
helm-cli close feature          # the shells
helm-cli rm feature             # and then the descriptor
```

`close` is `warm` backwards, over the same socket: it frees the session's panes,
ends whatever was running in them, and leaves the descriptor exactly where it is.
The session is **cold**, not gone — warming it again rebuilds its shape from the
file, and there is no third state here either. It takes a session and never
`session:pane`, for the reason `warm` does: a session goes cold whole. Closing
one that is already cold does nothing and is not an error.

**`close` is the only thing here that ends a process, and `rm` is not one.**
Deleting a descriptor deletes a file. A session with shells in it deliberately
outlives its descriptor, because a script removing a file is not a script asking
for somebody's agent to be killed — so `rm` on a warm session leaves a row on
Helm's dashboard that `helm-cli ls` no longer lists. That is honest and it is
almost never what the caller wanted. **Say `close` first.**

This is the end of the loop that `new`/`warm`/`prompt` begins, and the shape a
script that dispatches work should finish with:

```sh
helm-cli close "$session" && helm-cli rm "$session"
grove destroy "$workspace"
```

Order matters in one direction only: `close` before `rm`, because after `rm`
there is still a name to close but no descriptor to say what was closed. Nothing
stops you closing a session and keeping its descriptor — that is a session put
back in the drawer, ready to be warmed again.

A session whose last shell exits on its own goes cold without being asked, so a
worker that ends by exiting its own shell needs no `close` — only the `rm`.

## Talking to another agent

```sh
helm-cli current --address                                   # → ui-work:1
helm-cli prompt api-review 'review the diff, reply to me at ui-work:1'
```

`prompt` produces exactly the keystrokes the diff's **Send** button produces: the
line, then Return. Name a pane (`api-review:2`) or name only the session, in
which case Helm picks the pane Send would have picked — the most recently
reporting agent pane.

The pane-less form is for a session where an agent is **already running**, which
is what the send-target rule needs to pick anything. Send greys itself out in
that state; `prompt` cannot, so it types nowhere and exits 0. Anything aimed at a
session before its agent starts names its pane.

`current --address` prints this pane's address, which is the thing to hand
another agent so it can answer you. It is read from `HELM_PANE` and **never
inferred**: outside a pane there is no address, and a guessed pane number is a
reply delivered to a stranger. Exit 1 means you are not in one.

**An address is good for this run of Helm, not forever.** The pane number is a
serial handed out at open or split and is not recorded in the descriptor, so the
same string can point elsewhere after a relaunch. Use an address you were handed
during the exchange; do not write one down for later.

Helm has no reply-to mechanism and does not want one. The address is a word you
put in the sentence; the answering agent runs `helm-cli prompt` back at it. Both
sides of one exchange:

```sh
# asking, from ui-work
helm-cli prompt feature-2 "review the diff in ~/code/api and reply to me at $(helm-cli current --address)"

# answering, from feature-2
helm-cli prompt ui-work:1 'reviewed — two issues, see the comments'
```

There is no blocking form and no waiting. `prompt` types and returns; a reply
arrives in your pane as keystrokes, during your own turn, exactly as if someone
had typed it.

### What exit 0 claims

**That Helm took the line — not that a pane received it.** Nothing is written
back over the socket. A nudge is keystrokes and keystrokes can be swallowed, so
sending again is the recovery path, exactly as it is for Send.

Refusals are the things this side can actually know: a target that is not a
target, a prompt that will not fit, or Helm not listening (exit 2).

### When a prompt exits 0 and nothing happens

Everything the app decides is invisible from here. All of these print the address
and exit 0 while typing nothing:

- **The session is cold.** A session that has not been *entered* in this run of
  Helm has no live pane row, however real its descriptor is. This is the common
  one: `helm-cli warm <session>` first, or open the session in Helm.
- **The pane number is not there.** `feature-2:7` in a two-pane session.
- **No pane has reported**, and you named no pane. The unnamed form needs
  something for the send-target rule to pick; the named form does not. This is
  the other common one, and it is what a warmed-but-not-yet-started session looks
  like: warm and addressable, with nothing in it that has ever reported.
- **A second Helm holds the socket.** There is one `mcp.sock` and it is
  first-come: a Helm that starts while another is running declines to bind and
  has no MCP surface at all. If prompts vanish and agents also stop reporting,
  check for two running Helms before suspecting anything else.

### One line, and mid-turn

A prompt is **one line**. A newline in the middle would be a second Return, which
submits half of it, so an interior newline is refused rather than sent, stripped,
or turned into a space. `--file` reads a file and drops its trailing newline.

Sends are **not queued**. A prompt that arrives mid-turn goes in mid-turn, the
same rule Send follows — waiting for a model to be idle is a per-harness
integration Helm does not take on.

## Splits

Each `--pane` is one column of the session's row, left to right. `--title` and
`--width` attach to the `--pane` in front of them — order carries the
association, so a command may contain colons, spaces or anything else without
escaping.

```sh
helm-cli new api --dir ~/code/api --project helm \
  --pane claude --title agent --width 2 \
  --pane nvim --title editor \
  --pane 'npm run dev' --title server
```

`--width` is a **relative weight, not a size**: `2` and `1` split two thirds to
one. Omit it everywhere and the row shares equally.

Panes stacked *below* one another cannot be written here. A descriptor declares
a row of columns and never a stack — splitting downward is a live gesture in the
app (⇧⌘D) and is deliberately never written back to the file.

## What this cannot do

- **Create a project.** A project is a word on a session, not a file. It exists
  while a session names it and stops existing when the last one stops. `--project`
  on `new` is the whole of creating one; there is nothing to delete.
- **Edit a session.** A descriptor is written once and never rewritten. To change
  `env` or `panes`, edit the JSON directly — the watcher picks it up — or remove
  the session and create it again.
- **Open a session.** Nothing here takes focus or opens a window. `warm` gives a
  cold session shells and still shows you nothing; `close` takes them away
  without showing you anything either.
- **Kill a session's shells with `rm`.** `rm` is a file, `close` is the
  processes. See *Retiring a session* above.
- **Close one pane of a session.** `close` takes a session whole. Closing a
  single pane is a live gesture in the app.
- **Create or remove a directory.** `--dir` is recorded, not made, and neither
  `rm` nor `close` touches the work directory.
- **Name an agent.** There are no nicknames and no registry. An address is the
  pair `(session, pane)` Helm already has, and nothing else.
- **Confirm a prompt arrived.** The socket is one-way. See exit 0's claim above.

## Habits

- A name already in the spool is **refused, never disambiguated** — no `api-2`.
  Pick a different name.
- **Session names are global, not per project.** The descriptor is a file and the
  name is its filename, so two sessions called `feature-1` in different projects
  cannot both exist. That is why an address needs no project component: the
  session name already identifies exactly one session.
- **`--label` is how a session gets a per-project word anyway.** It sets what the
  session is *displayed* as and nothing else, so labels need not be unique and
  every project can hold an `orchestrator`:

  ```sh
  helm-cli new helm --project helm --label orchestrator
  ```

  It never addresses anything — `rm` and `prompt` still take the name, and `ls`
  still prints filenames, because it lists what you can address. `--label` is the
  session's; `--title` is a pane's, and a `--title` before any `--pane` is still
  refused.
- `rm` on a session that is not there exits 0 and says so on stderr. The end
  state is what was asked for either way.
- Writing several descriptors in a loop opens nothing. That is the intended way
  to set up a batch of sessions.
- A session whose descriptor cannot be read still lists, shown with `—`. It is a
  visible row, never a silent absence.
