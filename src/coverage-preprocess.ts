/*
 * Coverage-only preprocess (self-hosting milestone SH0).
 *
 * The compiler's own source (`src/*.ts`) is written in a modular, class-based,
 * discriminated-union-heavy TypeScript that the accepted single-file, module-less
 * subset does not parse — so `nativets coverage src/checker.ts` used to die at
 * parse time on ~line 10 (the `#!` shebang / `import` / `type` / `interface`
 * preamble, or a regex literal the lexer can't tokenize) before any feature-level
 * analysis could run.
 *
 * This module is a lightweight, *coverage-only* pre-strip that gets past that Tier-0
 * surface so `coverage` can report the REAL next blockers (classes, generics, …) as a
 * histogram — a gradient, not a wall. It is deliberately NOT wired into the real
 * compile pipeline: normal programs never go through here, so parsing them is
 * unchanged.
 *
 * What it does, over a tolerant tokenizer (which — unlike the real lexer — never
 * throws on `#!`, a stray `\`, or a regex literal):
 *   - drops a leading `#!` shebang line;
 *   - erases `import …;` / `import type …;` statements;
 *   - drops `export` / `default` / `declare` / `async` / `abstract` keyword prefixes
 *     (so `export function f` becomes plain `function f`);
 *   - erases `type X = …;` aliases and `interface X { … }` declarations (type-level,
 *     legitimately erasable — not counted as blockers);
 *   - neutralizes regex literals (`/…/flags` → `""`) so the real lexer doesn't crash on
 *     them.
 *
 * It NO LONGER erases `class X { … }`. That line used to read "erases class declarations,
 * RECORDING each as an NT1012 blocker", and it went stale when minimal classes started to
 * parse and compile: a class now flows through to the real parser as an ordinary statement
 * and surfaces its own next blocker (NT1015) there. The consequence is that `stripped`
 * below has NO producer left and is always empty — see its doc comment for why the field
 * nonetheless stays.
 * Then it splits the surviving code into top-level statements, so a single
 * un-parseable statement (a generic function, an exotic type) is isolated by the
 * caller's recovery loop rather than blanking the whole file.
 */

/**
 * One blocking feature, grouped by NT code — the unit of the coverage histogram.
 *
 * It is declared HERE, in the leaf, rather than in `coverage.ts` where it is consumed,
 * because this file's `Preprocessed.stripped` is typed in terms of it and `coverage.ts`
 * already imports this file for `preprocessForCoverage`. (This used to say that this file
 * PRODUCES the first blockers; it no longer produces any — see `stripped`. The reason the
 * declaration lives down here is the cycle below, which is unaffected.) Declaring it in the consumer
 * closed a cycle — `coverage.ts → coverage-preprocess.ts → coverage.ts` — whose closing
 * edge was `import type`. node and bun erase that edge, so the cycle was invisible to
 * them, but the linker (src/modules.ts) links modules in dependency order and resolves
 * each one's types from the modules linked BEFORE it, so it has to refuse a cycle it
 * cannot order. Moving the declaration DOWN a layer, to the module that does not import
 * the other, is the fix the NT1702 hint asks for. See docs/divergences.md.
 */
export interface Blocker { code: string; feature: string; milestone: string; hint: string; count: number; }

/** A top-level statement, module syntax stripped, ready to feed to `parse`. */
export interface PreStatement { text: string; line: number }

