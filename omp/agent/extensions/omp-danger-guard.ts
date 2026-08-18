/**
 * omp danger-guard — policy gate for the `bash`, `write` and `edit` tools.
 *
 * SINGLE source for host AND container. omp auto-discovers any *.ts under
 * `~/.omp/agent/extensions/`; the devcontainer bind-mounts this same file over its own
 * copy, and the container-only rules switch themselves on by probing for `/.dockerenv`
 * (a file the agent cannot fake from inside a bash command — deliberately not an env
 * var, since the agent writes the env of its own commands).
 *
 * ── The model ────────────────────────────────────────────────────────────────
 * Three tiers and one spatial boundary.
 *
 *   BLOCK   — refused outright, no dialog. A prompt you can click through is exactly
 *             what prompt-fatigue and prompt-injection defeat, so the handful of
 *             genuinely unrecoverable actions never get one. Escape hatch: run it
 *             yourself in your own terminal.
 *   CONFIRM — asks. Reserved for things that leave the machine, touch another person,
 *             or escape the session root.
 *   ALLOW   — silent. Everything else, including all the ordinary destructive work
 *             inside the project: rm, git reset --hard, rebase, force-push a branch.
 *
 * The boundary is the SESSION ROOT (`ctx.cwd`, pinned at first use). Inside it the agent
 * is free, because git plus the snapshot below is the backup. Outside it, or wherever the
 * command can't be statically pinned to a location, it asks — with the system temp dir
 * (see TEMP_ROOTS) as the one other free zone, since it holds nothing worth restoring.
 * This replaces the old
 * "list every disposable build directory" approach — no `_build`/`node_modules` allowlist
 * to maintain, and it generalises to paths that list never covered.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * It is a speed bump, not containment. It sees a command STRING, so `make deploy`,
 * `npm run release` or `bash ship.sh` hide their contents from it. Anything that must be
 * a guarantee lives where git itself enforces it — see `githooks/pre-push` in this repo,
 * which rejects protected-branch pushes no matter how the push was invoked. The rules
 * here are the friendly error message; the hook is the actual promise.
 *
 * ── The 30s handler cap ──────────────────────────────────────────────────────
 * `ExtensionRunner.emitToolCall` races every `tool_call` handler against 30_000ms and
 * blocks the call on expiry, and there is no config knob for it. So a handler cannot sit
 * on `await ctx.ui.confirm(...)` until the human answers. The dialog is therefore opened
 * ONCE per command and outlives the handler: each attempt waits WAIT_MS on that same
 * pending promise, and if unanswered blocks with a re-run instruction so the next attempt
 * resumes waiting on the SAME dialog. Net effect: the run stops at the prompt.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// ── Policy knobs ─────────────────────────────────────────────────────────────

/** Refs nobody pushes to from an agent session. Force-push here is BLOCK, plain is CONFIRM. */
const PROTECTED_BRANCHES: RegExp[] = [/^main$/, /^master$/, /^develop$/, /^production$/, /^release\//];

/** Deleting any of these destroys the backup that makes the whole ALLOW tier safe. */
const VCS_DIRS = new Set([".git", ".jj", ".hg", ".svn", ".worktrees"]);

/** Unrecoverable-by-git files: git isn't backing them up, so deletion is forever. */
const UNBACKED_FILE = /^\.env(\.[\w.-]+)?$|\.(?:pem|key|p12|pfx)$|^\.netrc$|^\.pgpass$/;

/**
 * Scratch roots outside the session root that the agent is free inside anyway: nothing
 * here is meant to survive, so a prompt buys nothing. Both spellings are resolved through
 * symlinks at load, because every operand the guard judges is resolved too — on macOS
 * `/tmp` IS `/private/tmp`, so that is the string the comparison actually sees, and a
 * literal "/tmp" entry alone would match none of it. `$TMPDIR` is deliberately NOT here:
 * on macOS it is a per-user `/var/folders/…` tree that also hosts real scratch workspaces.
 */
const TEMP_ROOTS: string[] = [...new Set(["/tmp", "/private/tmp"].map(realpathDeep))];

/**
 * Write a `refs/danger-guard/<ts>` snapshot commit before allowing a destructive command.
 * Closes the gap in "git is my backup": git recovers COMMITTED work, and the ALLOW tier
 * lets the agent destroy uncommitted edits and untracked files inside the root. Uses a
 * throwaway index, so the working tree and the real index are untouched. Recover with
 * `git log refs/danger-guard/*` then `git checkout <ref> -- <path>`.
 * Respects .gitignore, so ignored files are NOT covered — which is why deleting a
 * gitignored `.env` is CONFIRM above rather than ALLOW.
 */
const SNAPSHOT_BEFORE_DESTRUCTIVE = true;

const IN_CONTAINER = existsSync("/.dockerenv") || existsSync("/run/.containerenv");

// ── Verdicts ─────────────────────────────────────────────────────────────────

type Verdict = { level: "allow" } | { level: "confirm" | "block"; label: string };

const ALLOW: Verdict = { level: "allow" };
const confirm = (label: string): Verdict => ({ level: "confirm", label });
const block = (label: string): Verdict => ({ level: "block", label });

const RANK = { allow: 0, confirm: 1, block: 2 } as const;
const worst = (verdicts: Verdict[]): Verdict =>
  verdicts.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a), ALLOW);

