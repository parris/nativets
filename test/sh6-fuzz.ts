/*
 * SH6 RUNG-3 DIFFERENTIAL FUZZER — the compiled module vs the bun-run module.
 *
 * WHY THIS EXISTS
 * ---------------
 * `test/sh6.test.ts` records three modules at rung 3 (`lexer.ts`, `diagnostics.ts`,
 * `coverage-preprocess.ts`) and backs two of them with a DRIVER differential: a hand
 * written driver that imports the module, does some real work and must print the same
 * bytes when compiled by nativets as it does under `bun run`. That is 466 and 814 bytes
 * of matched output respectively, over a handful of hand-chosen inputs, and its own
 * header says a corpus differential is "necessary, not sufficient". One driver on one
 * input is much weaker than that.
 *
 * This file widens the driver differential from "a handful of inputs" to "every `.ts`
 * file in the tree, plus an adversarial set aimed at the lexer's edges". The interesting
 * failure it is hunting for is NOT in the modules' logic — that logic is identical text
 * on both sides — it is in the code nativets generates for it: refcounted strings,
 * persistent Map/Set tries, ownership drops, `String.fromCharCode`, `parseInt`,
 * `charCodeAt`, `.repeat`, `padStart`, `sort`, spread. Every one of those runs under the
 * nativets runtime on one side and under JavaScriptCore on the other, and no existing
 * test compares them over anything wider than three snippets.
 *
 * HOW TO RUN
 * ----------
 *   bun run test/sh6-fuzz.ts            # 553 inputs x 2 modules + 85 shapes (~6 min)
 *   bun run test/sh6-fuzz.ts --quick    # the adversarial set + every 20th corpus file
 *   bun run test/sh6-fuzz.ts --huge     # …plus the megabyte inputs. READ `skipHuge` FIRST.
 *
 * `test/sh6-fuzz.test.ts` pins the ADVERSARIAL half (no corpus files) as a ratchet — 8
 * seconds, and every root cause the full sweep finds is represented in it. The full sweep
 * is a script rather than a test because it links three binaries and spawns ~2200
 * processes; what it adds is the COUNTS (how many of the 501 real files each cause hits),
 * not new causes.
 *
 * WHAT THE FULL SWEEP FOUND, so a reader does not have to run it: 84 of 553 inputs diverge
 * for `lexer.ts` and 82 of 553 for `coverage-preprocess.ts`. 73 of each are ONE cause — a
 * line comment with an empty body — and the compiled `lexer.ts` aborts on 8 of the
 * compiler's own 12 modules, including itself.
 *
 * WHAT IT COMPARES
 * ----------------
 * stdout, byte for byte, and the exit code. NOT stderr: a compiled program's abort
 * message and bun's stack trace are different text by design (docs/divergences.md), and
 * the SH6 ladder makes the same choice for the same reason.
 *
 * THE ERROR PATH IS IN SCOPE, and it is why the drivers have NO `try`/`catch`. A `throw`
 * that is not inside a `try` IN THE SAME FUNCTION is NT1004 — so a driver that wrapped
 * `lex` in a `try` would not compile at all, and `lexer.ts` only reaches rung 3 today
 * because a program containing no `try` lowers its throws as UNCAUGHT (see
 * `FnGen.uncatchable` in src/codegen.ts). Uncaught is still a comparable observation:
 * node/bun print the error to stderr and exit 1, and `nt_exc_abort` does the same, so
 * stdout-up-to-the-throw plus the exit code must still match. That is the strongest
 * statement available about `LexError` today, and it is recorded as such.
 */

import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary } from "../src/driver.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const srcPath = (m: string) => join(ROOT, "src", m);

/* ============================================================
 * The corpus
 * ============================================================ */

/** Every `.ts` file under `src/`, `test/` and `examples/` — the same corpus the walker
 *  equivalence sweep used, and the largest pile of real TypeScript in the repo. */
export function fileCorpus(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "__snapshots__" || e.name.startsWith(".")) continue;
        walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  for (const d of ["src", "test", "examples"]) walk(join(ROOT, d));
  return out.sort();
}

/**
 * The adversarial set, as (name, bytes). Bytes rather than strings because three of these
 * are not valid UTF-8 or not representable in a JS string literal round trip: a lone
 * surrogate, a NUL, and a BOM.
 *
 * Sources for the edges, rather than invention where a reference existed: test262's
 * `language/literals/string` and `language/comments` for the escape and comment forms,
 * and the ECMAScript grammar's WhiteSpace/LineTerminator tables for the separator set.
 */
