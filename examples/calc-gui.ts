// calc-gui.ts — a NATIVE GUI calculator (docs/examples.md C-d, the north-star
// "calculator UI app that compiles on every platform").
//
// The window + button grid are drawn with the raylib-backed GUI FFI (initWindow /
// beginDraw / drawRect / drawText / mouse*, in the runtime as nt_gui.c). raylib is
// a tiny immediate-mode graphics lib that targets macOS/Linux/Windows AND wasm, so
// it fits nativets' retargetable backend.
//
//   RUN (host desktop, needs raylib + a display):
//       nativets run examples/calc-gui.ts
//   BUILD a binary:
//       nativets build examples/calc-gui.ts -o calc-gui   # then ./calc-gui
//
//   raylib install:  macOS → `brew install raylib`
//                    Linux → your distro's `raylib` / `libraylib-dev`
//   nt_gui.c + -lraylib (+ the macOS Cocoa/OpenGL frameworks) are linked ONLY when
//   a program calls a GUI builtin, so non-GUI programs stay raylib-free (driver.ts).
//
//   wasm/web (follow-on): raylib DOES build to WebAssembly, but via emscripten +
//   raylib-web, which is a DIFFERENT toolchain from nativets' current `--target
//   wasm` (wasi/wasi-libc, no DOM/GL). Wiring an emscripten lane is a documented
//   follow-on; today the GUI target is host desktop.
//
// The arithmetic engine is the precedence-climbing evaluator from calculator.ts
// (copied inline — no modules), in the IMMUTABLE subset: the expression is built by
// string concatenation and the UI state is a fresh record each click (`step`
// returns a NEW state, never mutates).
//
// A GUI window can't be differential-tested, so the interactive behaviour is
// factored into two PURE, node-differential-testable functions:
//   buttonAt(px, py) -> label   hit-test a click against the button grid
//   step(state, label) -> state the click handler (append / evaluate / clear)
// tested directly against node (byte-for-byte) in test/calc-gui.test.ts, without a
// live window. The build-verify there compiles the whole file iff raylib is present
// and SKIPs otherwise. Everything below the INTERACTIVE MAIN marker (the frame loop
// + the GUI builtins) is stripped by those tests.

// ---------------------------------------------------------------------------
// Arithmetic engine (identical to examples/calculator.ts / calc-tui.ts)
// ---------------------------------------------------------------------------

function isDigit(c: string): boolean {
  return "0123456789".indexOf(c) >= 0;
}

function tokenize(s: string): { kind: string; num: number }[] {
  let acc: { kind: string; num: number }[] = [{ kind: "^", num: 0 }]; // sentinel at 0
  let i: number = 0;
  while (i < s.length) {
    const c: string = s.charAt(i);
    if (c === " ") {
      i = i + 1;
    } else if (isDigit(c) || c === ".") {
      let j: number = i;
      while (j < s.length && (isDigit(s.charAt(j)) || s.charAt(j) === ".")) {
        j = j + 1;
      }
      acc = [...acc, { kind: "num", num: parseFloat(s.slice(i, j)) }];
      i = j;
    } else {
      acc = [...acc, { kind: c, num: 0 }];
      i = i + 1;
    }
  }
  return acc;
}

function precedence(op: string): number {
  if (op === "+" || op === "-") return 1;
  if (op === "*" || op === "/" || op === "%") return 2;
  return 0;
}

function isBinaryOp(op: string): boolean {
  return op === "+" || op === "-" || op === "*" || op === "/" || op === "%";
}

function applyOp(op: string, a: number, b: number): number {
  if (op === "+") return a + b;
  if (op === "-") return a - b;
  if (op === "*") return a * b;
  if (op === "/") return a / b;
  return a % b;
}

function parsePrimary(toks: { kind: string; num: number }[], pos: number): { value: number; pos: number } {
  const kind: string = toks[pos].kind;
  if (kind === "-") {
    const r = parsePrimary(toks, pos + 1);
    return { value: -r.value, pos: r.pos };
  }
  if (kind === "+") {
    const r = parsePrimary(toks, pos + 1);
    return { value: r.value, pos: r.pos };
  }
  if (kind === "(") {
    const inner = parseExpr(toks, pos + 1, 0);
    return { value: inner.value, pos: inner.pos + 1 };
  }
  return { value: toks[pos].num, pos: pos + 1 };
}

function parseExpr(toks: { kind: string; num: number }[], pos: number, minPrec: number): { value: number; pos: number } {
  const first = parsePrimary(toks, pos);
  let value: number = first.value;
  let p: number = first.pos;
  while (p < toks.length && isBinaryOp(toks[p].kind) && precedence(toks[p].kind) >= minPrec) {
    const op: string = toks[p].kind;
    const rhs = parseExpr(toks, p + 1, precedence(op) + 1);
    value = applyOp(op, value, rhs.value);
    p = rhs.pos;
  }
  return { value: value, pos: p };
}

