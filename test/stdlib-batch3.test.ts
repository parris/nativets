/*
 * stdlib Batch 3 — the object-shaped web APIs (now that classes exist).
 *
 * `docs/stdlib.md` deferred `new Date()`, `new URL()` and `URLSearchParams`
 * because nativets had no classes. It has them now (SH3–SH3.6), so the
 * functional workarounds become the real API and `node` is the oracle DIRECTLY
 * — no polyfill.
 *
 * TIMEZONE DECISION (docs/divergences.md §D): the local-time accessors are
 * genuinely local — the runtime uses `localtime_r`/`mktime`, which read the same
 * IANA zone (`TZ`, `/etc/localtime`) node's ICU does, so `getHours()` matches
 * node on the same machine in the same zone. To keep the tests deterministic the
 * local-time cases are run with `TZ` PINNED on BOTH sides (`differentialTZ`)
 * across UTC, a DST zone, and a half-hour-offset zone. `toISOString()` and
 * `new Date("YYYY-MM-DD")` are UTC by specification and need no pinning.
 *
 * `new Date()` itself is a clock read, so — exactly like `Date.now()` in Batch 1
 * — it is tested BEHAVIORALLY (monotonic, plausible range), never against node.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expectMatchesNode, compileAndRun, compileAndRunIO, runWithNodeIO, emitIR, emitIRAsan } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Compile-only: return the NT code a source is rejected with, or null if it compiles. */
function rejectCode(src: string): string | null {
  try { sourceToIR(src); return null; } catch (e) { return e instanceof NTError ? e.diag.code : "throw"; }
}

interface Case { name: string; code: string }

/** Run every case in a table as a differential test against node. */
function differential(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const c of cases) {
      test(c.name, async () => {
        const { ours, oracle } = await expectMatchesNode(c.code);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });
    }
  });
}

/** Zones the local-time cases are pinned to: UTC, a DST zone, a half-hour offset. */
const ZONES = ["UTC", "America/New_York", "Asia/Kolkata"];

/** Differential, but with `TZ` pinned identically on both sides, once per zone. */
function differentialTZ(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const c of cases) {
      for (const tz of ZONES) {
        test(`${c.name} [TZ=${tz}]`, async () => {
          const oracle = runWithNodeIO(c.code, { env: { TZ: tz } });
          const ours = await compileAndRunIO(c.code, { env: { TZ: tz } });
          expect(ours.stdout).toBe(oracle.stdout);
          expect(ours.exitCode).toBe(oracle.exitCode);
        });
      }
    }
  });
}

/* ============================================================
 * 1. Date — the component API
 * ============================================================ */

differential("stdlib batch 3: new Date(ms) + .getTime()", [
  {
    name: "epoch ms round-trips through .getTime()",
    code: `
console.log(new Date(0).getTime());
console.log(new Date(1700000000123).getTime());
console.log(new Date(-1).getTime());
`,
  },
  {
    name: "TimeClip — fractional ms truncate toward zero, out of range is NaN",
    code: `
console.log(new Date(1.5).getTime(), new Date(-1.5).getTime());
console.log(new Date(8.64e15).getTime());
console.log(new Date(8.64e15 + 1).getTime());
console.log(new Date(NaN).getTime());
`,
  },
  /*
   * TimeClip is `ToIntegerOrInfinity(t)` clamped (ECMA-262 21.4.1.15), and
   * ToIntegerOrInfinity maps -0 to +0 (7.1.5 step 3: "If integer is -0, return +0").
   * So EVERY time value in (-1, 0] clips to POSITIVE zero in node.
   *
   * The runtime truncated toward zero and kept the sign, so the stored time value was
   * `-0` and every reader of it saw a negative zero. That is a real VALUE difference,
   * not a printing one — but `String()` and `toISOString()` both erase the sign, so
   * only `console.log` (util.inspect prints `-0`) and a DIVISION expose it. The `1/x`
   * rows are the load-bearing ones: on main they printed `-Infinity`.
   */
  {
    name: "TimeClip normalises -0 to +0 — probed with 1/x, which the string forms hide",
    code: `
console.log(new Date(-0).getTime());
console.log(new Date(-0.5).getTime());
console.log(new Date(-0.9).getTime());
console.log(1 / new Date(-0).getTime());
console.log(1 / new Date(-0.5).getTime());
console.log(1 / new Date(0).getTime());
console.log(new Date(-1.5).getTime());
console.log(1 / new Date(-1).getTime());
`,
  },
]);

