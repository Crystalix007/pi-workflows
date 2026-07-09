// Real PromptDriver using the pi SDK's createAgentSession.
// Manages a persistent session for `continue` context and creates
// disposable sessions for `fresh`/`fork`. Each run() injects a
// structured_output tool matching the requested schema.
//
// NOTE: this driver is designed to run inside a pi extension context,
// where createAgentSession resolves auth/model from ~/.pi/agent defaults
// and the "typebox" module is provided by pi's jiti loader.

import {
	createAgentSession,
	defineTool,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	PromptDriver,
	PromptOpts,
	PromptResult,
	JsonSchema,
} from "./driver.ts";

// ---- JsonSchema -> typebox converter ----
function jsonSchemaToTypebox(s: JsonSchema): any {
	if (!s.properties) return Type.Any();
	const props: Record<string, any> = {};
	for (const [k, v] of Object.entries(s.properties)) {
		props[k] = fieldToTB(v);
	}
	return Type.Object(props);
}

function fieldToTB(f: JsonSchema): any {
	let inner: any;
	if (f.type === "string") inner = Type.String();
	else if (f.type === "boolean") inner = Type.Boolean();
	else if (f.type === "number" || f.type === "integer") inner = Type.Number();
	else if (f.type === "array" && f.items)
		inner = Type.Array(fieldToTB(f.items));
	else if (f.type === "object" && f.properties) {
		const p: Record<string, any> = {};
		for (const [k, v] of Object.entries(f.properties)) p[k] = fieldToTB(v);
		inner = Type.Object(p);
	} else inner = Type.Any();
	if (f.description) (inner as any).description = f.description;
	return inner;
}

// ---- driver ----
export class SdkPromptDriver implements PromptDriver {
	private persistSession: any = null; // AgentSession for `continue` context

	async run(opts: PromptOpts): Promise<PromptResult> {
		let session: any;
		const ownsSession = opts.context !== "continue" || !this.persistSession;

		if (opts.context === "continue" && this.persistSession) {
			session = this.persistSession;
		} else {
			const sm = SessionManager.inMemory();
			const { session: s } = await createAgentSession({
				sessionManager: sm,
			} as any);
			session = s;
			if (opts.context === "continue") this.persistSession = session;
		}

		let captured: unknown = null;
		let finalText = "";
		const toolName = "__wf_structured_output";

		if (opts.schema) {
			const tbSchema = jsonSchemaToTypebox(opts.schema);
			// defineTool returns a type incompatible with AgentTool[] at the TS
			// level; the runtime types are compatible inside pi's jiti loader.
			const tool = defineTool({
				name: toolName,
				label: "Structured Output",
				description: "Call this tool with your final answer. You MUST call it.",
				parameters: tbSchema,
				async execute(_toolCallId: string, params: any) {
					captured = params;
					return {
						content: [{ type: "text", text: "Result recorded." }],
						details: {},
						terminate: true,
					};
				},
			} as any);
			session.agent.state.tools = [...session.agent.state.tools, tool];
		}

		const unsub = session.subscribe((event: any) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent?.type === "text_delta"
			) {
				finalText += event.assistantMessageEvent.delta;
			}
		});

		try {
			await session.prompt(opts.text);
		} finally {
			unsub();
			if (opts.schema) {
				session.agent.state.tools = session.agent.state.tools.filter(
					(t: any) => t.name !== toolName,
				);
			}
			if (ownsSession) {
				// Dispose non-continue sessions (best-effort)
				try {
					session.dispose();
				} catch {
					/* best-effort */
				}
			}
		}

		return {
			result: opts.schema ? captured : finalText || null,
			text: finalText,
		};
	}
}
