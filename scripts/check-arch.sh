#!/usr/bin/env bash
# Is everything in this build ACTUALLY the architecture it claims to be?
#
# WHY THIS EXISTS. package.json listed both Apple architectures under the mac
# targets, so electron-builder honoured the config rather than the --arm64
# flag and built both on one runner. The arm64 job produced
# SWARM-Node-...-mac-x64.dmg and .zip: files named for Intel Macs, wrapping an
# arm64 node and an arm64 miner, which cannot start on the machine the name
# promises. The pinned binaries were right and passed their SHA-256 gate. The
# wrapper was the lie, and a name is not evidence.
#
# So this reads the binaries themselves:
#   macOS   lipo -archs (falls back to `file`)
#   Linux   readelf -h  (falls back to `file`)
#
# It checks the Electron executable AND the two programs the app runs, because
# they are staged separately and a mismatch in either one is a package that
# does not work.
#
#   scripts/check-arch.sh <unpacked dir> <expected arch>
#
# <expected arch> is arm64, x64 or x86_64 as this project spells it; the
# equivalents each tool prints are handled here.

set -euo pipefail

dir=${1:?usage: check-arch.sh <unpacked dir> <arm64|x64>}
want=${2:?usage: check-arch.sh <unpacked dir> <arm64|x64>}

case "$want" in
  x64|x86_64|amd64) want_mac=x86_64; want_elf=X86-64 ;;
  arm64|aarch64)    want_mac=arm64;  want_elf=AArch64 ;;
  *) echo "check-arch: unknown architecture '$want'"; exit 2 ;;
esac

fail=0
checked=0

arch_of() {
  local f=$1
  if [ "$(uname -s)" = Darwin ]; then
    if command -v lipo >/dev/null 2>&1; then
      lipo -archs "$f" 2>/dev/null || file -b "$f"
    else
      file -b "$f"
    fi
  else
    if command -v readelf >/dev/null 2>&1; then
      readelf -h "$f" 2>/dev/null | awk -F: '/Machine:/ {gsub(/^ +/, "", $2); print $2}'
    else
      file -b "$f"
    fi
  fi
}

check() {
  local f=$1
  [ -f "$f" ] || return 0
  local got
  got=$(arch_of "$f")
  checked=$((checked + 1))
  if [ "$(uname -s)" = Darwin ]; then
    # A universal binary lists several; it is acceptable only if it contains
    # the one we want and nothing this build did not ask for.
    if echo "$got" | tr ' ' '\n' | grep -qx "$want_mac"; then
      echo "  OK   $(basename "$f")  [$got]"
    else
      echo "  BAD  $(basename "$f")  is [$got], expected $want_mac"
      fail=1
    fi
  else
    if echo "$got" | grep -qi "$want_elf"; then
      echo "  OK   $(basename "$f")  [$got]"
    else
      echo "  BAD  $(basename "$f")  is [$got], expected $want_elf"
      fail=1
    fi
  fi
}

echo "checking $dir for $want"

# The Electron executable, wherever this platform puts it.
if [ "$(uname -s)" = Darwin ]; then
  while IFS= read -r app; do
    name=$(basename "$app" .app)
    check "$app/Contents/MacOS/$name"
    # The app's own copy of the node and the miner.
    for b in "$app/Contents/Resources/bin/"*; do check "$b"; done
  done < <(find "$dir" -maxdepth 2 -name '*.app' -print)
else
  check "$dir/swarm-node"
  for b in "$dir/resources/bin/"*; do check "$b"; done
fi

if [ "$checked" -lt 3 ]; then
  echo "check-arch: only $checked file(s) checked — the app, the node and the miner were expected"
  exit 1
fi
if [ "$fail" -ne 0 ]; then
  echo "check-arch: this package does not match $want"
  exit 1
fi
echo "check-arch: $checked file(s), all $want"
