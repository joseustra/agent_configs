/**
 * omp danger-guard — CONTAINER variant.
 *
 * This is the strict host guard (`../extensions/omp-danger-guard.ts`) with a narrow
 * set of exemptions for things the devcontainer can genuinely regenerate. It is
 * NOT installed onto the host: it lives in `extensions-container/`, a directory omp
 * does not scan, precisely so `~/.omp/agent/extensions/` keeps loading exactly one
 * guard — the strict one. The devcontainer's Makefile bind-mounts this file (read-only)
 * over the container's `~/.omp/agent/extensions/omp-danger-guard.ts`, so inside the
 * box this file *is* the guard.
 *
 * Why relax at all, and why so little?
 *   The tempting argument is "it's a sandbox, and /workspace is a git checkout, so
 *   git can undo anything." That argument is wrong here. `/workspace` is a read-write
 *   bind mount of the REAL host project directory, and git only recovers what is
 *   already committed AND pushed. It does not recover: uncommitted or staged work,
 *   stashes, untracked files, branches that never left the machine, sibling worktrees
 *   under `.worktrees/`, or `.git` itself — deleting which makes every other deletion
 *   permanent. So the boundary is not "destructive git commands"; it is "content that
 *   already exists somewhere else."
 *
 *   What actually causes prompt fatigue is not `rm -rf src/` — it is `rm -rf _build`,
 *   `rm -rf node_modules`, scratch files in /tmp. Those are regenerable by construction,
 *   independent of git. So this variant relaxes by PATH, not by command: an `rm` whose
 *   every argument names something at or below a disposable location runs unprompted.
 *   Everything else — including all of the above — stays gated exactly as on the host.
 *
 * The exemption is deliberately conservative and fails closed:
 *   - It applies only to the plain `rm` rule. `find -delete`, `xargs rm`, `shred`,
 *     `dd`, `mkfs` are never exempt.
 *   - It applies only when NO OTHER rule matches the command, so `sudo rm -rf /tmp/x`
 *     still trips the sudo rule, and `rm node_modules/foo.pem` still trips the
 *     secrets rule.
 *   - Any argument it cannot statically reason about (shell expansion, `..`, an
 *     unrecognised absolute path) disqualifies the whole command.
 *   - It cannot follow symlinks: a symlinked `node_modules` pointing outside the
 *     workspace would be exempted. That is a known limit — this is a speed bump for
 *     careless or prompt-injected commands, not a sandbox. The real containment is
 *     the read-only mounts, the egress allowlist, and file protection.
 *
 * Keeping this in sync with the host guard is manual: the rule tables below are a
 * verbatim copy. When you edit the host guard's rules, copy them here too. The two
 * files sit side by side in `agent_configs` so a diff shows exactly what differs.
 */
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

type Rule = { label: string; re: RegExp; head?: boolean };

// ── Rule tables: VERBATIM copy of the host guard ─────────────────────────────
// Do not diverge here. Divergence belongs in the exemption layer further down,
// where it is explicit and reviewable.

