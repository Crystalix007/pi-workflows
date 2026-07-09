# PLAN

> Doc lineage: **OBJECTIVE.md** (why) → **PLAN.md** (what / how, broad strokes) →
> **SEQUENCED.md** (buildable steps).
>
> This document fixes the architecture and component responsibilities. It is
> deliberately broad; SEQUENCED.md breaks it into concrete, ordered work.

## System in one sentence

A pi **extension** that runs **Lua** workflow scripts via an embedded VM; the
script's primitives are host-enforced steps that delegate agentic execution to
**`pi-subagents`**. The host owns deterministic control flow; `pi-subagents`
owns the agents.

## Layered architecture

```
   /wf command ─────┐
   run_workflow tool┼──▶ INVOCATION  (name / path / inline + args)
                   │
                   ▼
            ┌──────────────────────────────────────────────┐
            │             WORKFLOW ENGINE                  │
            │  discovery · module load · VM-per-run        │
            │  coroutine step scheduler  (control plane)   │
            └──┬──────────────┬──────────────────┬─────────┘
   primitives  │              │ logging          │ policy
   ┌───────────▼────┐  ┌──────▼───────────┐  ┌───▼──────────────┐
   │  LUA RUNTIME   │  │ SESSION LOGGING  │  │  POLICY          │
   │  wasmoon VM    │  │ step events      │  │  retry / budgets │
   │  sandbox       │  │ inline (model i) │  │  depth guard     │
   │  schema helper │  │ transcripts link │  │  canOrchestrate  │
   └──────┬─────────┘  └──────────────────┘  └──────────────────┘
          │ primitive calls (Lua yields)
   ┌──────▼───────────────────────────────────────────────────┐
   │          PI-SUBAGENTS ADAPTER  (host → RPC spawn)         │
   │   context mode · model · cwd · schema · budgets mapping   │
   └──────┬───────────────────────────────────┬────────────────┘
          │ primary                           │ fallback
   ┌──────▼──────────────┐           ┌────────▼──────────────┐
   │   pi-subagents       │           │  SDK createAgentSession│
   │  roles · fresh/fork  │           │  (direct steps)        │
   │  nesting · budgets   │           │                        │
   └──────────────────────┘           └────────────────────────┘
```

## Components & responsibilities

**1. Extension entrypoint** — the pi extension module. Registers the
`run_workflow` tool, the `/wf` command, discovers workflows, wires the engine,
and owns the process-lifetime resources (deferred until needed, per pi rules).

**2. Invocation surface** — accepts a workflow by *name*, *path*, or *inline
script string* plus optional input *args*. The LLM-facing tool and the
human-facing command funnel into one entry. (`--workflow` CLI flag is v1.x.)

**3. Discovery & resolution** — scans `.pi/workflows/*.lua` (project) and
`~/.pi/agent/workflows/*.lua` (global); resolves a name as **sibling (in the
current module) → on-disk → inline-bundle**; loads Lua modules and identifies
the entry + any named siblings.

**4. Workflow engine** — the deterministic core. Spins up **one Lua VM per
run**, injects the primitives + schema helper, and runs the entry as a
coroutine. The **step scheduler** resumes the coroutine; each primitive *yields*
and is resumed only when its backing async op resolves — so ordering is
guaranteed by construction (no forgotten steps). This scheduler is also the
foundation for v1.x concurrency.

**5. Lua runtime** — wraps `wasmoon` (Lua 5.4 via WASM): sandboxed globals, an
**instruction-count hook** for CPU budgeting and forced yields, and JSON
serialization at the Lua↔TS boundary. Owns the `schema{ … }` helper DSL.

**6. Primitives** — the Lua-facing API, each a thin host function that yields
and bridges to the execution layer:
`prompt(text, schema?, opts?)` · `subagent({role, task, …}, opts?)` ·
`workflow(name, args?)` · `ask(text, schema?, opts?)` · `exec(cmd, …)` ·
(`emit`/`on` arrive in v1.x). `opts` uniformly carries `context`
(`continue`/`fork`/`fresh`), `model`, `cwd`, `retry`, `budgets`.

**7. pi-subagents adapter** — bridges a primitive call to `pi-subagents` via its
in-process Extension RPC (`spawn` / `status` / `interrupt`), mapping our step
options (context mode, model, cwd, schema, budgets, nesting) onto `pi-subagents`
params and harvesting structured results (`outputSchema` / `structured_output`).
Falls back to the SDK `createAgentSession` for any step `pi-subagents` can't
serve. *(Validated by Spike 0 — see SEQUENCED.md.)*

**8. Session logging** — emits the workflow run and every step into the **parent
session log** (the plan or a reference; each step's primitive + args + structured
result/summary + context/retry decisions + control events). Subagent
**transcripts** stay in `pi-subagents` child session files, **linked** and
expandable on demand (logging model **(i)**). This makes progress inspectable and
manually resumable.

**9. Policy** — per-step retry, halt-with-report default, per-level **shrinking
budgets** (turn/tool/cost/time), nesting **depth guard** (default 5), and the
`canOrchestrate` escape-hatch that lets a step-agent self-orchestrate within
those bounds.

## End-to-end run flow

1. Agent or human invokes via `run_workflow` tool or `/wf` (name/path/inline + args).
2. Discovery resolves the module; entry and any siblings are identified.
3. Engine starts a Lua VM, injects primitives + schema helper, runs the entry
   coroutine with the args.
4. Each primitive call: Lua **yields** → adapter invokes `pi-subagents`
   (`spawn`) with the step options → awaits the result → resumes Lua with the
   parsed table.
5. Each step is **logged** into the session (inline summary + linked transcript).
6. On failure: the error returns as a Lua value; per-step retry or halt-with-report applies.
7. Workflows **compose** via `workflow(name, args)` at the Lua layer — no
   agent-nesting cost (Axis 1). Self-orchestration (Axis 2) only via explicit
   `canOrchestrate`, bounded by depth + budgets.

## Design invariants (constrain all implementation)

- **Deterministic control plane.** The host enforces step order; the model never
  decides *whether* a step runs.
- **Composition over nesting.** Decompose at the Lua layer; treat recursive
  agent self-orchestration as a bounded escape-hatch.
- **Replay-friendly primitives.** Pure + logged + deterministic given their
  results, from day one — so crash-durable resume (v1.x) is an additive layer,
  not a rewrite.
- **One VM per run.** Isolation and clean teardown; cross-run state passes
  explicitly.
- **Separation of execution from agentic.** Plans name *roles/goals*; the harness
  resolves model and prompt, so harness improvements benefit existing workflows.

## Evolution (broad strokes)

- **v1.0 — the thin vertical slice.** Lua runtime + scheduler; the five
  primitives; invocation (tool + `/wf`); discovery; structured output; per-step
  context/model/cwd/nesting control; failure policy; session logging; manual
  resume. Delivers executive reliability.
- **v1.x.** Intra-workflow concurrency & events (`emit`/`on`, parallel
  coroutine branches, multi-workflow bus); `--workflow` CLI flag; replay-based
  crash-durable resume; richer live observability.
- **v2+.** Scheduling, workflow versioning, a visual plan editor.