export function adversarialCorpus(): { name: string; bytes: Uint8Array }[] {
  const t = (s: string) => new TextEncoder().encode(s);
  const cases: { name: string; bytes: Uint8Array }[] = [];
  const add = (name: string, s: string) => cases.push({ name, bytes: t(s) });

  add("empty.ts", "");
  add("only-newline.ts", "\n");
  add("only-spaces.ts", "   \t  \n\n  ");
  add("shebang.ts", "#!/usr/bin/env bun\nconst a = 1;\n");
  add("shebang-only.ts", "#!/usr/bin/env bun");
  add("crlf.ts", "const a = 1;\r\nconst b = 2;\r\n");
  add("cr-only.ts", "const a = 1;\rconst b = 2;\r");
  add("regex-first.ts", "/ab+c/.test(s);\n");
  add("regex-vs-div.ts", "const a = b / c / d;\nconst r = /x\\/y/g;\nconst q = (1) / 2;\nif (a) /re/.test(s);\n");
  add("regex-class.ts", "const r = /[/]\\//g; const s = /a[^]b/;\n");
  add("template-nested.ts", "const s = `a${`b${`c${d}e`}f`}g`;\n");
  add("template-brace.ts", "const s = `a${ { x: 1 }.x }b`;\n");
  add("template-escape.ts", "const s = `a\\`b\\${c}d`;\n");
  add("template-newline.ts", "const s = `line1\nline2\nline3`;\n");
  add("escapes-all.ts", 'const s = "\\u0041\\u{1F600}\\x41\\n\\t\\r\\v\\f\\b\\\\\\"\\\'\\0";\n');
  add("escape-u-brace-big.ts", 'const s = "\\u{10FFFF}";\n');
  add("escape-octal-1.ts", 'const s = "\\1";\n');
  add("escape-octal-01.ts", 'const s = "\\01";\n');
  add("escape-octal-7.ts", 'const s = "\\7";\n');
  add("escape-nonoctal-8.ts", 'const s = "\\8\\9";\n');
  add("escape-bad-x.ts", 'const s = "\\xZZ";\n');
  add("escape-bad-u.ts", 'const s = "\\uZZZZ";\n');
  add("escape-trailing.ts", 'const s = "abc\\');
  add("unterminated-string.ts", 'const s = "abc\n');
  add("unterminated-string-eof.ts", 'const s = "abc');
  add("unterminated-template.ts", "const s = `abc\n");
  add("unterminated-comment.ts", "/* never closed\nconst a = 1;\n");
  add("unterminated-regex.ts", "const r = /abc\n");
  add("comments.ts", "// line\n/* block */ const a = 1; /** doc */\n//@@mutable\n/*@@x*/\n");
  // A line comment with an EMPTY body, and one with a whitespace-only body. Trivial
  // looking, and the single highest-yield input in this file — 71 of the repo's 501 `.ts`
  // files contain one, including `src/lexer.ts`.
  add("comment-empty.ts", "//");
  add("comment-ws.ts", "// \nconst a = 1;\n");
  add("pragma.ts", "//@@mutable\ninterface S { n: number }\nfunction f(//@@mutable xs: number[]) {}\n");
  add("punct-run.ts", "a >>>= b; a >>= b; a <<= b; a **= b; a ??= b; a?.b; a ?? b; a ?.5 : c;\n");
  add("punct-all.ts", "(){}[],;.=+-*/%<>!?:&|^~@ === !== >>> ... && || ?? ?. ++ -- => |> @@\n");
  add("numbers.ts", "const n = 0xFF + 0b1010 + 0o777 + 1_000_000 + 1e3 + 1E-3 + .5 + 5. + 0.0e0;\n");
  add("numbers-weird.ts", "const n = 1n; const m = 0xFFn; const p = 08; const q = 09.5;\n");
  add("unicode-ident.ts", "const \u00e9t\u00e9 = 1; const \u4e2d\u6587 = 2; const $_ = 3;\n");
  add("unicode-str.ts", 'const s = "\u00e9\u4e2d\ud83d\ude00\u200b";\n');
  add("ls-ps.ts", "const a = 1;\u2028const b = 2;\u2029const c = 3;\n");
  add("weird-space.ts", "const\u00a0a\u3000=\u20001;\n");
  add("bom-inside.ts", "const a = 1;\ufeffconst b = 2;\n");
  add("private-field.ts", "class C { #x = 1; get x() { return this.#x; } }\n");
  add("html-comment.ts", "<!-- a\nconst a = 1;\n--> b\n");
  add("nested-brackets.ts", "const a = " + "(".repeat(2000) + "1" + ")".repeat(2000) + ";\n");
  add("nested-array.ts", "const a = " + "[".repeat(1000) + "]".repeat(1000) + ";\n");
  add("long-line.ts", "const a = " + Array.from({ length: 5000 }, (_, i) => i).join(" + ") + ";\n");
  add("many-lines.ts", Array.from({ length: 20000 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n");
  add("big-ident.ts", "const " + "a".repeat(1_000_000) + " = 1;\n");
  add("big-string.ts", 'const s = "' + "x".repeat(1_000_000) + '";\n');
  add("big-template.ts", "const s = `" + "y".repeat(500_000) + "`;\n");
  add("big-comment.ts", "/*" + "z".repeat(1_000_000) + "*/\nconst a = 1;\n");

  // Not representable as ordinary text: raw bytes.
  cases.push({ name: "bom.ts", bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...t("const a = 1;\n")]) });
  cases.push({ name: "nul.ts", bytes: new Uint8Array([...t("const a = 1;"), 0x00, ...t("const b = 2;\n")]) });
  cases.push({ name: "nul-in-string.ts", bytes: new Uint8Array([...t('const s = "a'), 0x00, ...t('b";\n')]) });
  // CESU-8 for U+D800: a LONE SURROGATE that no valid UTF-8 file can contain. What each
  // side's `readFileSync(p, "utf8")` does with it is a HOST question, which is why the
  // drivers print a source digest before they print anything else.
  cases.push({ name: "lone-surrogate.ts", bytes: new Uint8Array([...t("const s = \""), 0xed, 0xa0, 0x80, ...t("\";\n")]) });
  cases.push({ name: "invalid-utf8.ts", bytes: new Uint8Array([...t("const a = 1; // "), 0xff, 0xfe, ...t("\n")]) });

  return cases;
}

/* ============================================================
 * The drivers
 * ============================================================ */

/**
 * A source digest printed FIRST by every file-driven driver, so a divergence in
 * `readFileSync`'s UTF-8 decoding is distinguishable from a divergence in the module.
 * Without it, a host-level decode difference reads as a lexer bug.
 */
const DIGEST = [
  `let __sum = 0;`,
  `for (let __i = 0; __i < source.length; __i++) { __sum = (__sum * 31 + source.charCodeAt(__i)) % 1000000007; }`,
  `console.log("src " + source.length + " " + __sum);`,
];

function lexDriver(spec: string): string {
  return [
    `import { readFileSync } from "node:fs";`,
    `import { lex } from ${JSON.stringify(spec)};`,
    ``,
    // NO try/catch: see the header. A `try` anywhere in the program turns lexer.ts's
    // throws into NT1004 and this driver stops compiling.
    `for (const path of process.argv.slice(2)) {`,
    `  console.log("## " + path);`,
    `  const source = readFileSync(path, "utf8");`,
    ...DIGEST.map((l) => "  " + l),
    `  const toks = lex(source);`,
    `  console.log("tokens " + toks.length);`,
    `  for (const t of toks) {`,
    `    console.log(t.line + ":" + t.col + " " + t.type + " [" + t.value.length + "] " + t.value);`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}

function cpDriver(spec: string): string {
  return [
    `import { readFileSync } from "node:fs";`,
    `import { preprocessForCoverage } from ${JSON.stringify(spec)};`,
    ``,
    `for (const path of process.argv.slice(2)) {`,
    `  console.log("## " + path);`,
    `  const source = readFileSync(path, "utf8");`,
    ...DIGEST.map((l) => "  " + l),
    `  const pre = preprocessForCoverage(source);`,
    `  console.log("statements " + pre.statements.length + " stripped " + pre.stripped.length + " erased " + pre.erasedNames.length);`,
    `  let total = 0;`,
    `  for (const st of pre.statements) {`,
    `    console.log(st.line + " | [" + st.text.length + "] " + st.text);`,
    `    total = total + st.text.length;`,
    `  }`,
    `  for (const b of pre.stripped) {`,
    `    console.log("B " + b.code + " " + b.feature + " " + b.milestone + " " + b.count + " " + b.hint);`,
    `  }`,
    `  console.log("erased: " + pre.erasedNames.join(","));`,
    `  console.log("total " + total);`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * `diagnostics.ts` renders, it does not transform source, so its corpus is a set of
 * DIAGNOSTIC SHAPES rather than files. Each case is unrolled into its own statement in
 * the generated driver — an array of `Diagnostic` with heterogeneous optional fields is
 * not a shape nativets has, and the point here is to exercise the FORMATTER, not to find
 * a new checker gap.
 *
 * The shapes target `formatDiagnostic`'s arithmetic, which is where a codegen bug would
 * show: `Math.max(...spans.map(...))` (spread of a computed array into a variadic),
 * `String(n).padStart`, `" ".repeat(n)` with n possibly 0, `.repeat(Math.max(1, ...))`,
 * a comparator returning `Number(!!b.primary) - Number(!!a.primary) || a.line - b.line`,
 * `text.slice(leadingWhitespace(text))` over every code point in ECMAScript's WhiteSpace
 * table, and `srcLines[s.line - 1] ?? ""` at and past the end of the array.
 */
export function diagCases(): { label: string; code: string }[] {
  const cases: { label: string; code: string }[] = [];
  const src10 = "const a = 1;\nconst b = 2;\nconsole.log(x);\n  indented();\n\ttabbed();\n\nlast();\n";
  const q = (s: string) => JSON.stringify(s);

  const fmt = (label: string, diag: string, source?: string) =>
    cases.push({ label, code: `console.log(formatDiagnostic(${diag}${source === undefined ? "" : `, ${source}`}));` });

  // --- no source, no spans: the compact form ---
  fmt("bare", `{ code: "NT0001", message: "plain" }`);
  fmt("bare+hint", `{ code: "NT0001", message: "plain", hint: "do this" }`);
  fmt("empty-hint", `{ code: "NT0001", message: "plain", hint: "" }`);
  fmt("empty-message", `{ code: "NT0001", message: "" }`);
  fmt("empty-code", `{ code: "", message: "m" }`);
  fmt("unicode", `{ code: "NT0001", message: "\u00e9\u4e2d\u6587 \ud83d\ude00 caf\u00e9", hint: "\u00fcber" }`);
  fmt("newline-in-message", `{ code: "NT0001", message: ${q("two\nlines")} }`);
  fmt("long-message", `{ code: "NT0001", message: ${q("x".repeat(5000))} }`);
  fmt("long-hint", `{ code: "NT0001", message: "m", hint: ${q("h".repeat(5000))} }`);

  // --- spans but no source: must fall back ---
  fmt("spans-no-source", `{ code: "NT1", message: "m", spans: [{ line: 3, label: "here", primary: true }] }`);
  // --- source but no spans ---
  fmt("source-no-spans", `{ code: "NT1", message: "m" }`, q(src10));
  fmt("empty-spans", `{ code: "NT1", message: "m", spans: [] }`, q(src10));

  // --- the rustc form ---
  fmt("one-primary", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "here", primary: true }] }`, q(src10));
  fmt("one-secondary", `{ code: "NT1", message: "m", spans: [{ line: 2, label: "there" }] }`, q(src10));
  fmt("multi", `{ code: "NT1", message: "m", spans: [{ line: 2, label: "moved here" }, { line: 4, label: "used here", primary: true }, { line: 1, label: "declared here" }] }`, q(src10));
  fmt("two-primaries", `{ code: "NT1", message: "m", spans: [{ line: 4, label: "a", primary: true }, { line: 2, label: "b", primary: true }] }`, q(src10));
  fmt("with-hint", `{ code: "NT1", message: "m", hint: "help text", spans: [{ line: 3, label: "here", primary: true }] }`, q(src10));

  // --- degenerate lines ---
  fmt("line-0", `{ code: "NT1", message: "m", spans: [{ line: 0, label: "nowhere", primary: true }] }`, q(src10));
  fmt("line-0-mixed", `{ code: "NT1", message: "m", spans: [{ line: 0, label: "nowhere" }, { line: 2, label: "here", primary: true }] }`, q(src10));
  fmt("line-negative", `{ code: "NT1", message: "m", spans: [{ line: -5, label: "neg", primary: true }] }`, q(src10));
  fmt("line-past-end", `{ code: "NT1", message: "m", spans: [{ line: 999, label: "past", primary: true }] }`, q(src10));
  fmt("line-one-past", `{ code: "NT1", message: "m", spans: [{ line: 8, label: "just past", primary: true }] }`, q(src10));
  fmt("line-fractional", `{ code: "NT1", message: "m", spans: [{ line: 2.5, label: "frac", primary: true }] }`, q(src10));
  fmt("line-huge", `{ code: "NT1", message: "m", spans: [{ line: 1000000, label: "huge", primary: true }] }`, q(src10));

  // --- gutter widths (String(line).length drives the padding) ---
  const many = Array.from({ length: 120 }, (_, i) => `line ${i + 1};`).join("\n");
  fmt("gutter-1-vs-3", `{ code: "NT1", message: "m", spans: [{ line: 9, label: "a", primary: true }, { line: 100, label: "b" }] }`, q(many));
  fmt("gutter-3", `{ code: "NT1", message: "m", spans: [{ line: 100, label: "a", primary: true }] }`, q(many));

  // --- the caret, and leadingWhitespace ---
  fmt("blank-line", `{ code: "NT1", message: "m", spans: [{ line: 6, label: "blank", primary: true }] }`, q(src10));
  fmt("indented-space", `{ code: "NT1", message: "m", spans: [{ line: 4, label: "sp", primary: true }] }`, q(src10));
  fmt("indented-tab", `{ code: "NT1", message: "m", spans: [{ line: 5, label: "tab", primary: true }] }`, q(src10));
  fmt("all-whitespace-line", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "ws", primary: true }] }`, q("   \t   \nx\n"));
  // Every non-ASCII code point in ECMAScript's WhiteSpace + LineTerminator table, which is
  // exactly what `leadingWhitespace` open-codes. A wrong `charCodeAt` on a non-BMP-adjacent
  // code unit, or an off-by-one in the range test, moves the caret.
  const ws = "\u00a0\u1680\u2000\u2001\u2009\u200a\u202f\u205f\u3000\ufeff";
  fmt("unicode-whitespace", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "ws", primary: true }] }`, q(ws + "x();\n"));
  fmt("near-miss-whitespace", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "ws", primary: true }] }`, q("\u1fff\u200b\u2060x();\n"));
  fmt("unicode-line", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "\ud83d\ude00", primary: true }] }`, q("const \u4e2d = \ud83d\ude00;\n"));
  fmt("empty-label", `{ code: "NT1", message: "m", spans: [{ line: 2, label: "" }] }`, q(src10));
  fmt("long-line", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "long", primary: true }] }`, q("x".repeat(3000) + "\ny\n"));
  fmt("crlf-source", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "cr", primary: true }] }`, q("const a = 1;\r\nconst b = 2;\r\n"));
  fmt("empty-source", `{ code: "NT1", message: "m", spans: [{ line: 1, label: "x", primary: true }] }`, q(""));
  fmt("source-no-trailing-nl", `{ code: "NT1", message: "m", spans: [{ line: 2, label: "x", primary: true }] }`, q("a\nb"));
  fmt("many-spans", `{ code: "NT1", message: "m", spans: [${Array.from({ length: 50 }, (_, i) => `{ line: ${i + 1}, label: "s${i}", primary: ${i % 3 === 0} }`).join(", ")}] }`, q(many));

  return cases;
}

/**
 * The CONSTRUCTORS — every exported factory, each of which builds a `Diagnostic` and an
 * `NTError` around it. This is the consuming-parameter path (the module's last SH6
 * blocker) run sixteen more times, with and without the optional arguments.
 */
function constructorCases(): { label: string; code: string }[] {
  const c = (label: string, code: string) => ({ label, code });
  return [
    c("nyi", `const c1 = nyi(NYI.CLASS_FEATURE, "generic classes");\nconsole.log(c1.message + " | " + c1.name + " | " + c1.diag.code + " | " + (c1.diag.hint ?? "-") + " | " + (c1.diag.milestone ?? "-"));`),
    c("nyi-at", `const c2 = nyi(NYI.CLASS_FEATURE, "x", "custom hint", { line: 7, col: 3 });\nconsole.log(formatDiagnostic(c2.diag));`),
    c("parseError", `const c3 = parseError("Expected ';'");\nconsole.log(c3.message + " | " + c3.diag.code);`),
    c("parseError-hint", `const c4 = parseError("Expected ';'", "add one");\nconsole.log(formatDiagnostic(c4.diag));`),
    c("typeError", `const c5 = typeError("bad type");\nconsole.log(formatDiagnostic(c5.diag));`),
    c("typeError-full", `const c6 = typeError("bad type", { line: 3, col: 5 }, "hint", "over here");\nconsole.log(formatDiagnostic(c6.diag, "a();\\nb();\\n  c();\\n"));`),
    c("boundsError", `const c7 = boundsError("out of range", "check length");\nconsole.log(formatDiagnostic(c7.diag));`),
    c("mutationError", `const c8 = mutationError("cannot mutate", "clone it", { line: 2, col: 1 });\nconsole.log(formatDiagnostic(c8.diag, "x;\\ny;\\n"));`),
    c("useBeforeAssign", `const c9 = useBeforeAssign("used before assigned", { line: 1, col: 1 }, "assign first");\nconsole.log(formatDiagnostic(c9.diag, "let a;\\n"));`),
    c("moduleError", `const c10 = moduleError("NT1702", "cycle", "break it");\nconsole.log(formatDiagnostic(c10.diag));`),
    c("unknownTypeName", `const c11 = unknownTypeName("Foo", { line: 1, col: 9 });\nconsole.log(formatDiagnostic(c11.diag));`),
    c("emptyArrayError", `const c12 = emptyArrayError();\nconsole.log(formatDiagnostic(c12.diag));`),
    c("decoratorError", `const c13 = decoratorError("bad decorator", "spell it @@mutable");\nconsole.log(formatDiagnostic(c13.diag));`),
    c("unlinkedImportError", `const c14 = unlinkedImportError("x", "./y.ts");\nconsole.log(formatDiagnostic(c14.diag));`),
    c("nulLiteral", `const c15 = nulLiteral("a string literal", 4, 9);\nconsole.log(formatDiagnostic(c15.diag));`),
    c("internalError", `const c16 = internalError("codegen fell over");\nconsole.log(c16.name + " / " + c16.message.length);`),
  ];
}

/**
 * The driver is CASE-SELECTABLE (`argv[2]` = case index, empty = all). That is not a
 * convenience: a panic ABORTS, so one bad case in a single-shot driver hides every case
 * after it, and the first run of this harness did exactly that — everything past
 * `line-past-end` was unmeasured. Running all-at-once first is the fast path; the sweep
 * falls back to one process per case the moment they disagree.
 */
function diagDriver(spec: string, catalogKeys: string[]): string {
  const cases = allDiagCases(catalogKeys);
  return [
    `import { formatDiagnostic, nyi, parseError, typeError, boundsError, mutationError, useBeforeAssign, moduleError, unknownTypeName, emptyArrayError, decoratorError, unlinkedImportError, nulLiteral, internalError, NYI } from ${JSON.stringify(spec)};`,
    ``,
    `const sel = process.argv[2] ?? "";`,
    ``,
    ...cases.map((c, i) => [
      `if (sel === "" || sel === "${i}") {`,
      `  console.log("## ${i} ${c.label}");`,
      ...c.code.split("\n").map((l) => "  " + l),
      `}`,
    ].join("\n")),
    ``,
  ].join("\n");
}

/** Every entry in the NYI catalog, rendered. It is a `as const` object of 60+ entries and
 *  the module's largest single data structure. */
function catalogCases(keys: string[]): { label: string; code: string }[] {
  return keys.map((k) => ({ label: `catalog-${k}`, code: `console.log(formatDiagnostic(nyi(NYI.${k}, "<what>").diag));` }));
}

export function allDiagCases(catalogKeys: string[]): { label: string; code: string }[] {
  return [...diagCases(), ...constructorCases(), ...catalogCases(catalogKeys)];
}

/* ============================================================
 * Running one differential
 * ============================================================ */

export interface RunResult { stdout: string; status: number }

/**
 * THE ONE DIVERGENCE THAT IS NOT A BUG, and it has to be subtracted or it swamps
 * everything else: a nativets string is UTF-8 BYTES and a JS string is UTF-16 code units,
 * so `"—".length` is 3 here and 1 under bun (docs/stdlib.md). Every file in this
 * repo that contains an em dash — which is most of `src/` — therefore disagrees on every
 * LENGTH and every COLUMN, without a single token boundary being wrong.
 *
 * So an input containing any byte >= 0x80 is compared on the facts that do NOT depend on
 * the string model: the token/statement SEQUENCE, its TEXT, and its LINE numbers. Columns,
 * `.length`s and the source digest are dropped. An ASCII-only input is compared byte for
 * byte with nothing dropped, and that is most of `test/`.
 */
export function normalize(s: string): string {
  return s
    .split("\n")
    .filter((l) => !l.startsWith("src ") && !l.startsWith("total "))
    .map((l) => l.replace(/^(\d+):\d+ /, "$1: ").replace(/\[\d+\] /, ""))
    .join("\n");
}

export function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return false;
  return true;
}

function runNative(bin: string, args: string[]): RunResult & { stderr: string } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 300_000, killSignal: "SIGKILL", maxBuffer: 512 * 1024 * 1024 });
  return { stdout: r.stdout ?? "", status: r.status ?? -1, stderr: r.stderr ?? "" };
}

function runBun(driver: string, args: string[]): RunResult {
  const r = spawnSync("bun", ["run", driver, ...args], { encoding: "utf8", timeout: 300_000, maxBuffer: 512 * 1024 * 1024 });
  return { stdout: r.stdout ?? "", status: r.status ?? -1 };
}

/** First differing byte offset, or -1. */
export function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export interface Divergence {
  module: string;
  input: string;
  kind: "stdout" | "exit";
  /** Grouping key: several hundred inputs can share one root cause. */
  cause: string;
  detail: string;
  minimized?: string;
}

/**
 * The root cause, read off the native side's stderr-free evidence. A panic aborts, so its
 * signature is a truncated stdout plus exit 134 — and the panic LOCATION is the only thing
 * that distinguishes one out-of-range index from another, so it is read from stderr HERE
 * (as a label only; stderr is still not part of the comparison).
 */
function causeOf(nativeStderr: string, kind: string): string {
  const m = /panic: ([^\n]*)\n\s*at ([^\n]*)/.exec(nativeStderr);
  if (m) return `panic @ ${m[2]}`;
  return kind;
}

/**
 * Delta-debug an input down to a still-diverging core: lines first, then characters.
 * Deliberately simple (halving passes, not full ddmin) — a lexer input that diverges is
 * usually one token, and the point is a repro small enough to paste into a bug report.
 */
export function minimize(
  input: string,
  diverges: (candidate: string) => boolean,
): string {
  let best = input;
  // Pass 1: lines.
  let lines = best.split("\n");
  let chunk = Math.max(1, Math.floor(lines.length / 2));
  while (chunk >= 1 && lines.length > 1) {
    let removed = false;
    for (let i = 0; i + chunk <= lines.length; ) {
      const candidate = [...lines.slice(0, i), ...lines.slice(i + chunk)].join("\n");
      if (candidate !== best && diverges(candidate)) {
        best = candidate;
        lines = best.split("\n");
        removed = true;
      } else {
        i += chunk;
      }
    }
    if (!removed) chunk = Math.floor(chunk / 2);
    if (chunk === 0) break;
  }
  // Pass 2: characters, from both ends and then interior halves.
  let changed = true;
  while (changed && best.length > 1) {
    changed = false;
    let step = Math.max(1, Math.floor(best.length / 2));
    while (step >= 1) {
      for (let i = 0; i + step <= best.length; ) {
        const candidate = best.slice(0, i) + best.slice(i + step);
        if (diverges(candidate)) {
          best = candidate;
          changed = true;
        } else {
          i += step;
        }
      }
      step = Math.floor(step / 2);
    }
  }
  return best;
}

/* ============================================================
 * The sweep
 * ============================================================ */

export interface FuzzOptions {
  /** `all` (default) = every `.ts` under src/test/examples; `sample` = every 20th;
   *  `none` = the adversarial set only, which is what the pinned test uses. */
  corpus?: "all" | "sample" | "none";
  quick?: boolean;
  /**
   * Skip the megabyte-scale adversarial inputs. DEFAULTS TO TRUE, and that default is a
   * finding rather than a convenience: `lex` accumulates a token with `s += source[st.i]`
   * one character at a time, which JavaScriptCore makes linear with ropes and the nativets
   * runtime makes QUADRATIC by copying. Measured on a single identifier: 16k chars 55 ms,
   * 32k chars 194 ms (4x per doubling, against a flat 22 ms under bun), and the 1 MB case
   * reached 20 GB RSS and 54 s of CPU before it was killed. Not a correctness divergence,
   * so it is not in the recorded table — but a `--huge` run will hang a laptop, so opting
   * in is deliberate.
   */
  skipHuge?: boolean;
  log?: (s: string) => void;
}

export interface FuzzReport {
  divergences: Divergence[];
  counts: Record<string, number>;
  /**
   * `module | input` for every input where BOTH sides FAILED and AGREED — same stdout,
   * same non-zero exit code. This is the positive half of the error-path question, and it
   * has to be collected rather than inferred: "no divergence" also covers "neither side
   * did anything", which would be evidence of nothing.
   */
  errorPathAgreements: string[];
}

export async function fuzz(opts: FuzzOptions = {}): Promise<FuzzReport> {
  const log = opts.log ?? (() => {});
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nativets-sh6-fuzz-")));
  const divergences: Divergence[] = [];
  const errorPathAgreements: string[] = [];
  const counts: Record<string, number> = {};

  try {
    const inputsDir = join(dir, "inputs");
    mkdirSync(inputsDir);

    // --- corpus on disk ---
    const mode = opts.corpus ?? (opts.quick ? "sample" : "all");
    let files = mode === "none" ? [] : fileCorpus();
    if (mode === "sample") files = files.filter((_, i) => i % 20 === 0);
    let adversarial = adversarialCorpus();
    if (opts.skipHuge !== false) adversarial = adversarial.filter((c) => c.bytes.length < 200_000);
    for (const c of adversarial) writeFileSync(join(inputsDir, c.name), c.bytes);
    const advFiles = adversarial.map((c) => join(inputsDir, c.name));
    const allInputs = [...advFiles, ...files];

    // --- the two file-driven modules ---
    for (const [module, mkDriver] of [
      ["lexer.ts", lexDriver],
      ["coverage-preprocess.ts", cpDriver],
    ] as [string, (spec: string) => string][]) {
      const driver = join(dir, `drive-${module.replace(/\W/g, "_")}.ts`);
      const spec = relative(dir, realpathSync(srcPath(module)));
      writeFileSync(driver, mkDriver(spec));
      const bin = join(dir, `bin-${module.replace(/\W/g, "_")}`);
      log(`building ${module} driver...`);
      await buildBinary(readFileSync(driver, "utf8"), bin, { target: "host", entryPath: driver });

      let n = 0;
      let utf8Only = 0;
      const seenCause = new Set<string>();
      for (const input of allInputs) {
        n++;
        const bytes = new Uint8Array(readFileSync(input));
        const ours = runNative(bin, [input]);
        const oracle = runBun(driver, [input]);
        // The UTF-8-vs-UTF-16 subtraction is keyed on whether NON-ASCII TEXT IS INVOLVED
        // AT ALL, not just on the input: `"\u{10FFFF}"` is an ASCII source whose token
        // VALUE is astral, and its length disagrees for exactly the documented reason.
        const ascii = isAscii(bytes) && isAscii(new TextEncoder().encode(ours.stdout)) && isAscii(new TextEncoder().encode(oracle.stdout));
        const rel = relative(ROOT, input);
        const same = ascii
          ? ours.stdout === oracle.stdout
          : normalize(ours.stdout) === normalize(oracle.stdout);
        if (same && ours.status === oracle.status) {
          if (!ascii && ours.stdout !== oracle.stdout) utf8Only++;
          if (ours.status !== 0) errorPathAgreements.push(`${module} | ${basename(input)}`);
          continue;
        }
        const kind: "stdout" | "exit" = same ? "exit" : "stdout";
        const at = firstDiff(ours.stdout, oracle.stdout);
        const cause = causeOf(ours.stderr, kind);
        log(`DIVERGENCE ${module} ${rel}: ${kind} (${cause})`);
        // MINIMIZE — but only once per root cause. 71 files share one bare `//`, and
        // delta-debugging each of them re-derives the same two bytes at real cost.
        let minimized: string | undefined;
        if (!seenCause.has(cause) && bytes.length < 200_000) {
          seenCause.add(cause);
          const raw = readFileSync(input, "utf8");
          const probe = join(dir, "probe.ts");
          const diverges = (candidate: string) => {
            writeFileSync(probe, candidate);
            const a = runNative(bin, [probe]);
            const b = runBun(driver, [probe]);
            if (a.status !== b.status) return causeOf(a.stderr, "exit") === cause;
            const aa = isAscii(new TextEncoder().encode(candidate));
            const eq = aa ? a.stdout === b.stdout : normalize(a.stdout) === normalize(b.stdout);
            return !eq;
          };
          minimized = diverges(raw) ? minimize(raw, diverges) : "(not reproducible from the decoded text — the raw bytes are the repro)";
        }
        divergences.push({
          module, input: rel, kind, cause,
          detail: kind === "exit"
            ? `exit ${ours.status} vs ${oracle.status}`
            : `first differing byte ${at}; exit ${ours.status} vs ${oracle.status}; ours ${JSON.stringify(ours.stdout.slice(Math.max(0, at - 60), at + 60))} vs bun ${JSON.stringify(oracle.stdout.slice(Math.max(0, at - 60), at + 60))}`,
          minimized,
        });
      }
      counts[module] = n;
      log(`${module}: ${n} inputs compared (${utf8Only} matched only after subtracting the documented UTF-8-length divergence)`);
    }

    // --- diagnostics.ts: shapes, not files ---
    {
      const module = "diagnostics.ts";
      const catalogKeys = Object.keys(
        (await import(srcPath("diagnostics.ts"))).NYI as Record<string, unknown>,
      ).sort();
      const cases = allDiagCases(catalogKeys);
      const driver = join(dir, "drive-diagnostics.ts");
      const spec = relative(dir, realpathSync(srcPath(module)));
      writeFileSync(driver, diagDriver(spec, catalogKeys));
      const bin = join(dir, "bin-diagnostics");
      log(`building ${module} driver...`);
      await buildBinary(readFileSync(driver, "utf8"), bin, { target: "host", entryPath: driver });
      counts[module] = cases.length;

      const all = runNative(bin, []);
      const allOracle = runBun(driver, []);
      if (all.stdout === allOracle.stdout && all.status === allOracle.status) {
        log(`${module}: ${cases.length} shapes compared, all in one process`);
      } else {
        // They disagree — enumerate, one process per case, so an aborting case does not
        // hide the ones behind it.
        log(`${module}: single-shot run disagrees; enumerating ${cases.length} cases`);
        for (let i = 0; i < cases.length; i++) {
          const ours = runNative(bin, [String(i)]);
          const oracle = runBun(driver, [String(i)]);
          // A non-ASCII CASE (unicode messages, the whitespace table) is subject to the
          // same documented UTF-8-length divergence as a non-ASCII file, and it shows up
          // as a shifted caret rather than a wrong one.
          const ascii = isAscii(new TextEncoder().encode(cases[i]!.code))
            && isAscii(new TextEncoder().encode(ours.stdout))
            && isAscii(new TextEncoder().encode(oracle.stdout));
          const same = ascii ? ours.stdout === oracle.stdout : normalize(ours.stdout) === normalize(oracle.stdout);
          if (same && ours.status === oracle.status) continue;
          const at = firstDiff(ours.stdout, oracle.stdout);
          const cause = causeOf(ours.stderr, same ? "exit" : "stdout");
          log(`DIVERGENCE ${module} case ${i} ${cases[i]!.label}: ${cause}`);
          divergences.push({
            module, input: `case ${i} ${cases[i]!.label}`, kind: same ? "exit" : "stdout", cause,
            detail: `exit ${ours.status} vs ${oracle.status}; ours ${JSON.stringify(ours.stdout.slice(Math.max(0, at - 40), at + 120))} vs bun ${JSON.stringify(oracle.stdout.slice(Math.max(0, at - 40), at + 120))}`,
            minimized: cases[i]!.code,
          });
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return { divergences, counts, errorPathAgreements };
}

if (import.meta.main) {
  const quick = process.argv.includes("--quick");
  // `--huge` opts IN to the megabyte inputs; see `skipHuge` for why that is not the default.
  const skipHuge = !process.argv.includes("--huge");
  const report = await fuzz({ quick, skipHuge, log: (s) => console.log(s) });
  console.log("\n=== SH6 FUZZ REPORT ===");
  for (const [m, n] of Object.entries(report.counts)) console.log(`${m}: ${n} inputs`);
  if (report.divergences.length === 0) {
    console.log("no divergences");
  } else {
    for (const d of report.divergences) {
      console.log(`\n--- ${d.module} / ${d.input} (${d.kind})`);
      console.log(d.detail);
      if (d.minimized !== undefined) console.log(`minimized (${d.minimized.length} bytes):\n${JSON.stringify(d.minimized)}`);
    }
    process.exit(1);
  }
}
