/**
 * Adapter interfaces + shared types.
 *
 * Each primitive is backed by a driver that the real pi extension or a mock
 * test harness can provide. This keeps the primitive logic testable without
 * model calls.
 */

// ---- JSON Schema (subset used by the schema compiler) ----
export interface JsonSchema {
	type: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean;
	description?: string;
	items?: JsonSchema;
	enum?: unknown[];
}

// ---- Primitives ----
export interface PromptOpts {
	text: string;
	schema?: JsonSchema;
	context?: "continue" | "fork" | "fresh";
	model?: string;
	cwd?: string;
}
export interface PromptResult {
	result: unknown; // parsed structured output (schema present) or the full text
	text: string;
}

export interface SubagentOpts {
	agent: string;
	task: string;
	context?: "fresh" | "fork";
	model?: string;
	cwd?: string;
	outputSchema?: JsonSchema;
}
export interface SubagentResult {
	text: string;
	details?: unknown;
}

/** One independently configured child in a parallel subagent fan-out. */
export interface FanoutTask {
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
	outputSchema?: JsonSchema;
}

/** A single deterministic workflow step backed by pi-subagents parallel mode. */
export interface FanoutOpts {
	tasks: FanoutTask[];
	context?: "fresh" | "fork";
	concurrency?: number;
	cwd?: string;
	worktree?: boolean;
}

/** Stable, input-ordered result for a child in a fan-out. */
export interface FanoutChildResult extends SubagentResult {
	index: number;
	agent: string;
	task: string;
	status: "complete" | "failed" | "stopped" | "paused" | "unknown";
	ok: boolean;
}

export interface FanoutResult {
	/** Human-readable aggregate retained for convenient logging and prompts. */
	text: string;
	/** Results remain in input order, including repeated agent roles. */
	results: FanoutChildResult[];
	runId?: string;
}

export interface ExecOpts {
	cmd: string;
	cwd?: string;
}
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

// ---- Drivers ----
export interface PromptDriver {
	run(opts: PromptOpts): Promise<PromptResult>;
}

export interface SubagentDriver {
	run(opts: SubagentOpts): Promise<SubagentResult>;
	fanout(opts: FanoutOpts): Promise<FanoutResult>;
}

export interface ExecDriver {
	run(opts: ExecOpts): Promise<ExecResult>;
}

/** Driver bundle: one set of implementations for the current environment. */
export interface AdapterDrivers {
	prompt: PromptDriver;
	subagent: SubagentDriver;
	exec: ExecDriver;
}
