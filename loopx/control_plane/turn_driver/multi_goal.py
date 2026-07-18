from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any

from .driver import LOOPX_TURN_PLAN_SCHEMA_VERSION, LoopXTurnRoute


LOOPX_MULTI_GOAL_TURN_PLAN_SCHEMA_VERSION = "loopx_multi_goal_turn_plan_v0"
LOOPX_MULTI_GOAL_SELECTION_SCHEMA_VERSION = "loopx_multi_goal_selection_v0"
CURRENT_SESSION = "current_session"
REQUIRES_ISOLATED_SESSION = "requires_isolated_session"
WORKSPACE_DISPOSITIONS = {CURRENT_SESSION, REQUIRES_ISOLATED_SESSION}
RUNNABLE_ROUTES = {
    LoopXTurnRoute.READY_FOR_HOST.value,
    LoopXTurnRoute.REPAIR_REQUIRED.value,
    LoopXTurnRoute.REPLAN_REQUIRED.value,
}


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _compact_text(value: Any, *, limit: int = 320) -> str | None:
    text = " ".join(str(value or "").split())
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _candidate_row(candidate: Mapping[str, Any]) -> dict[str, Any]:
    goal_id = str(candidate.get("goal_id") or "").strip()
    turn_plan = _mapping(candidate.get("turn_plan"))
    route = _mapping(turn_plan.get("route"))
    envelope = _mapping(turn_plan.get("turn_envelope"))
    action = _mapping(envelope.get("action"))
    scheduler = _mapping(envelope.get("scheduler"))
    transaction = _mapping(turn_plan.get("transaction"))
    selected_todo = _mapping(route.get("selected_todo"))
    route_kind = str(route.get("kind") or LoopXTurnRoute.CONTRACT_ERROR.value)
    workspace_disposition = str(candidate.get("workspace_disposition") or "")
    errors: list[str] = []

    if not goal_id:
        errors.append("goal_id_missing")
    if turn_plan.get("schema_version") != LOOPX_TURN_PLAN_SCHEMA_VERSION:
        errors.append("turn_plan_schema_mismatch")
    envelope_goal_id = str(envelope.get("goal_id") or "").strip()
    if goal_id and envelope_goal_id != goal_id:
        errors.append("turn_plan_goal_id_mismatch")
    if (
        turn_plan.get("ok") is not True
        or route_kind == LoopXTurnRoute.CONTRACT_ERROR.value
    ):
        errors.append("turn_plan_contract_error")
    if workspace_disposition not in WORKSPACE_DISPOSITIONS:
        errors.append("workspace_disposition_invalid")

    scheduler_action = str(scheduler.get("action") or "").strip()
    terminal = scheduler_action == "stop_until_explicit_resume"
    runnable = route_kind in RUNNABLE_ROUTES and not errors and not terminal
    row: dict[str, Any] = {
        "goal_id": goal_id or None,
        "route": route_kind,
        "workspace_disposition": workspace_disposition or None,
        "runnable": runnable,
        "terminal": terminal,
        "scheduler_action": scheduler_action or None,
        "cadence_class": scheduler.get("cadence_class"),
        "wake_after_seconds": _positive_int(candidate.get("wake_after_seconds")),
    }
    if transaction.get("turn_key"):
        row["turn_key"] = str(transaction["turn_key"])
    if envelope.get("effective_action"):
        row["effective_action"] = str(envelope["effective_action"])
    if selected_todo:
        row["selected_todo"] = {
            key: selected_todo[key]
            for key in (
                "todo_id",
                "priority",
                "task_class",
                "action_kind",
                "text",
                "text_ref",
            )
            if selected_todo.get(key) is not None
        }
    primary_action = _compact_text(action.get("primary_action"))
    if primary_action:
        row["primary_action"] = primary_action
    error = _compact_text(turn_plan.get("error"))
    if error:
        row["error"] = error
    if errors:
        row["contract_errors"] = list(dict.fromkeys(errors))
        row["runnable"] = False
    return {key: value for key, value in row.items() if value not in (None, "", [], {})}


def _rotate(
    rows: list[dict[str, Any]], after_goal_id: str | None
) -> tuple[list[dict[str, Any]], str]:
    cursor = str(after_goal_id or "").strip()
    if not cursor:
        return rows, "not_set"
    index = next(
        (position for position, row in enumerate(rows) if row.get("goal_id") == cursor),
        None,
    )
    if index is None:
        return rows, "reset_unknown_goal"
    return [*rows[index + 1 :], *rows[: index + 1]], "applied"


