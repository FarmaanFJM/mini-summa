#!/usr/bin/env bash
# Runs `claude` against an ISOLATED CLAUDE_CONFIG_DIR with the parent harness identity
# variables removed, so a test session cannot attach to, or pollute, the session that launched it.
# Credentials are NOT copied anywhere; whatever authentication the environment already provides is
# simply inherited (in the cloud sandbox that is the sandbox's own token; on a normal machine an
# isolated config dir starts logged out and needs an interactive /login).
# usage: claude-isolated.sh CONFIG_DIR [claude args...]
set -euo pipefail
cfg="$1"; shift
unset_args=()
while IFS='=' read -r name _; do
  case "$name" in
    CLAUDECODE|CLAUDE_PID|SESSION_INGRESS_URL|CLAUDE_CODE_*|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_ADDITIONAL_DIRECTORIES|CLAUDE_AUTO*|CLAUDE_EFFORT|CLAUDE_ENABLE_STREAM_WATCHDOG)
      unset_args+=("-u" "$name");;
  esac
done < <(env)
exec env "${unset_args[@]}" CLAUDE_CONFIG_DIR="$cfg" claude "$@"
