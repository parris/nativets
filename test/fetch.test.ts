/*
 * `fetch` — the web-standard HTTP client, differential vs node.
 *
 * We NEVER hit the real internet. Each test spins up a LOCAL node
 * http.createServer, then runs the SAME `.ts` source twice — once under `node`
 * (the oracle: node 18+ ships global `fetch`/`Response`/`Headers`) and once as a
 * compiled nativets binary — and asserts identical stdout + exit code. That is the
 * whole point of the async decision (see docs/divergences.md): `await` is an
 * identity pass-through over a *blocking* fetch, so ordinary idiomatic source
 *
 *     const res = await fetch(url);
 *     const body = await res.text();
 *
 * compiles here AND runs unchanged under node.
 *
 * NOTE: BOTH the compiled binary and the node oracle are run with the ASYNC
 * `spawn` (never `spawnSync`) — the mock server lives in THIS same bun process, so
 * a synchronous wait would block the event loop and deadlock the request. Async
 * spawn keeps the loop free to service the in-process server. (Same note as
 * test/http.test.ts, which this file mirrors.)
 */

import { test as _test, describe, expect, afterEach } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";

// The fetch runtime lives in nt_http.c, which #includes <curl/curl.h>, so these
// tests need libcurl's dev headers. Where absent (a dev box / CI without
// libcurl-dev) SKIP rather than hard-fail the whole suite — networking is an
// optional host feature (see docs/divergences.md).
const HAS_LIBCURL = spawnSync("clang", ["-fsyntax-only", "-x", "c", "-"], { input: "#include <curl/curl.h>\n" }).status === 0;
const test = HAS_LIBCURL ? _test : _test.skip;

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary, sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

let servers: Server[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Start a local http server with the given handler; resolve with its port. */
function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "nativets-fetch-"));
  tmpDirs.push(dir);
  return dir;
}

interface RunResult { stdout: string; exitCode: number; }

/** Run a command with the ASYNC spawn so the in-process mock server keeps serving. */
function runAsync(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { encoding: "utf8" } as never);
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", () => {});
    p.on("close", (code) => resolve({ stdout, exitCode: code ?? -1 }));
  });
}

/** The ORACLE: run the same source under node (which has global fetch). */
async function runNode(source: string): Promise<RunResult> {
  const file = join(scratch(), "case.ts");
  writeFileSync(file, source);
  return await runAsync("node", [file]);
}

/** Compile `source` to a host binary and run it. */
async function buildAndRun(source: string): Promise<RunResult> {
  const bin = join(scratch(), "prog");
  await buildBinary(source, bin, { target: "host" });
  return await runAsync(bin, []);
}

/** Differential: nativets output must equal node's, byte for byte. */
async function expectMatchesNode(source: string): Promise<string> {
  const oracle = await runNode(source);
  const ours = await buildAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

// ---------------------------------------------------------------------------
// 1. `await fetch(url)` → Response with `.status` / `.ok`; `await res.text()`.
// ---------------------------------------------------------------------------
test("await fetch(url): status, ok, and await res.text() (matches node)", async () => {
  const port = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from mock");
  });

  const src = `
async function main() {
  const res = await fetch("http://127.0.0.1:${port}/hi");
  console.log(res.status);
  console.log(res.ok);
  const body = await res.text();
  console.log(body);
}
main();
`;
  expect(await expectMatchesNode(src)).toBe("200\ntrue\nhello from mock\n");
});

// ---------------------------------------------------------------------------
// 2. `await res.json()` → the Stage-20 `Dyn`, narrowed with `dyn as T` (the
//    killer combination: fetch + generated runtime validation).
// ---------------------------------------------------------------------------
test("await res.json() narrows with `as T` (matches node)", async () => {
  const port = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "ada", age: 36, tags: ["math", "code"] }));
  });

  const src = `
async function main() {
  const res = await fetch("http://127.0.0.1:${port}/user");
  const user = (await res.json()) as { name: string, age: number, tags: string[] };
  console.log(user.name);
  console.log(user.age);
  console.log(user.tags[1]);
}
main();
`;
  expect(await expectMatchesNode(src)).toBe("ada\n36\ncode\n");
});