export interface Preprocessed {
  /** Surviving top-level statements (module preamble removed, regex neutralized). */
  statements: PreStatement[];
  /**
   * Constructs erased during the strip that are themselves real blockers.
   *
   * ALWAYS EMPTY TODAY, and that is a statement about the frontier, not an oversight.
   * `class` was the only producer this ever had; classes compile now, so nothing is
   * erased-and-blocking any more. Left in place deliberately rather than deleted:
   *
   *   - it is a stable OBSERVABLE in the SH6 self-compile differential, which prints
   *     `pre.stripped.length` from a generated driver and compares bun against the
   *     nativets-built binary (test/sh6.test.ts, test/sh6-fuzz.ts). Removing it would
   *     shrink that seam;
   *   - `test/self-host-coverage.test.ts` asserts it contains no NT1012, which is the
   *     regression test for "classes are no longer pre-stripped";
   *   - docs/self-hosting.md records a byte-for-byte diff of the WHOLE `Preprocessed`
   *     (statements, lines, `stripped`, `erasedNames`) over a 495-file corpus as the
   *     evidence for a past rewrite; changing the shape invalidates that baseline.
   *
   * So it is the re-entry point for the next erase-and-record construct, not dead weight.
   * Its consumers in `coverage.ts` are correspondingly inert — noted there too, so nobody
   * reads them as live logic.
   */
  stripped: Blocker[];
  /**
   * Every name the strip ERASED a declaration (or an import binding) for, collected as it
   * was thrown away: `import` specifiers, `type X = …`, `interface X { … }`.
   *
   * The strip deletes those but the ANNOTATIONS that use them survive into the statements
   * below, so without this the parser sees `t: Token` with no `Token` anywhere — an
   * artifact of the strip, not a property of the program — and refuses it (NT2003,
   * `refuseUnknownName` in src/parser.ts). Handing the names back keeps those annotations
   * on the erase-to-`number` fallback they were always on here.
   *
   * Collected LEXICALLY rather than from a whole-file parse, because the files this tool
   * exists for are precisely the ones whose full parse fails.
   */
  erasedNames: string[];
}

type TokKind = "ident" | "num" | "str" | "template" | "regex" | "punct" | "comment" | "shebang";
interface Tok { kind: TokKind; value: string; line: number }

/**
 * The tokenizer's cursor: the 1-based line it is on, and whether a `/` read next would
 * begin a REGEX literal rather than a division — which is a function of the last
 * SIGNIFICANT token emitted.
 *
 * It is a RECORD rather than two `let`s for exactly the reason `src/lexer.ts`'s
 * `LexState` is one: `nl` is a closure that moves it, and a write to a binding captured
 * from an enclosing scope is `NT1031` — it was this module's first blocker in the
 * standalone column of `test/selfhost-ratchet.test.ts`. Mutating a FIELD of an owned
 * local is not a capture write (the binding never changes, the object does), and
 * `//@@mutable` is a comment to TypeScript, so bun runs this file unchanged.
 *
 * `regexOk` is a BOOLEAN rather than the previous token itself, which is what it used to
 * be. Keeping the token meant every append had to store it twice — once into the array
 * and once into this record — and `.push` CONSUMES its argument (docs/decorators.md), so
 * the second store is a use-after-move (`NT1601`), while reading it back out of the
 * array is `NT1605` (cannot move out of an array element). The predicate is all any
 * caller ever wanted, and a `boolean` copies freely. This mirrors `emit`'s `prevVal`.
 */
//@@mutable
interface TokState { line: number; regexOk: boolean }

/*
 * Character classes, spelled out — the same discipline as `src/lexer.ts`. nativets has no
 * `RegExp` (docs/divergences.md), so the compiler's own source may not use one; this
 * module in particular, whose whole job is to make `src/` measurable, must be measurable
 * itself. `test/no-regex.test.ts` pins each class against the regex it replaced over
 * every BMP code point.
 */
/** `[A-Za-z_$]`. */
function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
}
/** `[A-Za-z0-9_$]` (= `[\w$]`). */
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}
/** `[0-9a-fA-F]`. */
function isHexDigit(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}
/** ECMAScript `\s` — WhiteSpace + LineTerminator, by code unit. */
function isSpace(c: string): boolean {
  const n = c.charCodeAt(0);
  if (n === 9 || n === 10 || n === 11 || n === 12 || n === 13 || n === 32) return true;
  return (
    n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) ||
    n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f ||
    n === 0x3000 || n === 0xfeff
  );
}
/**
 * `[0-9a-fA-FxXeE._+-]` — every character this forgiving tokenizer will absorb into a
 * numeric literal, radix prefixes and exponents included. (`e`/`E` are already hex
 * digits; `x`/`X` are the extra.)
 */
function isNumChar(c: string): boolean {
  return isHexDigit(c) || c === "x" || c === "X" ||
    c === "." || c === "_" || c === "+" || c === "-";
}