/*
 * `new Date()` reads the CLOCK, so node can never be its oracle (the two runs
 * happen at different instants). Tested behaviorally instead, exactly as Batch 1
 * tested `Date.now()`: it agrees with Date.now(), it is non-decreasing, and it
 * lands in a plausible range.
 */
test("stdlib batch 3: new Date() is a plausible, non-decreasing clock read", async () => {
  const ours = await compileAndRun(`
const a = new Date();
const b = new Date();
console.log(a.getTime() <= b.getTime());
console.log(Math.abs(a.getTime() - Date.now()) < 5000);
console.log(a.getTime() > 1735689600000);
console.log(a.getTime() === Math.floor(a.getTime()));
console.log(a.getUTCFullYear() >= 2025);
console.log(a.toISOString().length === 24);
`);
  expect(ours.stdout).toBe("true\ntrue\ntrue\ntrue\ntrue\ntrue\n");
  expect(ours.exitCode).toBe(0);
});

differentialTZ("stdlib batch 3: Date LOCAL component getters match node", [
  {
    name: "getFullYear/getMonth/getDate/getHours/getMinutes/getSeconds/getDay",
    code: `
const d = new Date(1584267630400);
console.log(d.getFullYear(), d.getMonth(), d.getDate());
console.log(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
console.log(d.getDay());
`,
  },
  {
    name: "across the epoch, a leap day, and a DST transition",
    code: `
const ts = [0, -1, 86399999, 951782400000, 1583650800000, 1604214000000, 2147483647000];
for (const t of ts) {
  const d = new Date(t);
  console.log(d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes());
}
`,
  },
  {
    name: "an Invalid Date returns NaN from every getter",
    code: `
const d = new Date(NaN);
console.log(d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getTime());
`,
  },
  {
    name: "the getUTC* aliases are zone-INDEPENDENT (identical in every TZ)",
    code: `
const d = new Date(1584267630400);
console.log(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay());
console.log(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
console.log(d.toISOString());
`,
  },
]);

differential("stdlib batch 3: Date#toISOString matches node", [
  {
    name: "the epoch, sub-second precision, before 1970, and the extended-year form",
    code: `
console.log(new Date(0).toISOString());
console.log(new Date(1700000000123).toISOString());
console.log(new Date(-1).toISOString());
console.log(new Date(-62167219200000).toISOString());
console.log(new Date(8.64e15).toISOString());
console.log(new Date(-8.64e15).toISOString());
`,
  },
  {
    name: "typeof a Date is \"object\" (node's answer, whatever our repr is)",
    code: `
const d = new Date(0);
console.log(typeof d);
console.log(typeof d.getTime());
console.log(typeof new URL("https://x.com/"));
console.log(typeof new URLSearchParams("a=1"));
`,
  },
  {
    name: "console.log(date) prints the ISO string (node's util.inspect of a Date)",
    code: `
console.log(new Date(0));
console.log(new Date(1584267630400));
console.log(new Date(NaN));
`,
  },
  {
    name: "toISOString() of an Invalid Date throws, and the throw is CATCHABLE",
    code: `
try {
  console.log(new Date(NaN).toISOString());
} catch (e) {
  console.log("caught");
}
console.log("after");
`,
  },
  /*
   * `Date.prototype.toJSON` is NOT `toISOString` by another name. 21.4.4.37 takes the
   * primitive FIRST and returns `null` when it is a non-finite Number — step 3, before
   * step 4 ever invokes `toISOString` — so an Invalid Date serialises as `null` and the
   * method never throws. Its result type is therefore `string | null`, which is why the
   * `?? "-"` row below is part of the case rather than a separate one.
   *
   * `JSON.stringify(invalidDate)` was already correct (`nt_date_to_json` checks for NaN),
   * which is exactly what hid this: only the DIRECT `.toJSON()` call routed through
   * `toISOString` and exited 1 with empty stdout where node prints `null` and carries on.
   */
  {
    name: "toJSON() of an Invalid Date is null, not a throw (21.4.4.37 step 3)",
    code: `
console.log(new Date(NaN).toJSON());
console.log(new Date(8640000000000001).toJSON());
console.log(new Date(0).toJSON());
console.log(new Date(NaN).toJSON() ?? "-");
console.log(new Date(0).toJSON() ?? "-");
console.log(new Date(NaN).toJSON() === null);
console.log("still here");
`,
  },
]);

