#!/usr/bin/env bash
# Point-in-time recovery drill.
#
# Proves that the WAL archiving configured in compose.prod.yaml can actually
# restore the ledger to a chosen instant, and measures how long it takes. A
# backup that has never been restored is a hypothesis.
#
# ## What it does
#
#   1. starts a throwaway PostgreSQL 18 with archiving on
#   2. creates a ledger-shaped table and inserts 50,000 rows
#   3. takes a `pg_basebackup`
#   4. inserts 50,000 more rows, then records a recovery target timestamp
#   5. commits a DESTRUCTIVE change after that timestamp (deletes half the rows)
#   6. restores base backup + WAL to the recovery target, in a second container
#   7. asserts the destructive change is absent and everything before it is not
#
# ## Safety
#
# Every container, volume and port here is created by this script with a
# `daftar-drill` prefix and removed on exit. It never touches the development
# database, and the ports are deliberately not the ones compose.yaml uses.
#
# Usage:  bash scripts/wal-restore-drill.sh

set -euo pipefail

IMAGE=postgres:18-alpine
PREFIX=daftar-drill
PRIMARY="${PREFIX}-primary"
RESTORED="${PREFIX}-restored"
VOL_BASE="${PREFIX}-basebackup"
VOL_WAL="${PREFIX}-wal"
PRIMARY_PORT=55440
RESTORED_PORT=55441
PGPASSWORD_VALUE=drill

# 100k rows in two halves, so the "before" and "after" states are clearly
# different sizes and the assertion cannot pass by accident.
ROWS_BEFORE_BACKUP=50000
ROWS_AFTER_BACKUP=50000

