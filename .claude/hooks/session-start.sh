#!/usr/bin/env bash
#
# Phong SessionStart hook.
#
# The plugin DECLARATION travels with the repo; the install does not. `.claude/settings.json`
# names three plugins and marks them enabled, but the files live in ~/.claude/plugins/cache,
# which is per-machine — so a new clone, a new machine or a fresh cloud session gets three
# plugins that are declared, enabled and absent. Same story for node_modules.
#
# Deliberately NOT `set -e`: this hook must never fail a session. A session that cannot reach
# GitHub is still a usable session, and these plugins are agents and slash commands invoked
# deliberately, so their absence degrades nothing on its own. Warn and exit 0.
set -uo pipefail

MARKETPLACE="gamedev-claude-plugins"
MARKETPLACE_SOURCE="sponticelli/gamedev-claude-plugins"
PLUGINS=(web-games multiplayer juice)

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

log() { printf 'phong/session-start: %s\n' "$*"; }

# Read the installed set back rather than trusting an exit status: `claude plugin install`
# prints a human-readable failure, and a status read through a pipe is the pipe's, not the CLI's.
missing_plugins() {
  local listed p
  listed="$(claude plugin list 2>/dev/null)"
  for p in "${PLUGINS[@]}"; do
    grep -qF -- "${p}@${MARKETPLACE}" <<<"$listed" || printf '%s\n' "$p"
  done
}

deps_stale() {
  [ -d "$ROOT/node_modules" ] || return 0
  [ "$ROOT/package-lock.json" -nt "$ROOT/node_modules" ]
}

# Fast path: a warm container pays nothing.
if [ -z "$(missing_plugins)" ] && ! deps_stale; then
  log "plugins and dependencies already present"
  exit 0
fi

if [ -n "$(missing_plugins)" ]; then
  # The step the manual loop was missing. `extraKnownMarketplaces` makes the marketplace known
  # by NAME but never fetches it, so install fails with "not found in marketplace" until one of
  # these has run. `add` covers a machine that has never seen it; `update` covers one that has.
  log "fetching marketplace ${MARKETPLACE}"
  claude plugin marketplace add "$MARKETPLACE_SOURCE" >/dev/null 2>&1 ||
    claude plugin marketplace update "$MARKETPLACE" >/dev/null 2>&1 ||
    log "warning: could not reach ${MARKETPLACE_SOURCE}"

  # -y because `claude plugin install --help` states it is required when stdout is not a TTY,
  # which is exactly a hook.
  for p in "${PLUGINS[@]}"; do
    claude plugin install "${p}@${MARKETPLACE}" --scope project -y >/dev/null 2>&1 ||
      log "warning: install of ${p} returned non-zero"
  done
fi

if deps_stale; then
  log "installing npm dependencies"
  # `install`, not `ci`: the container image is cached after this hook, so reuse beats a wipe.
  (cd "$ROOT" && npm install --no-audit --no-fund >/dev/null 2>&1) ||
    log "warning: npm install failed — run it by hand before lint, test or build"
fi

still_missing="$(missing_plugins | tr '\n' ' ')"
if [ -n "${still_missing// /}" ]; then
  log "warning: not installed: ${still_missing}— retry with .claude/hooks/session-start.sh, or /plugin → Errors"
else
  log "plugins ready: ${PLUGINS[*]}"
fi

exit 0
