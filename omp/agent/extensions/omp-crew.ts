/**
 * omp crew — a live control plane over omp's own agent registry.
 *
 * This is the CANONICAL source. Ship it to:
 *   - Host: ~/.omp/agent/extensions/omp-crew.ts  (symlink/copy of this file)
 * omp auto-discovers any *.ts/*.js under that `extensions/` dir at startup.
 *
 * What it is:
 *   alt+c (or /crew) opens one collapsible outline of every agent alive right
 *   now — omp's registry is the source of truth, crew keeps no roster — grouped
 *   by the feature you dispatched them under, nesting each agent's own spawns
 *   beneath it. Running rows show what they are doing and what they have spent;
 *   finished rows show a one-line summary of what they yielded.
 *
 * What it is NOT:
 *   Crew never renders a transcript and has no attach. omp's own agent hub
 *   (ctrl+s or alt+a, then Enter) attaches, kills, and messages; crew points at
 *   the agent and gets out of the way. Only three verbs live here, and only
 *   because the hub cannot offer them: `n` dispatch, `f` feature, `o` output.
 *
 *   Handing off costs two keystrokes, not one, and that is structural: omp binds
 *   the hub on the editor, which sees no input while an extension overlay is
 *   mounted. So ctrl+s/alt+a inside crew closes crew and says what to press
 *   next, rather than being silently swallowed — which is what it did until a
 *   second machine caught it.
 *
 * State:
 *   In-memory only, for the lifetime of the process — the agent→feature mapping
 *   has the same lifetime as the registry it describes. The single persisted
 *   thing is the feature-name vocabulary at <agent-dir>/crew/features.json, so
 *   the "new feature" picker remembers what you have been calling things.
 *   Nothing is ever written into your repository.
 *
 * Version note: verified against oh-my-pi v17.2.10. Everything crew needs comes
 * off `api.pi`, the package's own root barrel handed to extensions — but none of
 * it is part of the sanctioned ExtensionAPI, so every symbol is resolved
 * defensively and a missing one degrades loudly instead of killing the
 * extension. A major-version bump warns; see VERIFIED_AGAINST.
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
// Type-only, so nothing here has to resolve at runtime — but it does make the
// compiler check the one contract omp actually calls back into.
import type { Component } from "@oh-my-pi/pi-tui";

// ── omp surface ──────────────────────────────────────────────────────────────
// Nothing here is imported at module scope: a bare `import { X } from
// "@oh-my-pi/pi-coding-agent"` that no longer resolves turns into omp's
// "Failed to load extension:" line, which scrolls past and reads like a bad
// install. Resolving off `api.pi` — the same barrel, handed to us — lets a
// vanished symbol surface as a message about that symbol instead.

/** The omp release this file's use of the barrel was verified against. */
const VERIFIED_AGAINST = "17.3.0";

/** A registry entry. Shaped by AgentRegistry.register(); see docs/research/r2. */
interface AgentRef {
	id: string;
	displayName: string;
	kind: "main" | "sub" | "advisor";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	session?: { progress?: { tokens?: number; cost?: number } } | null;
	sessionFile?: string | null;
	createdAt: number;
	lastActivity?: number;
	activity?: string;
	history?: { outputPath?: string };
}

interface Registry {
	list(): AgentRef[];
	get(id: string): AgentRef | undefined;
	onChange(listener: (event: { type: string; ref: AgentRef }) => void): () => void;
}

/** A parsed agent definition from <agent-dir>/agents/*.md and friends. */
interface AgentDef {
	name: string;
	description?: string;
	model?: string;
	source?: string;
}

interface Barrel {
	VERSION?: string;
	AgentRegistry?: { global(): Registry };
	runSubprocess?: (opts: Record<string, unknown>) => Promise<unknown>;
	discoverAgents?: (cwd: string) => Promise<unknown>;
	getAgentDir?: () => string;
	settings?: unknown;
}

/** What crew could not find on the barrel. Empty means a healthy install. */
interface Breakage {
	/** Fatal: no tree at all. */
	registry?: string;
	/** Partial: the tree works, dispatch does not. */
	dispatch?: string;
	/** Soft: symbols resolved, but this is not the omp we were verified against. */
	version?: string;
}

let barrel: Barrel = {};
let breakage: Breakage = {};
let registryRef: Registry | undefined;