cleanup() {
  docker rm -f "$PRIMARY" "$RESTORED" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL_BASE" "$VOL_WAL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

psql_primary() {
  docker exec -e PGPASSWORD="$PGPASSWORD_VALUE" "$PRIMARY" \
    psql -U drill -d drill -v ON_ERROR_STOP=1 -tAc "$1"
}

cleanup

say "1/7  starting the primary with archive_mode=on"

docker volume create "$VOL_BASE" >/dev/null
docker volume create "$VOL_WAL" >/dev/null

docker run -d --name "$PRIMARY" \
  -e POSTGRES_USER=drill \
  -e POSTGRES_PASSWORD="$PGPASSWORD_VALUE" \
  -e POSTGRES_DB=drill \
  -e POSTGRES_INITDB_ARGS='--encoding=UTF8 --locale=C' \
  -p "127.0.0.1:${PRIMARY_PORT}:5432" \
  -v "${VOL_WAL}:/wal-archive" \
  "$IMAGE" \
  postgres \
  -c wal_level=replica \
  -c archive_mode=on \
  -c "archive_command=test ! -f /wal-archive/%f && cp %p /wal-archive/%f" \
  -c archive_timeout=30 \
  -c max_wal_senders=4 \
  -c timezone=UTC \
  >/dev/null

# The archive directory is created by the volume mount as root, and postgres
# runs as uid 70 in the alpine image — so `archive_command` would fail with a
# permission error on the very first segment. Fixed before the server needs it.
docker exec -u root "$PRIMARY" chown postgres:postgres /wal-archive

until docker exec "$PRIMARY" pg_isready -U drill -d drill >/dev/null 2>&1; do sleep 1; done

say "2/7  creating a ledger-shaped table and inserting ${ROWS_BEFORE_BACKUP} rows"

psql_primary "
  CREATE TABLE entries (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id  bigint NOT NULL,
    amount      bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO entries (account_id, amount)
  SELECT (n % 1000) + 1, ((n % 7) - 3) * 100
    FROM generate_series(1, ${ROWS_BEFORE_BACKUP}) AS n;
" >/dev/null

BEFORE_COUNT=$(psql_primary "SELECT count(*) FROM entries")
echo "    rows before backup: ${BEFORE_COUNT}"

say "3/7  taking a base backup"

BACKUP_START=$(date +%s.%N)
# `-X stream` so the backup is self-consistent without needing the archive for
# the segments written *during* the backup itself.
docker run --rm \
  --network "container:${PRIMARY}" \
  -e PGPASSWORD="$PGPASSWORD_VALUE" \
  -v "${VOL_BASE}:/backup" \
  "$IMAGE" \
  sh -c 'pg_basebackup -h 127.0.0.1 -U drill -D /backup/base -Fp -Xs -P 2>&1 | tail -2'
BACKUP_END=$(date +%s.%N)
BACKUP_SECONDS=$(echo "$BACKUP_END - $BACKUP_START" | bc)
printf '    base backup took %.1fs\n' "$BACKUP_SECONDS"

say "4/7  inserting ${ROWS_AFTER_BACKUP} more rows, then recording the recovery target"

psql_primary "
  INSERT INTO entries (account_id, amount)
  SELECT (n % 1000) + 1, ((n % 7) - 3) * 100
    FROM generate_series(1, ${ROWS_AFTER_BACKUP}) AS n;
" >/dev/null

GOOD_COUNT=$(psql_primary "SELECT count(*) FROM entries")
GOOD_SUM=$(psql_primary "SELECT coalesce(sum(amount), 0) FROM entries")
echo "    rows at the recovery target: ${GOOD_COUNT}  (sum ${GOOD_SUM})"

# The recovery target. Taken from the *server's* clock, not the shell's — a
# PITR target compared against a different clock is how a restore lands in the
# wrong place by however much the two have drifted.
RECOVERY_TARGET=$(psql_primary "SELECT now()")
echo "    recovery target time: ${RECOVERY_TARGET}"

# One second of separation, so the destructive change is unambiguously after
# the target rather than within timestamp resolution of it.
sleep 1

say "5/7  committing the destructive change (deleting half the rows)"

psql_primary "DELETE FROM entries WHERE id % 2 = 0;" >/dev/null
DAMAGED_COUNT=$(psql_primary "SELECT count(*) FROM entries")
echo "    rows after the damage: ${DAMAGED_COUNT}"

# Force the current WAL segment into the archive. Without this the segment
# containing the recovery target may still be open, and recovery stops short of
# the target with no error — it simply replays less than asked and reports
# success, which is the most dangerous failure mode a restore has.
psql_primary "SELECT pg_switch_wal();" >/dev/null
sleep 3

ARCHIVED=$(docker exec "$PRIMARY" sh -c 'ls -1 /wal-archive | wc -l')
echo "    archived WAL segments: ${ARCHIVED}"

say "6/7  restoring base backup + WAL to the recovery target"

RESTORE_START=$(date +%s.%N)

# `recovery_target_time` plus `recovery_target_action=promote`, and
# `recovery.signal` to put the server into archive recovery. The data directory
# is a copy of the base backup, so the original is still available for a second
# attempt if the first target turns out to be wrong.
docker run --rm \
  -v "${VOL_BASE}:/backup" \
  "$IMAGE" \
  sh -c "
    set -e
    rm -rf /backup/restore
    cp -a /backup/base /backup/restore
    cat >> /backup/restore/postgresql.auto.conf <<CONF
restore_command = 'cp /wal-archive/%f %p'
recovery_target_time = '${RECOVERY_TARGET}'
recovery_target_action = 'promote'
recovery_target_inclusive = on
CONF
    touch /backup/restore/recovery.signal
    chown -R postgres:postgres /backup/restore
    chmod 700 /backup/restore
  "

docker run -d --name "$RESTORED" \
  -e PGPASSWORD="$PGPASSWORD_VALUE" \
  -p "127.0.0.1:${RESTORED_PORT}:5432" \
  -v "${VOL_BASE}:/backup" \
  -v "${VOL_WAL}:/wal-archive:ro" \
  -e PGDATA=/backup/restore \
  "$IMAGE" \
  postgres -c timezone=UTC \
  >/dev/null

# Wait for recovery to finish and the server to promote.
for _ in $(seq 1 90); do
  if docker exec "$RESTORED" pg_isready -U drill -d drill >/dev/null 2>&1; then
    IN_RECOVERY=$(docker exec -e PGPASSWORD="$PGPASSWORD_VALUE" "$RESTORED" \
      psql -U drill -d drill -tAc 'SELECT pg_is_in_recovery()' 2>/dev/null || echo t)
    [ "$IN_RECOVERY" = "f" ] && break
  fi
  sleep 1
done

RESTORE_END=$(date +%s.%N)
RESTORE_SECONDS=$(echo "$RESTORE_END - $RESTORE_START" | bc)
printf '    restore + replay + promote took %.1fs\n' "$RESTORE_SECONDS"

say "7/7  verifying"

RESTORED_COUNT=$(docker exec -e PGPASSWORD="$PGPASSWORD_VALUE" "$RESTORED" \
  psql -U drill -d drill -tAc 'SELECT count(*) FROM entries')
RESTORED_SUM=$(docker exec -e PGPASSWORD="$PGPASSWORD_VALUE" "$RESTORED" \
  psql -U drill -d drill -tAc 'SELECT coalesce(sum(amount), 0) FROM entries')

echo "    restored rows: ${RESTORED_COUNT}  (expected ${GOOD_COUNT})"
echo "    restored sum:  ${RESTORED_SUM}  (expected ${GOOD_SUM})"
echo
docker logs "$RESTORED" 2>&1 | grep -iE "recovery stopping|starting point-in-time|redo done|database system is ready" | tail -5

echo
if [ "$RESTORED_COUNT" = "$GOOD_COUNT" ] && [ "$RESTORED_SUM" = "$GOOD_SUM" ]; then
  printf '\033[1;32mPASS\033[0m  recovered to the target; the DELETE after it was not replayed\n'
  printf '      RTO (this dataset): %.1fs restore  ·  %.1fs backup\n' \
    "$RESTORE_SECONDS" "$BACKUP_SECONDS"
  exit 0
fi

printf '\033[1;31mFAIL\033[0m  restored state does not match the recovery target\n'
exit 1