// ── Shell lexing ─────────────────────────────────────────────────────────────
//
// The guard used to split on /\n|;|&&|\|\||[|&]/ and slice operands on whitespace.
// Neither sees quotes, and both failed in the same direction — reading prose as shell:
//
//   git commit -m "fix; rm -rf /"        -> a phantom `rm -rf /` segment  (confirm)
//   git commit -m "use mkfs to format"   -> the mkfs BLOCK rule           (refused!)
//
// A false BLOCK is the worst outcome this design can produce, because block is
// deliberately the one tier with no dialog to click through. So the lexer is not a
// nicety; it is what makes the block tier safe to keep sharp.
//
// It stays IN THIS FILE rather than becoming a tree-sitter dependency: `manifest`
// symlinks this single .ts into place and the devcontainer bind-mounts that same one
// file, so the guard has no package.json to hang a dependency on. See the note in
// `lex` for why an AST would buy nothing here anyway.

/** One operand of a segment, already unquoted. */
type Word = {
  /** The literal value, with quotes and escapes resolved. */
  text: string;
  /** An unquoted `$` or backtick: the value is unknowable, so it can never be vouched for. */
  expands: boolean;
  /** This word is the destination of an output redirect (`>` / `>>`). */
  redirect: boolean;
};

/** Chars that end a word but are not themselves operands. */
const isSpace = (c: string): boolean => c === " " || c === "\t";

/**
 * Split a command into segments of words, honouring quotes, escapes, comments,
 * `$(…)`/backtick substitution, subshells and redirects.
 *
 * A substitution body is absorbed into the surrounding word and flagged `expands`
 * rather than being descended into. That is the whole reason a tree-sitter AST would
 * add nothing here: the guard's answer to "I cannot see this value" is already CONFIRM,
 * so a richer parse of an unknowable operand cannot change any verdict. What it needed
 * was to stop mistaking quoted text for syntax, and that is a lexing problem.
 */
type Lexed = {
  segments: Array<{ text: string; words: Word[] }>;
  /**
   * The command with the CONTENTS of quoted runs and heredoc bodies blanked to spaces,
   * byte-for-byte identical otherwise. The regex tiers read shell SYNTAX; a commit
   * message and a heredoc body are not shell syntax, and the rules have no way to tell
   * on a raw string. Masking lets every rule keep working exactly as written while
   * losing its ability to fire on prose. `secretVerdict` deliberately reads the RAW
   * command instead — a quoted path is still a path.
   */
  masked: string;
};

