/*
 * Diagnostics — modeled on scriptc's banded error-code system.
 *
 * Bands:
 *   NT0xxx  parse/preflight (syntax we can't read)
 *   NT1xxx  valid TypeScript we don't compile YET (the coverage gradient)
 *   NT2xxx  our type rules (real user type errors)
 *   NT9xxx  internal compiler error
 *
 * Every rejection of *supported-but-unimplemented* TS should use an NT1xxx code
 * with a milestone + hint, so `nativets coverage` can turn "unsupported" into an
 * actionable, prioritized list instead of an opaque wall.
 */

export type Milestone = "M1" | "M2" | "M3" | "later";

/**
 * A labeled source location for a multi-span diagnostic (rustc-style). `primary` marks the
 * main caret; secondary spans add "moved here" / "borrowed here" context on other lines.
 */
export interface DiagSpan {
  line: number;
  label: string;
  primary?: boolean;
}

export interface Diagnostic {
  code: string;
  message: string;
  milestone?: Milestone;
  hint?: string;
  /** Extra labeled lines, so a diagnostic can point at several places at once. */
  spans?: DiagSpan[];
}

export class NTError extends Error {
  constructor(readonly diag: Diagnostic) {
    super(`[${diag.code}] ${diag.message}`);
    this.name = "NTError";
  }
}

/**
 * A broken COMPILER INVARIANT — deliberately not an `NT****` code.
 *
 * An NT code says "your program uses something we do not compile yet", and its hint tells
 * the reader how to write it differently. That is exactly the wrong thing to say here: an
 * `InternalError` means the frontend accepted something codegen cannot lower, so the
 * defect is OURS and there is nothing for the user to work around. Dressing one up as an
 * NT code would send someone rewriting correct code to dodge our bug.
 *
 * So these stay loud, and the stack trace is kept on purpose — it is the useful artifact
 * in a bug report. What changes is that the message says whose fault it is.
 */
export class InternalError extends Error {
  constructor(detail: string) {
    super(
      `internal compiler error: ${detail}\n` +
      `  This is a bug in nativets, not in your program: the frontend accepted something\n` +
      `  codegen cannot lower, which the checker should have refused first. Please report\n` +
      `  it with the program that triggered it. The stack trace below is part of that report.`,
    );
    this.name = "InternalError";
  }
}
/** Shorthand for the throw sites. */
export function internalError(detail: string): InternalError {
  return new InternalError(detail);
}

/**
 * How many leading whitespace characters `s` has — the `^\s*` of ECMAScript's `\s`
 * (WhiteSpace + LineTerminator), scanned by code unit. nativets deliberately has no
 * `RegExp` (docs/divergences.md), so the compiler's own source may not use one either.
 */
function leadingWhitespace(s: string): number {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    // ASCII: TAB, LF, VT, FF, CR, SPACE.
    const ascii = c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
    // The rest of `\s`: NBSP, OGHAM SPACE, EN QUAD..HAIR SPACE, LS, PS, NNBSP,
    // MMSP, IDEOGRAPHIC SPACE, BOM.
    const wide =
      c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
      c === 0x3000 || c === 0xfeff;
    if (!ascii && !wide) break;
    i++;
  }
  return i;
}

/**
 * Render a diagnostic. With the original `source`, a multi-span diagnostic prints
 * rustc-style — the message, then each labeled span with its source line and a caret
 * underline — turning "moved at line 4, used at line 7" into a scannable, pointed error.
 * Falls back to the compact single-line form when there are no spans (or no source).
 */
export function formatDiagnostic(diag: Diagnostic, source?: string): string {
  const head = `error[${diag.code}]: ${diag.message}`;
  if (!diag.spans || diag.spans.length === 0 || !source) {
    return diag.hint ? `${head}\n  = help: ${diag.hint}` : head;
  }
  const srcLines = source.split("\n");
  // Primary span(s) first, then secondaries, but keep source order within each group.
  const spans = [...diag.spans].sort(
    (a, b) => Number(!!b.primary) - Number(!!a.primary) || a.line - b.line,
  );
  const gutter = Math.max(...spans.map((s) => String(s.line).length));
  const lines = [head];
  for (const s of spans) {
    const text = srcLines[s.line - 1] ?? "";
    const num = String(s.line).padStart(gutter);
    const pad = " ".repeat(gutter);
    const trimmed = text.slice(leadingWhitespace(text));
    const indent = text.length - trimmed.length;
    const caret = (s.primary ? "^" : "-").repeat(Math.max(1, trimmed.length || 1));
    lines.push(`  ${pad} |`);
    lines.push(`  ${num} | ${text}`);
    lines.push(`  ${pad} | ${" ".repeat(indent)}${caret} ${s.label}`);
  }
  if (diag.hint) lines.push(`  ${" ".repeat(gutter)} = help: ${diag.hint}`);
  return lines.join("\n");
}

