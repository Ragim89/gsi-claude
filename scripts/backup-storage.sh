#!/usr/bin/env bash
#
# Mirrors the object-storage bucket (MinIO in the compose stacks, or any S3-compatible endpoint
# reachable from inside the minio container) to a local, versioned archive, then applies
# retention. Runs `mc` inside the running `minio` service itself — the MinIO server image ships
# its own client — rather than pulling a separate image, since minio/mc and quay.io/minio/mc
# both require registry authentication to pull anonymously as of this writing and the running
# container already has everything needed.
#
#   scripts/backup-storage.sh                                  # backs up docker-compose.prod.yml's minio
#   COMPOSE_FILE=docker-compose.yml scripts/backup-storage.sh  # backs up the dev stack's minio
#
# See docs/BACKUP_RESTORE.md for retention, encryption at rest, and the restore drill this was
# proven against.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE_ARG=()
[ -n "${ENV_FILE:-}" ] && ENV_FILE_ARG=(--env-file "$ENV_FILE")
DC=(docker compose -f "$COMPOSE_FILE" "${ENV_FILE_ARG[@]}")

ACCESS_KEY="${S3_ACCESS_KEY:?set S3_ACCESS_KEY, matching the target composes env file}"
SECRET_KEY="${S3_SECRET_KEY:?set S3_SECRET_KEY, matching the target composes env file}"
BUCKET="${S3_BUCKET:-gsi-media}"

OUT_DIR="${BACKUP_DIR:-backups/storage}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="$OUT_DIR/gsi-${STAMP}"
ARCHIVE="$OUT_DIR/gsi-${STAMP}.tar.gz"
REMOTE_TMP="/tmp/gsi-backup-${STAMP}"

MINIO_CID=$("${DC[@]}" ps -q minio)
if [ -z "$MINIO_CID" ]; then
  echo "minio service is not running under $COMPOSE_FILE" >&2
  exit 1
fi

echo "Mirroring bucket '$BUCKET' out of the running minio container..."
docker exec "$MINIO_CID" mc alias set gsi-backup-src http://localhost:9000 "$ACCESS_KEY" "$SECRET_KEY" >/dev/null
docker exec "$MINIO_CID" mc mirror --quiet "gsi-backup-src/${BUCKET}" "$REMOTE_TMP"

mkdir -p "$SNAPSHOT_DIR"
docker cp "$MINIO_CID:$REMOTE_TMP/." "$SNAPSHOT_DIR"
docker exec "$MINIO_CID" rm -rf "$REMOTE_TMP"

FILES=$(find "$SNAPSHOT_DIR" -type f | wc -l)
echo "Mirrored $FILES object(s)."

echo "Archiving to $ARCHIVE..."
tar -C "$OUT_DIR" -czf "$ARCHIVE" "gsi-${STAMP}"
rm -rf "$SNAPSHOT_DIR"
SIZE=$(du -h "$ARCHIVE" | cut -f1)
echo "Wrote $ARCHIVE ($SIZE, $FILES objects)"

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  echo "Encrypting for $BACKUP_GPG_RECIPIENT..."
  gpg --batch --yes --trust-model always -e -r "$BACKUP_GPG_RECIPIENT" -o "${ARCHIVE}.gpg" "$ARCHIVE"
  rm -f "$ARCHIVE"
  ARCHIVE="${ARCHIVE}.gpg"
  echo "Wrote $ARCHIVE (encrypted)"
fi

echo "$FILES" > "$OUT_DIR/gsi-${STAMP}.count"

echo "Applying retention: deleting backups older than ${RETENTION_DAYS} days in $OUT_DIR..."
find "$OUT_DIR" -maxdepth 1 -type f \( -name 'gsi-*.tar.gz' -o -name 'gsi-*.tar.gz.gpg' -o -name 'gsi-*.count' \) \
  -mtime "+${RETENTION_DAYS}" -print -delete

echo "backup-storage: done — $ARCHIVE"
