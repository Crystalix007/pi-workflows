// Phase 1 gate test — validate the Lua runtime with an injected `exec` primitive.
// Runs pure exec-only workflows with loops, branches, error handling, and a
// runaway-loop cap. Must pass all checks before Phase 1 is declared done.
// Run: node --experimental-strip-types spikes/runtime-gate.ts
import { LuaRuntime } from "../src/lua/runtime.ts";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execSh = promisify(execCb);

// exec primitive: run a shell command, return trimmed stdout.
const exec = (cmd: string) =>
	execSh(cmd, { encoding: "utf8" }).then((r) => r.stdout.trimEnd());

const runtime = await LuaRuntime.create(
	{ exec },
	{ cpuSliceMs: 300, totalTimeoutMs: 15000 },
);

const fail: string[] = [];
let passed = 0;

function check(name: string, cond: boolean, detail = "") {
	if (cond) {
		passed++;
		console.log(`✓ ${name}${detail ? " — " + detail : ""}`);
	} else {
		fail.push(name);
		console.log(`✗ ${name}${detail ? " — " + detail : ""}`);
	}
}

// ----- Test 1: loop + exec with guaranteed ordering -----
const out = await runtime.run(`
  local parts = {}
  for i = 1, 3 do
    local s = exec("echo step" .. i):await()
    parts[#parts + 1] = s
  end
  return table.concat(parts, ", ")
`);
check("loop+exec ordering", out[0] === "step1, step2, step3", String(out[0]));

// ----- Test 2: while loop with condition -----
const out2 = await runtime.run(`
  local i, sum = 1, 0
  while i <= 5 do
    local v = tonumber(exec("echo " .. i * 2):await()) or 0
    sum = sum + v
    i = i + 1
  end
  return sum
`);
check("while loop + exec sum", out2[0] === 30, String(out2[0])); // 2+4+6+8+10

// ----- Test 3: branch (if/else) on exec value -----
const out3 = await runtime.run(`
  local n = tonumber(exec("echo 7"):await()) or 0
  if n > 5 then return "big" else return "small" end
`);
check("branch on exec value", out3[0] === "big", String(out3[0]));

// ----- Test 4: Lua error marshalled to WorkflowError -----
try {
	await runtime.run(`error("boom from lua")`);
	fail.push("lua error marshal");
	console.log("✗ lua error marshal — no throw");
} catch (e: any) {
	check("lua error marshalled", /boom/.test(e.message), e.message);
}

// ----- Test 5: runaway loop capped by CPU-slice budget -----
try {
	await runtime.run(`while true do end`);
	fail.push("runaway cap");
	console.log("✗ runaway loop — NOT capped");
} catch (e: any) {
	check("runaway loop capped", /cpu-slice|timeout/i.test(e.message), e.message);
}

// ----- Test 6: multiple return values -----
const out6 = await runtime.run(`
  return 1, 2, "three"
`);
check(
	"multi-return values",
	out6[0] === 1 && out6[1] === 2 && out6[2] === "three",
	JSON.stringify(out6),
);

await runtime.dispose();

console.log(`\n${passed} passed, ${fail.length} failed`);
if (fail.length > 0) process.exit(1);