/** Catalog of "not yet implemented" features (NT1xxx). Keep messages concrete. */
export const NYI = {
  ARRAY: { code: "NT1001", milestone: "M1", hint: "arrays need the heap value model (planned next)" },
  OBJECT: { code: "NT1002", milestone: "M1", hint: "object literals need the heap value model" },
  CLOSURE: { code: "NT1003", milestone: "M2", hint: "function values / closures need captured environments" },
  EXCEPTION: { code: "NT1004", milestone: "M2", hint: "try/catch/throw need unwinding support" },
  JSON: { code: "NT1005", milestone: "M3", hint: "JSON needs objects + runtime reflection" },
  SPREAD: { code: "NT1006", milestone: "M2", hint: "spread needs arrays/objects" },
  DESTRUCTURE: { code: "NT1007", milestone: "M2", hint: "destructuring needs arrays/objects" },
  REST_PARAM: { code: "NT1008", milestone: "M2", hint: "rest params need arrays" },
  OPTIONAL_CHAIN: { code: "NT1009", milestone: "M2", hint: "?. and ?? need nullable union types" },
  FOR_IN: { code: "NT1010", milestone: "M1", hint: "for-in needs objects" },
  FOR_OF_NONSTRING: { code: "NT1011", milestone: "M1", hint: "for-of currently supports strings only" },
  CLASS: { code: "NT1012", milestone: "M3", hint: "classes are not implemented" },
  GENERIC: { code: "NT1013", milestone: "M3", hint: "generics need monomorphization" },
  COLLECTION: { code: "NT1014", milestone: "M3", hint: "immutable Map/Set support string keys + number values (Map) / string|number elems (Set)" },
  // Minimal classes ARE implemented (fields + constructor + methods + `new`/`this`).
  // Everything beyond that plain shape — inheritance, static, getters/setters, access
  // modifiers, parameter properties, field initializers — is deferred with this code.
  CLASS_FEATURE: { code: "NT1015", milestone: "M3", hint: "minimal classes support only fields + a constructor + methods; this class feature is deferred" },
  // (NT1016 is retired. It refused `console.log(u8)` — node's size-dependent,
  // column-grouped typed-array layout. Stage 49 found that layout to BE the array
  // layout with the length folded into the opening brace, which the Stage-47 inspect
  // builder already owned, so a Uint8Array now prints exactly like node and nothing
  // is left for the code to refuse. The number is not reused.)
  // Networking tier: `fetch`/`await` ARE supported — but nativets has no event loop, so
  // `await` never yields and every request BLOCKS. Anything whose meaning depends on real
  // promises (concurrent/overlapping requests, `Promise.all`, `.then`, an un-awaited async
  // result) is refused rather than silently serialized-but-claimed-parallel. Concurrency in
  // nativets is the ACTOR model: spawn/send/receive. See docs/divergences.md.
  ASYNC: { code: "NT1020", milestone: "later", hint: "`await` is a pass-through over blocking calls — there is no concurrency. Use the actor model (spawn/send/receive) for parallel work" },
  // Modules (SH1). `import { a, b as c } from "./m.ts"`, `import type`, side-effect
  // imports, `export` of function/const/let/class/type/interface, `export { a as b }`
  // and `export { x } from "./y.ts"` ARE supported (whole-program link, see
  // src/modules.ts). So is the ONE default-import shape that is not really an import,
  // `import s from "./f.c" with { type: "text" }` (SH5): the file is read at compile
  // time and the name binds a string constant. What this code refuses is the module
  // syntax outside that subset: `export default`, a plain default import, `import * as
  // ns`, `export * from`, dynamic `import()`, bare/node_modules specifiers, and any
  // import attribute other than `type: "text"` (notably node's `type: "json"`, which
  // binds PARSED json — accepting it as text would silently change the program).
  // Actor messages (B3 v5). `number`, `string` and STRUCTURED records/arrays of those
  // ARE sendable — a structured message is deep-copied on send (the structuredClone
  // walk) and carries its shape, so the receiver can verify it. What this code refuses
  // is a message type with no sound copy: a function value (it captures the SENDER's
  // environment), a Map/Set/Uint8Array/Response handle, a `Dyn`, or a nullable box.
  // Isolation is the actor model's whole point, so we reject rather than share a pointer.
  ACTOR_MSG: { code: "NT1021", milestone: "later", hint: "actor messages are `number`, `string`, or a record/array of those (deep-copied on send). Send the data, not a handle — e.g. `{ id: number, name: string }` instead of a closure or a Map" },
  MODULE: { code: "NT1017", milestone: "M3", hint: "supported module syntax: `import { a, b as c } from \"./rel/path.ts\"`, `import type { T } from …`, `import \"./m.ts\"`, `import text from \"./f.c\" with { type: \"text\" }`, `export [async] function|const|let|class|type|interface`, `export { a as b }`, `export { x } from \"./y.ts\"`" },
  // `instanceof` is decided at COMPILE TIME from the static type of the left operand —
  // exact, because a value's static type IS its class here (user classes have no
  // inheritance, and there are no polymorphic references). What this code refuses is a
  // right operand whose class membership a static type cannot decide: `Error` (nativets
  // models it structurally as `{message:string}`, so an Error and a plain record with a
  // `message` are indistinguishable), `Object`/`Function`, and any non-class value.
  INSTANCEOF: { code: "NT1022", milestone: "later", hint: "`x instanceof C` works for a user class and for Array/Map/Set/Uint8Array; for an Error, compare a discriminant field (e.g. `e.code !== undefined`) instead" },
  // stdlib Batch 3 (the object-shaped web APIs). `new Date(…)` + the component getters,
  // `new URL(…)` + its components, `URLSearchParams` and the URI encode/decode globals ARE
  // supported. This code refuses the members OUTSIDE that surface — the ones whose meaning
  // needs machinery we do not have: a Unicode database (`String#normalize`), ICU collation
  // (`localeCompare`), locale/format tables (`toLocaleString`, `Date#toString`), or Date
  // MUTATION (`setHours` — a Date here is an immutable time value, like everything else).
  WEBAPI: { code: "NT1024", milestone: "later", hint: "Date supports getTime/getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds/getMilliseconds/toISOString; URL supports protocol/host/hostname/port/pathname/search/hash/origin/searchParams. Locale- and Unicode-table-driven members are refused rather than approximated" },
  // console.log of a COMPOUND value renders through node's util.inspect (Stage 47):
  // objects, class instances, arrays, Map/Set, nested combinations and Dyn are all
  // byte-identical to node. This code refuses the few leaf types INSIDE a printed
  // value whose node rendering we cannot reproduce — never a raw pointer.
  INSPECT: { code: "NT1025", milestone: "later", hint: "console.log renders objects, class instances, arrays, Map/Set and JSON.parse results exactly like node. A function value prints as `[Function: <name>]` in node — a name our lifted closures do not carry — and a Uint8Array/Response/URL handle has no node-identical form here; print a field or a derived string instead" },
  // The `console` surface (Stage 49). `console.log`/`error`/`warn`/`info`/`debug` ARE
  // supported, including node's format specifiers (`%s %d %i %f %j %o %O %c %%`) when
  // the format string is a LITERAL. This code refuses the rest: another `console.*`
  // method (`table`/`group`/`dir`/`time`/`count`/`assert`/`trace`), and a specifier
  // applied to an argument type whose node rendering has no faithful form here.
  CONSOLE: { code: "NT1026", milestone: "later", hint: "console supports log/error/warn/info/debug and node's `%s %d %i %f %j %O %c %%` format specifiers in a literal format string; build the line yourself for anything else" },
  // Regular expressions are a deliberate non-feature (Tier C, docs/divergences.md):
  // `.replace`/`.replaceAll`/`.split` take STRING patterns. A `/.../` literal now
  // LEXES (so it is a located, named refusal instead of a character-level lexer crash
  // that killed the whole file) and is refused here. This is the #1 self-hosting
  // blocker — see docs/self-hosting.md.
  REGEX: { code: "NT1027", milestone: "later", hint: "there is no RegExp — string patterns only (`s.replace(\"a\", \"b\")`, `s.split(\",\")`, `s.startsWith`/`endsWith`/`includes`/`indexOf`). Hand-roll character scanning for anything richer" },
  // The host FFI (SH4). A `node:` builtin module is resolved by the compiler ITSELF —
  // there is no node_modules and no JS to run — so only the members with a native
  // implementation exist. This code refuses a `node:` module we do not implement, and a
  // member outside the implemented surface, naming what IS available. It also refuses
  // the argument VALUES that decide what node returns (`readFileSync` with no encoding
  // yields a Buffer; a `spawnSync` option changes what the call does), because
  // half-implementing those would be a silent divergence rather than a refusal.
  HOSTMOD: { code: "NT1028", milestone: "later", hint: "the host FFI implements exactly what a self-hosted compiler needs — `node:fs` (readFileSync/writeFileSync/existsSync/mkdtempSync/readdirSync/rmSync), `node:path`, `node:os` (tmpdir/homedir), `node:url` (fileURLToPath), `node:child_process` (spawnSync). See docs/self-hosting.md (SH4)" },
  // Indexed access types (`T["field"]` — TypeScript's "lookup type"). The SUPPORTED shape
  // is the one the parser can resolve PRECISELY: a base whose structure is known in THIS
  // file (a `type`/`interface`/class declared here) indexed by a STRING LITERAL naming one
  // of its fields — that lookup becomes the field's type, exactly.
  //
  // This code refuses the shapes that would have to be GUESSED: a non-literal index
  // (`T[number]`, `T[K]`, `T[keyof T]`), a key the record does not have, and a base whose
  // structure this file does not know — note that an unknown named type ERASES to `number`
  // here (`resolveNamed`), which is precisely why a cross-module `Mod["field"]` cannot be
  // resolved and must not be approximated.
  //
  // An indexed access carries no runtime of its own, but its RESULT decides how the
  // annotated value is stored, compared and printed. Erasing an unresolved lookup to a
  // guess would therefore be a silent wrong answer — the worst outcome available — so it
  // is refused instead. Before this code existed the whole construct died on the `[]`
  // array-suffix loop as an ANONYMOUS `NT0001 Expected ']'`, with no hint and no name.
  INDEXED_ACCESS: { code: "NT1029", milestone: "later", hint: "an indexed access type is supported as `T[\"field\"]` where `T` is a record type declared in THIS file and the key is a string literal; write the field's type directly, or add a `type` alias for it, otherwise" },
  // The parser resolves type names in SOURCE ORDER, so a name used above its declaration
  // used to fall back to `number` silently — and the program was then rejected downstream
  // by an NT2001 that blamed the VALUE, naming neither the type nor the cause. Refused
  // here instead, at the type, saying which of the two shapes it is. Only names declared
  // in the same file reach this: an imported or stdlib name still falls back.
  FORWARD_TYPE: { code: "NT1030", milestone: "later", hint: "declare the type above its first use. A type that (directly or mutually) contains itself cannot be reordered into range: types are encoded STRUCTURALLY as a string (`Ty` in src/ast.ts), so a self-containing type has no finite encoding — nominal recursive types are not implemented (docs/divergences.md)" },
} as const;

