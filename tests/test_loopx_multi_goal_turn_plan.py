from __future__ import annotations

import pytest

from loopx.control_plane.turn_driver import LoopXTurnRoute
from loopx.control_plane.turn_driver.multi_goal import (
    CURRENT_SESSION,
    REQUIRES_ISOLATED_SESSION,
    build_multi_goal_turn_plan,
)


def _candidate(
    goal_id: str,
    *,
    route: LoopXTurnRoute = LoopXTurnRoute.READY_FOR_HOST,
    workspace: str = CURRENT_SESSION,
    scheduler_action: str = "run_now",
    wake_after_seconds: int | None = None,
    ok: bool = True,
) -> dict:
    runnable = route in {
        LoopXTurnRoute.READY_FOR_HOST,
        LoopXTurnRoute.REPAIR_REQUIRED,
        LoopXTurnRoute.REPLAN_REQUIRED,
    }
    return {
        "goal_id": goal_id,
        "workspace_disposition": workspace,
        "wake_after_seconds": wake_after_seconds,
        "turn_plan": {
            "ok": ok,
            "schema_version": "loopx_turn_plan_v0",
            "route": {
                "kind": route.value,
                "would_invoke_host": runnable,
                "selected_todo": (
                    {
                        "todo_id": f"todo_{goal_id}",
                        "priority": "P0",
                        "task_class": "advancement_task",
                        "text": f"Advance {goal_id}",
                    }
                    if runnable
                    else None
                ),
            },
            "turn_envelope": {
                "goal_id": goal_id,
                "effective_action": "normal_run" if runnable else route.value,
                "action": {"primary_action": f"Advance {goal_id}"},
                "scheduler": {
                    "action": scheduler_action,
                    "cadence_class": "active_work" if runnable else "quiet_wait",
                },
            },
            "transaction": {"turn_key": f"sha256:{goal_id}"},
            **({"error": "fixture contract failure"} if not ok else {}),
        },
    }


def test_multi_goal_plan_selects_one_current_session_turn() -> None:
    payload = build_multi_goal_turn_plan([_candidate("goal-a"), _candidate("goal-b")])

    assert payload["ok"] is True
    assert payload["schema_version"] == "loopx_multi_goal_turn_plan_v0"
    assert payload["selection"]["disposition"] == "run_current_session"
    assert payload["selection"]["selected"]["goal_id"] == "goal-a"
    assert payload["selection"]["selected"]["turn_key"] == "sha256:goal-a"
    assert payload["selection"]["next_after_goal_id"] == "goal-a"
    assert payload["boundary"] == {
        "read_only": True,
        "single_host_turn_max": 1,
        "quota_reinterpreted": False,
        "todo_selected_by_host": False,
        "cross_workspace_execution_allowed": False,
        "terminal_requires_all_candidates": True,
    }
    assert all(value is False for value in payload["effects"].values())


def test_multi_goal_plan_rotates_after_last_selected_goal() -> None:
    candidates = [_candidate("goal-a"), _candidate("goal-b"), _candidate("goal-c")]

    second = build_multi_goal_turn_plan(candidates, after_goal_id="goal-a")
    wrapped = build_multi_goal_turn_plan(candidates, after_goal_id="goal-c")

    assert second["selection"]["selection_order"] == ["goal-b", "goal-c", "goal-a"]
    assert second["selection"]["selected"]["goal_id"] == "goal-b"
    assert wrapped["selection"]["selection_order"] == ["goal-a", "goal-b", "goal-c"]
    assert wrapped["selection"]["selected"]["goal_id"] == "goal-a"


def test_unknown_cursor_resets_without_changing_candidate_order() -> None:
    payload = build_multi_goal_turn_plan(
        [_candidate("goal-a"), _candidate("goal-b")],
        after_goal_id="retired-goal",
    )

    assert payload["selection"]["cursor_status"] == "reset_unknown_goal"
    assert payload["selection"]["selection_order"] == ["goal-a", "goal-b"]
    assert payload["selection"]["selected"]["goal_id"] == "goal-a"