function resolveOmp(pi: ExtensionAPI): void {
	barrel = (pi as unknown as { pi?: Barrel }).pi ?? {};
	breakage = {};
	notifiedBreakage = false;

	const AgentRegistry = barrel.AgentRegistry;
	if (typeof AgentRegistry?.global !== "function") {
		breakage.registry = "AgentRegistry.global()";
	} else {
		try {
			registryRef = AgentRegistry.global();
		} catch (err) {
			breakage.registry = `AgentRegistry.global() threw: ${message(err)}`;
		}
	}

	if (typeof barrel.runSubprocess !== "function") breakage.dispatch = "runSubprocess";
	if (typeof barrel.discoverAgents !== "function") breakage.dispatch = "discoverAgents";

	// A resolved symbol whose contract moved underneath us is the failure a
	// presence check cannot see. Majors only: a patch-level nag becomes noise
	// you learn to dismiss, and an in-major contract change is a blind spot we
	// accept rather than pretend to cover.
	const version = barrel.VERSION;
	if (typeof version === "string" && major(version) !== major(VERIFIED_AGAINST)) {
		breakage.version = `omp ${version} vs verified ${VERIFIED_AGAINST}`;
	}
}

const major = (v: string) => v.split(".")[0];

const registry = (): Registry | undefined => registryRef;

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ── Module state ─────────────────────────────────────────────────────────────

let cwd = "";
let notifiedBreakage = false;
let nextIndex = 1;

/**
 * agentId → feature, for top-level agents only. Deliberately not persisted:
 * these keys live and die with the process-global registry, so a file would
 * only ever be read back full of ids that are already dead.
 */
const featureById = new Map<string, string>();

/** agentId → derived one-line result summary. Read from disk once per agent. */
const summaryById = new Map<string, string>();
const summaryPending = new Set<string>();

const UNGROUPED = "(no feature)";
const NEW_FEATURE = "＋ new feature…";
const CLEAR_FEATURE = "(no feature)";

// ── Feature vocabulary ───────────────────────────────────────────────────────
// The only thing crew writes anywhere. Not a mapping — just the names you have
// used, so the picker can offer them again. Written on successful dispatch and
// read only to fill a picker, so it cannot desync from anything.

interface FeatureFile {
	version: 1;
	byCwd: Record<string, string[]>;
}

const FEATURE_CAP = 20;

function featureFile(): string | undefined {
	const dir = barrel.getAgentDir?.();
	return dir ? path.join(dir, "crew", "features.json") : undefined;
}

async function readFeatures(): Promise<string[]> {
	const file = featureFile();
	if (!file) return [];
	try {
		const raw = JSON.parse(await Bun.file(file).text()) as FeatureFile;
		// Keyed by the raw absolute cwd — never omp's encoded session slug, which
		// has migration code behind it and is not ours to reproduce.
		return raw.byCwd?.[cwd] ?? [];
	} catch {
		return [];
	}
}

async function rememberFeature(name: string): Promise<void> {
	const file = featureFile();
	if (!file) return;
	try {
		let data: FeatureFile = { version: 1, byCwd: {} };
		try {
			data = JSON.parse(await Bun.file(file).text()) as FeatureFile;
			data.byCwd ??= {};
		} catch {
			// first write in this profile
		}
		const existing = (data.byCwd[cwd] ?? []).filter(f => f !== name);
		data.byCwd[cwd] = [name, ...existing].slice(0, FEATURE_CAP);
		await Bun.write(file, JSON.stringify(data, null, 2));
	} catch {
		// A vocabulary we failed to write is a picker that forgets a name, not a
		// broken dispatch — never surface it.
	}
}

// ── Tree model ───────────────────────────────────────────────────────────────

/**
 * The agents worth showing: omp's own hub cut (no advisors), narrowed to the
 * live ones. `parked` and `aborted` entries are agents omp has finished with —
 * once it parks them at task.agentIdleTtlMs they leave the tree, and that TTL is
 * the only expiry crew has or wants.
 */
function visibleRefs(): AgentRef[] {
	const reg = registry();
	if (!reg) return [];
	let all: AgentRef[];
	try {
		all = reg.list();
	} catch {
		return [];
	}
	return all.filter(
		// `main` is the session you are typing in — you are already looking at it.
		r => r.kind !== "advisor" && r.kind !== "main" && (r.status === "running" || r.status === "idle"),
	);
}

