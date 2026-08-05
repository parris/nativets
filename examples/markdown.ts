// markdown.ts — a tiny Markdown → HTML converter for nativets.
//
// Reads Markdown from stdin (or falls back to a hardcoded demo document when
// stdin is empty) and prints HTML. It supports a small, well-defined subset:
//
//   - `# `, `## `, `### ` ATX headings                → <h1>/<h2>/<h3>
//   - `- ` bullet lists (runs of adjacent items)      → <ul><li>…</li></ul>
//   - blank-line-separated paragraphs                 → <p>…</p>
//   - inline **bold** / *italic* / `code`             → <strong>/<em>/<code>
//   - HTML-special chars (& < >) are escaped everywhere.
//
// Because node runs THIS SAME .ts file as the differential oracle, the exact
// subset defined here *is* the specification — there is no external Markdown
// library to match. The output is fully deterministic.
//
// Written in the current immutable nativets subset (like wc.ts / grep.ts /
// calculator.ts): no `.push`, no `arr[i] = v`, no classes. State lives in plain
// string/boolean locals accumulated in a top-level loop, and inline formatting
// is a pure recursive `inline()` over string slices.
//
// Language-subset workarounds (see the report): the runtime's `String#indexOf`
// takes no `fromIndex`, and there is no `startsWith`, so we scan by slicing the
// remaining substring (`s.slice(i).indexOf(needle)`) and detect block prefixes
// with `line.slice(0, n) === "…"`.

// ---------------------------------------------------------------------------
// HTML escaping — no `String#replace`, so escape one character at a time.
// ---------------------------------------------------------------------------

function escapeChar(c: string): string {
  if (c === "&") return "&amp;";
  if (c === "<") return "&lt;";
  if (c === ">") return "&gt;";
  return c;
}

function escapeHtml(s: string): string {
  let out: string = "";
  let i: number = 0;
  while (i < s.length) {
    out = out + escapeChar(s.charAt(i));
    i = i + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline formatting: `code`, **bold**, *italic*. A left-to-right scan; when a
// delimiter opens we look for its closer in the REMAINING substring (indexOf has
// no fromIndex). Bold/italic bodies are formatted recursively; code bodies are
// literal (only escaped). An unclosed delimiter is emitted as a literal char.
// ---------------------------------------------------------------------------

function inline(s: string): string {
  let out: string = "";
  let i: number = 0;
  while (i < s.length) {
    const c: string = s.charAt(i);
    if (c === "`") {
      const rest: string = s.slice(i + 1);
      const close: number = rest.indexOf("`");
      if (close >= 0) {
        out = out + "<code>" + escapeHtml(rest.slice(0, close)) + "</code>";
        i = i + close + 2;
      } else {
        out = out + escapeChar(c);
        i = i + 1;
      }
    } else if (c === "*" && i + 1 < s.length && s.charAt(i + 1) === "*") {
      const rest: string = s.slice(i + 2);
      const close: number = rest.indexOf("**");
      if (close >= 0) {
        out = out + "<strong>" + inline(rest.slice(0, close)) + "</strong>";
        i = i + close + 4;
      } else {
        out = out + escapeChar(c);
        i = i + 1;
      }
    } else if (c === "*") {
      const rest: string = s.slice(i + 1);
      const close: number = rest.indexOf("*");
      if (close >= 0) {
        out = out + "<em>" + inline(rest.slice(0, close)) + "</em>";
        i = i + close + 2;
      } else {
        out = out + escapeChar(c);
        i = i + 1;
      }
    } else {
      out = out + escapeChar(c);
      i = i + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block-level conversion. A top-level state machine over the input lines:
//   - `paraBuf` accumulates the current paragraph (wrapped lines join with " ").
//   - `inList` tracks whether a <ul> is currently open.
// Headings, blank lines, and bullets flush any open paragraph/list first, so the
// block structure is unambiguous and deterministic.
// ---------------------------------------------------------------------------

const DEMO: string =
  "# nativets Markdown\n" +
  "\n" +
  "A **tiny** converter written in *plain* TypeScript.\n" +
  "It runs under `node` and compiles to a native binary.\n" +
  "\n" +
  "## Features\n" +
  "\n" +
  "- `#`/`##`/`###` headings\n" +
  "- **bold**, *italic*, and `code`\n" +
  "- bullet lists & paragraphs\n" +
  "\n" +
  "### Notes\n" +
  "\n" +
  "Escaping works: 1 < 2 && a > b.\n";

const raw: string = readStdin();
const input: string = raw.length > 0 ? raw : DEMO;

const lines: string[] = input.split("\n");

let paraBuf: string = "";
let inList: boolean = false;

for (const line of lines) {
  const h3: boolean = line.slice(0, 4) === "### ";
  const h2: boolean = line.slice(0, 3) === "## ";
  const h1: boolean = line.slice(0, 2) === "# ";
  const bullet: boolean = line.slice(0, 2) === "- ";
  const blank: boolean = line === "";

  if (blank) {
    // Blank line: end the current paragraph and/or list.
    if (paraBuf.length > 0) {
      console.log("<p>" + paraBuf + "</p>");
      paraBuf = "";
    }
    if (inList) {
      console.log("</ul>");
      inList = false;
    }
  } else if (h3 || h2 || h1) {
    // Heading: flush any open block, then emit at the right level.
    if (paraBuf.length > 0) {
      console.log("<p>" + paraBuf + "</p>");
      paraBuf = "";
    }
    if (inList) {
      console.log("</ul>");
      inList = false;
    }
    if (h3) {
      console.log("<h3>" + inline(line.slice(4)) + "</h3>");
    } else if (h2) {
      console.log("<h2>" + inline(line.slice(3)) + "</h2>");
    } else {
      console.log("<h1>" + inline(line.slice(2)) + "</h1>");
    }
  } else if (bullet) {
    // Bullet item: close any open paragraph, open a <ul> if needed.
    if (paraBuf.length > 0) {
      console.log("<p>" + paraBuf + "</p>");
      paraBuf = "";
    }
    if (!inList) {
      console.log("<ul>");
      inList = true;
    }
    console.log("  <li>" + inline(line.slice(2)) + "</li>");
  } else {
    // Ordinary text: close any open list, then extend the paragraph.
    if (inList) {
      console.log("</ul>");
      inList = false;
    }
    const formatted: string = inline(line);
    if (paraBuf.length === 0) {
      paraBuf = formatted;
    } else {
      paraBuf = paraBuf + " " + formatted;
    }
  }
}

// Flush any block left open at end of input.
if (paraBuf.length > 0) {
  console.log("<p>" + paraBuf + "</p>");
}
if (inList) {
  console.log("</ul>");
}
