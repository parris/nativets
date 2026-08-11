/*
 * Out-of-bounds index is a controlled PANIC.
 *
 * Every indexed accessor in the runtime is bounds-checked (nativets is memory-safe:
 * no UB, no OOB memory access) — but the POLICY on a failed check used to be "return a
 * benign value": `nt_arr_get` gave 0, `js_str_char_at` gave "", a Uint8Array write was a
 * silent no-op. That matched NEITHER node (`undefined`) NOR a trap, so the program kept
 * computing on a value that was never there — a silent wrong answer.
 *
 * The policy is now rustc's: abort immediately with
 *
 *     panic: index out of bounds: the length is 3 but the index is 5
 *       at <file>:<line>:<col>
 *       help: use `.at(i)` ...
 *
 * on STDERR (stdout stays byte-comparable), via abort() → SIGABRT → shell exit 134,
 * consistent with the existing OOM path. A panic is NOT an exception: it does not route
 * through the pending-exception protocol and `try`/`catch` cannot stop it.
 *
 * A deliberate, documented divergence from node — see docs/divergences.md.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary, sourceToIR } from "../src/driver.ts";
import { runWithNode } from "./harness.ts";

/**
 * Compile + run, reporting the exit code AS A SHELL SEES IT — a signal death (abort)
 * is 128+signo, so the panic's 134 is observable. `spawnSync` alone reports
 * `status: null` for a signalled process, which is what the plain harness does.
 */
