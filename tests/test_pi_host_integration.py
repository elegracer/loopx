from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from loopx.slash_commands import build_slash_command_catalog


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
        "skills/loopx-pr-review/SKILL.md",
        "README.md",
    ):
        assert (PI_PACKAGE / relative_path).is_file(), relative_path

    assert (PI_PACKAGE / "skills" / "loopx-pr-review" / "SKILL.md").read_text(
        encoding="utf-8"
    ) == (REPO_ROOT / "skills" / "loopx-pr-review" / "SKILL.md").read_text(
        encoding="utf-8"
    )


def test_pi_extension_covers_the_upstream_canonical_command_catalog() -> None:
    source = (PI_PACKAGE / "extensions" / "loopx.ts").read_text(encoding="utf-8")
    catalog = build_slash_command_catalog(include_legacy_aliases=True)
    commands = catalog["commands"]
    canonical_names = {
        str(item["command"]).split()[0].removeprefix("/") for item in commands
    }
    legacy_names = {
        str(alias).removeprefix("/")
        for item in commands
        for alias in item.get("legacy_aliases", [])
    }

    assert canonical_names == {
        "loopx",
        "loopx-global-summary",
        "loopx-global-gates",
        "loopx-global-todos",
        "loopx-global-risks",
        "loopx-pr-review",
    }
    literal_registrations = set(
        re.findall(r'pi\.registerCommand\("([^"]+)"', source)
    )
    manager_table_names = set(
        re.findall(r'name: "(loopx-global-[^"]+)"', source)
    )
    assert canonical_names <= literal_registrations | manager_table_names
    assert "for (const spec of GLOBAL_MANAGER_COMMANDS)" in source
    assert "pi.registerCommand(spec.name" in source

    for legacy_name in legacy_names:
        assert f'legacyName: "{legacy_name}"' in source
        assert legacy_name not in literal_registrations
    assert "GLOBAL_MANAGER_BY_LEGACY_NAME.get" in source
    assert 'slash.name.startsWith("loopx-")' in source
    assert "showSlashCommandHelp(pi, ctx, slash.name)" in source


def test_pi_canonical_read_only_commands_run_the_cli_packet_first() -> None:
    source = (PI_PACKAGE / "extensions" / "loopx.ts").read_text(encoding="utf-8")

    for required_fragment in (
        'const READ_ONLY_COMMAND_TIMEOUT_MS = 300_000',
        '["--format", "json", "global-summary"]',
        '"global_manager_command_response_v0"',
        '["--format", "json", "pr-review"]',
        'new Set(["--repo", "--state", "--since", "--limit"])',
        '"loopx_pr_review_command_response_v0"',
        "assertGlobalManagerPacket(packet)",
        "assertPrReviewPacket(packet)",
        "contract?.required_packet_fields_to_preserve",
        "contract?.required_final_sections",
        "groups?.unmerged",
        "groups?.merged",
        "item.review_template",
        "item.evidence_commands",
        "assertSlashCommandCatalog(packet)",
        "slashCommandHelpText(packet, unknownName)",
        "pi.sendUserMessage(globalManagerHandoffPrompt",
        "pi.sendUserMessage(prReviewHandoffPrompt",
        '["--format", "json", "slash-commands"]',
        '"loopx_slash_command_catalog_v0"',
    ):
        assert required_fragment in source

    assert "exec(`${LOOPX_BIN}" not in source
    assert "exec(LOOPX_BIN, rawArgs" not in source


def test_pi_control_exposes_project_contract_check() -> None:
    source = (PI_PACKAGE / "extensions" / "loopx.ts").read_text(encoding="utf-8")

    assert '  "check",' in source
    assert 'case "check":' in source
    assert '["--format", "json", "check", "--scan-root", project, "--limit", limit]' in source


def test_pi_extension_covers_loopx_027_writeback_guards() -> None:
    source = (PI_PACKAGE / "extensions" / "loopx.ts").read_text(encoding="utf-8")

    for required_fragment in (
        '"--host-surface",\n    "pi"',
        '"bootstrap-command-pack"',
        '"--runtime-profile",\n        "pi"',
        '"--host",\n        "pi"',
        '"--execution-mode",\n        "interactive-visible"',
        '"--delivery-workspace-path"',
        '"--autonomous-replan-recorded"',
        '"--repair-delta-kind"',
        '"--vision-state"',
        '"--vision-acceptance"',
        '"--vision-dreaming-policy"',
        '"--vision-unchanged-reason"',
        '"review-packet"',
        '"--handoff-only"',
        '"evidence-log"',
        '"--thin"',
        '"--task-repository"',
        '["--registry", join(project, ".loopx", "registry.json")]',
        "cwd: plan.commandCwd",
    ):
        assert required_fragment in source

    assert '"single_segment"' in source
    assert '"bounded_segment"' in source

    skill_source = (PI_PACKAGE / "skills" / "loopx-pi" / "SKILL.md").read_text(encoding="utf-8")
    for scope_fragment in (
        "## Structured Action Scope",
        "Do not mirror every LoopX CLI family into this tool.",
        "global manager views and PR review use their dedicated slash commands",
        "release/update, registry retirement, global route replacement",
        "Full Pi feature parity means the visible host can complete governed LoopX outcomes",
    ):
        assert scope_fragment in skill_source

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
        '"--host",\n    "pi"',
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
        "readGoalProgressMarker",
        '"history"',
        "dispatchedProgressMarkersByGoal",
        "previousProgressMarker === progressMarker",
        'const progressClassification = progressMarker.split("|")[1] || "no-runs"',
        'ctx.ui.setStatus("loopx-pi", `LoopX | ${goalId} | ${progressClassification} | ${disposition}`)',
        "autoState.dispatchedTurnKeysByGoal[goalId] === turnKey",
        "duplicateTurnRetriesByGoal",
        "retries < 1",
        "scheduleAuto(ctx, MIN_AUTO_WAKE_SECONDS)",
        "refusing duplicate dispatch",
        'phase: "waiting"',
        'ctx.ui.setStatus("loopx-pi", `LoopX | ${selectedGoalStatus} | ${disposition || "planning"}`)',
        'previousPhase === "waiting" && previousPlanId === planId',
        "Number.isFinite(Date.parse(raw.nextWakeAt))",
        "Complete one normal Pi turn before /loopx-auto start",
    ):
        assert required_fragment in source

    assert "setInterval(" not in source
    assert "child_process" not in source
    assert "outer_controller" not in source
    assert '"--host",\n    "generic-cli"' not in source
    assert re.search(
        r'if \(autoState\.phase === "running"\) \{.*?phase: "waiting".*?scheduleAuto\(ctx, MIN_AUTO_WAKE_SECONDS\);',
        source,
        re.DOTALL,
    )


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
