// Phase 1.3 spike — custom resume-loop scheduler with a PER-RESUME CPU-slice
// budget, using our OWN instruction-count hook with a mutable deadline.
//
// Why not wasmoon's thread.setTimeout: its hook closure captures the FIRST
// deadline arg, so repeated calls don't actually move the deadline (confirmed
// in source). We install a count hook whose closure reads a mutable `deadline`,
// and reset that deadline before each resume — so slow awaits don't consume the
// CPU budget but tight loops are still capped.
import { LuaFactory } from "wasmoon";

const lua = await new LuaFactory().createEngine({
  openStandardLibs: true,
  injectObjects: true,
  enableProxy: true,
});

lua.global.set("slow", (ms, val) => new Promise((r) => setTimeout(() => r(val), ms)));

const YIELD = 1;
const LUA_MASKCOUNT = 8;
const INSTRUCTION_HOOK_COUNT = 1000;

function installCpuHook(thread) {
  let deadline = Infinity;
  const ptr = thread.lua.module.addFunction(() => {
    if (Date.now() > deadline) {
      thread.pushValue(new Error("cpu-slice budget exceeded"));
      thread.lua.lua_error(thread.address);
    }
  }, "vii");
  thread.lua.lua_sethook(thread.address, ptr, LUA_MASKCOUNT, INSTRUCTION_HOOK_COUNT);
  return {
    setDeadline: (ms) => {
      deadline = Date.now() + ms;
    },
    dispose: () => {
      try {
        thread.lua.module.removeFunction(ptr);
      } catch {
        /* noop */
      }
    },
  };
}

async function runWithSliceBudget(code, sliceMs, totalMs) {
  const thread = lua.global.newThread();
  thread.loadString(code);
  const hook = installCpuHook(thread);
  const start = Date.now();
  try {
    hook.setDeadline(sliceMs);
    let res = thread.resume(0);
    for (;;) {
      if (Date.now() - start > totalMs) throw new Error("total timeout exceeded");
      if (res.result === YIELD) {
        if (res.resultCount > 0) {
          const last = thread.getValue(-1);
          thread.pop(res.resultCount);
          if (last && typeof last.then === "function") await last;
        }
        hook.setDeadline(sliceMs); // reset CPU budget for the next compute slice
        res = thread.resume(0);
      } else {
        thread.assertOk(res.result);
        return thread.getStackValues();
      }
    }
  } finally {
    hook.dispose();
  }
}

const log = (n, m) => console.log(`[${n}] ${m}`);

// Test A: a 500ms await under a 200ms CPU-slice budget must succeed (await time
// is not counted against the CPU budget thanks to per-resume reset).
let t0 = Date.now();
try {
  const r = await runWithSliceBudget(
    `local x = slow(500, "ok"):await()
     local s = 0; for i = 1, 1000 do s = s + i end
     return x .. ":" .. s`,
    200,
    10000,
  );
  log("A", `slow-await OK in ${Date.now() - t0}ms -> ${r[0]}`);
} catch (e) {
  log("A", `FAIL after ${Date.now() - t0}ms: ${e.message}`);
}

// Test B: a tight pure-compute loop must be capped by the 200ms slice budget.
t0 = Date.now();
try {
  await runWithSliceBudget(`while true do end`, 200, 10000);
  log("B", `FAIL: tight loop was NOT capped`);
} catch (e) {
  const ok = /slice|timeout/i.test(e.message);
  log("B", `tight loop ${ok ? "capped ✓" : "errored oddly"} after ${Date.now() - t0}ms: ${e.message}`);
}

await lua.global.close();
console.log("\nscheduler spike done");
