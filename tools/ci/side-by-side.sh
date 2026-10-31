#!/usr/bin/env bash
# Runs each argument, a command line, at the same time, then prints each one's
# output whole and in the order given, so the log reads as if they had run one
# after another. Exits 1 if any of them failed, naming which.
#
# For the `static` job: format, typecheck and lint each keep one core busy on
# a four-core runner, so side by side they take about as long as the slowest.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: side-by-side.sh '<command>' ['<command>' ...]" >&2
  exit 2
fi

for at in $(seq 1 "$#"); do
  # An unset variable in the workflow becomes '': the check it named would never run.
  command="${!at}"
  if [ -z "${command//[[:space:]]/}" ]; then
    echo "side-by-side.sh: command $at is empty" >&2
    exit 2
  fi
done

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

pids=()
for at in $(seq 1 "$#"); do
  bash -o pipefail -c "${!at}" > "$out/$at.log" 2>&1 &
  pids+=("$!")
done

failed=()
for at in $(seq 1 "$#"); do
  wait "${pids[$((at - 1))]}"
  status=$?
  echo "::group::${!at} (exit $status)"
  cat "$out/$at.log"
  echo "::endgroup::"
  if [ "$status" -ne 0 ]; then
    failed+=("${!at}")
    # Outside the group, so a failure's output is in view without opening it.
    tail -n 40 "$out/$at.log"
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  printf '::error::failed: %s\n' "${failed[@]}"
  exit 1
fi