const RM_RULE: Rule = {
  label: "rm (file deletion)",
  re: /(?:^|[\n;|&(]|\b(?:sudo|xargs|time|nice|env)\s+)\s*rm\b/i,
};

const FS_RULES: Rule[] = [
  RM_RULE,
  { label: "dd: writing to a device", re: /\bdd\b[^\n]*\bof=\/dev\//i },
  { label: "write/redirect to block device", re: />\s*\/dev\/(?:sd|nvme|disk|hd|mmcblk)/i },
  { label: "mkfs: format filesystem", re: /\bmkfs\b|\bmke2fs\b/i },
  { label: "disk wipe (shred/wipefs/blkdiscard)", re: /\b(?:shred|wipefs|blkdiscard)\b/i },
  { label: "find -delete / find -exec rm", re: /\bfind\b[^\n]*(?:-delete\b|-exec\s+rm\b)/i },
  { label: "xargs rm", re: /\|\s*xargs\b[^\n]*\brm\b/i },
  { label: "fork bomb", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
];

const GIT_CLEAN_RULE: Rule = {
  label: "git clean -fd / -fdx",
  re: /\bgit\b[^\n]*\bclean\b[^\n]*-\w*f/i,
};

const GIT_RULES: Rule[] = [
  { label: "git push --force", re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--force(?:-with-lease)?|\s-\w*f)\b/i },
  { label: "git push --delete (remote branch)", re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--delete\b|\s:\S)/i },
  { label: "git reset --hard", re: /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i },
  GIT_CLEAN_RULE,
  { label: "git branch -D (force-delete)", re: /\bgit\b[^\n]*\bbranch\b[^\n]*(?:-D\b|-d\w*\s+--force|--delete\s+--force)/i },
  { label: "git history rewrite (filter/rebase)", re: /\bgit\b[^\n]*\b(?:filter-branch|filter-repo|rebase)\b/i },
  { label: "git reflog expire / gc prune", re: /\bgit\b[^\n]*(?:reflog\s+expire|gc\b[^\n]*--prune=)/i },
  { label: "git checkout/restore -- . (discard worktree)", re: /\bgit\b[^\n]*\b(?:checkout|restore)\b[^\n]*--\s+\.(?:\s|$)/i },
  { label: "git push (publishes to remote)", re: /\bgit\b[^\n]*\bpush\b/i },
];

const SYS_RULES: Rule[] = [
  { label: "sudo / privilege escalation", re: /(?:^|\s|\||&|;)\s*sudo\b|(?:^|\s)doas\b/i },
  { label: "chmod 777 / world-writable", re: /\bchmod\b[^\n]*(?:-R[^\n]*)?(?:777|a\+w|o\+w)\b/i },
  { label: "chown -R", re: /\bchown\b[^\n]*-R\b/i },
  { label: "service manager (systemctl/service/launchctl)", re: /\b(?:systemctl|launchctl)\b|\bservice\s+\S+\s+(?:stop|start|restart|disable)\b/i },
  { label: "kill -9 / killall / pkill", re: /\b(?:kill\s+-(?:9|KILL)|killall|pkill)\b/i },
  { label: "touches secret/credential files", re: /(?:\.ssh\/id_|id_rsa|id_ed25519|\.aws\/credentials|\.config\/gcloud|\.netrc|\.pgpass|\.npmrc|\bcredentials\b[^\n]*\.json|[^\n]*\.pem\b|[^\n]*\.key\b|(?:^|\s|\/)\.env(?:\.|\s|$))/i },
];

const NET_RULES: Rule[] = [
  { label: "pipe download into shell (curl|sh)", re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|)sh\b/i },
  { label: "reverse shell / raw socket", re: /\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^\n]*(?:-e|-c|\s\d{2,5}\b)|mkfifo\b[^\n]*\|/i },
  { label: "package publish (npm/cargo/pip/gem)", re: /\b(?:npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bpoetry\s+publish\b/i },
  { label: "release / artifact upload", re: /\bgh\s+release\s+(?:create|upload)\b|\bdocker\b[^\n]*\bpush\b/i },
  { label: "container/infra mutate (k8s/terraform/docker)", re: /\bkubectl\s+(?:delete|apply)\b|\bterraform\s+(?:apply|destroy)\b|\bdocker\b[^\n]*\b(?:rm|rmi|system\s+prune|volume\s+rm)\b/i },
  { label: "cloud CLI destroy (aws/gcloud/az)", re: /\b(?:aws|gcloud|az)\b[^\n]*\b(?:delete|destroy|terminate|rm)\b/i },
];

const GH_RULES: Rule[] = [
  {
    label: "gh api (write request)",
    re: /\bgh\s+api\b[^\n]*(?:(?:-X|--method)[ =]?\s*(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-f|-F|--field|--raw-field)\b)/i,
  },
  {
    label: "gh (state-changing command)",
    re: /\bgh\b[^\n]*\b(?:create|delete|edit|merge|close|reopen|comment|rename|archive|unarchive|transfer|upload|fork|sync|ready|lock|unlock|pin|unpin|enable|disable|restore|rerun|cancel|revoke|approve|clear|set|add|remove)\b/i,
    head: true,
  },
  { label: "gh workflow run", re: /\bgh\s+workflow\b[^\n]*\brun\b/i, head: true },
];

const ACLI_RULES: Rule[] = [
  {
    label: "acli (state-changing command)",
    re: /\bacli\b[^\n]*\b(?:create|update|delete|transition|assign|edit|comment|add|remove|set|move|clone|link|unlink|archive|restore|upload|import|close|reopen|rank|watch|unwatch|vote)\b/i,
    head: true,
  },
];

// ── Container-only additions ─────────────────────────────────────────────────
// The sandbox has load-bearing config the host doesn't: the firewall, the squid
// allowlist, and the read-only mounts carrying host config. Those mounts already
// reject writes with EROFS, so these rules aren't the containment — they make the
// intent explicit and catch the attempt before it becomes a confusing error.
const CONTAINER_RULES: Rule[] = [
  { label: "firewall / routing change", re: /\b(?:iptables|ip6tables|nft|ipset)\b|\bip\s+(?:route|rule|addr)\b/i },
  { label: "egress allowlist / proxy config", re: /\/etc\/squid\b|\bsquid-allow\.sh\b|\bsquid\b[^\n]*\b(?:-k|reconfigure)\b/i },
  { label: "mounted host config (read-only by design)", re: /\/home\/dev\/\.(?:omp|pi|claude)\/|\/home\/dev\/\.gitconfig\b/i },
];

const RULES: Rule[] = [
  ...FS_RULES,
  ...GIT_RULES,
  ...SYS_RULES,
  ...NET_RULES,
  ...GH_RULES,
  ...ACLI_RULES,
  ...CONTAINER_RULES,
];

// ── Disposable-path exemption ────────────────────────────────────────────────

