from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PI_PACKAGE = REPO_ROOT / "integrations" / "pi"


def test_pi_package_manifest_and_resources_are_self_contained() -> None:
    manifest = json.loads((PI_PACKAGE / "package.json").read_text(encoding="utf-8"))

    assert manifest["name"] == "loopx-pi-adapter"
    assert manifest["private"] is True
    assert "pi-package" in manifest["keywords"]
    assert manifest["pi"] == {
        "extensions": ["./extensions/loopx.ts"],
        "skills": ["./skills"],
    }

    for relative_path in (
        "extensions/loopx.ts",
        "skills/loopx-pi/SKILL.md",
        "README.md",
    ):
        assert (PI_PACKAGE / relative_path).is_file(), relative_path


def test_pi_extension_covers_loopx_027_writeback_guards() -> None:
    source = (PI_PACKAGE / "extensions" / "loopx.ts").read_text(encoding="utf-8")

    for required_fragment in (
        '"--host-surface",\n        "pi"',
        '"--host-surface",\n        "generic_cli"',
        '"--scheduler-owner",\n        "agent_cli_loop"',
        '"--execution-mode",\n        "interactive"',
        '"--delivery-workspace-path"',
        '"--vision-state"',
        '"--vision-acceptance"',
        '"--vision-unchanged-reason"',
        '"--task-repository"',
        '["--registry", join(project, ".loopx", "registry.json")]',
        "cwd: plan.commandCwd",
    ):
        assert required_fragment in source

    assert "automation_update" not in source
    assert "scheduler-ack" not in source


def test_pi_extension_exposes_fail_closed_persistent_multi_goal_continuation() -> None:
    source = (PI_PACKAGE / "extensions" / "loopx.ts").read_text(encoding="utf-8")

    for required_fragment in (
        'const AUTO_STATE_ENTRY = "loopx-pi-auto-state"',
        'pi.registerCommand("loopx-auto"',
        "startGoalPreviewArgs(ctx.cwd, goalText)",
        'phase: "activating"',
        "goalIds: [goalId]",
        'driveAuto(ctx, "loopx_goal_setup_settled")',
        'join(state.project, ".loopx", "registry.json")',
        '"turn",\n    "select"',
        '"--scheduler-owner",\n    "agent_cli_loop"',
        'pi.on("agent_settled"',
        'pi.on("session_shutdown"',
        'pi.on("input"',
        "autoPlanAbort?.abort()",
        "runAutoPlan(pi, autoState, planAbort.signal)",
        "pi.appendEntry<AutoState>(AUTO_STATE_ENTRY",
        "ctx.sessionManager.getBranch()",
        "ctx.sessionManager.getSessionFile()",
        'return ctx.mode === "tui" || ctx.mode === "rpc"',
        "auto continuation is disabled outside TUI/RPC mode",
        'workspace_disposition !== "current_session"',
        'disposition === "requires_isolated_session"',
        'disposition === "user_action_required"',
        'disposition === "terminal_stop"',
        "effects.host_invoked !== false",
        "boundary.read_only !== true",
        "boundary.cross_workspace_execution_allowed !== false",
        "pi.sendUserMessage(buildAutoTurnPrompt",
        "autoState.dispatchedTurnKeysByGoal[goalId] === turnKey",
        "refusing duplicate dispatch",
        'previousPhase === "waiting" && previousPlanId === planId',
        "Number.isFinite(Date.parse(raw.nextWakeAt))",
        "Complete one normal Pi turn before /loopx-auto start",
    ):
        assert required_fragment in source

    assert "setInterval(" not in source
    assert "child_process" not in source
    assert "outer_controller" not in source


def test_pi_installer_is_explicit_and_has_a_non_mutating_preview() -> None:
    installer = REPO_ROOT / "scripts" / "install-pi-package.sh"
    result = subprocess.run(
        [str(installer), "--dry-run"],
        cwd=REPO_ROOT,
        check=True,
        text=True,
        capture_output=True,
    )

    assert "pi install" in result.stdout
    assert "integrations/pi" in result.stdout
    assert ".local/share/loopx/pi-package" in result.stdout
    assert not (REPO_ROOT / ".loopx-managed-pi-package").exists()