function lex(command: string): Lexed {
  const segs: Array<{ text: string; words: Word[] }> = [];
  let words: Word[] = [];
  let segStart = 0;

  const mask = [...command];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < mask.length; k++) if (mask[k] !== "\n") mask[k] = " ";
  };

  let buf = "";
  let open = false; // a word is in progress (possibly empty, e.g. `""`)
  let expands = false;
  let redirect = false;
  /** Delimiters of heredocs opened on the current line, awaiting their bodies. */
  const heredocs: string[] = [];

  const pushWord = () => {
    if (!open) return;
    words.push({ text: buf, expands, redirect });
    buf = "";
    open = false;
    expands = false;
    redirect = false;
  };
  const pushSeg = (end: number) => {
    pushWord();
    if (words.length) segs.push({ text: command.slice(segStart, end).trim(), words });
    words = [];
  };

  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];

    // Comment: only at the start of a word, as in a real shell.
    if (c === "#" && !open) {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }

    if (isSpace(c)) {
      pushWord();
      i++;
      continue;
    }

    // Segment separators. `(`/`)` and a standalone `{`/`}` split too, matching the old
    // behaviour of stripping them: a subshell's contents get judged on their own.
    if (c === "\n") {
      pushSeg(i);
      i++;
      // A heredoc body is DATA the command reads on stdin, not shell to be judged.
      // Left in, `cat <<EOF … mkfs … EOF` tripped a BLOCK rule on documentation.
      if (heredocs.length) {
        const bodyStart = i;
        while (heredocs.length) {
          const delim = heredocs.shift()!;
          for (;;) {
            const nl = command.indexOf("\n", i);
            if (nl === -1) {
              i = n;
              break;
            }
            const line = command.slice(i, nl).trim();
            i = nl + 1;
            if (line === delim) break;
          }
        }
        blank(bodyStart, i);
      }
      segStart = i;
      continue;
    }
    if (c === ";" || c === "(" || c === ")") {
      pushSeg(i);
      i += 1;
      segStart = i;
      continue;
    }
    if ((c === "{" || c === "}") && !open && (i + 1 >= n || isSpace(command[i + 1]) || command[i + 1] === ";")) {
      pushSeg(i);
      i += 1;
      segStart = i;
      continue;
    }
    if (c === "&" || c === "|") {
      const two = command.slice(i, i + 2);
      pushSeg(i);
      i += two === "&&" || two === "||" || two === "|&" ? 2 : 1;
      segStart = i;
      continue;
    }

    // Redirects. `2>&1` names no file, and a leading fd digit is not an operand.
    if (c === ">" || c === "<") {
      if (open && /^\d+$/.test(buf)) {
        buf = "";
        open = false;
      }
      pushWord();

      // Heredoc `<<WORD` / `<<-WORD` / `<<'WORD'`. (`<<<` is a here-STRING: the
      // delimiter scan below rejects `<`, so it falls through to normal redirect.)
      if (c === "<" && command[i + 1] === "<") {
        let j = i + 2;
        if (command[j] === "-") j++;
        while (j < n && isSpace(command[j])) j++;
        const q = command[j] === "'" || command[j] === '"' ? command[j++] : "";
        let delim = "";
        while (j < n && (q ? command[j] !== q : /[\w.-]/.test(command[j]))) delim += command[j++];
        if (q && command[j] === q) j++;
        if (delim) {
          heredocs.push(delim);
          i = j;
          continue;
        }
      }

      let j = i;
      while (j < n && (command[j] === ">" || command[j] === "<")) j++;
      let k = j;
      while (k < n && isSpace(command[k])) k++;
      if (command[k] === "&") {
        k++;
        while (k < n && /[\d-]/.test(command[k])) k++;
        i = k;
        continue;
      }
      if (command[k] === "(") {
        i = j; // process substitution — let the `(` split it
        continue;
      }
      i = j;
      if (c === ">") {
        // Mark the NEXT word; `redirect` is cleared by pushWord, so set it after the
        // intervening spaces are consumed.
        while (i < n && isSpace(command[i])) i++;
        open = true;
        redirect = true;
      }
      continue;
    }

    // Quoting.
    if (c === "'") {
      open = true;
      i++;
      const from = i;
      while (i < n && command[i] !== "'") buf += command[i++];
      blank(from, i);
      i++;
      continue;
    }
    if (c === '"') {
      open = true;
      i++;
      const from = i;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < n) {
          buf += command[i + 1];
          i += 2;
          continue;
        }
        if (command[i] === "$" || command[i] === "`") expands = true;
        buf += command[i++];
      }
      blank(from, i);
      i++;
      continue;
    }
    if (c === "\\") {
      open = true;
      if (i + 1 < n) buf += command[i + 1];
      i += 2;
      continue;
    }

    // Substitution: absorbed whole, so its `;` and `&&` cannot split the outer command.
    if (c === "$" && command[i + 1] === "(") {
      open = true;
      expands = true;
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")" && --depth === 0) {
          j++;
          break;
        }
      }
      buf += command.slice(i, j);
      i = j;
      continue;
    }
    if (c === "`") {
      open = true;
      expands = true;
      let j = i + 1;
      while (j < n && command[j] !== "`") j++;
      buf += command.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "$") {
      open = true;
      expands = true;
      buf += c;
      i++;
      continue;
    }

    open = true;
    buf += c;
    i++;
  }
  pushSeg(n);
  return { segments: segs, masked: mask.join("") };
}

// ── Path resolution ──────────────────────────────────────────────────────────

const GLOB_CHARS = /[*?[\]{}]/;

