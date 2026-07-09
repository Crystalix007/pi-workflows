# pi-workflows

Programmatic agentic workflows for Pi. Write multi-step plans as short Lua
scripts — the host **guarantees every step runs in order**, so nothing gets
forgotten.

## Quick start

**1. Install** — add to your Pi settings (`~/.pi/agent/settings.json`):

```json
{ "packages": ["npm:pi-subagents"] }
```

Then load the extension: `pi -e src/index.ts`  (or copy into `~/.pi/agent/extensions/`).

**2. Write a workflow** — create `.pi/workflows/my-plan.lua`:

```lua
set_options{ context = "continue" }

local verdict = prompt("Is the build ready?", schema{
  complete = bool,
  issues   = optional(list(str)),
}):await()

if not verdict.complete then
  subagent{
    agent   = "worker",
    task    = "Fix: " .. table.concat(verdict.issues, ", "),
    context = "fresh",
  }:await()
end

exec("echo done"):await()
```

**3. Run it** — tell the agent:

```
/wf my-plan
```

Or from the agent itself: call the `run_workflow` tool with a name, path, or
inline script.

## What you get

| Primitive | Does |
|---|---|
| `prompt(text, schema?)` | Ask the model. Returns structured data if you give it a `schema{…}`. |
| `subagent{role, task, …}` | Delegate to a worker, reviewer, oracle, etc. |
| `exec(cmd)` | Run a shell command. |
| `todo(action, params?)` | Manage hierarchical todo lists (if pi-todo is installed). |
| `schema{ key = type, … }` | Describe what you want back (`str`, `bool`, `num`, `list(…)`, `enum(…)`, `optional(…)`). |

See **[TODO-INTEGRATION.md](TODO-INTEGRATION.md)** for delegation loops, subtree syntax, and real workflow patterns with `todo()`.

Plus standard Lua: loops, `if`/`else`, variables, functions. Runaway loops are
automatically capped.

## Example

A review loop that keeps fixing until quality is "high" (from
`.pi/workflows/review-loop.lua`):

```lua
repeat
  local check = prompt("Review the work. Is it complete?", schema{
    quality = describe(enum("high", "medium", "low"), "quality"),
    issues  = optional(list(str)),
  }):await()
  if check.quality == "high" then break end
  subagent{ agent = "worker", task = "Fix: " .. table.concat(check.issues, ", "), context = "fresh" }:await()
until false
```

## Where workflows live

- **Project:** `.pi/workflows/*.lua`  (shared with your team)
- **Global:** `~/.pi/agent/workflows/*.lua`  (available everywhere)

Files named `<foo>.lua` are available as `/wf foo`.

## Context modes

Set per-step or for the whole workflow:

| Mode | What it means |
|---|---|
| `continue` | Extend the same conversation (default for `prompt`) |
| `fresh` | Brand-new context — good for implementation agents |
| `fork` | Branched thread inheriting history — good for review |

```lua
set_options{ context = "fresh" }       -- set default
subagent{ context = "fresh", … }      -- override per step
```

## More

- **Agents:** see `.pi/skills/pi-workflows/SKILL.md` for the full primitive reference.
- **Why this exists:** [OBJECTIVE.md](OBJECTIVE.md).
- **Architecture:** [PLAN.md](PLAN.md).
