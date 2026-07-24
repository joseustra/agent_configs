/**
 * omp crew — a per-project roster of named agents you spawn, watch, and enter.
 *
 * This is the CANONICAL source. Ship it to:
 *   - Host: ~/.omp/agent/extensions/omp-crew.ts  (symlink/copy of this file)
 * omp auto-discovers any *.ts/*.js under that `extensions/` dir at startup.
 *
 * What it does:
 *   /crew new  (or `n` inside the view)  — spawn a named agent (research,
 *     implementation, review, …) that runs IN-PROCESS via `runSubprocess`, the
 *     same infrastructure omp's Task tool and the first-party swarm extension
 *     use. The extension owns the roster: names, statuses, kill, rename.
 *   ctrl+a  (or /crew)  — overlay listing all crew agents with live status.
 *     ↑/↓/j/k select · Enter/→ talk to agent · n new · ^R rename · ^X kill ·
 *     Esc close.
 *     Enter ATTACHES to the agent: omp's own AgentTranscriptViewer renders its
 *     live transcript with an editor underneath, so you just type and it goes to
 *     that agent (steered mid-turn, a fresh prompt when idle). Esc or ctrl+a
 *     comes back to the roster. Agents from a previous omp run have no live
 *     session and fall back to a read-only pane (`o` opens the transcript).
 *
 * State:
 *   <cwd>/.crew/crew.json           — roster metadata (survives omp restarts;
 *                                     agents running at crash time show as "stale")
 *   <cwd>/.crew/sessions/<id>.jsonl — each agent's full session transcript
 *
 * Version note: verified against oh-my-pi v16.1.19 source. `runSubprocess` is a
 * package export (not the sanctioned ExtensionAPI), and the shortcut handler's
 * command-context cast relies on interactive mode passing createCommandContext()
 * (modes/controllers/input-controller.ts). Re-check both on major omp upgrades.
 * Design/plan: omp/docs/crew-extension-plan.md in the agent_configs repo.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentDefinition,
	AgentProgress,
	AgentSource,
	ExtensionAPI,
	ExtensionCommandContext,
	ModelRegistry,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent";
// AgentRegistry itself has no bundled export in the compiled binary (only root +
// declared subpath exports resolve from extensions; ./registry/* is not one).
// This ./modes/* helper returns AgentRegistry.global() when passed undefined.
import { getRunningSubagentBadgeRegistry } from "@oh-my-pi/pi-coding-agent/modes/running-subagent-badge";

const agentRegistry = () => getRunningSubagentBadgeRegistry(undefined);

// Registry entry type, inferred from the badge helper because ./registry/* is
// not a declared subpath export in the compiled binary.
type RegistryRef = ReturnType<ReturnType<typeof agentRegistry>["list"]>[number];

/**
 * Task-tool subagents spawned by a crew worker (spawns: "*"), depth-first with
 * indentation depth. These live in omp's global registry with parentId set to
 * the spawning agent, so the crew view can mirror them under their parent.
 */
function childTree(parentId: string, refs: RegistryRef[], depth = 1): { ref: RegistryRef; depth: number }[] {
	return refs
		.filter(r => r.parentId === parentId)
		.sort((a, b) => a.createdAt - b.createdAt)
		.flatMap(r => [{ ref: r, depth }, ...childTree(r.id, refs, depth + 1)]);
}
import {
	CombinedAutocompleteProvider,
	type Component,
	Editor,
	matchesKey,
	replaceTabs,
	truncateToWidth,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";

type UIRef = ExtensionCommandContext["ui"];

type CrewStatus = "running" | "done" | "failed" | "aborted" | "stale";

interface CrewAgent {
	id: string;
	name: string;
	/** The feature / workstream this agent belongs to; the roster's top level. */
	group?: string;
	task: string;
	role?: string;
	model?: string;
	status: CrewStatus;
	startedAt: number;
	endedAt?: number;
	error?: string;
	sessionFile: string;
	// live-only (not persisted)
	abort?: AbortController;
	progress?: AgentProgress;
	result?: SingleResult;
	// Needed to revive the worker for follow-up turns; gone after an omp restart,
	// which is what makes "stale" agents read-only.
	agentDef?: AgentDefinition;
}

// ── Module state ─────────────────────────────────────────────────────────────

const roster = new Map<string, CrewAgent>();
let cwd = "";
let ui: UIRef | undefined;
let modelRegistry: ModelRegistry | undefined;
let loaded = false;
let nextIndex = 1;
// Set while the overlay is mounted so onProgress ticks can repaint it.
let overlayRefresh: (() => void) | null = null;
// "Where am I?" tracking. `switchSession` loads a worker's transcript into the
// MAIN session, so without this there is nothing on screen saying the prompt is
// no longer your own session.
let enteredLabel: string | undefined;
let mainSessionFile: string | undefined;
let pendingSwitchTarget: string | undefined;

const crewDir = () => path.join(cwd, ".crew");
const sessionsDir = () => path.join(crewDir(), "sessions");
const stateFile = () => path.join(crewDir(), "crew.json");

function slug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function loadState(): Promise<void> {
	if (loaded) return;
	loaded = true;
	try {
		const raw = JSON.parse(await Bun.file(stateFile()).text()) as { agents?: CrewAgent[] };
		for (const a of raw.agents ?? []) {
			// In-process agents don't survive an omp restart.
			if (a.status === "running") a.status = "stale";
			roster.set(a.id, a);
		}
	} catch {
		// no state yet — fine
	}
}

async function saveState(): Promise<void> {
	await fs.mkdir(crewDir(), { recursive: true });
	// Self-ignoring dir: session transcripts are per-machine state, never for git.
	const gitignore = path.join(crewDir(), ".gitignore");
	try {
		await fs.access(gitignore);
	} catch {
		await Bun.write(gitignore, "*\n");
	}
	const agents = [...roster.values()].map(({ abort: _a, progress: _p, result: _r, ...meta }) => meta);
	await Bun.write(stateFile(), JSON.stringify({ version: 1, agents }, null, 2));
}

// ── Presentation helpers ─────────────────────────────────────────────────────

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
};

