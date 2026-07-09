// Phase 2 gate test — validate the adapter primitives (prompt, subagent, exec)
// with mock drivers, running on the Lua runtime.  No model calls.
// Run: node --experimental-strip-types spikes/adapter-gate.ts
import { LuaRuntime } from "../src/lua/runtime.ts";
import {
	createPrimitives,
	LUA_SCHEMA_PREAMBLE,
} from "../src/adapter/index.ts";
import type {
	AdapterDrivers,
	PromptDriver,
	SubagentDriver,
	ExecDriver,
} from "../src/adapter/driver.ts";

// ---- mock drivers (no model calls) ----
const mockPrompt: PromptDriver = {
	async run(opts) {
		if (opts.schema) {
			// Return a canned structured result that looks like the expected schema.
			const result: Record<string, unknown> = {};
			const props = opts.schema.properties ?? {};
			for (const k of Object.keys(props)) {
				const pt = props[k]?.type;
				if (pt === "boolean") result[k] = true;
				else if (pt === "number") result[k] = 42;
				else result[k] = `mock-${k}`;
			}
			return { result, text: JSON.stringify(result) };
		}
		return { result: "mock thinking done", text: "mock thinking done" };
	},
};

const mockSubagent: SubagentDriver = {
	async run(opts) {
		return {
			text: `mock-subagent[${opts.agent}]: ${opts.task}`,
			details: { agent: opts.agent },
		};
	},
};

const mockExec: ExecDriver = {
	async run(opts) {
		return {
			stdout: `echo:${opts.cmd}`,
			stderr: "",
			code: 0,
		};
	},
};

const drivers: AdapterDrivers = { prompt: mockPrompt, subagent: mockSubagent, exec: mockExec };
const primitives = createPrimitives(drivers);

const runtime = await LuaRuntime.create(primitives, { cpuSliceMs: 300, totalTimeoutMs: 15000 });

const fail: string[] = [];
let passed = 0;
function check(name: string, cond: boolean, detail = "") {
	if (cond) { passed++; console.log(`✓ ${name}${detail ? " — " + detail : ""}`); }
	else { fail.push(name); console.log(`✗ ${name}${detail ? " — " + detail : ""}`); }
}

const P = LUA_SCHEMA_PREAMBLE;

// ---- Test 1: prompt with schema returns structured output ----
const [r1] = await runtime.run(P + `return prompt("decide", schema{ correct = bool, reasoning = str }):await()`);
check("prompt+structured-output returns parsed object", !!r1 && (r1 as any).correct === true && (r1 as any).reasoning === "mock-reasoning",
	JSON.stringify(r1));

// ---- Test 2: prompt without schema returns text ----
const [r2] = await runtime.run(P + `return prompt("hello"):await()`);
check("prompt text-only", r2 === "mock thinking done", String(r2));

// ---- Test 3: subagent returns text + details ----
const [r3] = await runtime.run(P + `return subagent{ agent="worker", task="fix bug #42" }:await()`);
check("subagent text", (r3 as any)?.text === "mock-subagent[worker]: fix bug #42", JSON.stringify(r3));

// ---- Test 4: subagent with explicit context ----
const [r4] = await runtime.run(P + `return subagent{ agent="reviewer", task="review diff", context="fresh" }:await()`);
check("subagent explicit context", (r4 as any)?.text?.startsWith("mock-subagent[reviewer]"), JSON.stringify(r4));

// ---- Test 5: exec returns stdout ----
const [r5] = await runtime.run(P + `return exec("ls -la"):await()`);
check("exec stdout", r5 === "echo:ls -la", String(r5));

// ---- Test 6: loop + prompt + branching ----
const [r6] = await runtime.run(P + `
  local total = 0
  for i = 1, 3 do
    local s = exec("echo step"..i):await()
    if #s > 0 then total = total + 1 end
  end
  local verdict = prompt("is it done?", schema{complete=bool}):await()
  if verdict.complete then total = total + 10 end
  return total
`);
check("loop+branch+exec+prompt composition", r6 === 13, String(r6));

// ---- Test 7: runaway loop still capped ----
let capped = false;
try {
	await runtime.run(`while true do end`);
} catch (e: any) {
	capped = /cpu-slice/i.test(e.message || "");
}
check("runaway loop capped", capped);

// ---- Test 8: set_options + reset_options ----
const [r8] = await runtime.run(P + `
  set_options{context="fresh"}
  local r = prompt("test", schema{ok=bool}):await()
  reset_options()
  return r.ok
`);
check("set_options/reset_options", r8 === true, String(r8));

await runtime.dispose();
console.log(`\n${passed} passed, ${fail.length} failed`);
if (fail.length > 0) process.exit(1);
