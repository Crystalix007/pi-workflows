---
name: pi-workflows
description: |
  Author and run procedural Lua workflows with deterministic step execution.
  Use prompt() for direct model steps, subagent() for delegation, exec() for
  shell commands, and schema{…} for structured output. Loops, branches, and
  composition guarantee no step is forgotten.
---

# pi-workflows — procedural agentic workflows

Write workflows as Lua scripts. The host enforces control flow (loops,
branches, iteration, composition); each primitive delegates to an agent.
This is a **procedural** layer on top of **pi-subagents** — use when a
declarative chain isn't enough.

## Quick start

**Run a workflow** — call the `run_workflow` tool or use `/wf`:

```bash
/wf -e "return exec('echo hello'):await()"
/wf review-loop
```

**Write a workflow** in `.pi/workflows/<name>.lua` (project) or
`~/.pi/agent/workflows/<name>.lua` (global):

```lua
set_options{ context = "continue" }
local result = prompt("Is the build done?", schema{
  complete = bool, reasoning = str,
}):await()
if not result.complete then
  subagent{ agent = "worker", task = "finish the build", context = "fresh" }:await()
end
```

## Primitives

| Primitive | Purpose |
|---|---|
| `prompt(text, schema?)` | Ask the model; returns structured data if schema given |
| `subagent{role, task, …}` | Delegate to a pi-subagents role (worker, reviewer, etc.) |
| `exec(cmd)` | Run a shell command, return stdout |
| `schema{ key = type, … }` | Build a schema for structured output |
| `set_options{…}` / `reset_options()` | Set per-step defaults (context, model, cwd) |

Schema types: `str`, `bool`, `num`, `list(t)`, `enum(…)`, `optional(t)`,
`describe(t, "…")`.

## Control flow

Use standard Lua: `for`/`while` loops, `if`/`else` branches, `repeat`/`until`,
local variables. The host guarantees every step runs in order — no skipped
prompts. Runaway loops are capped (^500ms CPU slice).

## Context modes

- `continue` (default for prompt) — extends the same session.
- `fresh` — brand-new context (good for implementation workers).
- `fork` — branched thread inheriting history (good for review/oracle).

Set via `set_options{context="…"}` or per step: `subagent{context="…"}`.

## Composition

Call another workflow by name: `workflow("other-plan", args)` (coming soon).
For now, use `subagent()` to delegate to role agents and use `prompt()` for
direct model interactions.
