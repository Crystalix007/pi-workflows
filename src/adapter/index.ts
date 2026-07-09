/**
 * Adapter — creates injectable Lua primitives from driver implementations.
 *
 * Each primitive is an async JS function (returns a Promise).  The Lua runtime
 * calls them directly; wasmoon's `:await()` yields the coroutine until the
 * Promise resolves.
 */
import type {
	AdapterDrivers,
	PromptOpts,
	SubagentOpts,
	ExecOpts,
} from "./driver.ts";
import { luaSchemaToJsonSchema } from "./schema.ts";

export type {
	AdapterDrivers,
	PromptDriver,
	SubagentDriver,
	ExecDriver,
} from "./driver.ts";
export { LUA_SCHEMA_PREAMBLE } from "./schema.ts";

type PromptFn = (
	text: string,
	schemaTable?: Record<string, unknown>,
) => Promise<unknown>;
type SubagentFn = (
	opts: Record<string, unknown>,
) => Promise<{ text: string; details?: unknown }>;
type ExecFn = (cmd: string) => Promise<string>;

/** A mutable options bag set by the workflow via `set_options()`. */
interface WorkflowOptions {
	context?: "continue" | "fork" | "fresh";
	model?: string;
	cwd?: string;
}

export function createPrimitives(drivers: AdapterDrivers) {
	const opts: WorkflowOptions = {};

	// ---- set_options / reset_options ----
	function set_options(o: Record<string, unknown>) {
		if (o.context !== undefined)
			opts.context = o.context as WorkflowOptions["context"];
		if (o.model !== undefined) opts.model = o.model as string;
		if (o.cwd !== undefined) opts.cwd = o.cwd as string;
	}
	function reset_options() {
		delete opts.context;
		delete opts.model;
		delete opts.cwd;
	}

	// ---- prompt(text, schema?) => any ----
	const promptFn: PromptFn = async (text, schemaTable) => {
		const promptOpts: PromptOpts = { text, ...opts } as PromptOpts;
		if (schemaTable && typeof schemaTable === "object") {
			promptOpts.schema = luaSchemaToJsonSchema(
				schemaTable as Record<string, any>,
			);
		}
		const res = await drivers.prompt.run(promptOpts);
		return promptOpts.schema !== undefined ? res.result : res.text;
	};

	// ---- subagent(opts) => { text, details } ----
	const subagentFn: SubagentFn = async (luaOpts) => {
		const rawCtx: string | undefined =
			(luaOpts.context as string) ?? opts.context;
		const ctx = (
			rawCtx === "continue" ? undefined : rawCtx
		) as SubagentOpts["context"];
		const o: SubagentOpts = {
			agent: luaOpts.agent as string,
			task: luaOpts.task as string,
			context: ctx,
			model: (luaOpts.model as string) ?? opts.model,
			cwd: (luaOpts.cwd as string) ?? opts.cwd,
		};
		if (luaOpts.outputSchema && typeof luaOpts.outputSchema === "object") {
			o.outputSchema = luaSchemaToJsonSchema(
				luaOpts.outputSchema as Record<string, any>,
			);
		}
		return drivers.subagent.run(o);
	};

	// ---- exec(cmd) => stdout ----
	const execFn: ExecFn = async (cmd) => {
		const execOpts: ExecOpts = { cmd, ...(opts.cwd ? { cwd: opts.cwd } : {}) };
		const r = await drivers.exec.run(execOpts);
		if (r.code !== 0) throw new Error(`exec failed (${r.code}): ${r.stderr}`);
		return r.stdout;
	};

	return {
		prompt: promptFn,
		subagent: subagentFn,
		exec: execFn,
		set_options,
		reset_options,
	};
}
