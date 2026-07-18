import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LOOPX_BIN = process.env.LOOPX_BIN || "loopx";
const DEFAULT_AGENT_ID = process.env.LOOPX_PI_AGENT_ID || "pi-main";
const DEFAULT_CAPABILITIES = ["shell", "filesystem", "filesystem_write"];
const TOOL_TIMEOUT_MS = 60_000;
const AUTO_STATE_ENTRY = "loopx-pi-auto-state";
const AUTO_STATE_SCHEMA_VERSION = "loopx_pi_auto_state_v0";
const AUTO_PLAN_SCHEMA_VERSION = "loopx_multi_goal_turn_plan_v0";
const AUTO_SELECTION_SCHEMA_VERSION = "loopx_multi_goal_selection_v0";
const DEFAULT_AUTO_MAX_TURNS = 20;
const MAX_AUTO_TURNS = 100;
const MIN_AUTO_WAKE_SECONDS = 5;

const ACTIONS = [
  "doctor",
  "status",
  "start_goal",
  "connect",
  "register_agent",
  "ready_score",
  "quota_should_run",
  "turn_plan",
  "todo_list",
  "todo_add",
  "todo_claim",
  "todo_complete",
  "history",
  "diagnose",
  "refresh_state",
  "spend_slot",
] as const;