function statusIcon(a: CrewAgent): string {
	switch (effectiveStatus(a)) {
		case "running":
			return `${ANSI.yellow}◐${ANSI.reset}`;
		case "done":
			return `${ANSI.green}●${ANSI.reset}`;
		case "failed":
			return `${ANSI.red}✖${ANSI.reset}`;
		default:
			return `${ANSI.dim}○${ANSI.reset}`;
	}
}

function agentAge(a: CrewAgent): string {
	return formatDuration((a.endedAt ?? Date.now()) - a.startedAt);
}

function agentSummary(a: CrewAgent): string {
	const status = effectiveStatus(a);
	if (status === "running") {
		const p = a.progress;
		const doing = p?.currentTool
			? `▸ ${p.currentTool}${p.currentToolArgs ? ` ${p.currentToolArgs}` : ""}`
			: (p?.lastIntent ?? "starting…");
		return `running ${agentAge(a)}  ${ANSI.dim}${doing}${ANSI.reset}`;
	}
	const stats =
		a.progress || a.result
			? `  ${ANSI.dim}${Math.round((a.result?.tokens ?? a.progress?.tokens ?? 0) / 1000)}k tok · $${(a.result?.usage?.cost?.total ?? a.progress?.cost ?? 0).toFixed(2)}${ANSI.reset}`
			: "";
	const err = a.error ? `  ${ANSI.red}${a.error}${ANSI.reset}` : "";
	return `${status} ${agentAge(a)}${stats}${err}`;
}

// omp mounts extension overlays with `width: "100%", maxHeight: "100%"` anchored
// bottom-center (extension-ui-controller.showHookCustom), so the view is as tall
// as the lines we return — pad to the terminal height to claim the whole screen.
function viewportHeight(): number {
	return Math.max(10, (process.stdout.rows || 40) - 1);
}

/** Top-align content inside a full-height block (bottom-anchored overlay). */
function fitToHeight(lines: string[], height: number): string[] {
	if (lines.length > height) return lines.slice(0, height);
	return [...lines, ...Array(height - lines.length).fill("")];
}

/** Name of the crew agent whose transcript lives at `sessionPath`, if any. */
function crewLabelForSession(sessionPath: string): string | undefined {
	const resolved = path.resolve(sessionPath);
	for (const a of roster.values()) {
		if (path.resolve(a.sessionFile) === resolved) return a.name;
	}
	for (const ref of agentRegistry().list()) {
		if (ref.sessionFile && path.resolve(ref.sessionFile) === resolved) return ref.displayName;
	}
	// Nested spawns write into the crew's artifacts dir too — name them by file.
	if (cwd && path.dirname(resolved) === path.resolve(sessionsDir())) return path.basename(resolved, ".jsonl");
	return undefined;
}

function updateWidget(): void {
	if (!ui) return;
	const lines: string[] = [];
	if (roster.size > 0) {
		const working = [...roster.values()].filter(a => effectiveStatus(a) === "running").length;
		const parts = [...roster.values()].map(a => `${statusIcon(a)} ${a.name}`);
		const tally = working > 0 ? `${working} working` : "all idle";
		lines.push(` crew  ${parts.join("  ")}   ${ANSI.dim}${tally} · ctrl+a: view${ANSI.reset}`);
	}
	if (enteredLabel) {
		lines.push(
			` ${ANSI.cyan}▸ you are in ${ANSI.bold}${enteredLabel}${ANSI.reset}${ANSI.cyan}'s transcript${ANSI.reset}` +
				`  ${ANSI.dim}replies come from your main agent with its history · /crew back to leave${ANSI.reset}`,
		);
	}
	ui.setWidget("crew", lines.length > 0 ? lines : undefined);
}

