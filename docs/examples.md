# Example apps (north-star targets)

Two target applications drive the roadmap by forcing capabilities nativets doesn't have yet.
Each is **staged from "achievable now" to the full vision**, so every stage ships something real
and cross-compiles to macOS / Linux / iOS / Android (LLVM retargeting is the whole point).

> **The shared blocker:** nativets today has **no input** — no `stdin`, no `argv`, no env, no
> sockets. A program is a pure function of nothing → `stdout`. So the **Host I/O FFI** below is the
> single highest-leverage unlock; both apps depend on it (and it *is* self-hosting SH4).

---

## 0. Host I/O FFI (foundation — build first)

A small host interface in the runtime, exposed as builtins, backed by libc/posix so it
cross-compiles unchanged:

- `nt_argv` → `process.argv` (read CLI args — the LLM key, the calculator expression).
- `nt_read_line` / `nt_read_stdin` → read a line / all of stdin (interactive input).
- `nt_getenv` → env vars. `nt_exit(code)`.
- Later: `nt_open`/`nt_read`/`nt_write` (files), then **sockets + TLS** (the networking tier).

Node-differential-testable (node has `process.argv`/`process.stdin`/`process.env`), so node stays
the oracle. This is **self-hosting SH4** — building it here advances two roadmaps at once.

---

## 1. Calculator — cross-platform (UI) app

**Vision:** a calculator that compiles + runs on macOS, Linux, iOS, and Android from one source.

- **C-a — Expression engine (achievable now, minus input).** Tokenize → parse (a Pratt parser,
  which the compiler already has) → evaluate `+ - * / % ( )` and unary minus. Pure supported
  features (numbers, strings, arrays, functions, recursion). The only gap is *input*.
- **C-b — CLI calculator (first shippable milestone).** Read the expression from `argv` (or stdin)
  via the Host I/O FFI, print the result. A real program that **cross-compiles to every platform**.
  This is the concrete "compiles on every platform" deliverable.
- **C-c — TUI (terminal UI).** Raw-mode stdin + ANSI rendering → an interactive **text-UI**
  calculator (a display + button grid drawn in the terminal, arrow-key/entry driven). Runs in every
  platform's terminal (incl. the iOS sim / Android shell) — the **achievable, genuinely
  cross-platform "UI."** Needs `nt_read_key` (raw mode) + ANSI escape output (just strings).
- **C-d — Native GUI (north-star).** Real windows/buttons: a **UI FFI per platform** (UIKit/SwiftUI
  on iOS, Android SDK/Jetpack on Android, AppKit/GTK on desktop) or a portable immediate-mode GUI
  over a canvas/GPU surface. A large, separate initiative — the retargetable backend already exists;
  what's missing is the platform UI bindings.

---

## 2. Simple LLM chat — CLI, key via CLI arg

**Vision:** `nativets run chat.ts -- --key $KEY` → an interactive terminal chat with an LLM.

- **L-a — argv (Host I/O FFI).** Read `--key` from `argv`. (Shared with C-b.)
- **L-b — stdin loop.** Read user turns line-by-line (`nt_read_line`), loop until EOF/`/quit`.
- **L-c — JSON.** Build the request body + parse the response. ✅ **`JSON.stringify`/`JSON.parse`
  already exist** (Stages 17/20) — a real payoff of Phase A.
- **L-d — HTTP + TLS (the big tier).** `POST https://api.anthropic.com/v1/messages`. Needs a
  **sockets layer + TLS**. Options: FFI to the platform HTTP stack (NSURLSession / OkHttp) or link a
  small C client (libcurl, or BearSSL/mbedTLS for a static build). This is the networking initiative
  — the largest gap, and the one that makes nativets useful for real services.
- **L-e — Streaming (nice-to-have).** Consume SSE to stream tokens for a live feel.

When building the LLM client, follow the current Claude API contract (models, headers, streaming) —
load the `claude-api` skill / current docs rather than hard-coding from memory.

---

## Suggested order

1. **Host I/O FFI** (§0) — unblocks everything.
2. **CLI calculator** (C-a + C-b) — first cross-platform app; verify it on the Android emulator +
   iOS sim (the cross-execution harness already exists).
3. **TUI calculator** (C-c) — the achievable cross-platform "UI."
4. **HTTP + TLS** (L-d) — the networking tier → **LLM chat** (L-a…L-c on top).
5. **Native GUI** (C-d) — the north-star UI initiative, once platform UI bindings exist.