type NyiSpec = { code: string; milestone: Milestone; hint: string };

/**
 * A deferred feature, as the catalog entry describes it.
 *
 * `hint` overrides the catalog's generic hint for ONE site. A code covers a whole feature
 * area, so its catalog hint has to speak for every site that uses it — but a refusal is
 * only actionable when it names the workaround for the construct actually written. Where
 * a site can be that specific, it says so here; everything else keeps the catalog text.
 */
export function nyi(spec: NyiSpec, what: string, hint?: string): NTError {
  return new NTError({ code: spec.code, message: `${what} is not supported yet`, milestone: spec.milestone, hint: hint ?? spec.hint });
}

/**
 * A call to a name this module IMPORTS, in a program that was never linked (NT1003).
 *
 * An imported binding is introduced by the linker (`src/modules.ts`), so `check()` run
 * straight on a `parse()` result sees the callee as an unknown name and used to report it
 * as the closure gap — "function values / unknown callee ... is not supported yet". That
 * is a diagnostic about a feature the program does not use, on a call the compiler
 * handles correctly the moment the graph is linked.
 *
 * It is measurement damage, and it has cost real time: `docs/self-hosting.md` already
 * records driver.ts's NT1003 as "an artifact of the measurement, not a gap", and a
 * self-hosting fleet still spent two lanes treating the same diagnostic on coverage.ts
 * and driver.ts as a closure blocker to burn down.
 *
 * The CODE stays NT1003 so the coverage histogram keeps its shape; what changes is that
 * the message now says which module the name came from, and that linking fixes it.
 */
