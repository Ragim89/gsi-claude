#!/usr/bin/env bash
#
# The checks a phase has to pass before anything is committed.
#
#   scripts/verify.sh
#
# Runs, in order: unit tests, integration tests, lint, typecheck, API build (all inside the
# test container, against a throwaway `gsi_test` database), then the web build.
#
# The web build is a Docker build because that is the only place the web workspace's
# dependencies are installed; it runs `tsc --noEmit && vite build`, so it is a type check and a
# build at once. There is no ESLint configuration for the web workspace, so "lint" means the API.
#
# Nothing here touches the development database or the running stack. For the stack itself —
# Docker images, health, and the smoke sweep — use scripts/verify-full.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1   # Git Bash on Windows otherwise rewrites container paths

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# Sources are mounted into the test container, but dependencies and package.json come from the
# image. Building it first (layer-cached, seconds when nothing changed) means the run can never
# be against a stale image — the one failure mode that makes a green result meaningless.
step 'Test image'
docker compose --profile test build test

step 'API: unit tests, integration tests, lint, typecheck, build'
docker compose --profile test run --rm test npm run verify

step 'Web: type check and build'
docker compose build web

printf '\n\033[32mverify: green\033[0m — unit, integration, lint, typecheck, API build, web build\n'