function evaluate(s: string): number {
  const toks = tokenize(s);
  const r = parseExpr(toks, 1, 0); // index 0 is the sentinel
  return r.value;
}

// ---------------------------------------------------------------------------
// Button-grid layout — shared by the hit-test and the renderer so a click always
// lands on the same button it draws. A 4-column x 5-row grid, row-major. Constants
// are exposed as tiny functions so both buttonAt() (pure, tested) and the frame
// renderer (below the marker) read the SAME numbers.
// ---------------------------------------------------------------------------

function gridX(): number { return 10; }
function gridY(): number { return 80; }
function cellW(): number { return 55; }
function cellH(): number { return 55; }
function gridCols(): number { return 4; }
function gridRows(): number { return 5; }

// The 20 button labels, row-major (index = row * 4 + col). "" is a blank cell.
function buttonLabels(): string[] {
  return [
    "C", "(", ")", "/",
    "7", "8", "9", "*",
    "4", "5", "6", "-",
    "1", "2", "3", "+",
    "0", ".", "=", "",
  ];
}

// Hit-test a click at (px, py) against the grid → the button's label, or "" for a
// miss / blank cell. PURE arithmetic + array reads only (no GUI builtin), so it is
// node-differential-testable without raylib.
function buttonAt(px: number, py: number): string {
  const lx: number = px - gridX();
  const ly: number = py - gridY();
  if (lx < 0 || ly < 0) return "";
  const col: number = Math.floor(lx / cellW());
  const row: number = Math.floor(ly / cellH());
  if (col < 0 || col >= gridCols() || row < 0 || row >= gridRows()) return "";
  const idx: number = row * gridCols() + col;
  const labels = buttonLabels();
  return labels[idx];
}

// ---------------------------------------------------------------------------
// Pure UI core: state = { expr, result }.
//   expr   — the expression being typed
//   result — the last evaluated result (as a string; "" before any `=`)
// ---------------------------------------------------------------------------

// The click handler — PURE: returns a brand-new state, never mutates its input.
//   ""     -> a miss / blank cell (state unchanged)
//   C      -> clear (expr and result reset)
//   =      -> evaluate the current expression (v1 assumes it is well-formed)
//   other  -> append the label to the expression (and drop any stale result)
function step(
  state: { expr: string; result: string },
  label: string
): { expr: string; result: string } {
  if (label.length === 0) {
    return { expr: state.expr, result: state.result };
  }
  if (label === "C") {
    return { expr: "", result: "" };
  }
  if (label === "=") {
    if (state.expr.length === 0) {
      return { expr: state.expr, result: "" };
    }
    const v: number = evaluate(state.expr);
    return { expr: state.expr, result: "" + v };
  }
  return { expr: state.expr + label, result: "" };
}

// The text shown on the display panel: the result once evaluated, else the
// expression being typed, else a placeholder "0". PURE.
function displayText(state: { expr: string; result: string }): string {
  if (state.result.length > 0) return state.result;
  if (state.expr.length > 0) return state.expr;
  return "0";
}

// A palette index (see nt_gui.c) for a button's face: red for clear, accent for
// the operators / equals, plain button-face for digits and parens. PURE.
function buttonColor(label: string): number {
  if (label === "C") return 8;                                   // red
  if (label === "=" || isBinaryOp(label)) return 3;              // accent
  return 4;                                                      // button face
}

// ==== INTERACTIVE MAIN ====
// (The pure-function tests strip everything from this marker onward and drive
//  buttonAt()/step()/displayText() directly against the node oracle. Everything
//  below uses the raylib-backed GUI builtins and only runs in a real window.)

initWindow(240, 360, "nativets calc");
setTargetFPS(60);

let state: { expr: string; result: string } = { expr: "", result: "" };

while (!windowShouldClose()) {
  // Input: on a left click, hit-test the grid and advance the state.
  if (mousePressed()) {
    const label: string = buttonAt(mouseX(), mouseY());
    state = step(state, label);
  }

  // Render one frame.
  beginDraw();
  clearBackground(0); // dark shell

  // Display panel + its text (right-ish, large).
  drawRect(10, 10, 220, 60, 5);
  drawText(displayText(state), 20, 28, 28, 2);

  // Button grid.
  let idx: number = 0;
  const labels: string[] = buttonLabels();
  while (idx < gridCols() * gridRows()) {
    const label: string = labels[idx];
    if (label.length > 0) {
      const col: number = idx % gridCols();
      const row: number = Math.floor(idx / gridCols());
      const bx: number = gridX() + col * cellW();
      const by: number = gridY() + row * cellH();
      drawRect(bx + 2, by + 2, cellW() - 4, cellH() - 4, buttonColor(label));
      drawText(label, bx + 20, by + 16, 24, 2);
    }
    idx = idx + 1;
  }

  endDraw();
}
