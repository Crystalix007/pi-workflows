// Real SubagentDriver using pi-subagents' in-process Extension RPC.
//
// Emits a `spawn` RPC, polls `status` until the run completes (detecting
// "State: complete" or "State: failed" in the status text), then reads
// the run's result file to return the actual child output instead of
// the terminal status text. This enables downstream workflow steps to
// use prior subagent results as inputs.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	FanoutChildResult,
	FanoutOpts,
	FanoutResult,
	SubagentDriver,
	SubagentOpts,
	SubagentResult,
} from "./driver.ts";

export interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

const REQUEST = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

type TerminalState = "complete" | "failed" | "stopped" | "paused";

function terminalState(value: unknown): TerminalState | undefined {
	return value === "complete" ||
		value === "failed" ||
		value === "stopped" ||
		value === "paused"
		? value
		: undefined;
}

/** Shape of the result JSON file written by pi-subagents for a completed async run. */
interface AsyncResultFile {
	id?: string;
	runId?: string;
	agent?: string;
	success?: boolean;
	state?: string;
	summary?: string;
	output?: string;
	exitCode?: number;
	sessionFile?: string;
	structuredOutput?: unknown;
	results?: AsyncChildResult[];
	steps?: AsyncChildResult[];
}

interface AsyncChildResult {
	agent?: string;
	output?: string;
	finalOutput?: string;
	summary?: string;
	state?: string;
	status?: string;
	success?: boolean;
	exitCode?: number | null;
	sessionFile?: string;
	transcriptPath?: string;
	recentOutput?: string[];
	structuredOutput?: unknown;
}

/** Raised after launched fan-out children complete unsuccessfully. */
export class FanoutError extends Error {
	constructor(
		message: string,
		readonly result: FanoutResult,
	) {
		super(message);
	}
}

function readAsyncResult(asyncDir: string | undefined): AsyncResultFile | null {
	if (!asyncDir) return null;
	// status.json is the documented, durable lifecycle artifact. Result files
	// are transient hand-off data and remain a compatibility fallback.
	for (const name of ["status.json", "result.json", "result.jsonl"]) {
		try {
			const p = path.join(asyncDir, name);
			if (fs.existsSync(p)) {
				return JSON.parse(fs.readFileSync(p, "utf-8")) as AsyncResultFile;
			}
		} catch {
			// file may not exist yet; keep trying
		}
	}
	return null;
}

/** Read only the child result portion of output-N.log, not its prompt prelude. */
function readStepOutput(asyncDir: string, index: number): string | null {
	try {
		const p = path.join(asyncDir, `output-${index}.log`);
		if (fs.existsSync(p)) {
			const content = fs.readFileSync(p, "utf-8").trimEnd();
			const marker = "\n---\n**Output:**\n";
			const markerIndex = content.lastIndexOf(marker);
			return markerIndex >= 0
				? content.slice(markerIndex + marker.length).trim()
				: content;
		}
	} catch {
		/* not available */
	}
	return null;
}

export class RpcSubagentDriver implements SubagentDriver {
	private readonly events: EventBus;
	private readonly pollIntervalMs: number;
	private readonly totalTimeoutMs: number;

	constructor(
		events: EventBus,
		pollIntervalMs = 2000,
		totalTimeoutMs = 300_000,
	) {
		this.events = events;
		this.pollIntervalMs = pollIntervalMs;
		this.totalTimeoutMs = totalTimeoutMs;
	}

	rpc(method: string, params: unknown): Promise<any> {
		return new Promise((resolve, reject) => {
			const requestId = `wf-sa-${method}-${Math.random().toString(36).slice(2, 8)}`;
			const replyEvent = REPLY_PREFIX + requestId;
			let off: (() => void) | undefined;
			const timer = setTimeout(() => {
				off?.();
				reject(new Error(`subagent RPC ${method} timed out (15s)`));
			}, 15000);
			const offRet = this.events.on(replyEvent, (reply: any) => {
				clearTimeout(timer);
				off?.();
				if (reply?.success) resolve(reply.data);
				else
					reject(
						new Error(`${method} failed: ${JSON.stringify(reply?.error)}`),
					);
			});
			off = typeof offRet === "function" ? offRet : undefined;
			this.events.emit(REQUEST, {
				version: 1,
				requestId,
				method,
				params,
				source: { extension: "pi-workflows" },
			});
		});
	}

	sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	/**
	 * Read the output from a completed run's result file.
	 * For single runs, returns result.output.
	 * For chain/parallel runs, concatenates all child outputs.
	 * Falls back to the status text if no result file is found.
	 */
	private readOutput(
		asyncDir: string | undefined,
		statusText: string,
	): { text: string; details?: unknown } {
		const result = readAsyncResult(asyncDir);
		if (!result) {
			return { text: statusText };
		}

		// Multi-step run (chain/parallel): aggregate child outputs
		if (result.results && result.results.length > 0) {
			const parts: string[] = [];
			const allStructured: Record<string, unknown> = {};
			for (let i = 0; i < result.results.length; i++) {
				const child = result.results[i];
				const childOutput =
					child.output ?? readStepOutput(asyncDir!, i) ?? child.summary ?? "";
				const prefix = child.agent ? `[${child.agent}] ` : "";
				if (childOutput.trim()) {
					parts.push(`${prefix}${childOutput.trim()}`);
				}
				if (child.structuredOutput !== undefined) {
					allStructured[child.agent ?? `step_${i}`] = child.structuredOutput;
				}
				if (
					child.success === false ||
					(child.exitCode != null && child.exitCode !== 0)
				) {
					parts.push(
						`${prefix}[failed: ${child.summary ?? child.output ?? "unknown error"}]`,
					);
				}
			}
			const text = parts.length > 0 ? parts.join("\n\n") : statusText;
			return {
				text,
				details:
					Object.keys(allStructured).length > 0 ? allStructured : undefined,
			};
		}

		// Single run. The durable status artifact keeps the final child output in
		// its first step's recentOutput; transient result files expose it at root.
		const step = result.steps?.[0];
		const output =
			result.output ??
			step?.output ??
			step?.finalOutput ??
			step?.recentOutput?.join("\n") ??
			readStepOutput(asyncDir!, 0) ??
			result.summary ??
			"";
		const text = output.trim() || statusText;
		const details = result.structuredOutput ?? step?.structuredOutput;
		return details === undefined ? { text } : { text, details };
	}

	private readFanoutOutput(
		asyncDir: string | undefined,
		statusText: string,
		terminal: TerminalState,
		opts: FanoutOpts,
	): FanoutResult {
		const result = readAsyncResult(asyncDir);
		const children = result?.results ?? result?.steps ?? [];
		const terminalFailed = terminal !== "complete";
		const results: FanoutChildResult[] = opts.tasks.map((task, index) => {
			const child = children[index];
			const text = child
				? (child.output ??
					child.finalOutput ??
					readStepOutput(asyncDir!, index) ??
					child.recentOutput?.join("\n") ??
					child.summary ??
					statusText)
				: (readStepOutput(asyncDir!, index) ?? statusText);
			const childState = terminalState(child?.state ?? child?.status);
			let status: FanoutChildResult["status"] = "unknown";
			if (childState) {
				status = childState;
			} else if (
				child?.success === false ||
				(child?.exitCode != null && child.exitCode !== 0) ||
				terminalFailed
			) {
				status = "failed";
			}
			const details = child?.structuredOutput;
			const result: FanoutChildResult = {
				index,
				agent: child?.agent ?? task.agent,
				task: task.task,
				text: text.trim(),
				status,
				ok: status === "complete" || (!terminalFailed && status === "unknown"),
			};
			if (details !== undefined) result.details = details;
			return result;
		});
		const text =
			results
				.map((child) => (child.text ? `[${child.agent}] ${child.text}` : ""))
				.filter(Boolean)
				.join("\n\n") || statusText;
		return { text, results, runId: result?.runId ?? result?.id };
	}

