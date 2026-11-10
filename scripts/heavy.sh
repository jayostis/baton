#!/usr/bin/env bash
# A semaphore on this machine's heavy local commands (tests, builds, lint, docker): heavy.sh <command...> takes one of
# `heavy_slots` slots (scripts/machine.mjs), waits for a free one, runs the command, and gives the slot back on exit,
# including on a signal, after the command and everything it started are gone (it runs in its own process group, which a
# signal takes down whole). A slot is a folder under $BATON_HEAVY_DIR (default <tmp>/baton-heavy) holding the pid of its
# owner; a slot whose owner is dead is taken over. The slot count is BATON_HEAVY_SLOTS, else the limits file the dispatch hook
# writes from the project config, else the machine's own (scripts/machine.mjs); with none of them readable, one slot.
# Called from the Bash tool with `timeout: 600000`: it waits for a slot as long as the suites ahead of it run. pytest's `-n auto` is sized to this command's share of the cpus.
# It also appends heavy-wait, heavy-start and heavy-end to the epic's event log (scripts/event.mjs): the command's first 120
# characters, the seconds waited for a slot, the wall seconds, the cpu seconds of the command and its children, the exit
# code. bash's `times` gives the cpu where it counts a child's (Linux, macOS); Git Bash does not total a native child's,
# so there the cpu is the machine's busy time over the run (machine_cpu_s), an upper bound. BATON_EVENTS=0 turns it off.
set -u

if [ $# -eq 0 ]; then echo "usage: heavy.sh <command...>" >&2; exit 2; fi
if [ -n "${BATON_HEAVY_HELD:-}" ] || [ "${BATON_MACHINE:-}" = "0" ]; then exec "$@"; fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib/events.sh"
read -r slots _ _ cpus < <(node "$here/machine.mjs" 2>/dev/null)
case "${slots:-}" in ''|*[!0-9]*|0) slots=1 ;; esac
case "${cpus:-}" in ''|*[!0-9]*|0) cpus=1 ;; esac
dir="${BATON_HEAVY_DIR:-${TMPDIR:-/tmp}/baton-heavy}"
mkdir -p "$dir"

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

# A slot with no pid yet is being written; one still without after a minute was left by a crash.
owner_dead() {
  if [ -z "$2" ]; then [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]; return; fi
  ! alive "$2"
}

# Only one process at a time judges a slot, and it removes the slot only if the owner it judged is still the owner. A
# judge killed mid-way leaves its lock folder, which the next one takes over once it is a minute old.
reclaiming=""
reclaim() {
  local pid
  if [ -d "$1.reclaim" ] && [ -n "$(find "$1.reclaim" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir "$1.reclaim" 2>/dev/null; fi
  mkdir "$1.reclaim" 2>/dev/null || return 0
  reclaiming="$1.reclaim"
  pid="$(cat "$1/pid" 2>/dev/null)"
  if [ -d "$1" ] && owner_dead "$1" "$pid" && [ "$(cat "$1/pid" 2>/dev/null)" = "$pid" ]; then rm -rf "$1"; fi
  rmdir "$1.reclaim" 2>/dev/null; reclaiming=""
}

slot=""
cleanup() { [ -n "$reclaiming" ] && rmdir "$reclaiming" 2>/dev/null; [ -n "$slot" ] && rm -rf "$slot"; slot=""; reclaiming=""; }
trap cleanup EXIT
child=""
# On a signal the child's whole process group gets TERM, then KILL after five seconds, and the slot is freed only once the
# group is gone: a suite's workers and grandchildren must not run on after the slot is handed to the next caller.
stop() {
  if [ -n "$child" ]; then
    kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$child" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  exit "$1"
}
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
waited=0; [ -n "$told" ] && waited=$(( SECONDS - t0 ))
started=$SECONDS
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
# In the background so a signal reaches the trap now, and in its own process group (set -m) so the signal can take the whole
# tree; <&0 keeps the command's stdin, which a background job loses.
set -m
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
