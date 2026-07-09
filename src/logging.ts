/**
 * Minimal workflow-step logger.
 *
 * In the real extension this writes into the parent pi session.  For standalone
 * tests (mock gate) the no-op implementation is used.
 */
export interface StepRecord {
	primitive: string; // "prompt" | "subagent" | "exec" | "workflow"
	args: unknown; // snapshot of arguments (sanitised)
	result?: unknown; // omitted on error
	error?: string;
	durationMs: number;
	context?: string; // "continue" | "fork" | "fresh" | undefined
}

export interface WorkflowLogger {
	/** Called once when the workflow starts. */
	runStart(workflowRef: string): void;
	/** Called after each primitive step completes or fails. */
	step(record: StepRecord): void;
	/** Called once when the workflow finishes (success or halt). */
	runEnd(error?: string): void;
}

/** No-op logger for standalone / mock tests. */
export class NoopLogger implements WorkflowLogger {
	runStart(_ref: string): void {}
	step(_r: StepRecord): void {}
	runEnd(_error?: string): void {}
}

/** In-memory logger that collects records (useful for tests). */
export class InMemoryLogger implements WorkflowLogger {
	records: StepRecord[] = [];
	workflowRef = "";
	finalError?: string;

	runStart(ref: string): void {
		this.workflowRef = ref;
		this.records = [];
	}
	step(r: StepRecord): void {
		this.records.push(r);
	}
	runEnd(error?: string): void {
		this.finalError = error;
	}
}