// ---------------------------------------------------------------------------
// 3. `fetch(url, { method, headers, body })` — POST a JSON body with custom headers.
// ---------------------------------------------------------------------------
test("fetch POST sends method, headers and body (matches node)", async () => {
  const port = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        method: req.method,
        key: req.headers["x-api-key"] ?? "MISSING",
        type: req.headers["content-type"] ?? "MISSING",
        echo: body,
      }));
    });
  });

  const src = `
async function main() {
  const res = await fetch("http://127.0.0.1:${port}/echo", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sekret" },
    body: "{\\"hi\\":1}",
  });
  console.log(res.status);
  console.log(res.ok);
  const seen = (await res.json()) as { method: string, key: string, type: string, echo: string };
  console.log(seen.method);
  console.log(seen.key);
  console.log(seen.type);
  console.log(seen.echo);
}
main();
`;
  expect(await expectMatchesNode(src)).toBe(
    `201\ntrue\nPOST\nsekret\napplication/json\n{"hi":1}\n`,
  );
});

// ---------------------------------------------------------------------------
// 4. Response headers — `res.headers.get(name)` is case-insensitive (per spec) and
//    returns `string | null`, so `??` composes; `.has(name)` is the boolean form.
// ---------------------------------------------------------------------------
test("res.headers.get is case-insensitive and null on a miss (matches node)", async () => {
  const port = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "abc-123" });
    res.end("{}");
  });

  const src = `
async function main() {
  const res = await fetch("http://127.0.0.1:${port}/h");
  console.log(res.headers.get("content-type"));
  console.log(res.headers.get("Content-Type"));
  console.log(res.headers.get("X-REQUEST-ID"));
  console.log(res.headers.get("x-missing"));
  console.log(res.headers.get("x-missing") ?? "none");
  console.log(res.headers.has("x-request-id"));
  console.log(res.headers.has("x-missing"));
}
main();
`;
  expect(await expectMatchesNode(src)).toBe(
    "application/json\napplication/json\nabc-123\nnull\nnone\ntrue\nfalse\n",
  );
});

// ---------------------------------------------------------------------------
// 5a. Non-2xx: a 404 is a normal Response (`ok === false`), NOT a throw — exactly
//     like node. The body is still readable.
// ---------------------------------------------------------------------------
test("non-2xx: res.ok is false, status + body still readable (matches node)", async () => {
  const port = await startServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no such thing");
  });

  const src = `
async function main() {
  const res = await fetch("http://127.0.0.1:${port}/missing");
  console.log(res.status);
  console.log(res.ok);
  if (!res.ok) {
    console.log("request failed: " + res.status);
  }
  console.log(await res.text());
}
main();
`;
  expect(await expectMatchesNode(src)).toBe("404\nfalse\nrequest failed: 404\nno such thing\n");
});

// ---------------------------------------------------------------------------
// 5b. A connection failure is a CATCHABLE throw (the Stage-20 pending-exception
//     protocol), mirroring node's fetch rejecting. Port 1 has nothing listening.
// ---------------------------------------------------------------------------
test("connection failure throws and is catchable (matches node)", async () => {
  const src = `
async function main() {
  try {
    const res = await fetch("http://127.0.0.1:1/nope");
    console.log("unreachable " + res.status);
  } catch (e) {
    console.log("fetch failed");
  }
  console.log("still running");
}
main();
`;
  expect(await expectMatchesNode(src)).toBe("fetch failed\nstill running\n");
});

// ---------------------------------------------------------------------------
// 6. `async function` declarations (incl. a `Promise<T>` return annotation), async
//    arrows, and `await` on a NON-promise value — all identity pass-throughs.
// ---------------------------------------------------------------------------
test("async functions/arrows and await of a plain value (matches node)", async () => {
  const port = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  const src = `
async function double(n: number): Promise<number> {
  return n * 2;
}
async function main() {
  console.log(await double(21));
  console.log(await 5);
  const shout = async (s: string) => { return s + "!"; };
  console.log(await shout("hi"));
  const res = await fetch("http://127.0.0.1:${port}/");
  const body = await res.text();
  console.log(body.toUpperCase());
}
main();
`;
  expect(await expectMatchesNode(src)).toBe("42\n5\nhi!\nOK\n");
});

