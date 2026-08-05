// csv.ts — a tiny CSV parser + query tool for nativets (Host I/O tier).
//
// Reads a CSV table from stdin (or falls back to a hardcoded default table when
// stdin is empty) and prints, deterministically:
//
//   columns: <header fields joined by " | ">
//   rows: <number of data rows>
//
//   [column <first-column name>]      -- a projection: the first column of every row
//   <value> ...
//
//   [summary of <last-column name>]   -- a numeric summary of the LAST column
//   count / sum / avg / min / max
//
//   [rows with <last-column name> >= avg]   -- a filter: the above-average rows,
//   <row fields joined by " | "> ...          each shown as its parsed fields
//
// It compiles + runs identically under `node` (via the harness stdin polyfill)
// and nativets, and cross-compiles to macOS / Linux / iOS / Android unchanged.
//
// CSV subset (documented divergence from full RFC-4180): fields may be quoted
// with double quotes and quoted fields may contain COMMAS and ESCAPED QUOTES
// ("" -> a literal "). Quoted fields may NOT span multiple lines — the table is
// split into records on '\n' first, then each line is field-parsed. Blank lines
// are skipped. This is enough to demonstrate real quote-aware parsing while
// staying line-oriented.
//
// Written in the current immutable subset: no `.push` / `arr[i] = v`. Arrays are
// grown functionally with spread (`[...a, x]`); strings with `+=`. State is kept
// in three parallel 1-D arrays (no nested arrays), so growth stays simple.

// A hardcoded default table, used only when stdin is empty. It intentionally
// includes quoted fields with embedded commas ("New York, NY") to exercise the
// quote-aware field parser.
const DEFAULT_CSV: string =
  "id,name,city,score\n" +
  "1,Alice,\"New York, NY\",90\n" +
  "2,Bob,Boston,75\n" +
  "3,Carol,\"Los Angeles, CA\",82\n" +
  "4,Dave,Boston,60\n";

// Parse ONE CSV line into its fields, honoring double-quoted fields (which may
// contain commas) and the "" escape for a literal quote inside a quoted field.
function parseLine(line: string): string[] {
  let fields: string[] = [];
  let cur: string = "";
  let inQuotes: boolean = false;
  let i: number = 0;
  while (i < line.length) {
    const c: string = line.charAt(i);
    if (inQuotes) {
      if (c === "\"") {
        if (i + 1 < line.length && line.charAt(i + 1) === "\"") {
          cur += "\"";      // "" -> a single literal quote
          i = i + 2;
        } else {
          inQuotes = false; // closing quote
          i = i + 1;
        }
      } else {
        cur += c;
        i = i + 1;
      }
    } else {
      if (c === "\"") {
        inQuotes = true;    // opening quote
        i = i + 1;
      } else if (c === ",") {
        fields = [...fields, cur];
        cur = "";
        i = i + 1;
      } else {
        cur += c;
        i = i + 1;
      }
    }
  }
  fields = [...fields, cur];
  return fields;
}

// --- Read the table (stdin, or the default when stdin is empty). ---
let input: string = readStdin();
if (input.trim().length === 0) {
  input = DEFAULT_CSV;
}

const lines: string[] = input.split("\n");

// First non-blank line is the header; the rest are data rows. We keep three
// parallel 1-D arrays instead of an array-of-arrays: the first-column value, a
// human-readable " | "-joined display of the whole row, and the numeric value of
// the last column (for the summary + filter).
let header: string = "";
let haveHeader: boolean = false;
let firstCols: string[] = [];
let displays: string[] = [];
let scores: number[] = [];

for (const line of lines) {
  if (line.trim().length === 0) {
    continue; // skip blank lines (e.g. a trailing newline)
  }
  if (!haveHeader) {
    header = line;
    haveHeader = true;
    continue;
  }
  const fields: string[] = parseLine(line);
  firstCols = [...firstCols, fields[0]];
  displays = [...displays, fields.join(" | ")];
  scores = [...scores, Number(fields[fields.length - 1])];
}

const headerFields: string[] = parseLine(header);
const col0Name: string = headerFields.length > 0 ? headerFields[0] : "";
const lastName: string =
  headerFields.length > 0 ? headerFields[headerFields.length - 1] : "";

const count: number = scores.length;

// Numeric summary of the last column.
let sum: number = 0;
for (const s of scores) {
  sum = sum + s;
}
let mn: number = 0;
let mx: number = 0;
if (count > 0) {
  mn = scores[0];
  mx = scores[0];
  for (let i: number = 1; i < count; i = i + 1) {
    if (scores[i] < mn) {
      mn = scores[i];
    }
    if (scores[i] > mx) {
      mx = scores[i];
    }
  }
}
const avg: number = count > 0 ? sum / count : 0;

// --- Report. ---
console.log("columns: " + headerFields.join(" | "));
console.log("rows: " + count);

console.log("");
console.log("[column " + col0Name + "]");
for (const c of firstCols) {
  console.log(c);
}

console.log("");
console.log("[summary of " + lastName + "]");
console.log("count: " + count);
console.log("sum: " + sum);
console.log("avg: " + avg);
console.log("min: " + mn);
console.log("max: " + mx);

console.log("");
console.log("[rows with " + lastName + " >= avg]");
for (let i: number = 0; i < count; i = i + 1) {
  if (scores[i] >= avg) {
    console.log(displays[i]);
  }
}
