// Every character-scanning helper the regex-removal lane put into `src/`, compiled by
// nativets and differentially tested against node.
//
// WHY THIS FIXTURE EXISTS. `test/self-host-coverage.test.ts` and `test/bootstrap.test.ts`
// report each module's FIRST blocker, so a construct that sits BEHIND that blocker is
// invisible to both — a lane can clear one blocker and plant another where no gate can
// see it. This lane nearly did, twice: a `(string) => string | undefined` rename callback
// (nativets rejects the call site) and an `out.push(tok)` (NT1606, arrays are immutable).
// Neither was caught by any test. Both were caught by compiling the helper WITH nativets.
//
// So the helpers live here as a fixture: they must keep compiling, and keep agreeing with
// node, forever. If a future edit reaches for a generic, a general union, `readonly`,
// `var`, `satisfies` or a template-literal type, this fails immediately instead of
// silently moving the self-hosting frontier backwards.

// --- lexer.ts / coverage-preprocess.ts / ast.ts / modules.ts: identifier classes ---
function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}
function isIdentifier(s: string): boolean {
  if (s.length === 0 || !isIdentStart(s[0]!)) return false;
  for (let i = 1; i < s.length; i++) if (!isIdentPart(s[i]!)) return false;
  return true;
}
function isHexDigit(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}
function isNumChar(c: string): boolean {
  return isHexDigit(c) || c === "x" || c === "X" ||
    c === "." || c === "_" || c === "+" || c === "-";
}
// driver.ts: regex `\w` — note it does NOT include `$`.
function isWordChar(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
}
// ECMAScript `\s`: WhiteSpace + LineTerminator, by code unit.
function isSpace(c: string): boolean {
  const n = c.charCodeAt(0);
  if (n === 9 || n === 10 || n === 11 || n === 12 || n === 13 || n === 32) return true;
  return (
    n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) ||
    n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f ||
    n === 0x3000 || n === 0xfeff
  );
}

// --- diagnostics.ts: `^\s*` ---
function leadingWhitespace(s: string): number {
  let i = 0;
  while (i < s.length && isSpace(s[i]!)) i++;
  return i;
}

// --- lexer.ts / coverage-preprocess.ts: `^\s*@@([A-Za-z_$][\w$]*)\s*$` ---
function pragmaName(body: string): string {
  let a = 0;
  while (a < body.length && isSpace(body[a]!)) a++;
  if (body[a] !== "@" || body[a + 1] !== "@") return "";
  a += 2;
  if (a >= body.length || !isIdentStart(body[a]!)) return "";
  const start = a;
  a++;
  while (a < body.length && isIdentPart(body[a]!)) a++;
  const name = body.slice(start, a);
  while (a < body.length && isSpace(body[a]!)) a++;
  return a === body.length ? name : "";
}

// --- ast.ts: the two GLOBAL `#T` rewrites. A `Map` + a flag, NOT a rename callback:
// a `(string) => string | undefined` parameter type is refused at the call site. ---
const EMPTY_BINDINGS = new Map<string, string>();
function mapTypeParams(t: string, bindings: Map<string, string>, eraseUnbound: boolean): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (t[i] !== "#" || i + 1 >= t.length || !isIdentStart(t[i + 1]!)) {
      out += t[i];
      i++;
      continue;
    }
    let j = i + 1;
    while (j < t.length && isIdentPart(t[j]!)) j++;
    const bound = bindings.get(t.slice(i + 1, j));
    out += bound ?? (eraseUnbound ? "number" : t.slice(i, j));
    i = j;
  }
  return out;
}

// --- modules.ts: `([A-Za-z_$][\w$]*)\{` class-tag rename ---
function rewriteTags(t: string, tags: Map<string, string>): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (!isIdentStart(t[i]!)) { out += t[i]; i++; continue; }
    let j = i;
    while (j < t.length && isIdentPart(t[j]!)) j++;
    const name = t.slice(i, j);
    if (t[j] === "{") { out += `${tags.get(name) ?? name}{`; i = j + 1; }
    else { out += name; i = j; }
  }
  return out;
}

// --- driver.ts: `\bword\b`, the conditional-link scan, `split(/\s+/)`, the NDK name ---
function wordIndex(hay: string, word: string): number {
  for (let i = 0; i + word.length <= hay.length; i++) {
    if (!hay.startsWith(word, i)) continue;
    const beforeOk = i === 0 || !isWordChar(hay[i - 1]!);
    const end = i + word.length;
    const afterOk = end === hay.length || !isWordChar(hay[end]!);
    if (beforeOk && afterOk) return i;
  }
  return -1;
}
function hasWord(hay: string, word: string): boolean { return wordIndex(hay, word) >= 0; }