def test_pi_installer_uses_a_stable_managed_copy_and_rolls_back_on_failure(
    tmp_path: Path,
) -> None:
    installer = REPO_ROOT / "scripts" / "install-pi-package.sh"
    install_root = tmp_path / "loopx-share"
    capture = tmp_path / "pi-args.txt"
    fake_pi = tmp_path / "pi-ok"
    fake_pi.write_text(
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$PI_CAPTURE\"\n",
        encoding="utf-8",
    )
    fake_pi.chmod(0o755)
    env = {
        **os.environ,
        "LOOPX_PI_INSTALL_ROOT": str(install_root),
        "PI_CODING_AGENT_DIR": str(tmp_path / "pi-agent"),
        "PI_BIN": str(fake_pi),
        "PI_CAPTURE": str(capture),
    }

    subprocess.run([str(installer)], cwd=REPO_ROOT, env=env, check=True)

    target = install_root / "pi-package"
    assert (target / ".loopx-managed-pi-package").is_file()
    assert json.loads((target / "package.json").read_text(encoding="utf-8"))[
        "name"
    ] == "loopx-pi-adapter"
    assert capture.read_text(encoding="utf-8").splitlines() == [
        "install",
        str(target),
    ]

    sentinel = target / "rollback-sentinel"
    sentinel.write_text("keep", encoding="utf-8")
    failing_pi = tmp_path / "pi-fail"
    failing_pi.write_text("#!/usr/bin/env bash\nexit 9\n", encoding="utf-8")
    failing_pi.chmod(0o755)
    failed = subprocess.run(
        [str(installer)],
        cwd=REPO_ROOT,
        env={**env, "PI_BIN": str(failing_pi)},
        check=False,
    )

    assert failed.returncode != 0
    assert sentinel.read_text(encoding="utf-8") == "keep"


def test_pi_installer_migrates_only_the_known_legacy_package(
    tmp_path: Path,
) -> None:
    installer = REPO_ROOT / "scripts" / "install-pi-package.sh"
    agent_dir = tmp_path / "pi-agent"
    legacy = agent_dir / "packages" / "loopx-pi"
    legacy.mkdir(parents=True)
    (legacy / "package.json").write_text(
        json.dumps(
            {
                "name": "loopx-pi-adapter",
                "version": "0.1.0",
                "private": True,
                "pi": {
                    "extensions": ["./extensions/loopx.ts"],
                    "skills": ["./skills"],
                },
            }
        ),
        encoding="utf-8",
    )
    (agent_dir / "settings.json").write_text(
        json.dumps({"packages": ["packages/loopx-pi"]}),
        encoding="utf-8",
    )
    capture = tmp_path / "pi-args.txt"
    fake_pi = tmp_path / "pi-ok"
    fake_pi.write_text(
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$PI_CAPTURE\"\n",
        encoding="utf-8",
    )
    fake_pi.chmod(0o755)
    install_root = tmp_path / "loopx-share"
    env = {
        **os.environ,
        "LOOPX_PI_INSTALL_ROOT": str(install_root),
        "PI_CODING_AGENT_DIR": str(agent_dir),
        "PI_BIN": str(fake_pi),
        "PI_CAPTURE": str(capture),
    }

    result = subprocess.run(
        [str(installer)],
        cwd=REPO_ROOT,
        env=env,
        check=True,
        text=True,
        capture_output=True,
    )

    target = install_root / "pi-package"
    assert capture.read_text(encoding="utf-8").splitlines() == [
        "install",
        str(target),
        "remove",
        str(legacy),
    ]
    assert legacy.is_dir()
    assert "unregistered legacy source packages/loopx-pi" in result.stdout


def test_pi_installer_restores_managed_copy_when_legacy_unregister_fails(
    tmp_path: Path,
) -> None:
    installer = REPO_ROOT / "scripts" / "install-pi-package.sh"
    install_root = tmp_path / "loopx-share"
    target = install_root / "pi-package"
    target.mkdir(parents=True)
    (target / ".loopx-managed-pi-package").touch()
    sentinel = target / "rollback-sentinel"
    sentinel.write_text("keep", encoding="utf-8")

    agent_dir = tmp_path / "pi-agent"
    legacy = agent_dir / "packages" / "loopx-pi"
    legacy.mkdir(parents=True)
    (legacy / "package.json").write_text(
        json.dumps(
            {
                "name": "loopx-pi-adapter",
                "version": "0.1.0",
                "private": True,
                "pi": {
                    "extensions": ["./extensions/loopx.ts"],
                    "skills": ["./skills"],
                },
            }
        ),
        encoding="utf-8",
    )
    (agent_dir / "settings.json").write_text(
        json.dumps({"packages": ["packages/loopx-pi"]}),
        encoding="utf-8",
    )
    fake_pi = tmp_path / "pi-remove-fails"
    fake_pi.write_text(
        "#!/usr/bin/env bash\n[[ \"${1:-}\" != remove ]]\n",
        encoding="utf-8",
    )
    fake_pi.chmod(0o755)

    failed = subprocess.run(
        [str(installer)],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "LOOPX_PI_INSTALL_ROOT": str(install_root),
            "PI_CODING_AGENT_DIR": str(agent_dir),
            "PI_BIN": str(fake_pi),
        },
        check=False,
    )

    assert failed.returncode != 0
    assert sentinel.read_text(encoding="utf-8") == "keep"
