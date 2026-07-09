// Spike 0.2 — validate wasmoon capabilities pi-workflows depends on.
// CORRECTION: run code via thread.run({timeout}) (count-hook bounded), NOT
// engine.doString (unbounded for top-level loops). run() also drives the
// yield/resume loop that :await() depends on.
import { LuaFactory } from "wasmoon";

const log = (n, label) => console.log(`\n[${n}] ${label}`);

const lua = await new LuaFactory().createEngine({
	openStandardLibs: true,
	injectObjects: true,
	enableProxy: true,
});

// Run Lua on a fresh coroutine thread, bounded by wasmoon's instruction-count
// hook (fires every 1000 instructions; checks the deadline).
async function run(code, { timeout = 5000 } = {}) {
	const thread = lua.global.newThread();
	thread.loadString(code);
	return await thread.run(0, { timeout }); // MultiReturn (array-like)
}

try {
	log(1, "table round-trip (enableProxy -> plain JS)");
	const tbl = (
		await run(
			`return { reasoning = "ok", complete = true, items = { 10, 20, 30 } }`,
		)
	)[0];
	console.log(
		"  ->",
		JSON.stringify(tbl),
		"| complete:",
		tbl.complete,
		`(${typeof tbl.complete})`,
	);

	log(2, "JS function called from Lua");
	lua.global.set("add", (x, y) => x + y);
	console.log("  -> add(3,4) =", (await run(`return add(3, 4)`))[0]);

	log(
		3,
		"await JS Promise from Lua via :await()  (exercises run() yield/resume)",
	);
	lua.global.set(
		"asyncStep",
		(label, ms) =>
			new Promise((resolve) => setTimeout(() => resolve(`[${label}]`), ms)),
	);
	console.log(
		"  ->",
		(
			await run(`
      local a = asyncStep("first", 30):await()
      local b = asyncStep("second", 10):await()
      return a .. " then " .. b
    `)
		)[0],
	);

	log(4, "Lua error -> rejected promise");
	try {
		await run(`error("boom from lua")`);
		console.log("  -> ERROR: no throw");
	} catch (e) {
		console.log("  -> caught:", String(e.message || e).slice(0, 50));
	}

	log(5, "tight loop capped by run({timeout}) — must NOT freeze");
	const t0 = Date.now();
	try {
		await run(`while true do end`, { timeout: 150 });
		console.log("  -> ERROR: loop was NOT capped");
	} catch (e) {
		const dt = Date.now() - t0;
		const isTimeout = /timeout/i.test(String(e?.message || e));
		console.log(
			`  -> capped after ${dt}ms; timeout-like=${isTimeout}: ${String(e?.message || e).slice(0, 50)}`,
		);
	}
} finally {
	lua.global.close();
}

console.log("\nwasmoon spike OK");
