# Sourced by heavy.sh, wait-ci.sh and gate.sh: `ev <kind> [k=v ...]` appends an event to the epic's log
# (scripts/event.mjs). It prints nothing and fails never; BATON_EVENTS=0 turns it off. Needs $here, the scripts folder.
ev() { [ "${BATON_EVENTS:-}" = "0" ] || [ "${BATON_MACHINE:-}" = "0" ] || node "$here/event.mjs" "$@" 2>/dev/null; return 0; }
