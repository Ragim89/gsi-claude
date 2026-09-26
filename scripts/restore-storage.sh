#!/usr/bin/env bash
#
# Restores a scripts/backup-storage.sh archive into a throwaway MinIO container and verifies
# object count against what was archived — the same "prove it, do not just trust it" drill as
# scripts/restore-db.sh, for the other half of what a report depends on: its PDF and photo
# evidence in object storage, not only its database rows. Uses the minio server images own
# bundled `mc` client rather than a separate mc image (see scripts/backup-storage.sh for why).
#
#   scripts/restore-storage.sh backups/storage/gsi-20260926T120000Z.tar.gz
#   scripts/restore-storage.sh backups/storage/gsi-20260926T120000Z.tar.gz.gpg
#
# For restoring into a real bucket (an outage, not a drill), see docs/BACKUP_RESTORE.md — `mc
# mirror` the extracted archive straight at the target bucket; deliberately not scripted here for
# the same reason scripts/restore-db.sh's production path is not scripted.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

ARCHIVE="${1:?Usage: scripts/restore-storage.sh archive-file [count-file]}"
COUNT_FILE="${2:-}"
[ -f "$ARCHIVE" ] || { echo "No such file: $ARCHIVE" >&2; exit 1; }

WORK="$ARCHIVE"
CLEANUP_DECRYPTED=""
if [[ "$ARCHIVE" == *.gpg ]]; then
  echo "Decrypting $ARCHIVE..."
  WORK="${ARCHIVE%.gpg}.restoring"
  gpg --batch --yes -o "$WORK" -d "$ARCHIVE"
  CLEANUP_DECRYPTED="$WORK"
fi

if [ -z "$COUNT_FILE" ]; then
  CANDIDATE="${ARCHIVE%.gpg}"
  CANDIDATE="${CANDIDATE%.tar.gz}.count"
  [ -f "$CANDIDATE" ] && COUNT_FILE="$CANDIDATE"
fi

# Under the repo, not /tmp: some Docker CLI/Windows path-handling combinations cannot resolve a
# system-temp source path for `docker cp`/`-v` (seen and worked around during PHASE 13's restore
# drill — see docs/BACKUP_RESTORE.md), while a path under the working tree always resolves.
WORKDIR="$(pwd)/.restore-drill-$$"
mkdir -p "$WORKDIR"
CONTAINER="gsi-restore-drill-minio-$$"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  [ -n "$CLEANUP_DECRYPTED" ] && rm -f "$CLEANUP_DECRYPTED"
}
trap cleanup EXIT

echo "Extracting $WORK..."
tar -xzf "$WORK" -C "$WORKDIR"
SNAPSHOT_DIR=$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -type d | head -1)
FILE_COUNT=$(find "$SNAPSHOT_DIR" -type f | wc -l)
echo "Archive holds $FILE_COUNT object(s)."

echo "Starting a disposable MinIO to restore into, with the extracted archive bind-mounted..."
# Bind-mounting the already-extracted archive in at container start — rather than `docker cp`-ing
# it in afterwards — sidesteps a `docker cp`/Windows path-handling quirk seen with this Docker
# CLI when the destination is inside a container that has no shell tar to fall back on, and it is
# simpler besides: the minio image ships `mc` but not `tar`, so mc has to read the files from
# somewhere docker itself already put them.
docker run -d --name "$CONTAINER" \
  -e MINIO_ROOT_USER=drilladmin -e MINIO_ROOT_PASSWORD=drillpassword \
  -v "$SNAPSHOT_DIR:/restore-in:ro" \
  quay.io/minio/minio server /data >/dev/null

echo "Waiting for it to come up..."
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" mc ready local >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "Restoring into bucket 'restored'..."
docker exec "$CONTAINER" mc alias set gsi-restore-drill http://localhost:9000 drilladmin drillpassword >/dev/null
docker exec "$CONTAINER" mc mb --ignore-existing gsi-restore-drill/restored >/dev/null
docker exec "$CONTAINER" mc mirror --quiet /restore-in gsi-restore-drill/restored

RESTORED_COUNT=$(docker exec "$CONTAINER" mc find gsi-restore-drill/restored | wc -l)

echo
echo "Archived objects:  $FILE_COUNT"
echo "Restored objects:  $RESTORED_COUNT"
if [ -n "$COUNT_FILE" ] && [ -f "$COUNT_FILE" ]; then
  EXPECTED=$(cat "$COUNT_FILE")
  echo "Backup manifest:   $EXPECTED"
fi

if [ "$FILE_COUNT" != "$RESTORED_COUNT" ]; then
  echo "restore-storage: FAIL — object counts do not match" >&2
  exit 1
fi
echo "restore-storage: PASS — every archived object round-tripped through restore"
