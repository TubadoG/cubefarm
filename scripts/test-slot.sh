#!/usr/bin/env bash
# One host-wide slot per heavy test command; inherited fd 9 holds it until the command exits.
cmd=${1:?Usage: test-slot.sh <command string>}
slots=${SWARM_TEST_SLOTS:-2}
if [[ ! $slots =~ ^-?[0-9]+$ ]]; then slots=2; fi
if [[ $slots == -* ]]; then slots=1; else slots=$((10#$slots)); fi
if (( slots < 1 )); then slots=1; fi
slot_dir=${SWARM_TEST_SLOT_DIR:-$HOME/.cubefarm/test-slots}
mkdir -p "$slot_dir" || exit 1

if ! command -v flock >/dev/null 2>&1; then
  echo 'test-slot: flock is not installed; slots are off' >&2
  exec nice -n 10 bash -c "$cmd"
fi

waiting=false
while true; do
  for (( slot=1; slot<=slots; slot++ )); do
    # Open without truncating another holder's diagnostic record.
    exec 9>>"$slot_dir/slot-$slot.lock" || exit 1
    if flock -n 9; then
      printf '%s %s\n' "$$" "${cmd:0:200}" >"$slot_dir/slot-$slot.lock"
      if command -v ionice >/dev/null 2>&1; then
        exec nice -n 10 ionice -c2 -n7 bash -c "$cmd"
      fi
      exec nice -n 10 bash -c "$cmd"
    fi
    exec 9>&-
  done
  if ! $waiting; then
    echo "test-slot: waiting for a free test slot ($slots in use)" >&2
    waiting=true
  fi
  sleep 5
done
