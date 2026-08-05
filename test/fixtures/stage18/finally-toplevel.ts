// A `finally` at TOP LEVEL. Regression: codegen's finally-return path used the
// enclosing function's `retTy` ("number" at top level), but `main` is emitted as
// `define i32 @main` — so it produced `ret double` inside main and clang rejected
// the whole module. The block is unreachable (a top-level `return` is illegal),
// but LLVM type-checks unreachable blocks too.
try {
  console.log("try");
} finally {
  console.log("finally");
}

try {
  throw new Error("boom");
} catch (e) {
  console.log("caught", e.message);
} finally {
  console.log("cleanup");
}

// ...and the in-function form still runs finally before returning.
function f(): number {
  try {
    return 1;
  } finally {
    console.log("fin-in-fn");
  }
}
console.log(f());