/** `^\s*@@([A-Za-z_$][\w$]*)\s*$` — the pragma; `""` when the comment is anything else. */
function pragmaName(body: string): string {
  let a = 0;
  while (a < body.length && isSpace(body[a]!)) a++;
  // The bounds test is load-bearing — a bare `//` has an EMPTY body and `body[a]` is then
  // a read at index == length, which nativets PANICS on. Same defect, same fix, as
  // `pragmaName` in src/lexer.ts; this module carries a copy of it.
  if (a + 1 >= body.length || body[a] !== "@" || body[a + 1] !== "@") return "";
  a += 2;
  if (a >= body.length || !isIdentStart(body[a]!)) return "";
  const start = a;
  a++;
  while (a < body.length && isIdentPart(body[a]!)) a++;
  const name = body.slice(start, a);
  while (a < body.length && isSpace(body[a]!)) a++;
  return a === body.length ? name : "";
}

/** Keywords after which a `/` begins a regex literal (not division). */
const REGEX_PREFIX_KW = new Set([
  "return", "typeof", "case", "in", "of", "do", "else", "void", "delete",
  "instanceof", "new", "yield", "await", "throw",
]);

/**
 * A forgiving tokenizer: it classifies enough structure to strip and split, and —
 * critically — never throws on input the real lexer rejects (`#!`, `\`, regex). It is
 * intentionally separate from `src/lexer.ts` so the real lexer stays untouched.
 */