// ── Role presets ─────────────────────────────────────────────────────────────
// Reusable role definitions at <agent-dir>/crew-roles/*.md (profile-aware via
// getAgentDir; canonical copies live in agent_configs/omp/agent/crew-roles).
// Frontmatter keys: description (shown in the picker), model (spawn override).
// Body: the agent's system prompt.

interface CrewRole {
	name: string;
	description?: string;
	model?: string;
	systemPrompt: string;
}

function parseRole(name: string, raw: string): CrewRole {
	const role: CrewRole = { name, systemPrompt: raw.trim() };
	const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (fm) {
		role.systemPrompt = raw.slice(fm[0].length).trim();
		for (const line of fm[1].split(/\r?\n/)) {
			const kv = line.match(/^(\w+):\s*(.*)$/);
			if (kv?.[1] === "description") role.description = kv[2].trim();
			if (kv?.[1] === "model") role.model = kv[2].trim() || undefined;
		}
	}
	return role;
}

async function loadRoles(): Promise<CrewRole[]> {
	const dir = path.join(getAgentDir(), "crew-roles");
	let files: string[];
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith(".md")).sort();
	} catch {
		return [];
	}
	const roles: CrewRole[] = [];
	for (const f of files) {
		try {
			roles.push(parseRole(f.slice(0, -3), await Bun.file(path.join(dir, f)).text()));
		} catch {
			// unreadable role file — skip
		}
	}
	return roles.filter(r => r.systemPrompt.length > 0);
}

/** "review" → "review-2" when a review is already on the roster. */
function uniqueName(base: string): string {
	const taken = new Set([...roster.values()].map(a => a.name));
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
	}
}

// ── Spawning ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(name: string): string {
	return [
		`You are "${name}", one agent in a small crew working in this repository.`,
		"Work autonomously to complete your task end-to-end. When you finish, write a",
		"short summary of what you did and where the results are (files, branches, docs).",
	].join("\n");
}

interface SpawnRequest {
	name: string;
	task: string;
	group?: string;
	model?: string;
	role?: CrewRole;
}

function spawnAgent(pi: ExtensionAPI, req: SpawnRequest): CrewAgent {
	const { name, task, group, model, role } = req;
	const id = `crew-${slug(name)}-${Date.now().toString(36)}`;
	const abort = new AbortController();
	const agent: CrewAgent = {
		id,
		name,
		group,
		task,
		role: role?.name,
		model,
		status: "running",
		startedAt: Date.now(),
		sessionFile: path.join(sessionsDir(), `${id}.jsonl`),
		abort,
	};
	roster.set(id, agent);
	void saveState();
	updateWidget();

	const agentDef: AgentDefinition = {
		// Doubles as the row label in omp's own Agent Hub (ctrl+s → Enter is the
		// full attach), so carry the feature into it: "checkout-flow-research".
		name: group ? `${slug(group)}-${slug(name)}` : slug(name),
		description: role?.description ?? `crew agent: ${name}`,
		systemPrompt: role?.systemPrompt ?? buildSystemPrompt(name),
		source: "project" as AgentSource,
		// Without this, workers get "spawns disabled" and can't use the task tool.
		// "*" lets an orchestrator-style crew agent fan out its own subagents;
		// they appear in the crew view nested under their parent.
		spawns: "*",
	};

	agent.agentDef = agentDef;

	trackRun(
		agent,
		fs.mkdir(sessionsDir(), { recursive: true }).then(() =>
			runSubprocess({
				cwd,
				agent: agentDef,
				task,
				index: nextIndex++,
				id,
				modelOverride: model,
				signal: abort.signal,
				onProgress: progressHandler(agent),
				modelRegistry,
				settings: pi.pi.settings,
				// A crew agent should be as capable as a fresh omp session: LSP,
				// MCP and IRC all default on in ExecutorOptions, so don't opt out.
				artifactsDir: sessionsDir(),
			}),
		),
	);

	return agent;
}

function progressHandler(agent: CrewAgent): (p: AgentProgress) => void {
	return p => {
		agent.progress = p;
		updateWidget();
		overlayRefresh?.();
	};
}

/** Shared end-of-turn bookkeeping for the initial run and follow-up turns. */
function trackRun(agent: CrewAgent, run: Promise<SingleResult>): void {
	run
		.then(result => {
			agent.result = result;
			agent.error = result.error;
			agent.status = result.aborted ? "aborted" : result.exitCode === 0 ? "done" : "failed";
		})
		.catch(err => {
			agent.status = agent.abort?.signal.aborted ? "aborted" : "failed";
			agent.error = err instanceof Error ? err.message : String(err);
		})
		.finally(() => {
			agent.endedAt = Date.now();
			void saveState();
			updateWidget();
			overlayRefresh?.();
			ui?.notify(
				`crew: ${agent.name} ${agent.status}${agent.error ? ` — ${agent.error}` : ""}`,
				agent.status === "done" ? "info" : agent.status === "aborted" ? "warning" : "error",
			);
		});
}