function irCallsAny(ir: string, prefixes: string[]): boolean {
  for (const line of ir.split("\n")) {
    const at = wordIndex(line, "call");
    if (at < 0) continue;
    const rest = line.slice(at + 4);
    for (const p of prefixes) if (rest.includes(p)) return true;
  }
  return false;
}

function splitWhitespace(s: string): string[] {
  // `[...out, tok]`, not `out.push(tok)` — arrays are immutable, `.push` is NT1606.
  let out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && isSpace(s[i]!)) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !isSpace(s[i]!)) i++;
    out = [...out, s.slice(start, i)];
  }
  return out;
}

function isAndroidClangName(f: string): boolean {
  const prefix = "aarch64-linux-android";
  const suffix = "-clang";
  if (!f.startsWith(prefix) || !f.endsWith(suffix)) return false;
  const api = f.slice(prefix.length, f.length - suffix.length);
  if (api.length === 0) return false;
  for (let i = 0; i < api.length; i++) if (api[i]! < "0" || api[i]! > "9") return false;
  return true;
}

// --- ownership.ts / cli.ts: the two suffix strips ---
function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;
}

// --- ast.ts: the tag-value forbidden set `[,{}<>|[\]()"\\]` ---
const TAG_FORBIDDEN = ",{}<>|[]()\"\\";
function tagValueIsEncodable(v: string): boolean {
  for (let i = 0; i < v.length; i++) if (TAG_FORBIDDEN.includes(v[i]!)) return false;
  return true;
}

console.log(isIdentStart("a"), isIdentStart("1"), isIdentStart("$"), isIdentStart("."));
console.log(isIdentPart("9"), isIdentifier("Point"), isIdentifier("1a"), isIdentifier(""));
console.log(isHexDigit("F"), isHexDigit("g"), isNumChar("x"), isNumChar("z"));
console.log(isWordChar("_"), isWordChar("$"), isSpace("\t"), isSpace("x"));

console.log(leadingWhitespace("   ab"), leadingWhitespace("ab"), leadingWhitespace(""));

console.log(pragmaName(" @@mutable "), pragmaName("see @@mutable"), pragmaName("@@ x"));
console.log(pragmaName("@@_a1"), pragmaName("@@mutable x"));

const binds = new Map<string, string>().set("T", "number").set("U", "{a:string}");
console.log(mapTypeParams("(#T)=>#U", binds, false));
console.log(mapTypeParams("#T[]", EMPTY_BINDINGS, false));
console.log(mapTypeParams("##T[]", EMPTY_BINDINGS, true));
console.log(mapTypeParams("no markers here", binds, true));

const tags = new Map<string, string>().set("Point", "_m1_Point");
console.log(rewriteTags("Point{x:number,y:Point{z:number}}", tags));
console.log(rewriteTags("{a:{b:number}}", tags));
console.log(rewriteTags("1Point{a:number}", tags));

console.log(hasWord("wasm32-wasi x", "wasm32"), hasWord("xwasm32", "wasm32"));
console.log(hasWord("_wasm32", "wasm32"), hasWord("$wasm32", "wasm32"));
console.log(irCallsAny("  %1 = call ptr @nt_arr_new()", ["@nt_arr_"]));
console.log(irCallsAny("declare ptr @nt_arr_new()", ["@nt_arr_"]));
console.log(irCallsAny("  recall @nt_arr_x", ["@nt_arr_"]));
console.log(irCallsAny("  %1 = call ptr @nt_set_add(ptr %0)", ["@nt_coll_", "@nt_map_", "@nt_set_"]));

console.log(splitWhitespace("-L/opt/lib  -lraylib").join("|"));
console.log(splitWhitespace("one").join("|"), splitWhitespace("a\tb\nc").join("|"));

console.log(isAndroidClangName("aarch64-linux-android24-clang"));
console.log(isAndroidClangName("aarch64-linux-android-clang"));
console.log(isAndroidClangName("aarch64-linux-android24-clang++"));

console.log(stripSuffix("roman.ts", ".ts"), stripSuffix("roman", ".ts"));
console.log(stripSuffix("set$inner", "$inner"), stripSuffix("set", "$inner"));

console.log(tagValueIsEncodable("ok"), tagValueIsEncodable("a,b"), tagValueIsEncodable("a{b"));
