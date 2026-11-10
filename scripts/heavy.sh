#!/usr/bin/env bash
# A semaphore on this machine's heavy local commands (tests, builds, lint, docker): heavy.sh <command...> takes one of
# `heavy_slots` slots (scripts/machine.mjs), waits for a free one, runs the command, and gives the slot back on exit,
# including on a signal. A slot is a folder under $BATON_HEAVY_DIR (default <tmp>/baton-heavy) holding the pid of its
# owner; a slot whose owner is dead is taken over. pytest's `-n auto` is sized to this command's share of the cpus.
# It also appends heavy-wait, heavy-start and heavy-end to the epic's event log (scripts/event.mjs): the command's first 120
# characters, the seconds waited for a slot, the wall seconds, the cpu seconds of the command and its children, the exit
# code. bash's `times` gives the cpu where it counts a child's (Linux, macOS); Git Bash does not total a native child's,
# so there the cpu is the machine's busy time over the run (machine_cpu_s), an upper bound. BATON_EVENTS=0 turns it off.
set -u

if [ $# -eq 0 ]; then echo "usage: heavy.sh <command...>" >&2; exit 2; fi
if [ -n "${BATON_HEAVY_HELD:-}" ] || [ "${BATON_MACHINE:-}" = "0" ]; then exec "$@"; fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib/events.sh"
read -r slots _ _ cpus < <(node "$here/machine.mjs")
dir="${BATON_HEAVY_DIR:-${TMPDIR:-/tmp}/baton-heavy}"
mkdir -p "$dir"

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

# A slot with no pid yet is being written; one still without after a minute was left by a crash.
owner_dead() {
  local pid; pid="$(cat "$1/pid" 2>/dev/null)"
  if [ -z "$pid" ]; then [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]; return; fi
  ! alive "$pid"
}

reclaim() {
  # Only one process at a time may judge and remove a slot, or a new owner's slot could be removed by a late judge.
  mkdir "$1.reclaim" 2>/dev/null || return 0
  if [ -d "$1" ] && owner_dead "$1"; then rm -rf "$1"; fi
  rmdir "$1.reclaim"
}

slot=""
cleanup() { [ -n "$slot" ] && rm -rf "$slot"; slot=""; }
trap cleanup EXIT
child=""
# On a signal the child goes too and the slot is freed at once, not when the child would have ended.
stop() { [ -n "$child" ] && kill -TERM "$child" 2>/dev/null; [ -n "$child" ] && wait "$child" 2>/dev/null; exit "$1"; }
trap 'stop 130' INT
trap 'stop 143' TERM

told=""
t0=$SECONDS
while [ -z "$slot" ]; do
  for i in $(seq 1 "$slots"); do
    s="$dir/slot-$i"
    [ -d "$s" ] && reclaim "$s"
    if mkdir "$s" 2>/dev/null; then echo "$$" > "$s/pid"; slot="$s"; break; fi
  done
  [ -n "$slot" ] && break
  if [ -z "$told" ]; then
    echo "heavy.sh: all $slots heavy slots are taken (pids: $(cat "$dir"/slot-*/pid 2>/dev/null | tr '\n' ' ')); waiting for one" >&2
    told=1
  fi
  sleep "${BATON_HEAVY_POLL:-2}"
done

export BATON_HEAVY_HELD=1
waited=$(( SECONDS - t0 )); started=$SECONDS
cmd="$*"; cmd="${cmd:0:120}"
[ "$waited" -ge 1 ] && ev heavy-wait cmd="$cmd" wait_s="$waited"
busy="$(ev heavy-start cmd="$cmd" wait_s="$waited" --busy)"
# bash's own `times`, read in this shell (in a $(...) it would be a subshell's, which has no children).
usetimes=1; case "${OSTYPE:-}" in msys*|cygwin*|win32*) [ "${BATON_HEAVY_TIMES:-}" = "1" ] || usetimes="" ;; esac
snap() { times > "$slot/times.$1"; { read -r _; read -r "$2"; } < "$slot/times.$1"; }
tb=""; ta=""
[ -n "$usetimes" ] && snap before tb
share=$(( cpus / slots )); [ "$share" -lt 1 ] && share=1
export PYTEST_XDIST_AUTO_NUM_WORKERS="${PYTEST_XDIST_AUTO_NUM_WORKERS:-$share}"
# In the background so a signal reaches the trap now; <&0 keeps the command's stdin, which a background job loses.
"$@" <&0 &
child=$!
wait "$child"
rc=$?
[ -n "$usetimes" ] && snap after ta
args=(cmd="$cmd" wait_s="$waited" wall_s="$(( SECONDS - started ))" exit="$rc")
[ -n "$ta" ] && args+=(times_before="$tb" times_after="$ta")
[ -n "$busy" ] && args+=(busy_before="$busy")
ev heavy-end "${args[@]}"
exit "$rc"
