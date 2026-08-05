/*
 * examples/chat.ts — CLI LLM chat app, tested DETERMINISTICALLY against a local
 * mock Anthropic Messages API (no real API key, no network, no secrets).
 *
 * The mock server asserts the request shape (path, x-api-key header, JSON body)
 * and returns an Anthropic-shaped `{content:[{type,text}]}` envelope. The compiled
 * chat binary is fed user turns on stdin and pointed at the mock via `--url`; we
 * assert it prints the extracted assistant text for each turn.
 *
 * As with http.test.ts, the binary is run with async `spawn` (never spawnSync) so
 * the in-process mock server's event loop isn't blocked — that would deadlock the
 * request.
 */

import { test as _test, expect, afterEach } from "bun:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";

// The chat app links nt_http.c (libcurl). Skip where libcurl dev headers are absent
// rather than hard-failing the suite (see test/http.test.ts / docs/divergences.md).
const HAS_LIBCURL = spawnSync("clang", ["-fsyntax-only", "-x", "c", "-"], { input: "#include <curl/curl.h>\n" }).status === 0;
const test = HAS_LIBCURL ? _test : _test.skip;
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildBinary } from "../src/driver.ts";

const CHAT_SRC = readFileSync(join(import.meta.dir, "..", "examples", "chat.ts"), "utf8");

let servers: Server[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

interface SeenRequest { path: string; apiKey: string; version: string; body: string }

/** Anthropic-shaped mock: echoes the user's content back as the assistant text. */
function startMock(seen: SeenRequest[]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw) as { messages: { content: string }[] };
        const userText = parsed.messages[0].content;
        seen.push({
          path: req.url ?? "",
          apiKey: (req.headers["x-api-key"] as string) ?? "",
          version: (req.headers["anthropic-version"] as string) ?? "",
          body: raw,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: "echo: " + userText }] }));
      });
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/** Build examples/chat.ts once and run it with the given argv + stdin. */
async function runChat(args: string[], stdin: string): Promise<{ stdout: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "nativets-chat-"));
  tmpDirs.push(dir);
  const bin = join(dir, "chat");
  await buildBinary(CHAT_SRC, bin, { target: "host" });
  return await new Promise((resolve) => {
    const p = spawn(bin, args, {} as never);
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => resolve({ stdout, exitCode: code ?? -1 }));
    p.stdin.write(stdin);
    p.stdin.end();
  });
}

test("chat: one user turn → prints extracted assistant text; sends correct request", async () => {
  const seen: SeenRequest[] = [];
  const port = await startMock(seen);
  const url = `http://127.0.0.1:${port}/v1/messages`;

  const res = await runChat(["--key", "sk-test-123", "--url", url], "Hello there\n");
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe("assistant: echo: Hello there\n");

  // The request carried the API contract the chat app is supposed to send.
  expect(seen.length).toBe(1);
  expect(seen[0]!.path).toBe("/v1/messages");
  expect(seen[0]!.apiKey).toBe("sk-test-123");
  expect(seen[0]!.version).toBe("2023-06-01");
  const body = JSON.parse(seen[0]!.body);
  expect(body.model).toBe("claude-sonnet-5");
  expect(body.max_tokens).toBe(1024);
  expect(body.messages[0]).toEqual({ role: "user", content: "Hello there" });
});

test("chat: multiple turns, then EOF ends the loop", async () => {
  const seen: SeenRequest[] = [];
  const port = await startMock(seen);
  const url = `http://127.0.0.1:${port}/v1/messages`;

  const res = await runChat(["--key", "k", "--url", url], "first\nsecond\n");
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe("assistant: echo: first\nassistant: echo: second\n");
  expect(seen.length).toBe(2);
});

test("chat: /quit stops the loop before hitting the API", async () => {
  const seen: SeenRequest[] = [];
  const port = await startMock(seen);
  const url = `http://127.0.0.1:${port}/v1/messages`;

  const res = await runChat(["--key", "k", "--url", url], "hi\n/quit\nnever\n");
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe("assistant: echo: hi\n");
  expect(seen.length).toBe(1); // "never" is past /quit, so never sent
});

test("chat: missing --key prints usage and exits without a request", async () => {
  const seen: SeenRequest[] = [];
  await startMock(seen);
  const res = await runChat([], "");
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain("usage:");
  expect(seen.length).toBe(0);
});

test("chat: non-200 response surfaces the status + raw body", async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad key" }));
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
  const url = `http://127.0.0.1:${port}/v1/messages`;
  const res = await runChat(["--key", "wrong", "--url", url], "hello\n");
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe(`error 401: {"error":"bad key"}\n`);
});