def test_current_session_work_precedes_an_isolated_workspace_handoff() -> None:
    payload = build_multi_goal_turn_plan(
        [
            _candidate("other-project", workspace=REQUIRES_ISOLATED_SESSION),
            _candidate("current-project"),
        ]
    )

    assert payload["selection"]["disposition"] == "run_current_session"
    assert payload["selection"]["selected"]["goal_id"] == "current-project"


def test_isolated_runnable_goal_never_runs_in_the_current_session() -> None:
    payload = build_multi_goal_turn_plan(
        [_candidate("other-project", workspace=REQUIRES_ISOLATED_SESSION)]
    )

    assert payload["ok"] is True
    assert payload["selection"]["disposition"] == "requires_isolated_session"
    assert payload["selection"]["selected"]["goal_id"] == "other-project"
    assert payload["selection"]["selected"]["runnable"] is True
    assert payload["effects"]["host_invoked"] is False


def test_user_gate_pauses_before_requesting_an_isolated_session() -> None:
    payload = build_multi_goal_turn_plan(
        [
            _candidate(
                "current-gate",
                route=LoopXTurnRoute.USER_ACTION_REQUIRED,
                scheduler_action="backoff_waiting_for_user",
            ),
            _candidate("other-project", workspace=REQUIRES_ISOLATED_SESSION),
        ]
    )

    assert payload["selection"]["disposition"] == "user_action_required"
    assert payload["selection"]["selected"]["goal_id"] == "current-gate"


def test_wait_uses_the_earliest_loopx_derived_cadence() -> None:
    payload = build_multi_goal_turn_plan(
        [
            _candidate(
                "goal-a",
                route=LoopXTurnRoute.WAIT,
                scheduler_action="backoff_until_state_change",
                wake_after_seconds=1800,
            ),
            _candidate(
                "goal-b",
                route=LoopXTurnRoute.BLOCKED,
                scheduler_action="backoff_until_fresh_evidence",
                wake_after_seconds=3600,
            ),
        ]
    )

    assert payload["selection"]["disposition"] == "wait"
    assert payload["selection"]["wake_after_seconds"] == 1800


def test_terminal_stop_requires_every_candidate_to_be_terminal() -> None:
    terminal = _candidate(
        "closed",
        route=LoopXTurnRoute.WAIT,
        scheduler_action="stop_until_explicit_resume",
    )
    waiting = _candidate(
        "waiting",
        route=LoopXTurnRoute.WAIT,
        scheduler_action="backoff_until_state_change",
        wake_after_seconds=900,
    )

    mixed = build_multi_goal_turn_plan([terminal, waiting])
    closed = build_multi_goal_turn_plan([terminal])

    assert mixed["selection"]["disposition"] == "wait"
    assert mixed["selection"]["wake_after_seconds"] == 900
    assert closed["selection"]["disposition"] == "terminal_stop"
    assert closed["selection"]["reason_code"] == (
        "all_candidate_goals_terminal_no_followup"
    )


@pytest.mark.parametrize(
    "candidates",
    [
        [],
        [_candidate("goal-a"), _candidate("goal-a")],
        [_candidate("goal-a", ok=False, route=LoopXTurnRoute.CONTRACT_ERROR)],
    ],
)
def test_invalid_candidate_sets_fail_closed(candidates: list[dict]) -> None:
    payload = build_multi_goal_turn_plan(candidates)

    assert payload["ok"] is False
    assert payload["selection"]["disposition"] == "contract_error"
    assert payload["effects"]["host_invoked"] is False
    assert payload["error"]


def test_plan_id_is_stable_and_changes_with_the_fairness_cursor() -> None:
    candidates = [_candidate("goal-a"), _candidate("goal-b")]

    first = build_multi_goal_turn_plan(candidates)
    repeated = build_multi_goal_turn_plan(candidates)
    advanced = build_multi_goal_turn_plan(candidates, after_goal_id="goal-a")

    assert first["plan_id"] == repeated["plan_id"]
    assert first["plan_id"] != advanced["plan_id"]