// ── Messaging ────────────────────────────────────────────────────────────────
// Workers keep their AgentSession alive after finishing (runSubprocess keepAlive
// defaults to true), so "done" really means idle-and-revivable:
//   running → queue the text on the live session (consumed after current work)
//   idle    → runSubagentFollowUpTurn revives it and runs a turn with the text
//   stale   → previous omp run; the in-memory session is gone → read-only

function messageAgent(agent: CrewAgent, text: string): string {
	if (agent.status === "stale" || !agent.agentDef) {
		return `crew: ${agent.name} is from a previous omp run — open its transcript instead (o)`;
	}
	if (agent.status === "running") {
		const session = agentRegistry().get(agent.id)?.session;
		if (!session) return `crew: ${agent.name} is not addressable yet — try again in a moment`;
		void session.prompt(text, { streamingBehavior: "followUp" });
		return `crew: message queued for ${agent.name} (picked up after its current work)`;
	}
	if (!agentRegistry().get(agent.id)) {
		return `crew: ${agent.name}'s session is no longer alive — open its transcript instead (o)`;
	}
	agent.status = "running";
	agent.endedAt = undefined;
	agent.error = undefined;
	void saveState();
	updateWidget();
	// Fresh controller per revival so a previous kill doesn't poison this turn.
	agent.abort = new AbortController();
	trackRun(
		agent,
		runSubagentFollowUpTurn({
			id: agent.id,
			agent: agent.agentDef,
			message: text,
			signal: agent.abort.signal,
			onProgress: progressHandler(agent),
		}),
	);
	return `crew: ${agent.name} woken with your message`;
}

// ── Attached chat ────────────────────────────────────────────────────────────
// Enter on a live agent mounts omp's OWN AgentTranscriptViewer — the component
// the built-in Agent Hub uses for its in-hub chat. It renders the agent's live
// transcript and carries its own editor: Enter sends straight to that agent's
// session (`prompt(..., { streamingBehavior: "steer" })` — steers a mid-turn
// agent, prompts an idle one). So you just talk to the agent, no m/o detour.
//
// It lives at a declared `./modes/components/*` subpath, but it is NOT part of
// the sanctioned ExtensionAPI, so the import is dynamic and failure degrades to
// the hand-rolled read-only pane rather than breaking the extension.

type TranscriptViewer = Component & { dispose?(): void };
type ViewerCtor = new (deps: Record<string, unknown>) => TranscriptViewer;

let viewerCtor: ViewerCtor | null | undefined;

async function loadViewerCtor(): Promise<ViewerCtor | null> {
	if (viewerCtor !== undefined) return viewerCtor;
	try {
		const mod = await import("@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer");
		viewerCtor = (mod as { AgentTranscriptViewer?: ViewerCtor }).AgentTranscriptViewer ?? null;
	} catch {
		viewerCtor = null;
	}
	return viewerCtor;
}

/**
 * The viewer sends through an AgentLifecycleManager, which lives at `./registry/*`
 * — not a declared subpath, so extensions can't import it. This shim covers what
 * sending needs: crew workers stay registered after finishing (runSubprocess
 * `keepAlive`), so the registry has a live session for running AND idle agents.
 */
const lifecycleShim = () => ({
	ensureLive: async (id: string) => {
		const session = agentRegistry().get(id)?.session;
		if (!session) throw new Error("this agent's session is gone — open its transcript instead");
		return session;
	},
});

/**
 * The viewer builds its editor with `new Editor(...)` + `setMaxHeight(4)` and no
 * autocomplete, so typing there lacks the @file/path completion the main prompt
 * has. Rather than hand-roll one, hand that editor omp's own provider — the same
 * `CombinedAutocompleteProvider` class the main prompt's provider is built on.
 *
 * The editor is a `#private` field of the viewer, so the only seam is the
 * `setMaxHeight` call in its constructor: patch the prototype for exactly that
 * window, and `this` is the freshly built editor. Restored in a `finally`.
 */
function withEditorAutocomplete<T>(build: () => T): T {
	const original = Editor.prototype.setMaxHeight;
	if (typeof original !== "function") return build();
	const provider = new CombinedAutocompleteProvider([], cwd);
	Editor.prototype.setMaxHeight = function (this: Editor, ...args: Parameters<typeof original>) {
		const result = original.apply(this, args);
		this.setAutocompleteProvider?.(provider);
		return result;
	};
	try {
		return build();
	} finally {
		Editor.prototype.setMaxHeight = original;
	}
}

/** Registry truth beats our bookkeeping: turns started from the attached chat
 *  bypass trackRun, so an agent we recorded as "done" can be mid-turn again. */
function effectiveStatus(a: CrewAgent): CrewStatus {
	return agentRegistry().get(a.id)?.status === "running" ? "running" : a.status;
}

// ── Overlay view ─────────────────────────────────────────────────────────────

