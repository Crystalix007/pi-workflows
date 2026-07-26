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
`~/.pi/agent/workflows/<name>.lua` (global).  See `docs/review-loop.lua` for a
full example:

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
| `subagent{role, task, …}` | Delegate to one pi-subagents role (worker, reviewer, etc.) |
| `fanout{tasks={…}, concurrency?}` | Run independent pi-subagent tasks concurrently and return ordered results |
| `exec(cmd)` | Run a shell command, return stdout |
| `todo("action", params?)` | Manage pi-todo lists: `"create"`, `"add"`, `"next"`, `"update"`, `"show"`, `"purge"`. If pi-todo isn't installed, this function is absent. |
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

## Parallel fan-out

Use a single `fanout` step when independent subagent work can run together:

```lua
local results = fanout{
  context = "fresh",
  concurrency = 2,
  tasks = {
    { agent = "scout", task = "Map the auth flow. Do not edit files." },
    { agent = "reviewer", task = "Review auth tests. Do not edit files." },
  },
}:await()

local brief = prompt("Synthesize:\n" .. results.results[1].text .. "\n" .. results.results[2].text):await()
```

Tasks may set `model`, `cwd`, and `outputSchema`; otherwise `set_options`
defaults apply. `results.results` is always in input order, including repeated
agent roles. A child failure halts the workflow after outcomes are collected.
Use `fresh` or `fork`, never `continue`. Prefer read-only tasks; concurrent
writers require `worktree=true` and explicit reconciliation. Separate
`subagent():await()` calls are sequential.

## Composition

Call another workflow by name: `workflow("other-plan", args)` (coming soon).
For now, use `subagent()` to delegate to role agents and use `prompt()` for
direct model interactions.
