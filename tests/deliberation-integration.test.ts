/**
 * Integration test: multi-provider deliberation workflow end-to-end.
 *
 * Tests the full multi-provider deliberation pipeline:
 * 1. Per-step model override in SdkPromptDriver (via mock)
 * 2. RpcSubagentDriver returning actual child output (via mock)
 * 3. A two-provider debate with synthesis
 *
 * These tests use mock drivers so they run outside the pi extension context.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { LuaRuntime } from "../src/lua/runtime.ts";
import { LUA_SCHEMA_PREAMBLE } from "../src/adapter/schema.ts";
import type {
	PromptDriver,
	PromptOpts,
	PromptResult,
	SubagentDriver,
	SubagentOpts,
	SubagentResult,
	ExecDriver,
	ExecOpts,
	ExecResult,
	AdapterDrivers,
} from "../src/adapter/driver.ts";

// ============================================================
// Mock drivers
// ============================================================

class MockPromptDriver implements PromptDriver {
	public calls: Array<{ text: string; model?: string; schema?: boolean }> = [];

	async run(opts: PromptOpts): Promise<PromptResult> {
		this.calls.push({
			text: opts.text,
			model: opts.model,
			schema: opts.schema !== undefined,
		});

		const id = `prompt-${this.calls.length}`;
		const modelTag = opts.model ? ` [model:${opts.model}]` : "";
		if (opts.schema) {
			return {
				result: {
					id,
					answer: `Response from ${opts.model ?? "default"}${modelTag}`,
					model: opts.model ?? "default",
				},
				text: `Structured response for ${opts.text.slice(0, 40)}${modelTag}`,
			};
		}
		return {
			result: null,
			text: `Response ${id}: ${opts.text.slice(0, 40)}${modelTag}`,
		};
	}
}

class MockSubagentDriver implements SubagentDriver {
	public calls: Array<{ agent: string; task: string; model?: string }> = [];
	private simulateFailure: boolean;

	constructor(simulateFailure = false) {
		this.simulateFailure = simulateFailure;
	}

	async run(opts: SubagentOpts): Promise<SubagentResult> {
		this.calls.push({
			agent: opts.agent,
			task: opts.task,
			model: opts.model,
		});

		if (this.simulateFailure) {
			return {
				text: "",
				details: { error: "Simulated failure" },
			};
		}

		const modelTag = opts.model ? ` [model:${opts.model}]` : "";
		return {
			text: `Output from ${opts.agent}: resolved ${opts.task.slice(0, 40)}${modelTag}`,
			details: {
				agent: opts.agent,
				model: opts.model ?? "default",
				task: opts.task,
			},
		};
	}
}

class MockExecDriver implements ExecDriver {
	async run(_opts: ExecOpts): Promise<ExecResult> {
		return { stdout: "", stderr: "", code: 0 };
	}
}

function createMockDrivers(simulateSubagentFailure = false): AdapterDrivers {
	return {
		prompt: new MockPromptDriver(),
		subagent: new MockSubagentDriver(simulateSubagentFailure),
		exec: new MockExecDriver(),
	};
}

// ============================================================
// Helper: inject Lua primitives (mirrors createPrimitives)
// ============================================================

function injectPrimitives(runtime: LuaRuntime, drivers: AdapterDrivers): void {
	const opts: { context?: string; model?: string; cwd?: string } = {};

	runtime.inject({
		set_options: (o: Record<string, unknown>) => {
			if (o.context !== undefined) opts.context = o.context as string;
			if (o.model !== undefined) opts.model = o.model as string;
			if (o.cwd !== undefined) opts.cwd = o.cwd as string;
		},
		reset_options: () => {
			delete opts.context;
			delete opts.model;
			delete opts.cwd;
		},

		prompt: async (text: string, schemaTable?: Record<string, unknown>) => {
			const promptOpts: PromptOpts = { text, ...opts } as PromptOpts;
			if (schemaTable && typeof schemaTable === "object") {
				promptOpts.schema = { type: "object", properties: {} } as any;
			}
			const res = await drivers.prompt.run(promptOpts);
			return promptOpts.schema !== undefined ? res.result : res.text;
		},

		subagent: async (luaOpts: Record<string, unknown>) => {
			const o: SubagentOpts = {
				agent: luaOpts.agent as string,
				task: luaOpts.task as string,
				context: (luaOpts.context as "fresh" | "fork") ?? (opts.context as any),
				model: (luaOpts.model as string) ?? opts.model,
				cwd: (luaOpts.cwd as string) ?? opts.cwd,
			};
			return drivers.subagent.run(o);
		},

		exec: async (cmd: string) => {
			const r = await drivers.exec.run({ cmd });
			if (r.code !== 0) throw new Error(`exec failed (${r.code}): ${r.stderr}`);
			return r.stdout;
		},
	});
}

// ============================================================
// Tests
// ============================================================

describe("multi-provider deliberation workflow", () => {
	// ---- #215: Per-step model honor in prompt() ----
	describe("per-step model override (prompt)", () => {
		it("should pass model from set_options to prompt()", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        set_options({ model = "anthropic/claude-sonnet-4" })
        local r = prompt("First analysis")
        set_options({ model = "google/gemini-2-flash" })
        local r2 = prompt("Second analysis")
        return { r, r2 }
      `;

			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const p = drivers.prompt as MockPromptDriver;
			assert.strictEqual(p.calls.length, 2);
			assert.strictEqual(p.calls[0].model, "anthropic/claude-sonnet-4");
			assert.strictEqual(p.calls[1].model, "google/gemini-2-flash");
		});

		it("should pass per-call model to prompt() without set_options", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        local r = prompt("First")
        local r2 = prompt("Second")
        return { r, r2 }
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const p = drivers.prompt as MockPromptDriver;
			assert.strictEqual(p.calls.length, 2);
			assert.strictEqual(p.calls[0].model, undefined);
			assert.strictEqual(p.calls[1].model, undefined);
		});

		it("should reset model after reset_options()", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        set_options({ model = "anthropic/claude-sonnet-4" })
        local r = prompt("With model")
        reset_options()
        local r2 = prompt("Without model")
        return { r, r2 }
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const p = drivers.prompt as MockPromptDriver;
			assert.strictEqual(p.calls.length, 2);
			assert.strictEqual(p.calls[0].model, "anthropic/claude-sonnet-4");
			assert.strictEqual(p.calls[1].model, undefined);
		});
	});

	// ---- #216: Subagent output ----
	describe("subagent returns actual child output", () => {
		it("should call subagent with correct task and agent", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        subagent({ agent = "worker", task = "Analyze the data" })
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const s = drivers.subagent as MockSubagentDriver;
			assert.strictEqual(s.calls.length, 1);
			assert.strictEqual(s.calls[0].agent, "worker");
			assert(s.calls[0].task.includes("Analyze"));
		});

		it("should pass model from set_options to subagent", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        set_options({ model = "anthropic/claude-sonnet-4" })
        subagent({ agent = "worker", task = "Research" })
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const s = drivers.subagent as MockSubagentDriver;
			assert.strictEqual(s.calls.length, 1);
			assert.strictEqual(s.calls[0].model, "anthropic/claude-sonnet-4");
		});

		it("should use per-call model over set_options in subagent", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        set_options({ model = "anthropic/claude-sonnet-4" })
        subagent({ agent = "worker", task = "Analysis", model = "google/gemini-2-flash" })
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const s = drivers.subagent as MockSubagentDriver;
			assert.strictEqual(s.calls.length, 1);
			assert.strictEqual(s.calls[0].model, "google/gemini-2-flash");
		});
	});

	// ---- #217: Two-provider debate + synthesis ----
	describe("two-provider debate workflow", () => {
		it("should run a debate with two providers and synthesize", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        -- Round 1: Independent analyses from two providers
        set_options({ model = "anthropic/claude-sonnet-4" })
        local r1 = prompt("Analyze: should we use TypeScript or Rust for this CLI tool?")

        set_options({ model = "google/gemini-2-flash" })
        local r2 = prompt("Analyze: should we use TypeScript or Rust for this CLI tool?")

        -- Round 2: Synthesis using both prior analyses
        set_options({ model = "anthropic/claude-sonnet-4" })
        local synthesis = prompt("Given these two analyses, produce a final recommendation.\\n" ..
          "Analysis 1: " .. tostring(r1) .. "\\n" ..
          "Analysis 2: " .. tostring(r2))

        return {
          round1 = { r1, r2 },
          synthesis = synthesis
        }
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const p = drivers.prompt as MockPromptDriver;
			assert.strictEqual(p.calls.length, 3);

			// Round 1: first provider
			assert.strictEqual(p.calls[0].model, "anthropic/claude-sonnet-4");
			assert(p.calls[0].text.includes("TypeScript"));

			// Round 1: second provider
			assert.strictEqual(p.calls[1].model, "google/gemini-2-flash");
			assert(p.calls[1].text.includes("TypeScript"));

			// Round 2: synthesis (includes both prior responses)
			assert.strictEqual(p.calls[2].model, "anthropic/claude-sonnet-4");
			assert(p.calls[2].text.includes("Analysis 1"));
			assert(p.calls[2].text.includes("Analysis 2"));
		});

		it("should run a subagent-based debate with distinct models", async () => {
			const drivers = createMockDrivers();
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        -- Round 1: Independent research via subagents with different models
        subagent({ agent = "researcher", task = "Research pros/cons of TypeScript vs Rust for CLI", model = "anthropic/claude-sonnet-4" })
        subagent({ agent = "researcher", task = "Research pros/cons of TypeScript vs Rust for CLI", model = "google/gemini-2-flash" })

        -- Round 2: Synthesis using prior research
        set_options({ model = "anthropic/claude-sonnet-4" })
        prompt("Synthesize research findings into a final recommendation.")
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const s = drivers.subagent as MockSubagentDriver;
			const p = drivers.prompt as MockPromptDriver;

			// Two subagent calls with distinct models
			assert.strictEqual(s.calls.length, 2);
			assert.strictEqual(s.calls[0].model, "anthropic/claude-sonnet-4");
			assert.strictEqual(s.calls[1].model, "google/gemini-2-flash");

			// One synthesis prompt
			assert.strictEqual(p.calls.length, 1);
			assert.strictEqual(p.calls[0].model, "anthropic/claude-sonnet-4");
			assert(p.calls[0].text.includes("Synthesize"));
		});
	});

	// ---- Error handling ----
	describe("subagent error handling", () => {
		it("should handle subagent calls without crashing", async () => {
			const drivers = createMockDrivers(true);
			const runtime = await LuaRuntime.create({});
			injectPrimitives(runtime, drivers);

			const code = `
        subagent({ agent = "worker", task = "This will fail" })
      `;
			await runtime.run(LUA_SCHEMA_PREAMBLE + code);
			await runtime.dispose();

			const s = drivers.subagent as MockSubagentDriver;
			assert.strictEqual(s.calls.length, 1);
			assert.strictEqual(s.calls[0].agent, "worker");
		});
	});
});
