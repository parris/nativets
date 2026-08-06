#!/usr/bin/env bash
#
# Run nativets' tests on LINUX, locally, against the working tree.
#
#   scripts/docker-test.sh                          # the full suite
#   scripts/docker-test.sh test/transients.test.ts  # one test file (the usual case)
#   scripts/docker-test.sh --shell                  # an interactive Linux shell
#   scripts/docker-test.sh --run bun run src/cli.ts run ci/smoke.ts   # any command
#
# The tree is BIND-MOUNTED, so this tests your uncommitted local changes — not a
# git checkout. Nothing is copied into the image; edits take effect immediately.
#
# WHY (see docs/docker-linux.md): macOS and Linux are not equivalent test
# environments. ASan enables LeakSanitizer by default on Linux and macOS has no
# LSan at all — a difference that kept the ubuntu CI job red for five merges
# while every macOS run was green. Reproduce that here in minutes instead.
#
# Env knobs:
#   NATIVETS_DOCKER_IMAGE     image tag              (default nativets-linux:dev)
#   NATIVETS_DOCKER_PLATFORM  e.g. linux/amd64 to match CI's x86_64 runners under
#                             emulation (default: your host arch — much faster)
#   NATIVETS_ASAN_LEAKS=1     turn LeakSanitizer ON in test/transients.test.ts;
#                             forwarded into the container (see docs)
set -euo pipefail

IMAGE="${NATIVETS_DOCKER_IMAGE:-nativets-linux:dev}"
# The container mirrors the ubuntu CI JOB, so it runs with CI=true — which is what makes
# the IR snapshot tests skip (`test.skipIf(!!process.env.CI)`). They are a macOS-local
# debugging aid, not a correctness gate, and a not-yet-regenerated snapshot would
# otherwise bury the real failures under ~120 red lines. `NATIVETS_DOCKER_CI=0` opts out.
CI_ENV="true"
[[ "${NATIVETS_DOCKER_CI:-1}" == "0" ]] && CI_ENV=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# macOS ships bash 3.2, where `"${arr[@]}"` on an EMPTY array trips `set -u`; keep
# the platform flag as two plain scalars instead of an array.
PLATFORM_FLAG=""
PLATFORM_VALUE=""
if [[ -n "${NATIVETS_DOCKER_PLATFORM:-}" ]]; then
  PLATFORM_FLAG="--platform"
  PLATFORM_VALUE="$NATIVETS_DOCKER_PLATFORM"
fi

# ---- degrade gracefully when Docker is absent -------------------------------
# This lane is an OPT-IN local tool, never a hard dependency: `bun test` on a
# machine without Docker is unaffected (test/docker.test.ts skips).
if ! command -v docker >/dev/null 2>&1; then
  echo "docker-test: docker is not installed — this Linux lane is optional." >&2
  echo "  Install Docker Desktop (or colima) and re-run, or just push and let CI's ubuntu job cover it." >&2
  exit 127
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker-test: the docker daemon is not running — start Docker Desktop (or 'colima start') and re-run." >&2
  exit 127
fi

# ---- build the image on first use (and on demand with --build) --------------
force_build=0
if [[ "${1:-}" == "--build" ]]; then force_build=1; shift; fi
if [[ $force_build == 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "docker-test: building $IMAGE (cold ~1min, warm seconds — layers are cached)…" >&2
  docker build $PLATFORM_FLAG $PLATFORM_VALUE -f "$ROOT/docker/Dockerfile" -t "$IMAGE" "$ROOT"
fi

# ---- decide what to run inside ----------------------------------------------
if [[ "${1:-}" == "--shell" ]]; then
  exec docker run --rm -it $PLATFORM_FLAG $PLATFORM_VALUE \
    -v "$ROOT:/work" -w /work \
    -e "CI=${CI_ENV}" \
    -e "NATIVETS_ASAN_LEAKS=${NATIVETS_ASAN_LEAKS:-}" \
    "$IMAGE" bash
fi

if [[ "${1:-}" == "--run" ]]; then
  shift
  CMD=("$@")
else
  # Default: the test suite, optionally narrowed to the files/filters given.
  # --timeout mirrors CI: every differential test links a binary with clang, and
  # bun's 5s default is not enough on a cold container.
  CMD=(bun test --timeout 60000 "$@")
fi

# --init: reap the zombie processes the compiled binaries leave behind (PID 1 in a
# container does not reap, and the suite spawns thousands of clang/node children).
exec docker run --rm --init $PLATFORM_FLAG $PLATFORM_VALUE \
  -v "$ROOT:/work" -w /work \
  -e "CI=${CI_ENV}" \
  -e "NATIVETS_ASAN_LEAKS=${NATIVETS_ASAN_LEAKS:-}" \
  "$IMAGE" "${CMD[@]}"
