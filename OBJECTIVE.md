# OBJECTIVE

## Goal

Give Pi a way to define and run **programmatic agentic workflows** — multi-step
plans where a *deterministic host* enforces the control flow (loops, branches,
iteration, composition) and *delegates* each step's actual work to an agent.
Workflows are authored as concise, human-readable **Lua** scripts and are
designed to be written by agents themselves.

## The problem

Getting a model to execute a long, branching plan reliably is fragile today:
the model may drift from or "forget" individual steps mid-conversation, and
there is no first-class artifact for encoding a *procedural* plan (with loops
and dynamic iteration). `pi-subagents` already provides **declarative**
orchestration (sequential chains, parallel fanout, dynamic expand) but cannot
express **procedural** control flow — `while`/`if`/iteration/recursion and
data-driven branching.

## The approach

A thin **workflow layer** on top of `pi-subagents`:

- **Lua scripts** (embedded via `wasmoon`; one VM per run; coroutine-scheduled)
  define the *plan* — the procedural control flow.
- Each primitive (`prompt`, `subagent`, `workflow`, `ask`, `exec`) is a
  host-enforced **step** that delegates agentic execution to `pi-subagents`
  (agent roles; fresh / fork / continue context; model and cwd choice; nesting
  depth and budgets).
- The **control plane is deterministic** — the host guarantees every step runs,
  in order; no step is silently dropped. The **agentic plane stays
  model-driven** — each step is a full agent that can reason and use tools.

This separates the *execution* layer (the plan, deterministic) from the
*agentic* layer (the model, delegated): a plan declares *what role/goal* a step
uses, and the harness picks the model and prompt. General harness improvements
(skills, commands, better models) benefit existing workflows without plan
changes.

## Guiding principles

1. **Composition over deep nesting.** Prefer plans that compose other plans
   (Lua-level; cheap; does not consume agent-nesting depth) over agents that
   recursively self-orchestrate. Self-orchestration is an explicit, bounded
   *escape-hatch*, not the default.
2. **Agent-authorable, human-readable.** Slight verbosity is acceptable; a plan
   must remain something a human can grok at a glance. Agents are the primary
   authors.
3. **Observable by construction.** Every workflow run and every step is logged
   into the session, so progress is inspectable and resumable.
4. **Per-step control.** Context mode (continue / fork / fresh), model, working
   directory, output schema, retry policy, and nesting/budgets are configurable
   per step, with role-implied sensible defaults.

## Scope

**In v1:** procedural control flow; the core primitives; per-step
context/model/cwd/nesting control; structured outputs; failure handling; session
logging; **manual** resume. This delivers *executive reliability* (no skipped
steps) — not *crash-durability*.

**Out of v1 (later milestones):** automated crash-recovery (replay-based
durability); intra-workflow concurrency and events; the `--workflow` CLI flag;
richer live observability; a visual plan editor.

**Explicitly not:** a new agent runtime, or a reimplementation of what
`pi-subagents` already provides.

## Success looks like

An agent (or human) can write a short Lua plan encoding an iterative, branching
workflow — e.g. "loop until the task is done, re-plan when stuck, delegate
implementation to a fresh-context worker and review to a forked reviewer" — run
it, watch each structured step land in the session log, and trust that no step
is silently dropped.
