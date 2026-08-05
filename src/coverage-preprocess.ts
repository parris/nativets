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
 *   - erases `class X { … }` declarations, RECORDING each as an NT1012 blocker (a real
 *     semantic gap, surfaced in the histogram);
 *   - neutralizes regex literals (`/…/flags` → `""`) so the real lexer doesn't crash on
 *     them.
 * Then it splits the surviving code into top-level statements, so a single
 * un-parseable statement (a generic function, an exotic type) is isolated by the
 * caller's recovery loop rather than blanking the whole file.
 */

import type { Blocker } from "./coverage.ts";
import { NYI } from "./diagnostics.ts";

/** A top-level statement, module syntax stripped, ready to feed to `parse`. */
export interface PreStatement { text: string; line: number }

export interface Preprocessed {
  /** Surviving top-level statements (module preamble removed, regex neutralized). */
  statements: PreStatement[];
  /** Constructs erased during the strip that are real blockers (classes → NT1012). */
  stripped: Blocker[];
}

type TokKind = "ident" | "num" | "str" | "template" | "regex" | "punct" | "comment" | "shebang";
interface Tok { kind: TokKind; value: string; line: number }

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

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
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const nl = (s: string) => { for (const c of s) if (c === "\n") line++; };

  // Shebang: only meaningful on the very first line.
  if (source[0] === "#" && source[1] === "!") {
    let j = 0;
    while (j < n && source[j] !== "\n") j++;
    toks.push({ kind: "shebang", value: source.slice(0, j), line: 1 });
    i = j;
  }

  // The last significant token governs regex-vs-divide disambiguation.
  let prev: Tok | undefined;
  const push = (t: Tok) => { toks.push(t); prev = t; };

  while (i < n) {
    const c = source[i]!;

    if (c === " " || c === "\t" || c === "\r" || c === "\n") { if (c === "\n") line++; i++; continue; }

    // comments
    if (c === "/" && source[i + 1] === "/") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      toks.push({ kind: "comment", value: source.slice(i, j), line });
      i = j; continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      const raw = source.slice(i, j);
      toks.push({ kind: "comment", value: raw, line });
      nl(raw); i = j; continue;
    }

    // regex literal — only where a value can't be (after an operator/keyword/start)
    if (c === "/" && regexAllowed(prev)) {
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
      while (i < n && ID_PART.test(source[i]!)) i++; // flags
      push({ kind: "regex", value: source.slice(start, i), line });
      continue;
    }

    // string
    if (c === '"' || c === "'") {
      const start = i; const q = c; i++;
      while (i < n && source[i] !== q) { if (source[i] === "\\") i++; i++; }
      i++; // closing quote
      push({ kind: "str", value: source.slice(start, i), line });
      continue;
    }

    // template literal (with ${…} nesting; treated as one atom)
    if (c === "`") {
      const start = i; const startLine = line; i++;
      let depth = 0;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`" && depth === 0) { i++; break; }
        if (ch === "$" && source[i + 1] === "{") { depth++; i += 2; continue; }
        if (ch === "}" && depth > 0) { depth--; i++; continue; }
        if (ch === "\n") line++;
        i++;
      }
      push({ kind: "template", value: source.slice(start, i), line: startLine });
      continue;
    }

    // number
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < n && /[0-9a-fA-FxXeE._+-]/.test(source[i]!)) {
        // stop a trailing +/- that isn't part of an exponent
        if ((source[i] === "+" || source[i] === "-") && !/[eE]/.test(source[i - 1] ?? "")) break;
        i++;
      }
      push({ kind: "num", value: source.slice(start, i), line });
      continue;
    }

    // identifier / keyword
    if (ID_START.test(c)) {
      const start = i;
      while (i < n && ID_PART.test(source[i]!)) i++;
      push({ kind: "ident", value: source.slice(start, i), line });
      continue;
    }

    // punctuation — longest first so multi-char operators stay intact
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (["===", "!==", ">>>", "...", "**=", "<<=", ">>="].includes(three)) { push({ kind: "punct", value: three, line }); i += 3; continue; }
    if (["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "<<", ">>", "&=", "|=", "^=", "**", "|>"].includes(two)) { push({ kind: "punct", value: two, line }); i += 2; continue; }
    // stray characters the real lexer would reject (`#`, `\`, `@`) — keep as punct so
    // the strip/split can still reason about structure; they land in a statement chunk
    // that simply fails to parse (and is reported), never a tokenizer crash.
    push({ kind: "punct", value: c, line });
    i++;
  }
  return toks;
}

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === "punct") return prev.value !== ")" && prev.value !== "]" && prev.value !== "}";
  if (prev.kind === "ident") return REGEX_PREFIX_KW.has(prev.value);
  return false; // after a value (num/str/template/regex) a `/` is division
}