function childrenOf(id: string, refs: AgentRef[]): AgentRef[] {
	return refs.filter(r => r.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
}

/** Top-level agents: those whose parent is not itself in the tree. */
function rootsOf(refs: AgentRef[]): AgentRef[] {
	const ids = new Set(refs.map(r => r.id));
	return refs.filter(r => !r.parentId || !ids.has(r.parentId)).sort((a, b) => a.createdAt - b.createdAt);
}

/** Only top-level agents hold a feature; a nested spawn inherits its ancestor's. */
function rootAncestor(ref: AgentRef, refs: AgentRef[]): AgentRef {
	const byId = new Map(refs.map(r => [r.id, r]));
	let current = ref;
	for (let hops = 0; hops < 64; hops++) {
		const parent = current.parentId ? byId.get(current.parentId) : undefined;
		if (!parent) return current;
		current = parent;
	}
	return current;
}

function featureOf(ref: AgentRef, refs: AgentRef[]): string {
	return featureById.get(rootAncestor(ref, refs).id) ?? UNGROUPED;
}

function descendants(ref: AgentRef, refs: AgentRef[]): AgentRef[] {
	return childrenOf(ref.id, refs).flatMap(c => [c, ...descendants(c, refs)]);
}

// ── Result summaries ─────────────────────────────────────────────────────────
// The .md at history.outputPath IS the yield payload, verbatim — no frontmatter,
// no title. So "take the first line" is dead: omp's default yield is an
// unconstrained JSON object, and free text only happens when an agent opts into
// it (a terminal string `type` with `data` omitted, which is why the crew agent
// definitions ask for exactly that). Every shape it can take is typed instead,
// and none of them may render as a blank cell: an empty row reads as "still
// thinking" when it actually means "finished with nothing to say".

const NEVER_YIELDED = /exited without calling yield tool/i;

function deriveSummary(raw: string): string {
	const text = raw.trim();
	if (!text) return "(empty)";
	if (NEVER_YIELDED.test(text)) return "(no output)";
	// omp's other yield-protocol failures (null data, schema-retry exhausted)
	// arrive as boilerplate prose; say so rather than quoting it as a result.
	if (text.startsWith("SYSTEM WARNING:")) return `(${text.slice("SYSTEM WARNING:".length).trim().split(".")[0]})`;

	if (text.startsWith("{") || text.startsWith("[")) {
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				if (parsed.aborted) return `(aborted${parsed.error ? `: ${String(parsed.error)}` : ""})`;
				if (parsed.error) return `(failed: ${String(parsed.error)})`;
			}
			// Flatten, never key-guess: picking a "summary"/"result" key would
			// invent a convention the yielding agent never agreed to.
			return flatten(parsed);
		} catch {
			// Not JSON after all — fall through and treat it as prose.
		}
	}

	return text.split("\n").find(l => l.trim().length > 0)?.trim() ?? "(empty)";
}

