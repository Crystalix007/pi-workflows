import { LuaFactory } from "wasmoon";

/**
 * pi-workflows Lua runtime — one wasmoon VM per workflow run.
 *
 * Runs workflow source on a fresh coroutine with a PER-RESUME CPU-slice
 * budget: each uninterrupted compute slice is bounded (instruction-count hook),
 * but time spent awaiting a primitive's Promise (e.g. a slow model call) does
 * NOT consume the budget, because the hook deadline is reset before every
 * resume. Tight loops are capped; legit slow awaits are not.
 *
 * Primitives are plain JS globals (functions returning Promises); Lua awaits
 * them via wasmoon's `:await()`, which yields the coroutine back to run().
 */

export class WorkflowError extends Error {
	readonly cause?: unknown;
	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "WorkflowError";
		this.cause = cause;
	}
}

type LuaEngine = Awaited<ReturnType<LuaFactory["createEngine"]>>;
type LuaThread = ReturnType<LuaEngine["global"]["newThread"]>;

const LUA_YIELD = 1;
const LUA_MASKCOUNT = 8; // lua hook mask: count (fire every N instructions)
const INSTRUCTION_HOOK_COUNT = 1000;

export interface RuntimeOptions {
	/** Per-resume Lua CPU budget in ms (default 1000). */
	cpuSliceMs?: number;
	/** Hard wall-clock cap on a single run in ms (default 300000). */
	totalTimeoutMs?: number;
	/** Open Lua standard libraries (default true). */
	openStandardLibs?: boolean;
}

interface CpuHook {
	setDeadline(sliceMs: number): void;
	dispose(): void;
}

/** Install a count hook whose deadline is mutable (reset per resume). */
function installCpuHook(thread: LuaThread): CpuHook {
	// Low-level wasmoon glue; typed loosely to avoid friction with the C bindings.
	const lua = (thread as unknown as { lua: any }).lua;
	let deadline = Infinity;
	const ptr = lua.module.addFunction(() => {
		if (Date.now() > deadline) {
			thread.pushValue(new WorkflowError("cpu-slice budget exceeded"));
			lua.lua_error(thread.address);
		}
	}, "vii");
	lua.lua_sethook(thread.address, ptr, LUA_MASKCOUNT, INSTRUCTION_HOOK_COUNT);
	return {
		setDeadline: (ms: number) => {
			deadline = Date.now() + ms;
		},
		dispose: () => {
			try {
				lua.module.removeFunction(ptr);
			} catch {
				/* noop */
			}
		},
	};
}

/** Convert a wasmoon-returned value to a plain JSON-safe JS value. */
export function toPlainValue(value: unknown): unknown {
	try {
		return JSON.parse(
			JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
		);
	} catch {
		return value; // non-serializable (e.g. function) — return as-is
	}
}

export class LuaRuntime {
	private readonly engine: LuaEngine;
	private readonly cpuSliceMs: number;
	private readonly totalTimeoutMs: number;
	private disposed = false;

	constructor(engine: LuaEngine, cpuSliceMs: number, totalTimeoutMs: number) {
		this.engine = engine;
		this.cpuSliceMs = cpuSliceMs;
		this.totalTimeoutMs = totalTimeoutMs;
	}

	static async create(
		primitives: Record<string, unknown> = {},
		opts: RuntimeOptions = {},
	): Promise<LuaRuntime> {
		const engine = await new LuaFactory().createEngine({
			openStandardLibs: opts.openStandardLibs ?? true,
			injectObjects: true,
			enableProxy: true,
		});
		const rt = new LuaRuntime(
			engine,
			opts.cpuSliceMs ?? 1000,
			opts.totalTimeoutMs ?? 300_000,
		);
		rt.inject(primitives);
		return rt;
	}

	/** Set Lua globals (primitives, helpers). */
	inject(globals: Record<string, unknown>): void {
		for (const [k, v] of Object.entries(globals)) this.engine.global.set(k, v);
	}

	/** Run Lua source on a fresh coroutine with per-resume CPU-slice budgeting. */
	async run(code: string): Promise<unknown[]> {
		const thread = this.engine.global.newThread();
		thread.loadString(code);
		const hook = installCpuHook(thread);
		const start = Date.now();
		try {
			hook.setDeadline(this.cpuSliceMs);
			let res = thread.resume(0);
			for (;;) {
				if (Date.now() - start > this.totalTimeoutMs) {
					throw new WorkflowError("workflow total timeout exceeded");
				}
				if (res.result === LUA_YIELD) {
					if (res.resultCount > 0) {
						const last: unknown = thread.getValue(-1);
						thread.pop(res.resultCount);
						if (
							last &&
							typeof (last as { then?: unknown }).then === "function"
						) {
							await (last as Promise<unknown>);
						}
					}
					hook.setDeadline(this.cpuSliceMs); // reset budget for the next compute slice
					res = thread.resume(0);
				} else {
					thread.assertOk(res.result);
					const stack = Array.from(
						thread.getStackValues() as ArrayLike<unknown>,
					);
					return stack.map(toPlainValue);
				}
			}
		} catch (e) {
			if (e instanceof WorkflowError) throw e;
			throw new WorkflowError(e instanceof Error ? e.message : String(e), e);
		} finally {
			hook.dispose();
			try {
				thread.close();
			} catch {
				/* noop */
			}
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.engine.global.close();
		} catch {
			/* noop */
		}
	}
}
