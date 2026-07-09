/**
 * Workflow execution policy — retry, budgets, depth guard, halt report.
 * Applied as a thin wrapper around each primitive call inside the adapter.
 */

import type { WorkflowLogger } from "./logging.ts";

// ---- config ----
export interface PolicyConfig {
	/** Maximum retries per primitive call (default 1). */
	maxRetries: number;
	/** Global turn budget (placeholder — enforced later). */
	maxTurns?: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
	maxRetries: 1,
};

// ---- halt report ----
export class WorkflowHaltError extends Error {
	constructor(
		message: string,
		readonly step: string,
		readonly stepIndex: number,
		readonly originalError?: unknown,
		readonly partialResults?: unknown[],
	) {
		super(message);
		this.name = "WorkflowHaltError";
	}
}

// ---- retry wrapper ----
export interface PolicyContext {
	stepIndex: number;
	logger: WorkflowLogger;
	policy: PolicyConfig;
}

/**
 * Wraps a primitive so that failures are retried and logged, and a
 * WorkflowHaltError is thrown when retries are exhausted.
 */
export function withPolicy(
	name: string,
	fn: (...args: any[]) => Promise<any>,
	ctx: PolicyContext,
): (...args: any[]) => Promise<any> {
	return async (...args: unknown[]): Promise<unknown> => {
		const t0 = Date.now();
		let lastError: unknown;
		for (let attempt = 0; attempt <= ctx.policy.maxRetries; attempt++) {
			ctx.stepIndex++;
			try {
				const result = await fn(...args);
				ctx.logger.step({
					primitive: name,
					args,
					result,
					durationMs: Date.now() - t0,
				});
				return result;
			} catch (e) {
				lastError = e;
				if (attempt < ctx.policy.maxRetries) {
					ctx.logger.step({
						primitive: name,
						args,
						error:
							lastError instanceof Error
								? lastError.message
								: String(lastError),
						durationMs: Date.now() - t0,
						// retry will log again on next attempt; the final one is the definitive record
					});
				}
			}
		}
		// all retries exhausted
		const msg =
			lastError instanceof Error ? lastError.message : String(lastError);
		ctx.logger.step({
			primitive: name,
			args,
			error: msg,
			durationMs: Date.now() - t0,
		});
		throw new WorkflowHaltError(
			`Workflow halted: ${name} failed after ${ctx.policy.maxRetries + 1} attempt(s): ${msg}`,
			name,
			ctx.stepIndex,
			lastError,
		);
	};
}