function flatten(value: unknown): string {
	return JSON.stringify(value)?.replace(/[{}"]/g, "").replace(/,/g, " · ").replace(/\s+/g, " ").trim() || "(empty)";
}

/**
 * An idle row with no cached summary reads its file once, on first render, and
 * caches the result. The history `metadata_changed` event is an optimisation on
 * top of this, not the mechanism: an agent already idle when the overlay first
 * opens fired its event long before anyone was listening.
 */
function summaryFor(ref: AgentRef, repaint: () => void): string | undefined {
	if (ref.status !== "idle") return undefined;
	const cached = summaryById.get(ref.id);
	if (cached !== undefined) return cached;
	if (summaryPending.has(ref.id)) return undefined;

	const outputPath = ref.history?.outputPath;
	if (!outputPath) {
		summaryById.set(ref.id, "(no output)");
		return summaryById.get(ref.id);
	}

	summaryPending.add(ref.id);
	void Bun.file(outputPath)
		.text()
		.then(raw => summaryById.set(ref.id, deriveSummary(raw)))
		.catch(() => summaryById.set(ref.id, "(output unavailable)"))
		.finally(() => {
			summaryPending.delete(ref.id);
			repaint();
		});
	return undefined;
}

// ── Presentation ─────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}22m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}22m`;
const inverse = (s: string) => `${ESC}7m${s}${ESC}27m`;
const paint = (n: number, s: string) => `${ESC}${n}m${s}${ESC}39m`;
const green = (s: string) => paint(32, s);
const grey = (s: string) => paint(90, s);
const red = (s: string) => paint(31, s);
const yellow = (s: string) => paint(33, s);

const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function clip(s: string, width: number): string {
	if (visLen(s) <= width) return s;
	// Walk the string keeping escape sequences intact, counting only visible cells.
	let out = "";
	let seen = 0;
	for (let i = 0; i < s.length; ) {
		if (s[i] === "\x1b") {
			const end = s.indexOf("m", i);
			if (end === -1) break;
			out += s.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (seen >= width - 1) return `${out}…${ESC}0m`;
		out += s[i];
		seen++;
		i++;
	}
	return out;
}

const shortId = (id: string) => id.slice(-6);

function glyph(ref: AgentRef): string {
	return ref.status === "running" ? green("●") : grey("○");
}

function spend(ref: AgentRef): string {
	// Usage lives on the live session, not on the registry entry — so it exists
	// precisely while an agent is running and is gone the moment it is not.
	const p = ref.session?.progress;
	if (!p) return "";
	const tokens = typeof p.tokens === "number" ? `${Math.round(p.tokens / 1000)}k tok` : "";
	const cost = typeof p.cost === "number" ? `$${p.cost.toFixed(2)}` : "";
	const parts = [tokens, cost].filter(Boolean);
	return parts.length > 0 ? `  ${dim(parts.join(" · "))}` : "";
}

// ── Rows ─────────────────────────────────────────────────────────────────────

type Row =
	| { kind: "header"; key: string; feature: string; text: string; selectable: true }
	| { kind: "agent"; key: string; ref: AgentRef; text: string; selectable: true }
	| { kind: "new-feature"; key: string; text: string; selectable: true }
	| { kind: "filler"; key: string; text: string; selectable: false };

type SelectableRow = Extract<Row, { selectable: true }>;

const isSelectable = (row: Row): row is SelectableRow => row.selectable;

interface TreeState {
	collapsed: Set<string>;
	expanded: Set<string>;
	repaint: () => void;
	width: number;
}

function agentText(ref: AgentRef, depth: number, hasChildren: boolean, state: TreeState): string {
	const pad = "  ".repeat(depth);
	const marker = hasChildren ? (state.collapsed.has(ref.id) ? "▸ " : "▾ ") : "  ";
	const head = `${pad}${marker}${glyph(ref)} ${ref.displayName}`;

	// One slot, shared: setStatus wipes `activity` the instant an agent stops
	// running, so "keep the last activity next to the summary" is not a choice
	// that exists.
	if (ref.status === "running") {
		const doing = ref.activity ? `  ${dim(`· ${ref.activity}`)}` : `  ${dim("· working")}`;
		return `${head}${doing}${spend(ref)}`;
	}
	const summary = summaryFor(ref, state.repaint);
	if (summary === undefined) return `${head}  ${dim("· reading output…")}`;
	if (state.expanded.has(ref.id)) return head;
	return `${head}  ${dim(`↳ ${summary}`)}`;
}

function wrapSummary(text: string, indent: number, width: number): string[] {
	const avail = Math.max(20, width - indent - 4);
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line && `${line} ${word}`.length > avail) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) lines.push(line);
	return lines.map(l => `${" ".repeat(indent + 4)}${dim(l)}`);
}

function buildRows(state: TreeState): Row[] {
	const refs = visibleRefs();
	const rows: Row[] = [];

	const pushAgent = (ref: AgentRef, depth: number) => {
		const kids = childrenOf(ref.id, refs);
		rows.push({
			kind: "agent",
			key: ref.id,
			ref,
			text: agentText(ref, depth, kids.length > 0, state),
			selectable: true,
		});
		if (state.expanded.has(ref.id)) {
			const summary = summaryById.get(ref.id);
			if (summary) {
				for (const [i, line] of wrapSummary(summary, depth * 2, state.width).entries()) {
					rows.push({ kind: "filler", key: `${ref.id}:sum:${i}`, text: line, selectable: false });
				}
			}
		}
		if (!state.collapsed.has(ref.id)) for (const kid of kids) pushAgent(kid, depth + 1);
	};

	const roots = rootsOf(refs);
	const byFeature = new Map<string, AgentRef[]>();
	for (const root of roots) {
		const feature = featureById.get(root.id) ?? UNGROUPED;
		byFeature.set(feature, [...(byFeature.get(feature) ?? []), root]);
	}

	for (const [feature, agents] of byFeature) {
		const all = agents.flatMap(a => [a, ...descendants(a, refs)]);
		const running = all.filter(a => a.status === "running").length;
		const key = `feature:${feature}`;
		const marker = state.collapsed.has(key) ? "▸" : "▾";
		rows.push({
			kind: "header",
			key,
			feature,
			text: `${marker} ${bold(feature)}  ${dim(`${running} running · ${all.length} total`)}`,
			selectable: true,
		});
		if (!state.collapsed.has(key)) for (const agent of agents) pushAgent(agent, 1);
		rows.push({ kind: "filler", key: `${key}:gap`, text: "", selectable: false });
	}

	rows.push({ kind: "new-feature", key: "new-feature", text: `  ${dim(NEW_FEATURE)}`, selectable: true });
	return rows;
}

// ── Overlay ──────────────────────────────────────────────────────────────────

type Action =
	| { type: "dispatch"; feature?: string; askFeature: boolean }
	| { type: "feature"; agentId: string }
	| { type: "open"; agentId: string }
	| { type: "handoff"; agentId?: string };

const DEBUG_KEYS = !!process.env.CREW_DEBUG_KEYS;

// ── Key matching ─────────────────────────────────────────────────────────────
// Never compare raw bytes. omp asks the terminal for the Kitty keyboard
// protocol at startup and falls back to xterm modifyOtherKeys if it gets no
// answer within 150ms, so the *same* key arrives as different bytes on
// different terminals: ctrl+s is `\x13` on Terminal.app and `\x1b[115;5u` on
// Ghostty. Hand-rolled byte equality silently matched only the first, which is
// how crew shipped with every modified key dead on half the machines.
//
// omp's own matcher handles all three encodings, but it lives on `pi-tui`, not
// on the `api.pi` barrel — so it is loaded dynamically, and a fallback covers
// the same grammar if that ever stops resolving. Per D7: degrade, never vanish.

type KeyMatcher = (data: string, key: string) => boolean;

let matchKey: KeyMatcher = fallbackMatch;
let keyMatcherLoaded = false;

async function loadKeyMatcher(): Promise<void> {
	if (keyMatcherLoaded) return;
	keyMatcherLoaded = true;
	try {
		const mod = (await import("@oh-my-pi/pi-tui")) as { matchesKey?: KeyMatcher };
		if (typeof mod.matchesKey === "function") matchKey = mod.matchesKey;
	} catch {
		// Keep the fallback. Crew stays usable; it just knows fewer keys.
	}
}

/** `1 + bitmask`, with caps-lock (64) and num-lock (128) masked off. */
function modifierNames(mods: number): string[] {
	const names: string[] = [];
	if (mods & 1) names.push("shift");
	if (mods & 4) names.push("ctrl");
	if (mods & 2) names.push("alt");
	if (mods & 8) names.push("super");
	return names;
}

function namedKey(codepoint: number, mods: number): string | undefined {
	const base =
		codepoint === 27 ? "escape" : codepoint === 13 ? "enter" : codepoint === 9 ? "tab" : codepoint === 32 ? "space" : String.fromCodePoint(codepoint).toLowerCase();
	return [...modifierNames(mods & ~192), base].join("+");
}

const CSI_U = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::(\d+))?u$/;
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

