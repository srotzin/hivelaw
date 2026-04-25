#!/usr/bin/env bash
# CI guard — fail the build if the leaked HIVE_INTERNAL_KEY ever reappears
# in source, OR if a hardcoded `||` fallback for the internal key is added.
#
# Rotated 2026-04-25 after castle-seal Spectral key ceremony.
# Prior leaked key: hive_internal_125e04e0...327d46
#
# HiveFilter: 22/22

set -euo pipefail

LEAKED_FRAGMENT='125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

EXCLUDES='--exclude-dir=node_modules --exclude-dir=.git --exclude=check-no-leaked-key.sh'

if grep -rn $EXCLUDES "$LEAKED_FRAGMENT" "$ROOT" >/dev/null 2>&1; then
  echo "❌ Leaked HIVE_INTERNAL_KEY fragment detected in source!"
  grep -rn $EXCLUDES "$LEAKED_FRAGMENT" "$ROOT" || true
  echo
  echo "Rotated 2026-04-25. The previous key is DEAD. Read from env via src/lib/internal-key.js"
  exit 1
fi

if grep -rEn $EXCLUDES "process\.env\.(HIVE_INTERNAL_KEY|HIVE_KEY) *\|\| *['\"]hive_internal_" "$ROOT" >/dev/null 2>&1; then
  echo "❌ Hardcoded || fallback for internal key detected — fail closed only."
  grep -rEn $EXCLUDES "process\.env\.(HIVE_INTERNAL_KEY|HIVE_KEY) *\|\| *['\"]hive_internal_" "$ROOT" || true
  echo
  echo "Use getInternalKey() from src/lib/internal-key.js instead — it throws on missing env."
  exit 1
fi

echo "✓ No leaked-key fragments and no hardcoded internal-key fallbacks."
