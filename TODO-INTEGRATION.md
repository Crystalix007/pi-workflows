# Todo integration — using pi-todo from workflows

If you have [pi-todo](https://github.com/Crystalix007/pi-todo) installed,
pi-workflows automatically gains a `todo(action, params?)` primitive.
Nothing to configure — it's detected at runtime.

## What you can do

| Action | Example | What it does |
|---|---|---|
| `"create"` | `todo("create", { list = "my-plan", title = "Implementation" })` | Make a new list (or ensure one exists). |
| `"add"` | `todo("add", { list = "my-plan", items = { {text="Task A"}, {text="Task B"} } })` | Add tasks. If `items` use `ref`/`underRef`, you define a tree in one call. |
| `"next"` | `todo("next", { list = "my-plan" })` | Pull the highest-priority pending task. Returns `details.next_task` with `id`, `text`, `status`, `priority`. |
| `"update"` | `todo("update", { list = "my-plan", id = 3, status = "done" })` | Change a task's status, priority, text, etc. |
| `"show"` | `todo("show", { list = "my-plan" })` | Dump the current tree + counts. |
| `"purge"` | `todo("purge", { list = "my-plan" })` | Remove all fully-done branches. |
| `"lists"` | `todo("lists")` | List all your todo lists. |

## Power features

**Subtree syntax.**  `ref`/`underRef` lets you author a nested plan in one call:

```lua
todo("add", { list = "my-plan", items = {
  { ref = "a", text = "Investigate codebase", priority = "high" },
  { ref = "b", text = "Read auth module", priority = "medium", underRef = "a" },
  { ref = "c", text = "Read billing module", underRef = "a" },
  { text = "Deploy", priority = "critical" },
} })
```

**Scoped lists.**  `scope/name` namespaces your lists (e.g. `features/auth`,
`bugs/priority`).  The `"/"` prefix means root (no scope).

**Subtree targeting.**  Append `#<id>` to a list to operate within a subtree:
`todo("next", { list = "my-plan#5" })` pulls only from tasks under task 5.

**Global `next`.**  Omit `list` and it searches across *all* your lists for the
highest-priority pending task.

## Real workflow patterns

### The delegation loop

Pull the next task, hand it to a fresh-context worker, mark it done, repeat:

```lua
set_options{ context = "continue" }

-- Create a task list from a structured plan
local plan = prompt("Break down: upgrade auth to OAuth 2.0", schema{
  tasks = list(schema{ name = str, difficulty = describe(enum("easy","medium","hard"), "difficulty") })
}):await()

todo("create", { list = "auth-upgrade" }):await()
local items = {}
for i, t in ipairs(plan.tasks) do
  items[i] = { ref = "t" .. i, text = t.name, priority = (t.difficulty == "hard" and "high" or "medium") }
end
todo("add", { list = "auth-upgrade", items = items }):await()

-- The loop. next() throws when no pending task remains (and may return
-- a null next_task instead in the future), so guard both failure modes:
-- break when the :await() rejects AND when next_task is absent/null.
while true do
  local ok, n = pcall(function()
    return todo("next", { list = "auth-upgrade" }):await()
  end)
  if not ok or not n.details.next_task then break end
  local t = n.details.next_task
  subagent{ agent = "worker", task = t.text, context = "fresh" }:await()
  todo("update", { list = "auth-upgrade", id = t.id, status = "done", cascade = true }):await()
end
todo("purge", { list = "auth-upgrade" }):await()
```

### Self-repairing review loop

```lua
repeat
  local check = prompt("Review recent changes. Still issues?", schema{
    quality = describe(enum("high","medium","low"), "quality"),
    issues  = optional(list(str)),
  }):await()

  if check.quality == "high" then break end

  todo("add", { list = "reviews/fixes", items = {
    { text = "Fix: " .. table.concat(check.issues, ", "), priority = "high" }
  } }):await()

  local fix = todo("next", { list = "reviews/fixes" }):await()
  subagent{ agent = "worker", task = fix.details.next_task.text, context = "fresh" }:await()
  todo("update", { list = "reviews/fixes", id = fix.details.next_task.id, status = "done" }):await()
until false
```

## If pi-todo isn't installed

The `todo` function is simply absent from the workflow — the rest of the API
(`prompt`, `subagent`, `exec`, `schema`) works as normal.