function tokenize(source: string): Tok[] {
  // The token accumulator: an `@@mutable` binding so `.push` appends in place (see
  // docs/decorators.md). Every append happens HERE, in the function body — the old
  // `const push = (t) => { toks.push(t); st.prev = t }` closure captured this array, and a
  // captured accumulator is `NT1607` (a closure env holds a pointer this scope cannot
  // null). The two lines it saved are written out at each site instead.
  //@@mutable
  const toks: Tok[] = [];
  let i = 0;
  const st: TokState = { line: 1, regexOk: true };
  const n = source.length;
  const nl = (s: string) => { for (const c of s) if (c === "\n") st.line++; };

  // Shebang: only meaningful on the very first line.
  // `n >= 2` FIRST: on an EMPTY file `source[0]` is a read at index == length, which
  // nativets PANICS on (Stage 41) — the compiled preprocessor could not handle an empty
  // file at all. Same class as `pragmaName` above.
  if (n >= 2 && source[0] === "#" && source[1] === "!") {
    let j = 0;
    while (j < n && source[j] !== "\n") j++;
    toks.push({ kind: "shebang", value: source.slice(0, j), line: 1 });
    i = j;
  }

  // The last significant token governs regex-vs-divide disambiguation; `st.regexOk`
  // carries that one bit forward, and every append below sets it (see `TokState`).
  while (i < n) {
    const c = source[i]!;

    if (c === " " || c === "\t" || c === "\r" || c === "\n") { if (c === "\n") st.line++; i++; continue; }

    // comments
    // `i + 1 < n` FIRST, here and at the `/*` opener below: a file whose LAST byte is `/`
    // reads index == length, which nativets PANICS on (Stage 41). The same six-site class
    // as src/lexer.ts's — this module carries a copy of that scanner.
    if (c === "/" && i + 1 < n && source[i + 1] === "/") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      // `//@@name` is a PRAGMA, not a comment — the comment spelling of a compile-time
      // attribute, which is how the compiler's own source can carry `@@mutable` and still
      // be run by bun (see src/lexer.ts). Comments are dropped below, so it must be
      // re-emitted as the two tokens the real lexer produces for the bare sigil.
      const attr = pragmaName(source.slice(i + 2, j));
      if (attr !== "") {
        // Both tokens land; the SECOND (the attribute name) is what the next `/` sees.
        st.regexOk = regexAllowed("ident", attr);
        toks.push({ kind: "punct", value: "@@", line: st.line });
        toks.push({ kind: "ident", value: attr, line: st.line });
      } else {
        toks.push({ kind: "comment", value: source.slice(i, j), line: st.line });
      }
      i = j; continue;
    }
    if (c === "/" && i + 1 < n && source[i + 1] === "*") {
      let j = i + 2;
      // The SECOND read needs its own guard: an unterminated `/*` ending in a lone `*`
      // puts `j + 1` one past the end.
      while (j < n && !(source[j] === "*" && j + 1 < n && source[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      const raw = source.slice(i, j);
      toks.push({ kind: "comment", value: raw, line: st.line });
      nl(raw); i = j; continue;
    }

    // regex literal — only where a value can't be (after an operator/keyword/start)
    if (c === "/" && st.regexOk) {
      const start = i;
      i++; // past opening /
      let inClass = false;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { i++; break; }
        else if (ch === "\n") break; // not a regex after all — bail out safely
        i++;
      }
      while (i < n && isIdentPart(source[i]!)) i++; // flags
      st.regexOk = false; // after a value, the next `/` is division
      toks.push({ kind: "regex", value: source.slice(start, i), line: st.line });
      continue;
    }

    // string
    if (c === '"' || c === "'") {
      const start = i; const q = c; i++;
      while (i < n && source[i] !== q) { if (source[i] === "\\") i++; i++; }
      i++; // closing quote
      st.regexOk = false;
      toks.push({ kind: "str", value: source.slice(start, i), line: st.line });
      continue;
    }

    // template literal (with ${…} nesting; treated as one atom)
    if (c === "`") {
      const start = i; const startLine = st.line; i++;
      let depth = 0;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`" && depth === 0) { i++; break; }
          // `i + 1 < n` first: a `$` that ENDS the input reads past it.
        if (ch === "$" && i + 1 < n && source[i + 1] === "{") { depth++; i += 2; continue; }
        if (ch === "}" && depth > 0) { depth--; i++; continue; }
        if (ch === "\n") st.line++;
        i++;
      }
      st.regexOk = false;
      toks.push({ kind: "template", value: source.slice(start, i), line: startLine });
      continue;
    }

    // number
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < n && isNumChar(source[i]!)) {
        // stop a trailing +/- that isn't part of an exponent
        const p = source[i - 1] ?? "";
        if ((source[i] === "+" || source[i] === "-") && p !== "e" && p !== "E") break;
        i++;
      }
      st.regexOk = false;
      toks.push({ kind: "num", value: source.slice(start, i), line: st.line });
      continue;
    }

    // identifier / keyword
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(source[i]!)) i++;
      // The predicate is computed BEFORE the append: `.push` consumes its argument, and
      // `word` is moved into the token literal there (docs/decorators.md).
      const word = source.slice(start, i);
      st.regexOk = regexAllowed("ident", word);
      toks.push({ kind: "ident", value: word, line: st.line });
      continue;
    }

    // punctuation — longest first so multi-char operators stay intact
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (["===", "!==", ">>>", "...", "**=", "<<=", ">>="].includes(three)) { st.regexOk = regexAllowed("punct", three); toks.push({ kind: "punct", value: three, line: st.line }); i += 3; continue; }
    if (["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "<<", ">>", "&=", "|=", "^=", "**", "|>", "@@"].includes(two)) { st.regexOk = regexAllowed("punct", two); toks.push({ kind: "punct", value: two, line: st.line }); i += 2; continue; }
    // stray characters the real lexer would reject (`#`, `\`, `@`) — keep as punct so
    // the strip/split can still reason about structure; they land in a statement chunk
    // that simply fails to parse (and is reported), never a tokenizer crash.
    st.regexOk = regexAllowed("punct", c);
    toks.push({ kind: "punct", value: c, line: st.line });
    i++;
  }
  return toks;
}

/**
 * Whether a `/` read immediately after a token of this kind and text begins a REGEX
 * literal rather than a division. Takes the two fields rather than the token because the
 * token itself is consumed by `.push` at every call site (see `TokState.regexOk`); the
 * answer is unchanged.
 */
function regexAllowed(kind: TokKind, value: string): boolean {
  if (kind === "punct") return value !== ")" && value !== "]" && value !== "}";
  if (kind === "ident") return REGEX_PREFIX_KW.has(value);
  return false; // after a value (num/str/template/regex) a `/` is division
}

/** Identifiers that do NOT produce a value — after them a `/` is regex and a `!` is `not`. */
const NON_VALUE_KW = REGEX_PREFIX_KW;

/**
 * Reconstruct parseable source from a token group: regex literals become `""`, and a
 * postfix non-null assertion `!` (which TS erases) is dropped so the real parser — which
 * has no `!` postfix — doesn't choke on the pervasive `x!` / `arr[i]!` in the compiler
 * source. A leading `!x` (logical not) is preserved (its predecessor isn't a value).
 *
 * The group is a half-open WINDOW `[from, to)` into the caller's token array rather than a
 * second array of tokens. Copying the tokens out was `NT1605` — a `Tok` is linear, so it
 * cannot be moved out of an array element — and the window is exact, because the caller
 * only ever grows a group by one CONSECUTIVE token at a time.
 */
function emit(toks: Tok[], from: number, to: number): string {
  // An accumulator, appended in place; no arrow in this scope names it, so it is not the
  // captured shape `NT1607` refuses (docs/decorators.md).
  //@@mutable
  const parts: string[] = [];
  let prevVal = false; // did the previous emitted token yield a value?
  for (let k = from; k < to; k++) {
    // The fields are read out one at a time; `const t = toks[k]!` would MOVE the token out
    // of the array (`NT1605`), while a field read copies.
    const kind = toks[k]!.kind;
    const value = toks[k]!.value;
    if (kind === "comment") continue;
    if (kind === "punct" && value === "!" && prevVal) continue; // non-null assertion → erase
    // Computed before the append, which CONSUMES `value` (docs/decorators.md).
    const yieldsValue = kind === "ident" ? !NON_VALUE_KW.has(value)
      : kind === "punct" ? (value === ")" || value === "]")
      : (kind === "num" || kind === "str" || kind === "template" || kind === "regex");
    parts.push(kind === "regex" ? '""' : value);
    prevVal = yieldsValue;
  }
  return parts.join(" ");
}

const PREFIX_MODIFIERS = new Set(["export", "default", "declare", "async", "abstract", "public", "private", "readonly"]);
/** Keywords that begin a fresh top-level statement — safe split points. */
const STMT_STARTERS = new Set([
  "function", "const", "let", "var", "class", "interface", "type", "enum",
  "if", "for", "while", "do", "switch", "try", "return", "throw", "break", "continue",
  "import", "export",
]);

/**
 * Strip module/type surface and split into top-level statements.
 * Operates on the tolerant token stream (comments retained only for structure; dropped
 * on emit), so no character ever reaches the real lexer that would make it throw.
 */
export function preprocessForCoverage(source: string): Preprocessed {
  const toks = tokenize(source).filter((t) => t.kind !== "comment");
  const stripped: Blocker[] = [];
  //@@mutable
  const statements: PreStatement[] = [];
  // A `Set` is PERSISTENT here: `.add` returns a new set and leaves the receiver alone,
  // so the result has to be rebound (discarding it is `NT1606`). Under bun the spelling is
  // a no-op — `Set.prototype.add` returns the same set — so both toolchains agree.
  let erasedNames = new Set<string>();

  let i = 0;
  const n = toks.length;
  const isP = (t: Tok | undefined, v: string) => !!t && t.kind === "punct" && t.value === v;
  const isKw = (t: Tok | undefined, v: string) => !!t && t.kind === "ident" && t.value === v;

  // Consume a balanced `{ … }` block starting at the next `{`, returning the index
  // just past the closing brace (or end).
  const skipBraceBlock = (from: number): number => {
    let j = from;
    while (j < n && !isP(toks[j], "{")) j++;
    if (j >= n) return n;
    let depth = 0;
    for (; j < n; j++) {
      if (isP(toks[j], "{")) depth++;
      else if (isP(toks[j], "}")) { depth--; if (depth === 0) return j + 1; }
    }
    return n;
  };
  // Consume up to and including the next top-level `;` (brace/paren/bracket aware).
  const skipToSemicolon = (from: number): number => {
    let j = from, cur = 0, par = 0, br = 0;
    for (; j < n; j++) {
      if (isP(toks[j], "{")) cur++; else if (isP(toks[j], "}")) cur--;
      else if (isP(toks[j], "(")) par++; else if (isP(toks[j], ")")) par--;
      else if (isP(toks[j], "[")) br++; else if (isP(toks[j], "]")) br--;
      else if (isP(toks[j], ";") && cur <= 0 && par <= 0 && br <= 0) return j + 1;
    }
    return n;
  };

  while (i < n) {
    if (toks[i]!.kind === "shebang") { i++; continue; }

    // At a top-level statement start, strip leading module/visibility modifiers
    // (`export`, `async`, `declare`, …) so the decl keyword after them is analyzed.
    while (i < n && toks[i]!.kind === "ident" && PREFIX_MODIFIERS.has(toks[i]!.value)) i++;
    if (i >= n) break;

    if (isKw(toks[i], "import")) {
      const end = skipToSemicolon(i);
      // Keep the NAMES this import bound before dropping it — see `erasedNames`. `from`,
      // `type` and `as` are the clause's own keywords, never bindings.
      for (let j = i + 1; j < end; j++) {
        if (toks[j]!.kind === "ident" && toks[j]!.value !== "from" && toks[j]!.value !== "type" && toks[j]!.value !== "as") erasedNames = erasedNames.add(toks[j]!.value);
      }
      i = end;
      continue;
    }
    // A PLAIN `type`/`interface` is still erased (type-level, legitimately erasable — it
    // is not counted as a blocker). A DECORATED one is not: `@@mutable type Cell = { … }`
    // changes how later statements COMPILE, so erasing it would make `coverage` report an
    // NT1606 the real compiler does not. Those reach the real parser (the decorator sigil
    // is what `t` is here, so neither branch below matches) and their alias travels to the
    // next statement via `ParseOpts.collectTypes`.
    // Both erasures record the NAME they dropped (`erasedNames`): the annotations that use
    // it survive into the statements below, and a parser that cannot see the declaration
    // would refuse the name outright (NT2003) instead of falling back as it does today.
    if (isKw(toks[i], "type") && toks[i + 1]?.kind === "ident") { erasedNames = erasedNames.add(toks[i + 1]!.value); i = skipToSemicolon(i); continue; }
    if (isKw(toks[i], "interface")) {
      if (toks[i + 1]?.kind === "ident") erasedNames = erasedNames.add(toks[i + 1]!.value);
      i = skipBraceBlock(i);
      continue;
    }
    // `class` is no longer erased: minimal classes (fields + constructor + methods) now
    // parse + compile, so the class flows to the real parser as an ordinary statement.
    // A class using a still-deferred feature (inheritance/static/modifiers/field
    // initializers/parameter properties) surfaces its real next blocker (NT1015) there.

    // A normal top-level statement: collect tokens until a safe boundary. We split
    // BEFORE a statement-starter keyword that follows a completed statement (`}`/`;`)
    // — a point that never lands inside a signature or a type annotation's braces —
    // and AFTER a top-level `;`. Over-grouping is harmless (the parser reads multiple
    // statements per chunk); splitting INSIDE one would fabricate failures, so we don't.
    const startLine = toks[i]!.line;
    // The group is the half-open window `[gStart, i)` of `toks` — an index pair, not a
    // second array. It can be, because the group only ever grows by the token at `i` and
    // then advances `i`; and it has to be, because a `Tok` is linear and copying one out
    // of `toks` is `NT1605`.
    const gStart = i;
    let cur = 0, par = 0, br = 0;
    while (i < n) {
      // Every read of the current token indexes `toks` in place. Binding it to a local
      // (`const tk = toks[i]!`) is a MOVE out of the array, which a linear element type
      // refuses (`NT1605`); a field read, and passing the element straight to a predicate,
      // are both borrows.
      const balanced = cur <= 0 && par <= 0 && br <= 0;
      if (i > gStart && balanced && toks[i]!.kind === "ident" && STMT_STARTERS.has(toks[i]!.value)) {
        const closed = isP(toks[i - 1], "}") || isP(toks[i - 1], ";");
        const doWhile = toks[i]!.value === "while" && isKw(toks[gStart], "do");
        if (closed && !doWhile) break; // start a fresh statement here
      }
      // A decorator sigil after a completed statement starts a fresh one too, so a
      // decorated declaration is analyzed on its own rather than glued to its predecessor.
      if (i > gStart && balanced && (isP(toks[i], "@@") || isP(toks[i], "@"))) {
        if (isP(toks[i - 1], "}") || isP(toks[i - 1], ";")) break;
      }
      // The depth updates and the `;` test read the token at `i`, so they are taken BEFORE
      // `i` advances (they used to read a bound `tk` that outlived the increment).
      if (isP(toks[i], "{")) cur++;
      else if (isP(toks[i], "}")) cur--;
      else if (isP(toks[i], "(")) par++;
      else if (isP(toks[i], ")")) par--;
      else if (isP(toks[i], "[")) br++;
      else if (isP(toks[i], "]")) br--;
      const semi = isP(toks[i], ";");
      i++;
      if (cur <= 0 && par <= 0 && br <= 0 && semi) break; // `;`-terminated statement
    }
    const text = emit(toks, gStart, i).trim();
    if (text) statements.push({ text, line: startLine });
  }

  return { statements, stripped, erasedNames: [...erasedNames] };
}
