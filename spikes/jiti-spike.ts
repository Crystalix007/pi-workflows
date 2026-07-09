// Spike 0.2b — confirm wasmoon (WASM ESM) imports and runs inside a
// jiti-loaded pi extension, not just plain node. Loaded via `pi -e`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LuaFactory } from "wasmoon";

export default async function (_pi: ExtensionAPI) {
  try {
    const lua = await new LuaFactory().createEngine({ injectObjects: true, enableProxy: true });
    const thread = lua.global.newThread();
    thread.loadString("return 6 * 7");
    const results = await thread.run(0, { timeout: 2000 });
    console.error(`[wf-jiti-spike] wasmoon OK under jiti; 6*7 = ${results[0]}`);
    lua.global.close();
  } catch (e) {
    console.error(`[wf-jiti-spike] FAIL: ${(e as Error).message ?? e}`);
  }
}
