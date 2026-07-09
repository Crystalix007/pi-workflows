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
import { NoopLogger, type WorkflowLogger } from "../logging.ts";
import {
	withPolicy,
	type PolicyConfig,
	type PolicyContext,
	DEFAULT_POLICY,
} from "../policy.ts";

export type {
	AdapterDrivers,
	PromptDriver,
	SubagentDriver,
	ExecDriver,
} from "./driver.ts";
export { LUA_SCHEMA_PREAMBLE } from "./schema.ts";
export { NoopLogger } from "../logging.ts";
export { DEFAULT_POLICY, WorkflowHaltError } from "../policy.ts";

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

export interface AdapterOptions {
	logger?: WorkflowLogger;
	policy?: PolicyConfig;
}

export function createPrimitives(
	drivers: AdapterDrivers,
	adapterOpts: AdapterOptions = {},
) {
	const opts: WorkflowOptions = {};
	const logger = adapterOpts.logger ?? new NoopLogger();
	const policy = adapterOpts.policy ?? DEFAULT_POLICY;
	const pctx: PolicyContext = { stepIndex: 0, logger, policy };

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
	const rawPrompt: PromptFn = async (text, schemaTable) => {
		const promptOpts: PromptOpts = { text, ...opts } as PromptOpts;
		if (schemaTable && typeof schemaTable === "object") {
			promptOpts.schema = luaSchemaToJsonSchema(
				schemaTable as Record<string, any>,
			);
		}
		const res = await drivers.prompt.run(promptOpts);
		return promptOpts.schema !== undefined ? res.result : res.text;
	};
	const promptFn = withPolicy("prompt", rawPrompt, pctx);

	// ---- subagent(opts) => { text, details } ----
	const rawSubagent: SubagentFn = async (luaOpts) => {
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
	const subagentFn = withPolicy("subagent", rawSubagent, pctx);

	// ---- exec(cmd) => stdout ----
	const rawExec: ExecFn = async (cmd) => {
		const execOpts: ExecOpts = { cmd, ...(opts.cwd ? { cwd: opts.cwd } : {}) };
		const r = await drivers.exec.run(execOpts);
		if (r.code !== 0) throw new Error(`exec failed (${r.code}): ${r.stderr}`);
		return r.stdout;
	};
	const execFn = withPolicy("exec", rawExec, pctx);

	return {
		prompt: promptFn,
		subagent: subagentFn,
		exec: execFn,
		set_options,
		reset_options,
	};
}
