# nativets

A memory-safe **TypeScript → LLVM IR → native** compiler, hand-written frontend, no
`typescript` dependency. Targets macOS, Linux, iOS, Android, Windows, wasm.

## The prime directive

**`node` is the specification.** Every correctness test compiles a `.ts` file, runs it,
and asserts stdout + exit code equal `node <file>`. If we disagree with node, we are
wrong — until we deliberately document the divergence in `docs/divergences.md`.

The second rule follows from the first: **reject, never miscompile.** Anything we can't
compile correctly gets an `NT****` diagnostic with a hint. A silent wrong answer is the
worst outcome available.

## How to work

**Red → green → refactor, ONE test at a time.**

1. **RED** — write a *single* failing test for the next behavior. Run it. See it fail.
2. **GREEN** — the minimum code to pass it.
3. **REFACTOR** — clean up with the suite green. Never expand scope here.

Do not batch up a stage's tests and then start coding. One behavior, one test, one
checkpoint you never regress past. The ordered list of behaviors is the spec — agree it
first; the tests are added and closed one at a time against a running oracle.

**Never widen a stage's scope without asking** which tests to write for it first.

## Use reference tests

When a feature has a canonical, well-tested implementation, **mine its test suite** for
the behavior list and expected values instead of inventing cases. The reference already
found the edge cases you'd miss — this has repeatedly caught real bugs that hand-written
tests did not. Map each borrowed case to a node-runnable `.ts` fixture and cite where it
came from.

| Area | Reference |
|---|---|
| JS semantics, lexing | **test262**, and node itself |
| TypeScript syntax | the **TypeScript conformance suite** (`microsoft/TypeScript`, `tests/cases/`) |
| Ownership / borrow / move | **rustc** `tests/ui/borrowck`, `tests/ui/moves` (we mirror its codes: `NT1601`≈E0382) |
| Actors / supervision | **Erlang/OTP** `gen_server_SUITE`, `supervisor_SUITE`; Elixir's equivalents |
| Runtime validation | **zod**, `io-ts`; JSON parsing → `nst/JSONTestSuite` |
| Immutable data | `immer`, `immutable.js`, Bagwell **HAMT** |

## Test locally

```sh
bun test                      # everything (~7 min)
bun test test/foo.test.ts     # one file — what you'll use in the loop
bun run src/cli.ts run x.ts   # compile + run a single program
bun run src/cli.ts coverage x.ts   # what blocks a program, by NT code
bun run compile               # -> ./nativets, self-contained binary
```

- **Snapshots are not a correctness gate.** A changed IR snapshot is a prompt to
  re-verify behavior, never a failure on its own. Regenerate deliberately with
  `bun test --update-snapshots` *after* behavior is re-verified.
- **A green local run is not a green CI run.** Two failures have shipped that were
  invisible on macOS: LeakSanitizer only exists on Linux, and a race only lost under a
  loaded runner. Treat red CI as authoritative over a green laptop.

## Before you merge

- Full `bun test` green, and **check CI** — not just the local run.
- **Smoke-build after every merge, before committing it:** `bun run src/cli.ts run` on a
  trivial program. A 3-way merge that keeps *both* copies of a `declare` line breaks
  every build, and both branches were green.
- Shared hot spots to merge carefully: codegen `DECLARES`/`genGlobal`, `driver.ts`
  `linkArgv`, `checker.ts` `GLOBAL_FUNCS`, `ast.ts` type predicates. Resolve duplication
  to ONE canonical copy.
- Merge `main` into your branch **first** — worktrees branch from stale bases.
- Work on a branch, in your own worktree. Don't commit to `main` directly.

## Where things are

```
src/lexer.ts → parser.ts → checker.ts → ownership.ts → codegen.ts → driver.ts
                                                        (LLVM IR text)  (clang)
```

- `runtime/` — the C runtime, libc-only so it cross-links everywhere.
- `docs/ROADMAP.md` — **what's next.**
- `docs/divergences.md` — every deliberate difference from node, and every refusal.
- `docs/self-hosting.md` — the bootstrap frontier, measured.
- `docs/ledger.md` — the stage-by-stage build history.
- `src/diagnostics.ts` — the `NT****` catalog.

## Conventions

- All JS numbers are IEEE-754 `double`; floats emit as exact hex so LLVM never rejects
  them. Opaque pointers only (`ptr`), required by LLVM 21.
- No target triple in the emitted `.ll` — clang fills in host or `-target`. Keep it that
  way for painless retargeting.
- Prefer growing existing modules over adding new ones; match surrounding style.