function parseKeyFallback(data: string): string | undefined {
	const csi = CSI_U.exec(data);
	if (csi) {
		if (csi[3] === "3") return undefined; // key release, not a press
		return namedKey(Number(csi[1]), (csi[2] ? Number(csi[2]) : 1) - 1);
	}
	const legacy = MODIFY_OTHER_KEYS.exec(data);
	if (legacy) return namedKey(Number(legacy[2]), Number(legacy[1]) - 1);

	if (data === "\x1b") return "escape";
	if (data === "\r" || data === "\n") return "enter";
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data.length === 2 && data.startsWith("\x1b")) return `alt+${data[1].toLowerCase()}`;
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(96 + code)}`;
		return data;
	}
	return undefined;
}

/** Modifier order is not significant, so compare on a sorted form. */
function canonicalKey(key: string): string {
	const parts = key.toLowerCase().split("+");
	const base = parts.pop() ?? "";
	return [...parts.sort(), base].join("+");
}

/** Exported for the smoke harness; omp only ever loads the default export. */
export function fallbackMatch(data: string, key: string): boolean {
	const parsed = parseKeyFallback(data);
	return parsed !== undefined && canonicalKey(parsed) === canonicalKey(key);
}

interface TUILike {
	requestRender(): void;
}

const viewportHeight = () => Math.max(10, (process.stdout.rows || 40) - 1);

class CrewOverlay implements Component {
	#collapsed = new Set<string>();
	#expanded = new Set<string>();
	/** The cursor is a row KEY, never an index: rows accumulate as agents spawn,
	 *  so an index silently re-targets `f` and `n` at whatever slid underneath it. */
	#cursor: string | undefined;
	#scroll = 0;
	#lastKey = "(none yet)";
	#keyCount = 0;
	#timer: ReturnType<typeof setInterval>;
	#unsubscribe: (() => void) | undefined;

	constructor(
		private tui: TUILike,
		private done: (action: Action | undefined) => void,
	) {
		// Liveness is hybrid because it has to be: onChange covers structure and
		// status, but setActivity deliberately fires nothing, so the only way to
		// watch an agent's current activity — including agents crew never spawned —
		// is to look.
		this.#timer = setInterval(() => this.tui.requestRender(), 250);
		try {
			this.#unsubscribe = registry()?.onChange(() => this.tui.requestRender());
		} catch {
			// A registry that refuses listeners still lists; polling covers us.
		}
	}

	dispose(): void {
		clearInterval(this.#timer);
		this.#unsubscribe?.();
	}

	#state(width: number): TreeState {
		return {
			collapsed: this.#collapsed,
			expanded: this.#expanded,
			repaint: () => this.tui.requestRender(),
			width,
		};
	}

	#selected(rows: Row[]): SelectableRow | undefined {
		const selectable = rows.filter(isSelectable);
		return selectable.find(r => r.key === this.#cursor) ?? selectable[0];
	}

	#move(rows: Row[], delta: number): void {
		const selectable = rows.filter(isSelectable);
		if (selectable.length === 0) return;
		const current = this.#selected(rows);
		const at = current ? selectable.indexOf(current) : 0;
		const next = selectable[Math.min(selectable.length - 1, Math.max(0, at + delta))];
		if (next) this.#cursor = next.key;
		this.tui.requestRender();
	}

	/** Enter collapses a row that has children, and otherwise expands its result. */
	#act(rows: Row[]): void {
		const row = this.#selected(rows);
		if (!row) return;
		if (row.kind === "new-feature") {
			this.done({ type: "dispatch", askFeature: true });
			return;
		}
		if (row.kind === "header") {
			toggle(this.#collapsed, row.key);
			this.tui.requestRender();
			return;
		}
		if (row.kind !== "agent") return;
		const refs = visibleRefs();
		if (childrenOf(row.ref.id, refs).length > 0) {
			toggle(this.#collapsed, row.ref.id);
		} else if (summaryById.get(row.ref.id)) {
			toggle(this.#expanded, row.ref.id);
		}
		this.tui.requestRender();
	}

	#featureAtCursor(rows: Row[]): string | undefined {
		const row = this.#selected(rows);
		if (!row) return undefined;
		if (row.kind === "header") return row.feature === UNGROUPED ? undefined : row.feature;
		if (row.kind === "agent") {
			const feature = featureOf(row.ref, visibleRefs());
			return feature === UNGROUPED ? undefined : feature;
		}
		return undefined;
	}

	handleInput(data: string): void {
		const rows = buildRows(this.#state(process.stdout.columns ?? 100));
		// CREW_DEBUG_KEYS=1 shows the raw bytes of the last key the overlay was
		// handed. A key that is being eaten upstream leaves this line unchanged —
		// which is the whole diagnostic: "nothing happened" and "crew never saw it"
		// look identical from the outside, and this tells them apart.
		if (DEBUG_KEYS) {
			const hex = [...data].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
			this.#lastKey = `${hex}  (${JSON.stringify(data)}) → ${parseKeyFallback(data) ?? "?"}`;
			this.#keyCount++;
			this.tui.requestRender();
		}

		const is = (key: string) => matchKey(data, key);

		if (is("escape") || is("q") || is("ctrl+c")) {
			this.done(undefined);
		} else if (is("up") || is("k")) {
			this.#move(rows, -1);
		} else if (is("down") || is("j")) {
			this.#move(rows, 1);
		} else if (is("enter")) {
			this.#act(rows);
		} else if (is("n")) {
			if (breakage.dispatch) return;
			const row = this.#selected(rows);
			this.done({
				type: "dispatch",
				feature: this.#featureAtCursor(rows),
				askFeature: row?.kind === "new-feature",
			});
		} else if (is("f")) {
			const row = this.#selected(rows);
			// A header is a label for a feature, not a thing that has one.
			if (row?.kind === "agent") this.done({ type: "feature", agentId: row.ref.id });
		} else if (is("o")) {
			const row = this.#selected(rows);
			if (row?.kind === "agent") this.done({ type: "open", agentId: row.ref.id });
		} else if (is("ctrl+s") || is("alt+a") || is("alt+c")) {
			// omp binds its hub on the EDITOR (editor.setCustomKeyHandler), and while
			// this overlay is mounted the editor sees nothing — so ctrl+s inside crew
			// would otherwise be swallowed here and look broken. Crew cannot open the
			// hub itself (R1/D1: showAgentHub is on a private controller), so the
			// honest thing is to get out of the way and say what to press next.
			const row = this.#selected(rows);
			this.done({ type: "handoff", agentId: row?.kind === "agent" ? row.ref.id : undefined });
		}
	}

	render(width: number): readonly string[] {
		const height = viewportHeight();
		if (breakage.registry) return this.#renderTombstone(width, height);

		const rows = buildRows(this.#state(width));
		const selected = this.#selected(rows);
		if (selected) this.#cursor = selected.key;

		const header = [
			`${bold(` crew — ${path.basename(cwd) || cwd}`)}  ${dim(`${rows.filter(r => r.kind === "agent").length} agent(s) live`)}`,
			dim("─".repeat(Math.max(10, width))),
		];
		const footer = this.#footer(selected, width);
		const body = Math.max(3, height - header.length - footer.length);

		// Overflow is scroll-only: a paginated control plane makes you count pages
		// to find out how much is going on.
		const at = selected ? rows.indexOf(selected) : 0;
		if (at < this.#scroll) this.#scroll = at;
		if (at >= this.#scroll + body) this.#scroll = at - body + 1;
		this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, rows.length - body)));

		const view = rows.slice(this.#scroll, this.#scroll + body).map(r => {
			const line = clip(r.text, width);
			if (r.key !== selected?.key) return line;
			return inverse(line + " ".repeat(Math.max(0, width - visLen(line))));
		});
		while (view.length < body) view.push("");

		return [...header, ...view, ...footer].map(l => clip(l, width));
	}

	#footer(selected: SelectableRow | undefined, width: number): string[] {
		const target =
			selected?.kind === "agent"
				? `${dim("attach →")} ${bold(selected.ref.displayName)} ${dim(shortId(selected.ref.id))}`
				: dim("attach → (select an agent)");
		const dispatchKey = breakage.dispatch ? red(`n unavailable (${breakage.dispatch})`) : "n new";
		return [
			dim("─".repeat(Math.max(10, width))),
			target,
			dim(`enter collapse/expand · ${dispatchKey} · f feature · o output · esc close`),
			// Two keystrokes, and the footer says so rather than implying one: the
			// first leaves crew, the second reaches omp's hub for attach/kill/message.
			dim("ctrl+s / alt+a: leave crew, then press it again for omp's hub"),
			...(DEBUG_KEYS ? [yellow(`debug: key #${this.#keyCount} = ${this.#lastKey}`)] : []),
		];
	}

	/** The tree cannot exist without the registry, but crew still can: an overlay
	 *  that names the broken symbol beats a keybinding that does nothing. */
	#renderTombstone(width: number, height: number): string[] {
		const lines = [
			bold(" crew is not available on this omp"),
			"",
			`  ${red("Missing:")} ${breakage.registry}`,
			`  ${dim(`omp ${barrel.VERSION ?? "unknown"} · this extension was verified against ${VERIFIED_AGAINST}`)}`,
			"",
			`  ${dim("crew reads omp's agent registry directly; without it there is no tree.")}`,
			`  ${dim("omp's own agent hub (ctrl+s) is unaffected.")}`,
			"",
			`  ${dim("esc close")}`,
		];
		while (lines.length < height) lines.push("");
		return lines.map(l => clip(l, width));
	}
}

