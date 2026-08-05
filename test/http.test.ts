/*
 * HTTP client primitive (networking tier, L-d) — deterministic tests.
 *
 * We NEVER hit the real internet here. Each test spins up a LOCAL node
 * http.createServer that returns a canned body, compiles a nativets program
 * that httpPost/httpGets to http://127.0.0.1:<port>/..., and asserts the
 * round-trip (status code + response body). This proves the libcurl-backed
 * primitive with zero network flakiness or secrets.
 *
 * NOTE: the compiled binary is run with the ASYNC `spawn` (not the harness's
 * `spawnSync`) on purpose — the mock server lives in THIS same bun process, so
 * a synchronous wait would block the event loop and deadlock the request. Async
 * spawn keeps the loop free to service the in-process server.
 */

import { test, expect, afterEach } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

/** Compile `source` to a host binary and run it with async spawn (loop stays free). */
async function buildAndRun(source: string): Promise<{ stdout: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "nativets-http-"));
  tmpDirs.push(dir);
  const bin = join(dir, "prog");
  await buildBinary(source, bin, { target: "host" });
  return await new Promise((resolve) => {
    const p = spawn(bin, [], { encoding: "utf8" } as never);
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => resolve({ stdout, exitCode: code ?? -1 }));
  });
}

test("httpPost round-trips status + response body against a local mock server", async () => {
  // Mock server echoes the request body inside a canned JSON envelope, status 200.
  const port = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: body }));
    });
  });

  const src = `
const r = httpPost("http://127.0.0.1:${port}/echo", "content-type: application/json", "{\\"hi\\":1}");
console.log(r.status);
console.log(r.body);
`;
  const res = await buildAndRun(src);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe(`200\n{"ok":true,"echo":"{\\"hi\\":1}"}\n`);
});

test("httpPost sends request headers to the server", async () => {
  const port = await startServer((req, res) => {
    const key = req.headers["x-api-key"] ?? "MISSING";
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ sawKey: key }));
  });

  const src = `
const r = httpPost("http://127.0.0.1:${port}/", "x-api-key: sekret\\ncontent-type: application/json", "{}");
console.log(r.status);
console.log(r.body);
`;
  const res = await buildAndRun(src);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe(`201\n{"sawKey":"sekret"}\n`);
});

test("httpGet round-trips status + body", async () => {
  const port = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });

  const src = `
const r = httpGet("http://127.0.0.1:${port}/ping", "");
console.log(r.status);
console.log(r.body);
`;
  const res = await buildAndRun(src);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe(`200\n{"path":"/ping"}\n`);
});

test("httpPost response parses with JSON.parse and narrows via `as`", async () => {
  // Anthropic-shaped body → prove the exact chat.ts extraction path works.
  const port = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "hello from mock" }] }));
  });

  const src = `
const r = httpPost("http://127.0.0.1:${port}/v1/messages", "content-type: application/json", "{}");
const parsed = JSON.parse(r.body) as { content: { type: string, text: string }[] };
console.log(parsed.content[0].text);
`;
  const res = await buildAndRun(src);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe("hello from mock\n");
});
