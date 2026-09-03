/**
 * omp context gauge — the context window as raw tokens, not a percentage.
 *
 * omp's own status-line gauge (the reactive line between the left and right
 * segments) prints `9%` and `1M`; its label is hardcoded in
 * `formatEmbeddedContextPercent` and there is no setting for tokens. The segment
 * registry is internal — extensions get `ui.setStatus` (rows under the bar),
 * `ui.setWidget` (a component above/below the editor) and `setEditorComponent`,
 * and nothing that reaches into a segment. So this draws its own gauge as a row
 * below the editor instead:
 *
 *   197K/1M ████████████░░░░░░░░░░░░░░░░░░░░░░
 *
 * It pairs with `statusLine.contextLine: percentage` plus a custom preset that
 * drops `context_pct`/`context_total` (see omp/agent/config.yml here), so the
 * percentage is gone from the bar and this is the only context readout.
 *
 * Colors mirror omp's own thresholds (`getContextUsageLevel`): a level trips at
 * a percentage OR at an absolute token count, whichever comes first, so a 1M
 * window warns on absolute burn long before 50%.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
// Type-only: nothing here has to resolve at runtime, but the compiler still
// checks the one contract omp calls back into.
import type { Component } from "@oh-my-pi/pi-tui";

const WIDGET_KEY = "context-gauge";
/** Context usage only moves when a turn does; 1 s is imperceptible and cheap. */
const POLL_MS = 1000;
const FILLED = "█";
const EMPTY = "░";

/** omp's thresholds: [percent, absoluteTokens, themeColor], worst first. */
const LEVELS: ReadonlyArray<readonly [number, number, string]> = [
	[90, 500_000, "error"],
	[70, 270_000, "thinkingHigh"],
	[50, 150_000, "warning"],
];
const OK_COLOR = "statusLineContext";

/** The subset of omp's theme this file touches. */
interface Theme {
	fg(color: string, text: string): string;
	icon?: Record<string, string | undefined>;
}

/** The subset of `ctx` this file touches; `ExtensionContext` is wider. */
interface Ctx {
	hasUI?: boolean;
	getContextUsage?(): { tokens?: number; contextWindow?: number; percent?: number } | undefined | null;
	setInterval(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	ui: {
		theme?: Theme;
		setWidget?(
			key: string,
			content: ((ui: unknown, theme: Theme) => Component) | readonly string[] | undefined,
			opts?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		setStatus?(key: string, text: string | undefined): void;
	};
}

interface Reading {
	/** `197K/1M` — already formatted, and the change-detection key. */
	label: string;
	/** Used fraction of the window, clamped to [0, 1]. */
	ratio: number;
	/** Theme color name for both label and filled bar. */
	color: string;
}

/** One decimal, but `1.0M` reads as `1M` — omp drops the dead `.0` too. */
function oneDecimal(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * omp's `formatNumber`: 1234 -> `1.2K`, 197000 -> `197K`, 1e6 -> `1M`.
 * Reimplemented rather than imported — it is not part of ExtensionAPI.
 */
function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${oneDecimal(n / 1000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	if (n < 10_000_000) return `${oneDecimal(n / 1_000_000)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function levelColor(percent: number, window: number): string {
	for (const [pct, absolute, color] of LEVELS) {
		// The absolute limit expressed as a percentage of this window; the
		// smaller of the two trips first, which is what omp does.
		const effective = window > 0 ? Math.min(pct, (absolute / window) * 100) : pct;
		if (percent >= effective) return color;
	}
	return OK_COLOR;
}

function read(ctx: Ctx): Reading | null {
	const usage = ctx.getContextUsage?.();
	if (!usage) return null;
	const tokens = usage.tokens ?? 0;
	const window = usage.contextWindow ?? 0;
	if (window <= 0) {
		// No window to divide by: report the burn, draw an empty bar.
		return { label: `${formatTokens(tokens)}/?`, ratio: 0, color: OK_COLOR };
	}
	const percent = usage.percent ?? (tokens / window) * 100;
	return {
		label: `${formatTokens(tokens)}/${formatTokens(window)}`,
		ratio: Math.min(1, Math.max(0, tokens / window)),
		color: levelColor(percent, window),
	};
}

/** One row: `197K/1M ██████░░░░░░`, bar taking whatever the label leaves. */
function gauge(reading: Reading, theme: Theme): Component {
	return {
		render(width: number): readonly string[] {
			const label = reading.label;
			// 1 leading space, 1 between label and bar; the bar needs 4 cells to
			// mean anything, below that show the label alone.
			const barWidth = width - label.length - 2;
			const head = ` ${theme.fg(reading.color, label)}`;
			if (barWidth < 4) return [head];
			const filled = Math.min(barWidth, Math.round(reading.ratio * barWidth));
			return [
				`${head} ${theme.fg(reading.color, FILLED.repeat(filled))}${theme.fg("border", EMPTY.repeat(barWidth - filled))}`,
			];
		},
	};
}

export default function contextGauge(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, rawCtx) => {
		const ctx = rawCtx as unknown as Ctx;
		const theme = ctx.ui.theme;
		// A widget needs a component, which needs a theme; without either (RPC
		// and ACP stub the widget surface) fall back to a status row, which is
		// plain text and always supported.
		const widgets = ctx.hasUI !== false && typeof ctx.ui.setWidget === "function" && theme !== undefined;
		let shown: string | undefined;

		const paint = () => {
			const reading = read(ctx);
			if (!reading) return;
			if (reading.label === shown) return;
			shown = reading.label;
			if (widgets && theme) {
				ctx.ui.setWidget?.(WIDGET_KEY, () => gauge(reading, theme), { placement: "belowEditor" });
			} else {
				ctx.ui.setStatus?.(WIDGET_KEY, reading.label);
			}
		};

		paint();
		const timer = ctx.setInterval(paint, POLL_MS);

		pi.on("session_shutdown", () => {
			ctx.clearTimer(timer);
			if (widgets) ctx.ui.setWidget?.(WIDGET_KEY, undefined);
			else ctx.ui.setStatus?.(WIDGET_KEY, undefined);
		});
	});
}