differential("stdlib batch 3: new Date(isoString) matches node", [
  {
    name: "date-only is UTC; the full form with Z / an offset is absolute",
    code: `
console.log(new Date("2020-03-15").getTime());
console.log(new Date("2020-03-15T10:20:30.400Z").getTime());
console.log(new Date("2020-03-15T10:20:30Z").getTime());
console.log(new Date("2020-03-15T10:20:30+02:00").getTime());
console.log(new Date("2020-03-15T10:20:30-05:30").getTime());
console.log(new Date("1970-01-01T00:00:00.000Z").getTime());
console.log(new Date("2020-03-15T10:20:30.4Z").getTime());
console.log(new Date("+020020-03-15T00:00:00Z").getTime());
`,
  },
  {
    name: "a string outside the ES Date Time String Format is an Invalid Date (NaN)",
    code: `
console.log(new Date("").getTime());
console.log(new Date("not a date").getTime());
console.log(new Date("2020-13-01T00:00:00Z").getTime());
console.log(new Date("2020-03-15T10:20:30.400Zjunk").getTime());
console.log(new Date("2020-03-15T25:00:00Z").getTime());
`,
  },
]);

differentialTZ("stdlib batch 3: new Date(isoString) without an offset is LOCAL", [
  {
    name: "a date-TIME string with no zone designator is interpreted in the local zone",
    code: `
console.log(new Date("2020-03-15T10:20:30").getTime());
console.log(new Date("2020-07-04T12:00:00.500").getTime());
console.log(new Date("2020-01-01T00:00:00").getTime());
`,
  },
]);

/* ============================================================
 * 2. URL / URLSearchParams — the real class, node as the DIRECT oracle
 * ============================================================ */

differential("stdlib batch 3: new URL(u) components match node", [
  {
    name: "every component of a full absolute URL",
    code: `
const u = new URL("https://example.com/path?a=1&b=2#frag");
console.log(u.protocol);
console.log(u.host);
console.log(u.hostname);
console.log(u.port);
console.log(u.pathname);
console.log(u.search);
console.log(u.hash);
console.log(u.origin);
`,
  },
  {
    name: "explicit + default ports, an empty path, userinfo, uppercase host",
    code: `
const a = new URL("http://example.com:8080/x");
console.log(a.host, a.port, a.origin);
const b = new URL("https://example.com:443/x");
console.log(b.host, b.port, b.origin);
const c = new URL("http://example.com:80/x");
console.log(c.host, c.port);
const d = new URL("https://EXAMPLE.com");
console.log(d.hostname, d.pathname, "[" + d.search + "]", "[" + d.hash + "]");
const e = new URL("https://user:pass@example.com/p?q=1");
console.log(e.hostname, e.pathname);
`,
  },
]);

differential("stdlib batch 3: URLSearchParams matches node", [
  {
    name: "url.searchParams — get / has / getAll, with '+' and %XX decoding",
    code: `
const u = new URL("https://example.com/?x=b+c%20d&e=%2F&x=second&flag");
const p = u.searchParams;
console.log(p.get("x"));
console.log(p.get("e"));
console.log(p.get("flag"));
console.log(p.get("missing"));
console.log(p.has("x"), p.has("flag"), p.has("missing"));
console.log(p.getAll("x").join("|"));
console.log(p.getAll("missing").length);
`,
  },
  {
    name: "a standalone URLSearchParams, with and without the leading '?'",
    code: `
const p = new URLSearchParams("a=1&b=two&a=3");
console.log(p.get("a"), p.get("b"));
console.log(p.getAll("a").join(","));
console.log(p.toString());
const q = new URLSearchParams("?k=v%20w&empty=");
console.log(q.get("k"), "[" + (q.get("empty") ?? "?") + "]");
console.log(q.toString());
`,
  },
  {
    name: "`.get` of a missing key is null, so `??` composes (node's exact shape)",
    code: `
const p = new URLSearchParams("a=1");
console.log(p.get("a") ?? "fallback");
console.log(p.get("zzz") ?? "fallback");
console.log(p.get("zzz") === null);
`,
  },
]);