/** Identifiers that do NOT produce a value — after them a `/` is regex and a `!` is `not`. */
const NON_VALUE_KW = REGEX_PREFIX_KW;

/**
 * Reconstruct parseable source from a token group: regex literals become `""`, and a
 * postfix non-null assertion `!` (which TS erases) is dropped so the real parser — which
 * has no `!` postfix — doesn't choke on the pervasive `x!` / `arr[i]!` in the compiler
 * source. A leading `!x` (logical not) is preserved (its predecessor isn't a value).
 */
function emit(toks: Tok[]): string {
  const parts: string[] = [];
  let prevVal = false; // did the previous emitted token yield a value?
  for (const t of toks) {
    if (t.kind === "comment") continue;
    if (t.kind === "punct" && t.value === "!" && prevVal) continue; // non-null assertion → erase
    parts.push(t.kind === "regex" ? '""' : t.value);
    if (t.kind === "ident") prevVal = !NON_VALUE_KW.has(t.value);
    else if (t.kind === "punct") prevVal = t.value === ")" || t.value === "]";
    else prevVal = t.kind === "num" || t.kind === "str" || t.kind === "template" || t.kind === "regex";
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
  const statements: PreStatement[] = [];

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
      const t = toks[j]!;
      if (isP(t, "{")) cur++; else if (isP(t, "}")) cur--;
      else if (isP(t, "(")) par++; else if (isP(t, ")")) par--;
      else if (isP(t, "[")) br++; else if (isP(t, "]")) br--;
      else if (isP(t, ";") && cur <= 0 && par <= 0 && br <= 0) return j + 1;
    }
    return n;
  };

  while (i < n) {
    if (toks[i]!.kind === "shebang") { i++; continue; }

    // At a top-level statement start, strip leading module/visibility modifiers
    // (`export`, `async`, `declare`, …) so the decl keyword after them is analyzed.
    while (i < n && toks[i]!.kind === "ident" && PREFIX_MODIFIERS.has(toks[i]!.value)) i++;
    if (i >= n) break;
    const t = toks[i]!;

    if (isKw(t, "import")) { i = skipToSemicolon(i); continue; }
    if (isKw(t, "type") && toks[i + 1]?.kind === "ident") { i = skipToSemicolon(i); continue; }
    if (isKw(t, "interface")) { i = skipBraceBlock(i); continue; }
    if (isKw(t, "class")) {
      stripped.push({ code: NYI.CLASS.code, feature: `class ${toks[i + 1]?.value ?? ""}`.trim(), milestone: NYI.CLASS.milestone, hint: NYI.CLASS.hint, count: 1 });
      i = skipBraceBlock(i);
      continue;
    }

    // A normal top-level statement: collect tokens until a safe boundary. We split
    // BEFORE a statement-starter keyword that follows a completed statement (`}`/`;`)
    // — a point that never lands inside a signature or a type annotation's braces —
    // and AFTER a top-level `;`. Over-grouping is harmless (the parser reads multiple
    // statements per chunk); splitting INSIDE one would fabricate failures, so we don't.
    const startLine = t.line;
    const group: Tok[] = [];
    let cur = 0, par = 0, br = 0;
    while (i < n) {
      const tk = toks[i]!;
      const balanced = cur <= 0 && par <= 0 && br <= 0;
      if (group.length && balanced && tk.kind === "ident" && STMT_STARTERS.has(tk.value)) {
        const prev = group[group.length - 1]!;
        const closed = isP(prev, "}") || isP(prev, ";");
        const doWhile = tk.value === "while" && isKw(group[0], "do");
        if (closed && !doWhile) break; // start a fresh statement here
      }
      group.push(tk); i++;
      if (isP(tk, "{")) cur++;
      else if (isP(tk, "}")) cur--;
      else if (isP(tk, "(")) par++;
      else if (isP(tk, ")")) par--;
      else if (isP(tk, "[")) br++;
      else if (isP(tk, "]")) br--;
      if (cur <= 0 && par <= 0 && br <= 0 && isP(tk, ";")) break; // `;`-terminated statement
    }
    const text = emit(group).trim();
    if (text) statements.push({ text, line: startLine });
  }

  return { statements, stripped };
}
