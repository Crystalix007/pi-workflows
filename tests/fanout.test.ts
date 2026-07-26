import assert from "node:assert";
import { describe, it } from "node:test";
import { createPrimitives, LUA_SCHEMA_PREAMBLE } from "../src/adapter/index.ts";
import type {
	AdapterDrivers,
	ExecDriver,
	ExecOpts,
	ExecResult,
	FanoutOpts,
	FanoutResult,
	PromptDriver,
	PromptOpts,
	PromptResult,
	SubagentDriver,
	SubagentOpts,
	SubagentResult,
} from "../src/adapter/driver.ts";
import { LuaRuntime } from "../src/lua/runtime.ts";

class PromptSpy implements PromptDriver {
	calls: PromptOpts[] = [];

	async run(opts: PromptOpts): Promise<PromptResult> {
		this.calls.push(opts);
		return { result: null, text: "synthesized" };
	}
}

class FanoutSpy implements SubagentDriver {
	calls: FanoutOpts[] = [];
	fail = false;

	async run(_opts: SubagentOpts): Promise<SubagentResult> {
		return { text: "single" };
	}

	async fanout(opts: FanoutOpts): Promise<FanoutResult> {
		this.calls.push(opts);
		if (this.fail) throw new Error("launch failed");
		return {
			text: opts.tasks.map((task) => task.agent).join(", "),
			results: opts.tasks.map((task, index) => ({
				index,
				agent: task.agent,
				task: task.task,
				text: `result-${index + 1}`,
				status: "complete" as const,
				ok: true,
				details: { index },
			})),
		};
	}
}

class NoopExec implements ExecDriver {
	async run(_opts: ExecOpts): Promise<ExecResult> {
		return { stdout: "", stderr: "", code: 0 };
	}
}

function drivers(): {
	drivers: AdapterDrivers;
	prompt: PromptSpy;
	fanout: FanoutSpy;
} {
	const prompt = new PromptSpy();
	const fanout = new FanoutSpy();
	return {
		drivers: { prompt, subagent: fanout, exec: new NoopExec() },
		prompt,
		fanout,
	};
}

describe("Lua fanout primitive", () => {
	it("delegates one ordered parallel group with inherited and per-task options", async () => {
		const spies = drivers();
		const runtime = await LuaRuntime.create(createPrimitives(spies.drivers));
		try {
			await runtime.run(
				LUA_SCHEMA_PREAMBLE +
					`
				set_options{ model = "provider/default", cwd = "/repo" }
				local results = fanout{
					context = "fresh",
					concurrency = 2,
					tasks = {
						{ agent = "reviewer", task = "review", outputSchema = schema{ verdict = str } },
						{ agent = "reviewer", task = "test", model = "provider/override", cwd = "/other" },
					},
				}:await()
				return prompt("ordered: " .. results.results[1].text .. ", " .. results.results[2].text):await()
			`,
			);
		} finally {
			await runtime.dispose();
		}

		assert.strictEqual(spies.fanout.calls.length, 1);
		const [call] = spies.fanout.calls;
		assert.strictEqual(call.context, "fresh");
		assert.strictEqual(call.concurrency, 2);
		assert.strictEqual(call.tasks.length, 2);
		assert.deepStrictEqual(
			call.tasks.map((task) => task.model),
			["provider/default", "provider/override"],
		);
		assert.deepStrictEqual(
			call.tasks.map((task) => task.cwd),
			["/repo", "/other"],
		);
		assert.strictEqual(
			call.tasks[0].outputSchema?.properties?.verdict?.type,
			"string",
		);
		assert.match(spies.prompt.calls[0].text, /ordered: result-1, result-2/);
	});

	it("rejects malformed groups before the driver is invoked", async () => {
		const spies = drivers();
		const runtime = await LuaRuntime.create(createPrimitives(spies.drivers));
		try {
			await assert.rejects(
				runtime.run(`return fanout{ tasks = {} }:await()`),
				/fanout requires a non-empty tasks array/,
			);
		} finally {
			await runtime.dispose();
		}
		assert.strictEqual(spies.fanout.calls.length, 0);
	});

	it("does not retry a launched fanout", async () => {
		const spies = drivers();
		spies.fanout.fail = true;
		const runtime = await LuaRuntime.create(
			createPrimitives(spies.drivers, {
				policy: { maxRetries: 3 },
			}),
		);
		try {
			await assert.rejects(
				runtime.run(
					`return fanout{ tasks = {{ agent = "worker", task = "write" }} }:await()`,
				),
				/failed after 1 attempt/,
			);
		} finally {
			await runtime.dispose();
		}
		assert.strictEqual(spies.fanout.calls.length, 1);
	});
});