function toggle(set: Set<string>, key: string): void {
	if (set.has(key)) set.delete(key);
	else set.add(key);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** discoverAgents returns an object keyed by name, not an array — and Claude
 *  plugin agents land in the same result, so the picker is long by nature. */
function normalizeAgents(raw: unknown): AgentDef[] {
	if (!raw) return [];
	const values = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>);
	return values
		.flatMap(v => (Array.isArray(v) ? v : [v]))
		.filter((v): v is AgentDef => !!v && typeof v === "object" && typeof (v as AgentDef).name === "string")
		.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadAgentDefs(): Promise<AgentDef[]> {
	try {
		return normalizeAgents(await barrel.discoverAgents?.(cwd));
	} catch {
		return [];
	}
}

/** Bit-exact with what omp's own task tool passes, including for nested
 *  sessions — getArtifactsDir() diverges once an ArtifactManager is adopted. */
function artifactsDir(ctx: ExtensionCommandContext): string | undefined {
	const sm = (ctx as unknown as { sessionManager?: { getSessionFile?(): string | null } }).sessionManager;
	return sm?.getSessionFile?.()?.slice(0, -6) ?? undefined;
}

async function dispatchFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext, action: Extract<Action, { type: "dispatch" }>): Promise<void> {
	if (breakage.dispatch) {
		ctx.ui.notify(`crew: dispatch is unavailable — omp no longer exports ${breakage.dispatch}`, "error");
		return;
	}

	// Feature: inherited from wherever the cursor was. The only prompt is the one
	// you asked for by standing on "＋ new feature…".
	let feature = action.feature;
	if (action.askFeature) {
		const typed = await ctx.ui.input("crew: feature", "checkout flow / search revamp / … (empty = none)");
		if (typed === undefined) return;
		feature = typed.trim() || undefined;
	}

	const defs = await loadAgentDefs();
	if (defs.length === 0) {
		ctx.ui.notify(
			"crew: no agent definitions found — put one in <agent-dir>/agents or .omp/agents and try again",
			"error",
		);
		return;
	}

	const picked = await ctx.ui.select(
		"crew: agent",
		defs.map(d => ({ label: d.name, description: d.description })),
	);
	if (picked === undefined) return;
	const def = defs.find(d => d.name === picked);
	if (!def) return;

	const task = (await ctx.ui.editor(`crew: task for "${def.name}"`))?.trim();
	if (!task) return;

	const id = `crew-${def.name}-${Date.now().toString(36)}`;
	if (feature) {
		featureById.set(id, feature);
		void rememberFeature(feature);
	}

	const dir = artifactsDir(ctx);
	const run = barrel.runSubprocess?.({
		cwd,
		// Resolved by name from omp's own discovery — the definition owns the
		// model, the tools, and the prompt; crew adds nothing to it.
		agent: def,
		task,
		id,
		index: nextIndex++,
		artifactsDir: dir,
		eventBus: (pi as unknown as { events?: unknown }).events,
		parentToolCallId: id,
		modelRegistry: (ctx as unknown as { modelRegistry?: unknown }).modelRegistry,
		settings: barrel.settings,
	});

	// Fire-and-forget still has to answer for itself: an unhandled rejection here
	// would be an agent that never appears and never explains why.
	run?.catch((err: unknown) => {
		featureById.delete(id);
		ctx.ui.notify(`crew: ${def.name} failed to start — ${message(err)}`, "error");
	});

	ctx.ui.notify(`crew: ${def.name} dispatched${feature ? ` on ${feature}` : ""}`, "info");
}

