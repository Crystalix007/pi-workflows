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