/** Resolve through symlinks as deeply as the path actually exists, keeping the rest literal. */
function realpathDeep(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length ? [realpathSync(head), ...tail].join(sep) : realpathSync(head);
    } catch {
      const parent = dirname(head);
      if (parent === head) return p;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * The absolute, symlink-resolved location an operand names, or null when it cannot be
 * pinned down: shell expansion, command substitution, another user's home, or a glob that
 * could match dotfiles (and therefore `.git`). null always means CONFIRM, never ALLOW.
 */
function resolveOperand(w: Word, base: string): string | null {
  let a = w.text.trim();
  if (!a || a.startsWith("-")) return null;
  // Quoting is already resolved by the lexer, so `'$HOME'` is a literal filename and
  // resolves fine; only a LIVE expansion is unknowable.
  if (w.expands) return null;

  if (a === "~") a = homedir();
  else if (a.startsWith("~/")) a = homedir() + a.slice(1);
  else if (a.startsWith("~")) return null;

  // A glob only reaches inside its own literal prefix, so judge the prefix: `src/*` is
  // `src`. But a glob segment starting with `.` can match `.git`, so refuse to vouch.
  const parts = a.split("/");
  const g = parts.findIndex((p) => GLOB_CHARS.test(p));
  if (g !== -1) {
    if (parts[g].startsWith(".")) return null;
    a = parts.slice(0, g).join("/") || (a.startsWith("/") ? "/" : ".");
  }

  return realpathDeep(isAbsolute(a) ? normalize(a) : resolve(base, a));
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const touchesVcs = (p: string): boolean => p.split(sep).some((c) => VCS_DIRS.has(c));

/**
 * The temp roots that count as free for THIS session. Temp is only free while the
 * workspace lives elsewhere: with a session root inside /tmp — a scratch clone, a
 * worktree — the relaxation would swallow the workspace boundary whole and hand the
 * agent every sibling directory, so for that root it switches itself off.
 */
const tempRoots = (root: string): string[] => TEMP_ROOTS.filter((t) => !inside(root, t));

/**
 * The verdict for one path a command is about to destroy or overwrite.
 *
 * `scope: true` marks a path that is a SEARCH ROOT rather than a delete target —
 * `find . -name '*.beam' -delete` names `.` but destroys only what the filter picks, so
 * the root itself is not on the chopping block. An UNFILTERED `find . -delete` is the
 * wipe case and comes through with scope: false.
 */
function classifyTarget(p: string | null, root: string, what: string, scope = false): Verdict {
  if (p === null) return confirm(`${what} a path that can't be resolved statically`);
  if (touchesVcs(p)) return block(`${what} version-control metadata (${basename(p)}) — the backup itself`);
  if (p === "/" || p === homedir()) return block(`${what} ${p}`);
  const temps = tempRoots(root);
  // The temp root itself is shared with every other process on the machine, so wiping it
  // asks — exactly like the workspace root below.
  if (temps.includes(p) && !scope) return confirm(`${what} the shared temp root itself: ${p}`);
  if (!inside(p, root) && !temps.some((t) => inside(p, t))) return confirm(`${what} outside the workspace: ${p}`);
  if (p === root && !scope) return confirm(`${what} the workspace root itself`);
  if (UNBACKED_FILE.test(basename(p))) return confirm(`${what} ${basename(p)} — gitignored, so git can't restore it`);
  return ALLOW;
}

// ── Command decomposition ────────────────────────────────────────────────────

type Segment = { text: string; base: string; words: Word[] };

/** A leading `FOO=bar` assignment prefix is not the command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Words of a segment with any `FOO=bar` prefix dropped, so `words[0]` is the command. */
function commandWords(words: Word[]): Word[] {
  let i = 0;
  while (i < words.length && !words[i].redirect && ASSIGNMENT.test(words[i].text)) i++;
  return words.slice(i);
}

/**
 * Shell segments, tracking `cd` so `cd sub && rm x` resolves against `sub`. Returns null
 * when a `cd` lands somewhere unknowable — nothing after it can be judged.
 */
function segmentize(lexed: Lexed, root: string): Segment[] | null {
  const out: Segment[] = [];
  let base = root;
  for (const seg of lexed.segments) {
    const words = commandWords(seg.words);
    if (!words.length) continue;
    const head = words[0].text;
    if (head === "cd" || head === "pushd") {
      const arg = words.slice(1).find((w) => !w.redirect && !w.text.startsWith("-"));
      // A bare `cd` goes home, which is outside any workspace root.
      const target = arg ? resolveOperand(arg, base) : homedir();
      if (target === null) return null;
      base = target;
      continue;
    }
    out.push({ text: seg.text, base, words });
  }
  return out;
}

/** Bare (non-flag) operands of a segment, minus the command word and redirect targets. */
const operandsOf = (words: Word[]): Word[] =>
  words.slice(1).filter((w) => !w.redirect && w.text && !w.text.startsWith("-"));

/** `find <roots...> -flags` — the roots are what a `-delete`/`-exec rm` will chew through. */
function findRoots(words: Word[]): Word[] {
  const roots: Word[] = [];
  for (const w of words.slice(1)) {
    if (w.redirect) continue;
    if (w.text.startsWith("-")) break;
    roots.push(w);
  }
  return roots.length ? roots : [{ text: ".", expands: false, redirect: false }];
}

/** Output-redirect destinations (`> f`, `>> f`); fd dups and procsubs never reach here. */
const redirectTargets = (words: Word[]): Word[] => words.filter((w) => w.redirect && w.text);

const DELETERS = new Set(["rm", "rmdir", "unlink", "trash"]);
const MOVERS = new Set(["mv", "install"]);
/** Commands that emit PATHS on stdout, so a downstream `xargs rm` is bounded by their roots. */
const LISTERS = new Set(["find", "ls", "fd"]);

/**
 * Transparent prefixes. `sudo rm -rf /` IS an `rm`, and the old string-prefix test
 * (`/^rm\b/`) never saw it — the sudo rule downgraded a wipe of `/` to a mere confirm.
 */
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "nice", "command", "builtin", "exec"]);
/** Wrapper flags that consume the following word, which is therefore not the command. */
const WRAPPER_FLAG_WITH_VALUE = new Set(["-u", "-g", "-p", "-C", "-n", "--user", "--group"]);

function peelWrappers(words: Word[]): Word[] {
  for (let guard = 0; guard < 8; guard++) {
    if (!words.length || !WRAPPERS.has(words[0].text)) return words;
    let i = 1;
    while (i < words.length && (words[i].text.startsWith("-") || ASSIGNMENT.test(words[i].text))) {
      if (WRAPPER_FLAG_WITH_VALUE.has(words[i].text)) i++;
      i++;
    }
    if (i >= words.length) return words; // wrapper with no command after it
    words = words.slice(i);
  }
  return words;
}
/** A predicate that narrows what `find` acts on. Without one, `-delete` means "everything". */
const FIND_FILTER = /\s-(?:i?name|i?path|i?regex|i?wholename|type|newer|mtime|mmin|ctime|atime|size|user|group|perm|links|empty)\b/;

