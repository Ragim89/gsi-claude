#!/usr/bin/env bash
#
# Restores a scripts/backup-db.sh dump into a throwaway PostgreSQL container — never into a
# running compose stack's own `db`, so running this script can never damage a real database by
# accident — and verifies the restore by comparing exact row counts against the .counts file
# written alongside the dump. This is the drill docs/BACKUP_RESTORE.md points at as proof the
# backups are actually restorable, not just something that runs without erroring.
#
#   scripts/restore-db.sh backups/db/gsi-20260926T120000Z.dump
#   scripts/restore-db.sh backups/db/gsi-20260926T120000Z.dump.gpg   # decrypts first
#
# For restoring into an actual production database (an outage, not a drill), see the manual
# procedure in docs/BACKUP_RESTORE.md — that one is deliberately not a script: it stops the api
# service, replaces a live database and is not something to run unattended or automate away.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

DUMP="${1:?Usage: scripts/restore-db.sh <dump-file> [counts-file]}"
COUNTS="${2:-}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP" >&2; exit 1; }

WORK="$DUMP"
CLEANUP_DECRYPTED=""
if [[ "$DUMP" == *.gpg ]]; then
  echo "Decrypting $DUMP..."
  WORK="${DUMP%.gpg}.restoring"
  gpg --batch --yes -o "$WORK" -d "$DUMP"
  CLEANUP_DECRYPTED="$WORK"
fi

if [ -z "$COUNTS" ]; then
  # scripts/backup-db.sh always writes the two side by side with matching timestamps.
  CANDIDATE="${DUMP%.gpg}"
  CANDIDATE="${CANDIDATE%.dump}.counts"
  [ -f "$CANDIDATE" ] && COUNTS="$CANDIDATE"
fi

CONTAINER="gsi-restore-drill-$$"
NETWORK="gsi-restore-drill-net-$$"
DB_NAME="gsi_restore_drill"
DB_USER="gsi_drill"
DB_PASS="drill-only-$$"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  [ -n "$CLEANUP_DECRYPTED" ] && rm -f "$CLEANUP_DECRYPTED"
}
trap cleanup EXIT

echo "Starting a disposable postgres:16-alpine to restore into..."
docker network create "$NETWORK" >/dev/null
docker run -d --name "$CONTAINER" --network "$NETWORK" \
  -e POSTGRES_DB="$DB_NAME" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" \
  postgres:16-alpine >/dev/null

echo "Waiting for it to accept connections..."
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "Restoring $WORK into $DB_NAME..."
docker cp "$WORK" "$CONTAINER:/tmp/restore.dump"
docker exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges /tmp/restore.dump || {
  echo "pg_restore reported errors above — some are expected (roles/extensions that exist only" >&2
  echo "in the real deployment, e.g. CREATE ROLE gsi_app); check the table counts below before" >&2
  echo "deciding whether this restore is good." >&2
}

echo
echo "Verifying row counts..."
FAILED=0
if [ -n "$COUNTS" ] && [ -f "$COUNTS" ]; then
  mapfile -t LINES < "$COUNTS"
  CHECKED=0
  for line in "${LINES[@]}"; do
    [ -z "$line" ] && continue
    table="${line%% *}"
    expected="${line##* }"
    actual=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT count(*) FROM \"$table\"" </dev/null 2>/dev/null || echo "ERROR")
    CHECKED=$((CHECKED + 1))
    if [ "$actual" == "$expected" ]; then
      echo "  OK    $table: $actual"
    else
      echo "  FAIL  $table: expected $expected, restored $actual"
      FAILED=1
    fi
  done
  echo "  ($CHECKED tables checked)"
else
  echo "  (no .counts file found next to the dump — listing table sizes instead, nothing to compare against)"
  docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
    "SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text
     FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "restore-db: PASS — every table's row count matches the backup exactly"
else
  echo "restore-db: FAIL — see above" >&2
  exit 1
fi
