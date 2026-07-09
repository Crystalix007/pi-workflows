-- Example: simple review-and-fix workflow.
-- Runs a prompt to check quality, branches on the result, and delegates
-- fixes to a worker subagent when needed.
set_options{ context = "continue" }

local function print(msg) exec("echo " .. msg):await() end

print("starting review loop")
local round = 0

repeat
  round = round + 1
  print("round " .. round)

  -- Ask the main model to assess quality
  local check = prompt("Review the current work. Is it complete?", schema{
    quality = describe(enum("high", "medium", "low"), "quality rating"),
    issues  = optional(describe(list(str), "remaining issues")),
  }):await()

  if check.quality == "high" then
    print("quality is high; done")
    break
  end

  print("quality: " .. check.quality .. ", issues: " .. (#check.issues or 0))

  -- Delegate fixes to a fresh-context worker
  local fix = subagent{
    agent = "worker",
    task  = "Fix the following issues: " .. table.concat(check.issues, ", "),
    context = "fresh",
  }:await()
  print("fix result: " .. (fix.details and fix.details.agent or fix.text:sub(1,40)))

  if round >= 3 then
    print("max rounds reached; stopping")
    break
  end
until false

return { rounds = round, final_quality = "high" }