type OverlayAction =
	| { type: "open"; id: string }
	| { type: "message"; id: string }
	| { type: "rename"; id: string }
	| { type: "kill"; id: string }
	| { type: "message-child"; id: string }
	| { type: "new" };

type OverlayRow =
	| { kind: "group"; name: string; agents: CrewAgent[] }
	| { kind: "crew"; agent: CrewAgent }
	| { kind: "child"; ref: RegistryRef; depth: number };

const UNGROUPED = "(no feature)";

/** Per-feature tally for the group header: "2 working · 1 done". */
function groupSummary(agents: CrewAgent[]): string {
	const counts = new Map<string, number>();
	for (const a of agents) {
		const label = effectiveStatus(a) === "running" ? "working" : effectiveStatus(a);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts].map(([label, n]) => `${n} ${label}`).join(" · ");
}

class CrewOverlay implements Component {
	#selected = 0;
	#detailId: string | null = null;
	// Live chat with the selected agent (omp's AgentTranscriptViewer), when the
	// agent still has a session in the registry.
	#chat: TranscriptViewer | null = null;
	// Child agents report through their parent's onProgress only while the parent
	// is inside the task call; a coarse tick keeps their rows and ages live.
	#timer: ReturnType<typeof setInterval>;

	constructor(
		private tui: TUI,
		private done: (action: OverlayAction | undefined) => void,
	) {
		overlayRefresh = () => this.tui.requestRender();
		this.#timer = setInterval(() => this.tui.requestRender(), 1000);
	}

