// Real SubagentDriver using pi-subagents' in-process Extension RPC.
//
// Emits a `spawn` RPC, polls `status` until the run completes (detecting
// "State: complete" or "State: failed" in the status text), then reads
// the run's result file to return the actual child output instead of
// the terminal status text. This enables downstream workflow steps to
// use prior subagent results as inputs.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentDriver, SubagentOpts, SubagentResult } from "./driver.ts";

export interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

const REQUEST = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

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
	results?: Array<{
		agent?: string;
		output?: string;
		summary?: string;
		state?: string;
		success?: boolean;
		exitCode?: number | null;
		sessionFile?: string;
		structuredOutput?: unknown;
	}>;
}

function readAsyncResult(asyncDir: string | undefined): AsyncResultFile | null {
	if (!asyncDir) return null;
	// Try result.json first (written on completion), then result.jsonl as fallback
	for (const name of ["result.json", "result.jsonl"]) {
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

/** Try to read an individual step output file (output-0.log, output-1.log, ...). */
function readStepOutput(asyncDir: string, index: number): string | null {
	try {
		const p = path.join(asyncDir, `output-${index}.log`);
		if (fs.existsSync(p)) {
			return fs.readFileSync(p, "utf-8").trimEnd();
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

		// Single run
		const output =
			result.output ?? readStepOutput(asyncDir!, 0) ?? result.summary ?? "";
		const text = output.trim() || statusText;
		return {
			text,
			details:
				result.structuredOutput !== undefined
					? result.structuredOutput
					: undefined,
		};
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
}