export function unlinkedImportError(name: string, from: string): NTError {
  return new NTError({
    code: NYI.CLOSURE.code,
    milestone: NYI.CLOSURE.milestone,
    message: `call to '${name}', which is imported from "${from}" — this program was checked WITHOUT linking, so the binding does not exist yet`,
    hint: `not a missing feature: the call compiles once the module graph is linked. Check via \`sourceToIR(source, path)\` (src/driver.ts) or \`linkProgram(source, path)\` (src/modules.ts) rather than \`check(parse(source))\`, which leaves every imported binding undeclared`,
  });
}

/**
 * A bare `[]` with nothing to infer from and no contextual type (NT1001). nativets takes
 * an empty array literal's element type from CONTEXT — a binding/field annotation, a
 * declared return type, a parameter type, an assignment target, or the other arm of a
 * `?:`/`??`. With none of those it is genuinely ambiguous, so we reject rather than guess
 * (`[]` is not `never[]` here) — and name the three ways to supply the missing type.
 */
export function emptyArrayError(): NTError {
  return new NTError({
    code: NYI.ARRAY.code,
    milestone: NYI.ARRAY.milestone,
    message: "cannot infer the element type of an empty array literal `[]`: it has no elements and no type from context",
    hint:
      "supply the element type — annotate the binding (`const xs: number[] = []`), " +
      "annotate the return type (`function f(): number[] { return []; }`), " +
      "or write a non-empty literal (`const xs = [1, 2]`)",
  });
}

