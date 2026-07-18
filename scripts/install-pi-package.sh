#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
package_source="$repo_root/integrations/pi"
install_root="${LOOPX_PI_INSTALL_ROOT:-$HOME/.local/share/loopx}"
package_target="$install_root/pi-package"
managed_marker="$package_target/.loopx-managed-pi-package"
pi_bin="${PI_BIN:-pi}"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
settings_path="$agent_dir/settings.json"
legacy_package="$agent_dir/packages/loopx-pi"

registered_source_for_path() {
  local target_path="$1"
  [[ -f "$settings_path" ]] || return 0
  python3 - "$settings_path" "$target_path" <<'PY'
import json
import sys
from pathlib import Path

settings_path = Path(sys.argv[1])
target = Path(sys.argv[2]).expanduser().resolve()
try:
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    raise SystemExit(0)
for source in settings.get("packages", []):
    if not isinstance(source, str):
        continue
    candidate = Path(source).expanduser()
    if not candidate.is_absolute():
        candidate = settings_path.parent / candidate
    if candidate.resolve() == target:
        print(source)
        break
PY
}

is_known_legacy_package() {
  [[ -f "$legacy_package/package.json" ]] || return 1
  python3 - "$legacy_package/package.json" <<'PY'
import json
import sys
from pathlib import Path

try:
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
expected_pi = {
    "extensions": ["./extensions/loopx.ts"],
    "skills": ["./skills"],
}
valid = (
    manifest.get("name") == "loopx-pi-adapter"
    and manifest.get("version") == "0.1.0"
    and manifest.get("private") is True
    and manifest.get("pi") == expected_pi
)
raise SystemExit(0 if valid else 1)
PY
}

usage() {
  printf '%s\n' \
    'Usage: scripts/install-pi-package.sh [--dry-run]' \
    '' \
    "Register the opt-in LoopX pi package in pi's user settings. This command" \
    'does not install a scheduler or modify resources for any other agent host.'
}

case "${1:-}" in
  "") ;;
  --dry-run)
    printf 'sync %q -> %q\n' "$package_source" "$package_target"
    printf '%q install %q\n' "$pi_bin" "$package_target"
    exit 0
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [[ ! -f "$package_source/package.json" ]]; then
  echo "loopx pi installer error: package not found: $package_source" >&2
  exit 1
fi

if ! command -v "$pi_bin" >/dev/null 2>&1; then
  echo "loopx pi installer error: pi executable not found: $pi_bin" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "loopx pi installer error: python3 executable not found" >&2
  exit 1
fi

legacy_source=""
if is_known_legacy_package; then
  legacy_source="$(registered_source_for_path "$legacy_package")"
fi
target_source_before="$(registered_source_for_path "$package_target")"

mkdir -p "$install_root"
if [[ -e "$package_target" && ! -f "$managed_marker" ]]; then
  echo "loopx pi installer error: refusing to replace unmanaged path: $package_target" >&2
  exit 1
fi

staging="$(mktemp -d "$install_root/.pi-package-stage.XXXXXX")"
backup=""
cleanup() {
  if [[ -n "$staging" && -d "$staging" ]]; then
    rm -rf "$staging"
  fi
}
restore_package_target() {
  rm -rf "$package_target"
  if [[ -n "$backup" && -e "$backup" ]]; then
    mv "$backup" "$package_target"
  fi
}
trap cleanup EXIT

cp -R "$package_source/." "$staging/"
touch "$staging/.loopx-managed-pi-package"

if [[ -e "$package_target" ]]; then
  backup="$install_root/.pi-package-backup.$$"
  mv "$package_target" "$backup"
fi
if ! mv "$staging" "$package_target"; then
  if [[ -n "$backup" && -e "$backup" ]]; then
    mv "$backup" "$package_target"
  fi
  exit 1
fi
staging=""

if ! "$pi_bin" install "$package_target"; then
  if [[ -z "$target_source_before" ]]; then
    "$pi_bin" remove "$package_target" >/dev/null 2>&1 || true
  fi
  restore_package_target
  exit 1
fi

if [[ -n "$legacy_source" ]]; then
  if ! "$pi_bin" remove "$legacy_package"; then
    if [[ -z "$target_source_before" ]]; then
      "$pi_bin" remove "$package_target" >/dev/null 2>&1 || true
    fi
    restore_package_target
    echo "loopx pi installer error: failed to unregister known legacy package: $legacy_source" >&2
    exit 1
  fi
  echo "loopx pi package migration: unregistered legacy source $legacy_source"
fi

if [[ -n "$backup" && -e "$backup" ]]; then
  rm -rf "$backup"
fi

echo "loopx pi package registered: $package_target"
echo "Run /reload in an already open pi session."
