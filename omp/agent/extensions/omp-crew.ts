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
 *     ↑/↓/j/k select · Enter/→ open · n new · ^R rename · ^X kill · Esc close.
 *     Enter on a RUNNING agent shows a live detail pane (current tool, recent
 *     output, tokens/cost). Enter on a FINISHED agent switches the main prompt
 *     into that agent's session so you can keep talking to it (come back via
 *     omp's session picker).
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
import { type Component, matchesKey, replaceTabs, truncateToWidth, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";

type UIRef = ExtensionCommandContext["ui"];

type CrewStatus = "running" | "done" | "failed" | "aborted" | "stale";

interface CrewAgent {
	id: string;
	name: string;
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
	switch (a.status) {
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
	if (a.status === "running") {
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
	return `${a.status} ${agentAge(a)}${stats}${err}`;
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

function updateWidget(): void {
	if (!ui) return;
	if (roster.size === 0) {
		ui.setWidget("crew", undefined);
		return;
	}
	const parts = [...roster.values()].map(a => `${statusIcon(a)} ${a.name}`);
	ui.setWidget("crew", [` crew  ${parts.join("  ")}   ${ANSI.dim}ctrl+a: view${ANSI.reset}`]);
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

function spawnAgent(pi: ExtensionAPI, name: string, task: string, model?: string, role?: CrewRole): CrewAgent {
	const id = `crew-${slug(name)}-${Date.now().toString(36)}`;
	const abort = new AbortController();
	const agent: CrewAgent = {
		id,
		name,
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
		name: slug(name),
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
				enableLsp: false,
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

// ── Overlay view ─────────────────────────────────────────────────────────────

type OverlayAction =
	| { type: "open"; id: string }
	| { type: "message"; id: string }
	| { type: "rename"; id: string }
	| { type: "kill"; id: string }
	| { type: "open-child"; id: string }
	| { type: "message-child"; id: string }
	| { type: "new" };

type OverlayRow = { kind: "crew"; agent: CrewAgent } | { kind: "child"; ref: RegistryRef; depth: number };

class CrewOverlay implements Component {
	#selected = 0;
	#detailId: string | null = null;
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
		overlayRefresh = null;
	}

	#rows(): OverlayRow[] {
		const refs = agentRegistry().list();
		return [...roster.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.flatMap(a => [
				{ kind: "crew", agent: a } as OverlayRow,
				...childTree(a.id, refs).map(c => ({ kind: "child", ...c }) as OverlayRow),
			]);
	}

	handleInput(data: string): void {
		const rows = this.#rows();
		const current = rows[this.#selected];

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
			this.#selected = Math.max(0, this.#selected - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.#selected = Math.min(Math.max(0, rows.length - 1), this.#selected + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "right")) {
			if (!current) return;
			if (current.kind === "child") {
				this.done({ type: "open-child", id: current.ref.id });
				return;
			}
			this.#detailId = current.agent.id;
			this.tui.requestRender();
		} else if (data === "m") {
			if (!current) return;
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
		const height = viewportHeight();
		const lines = this.#detailId ? this.#renderDetail(this.#detailId, height) : this.#renderList(height);
		return fitToHeight(lines, height).map(l => truncateToWidth(replaceTabs(l), width));
	}

	#renderList(height: number): string[] {
		const rows = this.#rows();
		if (this.#selected >= rows.length) this.#selected = Math.max(0, rows.length - 1);
		const crewCount = rows.filter(r => r.kind === "crew").length;
		const lines: string[] = [];
		lines.push(`${ANSI.bold} crew — ${path.basename(cwd)}${ANSI.reset}  ${ANSI.dim}${crewCount} agent(s)${ANSI.reset}`);
		lines.push("");
		if (rows.length === 0) {
			lines.push(`   ${ANSI.dim}no agents yet — press n to create one${ANSI.reset}`);
		}
		// Chrome: title + blank + blank + hints, plus a row for each overflow marker.
		const budget = Math.max(3, height - 6);
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
			if (r.kind === "crew") {
				lines.push(` ${cursor} ${statusIcon(r.agent)} ${r.agent.name.padEnd(nameWidth)}  ${agentSummary(r.agent)}`);
			} else {
				const icon =
					r.ref.status === "running"
						? `${ANSI.yellow}◐${ANSI.reset}`
						: r.ref.status === "idle"
							? `${ANSI.green}●${ANSI.reset}`
							: `${ANSI.dim}○${ANSI.reset}`;
				const doing = r.ref.activity ? ` · ${r.ref.activity}` : "";
				lines.push(
					` ${cursor} ${"  ".repeat(r.depth)}└ ${icon} ${r.ref.displayName}  ${ANSI.dim}${r.ref.status}${doing}${ANSI.reset}`,
				);
			}
		});
		if (end < rows.length) lines.push(`   ${ANSI.dim}… ${rows.length - end} more below${ANSI.reset}`);
		// Hints pinned to the bottom of the full-height block.
		const hints = ` ${ANSI.dim}↑↓/jk select · Enter/→ open · m message · n new · ^R rename · ^X kill · Esc close${ANSI.reset}`;
		return [...fitToHeight(lines, height - 1), hints];
	}

	#renderDetail(id: string, height: number): string[] {
		const a = roster.get(id);
		if (!a) return [" agent gone"];
		const p = a.progress;
		const lines: string[] = [];
		lines.push(`${ANSI.bold} ${statusIcon(a)} ${a.name}${ANSI.reset}  ${ANSI.dim}${a.role ? `${a.role} · ` : ""}${a.status} · ${agentAge(a)}${p?.resolvedModel ? ` · ${p.resolvedModel}` : ""}${ANSI.reset}`);
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

async function newAgentFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
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
	spawnAgent(pi, name, task, model, role);
	ctx.ui.notify(`crew: ${name} started${role ? ` (${role.name})` : ""}`, "info");
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
		// entries, not roster entries: open their transcript or message them.
		if (action.type === "open-child" || action.type === "message-child") {
			const ref = agentRegistry().get(action.id);
			if (!ref) continue;
			if (action.type === "message-child") {
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
			if (!ref.sessionFile) {
				ctx.ui.notify(`crew: no session file for ${ref.displayName}`, "error");
				continue;
			}
			const res = await ctx.switchSession(ref.sessionFile);
			if (!res.cancelled) return;
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
			const subs = ["view", "new", "status"];
			return subs.filter(s => s.startsWith(prefix ?? "")).map(s => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ensureContext(ctx);
			const sub = args.trim().split(/\s+/)[0] ?? "";
			switch (sub) {
				case "new":
					await newAgentFlow(pi, ctx);
					return;
				case "status": {
					if (roster.size === 0) {
						ctx.ui.notify("crew: no agents", "info");
						return;
					}
					const lines = [...roster.values()].map(a => `${a.name}: ${a.status} (${agentAge(a)})${a.error ? ` — ${a.error}` : ""}`);
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
}
