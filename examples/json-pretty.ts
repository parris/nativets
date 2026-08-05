// json-pretty.ts — a JSON round-trip + pretty-printer for nativets (docs/examples.md L-c).
//
// Reads a JSON string (from the command line, or a built-in default), parses it with
// JSON.parse, and prints it back three ways — proving the parse → Dyn → narrow → stringify
// round-trip end to end:
//
//   nativets run examples/json-pretty.ts
//   nativets run examples/json-pretty.ts -- '{"name":"x","version":9,"stable":false,"tags":["a"],"limits":{"min":0,"max":1}}'
//
// It exercises the Stage-17/20 JSON surface: `JSON.parse(s)` returns a dynamic, runtime-tagged
// `Dyn`; you reach into it by field/index (`d.name`, `d.tags[0]`, `d.limits.max`) with runtime
// tag checks — scalar leaves print directly. Narrowing the whole value with `as T` validates it
// against the static shape and hands back an ordinary typed value, which `JSON.stringify` then
// re-serializes from that static type. The pretty-printer walks the known shape by hand (there is
// no `JSON.stringify(x, null, 2)` yet) — because node runs this very file too, its output matches
// node's by construction. Written in the immutable subset (no `.push` / `arr[i] = v`); keep inputs
// ASCII (string length is UTF-8 bytes here — see docs/divergences.md).

type Config = {
  name: string;
  version: number;
  stable: boolean;
  tags: string[];
  limits: { min: number; max: number };
};

const DEFAULT: string =
  '{"name":"nativets","version":2,"stable":true,"tags":["ts","llvm","native"],"limits":{"min":1,"max":80}}';

// --- Input: the whole tail of argv joined with spaces is the JSON text (else the default). ---
const args: string[] = process.argv.slice(2);
const input: string = args.length > 0 ? args.join(" ") : DEFAULT;

// 1) Parse to a dynamic, runtime-tagged Dyn.
const dyn = JSON.parse(input);

// 2) Dyn access — reach into the tagged value by field/index (runtime tag checks). These are
//    scalar leaves, so they print directly; a *compound* Dyn would need stringify/narrowing.
console.log("name:", dyn.name);
console.log("first tag:", dyn.tags[0]);
console.log("depth:", dyn.limits.max);

// 3) Narrow the whole value to a static type (validated at runtime) → an ordinary typed value.
const cfg = JSON.parse(input) as Config;

// 4) Round-trip: re-serialize the typed value compactly. For the default input this reproduces
//    the source text byte-for-byte (insertion order preserved).
console.log(JSON.stringify(cfg));

// 5) Pretty-print (2-space indent) by walking the known static shape.
function quote(s: string): string {
  return JSON.stringify(s); // reuse the string escaper so quoting matches node exactly
}

function pretty(c: Config): string {
  let tagLines: string = "";
  for (let i: number = 0; i < c.tags.length; i = i + 1) {
    const comma: string = i < c.tags.length - 1 ? "," : "";
    tagLines = tagLines + "    " + quote(c.tags[i]) + comma + "\n";
  }
  return (
    "{\n" +
    '  "name": ' + quote(c.name) + ",\n" +
    '  "version": ' + c.version + ",\n" +
    '  "stable": ' + c.stable + ",\n" +
    '  "tags": [\n' + tagLines + "  ],\n" +
    '  "limits": {\n' +
    '    "min": ' + c.limits.min + ",\n" +
    '    "max": ' + c.limits.max + "\n" +
    "  }\n" +
    "}"
  );
}

console.log(pretty(cfg));
