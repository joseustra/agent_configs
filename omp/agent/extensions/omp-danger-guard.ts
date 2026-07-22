/**
 * omp danger-guard — argument-aware confirmation gate for the `bash` tool.
 *
 * This is the CANONICAL source. It is shipped verbatim to two places:
 *   - Host:      ~/.omp/agent/extensions/omp-danger-guard.ts  (symlink/copy of this file)
 *   - Container: /home/dev/.omp/agent/extensions/omp-danger-guard.ts  (COPY'd in Dockerfile)
 * omp auto-discovers any *.ts/*.js under those `extensions/` dirs at startup — no flag needed.
 *
 * Why a hook and not config.yml approval policy?
 *   config.yml (`tools.approvalMode` / `tools.approval.<tool>`) is all-or-nothing per
 *   tool — it can't see the command string, so it can only "prompt on EVERY bash". This
 *   hook inspects `event.input.command` and gates ONLY the patterns below, leaving the
 *   thousands of harmless commands untouched. It runs on the tool-call interception path
 *   independent of approvalMode, so it still fires even when omp is in `yolo` mode.
 *
 * Behavior (per project decision):
 *   - match + interactive UI  -> ask `ctx.ui.confirm`; deny => block.
 *   - match + NO UI (headless) -> BLOCK (fail-closed). Unattended runs never auto-run a
 *     gated command. In the container the sandbox (egress allowlist + file-protection) is
 *     the backstop; on the bare host there is no sandbox, so fail-closed matters more.
 *
 * Tuning: each rule is `{ label, re }`. Comment one out to stop gating it, or add your own.
 * Order doesn't matter — first match wins and the label is shown to the user.
 */
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// `head: true` tests the rule against only the command HEAD — the leading run of
// bare tokens before the first flag (e.g. `acli jira workitem view` from
// `acli jira workitem view DOC-3192 --fields comment`). This stops a mutating
// word that appears as a FLAG VALUE (`--fields comment`) from tripping a verb rule.
type Rule = { label: string; re: RegExp; head?: boolean };

