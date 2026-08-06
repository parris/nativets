# Linux build/test lane for nativets — a local stand-in for the ubuntu CI job.
#
# WHY: the fleet develops on macOS, and macOS and Linux are NOT the same test
# environment. The sharpest example: ASan enables LeakSanitizer by default on
# Linux and macOS has NO LSan at all, so `test/transients.test.ts`'s sanitizer
# gate silently meant two different things per platform and was red on ubuntu
# for five straight merges while every macOS run was green. This image makes
# "does it pass on Linux?" answerable locally, in one command.
#
# Mirrors .github/workflows/ci.yml's ubuntu job: clang + libcurl (the fetch
# tier links -lcurl) + node (the differential oracle) + bun (the test runner).
#
# Layer order is deliberate: everything below changes only when THIS file does,
# so a re-run after a source edit is a no-op rebuild (the source tree is bind-
# mounted at run time, never COPYed in).

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# Match the host/CI oracle: node 24 (Array.prototype.with / toSorted are ES2023
# and the fixtures use them, so an old distro node would be a WRONG oracle).
ARG NODE_VERSION=24.11.1

# ---- Layer 1: the apt toolchain (same list as the ubuntu CI job) ------------
# clang            — the only compiler nativets shells out to (consumes .ll directly)
# libclang-rt-dev  — compiler-rt's ASan/UBSan runtimes; --no-install-recommends
#                    would otherwise drop them and -fsanitize=address fails to link
# libcurl-dev      — the fetch/http tier links -lcurl (conditionally, see driver.ts)
# curl/xz/ca-certs — only to fetch node below
# file             — test/toolchain.test.ts identifies cross-compiled objects with
#                    `file`; without it spawnSync returns "" and the arch assertions
#                    fail for a reason that has nothing to do with the toolchain
# tzdata           — the Date tests pin TZ on both sides (America/New_York,
#                    Asia/Kolkata); with no zoneinfo every zone silently IS UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      clang \
      libclang-rt-18-dev \
      libcurl4-openssl-dev \
      ca-certificates \
      curl \
      xz-utils \
      file \
      tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && clang --version

# ---- Layer 1b: llvm-symbolizer — OPTIONAL, on by default -------------------
# Without it an ASan/LSan report is bare hex addresses, which is close to useless
# for the one job this lane exists to do (diagnose a Linux-only memory fault).
# addr2line is NOT a substitute — modern ASan only drives llvm-symbolizer. Costs
# ~25 MB of download in its own layer; build with `--build-arg WITH_SYMBOLIZER=0`
# to skip it.
ARG WITH_SYMBOLIZER=1
RUN if [ "$WITH_SYMBOLIZER" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends llvm-18 \
      && rm -rf /var/lib/apt/lists/* \
      && ln -sf /usr/lib/llvm-18/bin/llvm-symbolizer /usr/local/bin/llvm-symbolizer; \
    fi

# ---- Layer 2: node — the differential oracle -------------------------------
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) narch=x64 ;; \
      arm64) narch=arm64 ;; \
      *) echo "unsupported arch: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${narch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
          --exclude CHANGELOG.md --exclude README.md --exclude LICENSE; \
    rm -rf /usr/local/include/node /usr/local/lib/node_modules/npm/docs; \
    node --version

# ---- Layer 3: bun — runs the compiler and the test suite -------------------
# Lifted from the official image rather than curl|bash: one cached layer, no
# network at build time, and the version is pinned by the tag.
ARG BUN_IMAGE=oven/bun:1-slim
COPY --from=oven/bun:1-slim /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version

# The source tree is bind-mounted here by scripts/docker-test.sh — nothing is
# baked in, so the container always tests the LOCAL working tree.
WORKDIR /work
CMD ["bash"]
