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

import { test as _test, expect, afterEach } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";

// The fetch runtime lives in nt_http.c, which #includes <curl/curl.h>, so these
// tests need libcurl's dev headers. Where absent (a dev box / CI without
// libcurl-dev) SKIP rather than hard-fail the whole suite — networking is an
// optional host feature (see docs/divergences.md).
const HAS_LIBCURL = spawnSync("clang", ["-fsyntax-only", "-x", "c", "-"], { input: "#include <curl/curl.h>\n" }).status === 0;
const test = HAS_LIBCURL ? _test : _test.skip;

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary } from "../src/driver.ts";

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