// ── 1) Destructive filesystem & disk ────────────────────────────────────────
const FS_RULES: Rule[] = [
  // Policy: EVERY rm invocation is confirmed, not just recursive/force ones.
  // Anchored to command position — start of a segment, after | ; & or ( , or behind
  // sudo/xargs/time/nice/env — so the word "rm" inside a commit message, grep pattern,
  // or echo string does NOT trip it. (find -delete / -exec rm have their own rules.)
  { label: "rm (file deletion)", re: /(?:^|[\n;|&(]|\b(?:sudo|xargs|time|nice|env)\s+)\s*rm\b/i },
  { label: "dd: writing to a device", re: /\bdd\b[^\n]*\bof=\/dev\//i },
  { label: "write/redirect to block device", re: />\s*\/dev\/(?:sd|nvme|disk|hd|mmcblk)/i },
  { label: "mkfs: format filesystem", re: /\bmkfs\b|\bmke2fs\b/i },
  { label: "disk wipe (shred/wipefs/blkdiscard)", re: /\b(?:shred|wipefs|blkdiscard)\b/i },
  { label: "find -delete / find -exec rm", re: /\bfind\b[^\n]*(?:-delete\b|-exec\s+rm\b)/i },
  { label: "xargs rm", re: /\|\s*xargs\b[^\n]*\brm\b/i },
  { label: "fork bomb", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
];

// ── 2) Git history rewrite & force-push ──────────────────────────────────────
const GIT_RULES: Rule[] = [
  { label: "git push --force", re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--force(?:-with-lease)?|\s-\w*f)\b/i },
  { label: "git push --delete (remote branch)", re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--delete\b|\s:\S)/i },
  { label: "git reset --hard", re: /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i },
  { label: "git clean -fd / -fdx", re: /\bgit\b[^\n]*\bclean\b[^\n]*-\w*f/i },
  { label: "git branch -D (force-delete)", re: /\bgit\b[^\n]*\bbranch\b[^\n]*(?:-D\b|-d\w*\s+--force|--delete\s+--force)/i },
  { label: "git history rewrite (filter/rebase)", re: /\bgit\b[^\n]*\b(?:filter-branch|filter-repo|rebase)\b/i },
  { label: "git reflog expire / gc prune", re: /\bgit\b[^\n]*(?:reflog\s+expire|gc\b[^\n]*--prune=)/i },
  { label: "git checkout/restore -- . (discard worktree)", re: /\bgit\b[^\n]*\b(?:checkout|restore)\b[^\n]*--\s+\.(?:\s|$)/i },
  // Plain `git push` — NOISIEST rule; comment it out if it gets in your way.
  { label: "git push (publishes to remote)", re: /\bgit\b[^\n]*\bpush\b/i },
];

// ── 3) Privilege, system & secrets ───────────────────────────────────────────
const SYS_RULES: Rule[] = [
  { label: "sudo / privilege escalation", re: /(?:^|\s|\||&|;)\s*sudo\b|(?:^|\s)doas\b/i },
  { label: "chmod 777 / world-writable", re: /\bchmod\b[^\n]*(?:-R[^\n]*)?(?:777|a\+w|o\+w)\b/i },
  { label: "chown -R", re: /\bchown\b[^\n]*-R\b/i },
  { label: "service manager (systemctl/service/launchctl)", re: /\b(?:systemctl|launchctl)\b|\bservice\s+\S+\s+(?:stop|start|restart|disable)\b/i },
  { label: "kill -9 / killall / pkill", re: /\b(?:kill\s+-(?:9|KILL)|killall|pkill)\b/i },
  // Secret material referenced by path (read/copy/exfil of keys & creds).
  { label: "touches secret/credential files", re: /(?:\.ssh\/id_|id_rsa|id_ed25519|\.aws\/credentials|\.config\/gcloud|\.netrc|\.pgpass|\.npmrc|\bcredentials\b[^\n]*\.json|[^\n]*\.pem\b|[^\n]*\.key\b|(?:^|\s|\/)\.env(?:\.|\s|$))/i },
];

// ── 4) Outbound, publish & infra ─────────────────────────────────────────────
const NET_RULES: Rule[] = [
  { label: "pipe download into shell (curl|sh)", re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|)sh\b/i },
  { label: "reverse shell / raw socket", re: /\/dev\/tcp\/|\b(?:nc|ncat|netcat)\b[^\n]*(?:-e|-c|\s\d{2,5}\b)|mkfifo\b[^\n]*\|/i },
  { label: "package publish (npm/cargo/pip/gem)", re: /\b(?:npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bpoetry\s+publish\b/i },
  { label: "release / artifact upload", re: /\bgh\s+release\s+(?:create|upload)\b|\bdocker\b[^\n]*\bpush\b/i },
  { label: "container/infra mutate (k8s/terraform/docker)", re: /\bkubectl\s+(?:delete|apply)\b|\bterraform\s+(?:apply|destroy)\b|\bdocker\b[^\n]*\b(?:rm|rmi|system\s+prune|volume\s+rm)\b/i },
  { label: "cloud CLI destroy (aws/gcloud/az)", re: /\b(?:aws|gcloud|az)\b[^\n]*\b(?:delete|destroy|terminate|rm)\b/i },
];

// ── 5) GitHub CLI (gh) — any state-changing action ───────────────────────────
// Policy: read-only verbs (view, list, status, diff, clone, search, browse) run
// freely; ANYTHING that creates/edits/deletes/publishes is confirmed. Verbs are
// matched after `gh` so the word must follow the binary, not appear in a string.
const GH_RULES: Rule[] = [
  // gh api with a mutating HTTP method, or with field flags (gh api auto-switches
  // to POST when -f/-F/--field/--raw-field is present), or a non-GET --method.
  {
    label: "gh api (write request)",
    re: /\bgh\s+api\b[^\n]*(?:(?:-X|--method)[ =]?\s*(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-f|-F|--field|--raw-field)\b)/i,
  },
  // gh <noun> <mutating-verb> — covers pr/issue/release/repo/gist/secret/variable/
  // label/workflow/run/cache/ruleset/ssh-key/gpg-key/extension etc.
  {
    label: "gh (state-changing command)",
    re: /\bgh\b[^\n]*\b(?:create|delete|edit|merge|close|reopen|comment|rename|archive|unarchive|transfer|upload|fork|sync|ready|lock|unlock|pin|unpin|enable|disable|restore|rerun|cancel|revoke|approve|clear|set|add|remove)\b/i,
    head: true,
  },
  // gh workflow run / gh run cancel etc. ("run" as a verb, not the `gh run` noun's
  // read subcommands like `gh run view|list|watch`).
  { label: "gh workflow run", re: /\bgh\s+workflow\b[^\n]*\brun\b/i, head: true },
];

// ── 6) Atlassian CLI (acli) — any state-changing action ──────────────────────
// Read-only verbs (view, list, search, get, export, validate) run freely.
const ACLI_RULES: Rule[] = [
  {
    label: "acli (state-changing command)",
    re: /\bacli\b[^\n]*\b(?:create|update|delete|transition|assign|edit|comment|add|remove|set|move|clone|link|unlink|archive|restore|upload|import|close|reopen|rank|watch|unwatch|vote)\b/i,
    head: true,
  },
];

const RULES: Rule[] = [...FS_RULES, ...GIT_RULES, ...SYS_RULES, ...NET_RULES, ...GH_RULES, ...ACLI_RULES];

// Per shell-segment, drop everything from the first flag (` -x` / ` --flag`)
// onward, keeping only the subcommand path. `gh pr view 1 --json x && gh issue
// create --title y` -> `gh pr view 1 ; gh issue create`. Verb rules run against
// this so flag VALUES never match, but a real verb in any segment still does.
function commandHead(command: string): string {
  return command
    .split(/[\n;|&]+/)
    .map((seg) => seg.split(/\s+-/)[0].trim())
    .filter(Boolean)
    .join(" ; ");
}

function firstMatch(command: string): Rule | undefined {
  const head = commandHead(command);
  return RULES.find((r) => r.re.test(r.head ? head : command));
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
      `⚠️  danger-guard: ${hit.label}`,
      `Allow this command?\n\n${command}`,
    );
    if (!ok) return { block: true, reason: `danger-guard: user denied (${hit.label})` };
    // approved -> fall through (return undefined) to let the command run.
  });
}
