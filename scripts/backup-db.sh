#!/usr/bin/env bash
#
# Dumps the PostgreSQL database from a running `db` service (docker-compose.yml or
# docker-compose.prod.yml — pass the compose file with -f, default is the production one) to a
# single compressed, restorable file, then applies a retention policy to what is already on disk.
#
#   scripts/backup-db.sh                                    # backs up docker-compose.prod.yml's db
#   COMPOSE_FILE=docker-compose.yml scripts/backup-db.sh     # backs up the dev stack instead
#   BACKUP_GPG_RECIPIENT=ops@example.com scripts/backup-db.sh   # encrypt the dump at rest
#
# See docs/BACKUP_RESTORE.md for the retention policy, the encryption-at-rest approach, the
# restore procedure and how this was proven against a real restore.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE_ARG=()
[ -n "${ENV_FILE:-}" ] && ENV_FILE_ARG=(--env-file "$ENV_FILE")
DC=(docker compose -f "$COMPOSE_FILE" "${ENV_FILE_ARG[@]}")

OUT_DIR="${BACKUP_DIR:-backups/db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_NAME="${DB_NAME:-gsi}"
DB_USER="${POSTGRES_USER:-gsi}"

mkdir -p "$OUT_DIR"
DUMP_FILE="$OUT_DIR/gsi-${STAMP}.dump"

echo "Dumping database '$DB_NAME' from the 'db' service of $COMPOSE_FILE..."
# Custom format (-Fc): compressed, and the only format pg_restore can apply selectively or
# in parallel. Runs as the schema owner so every object — including the ones `gsi_app` has no
# grant to touch, like audit_logs — is captured.
"${DC[@]}" exec -T db pg_dump -U "$DB_USER" -Fc -d "$DB_NAME" > "$DUMP_FILE"

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "Wrote $DUMP_FILE ($SIZE)"

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  echo "Encrypting for $BACKUP_GPG_RECIPIENT..."
  gpg --batch --yes --trust-model always -e -r "$BACKUP_GPG_RECIPIENT" -o "${DUMP_FILE}.gpg" "$DUMP_FILE"
  rm -f "$DUMP_FILE"
  DUMP_FILE="${DUMP_FILE}.gpg"
  echo "Wrote $DUMP_FILE (encrypted)"
fi

# Exact row counts alongside the dump: what restore-db.sh compares the restored database
# against, without having to open the dump file itself. Exact COUNT(*), not pg_class.reltuples
# (an ANALYZE-time estimate) — a restore check is only worth as much as the number it checks
# against.
COUNTS_FILE="$OUT_DIR/gsi-${STAMP}.counts"
: > "$COUNTS_FILE"
mapfile -t TABLES < <("${DC[@]}" exec -T db psql -U "$DB_USER" -d "$DB_NAME" -Atc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")
# `for`, not `while read ... done < <(...)`: each iteration's `docker compose exec` forwards the
# host's stdin to the container, and a `while read` sharing that same stdin stream gets drained
# by the first `docker exec` call and never sees a second line — a for loop over an array has no
# stdin of its own to lose.
for t in "${TABLES[@]}"; do
  [ -z "$t" ] && continue
  n=$("${DC[@]}" exec -T db psql -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT count(*) FROM \"$t\"" </dev/null)
  echo "$t $n" >> "$COUNTS_FILE"
done
echo "Wrote $COUNTS_FILE (exact row counts, for restore verification) — ${#TABLES[@]} tables"

echo "Applying retention: deleting backups older than ${RETENTION_DAYS} days in $OUT_DIR..."
find "$OUT_DIR" -maxdepth 1 -type f \( -name 'gsi-*.dump' -o -name 'gsi-*.dump.gpg' -o -name 'gsi-*.counts' \) \
  -mtime "+${RETENTION_DAYS}" -print -delete

echo "backup-db: done — $DUMP_FILE"