/**
 * Decorators (NT1023). nativets has TWO sigils with two mechanisms (docs/decorators.md):
 * `@@name` is a COMPILE-TIME attribute the checker reads (Rust `#[derive]`-shaped, zero
 * runtime footprint) and `@name` is a real RUNTIME wrapper (Python-shaped: an ordinary
 * user function that takes the thing being decorated and returns the replacement).
 * This code refuses everything outside that surface — an UNKNOWN `@@attribute` (never
 * silently ignored: an attribute that changes how a class compiles cannot be a comment),
 * a decorator in a position we do not lower, and a decorated shape we cannot make sound.
 */
export function decoratorError(message: string, hint: string): NTError {
  return new NTError({ code: "NT1023", message, milestone: "later", hint });
}

/**
 * A type error (NT2001).
 *
 * `at` is the position of the offending expression, when the caller knows it. It is worth
 * threading: a diagnostic with no location at all is the difference between "there is a
 * bug somewhere in this 3000-line file" and a jump to the line. It goes BOTH into the
 * message (so the compact one-line form, which is what `coverage` and the self-hosting
 * frontier print, still says where) and into a primary span (so `formatDiagnostic` with
 * the source underlines the line, rustc-style). `hint` is the fix, kept out of the
 * message so `coverage` can show it separately.
 */
export function typeError(message: string, at?: { line: number; col: number }, hint?: string, label = "here"): NTError {
  if (at === undefined) return new NTError({ code: "NT2001", message, hint });
  return new NTError({
    code: "NT2001",
    message: `${message} at ${at.line}:${at.col}`,
    hint,
    spans: [{ line: at.line, label, primary: true }],
  });
}

/**
 * A statically-known out-of-bounds index (NT2002). An out-of-range index PANICS at
 * runtime (docs/divergences.md) — but when BOTH the length and the index are known at
 * compile time, deferring to a runtime abort would be a worse diagnostic for the same
 * certain fault. So we reject: compile-time beats runtime, `coverage` surfaces it, and
 * the program never gets built. A real user error, hence the NT2xxx type-error band —
 * not the NT1xxx "not yet implemented" gradient.
 */
export function boundsError(message: string, hint: string): NTError {
  return new NTError({ code: "NT2002", message, hint });
}

/**
 * In-place mutation of an array/object is rejected (NT1606). nativets' data model
 * is immutable-by-default (Phase B "sharp turn", a deliberate divergence from node):
 * arrays and objects are values that are never mutated in place. `.push`/`.pop`,
 * `arr[i] = v`, and `o.f = v` are refused with an actionable pointer to the
 * immutable replacement — reject-don't-miscompile, surfaced by `coverage`.
 * Sits in the NT16xx ownership/memory-model band alongside the move checker.
 */
export function mutationError(message: string, hint: string): NTError {
  return new NTError({ code: "NT1606", message, milestone: "later", hint });
}

export function parseError(message: string): NTError {
  return new NTError({ code: "NT0001", message });
}

/**
 * Module-graph (link-time) errors — the NT17xx band, alongside NT16xx for the
 * memory model. These are not "unimplemented TypeScript": they are real defects in
 * a program's import graph, so they carry no milestone.
 *
 *   NT1701  a module could not be resolved / read
 *   NT1702  an import cycle (named, in order — never hang, never miscompile)
 *   NT1703  a module has no such export
 *   NT1704  a `with { type: "text" }` import whose file cannot become a string
 *           (a NUL byte: nativets strings are NUL-terminated, so inlining one would
 *           silently truncate the constant — the worst outcome available)
 */
export function moduleError(code: "NT1701" | "NT1702" | "NT1703" | "NT1704", message: string, hint?: string): NTError {
  return new NTError({ code, message, hint });
}
