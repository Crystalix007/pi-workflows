// Real SubagentDriver using pi-subagents' in-process Extension RPC.
//
// Emits a `spawn` RPC, polls `status` until the run completes (detecting
// "State: complete" or "State: failed" in the status text), and returns
// the terminal status data. See spikes/spawn-ext.ts for the validated
// RPC mechanics.

import type { SubagentDriver, SubagentOpts, SubagentResult } from "./driver.ts";

export interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

const REQUEST = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

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

	async run(opts: SubagentOpts): Promise<SubagentResult> {
		const spawnParams: any = {
			agent: opts.agent,
			task: opts.task,
			context: opts.context ?? "fresh",
			async: true,
		};
		if (opts.model) spawnParams.model = opts.model;
		if (opts.cwd) spawnParams.cwd = opts.cwd;

		const spawnData = await this.rpc("spawn", spawnParams);
		const details = spawnData?.details ?? {};
		const target: any = {};
		if (details.id) target.id = details.id;
		if (details.runId) target.runId = details.runId;
		else if (details.asyncId) target.runId = details.asyncId;
		if (details.dir) target.dir = details.dir;
		else if (details.asyncDir) target.dir = details.asyncDir;

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
			if (/\bState:\s*(complete|failed)\b/.test(text)) {
				return { text, details: statusData?.details };
			}
		}
	}
}
