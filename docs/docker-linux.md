# The local Linux lane (Docker)

Run the test suite on **Linux**, locally, against your working tree — in one command.

```bash
scripts/docker-test.sh                          # the whole suite on Linux
scripts/docker-test.sh test/transients.test.ts  # one file (the usual case)
scripts/docker-test.sh test/actors-mn.test.ts -t "fan-in"   # bun test flags pass through
scripts/docker-test.sh --shell                  # an interactive Linux shell in the tree
scripts/docker-test.sh --run bun run src/cli.ts run ci/smoke.ts   # any command
scripts/docker-test.sh --build …                # force an image rebuild
bun run test:linux …                            # same thing via package.json
```

The tree is **bind-mounted at `/work`**, so this tests uncommitted local changes, not a
git checkout. Nothing is copied into the image; an edit takes effect on the next run.
The image is built automatically on first use.

The container runs with **`CI=true`**, because it exists to mirror the ubuntu CI job —
which is what makes the IR snapshot tests skip (`test.skipIf(!!process.env.CI)` in
`test/fixtures.test.ts`). They are a macOS-local debugging aid, not a correctness gate,
and a not-yet-regenerated snapshot would otherwise bury the real failures under ~120 red
lines. Set `NATIVETS_DOCKER_CI=0` to run them anyway. It is the only test behavior the
flag changes (it is the only `process.env.CI` read in the tree).

## Why this exists

macOS and Linux are **not** equivalent test environments, and the differences are silent.
Two that cost this project real time:

- **ASan enables LeakSanitizer by default on Linux; macOS has no LSan at all.** The
  sanitizer gate in `test/transients.test.ts` therefore *meant two different things per
  platform*: on macOS "no double free / no use-after-free", on Linux that **plus** "no
  leaks" — which nativets deliberately has at the boundaries Stage 44 documents. It was
  red on ubuntu for five consecutive merges while every macOS run was green.
- **A scheduler race only lost under a loaded runner** — invisible on an idle laptop.

The first of those is now reproducible on demand, locally, in a couple of minutes.

## Reproducing the LeakSanitizer difference

`NATIVETS_ASAN_LEAKS=1` turns LSan back on for the ASan gate. The *same command* does
two different things, which is exactly the point:

```bash
# Linux — LSan fires: "ERROR: LeakSanitizer: detected memory leaks", the test goes red
NATIVETS_ASAN_LEAKS=1 scripts/docker-test.sh test/transients.test.ts -t ASan

# macOS — a no-op with a note, the gate stays green (there is no LSan to enable;
# ASan there refuses the flag outright: "detect_leaks is not supported on this platform")
NATIVETS_ASAN_LEAKS=1 bun test test/transients.test.ts -t ASan
```

Without the knob the gate runs `detect_leaks=0` on both platforms — one meaning
everywhere, which is what a gate has to have. Leaks stay gated separately and precisely
by the live counters (`__arrLive` / `__objLive` / `__pvNodes` / `nt_str_live`).

## What the image contains

`docker/Dockerfile`, `ubuntu:24.04`, ~870 MB, four cached layers:

| | |
|---|---|
| `clang` + `libclang-rt-18-dev` | the only compiler nativets shells out to, plus the ASan/UBSan runtimes |
| `llvm-18` (`llvm-symbolizer`) | symbolized sanitizer traces — without it a report is bare hex. Skip with `--build-arg WITH_SYMBOLIZER=0` (−120 MB) |
| `libcurl4-openssl-dev` | the `fetch`/http tier links `-lcurl` |
| node 24 (pinned, from nodejs.org) | **the differential oracle** — a distro node would be too old for the ES2023 fixtures, i.e. a *wrong* oracle |
| bun (from `oven/bun:1-slim`) | runs the compiler and the test suite |
| `file`, `tzdata` | not incidental: `test/toolchain.test.ts` identifies cross-compiled objects with `file` (absent → the arch assertions fail for no toolchain reason), and the `Date` tests pin `TZ` on both sides (no zoneinfo → every zone silently *is* UTC) |

Build times on an M-series laptop: **cold ~25 s**, **warm < 1 s** (nothing is COPYed in,
so a source edit invalidates no layer at all). A full `bun test` inside it takes ~4 min.

## What this lane cannot test

- **macOS-only paths** — iOS / iOS-simulator builds (`xcrun`, Apple sysroots), Mach-O
  output, `simctl`. `test/cross.test.ts` skips them here, as it does on the CI Linux job.
- **Android on a device** — no `adb`/emulator inside the container.
- **Windows** — covered only by the reduced `windows-smoke` CI job.
- **Real CPU architecture.** On Apple Silicon this is **arm64** Linux, while CI runners
  are x86_64. For an arch-sensitive suspicion, set
  `NATIVETS_DOCKER_PLATFORM=linux/amd64` (emulated, much slower).
- **Load-dependent races.** A loaded CI runner is not reproduced by an idle container;
  raise `NATIVETS_SCHED_THREADS` and re-run repeatedly to hunt those.

## No Docker?

Every entry point degrades: `scripts/docker-test.sh` prints what to install and exits
127, and `test/docker.test.ts` **skips** (it also skips when the image has not been
built — it never builds one). `bun test` is unaffected either way; this lane is opt-in.