differential("stdlib batch 3: new URL(bad) throws, catchably (node's TypeError)", [
  {
    name: "a URL node itself refuses is a CATCHABLE throw here too",
    code: `
const bad = ["notaurl", "", "http://", "/relative/path"];
for (const b of bad) {
  try {
    const u = new URL(b);
    console.log("parsed", u.host);
  } catch (e) {
    console.log("threw");
  }
}
console.log("done");
`,
  },
]);

/* ============================================================
 * 3. Object.freeze / getOwnPropertyNames (and the mutating ones, refused)
 * ============================================================ */

differential("stdlib batch 3: Object.freeze is honest (objects are already immutable)", [
  {
    name: "freeze returns the SAME object and the value is unchanged",
    code: `
const o = { a: 1, b: 2 };
const f = Object.freeze(o);
console.log(f.a, f.b);
console.log(Object.keys(f).join(","));
`,
  },
  {
    name: "getOwnPropertyNames == keys for a plain record, in insertion order",
    code: `
const o = { zeta: 1, alpha: 2, mid: 3 };
console.log(Object.getOwnPropertyNames(o).join(","));
console.log(Object.getOwnPropertyNames(o).length);
const one = { only: "x" };
console.log(Object.getOwnPropertyNames(one).join(","));
`,
  },
]);

/*
 * `Object.isFrozen` used to compile to the constant `true`, which is the project's own
 * worst category: node answers about THIS OBJECT's state, so a never-frozen object is
 * `false` there and both sides exited 0 with no diagnostic.
 *
 * It cannot be answered honestly without a per-object frozen bit, and a compile-time
 * approximation would be UNSOUND rather than merely incomplete: `Object.freeze(o)`
 * returns the SAME object, so
 *
 *     const f = Object.freeze(o);   //  node: Object.isFrozen(o) is now TRUE as well
 *
 * — freezing through any alias freezes the original, which is alias analysis, not a
 * syntactic test. So it is REFUSED, alongside its already-refused neighbours
 * `Object.isSealed` and `Object.isExtensible` (same NT1002 family, same reason).
 *
 * `Object.freeze` ITSELF stays: node's contract for it — the same object back — is met
 * exactly, and the frozen-ness it establishes is only ever observed through these three
 * predicates, all of which now refuse.
 */
describe("stdlib batch 3: the frozen-STATE predicates are refused, not guessed (NT1002)", () => {
  for (const [name, src] of [
    ["Object.isFrozen", `const o = { a: 1 }; console.log(Object.isFrozen(o));`],
    ["Object.isFrozen of a freeze result", `const o = { a: 1 }; console.log(Object.isFrozen(Object.freeze(o)));`],
    ["Object.isSealed", `const o = { a: 1 }; console.log(Object.isSealed(o));`],
    ["Object.isExtensible", `const o = { a: 1 }; console.log(Object.isExtensible(o));`],
  ] as const) {
    test(name, () => { expect(rejectCode(src)).toBe("NT1002"); });
  }

  test("the refusal names the alias reason, and does NOT claim objects are frozen", () => {
    let hint = "", message = "";
    try { sourceToIR(`const o = { a: 1 }; console.log(Object.isFrozen(o));`); }
    catch (e) { if (e instanceof NTError) { hint = e.diag.hint ?? ""; message = e.diag.message; } }
    expect(message).toContain("Object.isFrozen");
    expect(hint).toContain("Object.freeze(o)` returns the SAME object");
    // The old behavior, stated as advice, would be the same wrong answer in a hint.
    expect(hint).not.toContain("always `true`");
  });

  test("`Object.freeze` itself still compiles — only the OBSERVATION is refused", () => {
    expect(rejectCode(`const o = { a: 1 }; const f = Object.freeze(o); console.log(f.a);`)).toBe(null);
  });
});

describe("stdlib batch 3: the mutating Object statics are refused (NT1606)", () => {
  for (const [name, src] of [
    ["Object.assign", `const a = { x: 1 }; const b = { y: 2 }; Object.assign(a, b); console.log(a.x);`],
    ["Object.defineProperty", `const a = { x: 1 }; Object.defineProperty(a, "y", { value: 2 }); console.log(a.x);`],
  ] as const) {
    test(name, () => { expect(rejectCode(src)).toBe("NT1606"); });
  }
});