def _plan_id(
    *,
    rows: Sequence[Mapping[str, Any]],
    after_goal_id: str | None,
    disposition: str,
    selected_goal_id: str | None,
) -> str:
    source = {
        "rows": list(rows),
        "after_goal_id": after_goal_id,
        "disposition": disposition,
        "selected_goal_id": selected_goal_id,
    }
    encoded = json.dumps(
        source,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()[:24]


def build_multi_goal_turn_plan(
    candidates: Sequence[Mapping[str, Any]],
    *,
    after_goal_id: str | None = None,
) -> dict[str, Any]:
    """Select one current-session Turn from already governed single-goal plans.

    The selector does not reinterpret quota or todo state. Every candidate must
    carry a canonical ``loopx_turn_plan_v0`` plus an explicit workspace
    disposition supplied by the host-facing CLI layer.
    """

    rows = [_candidate_row(candidate) for candidate in candidates]
    goal_ids = [str(row.get("goal_id") or "") for row in rows]
    duplicate_goal_ids = sorted(
        goal_id for goal_id in set(goal_ids) if goal_id and goal_ids.count(goal_id) > 1
    )
    rotated, cursor_status = _rotate(rows, after_goal_id)
    contract_error_rows = [row for row in rows if row.get("contract_errors")]

    selected: dict[str, Any] | None = None
    disposition: str
    reason_code: str
    ok = True

    if not rows:
        disposition = "contract_error"
        reason_code = "multi_goal_candidate_set_empty"
        ok = False
    elif duplicate_goal_ids:
        disposition = "contract_error"
        reason_code = "multi_goal_candidate_ids_duplicate"
        ok = False
    elif contract_error_rows:
        disposition = "contract_error"
        reason_code = "candidate_turn_plan_invalid"
        ok = False
    else:
        current_runnable = [
            row
            for row in rotated
            if row.get("runnable") is True
            and row.get("workspace_disposition") == CURRENT_SESSION
        ]
        user_action = [
            row
            for row in rotated
            if row.get("route") == LoopXTurnRoute.USER_ACTION_REQUIRED.value
            and not row.get("terminal")
        ]
        isolated_runnable = [
            row
            for row in rotated
            if row.get("runnable") is True
            and row.get("workspace_disposition") == REQUIRES_ISOLATED_SESSION
        ]
        nonterminal = [row for row in rotated if row.get("terminal") is not True]
        if current_runnable:
            disposition = "run_current_session"
            reason_code = "round_robin_current_session_runnable"
            selected = dict(current_runnable[0])
        elif user_action:
            disposition = "user_action_required"
            reason_code = "candidate_user_gate_blocks_continuation"
            selected = dict(user_action[0])
        elif isolated_runnable:
            disposition = "requires_isolated_session"
            reason_code = "runnable_goal_outside_current_session_workspace"
            selected = dict(isolated_runnable[0])
        elif nonterminal:
            disposition = "wait"
            reason_code = "no_candidate_currently_runnable"
        else:
            disposition = "terminal_stop"
            reason_code = "all_candidate_goals_terminal_no_followup"

    selected_goal_id = str((selected or {}).get("goal_id") or "") or None
    wake_delays = [
        delay
        for row in rows
        if row.get("terminal") is not True
        for delay in [_positive_int(row.get("wake_after_seconds"))]
        if delay is not None
    ]
    wake_after_seconds = min(wake_delays) if wake_delays else None
    plan_id = _plan_id(
        rows=rows,
        after_goal_id=after_goal_id,
        disposition=disposition,
        selected_goal_id=selected_goal_id,
    )
    selection: dict[str, Any] = {
        "schema_version": LOOPX_MULTI_GOAL_SELECTION_SCHEMA_VERSION,
        "disposition": disposition,
        "reason_code": reason_code,
        "selected": selected,
        "after_goal_id": str(after_goal_id or "").strip() or None,
        "cursor_status": cursor_status,
        "next_after_goal_id": selected_goal_id
        or (str(after_goal_id or "").strip() or None),
        "selection_order": [row.get("goal_id") for row in rotated],
    }
    if wake_after_seconds is not None and disposition == "wait":
        selection["wake_after_seconds"] = wake_after_seconds

    payload: dict[str, Any] = {
        "ok": ok,
        "schema_version": LOOPX_MULTI_GOAL_TURN_PLAN_SCHEMA_VERSION,
        "mode": "plan",
        "plan_id": plan_id,
        "goal_count": len(rows),
        "selection": selection,
        "candidates": rows,
        "effects": {
            "host_invoked": False,
            "state_written": False,
            "scheduler_acknowledged": False,
            "quota_spent": False,
        },
        "boundary": {
            "read_only": True,
            "single_host_turn_max": 1,
            "quota_reinterpreted": False,
            "todo_selected_by_host": False,
            "cross_workspace_execution_allowed": False,
            "terminal_requires_all_candidates": True,
        },
    }
    if duplicate_goal_ids:
        payload["error"] = (
            f"duplicate candidate goal ids: {', '.join(duplicate_goal_ids)}"
        )
    elif contract_error_rows:
        payload["error"] = "one or more candidate Turn plans failed closed"
    elif not rows:
        payload["error"] = "at least one candidate goal is required"
    return payload