	dispose(): void {
		clearInterval(this.#timer);
		this.#detach();
		overlayRefresh = null;
	}

	/** Enter: talk to the agent directly. Falls back to the read-only pane for
	 *  agents with no live session (previous omp run) or if the viewer is gone. */
	#attach(id: string): void {
		if (!agentRegistry().get(id)) {
			this.#detailId = id;
			this.tui.requestRender();
			return;
		}
		void (async () => {
			const Ctor = await loadViewerCtor();
			if (!Ctor) {
				this.#detailId = id;
				this.tui.requestRender();
				return;
			}
			this.#chat = withEditorAutocomplete(
				() =>
					new Ctor({
						agentId: id,
						registry: agentRegistry(),
						ui: this.tui,
						cwd,
						lifecycle: lifecycleShim,
						expandKeys: ["ctrl+o"],
						// The viewer treats these as "close the hub" — here that means
						// back to the roster, so ctrl+a in a chat matches ctrl+a outside.
						hubKeys: ["ctrl+a"],
						requestRender: () => this.tui.requestRender(),
						onClose: () => this.#detach(),
						onHubClose: () => this.#detach(),
					}),
			);
			this.tui.requestRender();
		})();
	}

	#detach(): void {
		this.#chat?.dispose?.();
		this.#chat = null;
		this.tui.requestRender();
	}

	/** Feature → its agents → their nested spawns, flattened for the cursor. */
	#rows(): OverlayRow[] {
		const refs = agentRegistry().list();
		const groups = new Map<string, CrewAgent[]>();
		for (const a of [...roster.values()].sort((x, y) => y.startedAt - x.startedAt)) {
			const key = a.group || UNGROUPED;
			groups.set(key, [...(groups.get(key) ?? []), a]);
		}
		return [...groups].flatMap(([name, agents]) => [
			{ kind: "group", name, agents } as OverlayRow,
			...agents.flatMap(a => [
				{ kind: "crew", agent: a } as OverlayRow,
				...childTree(a.id, refs).map(c => ({ kind: "child", ...c }) as OverlayRow),
			]),
		]);
	}

	/** Group headers are labels, not destinations — the cursor steps over them. */
	#move(rows: OverlayRow[], delta: number): void {
		let next = this.#selected + delta;
		while (rows[next]?.kind === "group") next += delta;
		if (rows[next]) this.#selected = next;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const rows = this.#rows();
		const current = rows[this.#selected];

		// The chat owns every key while attached (its editor is typing).
		if (this.#chat) {
			this.#chat.handleInput?.(data);
			return;
		}

		if (this.#detailId) {
			// Detail pane: m message the agent, o open the raw transcript, Esc/← back.
			if (matchesKey(data, "escape") || matchesKey(data, "left")) {
				this.#detailId = null;
				this.tui.requestRender();
			} else if (data === "m") {
				this.done({ type: "message", id: this.#detailId });
			} else if (data === "o") {
				this.done({ type: "open", id: this.#detailId });
			}
			return;
		}

		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
		} else if (matchesKey(data, "up") || data === "k") {
			this.#move(rows, -1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.#move(rows, 1);
		} else if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "right")) {
			if (!current || current.kind === "group") return;
			this.#attach(current.kind === "child" ? current.ref.id : current.agent.id);
		} else if (data === "m") {
			if (!current || current.kind === "group") return;
			this.done(
				current.kind === "child"
					? { type: "message-child", id: current.ref.id }
					: { type: "message", id: current.agent.id },
			);
		} else if (data === "n") {
			this.done({ type: "new" });
		} else if (matchesKey(data, "ctrl+r")) {
			if (current?.kind === "crew") this.done({ type: "rename", id: current.agent.id });
		} else if (matchesKey(data, "ctrl+x")) {
			if (current?.kind === "crew") this.done({ type: "kill", id: current.agent.id });
		}
	}

	render(width: number): readonly string[] {
		// The viewer sizes itself against process.stdout.rows already.
		if (this.#chat) return this.#chat.render(width);
		const height = viewportHeight();
		const lines = this.#detailId ? this.#renderDetail(this.#detailId, height) : this.#renderList(height);
		return fitToHeight(lines, height).map(l => truncateToWidth(replaceTabs(l), width));
	}

	#renderList(height: number): string[] {
		const rows = this.#rows();
		if (this.#selected >= rows.length) this.#selected = Math.max(0, rows.length - 1);
		// Never rest on a feature header (first paint, or after a kill).
		while (rows[this.#selected]?.kind === "group" && this.#selected < rows.length - 1) this.#selected++;
		const crewCount = rows.filter(r => r.kind === "crew").length;
		const featureCount = rows.filter(r => r.kind === "group").length;
		const lines: string[] = [];
		lines.push(
			`${ANSI.bold} crew — ${path.basename(cwd)}${ANSI.reset}  ${ANSI.dim}${featureCount} feature(s) · ${crewCount} agent(s)${ANSI.reset}`,
		);
		lines.push("");
		if (rows.length === 0) {
			lines.push(`   ${ANSI.dim}no agents yet — press n to create one${ANSI.reset}`);
		}
		// Chrome: title + blank + 2 hints + overflow markers, plus the blank line
		// each feature header adds — hence the slack over a 1 row : 1 line count.
		const budget = Math.max(3, height - 8);
		let start = 0;
		if (rows.length > budget) {
			start = Math.min(Math.max(0, this.#selected - Math.floor(budget / 2)), rows.length - budget);
		}
		const end = Math.min(rows.length, start + budget);
		if (start > 0) lines.push(`   ${ANSI.dim}… ${start} more above${ANSI.reset}`);
		const nameWidth = Math.max(8, ...rows.map(r => (r.kind === "crew" ? r.agent.name.length : 0)));
		rows.slice(start, end).forEach((r, offset) => {
			const i = start + offset;
			const cursor = i === this.#selected ? `${ANSI.cyan}▸${ANSI.reset}` : " ";
			if (r.kind === "group") {
				if (i > start) lines.push("");
				lines.push(` ${ANSI.bold}▍ ${r.name}${ANSI.reset}  ${ANSI.dim}${groupSummary(r.agents)}${ANSI.reset}`);
			} else if (r.kind === "crew") {
				const here = r.agent.name === enteredLabel ? `  ${ANSI.cyan}◂ your prompt is here${ANSI.reset}` : "";
				lines.push(
					` ${cursor}  ${statusIcon(r.agent)} ${r.agent.name.padEnd(nameWidth)}  ${agentSummary(r.agent)}${here}`,
				);
			} else {
				const icon =
					r.ref.status === "running"
						? `${ANSI.yellow}◐${ANSI.reset}`
						: r.ref.status === "idle"
							? `${ANSI.green}●${ANSI.reset}`
							: `${ANSI.dim}○${ANSI.reset}`;
				const doing = r.ref.activity ? ` · ${r.ref.activity}` : "";
				lines.push(
					` ${cursor}  ${"  ".repeat(r.depth)}└ ${icon} ${r.ref.displayName}  ${ANSI.dim}${r.ref.status}${doing}${ANSI.reset}`,
				);
			}
		});
		if (end < rows.length) lines.push(`   ${ANSI.dim}… ${rows.length - end} more below${ANSI.reset}`);
		// Hints pinned to the bottom of the full-height block.
		const hints = [
			` ${ANSI.dim}↑↓/jk select · Enter/→ chat · n new · ^R rename · ^X kill · Esc close${ANSI.reset}`,
			` ${ANSI.dim}ctrl+s → omp's agent hub attaches your real prompt to an agent (full session)${ANSI.reset}`,
		];
		return [...fitToHeight(lines, height - hints.length), ...hints];
	}

	/** Read-only fallback: no live session to attach to (previous omp run), or
	 *  omp's transcript viewer wasn't importable on this version. */
	#renderDetail(id: string, height: number): string[] {
		const a = roster.get(id);
		if (!a) return [" agent gone"];
		const p = a.progress;
		const lines: string[] = [];
		lines.push(`${ANSI.bold} ${statusIcon(a)} ${a.name}${ANSI.reset}  ${ANSI.dim}${a.role ? `${a.role} · ` : ""}${a.status} · ${agentAge(a)}${p?.resolvedModel ? ` · ${p.resolvedModel}` : ""}  (no live session)${ANSI.reset}`);
		if (p) {
			lines.push(
				` ${ANSI.dim}${Math.round(p.tokens / 1000)}k tok · $${p.cost.toFixed(2)} · ${p.toolCount} tool calls${ANSI.reset}`,
			);
			if (p.lastIntent) lines.push(` intent: ${p.lastIntent}`);
			if (p.currentTool) lines.push(` ▸ ${p.currentTool} ${p.currentToolArgs ?? ""}`);
		}
		lines.push(` ${ANSI.dim}task: ${a.task.split("\n")[0]}${ANSI.reset}`);
		lines.push("");
		// Output tail fills whatever the header left over (blank + hints reserved).
		const room = Math.max(1, height - lines.length - 2);
		const tail = p?.recentOutput?.slice(-room) ?? [];
		if (tail.length === 0) lines.push(` ${ANSI.dim}(no output yet)${ANSI.reset}`);
		for (const out of tail) lines.push(` ${out}`);
		const hints = ` ${ANSI.dim}m message · o open transcript · Esc/← back${ANSI.reset}`;
		return [...fitToHeight(lines, height - 1), hints];
	}
}

// ── Flows ────────────────────────────────────────────────────────────────────

async function ensureContext(ctx: ExtensionCommandContext): Promise<void> {
	cwd = ctx.cwd;
	ui = ctx.ui;
	modelRegistry = ctx.modelRegistry;
	await loadState();
	updateWidget();
}

const BLANK_ROLE_LABEL = "(blank agent)";

const NEW_GROUP_LABEL = "＋ new feature…";

/** Existing features, most-recently-used first. */
function knownGroups(): string[] {
	const seen = new Map<string, number>();
	for (const a of roster.values()) {
		if (a.group) seen.set(a.group, Math.max(seen.get(a.group) ?? 0, a.startedAt));
	}
	return [...seen].sort((x, y) => y[1] - x[1]).map(([name]) => name);
}

async function newAgentFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	// 0) Feature — the workstream this agent belongs to; groups the roster.
	const groups = knownGroups();
	let group: string | undefined;
	if (groups.length > 0) {
		const picked = await ctx.ui.select("crew: feature", [
			...groups.map(g => ({ label: g })),
			{ label: NEW_GROUP_LABEL, description: "start a new workstream" },
		]);
		if (picked === undefined) return;
		group = picked === NEW_GROUP_LABEL ? undefined : picked;
	}
	if (!group) {
		const typed = await ctx.ui.input("crew: feature", "checkout flow / search revamp / … (empty = none)");
		if (typed === undefined) return;
		group = typed.trim() || undefined;
	}

	// 1) Role — only asked when presets exist; supplies system prompt + model.
	const roles = await loadRoles();
	let role: CrewRole | undefined;
	if (roles.length > 0) {
		const picked = await ctx.ui.select("crew: role", [
			...roles.map(r => ({ label: r.name, description: r.description ?? (r.model ? `model: ${r.model}` : undefined) })),
			{ label: BLANK_ROLE_LABEL, description: "no preset — generic system prompt, pick model manually" },
		]);
		if (picked === undefined) return;
		role = roles.find(r => r.name === picked);
	}

	// 2) Name — defaults to the role name (review, review-2, …).
	const defaultName = role ? uniqueName(role.name) : undefined;
	const nameInput = await ctx.ui.input(
		"crew: agent name",
		defaultName ? `empty = ${defaultName}` : "research / implementation / review / …",
	);
	if (nameInput === undefined) return;
	const name = nameInput.trim() || defaultName;
	if (!name) return;

	// 3) Task — the only per-spawn content when a role is used.
	const task = (await ctx.ui.editor(`crew: task for "${name}"${role ? ` (role: ${role.name})` : ""}`))?.trim();
	if (!task) return;

	let model = role?.model;
	if (!role) {
		model = (await ctx.ui.input("crew: model override", "empty = session default"))?.trim() || undefined;
	}
	spawnAgent(pi, { name, task, group, model, role });
	ctx.ui.notify(`crew: ${name} started${group ? ` on ${group}` : ""}${role ? ` (${role.name})` : ""}`, "info");
}

async function showCrewView(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await ensureContext(ctx);
	if (!ctx.hasUI) return;

	// Dialog actions close the overlay, run, then loop back into it.
	while (true) {
		const action = await ctx.ui.custom<OverlayAction | undefined>(
			(tui, _theme, _keybindings, done) => new CrewOverlay(tui, done),
			{ overlay: true },
		);
		if (!action) return;

		if (action.type === "new") {
			await newAgentFlow(pi, ctx);
			continue;
		}

		// Nested subagents (spawned by a crew worker's task tool) are registry
		// entries, not roster entries — Enter attaches to them like any other
		// agent, `m` queues a non-interrupting message instead.
		if (action.type === "message-child") {
			const ref = agentRegistry().get(action.id);
			if (!ref) continue;
			const text = (await ctx.ui.editor(`crew: message to "${ref.displayName}"`))?.trim();
			if (!text) continue;
			if (ref.session) {
				void ref.session.prompt(text, { streamingBehavior: "followUp" });
				ctx.ui.notify(`crew: message queued for ${ref.displayName}`, "info");
			} else {
				ctx.ui.notify(`crew: ${ref.displayName} is parked — open its transcript instead`, "warning");
			}
			continue;
		}

		const agent = roster.get(action.id);
		if (!agent) continue;

		switch (action.type) {
			case "message": {
				const text = (await ctx.ui.editor(`crew: message to "${agent.name}"`))?.trim();
				if (text) ctx.ui.notify(messageAgent(agent, text), "info");
				continue;
			}
			case "open": {
				try {
					await fs.access(agent.sessionFile);
				} catch {
					ctx.ui.notify(`crew: no session file for ${agent.name} (${agent.sessionFile})`, "error");
					continue;
				}
				const res = await ctx.switchSession(agent.sessionFile);
				if (!res.cancelled) return;
				continue;
			}
			case "rename": {
				const newName = (await ctx.ui.input(`crew: rename "${agent.name}" to`, agent.name))?.trim();
				if (newName && newName !== agent.name) {
					agent.name = newName;
					await saveState();
					updateWidget();
				}
				continue;
			}
			case "kill": {
				if (agent.status === "running") {
					const ok = await ctx.ui.confirm("crew: kill agent", `Abort "${agent.name}" while it is running?`);
					if (ok) agent.abort?.abort();
				} else {
					const ok = await ctx.ui.confirm(
						"crew: remove agent",
						`Remove "${agent.name}" from the roster? Its session file is kept on disk.`,
					);
					if (ok) {
						roster.delete(agent.id);
						await saveState();
						updateWidget();
					}
				}
				continue;
			}
		}
	}
}

// ── Registration ─────────────────────────────────────────────────────────────

export default function ompCrew(pi: ExtensionAPI): void {
	pi.setLabel("Crew");

	pi.registerShortcut("ctrl+a", {
		description: "crew: show agents view",
		// Interactive mode passes createCommandContext() to shortcut handlers even
		// though the type says ExtensionContext (input-controller.ts) — the cast is
		// what makes switchSession reachable from the overlay.
		handler: ctx => showCrewView(pi, ctx as ExtensionCommandContext),
	});

	pi.registerCommand("crew", {
		description: "Crew agents: view roster, spawn, rename, kill",
		getArgumentCompletions: prefix => {
			const subs = ["view", "new", "status", "back"];
			return subs.filter(s => s.startsWith(prefix ?? "")).map(s => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ensureContext(ctx);
			const sub = args.trim().split(/\s+/)[0] ?? "";
			switch (sub) {
				case "new":
					await newAgentFlow(pi, ctx);
					return;
				case "back": {
					if (!enteredLabel || !mainSessionFile) {
						ctx.ui.notify("crew: you are already in your own session", "info");
						return;
					}
					await ctx.switchSession(mainSessionFile);
					return;
				}
				case "status": {
					if (roster.size === 0) {
						ctx.ui.notify("crew: no agents", "info");
						return;
					}
					const byGroup = new Map<string, CrewAgent[]>();
					for (const a of roster.values()) {
						const key = a.group || UNGROUPED;
						byGroup.set(key, [...(byGroup.get(key) ?? []), a]);
					}
					const lines = [...byGroup].flatMap(([name, agents]) => [
						`${name}:`,
						...agents.map(
							a => `  ${a.name}: ${effectiveStatus(a)} (${agentAge(a)})${a.error ? ` — ${a.error}` : ""}`,
						),
					]);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				default:
					await showCrewView(pi, ctx);
					return;
			}
		},
	});

	// Surface the roster widget as soon as a session opens (previous runs show as stale).
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		ui = ctx.ui as UIRef;
		await loadState();
		updateWidget();
	});

	// "Where am I?" — entering an agent replaces the MAIN session's history with
	// that agent's transcript (AgentSession.switchSession), and nothing else on
	// screen says so. session_before_switch carries the target path; session_switch
	// carries the one we left, which is how /crew back finds its way home.
	pi.on("session_before_switch", async event => {
		pendingSwitchTarget = event.reason === "resume" ? event.targetSessionFile : undefined;
		return undefined;
	});

	pi.on("session_switch", async event => {
		const target = pendingSwitchTarget;
		pendingSwitchTarget = undefined;
		const label = target ? crewLabelForSession(target) : undefined;
		// Only the first hop leaves your own session; crew→crew hops keep the anchor.
		if (label && !enteredLabel) mainSessionFile = event.previousSessionFile;
		enteredLabel = label;
		updateWidget();
		if (label) {
			ui?.notify(
				`crew: you are now in ${label}'s transcript — what you type runs in your main agent with that history. /crew back returns.`,
				"info",
			);
		}
	});
}
