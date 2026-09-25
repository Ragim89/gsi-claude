#!/usr/bin/env bash
#
# Everything in scripts/verify.sh, plus the assembled stack.
#
#   scripts/verify-full.sh
#
# Adds: the Docker image builds, the stack brought up with migrations applied, `/health/ready`,
# and the smoke sweep across every module against the real database and object store. This is
# what proves a migration that touched one table did not break a join in another — the kind of
# failure a throwaway test database never sees.
#
# It leaves the stack running; `docker compose down` when you are finished with it.
set -euo pipefail

cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

scripts/verify.sh

step 'Docker: build the images'
docker compose build api web

step 'Stack: up, with migrations applied on boot'
docker compose up -d

step 'Health: waiting for /api/health/ready'
ready=''
for _ in $(seq 1 60); do
  if body=$(curl -fsS http://localhost:3000/api/health/ready 2>/dev/null); then
    echo "$body"
    ready='yes'
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo 'health/ready did not come up within two minutes' >&2
  docker compose logs --tail 50 api >&2
  exit 1
fi

step 'Smoke: every module, against the running stack'
docker compose --profile test run --rm -e API=http://api:3000/api test node /repo/scripts/smoke.mjs

printf '\n\033[32mverify:full: green\033[0m — builds, stack, health, smoke\n'
