import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-workflows — programmatic agentic workflows via embedded Lua.
 *
 * Phase 0 scaffold: a no-op extension shell that confirms it loads under pi.
 * Real registration (run_workflow tool, /wf command, engine wiring) arrives in
 * later phases per SEQUENCED.md.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("pi-workflows extension loaded (scaffold)", "info");
  });
}