// ---------------------------------------------------------------------------
// The example app, end-to-end against the local mock (fetch → headers → validate →
// summary), plus its non-2xx and connection-failure paths. Same source under node.
// ---------------------------------------------------------------------------
describe("examples/fetch-json.ts", () => {
  const SRC = readFileSync(join(import.meta.dir, "..", "examples", "fetch-json.ts"), "utf8");

  /** Run the example with `--url <mock>` under both node and the compiled binary. */
  async function runBoth(port: number, path: string): Promise<string> {
    const file = join(scratch(), "fetch-json.ts");
    writeFileSync(file, SRC);
    const url = `http://127.0.0.1:${port}${path}`;
    const oracle = await runAsync("node", [file, "--url", url]);
    const bin = join(scratch(), "fetch-json");
    await buildBinary(SRC, bin, { target: "host" });
    const ours = await runAsync(bin, ["--url", url]);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    return ours.stdout;
  }

  const repoServer = () =>
    startServer((req, res) => {
      if (req.url === "/repo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "nativets", stars: 1234, topics: ["typescript", "llvm", "compiler"] }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
      }
    });

  test("fetches, validates and summarizes the JSON (matches node)", async () => {
    const out = await runBoth(await repoServer(), "/repo");
    expect(out).toBe(
      "status: 200\ncontent-type: application/json\nname:   nativets\nstars:  1234\ntopics: typescript, llvm, compiler\n",
    );
  });

  test("reports a non-2xx without throwing (matches node)", async () => {
    const out = await runBoth(await repoServer(), "/nope");
    expect(out).toBe("status: 404\ncontent-type: application/json\nrequest failed with status 404\n");
  });

  test("catches a connection failure (matches node)", async () => {
    expect(await runBoth(1, "/repo")).toBe("fetch failed\n");
  });
});

// ---------------------------------------------------------------------------
// The async DECISION, enforced: there is no concurrency, so every construct whose
// meaning depends on real promises is REJECTED (NT1020) instead of being silently
// serialized-but-claimed-parallel. See docs/divergences.md.
// ---------------------------------------------------------------------------
describe("no concurrency: promise plumbing is rejected (NT1020)", () => {
  const rejects = (source: string) => {
    let code: string | null = null;
    try { sourceToIR(source); } catch (err) { code = err instanceof NTError ? err.diag.code : `unexpected: ${err}`; }
    expect(code).toBe("NT1020");
  };

  _test("Promise.all", () => rejects(`
async function one(): Promise<number> { return 1; }
async function main() { const xs = await Promise.all([one(), one()]); console.log(xs[0]); }
main();
`));

  _test("new Promise(...)", () => rejects(`
const p = new Promise((resolve: number) => { return 1; });
console.log(1);
`));

  _test("fetch(...).then(...)", () => rejects(`
function go() { fetch("http://127.0.0.1:1/").then((r: Response) => { console.log(r.status); }); }
go();
`));

  _test("un-awaited async call whose value is used", () => rejects(`
async function one(): Promise<number> { return 1; }
async function main() { const p = one(); console.log(1); }
main();
`));

  _test("fire-and-forget async call with code after it", () => rejects(`
async function one(): Promise<number> { return 1; }
one();
console.log("after");
`));

  // An async ARROW is the same promise, so it gets the same guard: the guard tracks
  // NAMES, and an arrow binds its name through a `const`, not a `function` keyword.
  _test("un-awaited async ARROW whose value is used", () => rejects(`
const one = async (): Promise<number> => 1;
console.log(one());
`));

  // Re-binding an async function to a new name does not make it not-async. The guard
  // follows a DIRECT alias chain (`const b = a`), which is what `const { x } = …`-free
  // straight-line code actually looks like. See the boundary note in parseDeclarator.
  _test("un-awaited call through an alias of an async arrow", () => rejects(`
const one = async (): Promise<number> => 1;
const two = one;
console.log(two());
`));

  // An immediately-invoked async arrow never gets a name at all, so the name-based
  // guard would miss it — it is caught on the callee NODE instead.
  _test("un-awaited immediately-invoked async arrow", () => rejects(`
console.log((async (): Promise<number> => 1)());
`));

  // HIGHER-ORDER async. An async function passed AS A VALUE is still promise-returning
  // when it is finally called — test262 pins that the promise comes from the function,
  // not the call site (test/language/expressions/async-arrow-function/
  // returns-async-arrow-returns-newtarget.js and .../statements/async-function/
  // evaluation-body-that-returns.js both call the function through a binding and assert
  // the RESULT is a promise). The name-based guard cannot follow a value across a call
  // boundary, so the declared TYPE carries it: a parameter annotated
  // `(…) => Promise<T>` is exactly as promise-returning as an `async function`.
  _test("un-awaited call through a `() => Promise<T>` PARAMETER", () => rejects(`
const one = async (): Promise<number> => 1;
function callit(f: () => Promise<number>): number { return f(); }
console.log(callit(one));
`));

  // An ARROW's parameter list is parsed by a different routine, and a higher-order
  // callback is far more often an arrow than a `function` — so it gets the same rule.
  _test("un-awaited call through a `() => Promise<T>` parameter of an ARROW", () => rejects(`
const one = async (): Promise<number> => 1;
const callit = (f: () => Promise<number>): number => f();
console.log(callit(one));
`));
});
