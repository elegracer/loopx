---
name: loopx-pi
description: Operate LoopX long-running goals from pi. Use for /loopx, /loopx-turn, persistent project goals, quota-gated work, LoopX todo ownership, state writeback, or handoff across agent sessions.
compatibility: Requires LoopX 0.2.7+ on PATH and the loopx-pi-adapter extension.
---

# LoopX In Pi

LoopX is the deterministic local control plane. Pi is the interactive executor. Keep their responsibilities separate:

- LoopX owns durable goal, gate, todo, quota, evidence, and handoff state.
- Pi performs one bounded work segment using its normal read/bash/edit/write tools.
- `/loopx-turn` is manual. `/loopx-auto start` explicitly opts the visible Pi session into persistent multi-goal continuation.
- Auto mode uses only a session-scoped timer derived from LoopX cadence. It never installs a daemon, cron job, detached worker, or external heartbeat automation.

Use `loopx_control` for supported operations. Do not construct raw `loopx` shell commands unless the structured tool lacks the required action.

## Host Mapping

Treat pi as an external interactive CLI host:

- start-goal host surface: `pi`
- typed turn-plan host: `generic-cli`
- execution mode: `interactive-visible`
- scheduler owner: `agent_cli_loop`
- LoopX 0.2.7 quota calls use the goal, agent, capabilities, and bounded turn envelope
- default registered agent: `pi-main` (override with `LOOPX_PI_AGENT_ID`)
- available capabilities: `shell`, `filesystem`, `filesystem_write`

These capabilities describe the current runtime; they do not grant repository, network, publish, production, or secret access.

## Delivery Workspace And Vision

LoopX 0.2.7 binds accountable delivery to the Git checkout that produced it.

- When work is delivered in the connected goal project, omit `deliveryWorkspace`.
- When work is delivered in another checkout or worktree, pass that path as `deliveryWorkspace` to both `refresh_state` and `spend_slot`.
- For a material refresh, provide a bounded vision patch with `visionState`, `visionSummary`, `visionRoleScope`, `visionAcceptance`, and the relevant continuation fields.
- Use `visionUnchangedReason` only after an agent vision baseline exists and its acceptance boundary is genuinely unchanged.
- A workspace or vision guard failure is a blocker to fix, not permission to spend from another directory or omit the checkpoint.

## Read-Only Inspection

For `/loopx` without a goal:

1. Call `loopx_control` with `action=status` and no mutation.
2. If status is contradictory or unhealthy, call `diagnose` for the selected goal.
3. Report the active goal, current user gate, highest-priority runnable agent todo, owner/claim, and exactly one next safe action.
4. Do not connect a project, add todos, refresh state, or spend quota.

## Start Or Continue A Goal

`/loopx <goal text>` is explicit user intent to create or reuse local LoopX state for that goal. It is not permission for external writes, publishing, production actions, destructive git, or persistent continuation. Only `/loopx-auto start` opts the current Pi session into continuation.

1. Call `start_goal` with the exact goal text. Read `project_connection` and `recommended_next_step`.
2. If already connected, reuse the existing goal and todos. Never force bootstrap or replace state. Check `registered_agents`; when `pi-main` is absent, preview then execute `register_agent` for the existing goal before claiming work.
3. If not connected, call `connect` first as a preview (`execute=false`), inspect its paths and goal id, then call it with `execute=true`. The adapter also registers `pi-main` for the new goal.
4. Confirm `.loopx/`, `.codex/goals/`, and `.local/` are ignored. The adapter writes these patterns to local `.git/info/exclude` after connect and does not modify tracked `.gitignore`. Do not commit generated live state.
5. Read `todo_list` before planning. Avoid todos that duplicate existing text or intent.
6. For a broad goal, plan 2-5 concise public-safe todos. For a bounded goal, use only the steps needed to make the approach explicit. Prefix each with `[P0]`, `[P1]`, or `[P2]`; include at least one P0 unless blocked by a user gate.
7. Preview each `todo_add`, then execute it in exact plan order. Prefer `role=agent`, `taskClass=advancement_task`; use `role=user`, `taskClass=user_gate` only for a concrete owner decision.
8. Call `refresh_state` with a truthful next action. Then follow the one-turn workflow below.