test("stdlib batch 3: Object.freeze aliases (it does NOT double-free the object)", async () => {
  const ours = await compileAndRun(`
function f(): number {
  const o = { a: 1, b: 2 };
  const g = Object.freeze(o);
  return g.a + g.b;
}
console.log(f());
console.log(__objLive());
`);
  expect(ours.stdout).toBe("3\n0\n"); // freed exactly once, by the final owner
  expect(ours.exitCode).toBe(0);
});

/* ============================================================
 * 4. Integration — a Date/URL used the way a real program uses one
 * ============================================================ */

differential("stdlib batch 3: Date and URL compose with the rest of the language", [
  {
    name: "`Date` / `URL` as parameter, return and object-field TYPES",
    code: `
function ageMs(from: Date, to: Date): number { return to.getTime() - from.getTime(); }
function pathOf(u: URL): string { return u.pathname; }
console.log(ageMs(new Date(0), new Date(1500)));
console.log(pathOf(new URL("https://example.com/a/b?q=1")));
const rec = { at: new Date(86400000), url: new URL("https://example.com/x") };
console.log(rec.at.toISOString(), rec.url.host, rec.url.pathname);
`,
  },
  {
    name: "JSON.stringify serializes a Date via toJSON (the quoted ISO string)",
    code: `
console.log(JSON.stringify({ at: new Date(0), n: 1 }));
console.log(JSON.stringify({ at: new Date(1584267630400) }));
console.log(JSON.stringify({ at: new Date(NaN) }));
`,
  },
  {
    name: "structuredClone deep-copies a Date field",
    code: `
const rec = { at: new Date(5), n: 1 };
const c = structuredClone(rec);
console.log(c.at.toISOString(), c.n);
console.log(JSON.stringify(c));
`,
  },
  {
    name: "Dates compare and sort as the numbers they are",
    code: `
const a = new Date(1000), b = new Date(2000);
console.log(a.getTime() < b.getTime(), a.getTime() === new Date(1000).getTime());
const spans = [new Date("2021-01-01T00:00:00Z"), new Date("2020-06-01T00:00:00Z")];
console.log(spans[0].getTime() > spans[1].getTime());
`,
  },
]);

/* ============================================================
 * 5. The refusals: no Unicode database, no ICU, no Date mutation
 * ============================================================ */

describe("stdlib batch 3: what is refused, precisely (NT1024)", () => {
  for (const [name, src] of [
    ["String#normalize (needs the Unicode database)", `console.log("abc".normalize());`],
    ["String#localeCompare (needs ICU collation)", `console.log("a".localeCompare("b"));`],
    ["String#toLocaleUpperCase", `console.log("a".toLocaleUpperCase());`],
    ["Date#setHours — a Date is an immutable time value", `const d = new Date(0); d.setHours(3);`],
    ["Date#toString — locale + zone-name formatting", `console.log(new Date(0).toString());`],
    ["Date#toLocaleDateString", `console.log(new Date(0).toLocaleDateString());`],
    ["new Date(y, m, d) — the component constructor", `console.log(new Date(2020, 2, 15).getTime());`],
    ["new URL(relative, base) — URL resolution", `console.log(new URL("/a", "https://x.com").pathname);`],
    ["URL#href — needs the WHATWG serializer", `console.log(new URL("https://x.com/").href);`],
    ["console.log(url) — node inspects it as `URL { … }`", `console.log(new URL("https://x.com/"));`],
    ["`\"\" + date` — node's Date#toString", `console.log("t=" + new Date(0));`],
    ["URLSearchParams#append — it mutates", `const p = new URLSearchParams("a=1"); p.append("b", "2");`],
  ] as const) {
    test(name, () => { expect(rejectCode(src)).toBe("NT1024"); });
  }

  // WAS: "string concatenation with a `string | null` is refused, not miscompiled (NT1009)".
  //
  // That refusal is GONE, and this test now pins the opposite. The lane that added it
  // reasoned that `?? "…"` was "the only spelling whose output is unambiguous" — but node
  // defines the output exactly (`String(null)` is "null", `String(undefined)` is
  // "undefined"), and node is the specification. Refusing a program node runs, with a
  // defined answer we can produce, is a divergence with nothing behind it.
  //
  // The original concern was still half right, and worth keeping in view: the raw nullable
  // BOX must never reach codegen as if it were a string. It used to, which is why `${x}`
  // emitted invalid IR. The nullable-box lane made concatenation unwrap through the tag —
  // so the box is handled, and the refusal is no longer earning anything.
  test("string concatenation with a `string | null` matches node — not refused", async () => {
    await expectMatchesNode(
      `const p = new URLSearchParams("a=1");\n` +
      `console.log("[" + p.get("a") + "]");\n` +   // present -> [1]
      `console.log("[" + p.get("zz") + "]");\n`,   // absent  -> [null], as node prints it
    );
  });
});