async function featureFlow(ctx: ExtensionCommandContext, agentId: string): Promise<void> {
	const refs = visibleRefs();
	const ref = refs.find(r => r.id === agentId);
	if (!ref) return;
	const root = rootAncestor(ref, refs);

	const known = await readFeatures();
	const picked = await ctx.ui.select(`crew: feature for "${root.displayName}"`, [
		...known.map(f => ({ label: f })),
		{ label: NEW_FEATURE, description: "name a new one" },
		{ label: CLEAR_FEATURE, description: "remove this agent's feature" },
	]);
	if (picked === undefined) return;

	if (picked === CLEAR_FEATURE) {
		featureById.delete(root.id);
		return;
	}
	let feature = picked;
	if (picked === NEW_FEATURE) {
		const typed = await ctx.ui.input("crew: feature", "checkout flow / search revamp / …");
		if (!typed?.trim()) return;
		feature = typed.trim();
	}
	featureById.set(root.id, feature);
	void rememberFeature(feature);
}

/** Opens the yield payload — the .md, not the raw .jsonl transcript, which is
 *  ctrl+s's job. Detached, so it costs omp nothing. */
function openOutput(ctx: ExtensionCommandContext, agentId: string): void {
	const ref = registry()?.get(agentId);
	const outputPath = ref?.history?.outputPath;
	if (!outputPath) {
		ctx.ui.notify("crew: this agent has not written an output file", "warning");
		return;
	}
	try {
		const opener = process.platform === "darwin" ? "open" : "xdg-open";
		Bun.spawn([opener, outputPath], { stdio: ["ignore", "ignore", "ignore"] }).unref();
	} catch (err) {
		ctx.ui.notify(`crew: could not open ${outputPath} — ${message(err)}`, "error");
	}
}