const controlParameters = Type.Object({
  action: StringEnum(ACTIONS),
  project: Type.Optional(Type.String({ description: "Project directory; defaults to pi's current directory" })),
  goalId: Type.Optional(Type.String({ description: "Stable LoopX goal id" })),
  goalText: Type.Optional(
    Type.String({ description: "Exact long-running goal text; omit for a bare /loopx guided connection preview" }),
  ),
  agentId: Type.Optional(Type.String({ description: `Registered agent id; defaults to ${DEFAULT_AGENT_ID}` })),
  todoId: Type.Optional(Type.String({ description: "Structured LoopX todo id" })),
  text: Type.Optional(Type.String({ description: "Public-safe todo text" })),
  role: Type.Optional(StringEnum(["agent", "user"] as const)),
  taskClass: Type.Optional(
    StringEnum(["advancement_task", "continuous_monitor", "user_gate", "user_action", "blocker"] as const),
  ),
  actionKind: Type.Optional(Type.String({ description: "Public-safe action token" })),
  taskRepository: Type.Optional(
    Type.String({ description: "Credential-free Git repository identity for an agent todo" }),
  ),
  evidence: Type.Optional(Type.String({ description: "Public-safe validation evidence or pointer" })),
  note: Type.Optional(Type.String({ description: "Public-safe lifecycle note" })),
  nextAgentTodo: Type.Optional(Type.String({ description: "Public-safe successor agent todo" })),
  nextAction: Type.Optional(Type.String({ description: "Durable next action for refresh_state" })),
  classification: Type.Optional(Type.String({ description: "Public-safe refresh classification" })),
  recommendedAction: Type.Optional(Type.String({ description: "Public-safe recommended action" })),
  deliveryBatchScale: Type.Optional(
    StringEnum(["test_only", "single_surface", "multi_surface", "implementation"] as const),
  ),
  deliveryOutcome: Type.Optional(
    StringEnum(["surface_only", "outcome_gap", "outcome_progress", "primary_goal_outcome"] as const),
  ),
  deliveryWorkspace: Type.Optional(
    Type.String({ description: "Git checkout that produced the accountable delivery; defaults to project" }),
  ),
  visionState: Type.Optional(Type.String({ description: "Agent vision lifecycle state for refresh_state" })),
  visionSummary: Type.Optional(Type.String({ description: "Bounded agent vision summary" })),
  visionRoleScope: Type.Optional(Type.String({ description: "Bounded agent role scope" })),
  visionAcceptance: Type.Optional(Type.String({ description: "Bounded agent vision acceptance summary" })),
  visionAdvancementPolicy: Type.Optional(StringEnum(["as_needed", "repeat_until_closed"] as const)),
  visionReplanTrigger: Type.Optional(Type.String({ description: "Bounded agent vision replan trigger" })),
  visionLastPatch: Type.Optional(Type.String({ description: "Bounded summary of the latest vision patch" })),
  visionTodoDelta: Type.Optional(
    Type.Array(Type.String({ description: "Compact public-safe todo delta" }), { maxItems: 8 }),
  ),
  visionUnchangedReason: Type.Optional(
    Type.String({ description: "Reason an existing agent vision remains unchanged" }),
  ),
  noFollowUp: Type.Optional(Type.Boolean({ description: "Record that a completed todo intentionally has no successor" })),
  execute: Type.Optional(Type.Boolean({ description: "Apply a mutation; false or omitted means preview/read-only" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

type ControlParams = {
  action: (typeof ACTIONS)[number];
  project?: string;
  goalId?: string;
  goalText?: string;
  agentId?: string;
  todoId?: string;
  text?: string;
  role?: "agent" | "user";
  taskClass?: "advancement_task" | "continuous_monitor" | "user_gate" | "user_action" | "blocker";
  actionKind?: string;
  taskRepository?: string;
  evidence?: string;
  note?: string;
  nextAgentTodo?: string;
  nextAction?: string;
  classification?: string;
  recommendedAction?: string;
  deliveryBatchScale?: "test_only" | "single_surface" | "multi_surface" | "implementation";
  deliveryOutcome?: "surface_only" | "outcome_gap" | "outcome_progress" | "primary_goal_outcome";
  deliveryWorkspace?: string;
  visionState?: string;
  visionSummary?: string;
  visionRoleScope?: string;
  visionAcceptance?: string;
  visionAdvancementPolicy?: "as_needed" | "repeat_until_closed";
  visionReplanTrigger?: string;
  visionLastPatch?: string;
  visionTodoDelta?: string[];
  visionUnchangedReason?: string;
  noFollowUp?: boolean;
  execute?: boolean;
  limit?: number;
};

type ExecContext = {
  cwd: string;
  signal?: AbortSignal;
};

type AutoPhase = "idle" | "activating" | "armed" | "planning" | "running" | "waiting" | "paused" | "completed";

type AutoState = {
  schemaVersion: typeof AUTO_STATE_SCHEMA_VERSION;
  enabled: boolean;
  phase: AutoPhase;
  project: string;
  goalIds: string[];
  agentId: string;
  maxTurns: number;
  dispatchedTurns: number;
  afterGoalId?: string;
  nextWakeAt?: string;
  lastPlanId?: string;
  lastTurnKey?: string;
  dispatchedTurnKeysByGoal: Record<string, string>;
  pauseReason?: string;
  revision: number;
};

type AutoCommand = {
  action: "start" | "stop" | "status" | "resume" | "tick";
  goalIds: string[];
  maxTurns: number;
};

type MultiGoalSelection = {
  schema_version?: string;
  disposition?: string;
  reason_code?: string;
  wake_after_seconds?: number;
  selected?: Record<string, unknown>;
};

type MultiGoalPlan = {
  ok?: boolean;
  schema_version?: string;
  plan_id?: string;
  goal_count?: number;
  selection?: MultiGoalSelection;
  effects?: Record<string, unknown>;
  boundary?: Record<string, unknown>;
  error?: string;
};

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for this LoopX action`);
  return normalized;
}

function projectPath(value: string | undefined, cwd: string): string {
  if (!value?.trim()) return cwd;
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function defaultAutoState(project: string, agentId = DEFAULT_AGENT_ID): AutoState {
  return {
    schemaVersion: AUTO_STATE_SCHEMA_VERSION,
    enabled: false,
    phase: "idle",
    project,
    goalIds: [],
    agentId,
    maxTurns: DEFAULT_AUTO_MAX_TURNS,
    dispatchedTurns: 0,
    dispatchedTurnKeysByGoal: {},
    revision: 0,
  };
}

function normalizeAutoState(value: unknown, project: string): AutoState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<AutoState>;
  if (raw.schemaVersion !== AUTO_STATE_SCHEMA_VERSION) return undefined;
  const phases = new Set<AutoPhase>([
    "idle",
    "activating",
    "armed",
    "planning",
    "running",
    "waiting",
    "paused",
    "completed",
  ]);
  const phase = phases.has(raw.phase as AutoPhase) ? (raw.phase as AutoPhase) : "paused";
  const maxTurns = Math.min(MAX_AUTO_TURNS, Math.max(1, Number(raw.maxTurns) || DEFAULT_AUTO_MAX_TURNS));
  return {
    schemaVersion: AUTO_STATE_SCHEMA_VERSION,
    enabled: raw.enabled === true,
    phase,
    project: typeof raw.project === "string" && raw.project ? raw.project : project,
    goalIds: Array.isArray(raw.goalIds)
      ? [...new Set(raw.goalIds.map((goalId) => String(goalId).trim()).filter(Boolean))]
      : [],
    agentId: typeof raw.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : DEFAULT_AGENT_ID,
    maxTurns,
    dispatchedTurns: Math.max(0, Number(raw.dispatchedTurns) || 0),
    afterGoalId: typeof raw.afterGoalId === "string" && raw.afterGoalId ? raw.afterGoalId : undefined,
    nextWakeAt:
      typeof raw.nextWakeAt === "string" && Number.isFinite(Date.parse(raw.nextWakeAt))
        ? raw.nextWakeAt
        : undefined,
    lastPlanId: typeof raw.lastPlanId === "string" && raw.lastPlanId ? raw.lastPlanId : undefined,
    lastTurnKey: typeof raw.lastTurnKey === "string" && raw.lastTurnKey ? raw.lastTurnKey : undefined,
    dispatchedTurnKeysByGoal:
      raw.dispatchedTurnKeysByGoal && typeof raw.dispatchedTurnKeysByGoal === "object"
        ? Object.fromEntries(
            Object.entries(raw.dispatchedTurnKeysByGoal)
              .map(([goalId, turnKey]) => [String(goalId).trim(), String(turnKey).trim()])
              .filter(([goalId, turnKey]) => goalId && turnKey),
          )
        : {},
    pauseReason: typeof raw.pauseReason === "string" && raw.pauseReason ? raw.pauseReason : undefined,
    revision: Math.max(0, Number(raw.revision) || 0),
  };
}

function supportsAutoMode(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

function hasDurableSession(ctx: ExtensionContext): boolean {
  if (!ctx.sessionManager.getSessionFile()) return false;
  return ctx.sessionManager.getBranch().some(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
}

function restoreAutoState(ctx: ExtensionContext): AutoState {
  let restored: AutoState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== AUTO_STATE_ENTRY) continue;
    restored = normalizeAutoState(entry.data, ctx.cwd) ?? restored;
  }
  return restored ?? defaultAutoState(ctx.cwd);
}

function parseAutoCommand(rawArgs: string): AutoCommand {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const knownActions = new Set(["start", "stop", "status", "resume", "tick"]);
  const first = tokens[0];
  const action = (first && knownActions.has(first) ? first : first ? "start" : "status") as AutoCommand["action"];
  const args = first && knownActions.has(first) ? tokens.slice(1) : tokens;
  const goalIds: string[] = [];
  let maxTurns = DEFAULT_AUTO_MAX_TURNS;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--max-turns") {
      const value = args[index + 1];
      if (!value) throw new Error("--max-turns requires an integer");
      maxTurns = Number(value);
      index += 1;
      continue;
    }
    if (token.startsWith("--max-turns=")) {
      maxTurns = Number(token.slice("--max-turns=".length));
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unsupported /loopx-auto option: ${token}`);
    goalIds.push(token);
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_AUTO_TURNS) {
    throw new Error(`--max-turns must be an integer between 1 and ${MAX_AUTO_TURNS}`);
  }
  return { action, goalIds: [...new Set(goalIds)], maxTurns };
}

function autoStatusText(state: AutoState): string {
  const goals = state.goalIds.length > 0 ? state.goalIds.join(",") : "all-project-goals";
  const budget = `${state.dispatchedTurns}/${state.maxTurns}`;
  if (state.phase === "waiting" && state.nextWakeAt) {
    const seconds = Math.max(0, Math.ceil((Date.parse(state.nextWakeAt) - Date.now()) / 1000));
    return `LoopX auto ${budget} | wait ${seconds}s | ${goals}`;
  }
  const reason = state.pauseReason ? ` | ${state.pauseReason}` : "";
  return `LoopX auto ${budget} | ${state.phase}${reason} | ${goals}`;
}

function autoStatusLines(state: AutoState): string[] {
  return [
    autoStatusText(state),
    `agent ${state.agentId} | enabled ${String(state.enabled)} | cursor ${state.afterGoalId ?? "none"}`,
    `last plan ${state.lastPlanId ?? "none"} | last turn ${state.lastTurnKey ?? "none"}`,
  ];
}

function buildAutoTurnPrompt(state: AutoState, plan: MultiGoalPlan, selected: Record<string, unknown>): string {
  const goalId = String(selected.goal_id ?? "").trim();
  const turnKey = String(selected.turn_key ?? "").trim();
  const route = String(selected.route ?? "ready_for_host");
  const todo = selected.selected_todo as Record<string, unknown> | undefined;
  const todoId = String(todo?.todo_id ?? "unselected");
  return `[loopx-pi-auto:${String(plan.plan_id ?? "unknown")}:${turnKey || "unknown"}]
Run exactly one visible, bounded LoopX turn for goal ${goalId} in the current project.

The canonical multi-goal planner selected route ${route}, todo ${todoId}, and turn key ${turnKey || "unknown"}. Load the loopx-pi skill, then re-read goal-scoped status and turn_plan before work. If the live turn key or gate changed, follow the fresh LoopX contract instead of this dispatch snapshot. Claim at most one runnable todo, perform and validate one coherent segment, write truthful todo/state/vision updates, and spend one slot only after validated writeback. Stop after this segment. Do not schedule or inject another turn; the visible pi host controller owns continuation after agent_settled. Budget ${state.dispatchedTurns}/${state.maxTurns}.`;
}

function addCapabilities(args: string[]): void {
  for (const capability of DEFAULT_CAPABILITIES) {
    args.push("--available-capability", capability);
  }
}

function startGoalPreviewArgs(project: string, goalText: string): string[] {
  const args = [
    "--format",
    "json",
    "start-goal",
    "--guided",
    "--project",
    project,
    "--host-surface",
    "pi",
    "--agent-id",
    DEFAULT_AGENT_ID,
    "--goal-text",
    goalText,
  ];
  addCapabilities(args);
  return args;
}

function buildArgs(
  params: ControlParams,
  cwd: string,
): { args: string[]; project: string; commandCwd: string; agentId: string } {
  const project = projectPath(params.project, cwd);
  const deliveryWorkspace = projectPath(params.deliveryWorkspace, project);
  const agentId = params.agentId?.trim() || DEFAULT_AGENT_ID;
  const limit = String(params.limit ?? 20);
  const goalId = params.goalId?.trim();
  let args: string[];
  let commandCwd = project;

  switch (params.action) {
    case "doctor":
      args = ["--format", "json", "doctor", "--deep"];
      break;
    case "status":
      args = ["--format", "json", "status", "--limit", limit];
      if (goalId) args.push("--goal-id", goalId, "--agent-id", agentId);
      break;
    case "start_goal": {
      const goalText = params.goalText?.trim();
      args = goalText
        ? [
            "--format",
            "json",
            "start-goal",
            "--guided",
            "--project",
            project,
            "--host-surface",
            "pi",
            "--agent-id",
            agentId,
            "--goal-text",
            goalText,
          ]
        : [
            "--format",
            "json",
            "bootstrap-command-pack",
            "--project",
            project,
            "--host-surface",
            "pi",
            "--agent-id",
            agentId,
          ];
      if (goalId) args.push("--goal-id", goalId);
      addCapabilities(args);
      break;
    }
    case "connect":
      args = [
        "--format",
        "json",
        "bootstrap",
        "--project",
        project,
        "--objective",
        required(params.goalText, "goalText"),
        "--adapter-kind",
        "read_only_project_map_v0",
        "--adapter-status",
        "connected-read-only",
        "--no-onboarding-scan",
        "--codex-app-heartbeat",
        "no",
      ];
      if (goalId) args.push("--goal-id", goalId);
      if (!params.execute) args.push("--dry-run");
      break;
    case "register_agent":
      args = [
        "--format",
        "json",
        "register-agent",
        "--goal-id",
        required(goalId, "goalId"),
        "--agent-id",
        agentId,
      ];
      if (params.execute) args.push("--execute");
      break;
    case "ready_score":
      args = [
        "--format",
        "json",
        "ready-score",
        "--goal-id",
        required(goalId, "goalId"),
        "--agent-id",
        agentId,
      ];
      break;
    case "quota_should_run":
      args = [
        "--format",
        "json",
        "quota",
        "should-run",
        "--goal-id",
        required(goalId, "goalId"),
        "--agent-id",
        agentId,
        "--host-surface",
        "generic_cli",
        "--scheduler-owner",
        "agent_cli_loop",
        "--execution-mode",
        "interactive",
        "--turn-envelope",
      ];
      addCapabilities(args);
      break;
    case "turn_plan":
      args = [
        "--format",
        "json",
        "turn",
        "plan",
        "--goal-id",
        required(goalId, "goalId"),
        "--agent-id",
        agentId,
        "--host",
        "generic-cli",
        "--execution-mode",
        "interactive-visible",
        "--scheduler-owner",
        "agent_cli_loop",
      ];
      addCapabilities(args);
      break;
    case "todo_list":
      args = ["--format", "json", "todo", "list", "--goal-id", required(goalId, "goalId")];
      break;
    case "todo_add":
      args = [
        "--format",
        "json",
        "todo",
        "add",
        "--goal-id",
        required(goalId, "goalId"),
        "--role",
        params.role ?? "agent",
        "--text",
        required(params.text, "text"),
        "--task-class",
        params.taskClass ?? (params.role === "user" ? "user_gate" : "advancement_task"),
      ];
      if (params.actionKind) args.push("--action-kind", params.actionKind);
      if (params.taskRepository) args.push("--task-repository", params.taskRepository);
      if (params.role !== "user") args.push("--claimed-by", agentId);
      if (!params.execute) args.push("--dry-run");
      break;
    case "todo_claim":
      args = [
        "--format",
        "json",
        "todo",
        "claim",
        "--goal-id",
        required(goalId, "goalId"),
        "--todo-id",
        required(params.todoId, "todoId"),
        "--claimed-by",
        agentId,
      ];
      if (!params.execute) args.push("--dry-run");
      break;
    case "todo_complete":
      args = [
        "--format",
        "json",
        "todo",
        "complete",
        "--goal-id",
        required(goalId, "goalId"),
        "--todo-id",
        required(params.todoId, "todoId"),
        "--claimed-by",
        agentId,
      ];
      if (params.evidence) args.push("--evidence", params.evidence);
      if (params.note) args.push("--note", params.note);
      if (params.nextAgentTodo) args.push("--next-agent-todo", params.nextAgentTodo);
      if (params.noFollowUp) args.push("--no-follow-up");
      if (!params.execute) args.push("--dry-run");
      break;
    case "history":
      args = ["--format", "json", "history", "--goal-id", required(goalId, "goalId"), "--limit", limit];
      break;
    case "diagnose":
      args = [
        "--format",
        "json",
        "diagnose",
        "--goal-id",
        required(goalId, "goalId"),
        "--agent-id",
        agentId,
        "--limit",
        limit,
      ];
      addCapabilities(args);
      break;
    case "refresh_state":
      args = [
        "--format",
        "json",
        "refresh-state",
        "--goal-id",
        required(goalId, "goalId"),
        "--project",
        project,
        "--agent-id",
        agentId,
        "--progress-scope",
        "goal",
      ];
      if (params.classification) args.push("--classification", params.classification);
      if (params.recommendedAction) args.push("--recommended-action", params.recommendedAction);
      if (params.nextAction) args.push("--next-action", params.nextAction);
      if (params.deliveryBatchScale) args.push("--delivery-batch-scale", params.deliveryBatchScale);
      if (params.deliveryOutcome) args.push("--delivery-outcome", params.deliveryOutcome);
      if (params.deliveryWorkspace) args.push("--delivery-workspace-path", deliveryWorkspace);
      if (params.visionState) args.push("--vision-state", params.visionState);
      if (params.visionSummary) args.push("--vision-summary", params.visionSummary);
      if (params.visionRoleScope) args.push("--vision-role-scope", params.visionRoleScope);
      if (params.visionAcceptance) args.push("--vision-acceptance", params.visionAcceptance);
      if (params.visionAdvancementPolicy) {
        args.push("--vision-advancement-policy", params.visionAdvancementPolicy);
      }
      if (params.visionReplanTrigger) args.push("--vision-replan-trigger", params.visionReplanTrigger);
      if (params.visionLastPatch) args.push("--vision-last-patch", params.visionLastPatch);
      for (const delta of params.visionTodoDelta ?? []) args.push("--vision-todo-delta", delta);
      if (params.visionUnchangedReason) {
        args.push("--vision-unchanged-reason", params.visionUnchangedReason);
      }
      if (!params.execute) args.push("--dry-run");
      break;
    case "spend_slot":
      commandCwd = deliveryWorkspace;
      args = [
        "--format",
        "json",
        ...(params.deliveryWorkspace ? ["--registry", join(project, ".loopx", "registry.json")] : []),
        "quota",
        "spend-slot",
        "--goal-id",
        required(goalId, "goalId"),
        "--agent-id",
        agentId,
        "--slots",
        "1",
        "--source",
        "controller",
        params.execute ? "--execute" : "--dry-run",
      ];
      addCapabilities(args);
      break;
    default:
      throw new Error(`Unsupported LoopX action: ${String(params.action)}`);
  }

  return { args, project, commandCwd, agentId };
}

async function ensureLocalLoopxExcludes(pi: ExtensionAPI, project: string, signal?: AbortSignal) {
  const gitPath = await pi.exec("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: project,
    signal,
    timeout: 5000,
  });
  if (gitPath.code !== 0) {
    return { updated: false, reason: "not_a_git_repository" };
  }

  const rawPath = gitPath.stdout.trim();
  const excludePath = isAbsolute(rawPath) ? rawPath : resolve(project, rawPath);
  const requiredPatterns = [".loopx/", ".codex/goals/", ".local/"];

  return withFileMutationQueue(excludePath, async () => {
    let current = "";
    try {
      current = await readFile(excludePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    const existing = new Set(
      current
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const missing = requiredPatterns.filter((pattern) => !existing.has(pattern));
    if (missing.length === 0) return { updated: false, path: excludePath, added: [] };

    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    const block = `${prefix}# LoopX local state (managed by loopx-pi-adapter)\n${missing.join("\n")}\n`;
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, current + block, "utf8");
    return { updated: true, path: excludePath, added: missing };
  });
}

async function runLoopx(pi: ExtensionAPI, params: ControlParams, ctx: ExecContext) {
  const plan = buildArgs(params, ctx.cwd);
  const result = await pi.exec(LOOPX_BIN, plan.args, {
    cwd: plan.commandCwd,
    signal: ctx.signal,
    timeout: TOOL_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    const errorText = (result.stderr || result.stdout || "LoopX command failed").trim();
    throw new Error(errorText.slice(0, 8000));
  }

  const output = result.stdout.trim() || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }

  if (params.action === "connect" && params.execute && parsed && typeof parsed === "object") {
    const goalId = (parsed as Record<string, unknown>).goal_id;
    if (typeof goalId === "string" && goalId) {
      const registration = await pi.exec(
        LOOPX_BIN,
        ["--format", "json", "register-agent", "--goal-id", goalId, "--agent-id", plan.agentId, "--execute"],
        { cwd: plan.project, signal: ctx.signal, timeout: TOOL_TIMEOUT_MS },
      );
      if (registration.code !== 0) {
        const detail = (registration.stderr || registration.stdout || "agent registration failed").trim();
        throw new Error(`Project connected, but pi agent registration failed: ${detail.slice(0, 4000)}`);
      }
      try {
        (parsed as Record<string, unknown>).pi_agent_registration = JSON.parse(registration.stdout);
      } catch {
        (parsed as Record<string, unknown>).pi_agent_registration = registration.stdout.trim();
      }
    }
    (parsed as Record<string, unknown>).pi_local_excludes = await ensureLocalLoopxExcludes(
      pi,
      plan.project,
      ctx.signal,
    );
  }

  const rendered = parsed === undefined ? output : JSON.stringify(parsed, null, 2);
  const truncation = truncateHead(rendered, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let text = truncation.content;
  let fullOutputPath: string | undefined;

  if (truncation.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "loopx-pi-"));
    fullOutputPath = join(dir, `${params.action}.json`);
    await writeFile(fullOutputPath, rendered, "utf8");
    text += `\n\n[LoopX output truncated to ${truncation.outputLines} lines / ${formatSize(truncation.outputBytes)}. Full output: ${fullOutputPath}]`;
  }

  return {
    content: [{ type: "text" as const, text }],
    details: {
      action: params.action,
      project: plan.project,
      commandCwd: plan.commandCwd,
      agentId: plan.agentId,
      execute: params.execute === true,
      truncated: truncation.truncated,
      fullOutputPath,
    },
  };
}

async function runAutoPlan(
  pi: ExtensionAPI,
  state: AutoState,
  signal?: AbortSignal,
): Promise<MultiGoalPlan> {
  const args = [
    "--format",
    "json",
    "--registry",
    join(state.project, ".loopx", "registry.json"),
    "turn",
    "select",
    "--project",
    state.project,
    "--agent-id",
    state.agentId,
    "--host",
    "generic-cli",
    "--execution-mode",
    "interactive-visible",
    "--scheduler-owner",
    "agent_cli_loop",
    "--limit",
    "20",
  ];
  for (const goalId of state.goalIds) args.push("--goal-id", goalId);
  if (state.afterGoalId) args.push("--after-goal-id", state.afterGoalId);
  addCapabilities(args);
  const result = await pi.exec(LOOPX_BIN, args, {
    cwd: state.project,
    signal,
    timeout: TOOL_TIMEOUT_MS,
  });
  const output = (result.stdout || result.stderr || "").trim();
  let payload: MultiGoalPlan;
  try {
    payload = JSON.parse(output || "{}") as MultiGoalPlan;
  } catch {
    throw new Error(`LoopX multi-goal plan returned invalid JSON: ${output.slice(0, 2000)}`);
  }
  if (result.code !== 0 || payload.ok !== true) {
    throw new Error(payload.error || output || "LoopX multi-goal plan failed");
  }
  if (payload.schema_version !== AUTO_PLAN_SCHEMA_VERSION || !payload.selection) {
    throw new Error("LoopX multi-goal plan schema mismatch");
  }
  if (
    payload.selection.schema_version !== AUTO_SELECTION_SCHEMA_VERSION ||
    typeof payload.plan_id !== "string" ||
    !payload.plan_id ||
    !Number.isInteger(payload.goal_count) ||
    Number(payload.goal_count) < 1
  ) {
    throw new Error("LoopX multi-goal plan identity contract mismatch");
  }
  const dispositions = new Set([
    "run_current_session",
    "user_action_required",
    "requires_isolated_session",
    "wait",
    "terminal_stop",
    "contract_error",
  ]);
  if (!dispositions.has(String(payload.selection.disposition ?? ""))) {
    throw new Error("LoopX multi-goal selection disposition mismatch");
  }
  const effects = payload.effects ?? {};
  if (
    effects.host_invoked !== false ||
    effects.state_written !== false ||
    effects.scheduler_acknowledged !== false ||
    effects.quota_spent !== false
  ) {
    throw new Error("LoopX multi-goal plan violated its read-only effects contract");
  }
  const boundary = payload.boundary ?? {};
  if (
    boundary.read_only !== true ||
    boundary.single_host_turn_max !== 1 ||
    boundary.todo_selected_by_host !== false ||
    boundary.cross_workspace_execution_allowed !== false
  ) {
    throw new Error("LoopX multi-goal plan boundary contract mismatch");
  }
  return payload;
}

function statusLines(payload: Record<string, unknown>): string[] {
  const queue = payload.attention_queue as { item_count?: number; items?: Array<Record<string, unknown>> } | undefined;
  const lines = [
    `LoopX | goals ${String(payload.goal_count ?? 0)} | runs ${String(payload.run_count ?? 0)} | attention ${String(queue?.item_count ?? 0)}`,
  ];
  for (const item of queue?.items?.slice(0, 5) ?? []) {
    lines.push(
      `${String(item.severity ?? "info")} | ${String(item.goal_id ?? "unknown")} | ${String(item.recommended_action ?? item.status ?? "inspect status")}`,
    );
  }
  return lines;
}

export default function loopxPiAdapter(pi: ExtensionAPI) {
  let autoState = defaultAutoState("");
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let autoPlanAbort: AbortController | undefined;
  let autoPlanningGeneration: number | undefined;
  let autoGeneration = 0;

  function clearAutoTimer(): void {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = undefined;
  }

  function cancelAutoPlan(): void {
    autoPlanAbort?.abort();
    autoPlanAbort = undefined;
    autoPlanningGeneration = undefined;
  }

  function persistAutoState(ctx: ExtensionContext): void {
    autoState = { ...autoState, revision: autoState.revision + 1 };
    pi.appendEntry<AutoState>(AUTO_STATE_ENTRY, {
      ...autoState,
      goalIds: [...autoState.goalIds],
      dispatchedTurnKeysByGoal: { ...autoState.dispatchedTurnKeysByGoal },
    });
    updateAutoStatus(ctx);
  }

  function updateAutoStatus(ctx: ExtensionContext): void {
    const visible = autoState.enabled || !["idle", "completed"].includes(autoState.phase);
    ctx.ui.setStatus("loopx-pi-auto", visible ? autoStatusText(autoState) : undefined);
  }

  function pauseAuto(ctx: ExtensionContext, reason: string, notify = true): void {
    clearAutoTimer();
    cancelAutoPlan();
    autoGeneration += 1;
    autoState = {
      ...autoState,
      enabled: false,
      phase: "paused",
      nextWakeAt: undefined,
      pauseReason: reason,
    };
    persistAutoState(ctx);
    if (notify) ctx.ui.notify(`LoopX auto paused: ${reason}`, "warning");
  }

  function stopAuto(ctx: ExtensionContext): void {
    clearAutoTimer();
    cancelAutoPlan();
    autoGeneration += 1;
    autoState = {
      ...autoState,
      enabled: false,
      phase: "idle",
      nextWakeAt: undefined,
      pauseReason: undefined,
    };
    persistAutoState(ctx);
    ctx.ui.setWidget("loopx-pi-auto-status", undefined);
    ctx.ui.notify("LoopX auto stopped", "info");
  }

  function scheduleAuto(ctx: ExtensionContext, seconds: number): void {
    clearAutoTimer();
    const delaySeconds = Math.max(MIN_AUTO_WAKE_SECONDS, Math.ceil(seconds));
    const generation = autoGeneration;
    autoTimer = setTimeout(() => {
      autoTimer = undefined;
      if (generation !== autoGeneration || !autoState.enabled) return;
      void driveAuto(ctx, "timer");
    }, delaySeconds * 1000);
  }

  async function driveAuto(ctx: ExtensionContext, trigger: string): Promise<void> {
    if (!supportsAutoMode(ctx)) return;
    if (!autoState.enabled || autoPlanningGeneration !== undefined) return;
    if (!ctx.isIdle()) return;
    if (autoState.project !== ctx.cwd) {
      pauseAuto(ctx, "session cwd changed; start a new controller in this project");
      return;
    }
    clearAutoTimer();
    const previousPhase = autoState.phase;
    const previousPlanId = autoState.lastPlanId;
    const generation = autoGeneration;
    const planAbort = new AbortController();
    autoPlanAbort = planAbort;
    autoPlanningGeneration = generation;
    autoState = {
      ...autoState,
      phase: "planning",
      nextWakeAt: undefined,
      pauseReason: undefined,
    };
    updateAutoStatus(ctx);
    try {
      const plan = await runAutoPlan(pi, autoState, planAbort.signal);
      if (generation !== autoGeneration || !autoState.enabled) return;
      if (!ctx.isIdle()) {
        autoState = { ...autoState, phase: "armed" };
        persistAutoState(ctx);
        return;
      }
      const selection = plan.selection ?? {};
      const disposition = String(selection.disposition ?? "");
      const selected = selection.selected;
      if (disposition === "run_current_session") {
        if (!selected) {
          pauseAuto(ctx, "planner returned run_current_session without a selected goal");
          return;
        }
        if (autoState.dispatchedTurns >= autoState.maxTurns) {
          pauseAuto(ctx, `turn budget reached (${autoState.maxTurns})`);
          return;
        }
        const goalId = String(selected.goal_id ?? "").trim();
        const turnKey = String(selected.turn_key ?? "").trim();
        if (!goalId || !turnKey || selected.workspace_disposition !== "current_session") {
          pauseAuto(ctx, "selected Turn is missing current-session goal or transaction identity");
          return;
        }
        if (autoState.goalIds.length > 0 && !autoState.goalIds.includes(goalId)) {
          pauseAuto(ctx, "planner selected a goal outside the persisted controller scope");
          return;
        }
        if (autoState.dispatchedTurnKeysByGoal[goalId] === turnKey) {
          pauseAuto(ctx, `no governed progress after ${turnKey}; refusing duplicate dispatch`);
          return;
        }
        autoState = {
          ...autoState,
          phase: "running",
          dispatchedTurns: autoState.dispatchedTurns + 1,
          afterGoalId: goalId,
          lastPlanId: String(plan.plan_id ?? "") || undefined,
          lastTurnKey: turnKey,
          dispatchedTurnKeysByGoal: {
            ...autoState.dispatchedTurnKeysByGoal,
            [goalId]: turnKey,
          },
          nextWakeAt: undefined,
          pauseReason: undefined,
        };
        persistAutoState(ctx);
        pi.sendUserMessage(buildAutoTurnPrompt(autoState, plan, selected));
        return;
      }
      if (disposition === "wait") {
        const wakeAfterSeconds = Number(selection.wake_after_seconds);
        if (!Number.isFinite(wakeAfterSeconds) || wakeAfterSeconds <= 0) {
          pauseAuto(ctx, "LoopX wait plan has no scheduler-derived wake cadence");
          return;
        }
        const boundedSeconds = Math.max(MIN_AUTO_WAKE_SECONDS, Math.ceil(wakeAfterSeconds));
        const planId = String(plan.plan_id ?? "") || undefined;
        autoState = {
          ...autoState,
          phase: "waiting",
          lastPlanId: planId,
          nextWakeAt: new Date(Date.now() + boundedSeconds * 1000).toISOString(),
          pauseReason: undefined,
        };
        if (previousPhase === "waiting" && previousPlanId === planId) {
          updateAutoStatus(ctx);
        } else {
          persistAutoState(ctx);
        }
        scheduleAuto(ctx, boundedSeconds);
        return;
      }
      if (disposition === "terminal_stop") {
        clearAutoTimer();
        autoGeneration += 1;
        autoState = {
          ...autoState,
          enabled: false,
          phase: "completed",
          lastPlanId: String(plan.plan_id ?? "") || undefined,
          nextWakeAt: undefined,
          pauseReason: undefined,
        };
        persistAutoState(ctx);
        ctx.ui.notify("LoopX auto completed: all candidate goals are terminal_no_followup", "info");
        return;
      }
      const selectedGoal = String(selected?.goal_id ?? "unknown");
      const reason = String(selection.reason_code ?? (disposition || "planner stopped continuation"));
      if (disposition === "user_action_required") {
        pauseAuto(ctx, `user action required for ${selectedGoal}: ${reason}`);
      } else if (disposition === "requires_isolated_session") {
        pauseAuto(ctx, `goal ${selectedGoal} requires an isolated pi session/workspace`);
      } else {
        pauseAuto(ctx, `${disposition || "contract_error"}: ${reason}`);
      }
    } catch (error) {
      if (generation === autoGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        pauseAuto(ctx, `${trigger} plan failed: ${message}`);
      }
    } finally {
      if (autoPlanAbort === planAbort) autoPlanAbort = undefined;
      if (autoPlanningGeneration === generation) autoPlanningGeneration = undefined;
    }
  }

  pi.registerTool({
    name: "loopx_control",
    label: "LoopX Control",
    description:
      `Inspect and update LoopX's local long-running-goal control plane through structured actions. ` +
      `Mutating actions are previews unless execute=true. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Inspect or update LoopX goals, quota, todos, history, and state writeback",
    promptGuidelines: [
      "Use loopx_control instead of constructing raw loopx shell commands when the requested action is supported.",
      "Before a LoopX work segment, use loopx_control status and quota_should_run; spend a slot only after validated work and refresh_state writeback.",
      "Do not set execute=true for LoopX mutations unless the user explicitly started a goal or approved the state change.",
    ],
    parameters: controlParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runLoopx(pi, params as ControlParams, { cwd: ctx.cwd, signal });
    },
  });

  pi.registerCommand("loopx", {
    description: "Inspect LoopX or start/continue a long-running goal",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy; run /loopx after the current turn settles.", "warning");
        return;
      }
      const goalText = args.trim();
      const commandArgs = goalText
        ? startGoalPreviewArgs(ctx.cwd, goalText)
        : ["--format", "json", "status", "--limit", "20"];
      if (ctx.mode === "print") {
        try {
          const result = await pi.exec(LOOPX_BIN, commandArgs, { cwd: ctx.cwd, timeout: TOOL_TIMEOUT_MS });
          if (result.code !== 0) throw new Error(result.stderr || result.stdout || "LoopX command failed");
          const payload = JSON.parse(result.stdout) as Record<string, unknown>;
          if (goalText) {
            const connection = payload.project_connection as Record<string, unknown> | undefined;
            const next = payload.recommended_next_step as Record<string, unknown> | undefined;
            console.log(
              `LoopX preview | goal ${String(payload.goal_id ?? "unknown")} | connection ${String(connection?.connection_state ?? "unknown")} | next ${String(next?.kind ?? "inspect packet")}`,
            );
          } else {
            console.log(statusLines(payload).join("\n"));
          }
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (goalText) {
        try {
          const result = await pi.exec(LOOPX_BIN, commandArgs, { cwd: ctx.cwd, timeout: TOOL_TIMEOUT_MS });
          if (result.code !== 0) throw new Error(result.stderr || result.stdout || "LoopX goal preview failed");
          const payload = JSON.parse(result.stdout) as Record<string, unknown>;
          const goalId = String(payload.goal_id ?? "").trim();
          if (!goalId) throw new Error("LoopX goal preview returned no goal id");
          clearAutoTimer();
          cancelAutoPlan();
          autoGeneration += 1;
          autoState = {
            ...defaultAutoState(ctx.cwd, DEFAULT_AGENT_ID),
            enabled: true,
            phase: "activating",
            goalIds: [goalId],
            revision: autoState.revision,
          };
          updateAutoStatus(ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }
      }

      const request = goalText
        ? `Start or continue this LoopX goal in the current project: ${goalText}\n\nThis /loopx invocation is explicit user intent to create or reuse local LoopX state and activates visible session continuation for that goal. Load the loopx-pi skill, use loopx_control start_goal first, connect only if needed, create a concise ranked todo plan without duplicates, then run the first quota-allowed bounded segment. Stop after that segment; the pi host controller will select any later turn after agent_settled. Do not install a background scheduler.`
        : "Inspect the current project's LoopX state in read-only mode. Load the loopx-pi skill and use loopx_control status first. If the project has a connected goal, report the active goal, user gate, top runnable agent todo, and next safe action. If no goal is connected, call loopx_control start_goal without goalText to obtain the canonical guided connection preview, show its dry-run next step, and ask before any mutation. Do not connect, add todos, activate continuation, or spend quota.";
      pi.sendUserMessage(request);
    },
  });

  pi.registerCommand("loopx-turn", {
    description: "Run one quota-gated LoopX work segment",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy; run /loopx-turn after the current turn settles.", "warning");
        return;
      }
      const goalHint = args.trim();
      pi.sendUserMessage(
        `Run exactly one bounded LoopX turn in the current project${goalHint ? ` for goal ${goalHint}` : ""}. ` +
          "Load the loopx-pi skill. Inspect status and quota first, respect every user/capability gate, claim at most one runnable todo, perform and validate one coherent work segment, then complete/update the todo, refresh state, and spend one slot only when validated delivery was written back. Do not schedule another turn.",
      );
    },
  });

  pi.registerCommand("loopx-auto", {
    description: "Control visible session-persistent multi-goal LoopX continuation",
    handler: async (args, ctx) => {
      let command: AutoCommand;
      try {
        command = parseAutoCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (command.action === "status") {
        ctx.ui.setWidget("loopx-pi-auto-status", autoStatusLines(autoState), { placement: "aboveEditor" });
        updateAutoStatus(ctx);
        return;
      }
      if (command.action === "stop") {
        stopAuto(ctx);
        return;
      }
      if (!supportsAutoMode(ctx)) {
        ctx.ui.notify("/loopx-auto requires TUI or RPC mode", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy; retry /loopx-auto after the current turn settles.", "warning");
        return;
      }
      if (command.action === "start") {
        if (!hasDurableSession(ctx)) {
          ctx.ui.notify(
            "Complete one normal Pi turn before /loopx-auto start so controller state is durably persisted.",
            "warning",
          );
          return;
        }
        clearAutoTimer();
        cancelAutoPlan();
        autoGeneration += 1;
        autoState = {
          ...defaultAutoState(ctx.cwd, DEFAULT_AGENT_ID),
          enabled: true,
          phase: "armed",
          goalIds: command.goalIds,
          maxTurns: command.maxTurns,
          revision: autoState.revision,
        };
        persistAutoState(ctx);
        await driveAuto(ctx, "start");
        return;
      }
      if (command.action === "resume") {
        if (autoState.project !== ctx.cwd) {
          ctx.ui.notify("Saved LoopX auto state belongs to another project; use start instead.", "error");
          return;
        }
        if (autoState.dispatchedTurns >= autoState.maxTurns) {
          ctx.ui.notify("Turn budget is exhausted; use /loopx-auto start with a new budget.", "warning");
          return;
        }
        clearAutoTimer();
        cancelAutoPlan();
        autoGeneration += 1;
        autoState = {
          ...autoState,
          enabled: true,
          phase: "armed",
          nextWakeAt: undefined,
          pauseReason: undefined,
        };
        persistAutoState(ctx);
        await driveAuto(ctx, "resume");
        return;
      }
      if (!autoState.enabled) {
        ctx.ui.notify("LoopX auto is not enabled; use /loopx-auto start [goal-id ...].", "warning");
        return;
      }
      clearAutoTimer();
      cancelAutoPlan();
      autoGeneration += 1;
      autoState = {
        ...autoState,
        phase: "armed",
        nextWakeAt: undefined,
        pauseReason: undefined,
      };
      persistAutoState(ctx);
      await driveAuto(ctx, "tick");
    },
  });

  pi.registerCommand("loopx-status", {
    description: "Show a compact read-only LoopX status widget",
    handler: async (_args, ctx) => {
      try {
        const result = await pi.exec(LOOPX_BIN, ["--format", "json", "status", "--limit", "20"], {
          cwd: ctx.cwd,
          timeout: TOOL_TIMEOUT_MS,
        });
        if (result.code !== 0) throw new Error(result.stderr || result.stdout || "LoopX status failed");
        const payload = JSON.parse(result.stdout) as Record<string, unknown>;
        ctx.ui.setWidget("loopx-pi-status", statusLines(payload), { placement: "aboveEditor" });
        ctx.ui.notify("LoopX status refreshed", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (autoState.enabled && event.source !== "extension") {
      pauseAuto(ctx, "manual user input received", false);
      ctx.ui.notify("LoopX auto paused before processing manual input", "info");
    }
    return { action: "continue" as const };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!supportsAutoMode(ctx) || !autoState.enabled) return;
    if (autoState.phase === "activating") {
      if (!hasDurableSession(ctx)) {
        autoState = {
          ...autoState,
          enabled: false,
          phase: "paused",
          pauseReason: "pi did not establish a durable session after /loopx setup",
        };
        updateAutoStatus(ctx);
        ctx.ui.notify(`LoopX auto paused: ${autoState.pauseReason}`, "warning");
        return;
      }
      autoState = {
        ...autoState,
        phase: "armed",
        nextWakeAt: undefined,
        pauseReason: undefined,
      };
      persistAutoState(ctx);
      await driveAuto(ctx, "loopx_goal_setup_settled");
      return;
    }
    if (autoState.phase === "running") {
      autoState = {
        ...autoState,
        phase: "armed",
        nextWakeAt: undefined,
        pauseReason: undefined,
      };
      persistAutoState(ctx);
      await driveAuto(ctx, "agent_settled");
      return;
    }
    if (autoState.phase === "armed") {
      await driveAuto(ctx, "agent_settled");
      return;
    }
    if (autoState.phase === "waiting" && autoState.nextWakeAt) {
      const remainingMs = Date.parse(autoState.nextWakeAt) - Date.now();
      if (remainingMs <= 0) await driveAuto(ctx, "agent_settled_due_wait");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    clearAutoTimer();
    cancelAutoPlan();
    autoGeneration += 1;
    autoState = restoreAutoState(ctx);
    if (autoState.enabled) {
      pauseAuto(ctx, "tree navigation requires explicit /loopx-auto resume", false);
    } else {
      updateAutoStatus(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    clearAutoTimer();
    cancelAutoPlan();
    autoGeneration += 1;
  });

  pi.on("session_start", async (event, ctx) => {
    autoState = restoreAutoState(ctx);
    if (!supportsAutoMode(ctx) && autoState.enabled) {
      autoState = {
        ...autoState,
        enabled: false,
        phase: "paused",
        pauseReason: "auto continuation is disabled outside TUI/RPC mode",
      };
    } else if (autoState.project !== ctx.cwd && autoState.enabled) {
      pauseAuto(ctx, "saved controller project does not match this session", false);
    } else if (event.reason === "fork" && autoState.enabled) {
      pauseAuto(ctx, "forked session requires explicit /loopx-auto resume", false);
    } else if (autoState.enabled && ["activating", "planning", "running"].includes(autoState.phase)) {
      pauseAuto(ctx, "previous dispatch outcome is uncertain; resume explicitly", false);
    } else if (autoState.enabled && autoState.phase === "waiting" && autoState.nextWakeAt) {
      const remainingSeconds = Math.max(
        MIN_AUTO_WAKE_SECONDS,
        Math.ceil((Date.parse(autoState.nextWakeAt) - Date.now()) / 1000),
      );
      scheduleAuto(ctx, remainingSeconds);
    } else if (autoState.enabled) {
      autoState = { ...autoState, phase: "armed" };
      scheduleAuto(ctx, MIN_AUTO_WAKE_SECONDS);
    }
    updateAutoStatus(ctx);
    try {
      const result = await pi.exec(LOOPX_BIN, ["version"], { cwd: ctx.cwd, timeout: 5000 });
      if (result.code === 0) ctx.ui.setStatus("loopx-pi", result.stdout.trim());
    } catch {
      ctx.ui.setStatus("loopx-pi", "LoopX unavailable");
    }
  });
}
