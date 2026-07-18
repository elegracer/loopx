# LoopX Pi Adapter

Opt-in pi package for using LoopX as the durable control plane while pi performs
visible, bounded interactive work.

## Install

From a LoopX checkout or release snapshot:

```bash
loopx-pi-install
```

Contributors can run `scripts/install-pi-package.sh` directly from a checkout.

Then run `/reload` in an already open pi session. The script syncs the reviewed
package into the stable managed path `~/.local/share/loopx/pi-package` before
registering it, so LoopX release snapshot updates do not create a new pi package
identity. It refuses to replace an unmarked existing directory. After the new
package is registered, it unregisters the known legacy
`~/.pi/agent/packages/loopx-pi` entry only when that manifest exactly matches
`loopx-pi-adapter@0.1.0`; it does not delete the legacy directory or migrate an
unknown package. The script does not change LoopX's Codex, Claude Code, manual,
or custom-agent integrations.

## Resources

- `extensions/loopx.ts`: the canonical `/loopx`, `/loopx-global-*`, and
  `/loopx-pr-review` commands; migration aliases; Pi-only `/loopx-turn`,
  `/loopx-auto`, `/loopx-status`; and the structured `loopx_control` tool.
- `skills/loopx-pi/SKILL.md`: pi-specific lifecycle, quota, todo, vision,
  writeback, and safety rules.
- `skills/loopx-pr-review/SKILL.md`: the upstream read-only PR queue and
  five-block evidence review contract.

## Requirements

- pi 0.80.10+
- LoopX 0.2.7+ on `PATH`
- Python 3.11+

The adapter preserves the canonical LoopX entry behavior:

- Bare `/loopx` inspects connected state or returns a guided connection preview
  without mutation.
- `/loopx <goal>` starts or reuses a goal and automatically arms persistent
  continuation for that goal after the setup turn settles. The default budget
  is 20 dispatched turns.
- `/loopx-turn` runs one manually requested, quota-gated work segment.

The canonical manager and review commands match `loopx slash-commands`:

- `/loopx-global-summary`, `/loopx-global-gates`, `/loopx-global-todos`, and
  `/loopx-global-risks` run and validate the same public-safe
  `loopx --format json global-summary` packet first, then ask Pi to render the
  requested read-only view.
- `/loopx-pr-review` runs and validates the complete JSON PR-review packet
  before Pi reads per-PR evidence. It preserves both lifecycle groups, the
  blank five-block templates, evidence commands, and completeness contract.
- Legacy `/loop-global-*` inputs are accepted and canonicalized without being
  advertised as primary commands. Unknown `/loopx-*` inputs fail closed to
  `loopx slash-commands` help instead of becoming ordinary chat.
- `/loopx-turn`, `/loopx-auto`, and `/loopx-status` are Pi-only additive
  controls; they do not replace an upstream canonical command.

Auto mode persists its controller state in the pi session, uses LoopX's typed
multi-goal plan and scheduler-derived cadence, and dispatches at most one
current-workspace turn after `agent_settled`. `/loopx-auto status`, `resume`,
`tick`, and `stop` inspect or control the loop. `/loopx-auto start [goal-id ...]
[--max-turns N]` explicitly replaces the active goal scope or budget; omit goal
ids to use all project goals. The hard maximum is 100 turns. A direct
`/loopx-auto start` in a new empty session requires one prior normal turn, while
`/loopx <goal>` uses its own setup response to establish durable session state.

The adapter never installs a daemon, cron job, detached worker, or external
heartbeat automation. Its timer exists only inside the visible pi process and
is cleared on session shutdown. Manual input pauses it. User gates, uncertain
resume/fork state, contract errors, an unchanged per-goal turn key after a
dispatch, exhausted turn budget, and runnable goals in another workspace also
pause it. Start a separate pi session in the canonical
workspace for an isolated goal; the current session never executes it.

For delivery in a repository other than the connected goal project, pass
`deliveryWorkspace` to `refresh_state` and `spend_slot`. Material refreshes must
also provide a valid agent vision patch, or `visionUnchangedReason` after a
baseline exists.

## Environment

- `LOOPX_BIN`: override the LoopX executable (default: `loopx`).
- `LOOPX_PI_AGENT_ID`: override the registered LoopX agent id (default:
  `pi-main`).
