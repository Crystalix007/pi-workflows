// Spike 0.3 — validate host -> pi-subagents RPC plumbing (no model cost).
// Registers a `ready` listener in the factory (before any session_start),
// then emits a `ping` on the shared event bus and prints the reply envelope.
// This is the exact integration path our adapter will use.
// Run: pi -e spikes/rpc-spike.ts -p "ok"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READY = "subagents:rpc:v1:ready";
const REQUEST = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const VERSION = 1;

export default function (pi: ExtensionAPI) {
	let fired = false;

	const ping = (label: string) => {
		if (fired) return;
		const requestId = `wf-spike-${label}-${Math.random().toString(36).slice(2, 10)}`;
		const replyEvent = REPLY_PREFIX + requestId;
		let off: (() => void) | undefined;

		const timer = setTimeout(() => {
			off?.();
			console.error(`[wf-rpc-spike] ${label}: TIMEOUT (no reply in 5s)`);
		}, 5000);

		const offRet = pi.events.on(replyEvent, (reply: unknown) => {
			if (fired) return;
			fired = true;
			clearTimeout(timer);
			off?.();
			console.error(`[wf-rpc-spike] ${label} reply: ${JSON.stringify(reply)}`);
		});
		off = typeof offRet === "function" ? offRet : undefined;

		pi.events.emit(REQUEST, {
			version: VERSION,
			requestId,
			method: "ping",
			source: { extension: "pi-workflows-spike" },
		});
		console.error(
			`[wf-rpc-spike] ${label}: emitted ping (requestId=${requestId})`,
		);
	};

	// Factory runs before session_start events fire, so this listener is in place
	// before pi-subagents emits `ready` from its own session_start handler.
	pi.events.on(READY, () => ping("on-ready"));
	// Fallback in case `ready` already fired before the listener attached.
	setTimeout(() => ping("fallback-1s"), 1000);
}