/* ============================================================
 * 5. encodeURIComponent / decodeURIComponent / encodeURI / decodeURI
 * ============================================================ */

differential("stdlib batch 3: URI encoding matches node", [
  {
    name: "encodeURIComponent — the unescaped set, reserved chars, spaces",
    code: `
console.log(encodeURIComponent("hello world"));
console.log(encodeURIComponent("a/b?c=d&e#f"));
console.log(encodeURIComponent("-_.!~*'()"));
console.log(encodeURIComponent("ABCdef0189"));
console.log(encodeURIComponent(""));
console.log(encodeURIComponent("100%"));
console.log(encodeURIComponent("\\n\\t"));
`,
  },
  {
    name: "encodeURI keeps the reserved set that encodeURIComponent escapes",
    code: `
console.log(encodeURI("https://example.com/a b?x=1&y=2#z"));
console.log(encodeURI("a/b?c=d&e#f"));
console.log(encodeURI(";/?:@&=+$,#"));
console.log(encodeURIComponent(";/?:@&=+$,#"));
`,
  },
  {
    name: "decodeURIComponent / decodeURI round-trip and differ on the reserved set",
    code: `
console.log(decodeURIComponent("hello%20world"));
console.log(decodeURIComponent("a%2Fb%3Fc%3Dd"));
console.log(decodeURI("a%2Fb%3Fc%3Dd"));
console.log(decodeURI("hello%20world"));
console.log(decodeURIComponent(encodeURIComponent("a/b?c=d&e#f")));
console.log(decodeURI(encodeURI("https://example.com/a b?x=1#z")));
console.log(decodeURIComponent("nothing to decode"));
`,
  },
  {
    name: "a malformed % sequence throws, and the throw is CATCHABLE (node's URIError)",
    code: `
const bad = ["%", "%A", "%ZZ", "abc%"];
for (const b of bad) {
  try {
    console.log(decodeURIComponent(b));
  } catch (e) {
    console.log("threw");
  }
}
console.log("done");
`,
  },
]);

/*
 * ...AND THE SCRATCH BUFFER THEY BUILD THE ANSWER IN IS FREED.
 *
 * `uri_encode`/`uri_decode` (runtime/runtime.c) write into a `nativets_alloc`
 * worst-case buffer, copy the finished bytes into a fresh `alloc_str`, and used to
 * return without freeing the scratch — on the success path AND on the URIError path,
 * which returns early. So every `encodeURIComponent`/`decodeURIComponent`/`encodeURI`/
 * `decodeURI` call abandoned one block, without bound, in proportion to the program's
 * work.
 *
 * WHY NO EXISTING TEST COULD SEE IT. The scratch is UNREGISTERED memory: only
 * `alloc_str` calls `nt_str_register`, so the buffer carries no refcount and is not in
 * the side table at all. `__strLive()` counts registered strings, `__arrLive()` counts
 * array HEADERS, `__objLive()` counts object blocks — the residue here is invisible to
 * every counter this compiler exposes, and the value the program observes is correct
 * either way. Only an allocator-level instrument sees this class.
 *
 * So this test uses one, on BOTH platforms rather than skipping half of them:
 * LeakSanitizer where it exists (Linux, via `-fsanitize=address` +
 * `ASAN_OPTIONS=detect_leaks=1`) and macOS's `leaks --atExit` where it does not — the
 * same reachability question, asked by the platform's own tool. That is the difference
 * from the Linux-only gate in test/transients.test.ts, which had no macOS instrument
 * available for the abandoned flat blocks it watches.
 *
 * TWO SCALES, and the assertion is that the residue does not GROW with the work — the
 * rule the leak tests in test/fuzz2-diff.test.ts state. A constant residue is
 * conservative over-retention; a residue proportional to the loop count is the leak.
 * Measured before the fix with `leaks`: 20,000 `decodeURIComponent` calls left 20,000
 * blocks / 1.83 MB, one per call, against ZERO for the same loop with the call deleted.
 */
