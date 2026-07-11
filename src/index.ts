import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LuaRuntime } from "./lua/runtime.ts";
import {
	createPrimitives,
	LUA_SCHEMA_PREAMBLE,
	NoopLogger,
} from "./adapter/index.ts";
import { SdkPromptDriver } from "./adapter/sdk-driver.ts";
import { RpcSubagentDriver } from "./adapter/rpc-driver.ts";
import { NodeExecDriver } from "./adapter/pi-exec.ts";
import { resolve, resolveInline } from "./discovery.ts";
import { todoAvailable } from "./adapter/todo.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify("pi-workflows loaded", "info");
	});

	// ---- conditional todo enrichment ----
	if (todoAvailable()) {
		pi.on("before_agent_start", (event) => {
			const section =
				"\n\n## Todo integration (pi-todo detected)\n" +
				'The `todo()` primitive is available in workflows. Use `todo("add", ...)` ' +
				"to create hierarchical task lists (with `ref`/`underRef` subtree syntax), " +
				'`todo("next", ...)` to pull the highest-priority pending task, and ' +
				'`todo("update", {list=…, id=…, status="done"})` to mark tasks done. ' +
				"The delegation loop: next → worker → done → repeat. " +
				"See TODO-INTEGRATION.md for real patterns.";
			return { systemPrompt: event.systemPrompt + section };
		});
	}

	// ---- /wf command (human-facing) ----
	pi.registerCommand("wf", {
		description: "Run a pi-workflows Lua workflow (name, path, or inline code)",
		handler: async (args, ctx) => {
			// If args starts with "-e ", treat the rest as inline Lua.
			// Otherwise treat as a workflow name or path.
			const trimmed = (args ?? "").trim();
			let kind: "name" | "inline" = "name";
			let specifier = trimmed;
			if (trimmed.startsWith("-e ")) {
				kind = "inline";
				specifier = trimmed.slice(3).trim();
			}
			try {
				const result = await runWorkflow(pi, specifier, kind);
				ctx.ui.notify(`Workflow done.`, "info");
				if (result !== undefined) {
					// Print the result so the user can see it.
					const text =
						typeof result === "string" ? result : JSON.stringify(result);
					pi.sendMessage({
						customType: "pi-workflows",
						content: text.slice(0, 2000),
						display: true,
						details: { result },
					});
				}
			} catch (e: any) {
				ctx.ui.notify(`Workflow failed: ${e.message}`, "error");
				pi.sendMessage({
					customType: "pi-workflows",
					content: `Workflow failed: ${e.message}`,
					display: true,
					details: { error: e.message },
				});
			}
		},
	});

	// ---- run_workflow tool (LLM-facing) ----
	pi.registerTool({
		name: "run_workflow",
		label: "Run Workflow",
		description:
			"Run a pi-workflows Lua workflow by name, path, or inline script. " +
			"Workflows are procedural Lua scripts with primitives: prompt(), subagent(), exec(), set_options(), reset_options(). " +
			"Use schema{…} for structured output.",
		promptSnippet:
			"Execute a multi-step procedural Lua workflow with prompt/subagent/exec primitives and guaranteed step ordering.",
		promptGuidelines: [
			"Use run_workflow for long, procedural plans that need guaranteed step execution. Prefer composing smaller workflows. Inline mode is good for one-off scripts.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({
					description:
						"Name of a saved workflow (.pi/workflows/<name>.lua or ~/.pi/agent/workflows/<name>.lua)",
				}),
			),
			path: Type.Optional(
				Type.String({ description: "Path to a .lua workflow file" }),
			),
			inline: Type.Optional(
				Type.String({ description: "Inline Lua workflow code" }),
			),
			args: Type.Optional(
				Type.Unsafe({
					description:
						"Optional arguments (JSON-serializable value). Available inside the workflow as the global _WF_ARGS.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const source =
				params.name != null
					? ({ kind: "name", value: String(params.name) } as const)
					: params.path != null
						? ({ kind: "path", value: String(params.path) } as const)
						: ({
								kind: "inline",
								value: String(params.inline ?? ""),
							} as const);
			try {
				const result = await runWorkflow(
					pi,
					source.value,
					source.kind,
					params.args,
				);
				const text =
					typeof result === "string" ? result : JSON.stringify(result);
				return {
					content: [{ type: "text", text }],
					details: { result },
				} as any;
			} catch (e: any) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Workflow failed: ${msg}` }],
					details: { error: msg },
					isError: true,
				} as any;
			}
		},
	});
}

// ---- shared run logic ----
async function runWorkflow(
	pi: ExtensionAPI,
	specifier: string,
	kind: "name" | "path" | "inline" = "inline",
	args?: unknown,
): Promise<unknown> {
	let code: string;

	switch (kind) {
		case "inline":
			code = resolveInline(specifier).code;
			break;
		case "path": {
			const { readFileSync } = await import("node:fs");
			code = readFileSync(specifier, "utf8");
			break;
		}
		default: {
			const r = resolve(specifier);
			code = r.code;
		}
	}

	// Build real drivers
	const promptDriver = new SdkPromptDriver();
	const subagentDriver = new RpcSubagentDriver(pi.events);
	const execDriver = new NodeExecDriver();

	const primitives = createPrimitives(
		{
			prompt: promptDriver,
			subagent: subagentDriver,
			exec: execDriver,
		},
		{ logger: new NoopLogger() }, // TODO: wire PiSessionLogger in hardening
	);

	const runtime = await LuaRuntime.create(primitives, {
		cpuSliceMs: 1000,
		totalTimeoutMs: 600_000, // 10 minutes
	});

	try {
		// Inject workflow args as a Lua global if provided
		if (args !== undefined) {
			runtime.inject({ _WF_ARGS: args });
		}
		const fullCode = LUA_SCHEMA_PREAMBLE + "\n" + code;
		const results = await runtime.run(fullCode);
		return results.length === 1 ? results[0] : results;
	} finally {
		await runtime.dispose();
	}
}