/**
 * Path-scoped verdict for everything in the command that destroys or overwrites a
 * location, plus whether anything destructive was found at all (drives the snapshot).
 */
function pathVerdicts(segs: Segment[] | null, root: string): { verdict: Verdict; destructive: boolean } {
  if (segs === null) return { verdict: confirm("a `cd` to a directory the guard can't resolve"), destructive: true };

  const verdicts: Verdict[] = [];
  let destructive = false;
  /** The upstream path-lister of the current pipeline, if the previous segment was one. */
  let upstream: { roots: Word[]; filtered: boolean } | null = null;

  for (const seg of segs) {
    const { text, base } = seg;
    const words = peelWrappers(seg.words);
    const cmd = words[0]?.text ?? "";
    const filtered = FIND_FILTER.test(text);

    let targets: Word[] | null = null;
    let scope = false;
    let what = "deletes";

    if (DELETERS.has(cmd)) {
      targets = operandsOf(words);
    } else if (MOVERS.has(cmd)) {
      targets = operandsOf(words);
      what = "moves/overwrites";
    } else if (cmd === "find" && /(?:-delete\b|-exec\s+rm\b)/.test(text)) {
      targets = findRoots(words);
      scope = filtered;
    } else if (cmd === "xargs" && words.some((w) => w.text === "rm")) {
      // Operands arrive on stdin, so the upstream segment is the only evidence available.
      // Only a path LISTER counts: `cat list | xargs rm` prints file contents, not paths,
      // and vouching for its operands would be vouching for the wrong thing entirely.
      targets = upstream ? upstream.roots : []; // [] -> "targets the guard can't see" -> confirm
      scope = upstream?.filtered ?? false;
    }

    if (targets !== null) {
      destructive = true;
      verdicts.push(
        targets.length === 0
          ? confirm(`a delete whose targets the guard can't see (\`${text.slice(0, 60)}\`)`)
          : worst(targets.map((t) => classifyTarget(resolveOperand(t, base), root, what, scope))),
      );
    }

    for (const r of redirectTargets(seg.words)) {
      verdicts.push(classifyTarget(resolveOperand(r, base), root, "writes over"));
    }

    const isLister = LISTERS.has(cmd) || (cmd === "git" && words[1]?.text === "ls-files");
    upstream = isLister ? { roots: cmd === "find" ? findRoots(words) : operandsOf(words), filtered } : null;
  }

  return { verdict: worst(verdicts), destructive };
}

// ── git: protected branches ──────────────────────────────────────────────────

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Where a bare `git push` would land: the configured push target, else the branch name. */
function implicitPushTarget(root: string): string | null {
  const pushed = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]);
  if (pushed) return pushed.replace(/^[^/]+\//, "");
  return git(root, ["symbolic-ref", "--short", "HEAD"]);
}

const isProtected = (ref: string): boolean => PROTECTED_BRANCHES.some((re) => re.test(ref));