describe("stdlib batch 3: URI coding frees its scratch buffer", () => {
  /** The loop, at a caller-chosen scale. Both exits of `uri_decode` are exercised: the
   *  success path, and the early return after the URIError raise. */
  const uriLoop = (n: number) => `
function work(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const enc = encodeURIComponent("a b/c?d=e&f#g");
    acc = acc + decodeURIComponent(enc).length;
    acc = acc + decodeURI(encodeURI("http://x.example/a b?q=1")).length;
    try { acc = acc + decodeURIComponent("bad%zz").length; } catch (e) { acc = acc + 1; }
  }
  return acc;
}
console.log(work(${n}));
`;

  /** The CONTROL: the same loop and the same string traffic with no URI call in it, so
   *  a residue reported for the loop above is attributable to the URI functions rather
   *  than to the shape around them. */
  const controlLoop = (n: number) => `
function work(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const enc = "a%20b%2Fc%3Fd%3De%26f%23g".slice(0);
    acc = acc + enc.length;
    acc = acc + "http://x.example/a%20b?q=1".slice(0).length;
    try { acc = acc + "bad%zz".length; } catch (e) { acc = acc + 1; }
  }
  return acc;
}
console.log(work(${n}));
`;

  /** Build `src` and return how many blocks the platform's leak checker calls
   *  unreachable at exit, plus the program's stdout so the run is proved to have
   *  actually done the work. */
  function leakedBlocks(src: string): { leaks: number; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), "nativets-uri-leak-"));
    try {
      const ll = join(dir, "module.ll");
      const bin = join(dir, "prog");
      const onDarwin = process.platform === "darwin";
      // macOS `leaks` reads the process's own allocator, so the plain build is what it
      // wants; on Linux the leak checker IS ASan, which only instruments defines that
      // carry `sanitize_address` (see emitIRAsan / test/asan-instrumentation.test.ts).
      writeFileSync(ll, onDarwin ? emitIR(src) : emitIRAsan(src));
      const built = spawnSync("clang", [
        "-O1", "-g", ...(onDarwin ? [] : ["-fsanitize=address"]),
        ll, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
      ], { encoding: "utf8" });
      expect(built.status).toBe(0);
      if (!onDarwin) {
        const run = spawnSync(bin, [], {
          encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
          env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1" },
        });
        expect(run.status).toBe(0);
        // LSan prints one `… leak of N byte(s) in K object(s)` per stack; sum the object
        // counts, so the number is comparable between the two scales.
        let leaks = 0;
        for (const m of run.stderr.matchAll(/in (\d+) object\(s\)/g)) leaks += Number(m[1]);
        return { leaks, stdout: run.stdout };
      }
      const run = spawnSync("leaks", ["--atExit", "--", bin], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        env: { ...process.env, MallocStackLogging: "1" },
      });
      // `leaks` exits 1 when it finds leaks and 0 when it does not; both are readings,
      // so the exit code is not asserted — the COUNT it reports is.
      const m = /Process \d+: (\d+) leaks? for/.exec(run.stdout);
      if (!m) throw new Error(`could not read a leak count from \`leaks\`:\n${run.stdout}\n${run.stderr}`);
      // `leaks --atExit` prefixes the child's own stdout; the program prints one line.
      const line = /^\d+$/m.exec(run.stdout);
      return { leaks: Number(m[1]), stdout: line ? `${line[0]}\n` : run.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("the residue does not grow with the number of URI calls", () => {
    const small = leakedBlocks(uriLoop(200));
    const big = leakedBlocks(uriLoop(2000));
    expect(small.stdout).toBe("7600\n");
    expect(big.stdout).toBe("76000\n");
    // 10x the work, the same residue. Before the fix this was 800 vs 8000.
    expect({ leaks: big.leaks }).toEqual({ leaks: small.leaks });
  }, 300_000);

  test("the control leaves the same residue as the URI loop (attribution)", () => {
    const control = leakedBlocks(controlLoop(2000));
    const uri = leakedBlocks(uriLoop(2000));
    expect(control.stdout).toBe("114000\n");
    // The surrounding shape — a counted loop, a string local, a try/catch — accounts for
    // the whole residue; the URI calls add none of their own.
    expect({ leaks: uri.leaks }).toEqual({ leaks: control.leaks });
  }, 300_000);
});
