// examples/fetch-json.ts — fetch a JSON document, VALIDATE its shape, print a summary.
//
// The end-to-end networking demo: ordinary web-standard `fetch` + `await`, the response
// headers, a non-2xx guard, `await res.json()` narrowed with `as Repo` (which compiles
// to a generated runtime validator — io-ts/zod semantics), and a catch for a connection
// failure. This exact source also runs under plain `node`, which is the oracle for the
// deterministic mock-server test (see test/fetch.test.ts).
//
// Run it against anything that serves JSON of this shape:
//   nativets run examples/fetch-json.ts -- --url http://127.0.0.1:8080/repo
//
// NOTE (platform): `fetch` is HOST-ONLY (macOS/Linux, libcurl). iOS/Android need a
// native HTTP stack (NSURLSession/OkHttp) — see docs/divergences.md.
// NOTE (concurrency): `await` never yields — every request BLOCKS. Overlapping /
// parallel requests are rejected (NT1020); use actors (spawn/send/receive) for those.

interface Repo {
  name: string;
  stars: number;
  topics: string[];
}

function argAfter(args: string[], flag: string): string {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) return args[i + 1];
  }
  return "";
}

async function main() {
  const url = argAfter(process.argv, "--url");
  if (url === "") {
    console.log("usage: nativets run examples/fetch-json.ts -- --url <json endpoint>");
  } else {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      console.log("status: " + res.status);
      console.log("content-type: " + (res.headers.get("content-type") ?? "unknown"));
      if (!res.ok) {
        console.log("request failed with status " + res.status);
      } else {
        const repo = (await res.json()) as Repo;
        console.log("name:   " + repo.name);
        console.log("stars:  " + repo.stars);
        console.log("topics: " + repo.topics.join(", "));
      }
    } catch (e) {
      console.log("fetch failed");
    }
  }
}

main();