// ── View loop ────────────────────────────────────────────────────────────────

async function showCrew(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	cwd = ctx.cwd;
	if (!ctx.hasUI) return;
	// Before the overlay mounts: handleInput is synchronous and cannot await.
	await loadKeyMatcher();

	while (true) {
		const action = await ctx.ui.custom<Action | undefined>(
			(tui, _theme, _keybindings, done) => new CrewOverlay(tui as TUILike, done),
			{ overlay: true },
		);
		if (!action) return;

		switch (action.type) {
			case "dispatch":
				await dispatchFlow(pi, ctx, action);
				break;
			case "feature":
				await featureFlow(ctx, action.agentId);
				break;
			case "open":
				openOutput(ctx, action.agentId);
				break;
			case "handoff": {
				const ref = action.agentId ? registry()?.get(action.agentId) : undefined;
				ctx.ui.notify(
					ref
						? `crew: closed — press ctrl+s (or alt+a) again for omp's hub, then pick ${ref.displayName}`
						: "crew: closed — press ctrl+s (or alt+a) again for omp's hub",
					"info",
				);
				return;
			}
		}
	}
}

/**
 * Report breakage once, on session_start — the first moment a user-visible
 * channel exists at all. During the extension factory `api.runtime` is a
 * throwing stub, so a notify there goes nowhere.
 */
function notifyBreakage(ctx: { ui?: { notify(text: string, level: string): void } }): void {
	if (notifiedBreakage) return;
	notifiedBreakage = true;
	if (breakage.registry) {
		ctx.ui?.notify(
			`crew: omp ${barrel.VERSION ?? "?"} no longer provides ${breakage.registry} — the agent tree is unavailable (alt+c explains). omp's own ctrl+s hub still works.`,
			"error",
		);
	} else if (breakage.dispatch) {
		ctx.ui?.notify(
			`crew: omp ${barrel.VERSION ?? "?"} no longer provides ${breakage.dispatch} — the tree works, but crew cannot dispatch agents.`,
			"error",
		);
	} else if (breakage.version) {
		ctx.ui?.notify(
			`crew: ${breakage.version} — a major omp bump can move contracts crew depends on without removing them. Open alt+c and dispatch once to check.`,
			"warning",
		);
	}
}

// ── Registration ─────────────────────────────────────────────────────────────

export default function ompCrew(pi: ExtensionAPI): void {
	pi.setLabel("Crew");
	resolveOmp(pi);

	// alt+c, because every obvious ctrl+ binding is already readline's:
	// ctrl+a start-of-line, ctrl+e end-of-line, ctrl+w delete-word.
	pi.registerShortcut("alt+c", {
		description: "crew: agent control plane",
		handler: ctx => showCrew(pi, ctx as ExtensionCommandContext),
	});

	pi.registerCommand("crew", {
		description: "Crew: live tree of running agents, and dispatch",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await showCrew(pi, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		notifyBreakage(ctx as { ui?: { notify(text: string, level: string): void } });
	});
}
