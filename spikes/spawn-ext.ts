// Spike 0.3 + 0.4 (extension form) — spawn a delegate + a structured-output
// chain via the host RPC, polling status to completion. Run as a real pi
// extension (so pi-subagents definitely loads + emits ready), invoked through a
// command so -p awaits the long poll:
//   pi -e spikes/spawn-ext.ts -p "/wf-spawn"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUEST = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

export default function (pi: ExtensionAPI) {
	const log = (m: string) => console.error(`[wf-spawn-spike] ${m}`);

	const rpc = (method: string, params: unknown) =>
		new Promise((resolve, reject) => {
			const requestId = `wf-${method}-${Math.random().toString(36).slice(2, 8)}`;
			let off: (() => void) | undefined;
			const timer = setTimeout(() => {
				off?.();
				reject(new Error(`${method} 15s timeout`));
			}, 15000);
			const offRet = pi.events.on(REPLY_PREFIX + requestId, (reply: any) => {
				clearTimeout(timer);
				off?.();
				if (reply?.success) resolve(reply.data);
				else
					reject(
						new Error(`${method} failed: ${JSON.stringify(reply?.error)}`),
					);
			});
			off = typeof offRet === "function" ? offRet : undefined;
			pi.events.emit(REQUEST, {
				version: 1,
				requestId,
				method,
				params,
				source: { extension: "pi-workflows-spike" },
			});
		});

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const targetFrom = (d: any = {}) => {
		const t: any = {};
		if (d.id) t.id = d.id;
		if (d.runId) t.runId = d.runId;
		else if (d.asyncId) t.runId = d.asyncId;
		if (d.dir) t.dir = d.dir;
		else if (d.asyncDir) t.dir = d.asyncDir;
		return t;
	};

	const pollUntilDone = async (data: any, label: string) => {
		const target = targetFrom(data?.details);
		log(`${label}: status target = ${JSON.stringify(target)}`);
		let last: any = null;
		for (let i = 0; i < 24; i++) {
			await sleep(1500);
			let s: any;
			try {
				s = await rpc("status", target);
			} catch (e: any) {
				log(`${label}: status[${i}] err ${e.message}`);
				continue;
			}
			last = s;
			const text: string = s?.text || "";
			const m = text.match(/State:\s*(\w+)/);
			const state = m?.[1] || "?";
			if (i < 3) log(`${label}: state[${i}] = ${state}`);
			if (state === "complete" || state === "failed") {
				log(
					`${label}: terminal (${state}); details.results = ${JSON.stringify(s?.details?.results).slice(0, 1200)}`,
				);
				log(`${label}: text tail = ...${text.slice(-300)}`);
				return s;
			}
		}
		log(
			`${label}: no terminal state seen; LAST raw ===\n${JSON.stringify(last).slice(0, 2200)}`,
		);
	};

	pi.registerCommand("wf-spawn", {
		description: "Spike: spawn delegate + structured-output chain via RPC",
		handler: async (_args, ctx) => {
			log("command invoked");
			// 0.3 — single delegate, text result
			try {
				const data: any = await rpc("spawn", {
					agent: "delegate",
					task: "Reply with exactly the word: pong",
					context: "fresh",
					async: true,
				});
				log(`0.3 spawn data = ${JSON.stringify(data)}`);
				await pollUntilDone(data, "0.3");
			} catch (e: any) {
				log(`0.3 ERROR: ${e.message || e}`);
			}
			// 0.4 — single-step chain with outputSchema (structured output)
			try {
				const data: any = await rpc("spawn", {
					async: true,
					context: "fresh",
					chain: [
						{
							agent: "delegate",
							task: "Is 2+2 equal to 4? Decide and return structured output.",
							outputSchema: {
								type: "object",
								properties: {
									correct: { type: "boolean" },
									reasoning: { type: "string" },
								},
								required: ["correct", "reasoning"],
							},
						},
					],
				});
				log(`0.4 spawn data = ${JSON.stringify(data)}`);
				await pollUntilDone(data, "0.4");
			} catch (e: any) {
				log(`0.4 ERROR: ${e.message || e}`);
			}
			ctx.ui.notify("wf-spawn done", "info");
			log("command done");
		},
	});
}