Do not interpret successful setup as successful project work.

## One Bounded Turn

Use this workflow for `/loopx-turn` and for the first segment after starting a goal:

1. Call `status` focused on the goal and `quota_should_run` with `agentId=pi-main`.
2. If LoopX says not to run, stop. Report the reason, gate, backoff, and next observable condition. Do not spend quota.
3. Select at most one runnable agent todo. Respect `claimed_by`, excluded agents, required decision scope, write scope, capabilities, and repository policy.
4. Preview `todo_claim`, then execute it. If the claim is rejected, re-read status instead of working around ownership.
5. Perform one coherent work segment with pi's normal tools. Keep changes inside the selected todo and repository scope.
6. Run targeted validation. A tool call, process launch, generated packet, or unverified edit is not delivery evidence.
7. On validated progress, preview and execute `todo_complete` with compact public-safe evidence and either a concrete successor (`nextAgentTodo`) or `noFollowUp=true`.
8. Preview and execute `refresh_state`. Set a truthful classification, delivery scale, delivery outcome, next action, delivery workspace, and required agent vision checkpoint.
9. Only after validated work and state writeback, preview then execute `spend_slot` once from the accountable delivery workspace.
10. Stop after this segment. Do not schedule, inject, or recursively trigger another Pi turn. In auto mode, only the host controller may select the next goal after `agent_settled`.

If work fails or remains incomplete, do not falsely complete the todo or spend quota. Record a truthful refresh classification/outcome when supported, and report the blocker.

## Persistent Multi-Goal Mode

`/loopx-auto start [goal-id ...] [--max-turns N]` is explicit user permission for bounded continuation in the current visible Pi session. The default budget is 20 dispatched turns and the hard maximum is 100. Omit goal ids to consider every goal in the current project registry.

Before starting, complete one normal Pi turn. Pi only flushes custom session entries durably after an assistant message exists, and the adapter refuses an empty-session start rather than claiming persistence it cannot guarantee.

The controller must preserve these boundaries:

1. Call the read-only `loopx turn select` command with scheduler owner `agent_cli_loop`, the persisted fairness cursor, and the user-selected goal set.
2. Dispatch only `run_current_session` and exactly one selected Turn. Re-read goal-scoped status and `turn_plan` inside the Turn before claiming work because the dispatch snapshot may be stale.
3. Persist the goal set, turn budget, cursor, plan id, turn key, and LoopX-derived next wake in Pi custom session entries.
4. Continue only after `agent_settled`. The agent itself never owns continuation.
5. Pause on manual input, user action, contract error, uncertain restart/fork/tree state, exhausted budget, `requires_isolated_session`, or a repeated per-goal turn key showing no governed state progress.
6. On `wait`, use only `wake_after_seconds` from LoopX. Do not invent a polling rate.
7. Stop only when every selected goal is terminal, represented by `terminal_stop`.
8. Clear timers on session shutdown. Never continue in a detached process or execute a goal in the wrong working directory.

Use `/loopx-auto status` to inspect state, `stop` to disable it, `resume` after resolving a pause, and `tick` for an explicit immediate re-plan. A cross-workspace goal needs a separate Pi session opened in its canonical project.

## Write Safety

- Mutating `loopx_control` actions default to preview. Inspect preview output before repeating with `execute=true`.
- Never use force bootstrap, state replacement, destructive reconnect, or global-route replacement through this adapter.
- Never expose credentials, raw private logs, private URLs, local absolute paths, or benchmark trajectories as public-safe evidence.
- External comments, PR publication, merge, production action, and private-material access remain explicit user or repository-policy gates.
- LoopX's local generated state is operational state, not source code. Keep it untracked.

## Recovery

When behavior is surprising:

1. Run `doctor`.
2. Run goal-scoped `status`, then `diagnose` and `history`.
3. Compare the active todo, quota decision, latest refresh, and claimed agent.
4. Do not bypass a contradictory gate. Report the exact contradiction and the smallest repair action.
