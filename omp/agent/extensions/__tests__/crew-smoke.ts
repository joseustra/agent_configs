/**
 * Smoke harness for omp-crew. Run it, read the output:
 *
 *   bun omp/agent/extensions/__tests__/crew-smoke.ts
 *
 * It loads the real extension against a fake `api.pi` barrel and a fake agent
 * registry, then paints the tree and prints what dispatch was handed. It is
 * deliberately not a `.test.ts`: there are no assertions, because what it
 * checks is a rendering, and the useful question ("does this read right?") is
 * one only a person can answer.
 *
 * This is the response to the version tripwire, not a standing gate — when omp
 * warns that a major bump may have moved a contract underneath crew, run this
 * and look at cases 1, 3 and 3c.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ompCrew, { fallbackMatch } from "../omp-crew.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crew-smoke-"));
const agentDir = path.join(tmp, "agentdir");
await fs.mkdir(agentDir, { recursive: true });

// ── output payloads, one per shape D8 enumerated ─────────────────────────────
const out = async (id: string, body: string) => {
  const p = path.join(tmp, `${id}.md`);
  await Bun.write(p, body);
  return p;
};

const refs: any[] = [
  { id: "root-a", displayName: "implement", kind: "sub", parentId: "Main", status: "running",
    createdAt: 1, activity: "editing omp-crew.ts", session: { progress: { tokens: 12400, cost: 0.31 } } },
  { id: "kid-a1", displayName: "research", kind: "sub", parentId: "root-a", status: "idle",
    createdAt: 2, history: { outputPath: await out("kid-a1", "Husky pre-push is the only hook that runs before refs leave the box.\n\nMore detail here.") } },
  { id: "kid-a2", displayName: "nested-deep", kind: "sub", parentId: "kid-a1", status: "running",
    createdAt: 3, activity: "running bun test" },
  { id: "root-b", displayName: "branch-review", kind: "sub", parentId: "Main", status: "idle",
    createdAt: 4, history: { outputPath: await out("root-b", JSON.stringify({ verdict: "merge-after-fixes", blockers: 2 })) } },
  { id: "root-c", displayName: "aborted-one", kind: "sub", parentId: "Main", status: "idle",
    createdAt: 5, history: { outputPath: await out("root-c", JSON.stringify({ aborted: true, error: "model role unavailable" })) } },
  { id: "root-d", displayName: "never-yielded", kind: "sub", parentId: "Main", status: "idle",
    createdAt: 6, history: { outputPath: await out("root-d", "SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.") } },
  { id: "root-e", displayName: "no-output", kind: "sub", parentId: "Main", status: "idle", createdAt: 7 },
  { id: "root-f", displayName: "missing-file", kind: "sub", parentId: "Main", status: "idle",
    createdAt: 8, history: { outputPath: path.join(tmp, "does-not-exist.md") } },
  // must NOT appear: advisor, main, aborted. parked DOES appear — it is alive.
  { id: "adv", displayName: "advisor", kind: "advisor", parentId: "Main", status: "running", createdAt: 9 },
  { id: "main", displayName: "you", kind: "main", status: "running", createdAt: 0 },
  { id: "parked", displayName: "parked-one", kind: "sub", parentId: "Main", status: "parked", createdAt: 10 },
  { id: "dead", displayName: "dead-one", kind: "sub", parentId: "Main", status: "aborted", createdAt: 11 },
];

const registry = {
  list: () => refs,
  get: (id: string) => refs.find(r => r.id === id),
  onChange: (_cb: any) => () => {},
};

let dispatched: any = null;
const makeApi = (over: Record<string, unknown> = {}) => ({
  setLabel: () => {},
  registerShortcut: (_k: string, o: any) => { handlers.shortcut = o.handler; },
  registerCommand: (_n: string, o: any) => { handlers.command = o.handler; },
  on: (_e: string, h: any) => { handlers.session_start = h; },
  events: { fake: true },
  pi: {
    VERSION: "17.2.10",
    AgentRegistry: { global: () => registry },
    runSubprocess: async (opts: any) => { dispatched = opts; return {}; },
    discoverAgents: async () => ({ implement: { name: "implement", description: "builds things" },
                                   research: { name: "research", description: "reads things" } }),
    getAgentDir: () => agentDir,
    settings: { fake: true },
    ...over,
  },
});

const handlers: any = {};

// ── fake UI ──────────────────────────────────────────────────────────────────
const notices: string[] = [];
let keyScript: string[] = [];

function makeCtx(answers: any = {}) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    modelRegistry: { fake: true },
    sessionManager: { getSessionFile: () => "/sessions/abc/2026-01-01T00-00-00_uuid.jsonl" },
    ui: {
      notify: (t: string, l: string) => notices.push(`[${l}] ${t}`),
      input: async (..._a: any[]) => answers.input,
      select: async (..._a: any[]) => answers.select,
      editor: async (..._a: any[]) => answers.editor,
      custom: async (factory: any, _opts: any) => {
        let resolve: (v: any) => void;
        const p = new Promise<any>(r => { resolve = r; });
        const tui = { requestRender: () => {} };
        const comp = factory(tui, {}, {}, (a: any) => resolve(a));
        // one render before input, one after, then whatever the script says
        const before = comp.render(100);
        // consume, so a re-opened overlay does not replay the whole script
        while (keyScript.length > 0) {
          const k = keyScript.shift()!;
          comp.handleInput(k);
        }
        comp.handleInput("\x1b");
        await Bun.sleep(30); // let lazy summary reads land
        const after = comp.render(100);
        comp.dispose();
        lastRender = after;
        firstRender = before;
        if (!settled) { settled = true; }
        return p;
      },
    },
  } as any;
}

let firstRender: readonly string[] = [];
let lastRender: readonly string[] = [];
let settled = false;

const show = (title: string, lines: readonly string[]) => {
  console.log(`\n══ ${title} ${"═".repeat(Math.max(0, 60 - title.length))}`);
  for (const l of lines) if (l.replace(/\x1b\[[0-9;]*m/g, "").trim()) console.log(l);
};

// ── 1. healthy tree ──────────────────────────────────────────────────────────
{
  const api = makeApi();
  ompCrew(api as any);
  keyScript = ["\x1b"]; // close after the first paint
  const ctx = makeCtx();
  await handlers.shortcut(ctx).catch(() => {});
  show("1. first paint (summaries not yet read)", firstRender);
  show("1. after lazy reads", lastRender);
}

// ── 2. navigation + collapse ─────────────────────────────────────────────────
{
  const api = makeApi();
  ompCrew(api as any);
  keyScript = ["j", "\r", "j", "j", "\r", "\x1b"];
  const ctx = makeCtx();
  await handlers.shortcut(ctx).catch(() => {});
  show("2. after j/enter/j/j/enter (collapse + summary expand)", lastRender);
}

// ── 3. dispatch flow ─────────────────────────────────────────────────────────
{
  const api = makeApi();
  ompCrew(api as any);
  keyScript = ["n", "\x1b"];
  const ctx = makeCtx({ select: "research", editor: "go read the registry", input: "checkout-flow" });
  await handlers.shortcut(ctx).catch(() => {});
  await Bun.sleep(30);
  console.log("\n══ 3. dispatch ═══════════════════════════════════════════════");
  console.log("runSubprocess called with:", dispatched && {
    agent: dispatched.agent?.name, task: dispatched.task, id: dispatched.id,
    artifactsDir: dispatched.artifactsDir, eventBus: !!dispatched.eventBus,
    parentToolCallId: dispatched.parentToolCallId, hasSettings: !!dispatched.settings,
    modelOverridePresent: "modelOverride" in dispatched,
  });
  console.log("features.json:", await Bun.file(path.join(agentDir, "crew", "features.json")).text().catch(() => "(none)"));
  console.log("notices:", notices.slice(-2));
}

// ── 3b. dispatch onto a new feature, from the "＋ new feature…" row ──────────
{
  notices.length = 0;
  dispatched = null;
  const api = makeApi();
  ompCrew(api as any);
  // walk to the last selectable row (＋ new feature…) then n
  keyScript = ["j","j","j","j","j","j","j","j","j","j","n"];
  const ctx = makeCtx({ select: "implement", editor: "build the thing", input: "checkout-flow" });
  await handlers.shortcut(ctx).catch(() => {});
  await Bun.sleep(30);
  console.log("\n══ 3b. dispatch onto a new feature ═══════════════════════════");
  console.log("agent:", dispatched?.agent?.name, "| notices:", notices);
  console.log("features.json:", await Bun.file(path.join(agentDir, "crew", "features.json")).text().catch(() => "(none)"));
}

// ── 3c. `f` assigns a feature, and it walks to the root ancestor ─────────────
{
  notices.length = 0;
  const api = makeApi();
  ompCrew(api as any);
  // cursor: header, j → implement, j → research (a CHILD), then f
  keyScript = ["j", "j", "f"];
  const ctx = makeCtx({ select: "checkout-flow" });
  await handlers.shortcut(ctx).catch(() => {});
  await Bun.sleep(30);
  show("3c. `f` on the nested `research` row regroups its ROOT (implement)", lastRender);
}

// ── 3d-pre. every encoding omp can deliver reaches the same action ───────────
// Regression for the real bug: on a Kitty-protocol terminal ctrl+s arrives as
// \x1b[115;5u, never as \x13. Raw byte equality matched only the legacy form.
{
  console.log("\n══ 3d-pre. key encodings ═════════════════════════════════════");
  const cases: [string, string, string][] = [
    ["\x13",             "ctrl+s", "ctrl+s legacy"],
    ["\x1b[115;5u",      "ctrl+s", "ctrl+s kitty"],
    ["\x1b[27;5;115~",   "ctrl+s", "ctrl+s modifyOtherKeys"],
    ["\x1ba",            "alt+a",  "alt+a legacy"],
    ["\x1b[97;3u",       "alt+a",  "alt+a kitty"],
    ["\x1b[99;3u",       "alt+c",  "alt+c kitty"],
    ["\x1b",             "escape", "escape legacy"],
    ["\x1b[27u",         "escape", "escape kitty"],
    ["\r",               "enter",  "enter legacy"],
    ["\x1b[13u",         "enter",  "enter kitty"],
    ["j",                "j",      "plain j"],
    ["\x1b[A",           "up",     "up arrow"],
    ["\x1b[115;6u",      "shift+ctrl+s", "modifier order insensitive"],
  ];
  for (const [bytes, key, label] of cases) {
    const ok = fallbackMatch(bytes, key);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(28)} ${JSON.stringify(bytes)} vs "${key}"`);
  }
  // a key release must NOT fire the action
  const release = fallbackMatch("\x1b[97;3:3u", "alt+a");
  console.log(`  ${release === false ? "ok  " : "FAIL"} key release ignored`);
}

// ── 3d. ctrl+s inside crew hands off instead of being swallowed ──────────────
// Regression: omp binds its hub on the editor, which is dark while this overlay
// is mounted, so ctrl+s here used to do nothing at all.
{
  notices.length = 0;
  const api = makeApi();
  ompCrew(api as any);
  keyScript = ["j", "\x13"]; // cursor onto `implement`, then ctrl+s
  const ctx = makeCtx();
  await handlers.shortcut(ctx).catch(() => {});
  await Bun.sleep(30);
  console.log("\n══ 3d. ctrl+s handoff ════════════════════════════════════════");
  console.log("notices:", notices);
}
{
  notices.length = 0;
  const api = makeApi();
  ompCrew(api as any);
  keyScript = ["\x1ba"]; // alt+a on a header row — no agent named
  const ctx = makeCtx();
  await handlers.shortcut(ctx).catch(() => {});
  await Bun.sleep(30);
  console.log("alt+a on a non-agent row:", notices);
}

// ── 3e. parked agents stay visible; aborted ones do not ─────────────────────
// omp parks an idle agent after task.agentIdleTtlMs (7 min default). A
// running|idle filter made it silently vanish while still alive and revivable.
{
  refs.push({ id: "root-g", displayName: "parked-alive", kind: "sub", parentId: "Main",
              status: "parked", createdAt: 11 });
  refs.push({ id: "root-h", displayName: "really-aborted", kind: "sub", parentId: "Main",
              status: "aborted", createdAt: 12 });
  const api = makeApi();
  ompCrew(api as any);
  keyScript = [];
  const ctx = makeCtx();
  await handlers.shortcut(ctx).catch(() => {});
  const text = lastRender.join("\n");
  console.log("\n══ 3e. parked vs aborted ═════════════════════════════════════");
  console.log(`  ${text.includes("parked-alive") ? "ok  " : "FAIL"} parked agent is still shown`);
  console.log(`  ${!text.includes("really-aborted") ? "ok  " : "FAIL"} aborted agent is hidden`);
  refs.length = refs.length - 2;
}

// ── 4. registry missing → tombstone ──────────────────────────────────────────
{
  notices.length = 0;
  const api = makeApi({ AgentRegistry: undefined });
  ompCrew(api as any);
  const ctx = makeCtx();
  await handlers.session_start({}, ctx);
  keyScript = ["\x1b"];
  await handlers.shortcut(ctx).catch(() => {});
  show("4. tombstone", lastRender);
  console.log("notices:", notices);
}

// ── 5. runSubprocess missing → dispatch degrades alone ───────────────────────
{
  notices.length = 0;
  const api = makeApi({ runSubprocess: undefined });
  ompCrew(api as any);
  const ctx = makeCtx();
  await handlers.session_start({}, ctx);
  keyScript = ["n", "\x1b"];
  await handlers.shortcut(ctx).catch(() => {});
  show("5. tree still works, n visibly broken", lastRender.slice(-5));
  console.log("notices:", notices);
}

// ── 6. major version bump → warning only ─────────────────────────────────────
{
  notices.length = 0;
  const api = makeApi({ VERSION: "18.0.0" });
  ompCrew(api as any);
  const ctx = makeCtx();
  await handlers.session_start({}, ctx);
  console.log("\n══ 6. major bump ═════════════════════════════════════════════");
  console.log("notices:", notices);
}

// ── 7. patch bump → silent ───────────────────────────────────────────────────
{
  notices.length = 0;
  const api = makeApi({ VERSION: "17.9.99" });
  ompCrew(api as any);
  const ctx = makeCtx();
  await handlers.session_start({}, ctx);
  console.log("\n══ 7. patch bump ═════════════════════════════════════════════");
  console.log("notices (expect none):", notices);
}

await fs.rm(tmp, { recursive: true, force: true });