	async run(opts: SubagentOpts): Promise<SubagentResult> {
		const spawnParams: any = {
			agent: opts.agent,
			task: opts.task,
			context: opts.context ?? "fresh",
			async: true,
		};
		// Pass outputSchema so pi-subagents stores structured output in the result
		if (opts.model) spawnParams.model = opts.model;
		if (opts.cwd) spawnParams.cwd = opts.cwd;
		if (opts.outputSchema) {
			spawnParams.outputSchema = opts.outputSchema;
		}

		const spawnData = await this.rpc("spawn", spawnParams);
		const details = spawnData?.details ?? {};
		const target: any = {};
		if (details.id) target.id = details.id;
		if (details.runId) target.runId = details.runId;
		else if (details.asyncId) target.runId = details.asyncId;
		if (details.dir) target.dir = details.dir;
		else if (details.asyncDir) target.dir = details.asyncDir;
		const asyncDir: string | undefined =
			details.asyncDir ?? details.dir ?? target.dir;

		const start = Date.now();
		for (;;) {
			await this.sleep(this.pollIntervalMs);
			if (Date.now() - start > this.totalTimeoutMs) {
				throw new Error(
					`subagent ${opts.agent} timed out after ${this.totalTimeoutMs}ms`,
				);
			}
			let statusData: any;
			try {
				statusData = await this.rpc("status", target);
			} catch {
				continue; // retry on transient errors
			}
			const text: string = statusData?.text ?? "";
			if (/\bState:\s*complete\b/.test(text)) {
				// Give the result file a moment to be written, then read actual output.
				await this.sleep(500);
				const output = this.readOutput(asyncDir, text);
				return {
					text: output.text,
					details: output.details,
				};
			}
			if (/\bState:\s*failed\b/.test(text)) {
				await this.sleep(500);
				const output = this.readOutput(asyncDir, text);
				return {
					text: output.text || text,
					details: output.details ?? statusData?.details,
				};
			}
		}
	}

	async fanout(opts: FanoutOpts): Promise<FanoutResult> {
		const spawnParams: any = {
			tasks: opts.tasks.map((task) => ({
				agent: task.agent,
				task: task.task,
				...(task.model ? { model: task.model } : {}),
				...(task.cwd ? { cwd: task.cwd } : {}),
				...(task.outputSchema ? { outputSchema: task.outputSchema } : {}),
			})),
			context: opts.context ?? "fresh",
			async: true,
			...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
			...(opts.cwd ? { cwd: opts.cwd } : {}),
			...(opts.worktree ? { worktree: true } : {}),
		};
		const spawnData = await this.rpc("spawn", spawnParams);
		const details = spawnData?.details ?? {};
		const target: any = {};
		if (details.id) target.id = details.id;
		if (details.runId) target.runId = details.runId;
		else if (details.asyncId) target.runId = details.asyncId;
		if (details.dir) target.dir = details.dir;
		else if (details.asyncDir) target.dir = details.asyncDir;
		const asyncDir: string | undefined =
			details.asyncDir ?? details.dir ?? target.dir;

		const start = Date.now();
		for (;;) {
			await this.sleep(this.pollIntervalMs);
			if (Date.now() - start > this.totalTimeoutMs) {
				throw new Error(`fanout timed out after ${this.totalTimeoutMs}ms`);
			}
			let statusData: any;
			try {
				statusData = await this.rpc("status", target);
			} catch {
				continue;
			}
			const text: string = statusData?.text ?? "";
			const state =
				terminalState(readAsyncResult(asyncDir)?.state) ??
				terminalState(text.match(/\bState:\s*(\w+)\b/)?.[1]);
			if (state) {
				await this.sleep(500);
				const output = this.readFanoutOutput(asyncDir, text, state, opts);
				if (state !== "complete" || output.results.some((child) => !child.ok)) {
					throw new FanoutError("one or more fanout children failed", output);
				}
				return output;
			}
		}
	}
}