/** Destination ref of a refspec: `HEAD:main` -> `main`, `+feat` -> `feat`, `:gone` -> `gone`. */
const refspecTarget = (spec: string): string =>
  (spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec).replace(/^\+/, "").replace(/^refs\/heads\//, "");

function gitPushVerdict(words: Word[], root: string): Verdict | null {
  const w = peelWrappers(words);
  if (w[0]?.text !== "git") return null;
  const toks = w.map((t) => t.text);
  const i = toks.indexOf("push");
  if (i === -1) return null;

  const rest = toks.slice(i + 1);
  const specs = rest.filter((t) => !t.startsWith("-")).slice(1); // drop the remote
  const deleting = rest.some((t) => t === "--delete" || t === "-d") || specs.some((s) => s.startsWith(":"));
  const forced =
    rest.some((t) => /^--force(?:-with-lease)?(?:=|$)/.test(t) || /^-[A-Za-z]*f/.test(t)) ||
    specs.some((s) => s.startsWith("+"));

  const targets = specs.length ? specs.map(refspecTarget) : [implicitPushTarget(root)];

  for (const t of targets) {
    if (t === null) return confirm("git push to a branch the guard couldn't identify");
    if (!isProtected(t)) continue;
    if (forced) return block(`force-push to protected branch \`${t}\``);
    if (deleting) return block(`deleting protected branch \`${t}\``);
    return confirm(`git push to protected branch \`${t}\``);
  }

  if (deleting) return confirm("deleting a remote branch");
  return ALLOW;
}

// ── Regex tiers ──────────────────────────────────────────────────────────────

type Rule = { label: string; re: RegExp; head?: boolean };

/** Unrecoverable, or with no legitimate agent-initiated form. */
const BLOCK_RULES: Rule[] = [
  { label: "filesystem format (mkfs)", re: /\b(?:mkfs|mke2fs)\b/i },
  { label: "disk wipe (shred/wipefs/blkdiscard)", re: /\b(?:shred|wipefs|blkdiscard)\b/i },
  { label: "dd writing to a device", re: /\bdd\b[^\n]*\bof=\/dev\//i },
  { label: "redirect to a block device", re: />\s*\/dev\/(?:sd|nvme|disk|hd|mmcblk)/i },
  { label: "fork bomb", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  // The reflog is what makes reset --hard, rebase and branch force-push recoverable —
  // and therefore what lets the whole ALLOW tier exist. Expiring it is the one git
  // operation with no undo.
  { label: "expiring the reflog (destroys git's undo)", re: /\bgit\b[^\n]*(?:reflog\s+expire|gc\b[^\n]*--prune=)/i },
  { label: "deleting or transferring the repo", re: /\bgh\s+repo\s+(?:delete|transfer)\b/i },
  // The pre-push hook is the actual guarantee about protected branches; disabling it is
  // the one move that would turn this file back into the only line of defence.
  // (`git commit --no-verify` stays fine — skipping a lint hook is ordinary work.)
  {
    label: "disabling the pre-push guard",
    re: /\bgit\b[^\n]*\bpush\b[^\n]*--no-verify\b|\bgit\b[^\n]*--no-verify\b[^\n]*\bpush\b|\bgit\s+-c\s+core\.hooksPath\b|\bcore\.hooksPath\s*=|\bgit\s+config\b(?![^\n]*--(?:get|list))[^\n]*\bcore\.hooksPath\b/i,
  },
];

/** Leaves the machine, touches another person, or escapes the root. */
const CONFIRM_RULES: Rule[] = [
  { label: "sudo / privilege escalation", re: /(?:^|[\s|&;(])(?:sudo|doas)\b/i },
  { label: "service manager", re: /\b(?:systemctl|launchctl)\b|\bservice\s+\S+\s+(?:stop|start|restart|disable)\b/i },
  { label: "killall / pkill / kill -9", re: /\b(?:killall|pkill)\b|\bkill\s+-(?:9|KILL)\b/i },
  { label: "world-writable permissions", re: /\bchmod\b[^\n]*(?:777|a\+w|o\+w)\b/i },
  { label: "recursive chown", re: /\bchown\b[^\n]*\s-\w*R\b/i },
  { label: "pipes a download into a shell", re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i },
  {
    label: "reverse shell / raw socket",
    re: /\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^\n]*(?:-e\b|-c\b|\s\d{2,5}\b)|\bmkfifo\b[^\n]*\|/i,
  },
  {
    label: "publishes a package",
    re: /\b(?:npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bpoetry\s+publish\b|\bmix\s+hex\.publish\b/i,
  },
  { label: "publishes a release or image", re: /\bgh\s+release\s+(?:create|upload|delete)\b|\bdocker\b[^\n]*\bpush\b/i },
  { label: "merges a pull request", re: /\bgh\s+pr\s+merge\b/i },
  { label: "changes CI secrets", re: /\bgh\s+(?:secret|variable)\s+(?:set|delete|remove)\b/i },
  { label: "triggers or cancels CI", re: /\bgh\s+workflow\s+(?:run|enable|disable)\b|\bgh\s+run\s+(?:rerun|cancel)\b/i },
  { label: "changes gh auth", re: /\bgh\s+auth\s+(?:login|logout|refresh|token|setup-git)\b/i },
  {
    // The typed commands (gh pr create/comment/…) are free; raw api is the bypass path
    // for everything above, so writes through it still ask.
    label: "raw gh api write",
    re: /\bgh\s+api\b[^\n]*(?:(?:-X|--method)[= ]\s*(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-f|-F|--field|--raw-field)\b)/i,
  },
  { label: "archives or renames the repo", re: /\bgh\s+repo\s+(?:archive|rename)\b/i },
  { label: "mutates cluster/infra state", re: /\bkubectl\s+(?:delete|apply|drain)\b|\bterraform\s+(?:apply|destroy)\b/i },
  { label: "destroys a cloud resource", re: /\b(?:aws|gcloud|az)\b[^\n]*\b(?:delete|destroy|terminate|rm)\b/i, head: true },
  { label: "prunes docker state", re: /\bdocker\b[^\n]*\b(?:system\s+prune|volume\s+rm)\b/i },
  // Jira writes fan out as notifications to a team and can't be un-sent. Creating and
  // commenting is ordinary work; deleting and moving someone's board state is not.
  { label: "deletes or transitions a Jira item", re: /\bacli\b[^\n]*\b(?:delete|transition)\b/i, head: true },
];

/** The sandbox's own load-bearing config. Auto-enabled inside a container. */
const CONTAINER_RULES: Rule[] = [
  { label: "firewall / routing change", re: /\b(?:iptables|ip6tables|nft|ipset)\b|\bip\s+(?:route|rule|addr)\b/i },
  { label: "egress allowlist / proxy config", re: /\/etc\/squid\b|\bsquid-allow\.sh\b|\bsquid\b[^\n]*\b(?:-k|reconfigure)\b/i },
  { label: "mounted host config (read-only by design)", re: /\/home\/dev\/\.(?:omp|pi|claude)\/|\/home\/dev\/\.gitconfig\b/i },
];

// Secrets: the risk is exfiltration and deletion, not reading. `cat .env` in your own
// project is ordinary work; `curl -d @.env` is not, and neither is reaching into ~/.ssh.
const SECRET_PATH =
  /(?:\.ssh\/id_|\bid_rsa\b|\bid_ed25519\b|\.aws\/credentials|\.config\/gcloud|\.netrc\b|\.pgpass\b|\.npmrc\b|[\w./~-]+\.(?:pem|key|p12|pfx)\b|(?:^|[\s/'"])\.env(?:\.[\w-]+)?(?:$|[\s'"]))/i;
const OUTBOUND_SINK =
  /\b(?:curl|wget|nc|ncat|netcat|scp|sftp|rsync|ssh|xh|httpie)\b|\bgh\s+api\b|\bbase64\b|\bopenssl\s+(?:enc|base64)\b/i;

/** Drop everything from the first flag onward, per segment, so flag VALUES can't match verbs. */
const commandHead = (command: string): string =>
  command
    .split(/[\n;|&]+/)
    .map((s) => s.split(/\s+-/)[0].trim())
    .filter(Boolean)
    .join(" ; ");

function ruleVerdict(command: string): Verdict {
  const head = commandHead(command);
  const test = (r: Rule) => r.re.test(r.head ? head : command);

  const blocked = BLOCK_RULES.find(test);
  if (blocked) return block(blocked.label);

  const rules = IN_CONTAINER ? [...CONFIRM_RULES, ...CONTAINER_RULES] : CONFIRM_RULES;
  const asked = rules.find(test);
  if (asked) return confirm(asked.label);
  return ALLOW;
}

/**
 * Runs on the RAW command, not the masked one: a quoted path is still a path, and the
 * risk here is where a credential GOES, not whether it was written with quotes.
 */
function secretVerdict(command: string, root: string, segs: Segment[] | null): Verdict {
  if (!SECRET_PATH.test(command)) return ALLOW;
  if (OUTBOUND_SINK.test(command)) return confirm("secret material heading off-machine");
  // Reading the project's own secrets is fine; reaching outside the workspace for
  // someone else's is not.
  for (const seg of segs ?? []) {
    for (const w of seg.words) {
      // `--key=value` hides the path in a flag, so try the value half too.
      const eq = w.text.indexOf("=");
      const candidates = eq === -1 ? [w] : [w, { ...w, text: w.text.slice(eq + 1) }];
      for (const c of candidates) {
        if (!SECRET_PATH.test(c.text)) continue;
        const p = resolveOperand(c, seg.base);
        if (p && !inside(p, root)) return confirm(`reads credentials outside the workspace: ${p}`);
      }
    }
  }
  return ALLOW;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/** Best-effort: a failed snapshot never blocks the command it was protecting. */
function snapshot(root: string, reason: string): void {
  if (!SNAPSHOT_BEFORE_DESTRUCTIVE) return;
  if (!git(root, ["rev-parse", "--git-dir"])) return;

  const index = join(tmpdir(), `danger-guard-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    run(["add", "-A"]);
    const tree = run(["write-tree"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const commit = run(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `danger-guard snapshot: ${reason}`]);
    run(["update-ref", `refs/danger-guard/${new Date().toISOString().replace(/[:.]/g, "-")}`, commit]);
  } catch {
    // ignored
  } finally {
    try {
      unlinkSync(index);
    } catch {
      // ignored
    }
  }
}

// ── Decision ─────────────────────────────────────────────────────────────────

let PINNED_ROOT: string | undefined;

/**
 * Pinned at first use rather than read live: if the session cwd can move, a live read
 * would let the boundary move with it.
 */
function sessionRoot(ctx: { cwd?: string }): string {
  if (PINNED_ROOT === undefined) PINNED_ROOT = realpathDeep(ctx.cwd || process.cwd());
  return PINNED_ROOT;
}

function decideBash(command: string, root: string): { verdict: Verdict; destructive: boolean } {
  const lexed = lex(command);

  // The rule tier reads shell SYNTAX, so quoted prose and heredoc data are blanked
  // first. Without this, `git commit -m "use mkfs to format"` hit the mkfs BLOCK rule.
  const rules = ruleVerdict(lexed.masked);
  if (rules.level === "block") return { verdict: rules, destructive: false };

  const segs = segmentize(lexed, root);
  const pushVerdicts: Verdict[] = [];
  for (const seg of segs ?? []) {
    const v = gitPushVerdict(seg.words, root);
    if (v) pushVerdicts.push(v);
  }

  const paths = pathVerdicts(segs, root);
  const verdict = worst([rules, ...pushVerdicts, paths.verdict, secretVerdict(command, root, segs)]);
  return { verdict, destructive: paths.destructive };
}

/** write/edit bypass bash entirely, so the same boundary applies to their target path. */
function decideFileTool(input: unknown, root: string): Verdict {
  const rec = (input ?? {}) as Record<string, unknown>;
  const raw = rec.path ?? rec.file_path ?? rec.filePath;
  if (typeof raw !== "string" || !raw) return ALLOW;
  const p = realpathDeep(isAbsolute(raw) ? normalize(raw) : resolve(root, raw));
  if (touchesVcs(p)) return block(`writing into version-control metadata (${basename(p)})`);
  if (!inside(p, root) && !tempRoots(root).some((t) => inside(p, t)))
    return confirm(`writes outside the workspace: ${p}`);
  return ALLOW;
}

// ── Pending-confirmation machinery (survives the 30s handler cap) ────────────

const WAIT_MS = Number(process.env.OMP_DANGER_GUARD_WAIT_MS ?? "") || 25_000;
const PENDING = Symbol("danger-guard:pending");

/** One live dialog per exact command string, surviving handler timeouts. */
const inflight = new Map<string, Promise<boolean>>();
/** Answers that landed after the asking attempt was cut off, awaiting consumption. */
const decided = new Map<string, boolean>();

/** Resolves with the dialog answer, or PENDING once `ms` elapses. Never rejects. */
function waitUpTo(p: Promise<boolean>, ms: number): Promise<boolean | typeof PENDING> {
  const { promise, resolve: settle } = Promise.withResolvers<typeof PENDING>();
  const timer = setTimeout(() => settle(PENDING), ms);
  return Promise.race([p, promise]).finally(() => clearTimeout(timer));
}

export default function ompDangerGuard(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName;
    if (tool !== "bash" && tool !== "write" && tool !== "edit" && tool !== "multi_edit") return;

    const root = sessionRoot(ctx as { cwd?: string });
    const input: unknown = event.input;

    let verdict: Verdict;
    let key: string;
    let destructive = false;

    if (tool === "bash") {
      const raw = input && typeof input === "object" && "command" in input ? input.command : undefined;
      const command = String(raw ?? "").trim();
      if (!command) return;
      const decision = decideBash(command, root);
      verdict = decision.verdict;
      destructive = decision.destructive;
      key = command;
    } else {
      verdict = decideFileTool(input, root);
      key = `${tool}:${JSON.stringify(input)}`;
    }

    if (verdict.level === "allow") {
      if (destructive) snapshot(root, key.slice(0, 120));
      return;
    }

    // BLOCK: refused outright. No dialog — a prompt you can click through is exactly what
    // fatigue and injection defeat. Run it yourself if you really mean it.
    if (verdict.level === "block") {
      return {
        block: true,
        reason:
          `danger-guard: REFUSED — ${verdict.label}. This is blocked by policy and there is no prompt for it. ` +
          "Do not attempt a workaround, a rephrasing, or an equivalent command. " +
          "Tell the user what you wanted to do and let them run it themselves if they agree.",
      };
    }

    // Headless / no UI -> fail closed. Unattended runs never auto-run a gated command.
    if (!ctx.hasUI) {
      return { block: true, reason: `danger-guard: ${verdict.label} — blocked (no UI to confirm)` };
    }

    // An answer from a previous, timed-out attempt. Consume it once.
    if (decided.has(key)) {
      const answer = decided.get(key)!;
      decided.delete(key);
      if (!answer) return { block: true, reason: `danger-guard: user denied (${verdict.label})` };
      if (destructive) snapshot(root, key.slice(0, 120));
      return;
    }

    let dialog = inflight.get(key);
    if (!dialog) {
      // Opened exactly once and deliberately outliving this handler; `.then` records the
      // answer so a later attempt can pick it up. A rejection (aborted overlay) counts as
      // a denial rather than escaping as an unhandled rejection.
      dialog = Promise.resolve(
        ctx.ui.confirm(
          `⚠️  danger-guard${IN_CONTAINER ? " (container)" : ""}: ${verdict.label}`,
          `Allow this?\n\n${key}\n\nNothing runs until you answer.`,
        ),
      ).then(
        (ok) => !!ok,
        () => false,
      );
      const pendingDialog = dialog;
      dialog
        .then((ok) => {
          decided.set(key, ok);
        })
        .finally(() => {
          if (inflight.get(key) === pendingDialog) inflight.delete(key);
          ctx.ui.setStatus?.("danger-guard", "");
        });
      inflight.set(key, dialog);
    }

    ctx.ui.setStatus?.("danger-guard", `awaiting approval: ${verdict.label}`);
    const answer = await waitUpTo(dialog, WAIT_MS);

    if (answer === PENDING) {
      // Return before the runner's cap; the dialog stays open and the next attempt
      // resumes waiting on it.
      return {
        block: true,
        reason:
          `danger-guard: waiting for the user to approve ${verdict.label}. ` +
          "A confirmation dialog is open and still unanswered — this is NOT a failure and NOT a denial. " +
          "Re-issue the exact same command verbatim, immediately and as many times as needed, to keep waiting. " +
          "Do not modify the command, do not work around the guard, and do not move on to other work.",
      };
    }

    decided.delete(key);
    if (!answer) return { block: true, reason: `danger-guard: user denied (${verdict.label})` };
    if (destructive) snapshot(root, key.slice(0, 120));
  });
}

// Exported for the test harness in `omp/agent/extensions/__tests__`.
export { decideBash, decideFileTool, sessionRoot, snapshot };
