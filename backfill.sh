#!/bin/sh
# backfill.sh — archive the whole station history in rounds of $HBA_BATCH recordings.
#
# One long run is fragile (the P2P session dies after a few dozen downloads), so every round is a fresh
# process with its own session, index and recovery. The loop stops as soon as a round has nothing left
# to do. Run it detached:
#
#   setsid ./backfill.sh < /dev/null > /dev/null 2>&1 &
#
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
STATE_DIR=${HBA_STATE_DIR:-$HOME/.local/state/homebase2-archive}
LOG="$STATE_DIR/backfill.log"
BATCH=${HBA_BATCH:-400}
MAX_ROUNDS=${HBA_MAX_ROUNDS:-60}

mkdir -p "$STATE_DIR"
cd "$HERE" || exit 1

echo "$(date -Iseconds) backfill started: $BATCH clips per round, max $MAX_ROUNDS rounds" >>"$LOG"

round=1
rounds_done=0
aborts=0
while [ "$round" -le "$MAX_ROUNDS" ]; do
  start_line=$(wc -l <"$LOG" | tr -d ' ')
  "$HERE/run.sh" --limit "$BATCH" >>"$LOG" 2>&1
  status=$?
  this_round=$(tail -n +"$((start_line + 1))" "$LOG")
  summary=$(printf '%s\n' "$this_round" | grep " summary: " | tail -n 1)

  # A round that archives nothing and fails nothing means the pending list is empty.
  case "$summary" in
  *"archived=0 failed=0"*)
    echo "$(date -Iseconds) round $round: nothing left to do — backfill finished" >>"$LOG"
    rounds_done=$round
    break
    ;;
  esac

  if [ "$status" -ne 0 ] || [ -z "$summary" ]; then
    aborts=$((aborts + 1))
    echo "$(date -Iseconds) round $round: aborted (status $status, $aborts/3)" >>"$LOG"
    if [ "$aborts" -ge 3 ]; then
      echo "$(date -Iseconds) three rounds failed in a row — backfill stops" >>"$LOG"
      rounds_done=$round
      break
    fi
  else
    aborts=0
    echo "$(date -Iseconds) round $round:$(printf '%s' "$summary" | sed 's/.* summary:[[:space:]]*/ /')" >>"$LOG"
  fi
  round=$((round + 1))
done

rounds_done=${rounds_done:-$((round - 1))}
echo "$(date -Iseconds) backfill finished after $rounds_done round(s)" >>"$LOG"
