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

import { expectMatchesNode, compileAndRun, compileAndRunIO, runWithNodeIO } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

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
    name: "freeze returns the SAME object; isFrozen is true; the value is unchanged",
    code: `
const o = { a: 1, b: 2 };
const f = Object.freeze(o);
console.log(f.a, f.b);
console.log(Object.isFrozen(f));
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
