// examples/chat.ts — a tiny CLI LLM chat client (examples.md §2, L-a..L-d).
//
// Reads the API key from argv, then reads user turns from stdin line-by-line
// (readLine) until EOF or "/quit". For each turn it builds an Anthropic Messages
// API request with JSON.stringify, httpPosts it (libcurl + TLS), JSON.parses the
// response, and prints the assistant's text.
//
// Manual run (real API):
//   echo "Hello, who are you?" | nativets run examples/chat.ts -- --key $ANTHROPIC_API_KEY
// or interactively (type turns, then Ctrl-D to send — stdin is read to EOF):
//   nativets run examples/chat.ts -- --key $ANTHROPIC_API_KEY
// Point at a different endpoint (used by the deterministic mock-server test):
//   nativets run examples/chat.ts -- --key test --url http://127.0.0.1:8080/v1/messages
//
// This file also runs under plain `node examples/chat.ts` given the readLine /
// httpPost polyfills (the compiler is the oracle for the real thing).
//
// Anthropic Messages API contract:
//   POST https://api.anthropic.com/v1/messages
//   headers: x-api-key: <KEY>, anthropic-version: 2023-06-01, content-type: application/json
//   body:    {"model":"claude-sonnet-5","max_tokens":1024,"messages":[{"role":"user","content":"..."}]}
//   response:{"content":[{"type":"text","text":"..."}], ...}  → print content[0].text

function argAfter(args: string[], flag: string): string {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) return args[i + 1];
  }
  return "";
}

const args = process.argv;
const key = argAfter(args, "--key");
const urlArg = argAfter(args, "--url");
const url = urlArg === "" ? "https://api.anthropic.com/v1/messages" : urlArg;

if (key === "") {
  console.log("usage: nativets run examples/chat.ts -- --key <ANTHROPIC_API_KEY> [--url <endpoint>]");
} else {
  const headers = "x-api-key: " + key + "\nanthropic-version: 2023-06-01\ncontent-type: application/json";
  let running = true;
  while (running) {
    const userText = readLine();
    if (userText === "" || userText === "/quit") {
      running = false;
    } else {
      // Single-turn requests (no history accumulation) — fine for v1.
      const body = JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: userText }],
      });
      const resp = httpPost(url, headers, body);
      if (resp.status === 200) {
        const parsed = JSON.parse(resp.body) as { content: { type: string, text: string }[] };
        console.log("assistant: " + parsed.content[0].text);
      } else {
        console.log("error " + resp.status + ": " + resp.body);
      }
    }
  }
}
