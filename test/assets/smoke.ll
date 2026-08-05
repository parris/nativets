; Minimal hand-written LLVM IR used by the toolchain smoke test.
; Proves clang can consume our IR text and that the produced binary runs.
; Exits with code 0.

define i32 @main() {
entry:
  ret i32 0
}