async function run(source: string, file = "case.ts"): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "nativets-panic-"));
  try {
    const entry = join(dir, file);
    writeFileSync(entry, source);
    const bin = join(dir, "prog");
    await buildBinary(source, bin, { target: "host", entryPath: entry });
    const proc = spawnSync("/bin/sh", ["-c", `"${bin}"; echo "__exit:$?"`], { encoding: "utf8" });
    const out = proc.stdout ?? "";
    const m = out.match(/__exit:(\d+)\n?$/);
    return {
      stdout: out.replace(/__exit:\d+\n?$/, ""),
      stderr: proc.stderr ?? "",
      exitCode: m ? Number(m[1]) : -1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The compile-time half: what diagnostic (if any) does this source produce? */
function compileError(source: string): { code: string; message: string; hint: string } | null {
  try {
    sourceToIR(source);
    return null;
  } catch (e: any) {
    return e.diag
      ? { code: e.diag.code, message: e.diag.message, hint: (e.diag.hint ?? "").replace(/\s+/g, " ") }
      : { code: "?", message: String(e), hint: "" };
  }
}

const PANIC = /^panic: index out of bounds: the length is (\S+) but the index is (\S+)$/m;

describe("array index", () => {
  test("reading past the end panics instead of yielding 0", async () => {
    const r = await run(`const a: number[] = [1, 2, 3];
let i = 5;
console.log(a[i]);
`);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("panic: index out of bounds: the length is 3 but the index is 5");
    expect(r.exitCode).toBe(134);
  });

  test("the panic names the source location of the index that faulted", async () => {
    const r = await run(`const a: number[] = [1, 2, 3];
let i = 9;
console.log(a[i]);
`);
    // `case.ts:3:14` — the `[` of `a[i]` on line 3 (1-based col of the bracket).
    expect(r.stderr).toMatch(/\n {2}at .*case\.ts:3:14\n/);
  });

  test("the panic points at `.at(i)` as the node-exact escape hatch", async () => {
    const r = await run(`const a: number[] = [1, 2, 3];
let i = 5;
console.log(a[i]);
`);
    expect(r.stderr).toContain("use `.at(5)` to get `undefined` instead of panicking");
  });

  test("a negative index panics too (node: undefined; we used to give 0)", async () => {
    const r = await run(`const a: number[] = [1, 2, 3];
let i = -1;
console.log(a[i]);
`);
    expect(r.stderr).toMatch(PANIC);
    expect(r.stderr).toContain("the length is 3 but the index is -1");
    expect(r.exitCode).toBe(134);
  });

  test("stdout printed BEFORE the fault is flushed and intact", async () => {
    const r = await run(`const a: number[] = [10, 20];
console.log("before");
console.log(a[0]);
let i = 7;
console.log(a[i]);
console.log("after");
`);
    expect(r.stdout).toBe("before\n10\n");
    expect(r.exitCode).toBe(134);
  });

  test("in-bounds indexing is untouched and still matches node", async () => {
    const src = `const a: number[] = [1, 2, 3];
for (let i = 0; i < a.length; i++) console.log(a[i]);
console.log(a[a.length - 1]);
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });
});

describe("string index", () => {
  test("`s[i]` past the end panics instead of yielding the empty string", async () => {
    const r = await run(`const s = "abc";
let i = 7;
console.log(s[i]);
`);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("panic: index out of bounds: the length is 3 but the index is 7");
    expect(r.exitCode).toBe(134);
  });

  test("a negative string index panics", async () => {
    const r = await run(`const s = "abc";
let i = -1;
console.log(s[i]);
`);
    expect(r.stderr).toContain("the length is 3 but the index is -1");
    expect(r.exitCode).toBe(134);
  });

  test("`.charAt(i)` is node-DEFINED as \"\" out of range, so it does NOT panic", async () => {
    const src = `const s = "abc";
let i = 7;
console.log("[" + s.charAt(i) + "]");
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
    expect(r.stdout).toBe("[]\n");
  });
});

describe("compile-time rejection (NT2002) — better than a runtime panic", () => {
  test("a literal index past a const array's known length does not compile", () => {
    const d = compileError(`const a: number[] = [1, 2, 3];
console.log(a[5]);
`);
    expect(d?.code).toBe("NT2002");
    expect(d?.message).toBe("index 5 is out of bounds for an array of length 3");
  });

  test("a negative literal index does not compile", () => {
    expect(compileError(`const a: number[] = [1, 2, 3];
console.log(a[-1]);
`)?.code).toBe("NT2002");
  });

  test("indexing a literal array directly is caught too", () => {
    expect(compileError(`console.log([1, 2][7]);\n`)?.code).toBe("NT2002");
  });

  test("a string literal's length is known (UTF-8 bytes, our index space)", () => {
    const d = compileError(`console.log("abc"[7]);\n`);
    expect(d?.code).toBe("NT2002");
    expect(d?.message).toContain("a string of length 3");
  });

  /*
   * The compile-time length of a NON-ASCII literal must be the same number the RUNTIME
   * reports, or NT2002 rejects in-bounds code / admits out-of-bounds code — a silent
   * wrong answer on the bounds themselves.
   *
   * It used to be `Buffer.byteLength(v, "utf8")`, which cannot appear in `src/` (`Buffer`
   * is a node global with no representation here — NT2001, and it was the FIRST blocker
   * for checker/codegen/ownership). It is now `utf8ByteLength` in the checker; these cases
   * pin the two together. Each expectation was taken from `Buffer.byteLength` itself.
   *
   * Note a well-formed surrogate PAIR is ONE code point and FOUR bytes, not 3+3: a string
   * literal's bytes come from codegen's `encodeCString`, which is `TextEncoder` — plain
   * UTF-8. (The runtime's `String.fromCharCode` concat path really does produce CESU-8, 6
   * bytes, but it builds a string at RUN time and never reaches the literal path.)
   * A LONE surrogate is not representable in UTF-8; TextEncoder and Buffer.byteLength both
   * substitute U+FFFD, so it measures 3.
   */
  test("a NON-ASCII literal's length is its UTF-8 byte count, matching the runtime", () => {
    const BS = String.fromCharCode(92); // a backslash, without writing one in a template
    const cases: { lit: string; bytes: number; what: string }[] = [
      { lit: '"é"', bytes: 2, what: "Latin-1 (U+00E9)" },
      { lit: '"€"', bytes: 3, what: "BMP (U+20AC)" },
      { lit: '"\u{1f600}"', bytes: 4, what: "astral, raw in source" },
      { lit: `"${BS}u{1F600}"`, bytes: 4, what: "astral via ${BS}u{...}" },
      { lit: `"${BS}uD83D${BS}uDE00"`, bytes: 4, what: "astral via a SURROGATE PAIR — 4, not 3+3" },
      { lit: `"${BS}uD800"`, bytes: 3, what: "a LONE high surrogate — U+FFFD, 3 bytes" },
      { lit: `"${BS}uDC00"`, bytes: 3, what: "a LONE low surrogate — U+FFFD, 3 bytes" },
      { lit: '"aéb"', bytes: 4, what: "mixed ASCII + Latin-1" },
    ];
    for (const { lit, bytes, what } of cases) {
      // one PAST the end is refused, and the message states the byte length
      const d = compileError(`console.log(${lit}[${bytes}]);\n`);
      expect(`${what}: ${d?.code}`).toBe(`${what}: NT2002`);
      expect(`${what}: ${d?.message}`).toBe(`${what}: index ${bytes} is out of bounds for a string of length ${bytes}`);
      // …and the LAST byte is still in bounds, so the boundary sits exactly on the count
      expect(`${what}: ${compileError(`console.log(${lit}[${bytes - 1}]);\n`)}`).toBe(`${what}: null`);
    }
  });

  test("the empty literal has length 0, so even index 0 is out of bounds", () => {
    const d = compileError(`console.log(""[0]);\n`);
    expect(d?.code).toBe("NT2002");
    expect(d?.message).toBe("index 0 is out of bounds for a string of length 0");
  });

  test("an empty const array says so", () => {
    const d = compileError(`const a: number[] = [];
console.log(a[0]);
`);
    expect(d?.code).toBe("NT2002");
  });

  test("in-bounds literal indices still compile", () => {
    expect(compileError(`const a: number[] = [1, 2, 3];
console.log(a[0], a[2], "abc"[1]);
`)).toBe(null);
  });

  /*
   * The NT2002 hint has to survive being FOLLOWED. It used to end, for every index,
   * with "use `.at(N)` if you want `undefined` instead of a panic" — true past the end,
   * a different VALUE for a negative or fractional one (see the runtime section below).
   */
  describe("its hint is true for the index that was written", () => {
    test("past the end: `.at(N)` really is `undefined`", () => {
      const d = compileError(`const a: number[] = [1, 2, 3];\nconsole.log(a[5]);\n`);
      expect(d?.hint).toBe("valid indices are 0..2; use `.at(5)` if you want `undefined` instead of a panic");
    });

    test("negative: `.at(-1)` is the LAST element, not `undefined`", () => {
      const d = compileError(`const a: number[] = [1, 2, 3];\nconsole.log(a[-1]);\n`);
      expect(d?.hint).not.toContain("if you want `undefined`");
      expect(d?.hint).toContain("node reads `undefined` for a negative index");
      expect(d?.hint).toContain("`.at(-1)` is NOT that: it counts from the END");
    });

    test("fractional: `.at(1.5)` truncates, so it is not `undefined` either", () => {
      const d = compileError(`const a: number[] = [1, 2, 3];\nconsole.log(a[1.5]);\n`);
      expect(d?.hint).not.toContain("if you want `undefined`");
      expect(d?.hint).toContain("truncates towards zero");
    });

    test("an EMPTY container has no `.at` that returns anything", () => {
      const d = compileError(`const a: number[] = [];\nconsole.log(a[0]);\n`);
      // The empty case gets its OWN sentence rather than the general range plus a
      // parenthetical: the general branch renders "valid indices are 0..-1", which is not
      // a range and reads as a second, invented error.
      expect(d?.hint).toContain("no valid indices at all");
      expect(d?.hint).not.toContain("0..-1");
      expect(d?.hint).toContain("`.at(0)`");
    });
  });

  test("a non-const or non-literal length is left to the runtime panic", () => {
    // `let` may be reassigned and a computed index is unknown — no compile-time claim.
    expect(compileError(`let a: number[] = [1, 2, 3];
console.log(a[9]);
`)).toBe(null);
    expect(compileError(`function f(xs: number[]): number { return xs[99]; }
console.log(f([1]));
`)).toBe(null);
  });
});

describe("a panic is NOT an exception", () => {
  test("`try { a[oob] } catch {}` still aborts — catch cannot swallow it", async () => {
    const r = await run(`const a: number[] = [1, 2, 3];
let i = 5;
try {
  console.log(a[i]);
} catch (e) {
  console.log("caught");
}
console.log("after");
`);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("panic: index out of bounds");
    expect(r.exitCode).toBe(134);
  });

  test("a `finally` does NOT run on a panic (it is not an unwind)", async () => {
    // NB: a `finally` at TOP LEVEL is a PRE-EXISTING codegen defect (`ret double` out of
    // `main`), unrelated to this lane — hence the enclosing function.
    const r = await run(`function go(): void {
  const a: number[] = [1];
  let i = 3;
  try {
    console.log(a[i]);
  } finally {
    console.log("finally");
  }
}
go();
`);
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(134);
  });

  test("an ordinary throw is still catchable (the exception path is unchanged)", async () => {
    const src = `try {
  throw new Error("boom");
} catch (e) {
  console.log("caught", e.message);
}
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });
});

describe("`.at(i)` is the node-exact escape hatch (unchanged)", () => {
  test("array `.at` out of range is `undefined`, node-identically", async () => {
    const src = `const a: number[] = [1, 2, 3];
console.log(a.at(0), a.at(-1), a.at(5), a.at(-9));
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
    expect(r.stdout).toBe("1 3 undefined undefined\n");
  });

  test("string `.at` out of range is `undefined`, node-identically", async () => {
    const src = `const s = "abc";
console.log(s.at(0), s.at(-1), s.at(7));
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });

  test("`.at` guards a would-be panic — the documented fix", async () => {
    const src = `const a: number[] = [1, 2, 3];
const v = a.at(5);
console.log(v === undefined ? "absent" : "present");
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });
});

describe("`.with(i, v)` — the persistent-vector update", () => {
  test("an out-of-range update panics instead of returning an unchanged copy", async () => {
    const r = await run(`const a: number[] = [1, 2, 3];
let i = 5;
const b = a.with(i, 99);
console.log(b.join(","));
`);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("panic: index out of bounds: the length is 3 but the index is 5");
    expect(r.exitCode).toBe(134);
  });

  test("past the 32-element trie threshold too (the pvec path)", async () => {
    const r = await run(`const a: number[] = [];
let xs: number[] = a;
for (let i = 0; i < 100; i++) xs = [...xs, i];
let k = 1000;
const b = xs.with(k, 1);
console.log(b.length);
`);
    expect(r.stderr).toContain("the length is 100 but the index is 1000");
    expect(r.exitCode).toBe(134);
  });

  test("an in-range `.with` still matches node", async () => {
    const src = `const a: number[] = [1, 2, 3];
console.log(a.with(1, 9).join(","), a.join(","));
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });
});

describe("Uint8Array", () => {
  test("an out-of-range READ panics", async () => {
    const r = await run(`const u = new Uint8Array(4);
let i = 9;
console.log(u[i]);
`);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("panic: index out of bounds: the length is 4 but the index is 9");
    expect(r.exitCode).toBe(134);
  });

  test("an out-of-range WRITE panics instead of silently doing nothing", async () => {
    const r = await run(`const u = new Uint8Array(4);
let i = 4;
u[i] = 255;
console.log("survived");
`);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("panic: index out of bounds: the length is 4 but the index is 4");
    expect(r.exitCode).toBe(134);
  });

  test("a negative WRITE index panics", async () => {
    const r = await run(`const u = new Uint8Array(4);
let i = -2;
u[i] = 1;
console.log("survived");
`);
    expect(r.stderr).toContain("the length is 4 but the index is -2");
    expect(r.exitCode).toBe(134);
  });

  test("a compound write `u[i] += v` out of range panics on the read half", async () => {
    const r = await run(`const u = new Uint8Array(2);
let i = 5;
u[i] += 3;
console.log("survived");
`);
    expect(r.stderr).toContain("the length is 2 but the index is 5");
    expect(r.exitCode).toBe(134);
  });

  test("in-bounds byte reads/writes still match node", async () => {
    const src = `const u = new Uint8Array(3);
u[0] = 7;
u[1] = 300;
u[2] += 5;
console.log(u[0], u[1], u[2], u.length);
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });
});

/* ============================================================
 * A FRACTIONAL INDEX IS OUT OF BOUNDS — the runtime now agrees with the checker.
 *
 * Found by trying to write a truthful help line for one. The COMPILE-TIME half has
 * always rejected `a[1.5]` (`checkStaticBounds` requires `Number.isInteger(idx)`, so
 * `[1,2,3][1.5]` is NT2002) but the RUNTIME half truncated the double to an int64 and
 * read the neighbouring element:
 *
 *     let i = 1.5;   a[i] -> 2      node: undefined
 *                    s[i] -> "b"    node: undefined
 *                    u[i] -> u[1]   node: undefined
 *     u[i] = 7                      node: stores an ordinary property, NOT a byte
 *
 * exit 0 on both sides, no diagnostic — the same silent-wrong-answer class as reading
 * past the end used to be, and the reason the bounds panic exists at all. A non-integer
 * is not an index; it now panics like any other out-of-range one.
 *
 * `.with` is deliberately NOT changed: node's `.with` runs its index through
 * ToIntegerOrInfinity, so `[1,2,3].with(1.7, 9)` really IS `[1,9,3]` — and ours already
 * truncates to the same answer. Bracket indexing has no such coercion.
 * ============================================================ */
describe("a non-integer index is out of bounds at RUN time too, not truncated", () => {
  for (const [name, src, len] of [
    ["array", `const a: number[] = [1, 2, 3];\nlet i = 1.5;\nconsole.log(a[i]);\n`, 3],
    ["string", `const s = "abc";\nlet i = 1.5;\nconsole.log(s[i]);\n`, 3],
    ["Uint8Array read", `const u = new Uint8Array(3);\nlet i = 1.5;\nconsole.log(u[i]);\n`, 3],
    ["Uint8Array write", `const u = new Uint8Array(3);\nlet i = 1.5;\nu[i] = 7;\nconsole.log("survived");\n`, 3],
  ] as const) {
    test(name, async () => {
      const r = await run(src);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`panic: index out of bounds: the length is ${len} but the index is 1.5`);
      expect(r.exitCode).toBe(134);
    });
  }

  test("a whole-valued double is still a perfectly good index", async () => {
    const src = `const a: number[] = [1, 2, 3];
let i = 6 / 2 - 1;
console.log(a[i], "abc"[i]);
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });

  test("`.with` is UNCHANGED — node truncates there, so truncating matches it", async () => {
    const src = `const a: number[] = [1, 2, 3];
let i = 1.7;
console.log(a.with(i, 9).join(","));
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
    expect(r.stdout).toBe("1,9,3\n");
  });
});

/* ============================================================
 * THE HELP LINE HAS TO BE TRUE.
 *
 * `nt_panic_bounds` used to compose ONE help line for every accessor and every index:
 *
 *     help: <what> is out of range; use `.at(i)` to get `undefined` instead of panicking
 *
 * Measured against node, that is only true for a READ at or past the end. Everywhere
 * else, FOLLOWING IT DOES NOT AVOID THE PANIC — IT RETURNS A DIFFERENT VALUE:
 *
 *     [1,2,3][-1]   -> undefined      [1,2,3].at(-1)   -> 3      (the LAST element)
 *     "abc"[-1]     -> undefined      "abc".at(-1)     -> "c"
 *     [1,2,3][1.5]  -> undefined      [1,2,3].at(1.5)  -> 2      (truncates)
 *     [1,2,3][NaN]  -> undefined      [1,2,3].at(NaN)  -> 1      (element 0)
 *
 * and for a `.with` or a typed-array WRITE, `.at` is a READ and cannot express the
 * operation at all — yet both were told to use it.
 *
 * `nt_panic_bounds` already takes `what`, so the suggestion is keyed on it (and on the
 * index). Every line below is EXECUTED against node in the "the advice compiles and
 * matches node" tests: a hint whose advice is never run is a hint nobody checked.
 * ============================================================ */
describe("the panic's help line is true for the accessor that faulted", () => {
  /** The `help:` line of a panic, whitespace-normalized. */
  const help = (stderr: string): string => (stderr.match(/^ {2}help: (.*)$/m)?.[1] ?? "").replace(/\s+/g, " ");

  describe("a READ at or past the end — `.at(i)` really is `undefined` there", () => {
    test("array", async () => {
      const r = await run(`const a: number[] = [1, 2, 3];\nlet i = 5;\nconsole.log(a[i]);\n`);
      expect(help(r.stderr)).toContain("use `.at(5)` to get `undefined` instead of panicking");
    });
  });

  describe("a NEGATIVE read — `.at` counts from the END, so it is a different value", () => {
    for (const [name, src, at] of [
      ["array", `const a: number[] = [1, 2, 3];\nlet i = -1;\nconsole.log(a[i]);\n`, "`.at(-1)`"],
      ["string", `const s = "abc";\nlet i = -1;\nconsole.log(s[i]);\n`, "`.at(-1)`"],
      ["Uint8Array", `const u = new Uint8Array(4);\nlet i = -2;\nconsole.log(u[i]);\n`, "`.at(-2)`"],
    ] as const) {
      test(name, async () => {
        const h = help((await run(src)).stderr);
        // The defect verbatim: it must NOT promise `undefined` from `.at`.
        expect(h).not.toContain("to get `undefined` instead of panicking");
        expect(h).toContain("node reads `undefined` for a negative index");
        expect(h).toContain(`${at} is NOT that: it counts from the END`);
      });
    }
  });

  describe("a NON-INTEGER read — `.at` truncates, and `.at(NaN)` reads element 0", () => {
    test("a fractional index", async () => {
      const h = help((await run(`const a: number[] = [1, 2, 3];\nlet i = 1.5;\nconsole.log(a[i]);\n`)).stderr);
      expect(h).not.toContain("to get `undefined` instead of panicking");
      expect(h).toContain("truncates towards zero");
    });

    test("NaN", async () => {
      const h = help((await run(`const a: number[] = [1, 2, 3];\nlet i = 0 / 0;\nconsole.log(a[i]);\n`)).stderr);
      expect(h).not.toContain("to get `undefined` instead of panicking");
      expect(h).toContain("`.at(NaN)` reads element 0");
    });
  });

  describe("a typed-array WRITE — `.at` is a read and cannot express it", () => {
    for (const [name, src] of [
      ["past the end", `const u = new Uint8Array(4);\nlet i = 4;\nu[i] = 255;\n`],
      ["negative", `const u = new Uint8Array(4);\nlet i = -2;\nu[i] = 1;\n`],
    ] as const) {
      test(name, async () => {
        const h = help((await run(src)).stderr);
        expect(h).not.toMatch(/use `\.at\(/);
        expect(h).toContain("node silently DISCARDS an out-of-range typed-array write");
        expect(h).toContain("`.at(");           // …only to say it is a READ and cannot do this
        expect(h).toContain("is a READ and cannot express a write");
      });
    }
  });

  describe("`.with(i, v)` — a pure UPDATE, which `.at` cannot express either", () => {
    test("a negative index: node counts from the end, so name the equivalent", async () => {
      const h = help((await run(`const a: number[] = [1, 2, 3];\nlet i = -1;\nconsole.log(a.with(i, 9).join(","));\n`)).stderr);
      expect(h).not.toMatch(/`\.at\(/);
      expect(h).toContain("node's `.with` counts a negative index from the END");
      expect(h).toContain("write `.with(a.length - 1, v)`");
    });

    test("past the end: node throws RangeError too, so point at the spread", async () => {
      const h = help((await run(`const a: number[] = [1, 2, 3];\nlet i = 5;\nconsole.log(a.with(i, 9).join(","));\n`)).stderr);
      expect(h).not.toMatch(/`\.at\(/);
      expect(h).toContain("RangeError: Invalid index : 5");
      expect(h).toContain("[...a, v]");
    });

    test("a negative index that is still past the START gets the RangeError line", async () => {
      const h = help((await run(`const a: number[] = [1, 2, 3];\nlet i = -4;\nconsole.log(a.with(i, 9).join(","));\n`)).stderr);
      expect(h).toContain("RangeError: Invalid index : -4");
    });
  });

  /*
   * THE STANDING RULE: compile the advice and run it against node. Sixteen lying
   * diagnostics were found in one day, and this is the only check that catches the class.
   */
  describe("the advice compiles and matches node", () => {
    for (const [name, src] of [
      // "test the index first" for a negative read — node's `a[-1]` is `undefined`.
      ["guarding a negative read reproduces node's `undefined`",
       `const a: number[] = [1, 2, 3];
let i = -1;
console.log(i >= 0 && i < a.length ? String(a[i]) : "undefined");
console.log(String(a[-1 + 1]));
`],
      // "…or use `.at()` deliberately if the element from the end is what you meant".
      ["`.at(-1)` really is the LAST element, which is what the help says it is",
       `const a: number[] = [1, 2, 3];
const s = "abc";
console.log(String(a.at(-1)), String(s.at(-1)));
`],
      // `.with(a.length - 1, v)` is node's `.with(-1, v)`.
      ["`.with(a.length - 1, v)` equals node's `.with(-1, v)`",
       `const a: number[] = [1, 2, 3];
console.log(a.with(a.length - 1, 9).join(","));
console.log(a.with(-1 + a.length, 9).join(","));
`],
      // "to APPEND, spread instead: `[...a, v]`".
      ["`[...a, v]` appends where an out-of-range `.with` cannot",
       `const a: number[] = [1, 2, 3];
const b: number[] = [...a, 9];
console.log(b.join(","), a.join(","));
`],
      // "test `i >= 0 && i < u.length` before writing" — node DISCARDS the write, so a
      // guarded no-op is the node-identical program.
      ["guarding a typed-array write reproduces node's silent discard",
       `const u = new Uint8Array(3);
let i = 5;
if (i >= 0 && i < u.length) { u[i] = 7; }
console.log(u[0], u[1], u[2], u.length);
`],
    ] as const) {
      test(name, async () => {
        const r = await run(src);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe(runWithNode(src).stdout);
      });
    }

    /*
     * The counter-case, kept as an executable record of WHY the old hint was wrong:
     * node's `a[-1]` and node's `a.at(-1)` disagree, so "use `.at(-1)`" changed the
     * answer. Both sides run under node here — nothing to compile — but if `.at`'s
     * relative indexing ever stopped being relative, this is the test that says so.
     */
    test("node itself proves `a[-1]` and `a.at(-1)` are different values", () => {
      const src = `const a = [1, 2, 3];
console.log(String(a[-1]), String(a.at(-1)));
console.log(String("abc"[-1]), String("abc".at(-1)));
`;
      expect(runWithNode(src).stdout).toBe("undefined 3\nundefined c\n");
    });
  });
});

/*
 * A string bigger than the host can represent is a controlled PANIC too.
 *
 * These builders took their length as `(long)d`, which is UNDEFINED in C for a
 * non-finite or out-of-range double, and then did the size arithmetic in `size_t`,
 * which WRAPS. Both halves were reachable from ordinary source:
 *
 *   - `"abc".padStart(Infinity, "xy")` — arm64 saturates the conversion to LONG_MAX and
 *     asks malloc for 9 exabytes (a bare signal); x86-64 yields LONG_MIN, which makes
 *     `n >= target` TRUE and silently answers `"abc"` at exit 0. Same source, opposite
 *     failures, decided by the host.
 *   - `"abcd".repeat(2**62)` — 2^64 bytes truncates to 0, so it allocated ONE byte and
 *     memcpy'd into it 2^62 times. An out-of-bounds heap write, observed as SIGBUS with
 *     empty stdout AND empty stderr, the overflow having smashed stdio's own buffer.
 *   - `"".repeat(1e100)` — hung forever on a LONG_MAX-trip loop of zero-byte copies.
 *   - `"x".repeat(-1)` — answered "" at exit 0 where node throws.
 *
 * The cap is node's own: V8's maximum string length, 2^29-24 = 536870888 BYTES (we count
 * UTF-8 bytes where node counts UTF-16 code units — the pre-existing A.2 divergence — so
 * the boundaries coincide for ASCII). Verified by binary search against node v24:
 * `"abc".padStart(536870888)` succeeds on both sides, 536870889 stops on both.
 *
 * Why a panic and not a catchable raise: see the block comment on `nt_panic_str_len` in
 * runtime/runtime.c. node throws a RangeError, so the EXIT CODE diverges (134 vs 1) —
 * docs/divergences.md. stdout up to the stop stays byte-comparable, which is what the
 * differential harness compares.
 */
describe("string length", () => {
  test("`padStart(Infinity)` panics with a diagnostic instead of dying on a bare signal", async () => {
    const src = `console.log("start");
console.log("abc".padStart(Infinity, "xy"));
`;
    const r = await run(src);
    // stdout up to the stop is intact and byte-identical to node's.
    expect(r.stdout).toBe("start\n");
    expect(r.stdout).toBe(runWithNode(src).stdout);
    expect(r.stderr).toContain("panic: invalid string length: the padded string would be Infinity bytes");
    expect(r.exitCode).toBe(134);
    // node's half of the contract: it stops here too, and says why.
    expect(runWithNode(src).stderr).toContain("RangeError: Invalid string length");
  });

  test("the panic names node's exact maximum, so the cap cannot drift by one", async () => {
    const r = await run(`console.log("abc".padStart(536870889, "x").length);\n`);
    expect(r.stderr).toContain("the padded string would be 536870889 bytes, past the 536870888-byte maximum");
    expect(r.exitCode).toBe(134);
  });

  test("`padEnd` shares the path", async () => {
    const src = `console.log("start");
console.log("abc".padEnd(2 ** 31, "xy"));
`;
    const r = await run(src);
    expect(r.stdout).toBe("start\n");
    expect(r.stderr).toContain("panic: invalid string length: the padded string would be 2147483648 bytes");
    expect(r.exitCode).toBe(134);
    expect(runWithNode(src).stderr).toContain("RangeError: Invalid string length");
  });

  test("`repeat` overflowing size_t panics instead of writing past a 1-byte buffer", async () => {
    const src = `console.log("start");
console.log("abcd".repeat(4611686018427387904).length);
`;
    const r = await run(src);
    // The old wrap died with EMPTY stdout: the OOB write had already corrupted stdio's
    // buffer, so even the line printed before the fault was lost. Asserting it is back
    // is what distinguishes a controlled stop from the heap overflow.
    expect(r.stdout).toBe("start\n");
    expect(r.stderr).toContain("panic: invalid string length: the repeated string would be 18446744073709552000 bytes");
    expect(r.exitCode).toBe(134);
    expect(runWithNode(src).stderr).toContain("RangeError: Invalid string length");
  });

  test("a negative `repeat` count stops instead of silently answering the empty string", async () => {
    const src = `console.log("start");
console.log("x".repeat(-1).length);
`;
    const r = await run(src);
    expect(r.stdout).toBe("start\n");
    expect(r.stderr).toContain("panic: invalid count value: -1");
    expect(r.stderr).toContain("RangeError: Invalid count value: -1");
    expect(r.exitCode).toBe(134);
    expect(runWithNode(src).stderr).toContain("RangeError: Invalid count value: -1");
  });

  test("the count is rejected BEFORE the length, so `\"\".repeat(Infinity)` stops", async () => {
    // ES 22.1.3.18 step 3 runs ahead of the length check, which is why an empty receiver
    // does not excuse an infinite count — while `"".repeat(1e100)` is a plain "".
    const src = `console.log("start");
console.log("".repeat(Infinity).length);
`;
    const r = await run(src);
    expect(r.stderr).toContain("panic: invalid count value: Infinity");
    expect(r.exitCode).toBe(134);
    expect(runWithNode(src).stderr).toContain("RangeError: Invalid count value: Infinity");
  });

  test("`\"\".repeat(1e100)` is \"\" — it used to hang forever", async () => {
    const src = `console.log("".repeat(1e100).length);\n`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });

  test("an empty pad returns the receiver even for an infinite target, exactly like node", async () => {
    // ES 22.1.3.17: the empty-filler short-circuit runs BEFORE the length is checked, so
    // this is `"abc"` and not a RangeError. Getting the order wrong would panic here.
    const src = `console.log("abc".padStart(Infinity, ""));
console.log("abc".padEnd(Infinity, ""));
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("abc\nabc\n");
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });

  test("every in-range pad/repeat still matches node byte for byte", async () => {
    const src = `console.log("abc".padStart(NaN, "xy"));
console.log("abc".padStart(-5, "xy"));
console.log("abc".padStart(0, "xy"));
console.log("abc".padStart(10, ""));
console.log("abc".padStart(10, "xy"));
console.log("abc".padStart(4.9, "z"));
console.log("abc".padEnd(10, "xy"));
console.log("abc".padEnd(3, "xy"));
console.log("x".repeat(NaN).length);
console.log("x".repeat(-0.5).length);
console.log("x".repeat(0).length);
console.log("ab".repeat(2.9));
console.log("ab".repeat(3));
`;
    const r = await run(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(runWithNode(src).stdout);
  });
});
