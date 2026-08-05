// Top-level statements of every module are concatenated into ONE `main` frame, and
// that frame is FLAT — so a loop variable, a `const` nested in an `if`, and a `catch`
// parameter all share the namespace with every other module's. Here `item`, `tmp`
// and `e` are used at DIFFERENT types than in right.ts: only a correct per-module
// rename keeps them apart (a collision would silently keep the first type).
export const LEFT = "left";

for (const item of ["a", "b"]) {
  console.log("left " + item);
}

if (LEFT.length > 0) {
  const tmp = "left-tmp";
  console.log(tmp);
}

try {
  throw new Error("left-boom");
} catch (e) {
  console.log("left caught " + e.message);
}