// Absolute locations that are scratch by definition. Trailing content optional so
// `rm -rf /tmp` itself is covered as well as `/tmp/foo`.
const DISPOSABLE_ROOTS = [/^\/tmp(?:\/|$)/, /^\/var\/tmp(?:\/|$)/, /^\/home\/dev\/\.cache(?:\/|$)/, /^~\/\.cache(?:\/|$)/];

// Directory names whose contents a build tool regenerates. A path containing any of
// these as a component names something at or below such a directory, so deleting it
// costs a rebuild and nothing else.
const DISPOSABLE_DIRS = new Set([
  "_build",
  "deps",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".elixir_ls",
  "cover",
  ".cache",
  ".gradle",
  ".terraform",
]);

// Components that veto an exemption no matter what else the path contains. `.git`
// under a `dist/` directory is still git history; a sibling worktree is still
// somebody's uncommitted work.
const NEVER_DISPOSABLE_DIRS = new Set([".git", ".worktrees", ".claude", ".jj", ".hg", ".svn"]);

/** True if this single argument names something we are willing to delete unprompted. */
function isDisposablePath(raw: string): boolean {
  // Strip one layer of surrounding quotes; anything else quoted mid-token is suspect.
  const arg = raw.replace(/^['"]|['"]$/g, "");
  if (!arg) return false;

  // Anything we can't evaluate statically disqualifies the command: shell expansion,
  // command substitution, or a traversal that could climb back out of a safe root.
  if (/[$`]/.test(arg)) return false;
  if (arg.split("/").includes("..")) return false;

  const components = arg.split("/").filter((c) => c && c !== "." && c !== "*");
  if (components.some((c) => NEVER_DISPOSABLE_DIRS.has(c))) return false;

  if (DISPOSABLE_ROOTS.some((re) => re.test(arg))) return true;

  // Absolute paths outside the scratch roots are only in scope under /workspace.
  if (arg.startsWith("/") && !/^\/workspace(?:\/|$)/.test(arg)) return false;
  if (arg.startsWith("~")) return false;

  return components.some((c) => DISPOSABLE_DIRS.has(c));
}

/**
 * True if every `rm` in the command deletes only disposable paths. Conservative by
 * construction: an `rm` with no parseable operands, or with one operand we can't
 * vouch for, returns false and the command gets gated.
 */
function rmTargetsAreDisposable(command: string): boolean {
  const segments = command
    .split(/[\n;|&]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const rmSegments = segments.filter((s) => /^\(?\s*rm\b/.test(s));
  if (rmSegments.length === 0) return false;

  return rmSegments.every((seg) => {
    const operands = seg
      .replace(/^\(\s*/, "")
      .split(/\s+/)
      .slice(1) // drop `rm`
      .filter((t) => t && !t.startsWith("-"));
    return operands.length > 0 && operands.every(isDisposablePath);
  });
}

/** `git clean -fdX` removes ignored files only — build output, by definition. */
function isIgnoredOnlyGitClean(command: string): boolean {
  const flags = command.match(/\bclean\b((?:\s+-\S+)*)/);
  if (!flags) return false;
  return /X/.test(flags[1]) && !/x/.test(flags[1].replace(/X/g, ""));
}

function commandHead(command: string): string {
  return command
    .split(/[\n;|&]+/)
    .map((seg) => seg.split(/\s+-/)[0].trim())
    .filter(Boolean)
    .join(" ; ");
}

function matches(rule: Rule, command: string, head: string): boolean {
  return rule.re.test(rule.head ? head : command);
}

function exempt(hit: Rule, command: string): boolean {
  if (hit === RM_RULE) return rmTargetsAreDisposable(command);
  if (hit === GIT_CLEAN_RULE) return isIgnoredOnlyGitClean(command);
  return false;
}

/**
 * The gating rule, or undefined to let the command through. A command is exempt only
 * when EVERY rule it trips is exemptible and that exemption holds — so `sudo rm /tmp/x`
 * still gates on sudo, and `rm node_modules/key.pem` still gates on the secrets rule.
 */
export function firstMatch(command: string): Rule | undefined {
  const head = commandHead(command);
  const hits = RULES.filter((r) => matches(r, command, head));
  if (hits.length === 0) return undefined;
  if (hits.every((r) => exempt(r, command))) return undefined;
  return hits.find((r) => !exempt(r, command));
}

export default function ompDangerGuard(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown })?.command ?? "").trim();
    if (!command) return;

    const hit = firstMatch(command);
    if (!hit) return;

    // Headless / no UI -> fail closed.
    if (!ctx.hasUI) {
      return { block: true, reason: `danger-guard: ${hit.label} blocked (no UI to confirm)` };
    }

    const ok = await ctx.ui.confirm(
      `⚠️  danger-guard (container): ${hit.label}`,
      `Allow this command?\n\n${command}`,
    );
    if (!ok) return { block: true, reason: `danger-guard: user denied (${hit.label})` };
  });
}
