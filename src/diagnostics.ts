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
    const trimmed = text.replace(/^\s*/, "");
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
  // Bytes (stdlib batch 2): Uint8Array + TextEncoder/TextDecoder ARE supported (construct,
  // index read/write, .length, for-of, encode/decode). What is refused with this code is
  // `console.log(u8)` — node's size-dependent column-grouped typed-array layout is not
  // cheap to match byte-for-byte, so we reject rather than miscompile the format.
  BYTES: { code: "NT1016", milestone: "M3", hint: "Uint8Array works (index/length/for-of/encode/decode); only console.log of one is deferred — inspect elements individually or decode to a string" },
  // Networking tier: `fetch`/`await` ARE supported — but nativets has no event loop, so
  // `await` never yields and every request BLOCKS. Anything whose meaning depends on real
  // promises (concurrent/overlapping requests, `Promise.all`, `.then`, an un-awaited async
  // result) is refused rather than silently serialized-but-claimed-parallel. Concurrency in
  // nativets is the ACTOR model: spawn/send/receive. See docs/divergences.md.
  ASYNC: { code: "NT1020", milestone: "later", hint: "`await` is a pass-through over blocking calls — there is no concurrency. Use the actor model (spawn/send/receive) for parallel work" },
  // Modules (SH1). `import { a, b as c } from "./m.ts"`, `import type`, side-effect
  // imports, `export` of function/const/let/class/type/interface, `export { a as b }`
  // and `export { x } from "./y.ts"` ARE supported (whole-program link, see
  // src/modules.ts). What this code refuses is the module syntax outside that subset:
  // `export default`, `import * as ns`, `export * from`, dynamic `import()`, and
  // bare/node_modules specifiers.
  // Actor messages (B3 v5). `number`, `string` and STRUCTURED records/arrays of those
  // ARE sendable — a structured message is deep-copied on send (the structuredClone
  // walk) and carries its shape, so the receiver can verify it. What this code refuses
  // is a message type with no sound copy: a function value (it captures the SENDER's
  // environment), a Map/Set/Uint8Array/Response handle, a `Dyn`, or a nullable box.
  // Isolation is the actor model's whole point, so we reject rather than share a pointer.
  ACTOR_MSG: { code: "NT1021", milestone: "later", hint: "actor messages are `number`, `string`, or a record/array of those (deep-copied on send). Send the data, not a handle — e.g. `{ id: number, name: string }` instead of a closure or a Map" },
  MODULE: { code: "NT1017", milestone: "M3", hint: "supported module syntax: `import { a, b as c } from \"./rel/path.ts\"`, `import type { T } from …`, `import \"./m.ts\"`, `export function|const|let|class|type|interface`, `export { a as b }`, `export { x } from \"./y.ts\"`" },
} as const;

type NyiSpec = { code: string; milestone: Milestone; hint: string };

export function nyi(spec: NyiSpec, what: string): NTError {
  return new NTError({ code: spec.code, message: `${what} is not supported yet`, milestone: spec.milestone, hint: spec.hint });
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

export function typeError(message: string): NTError {
  return new NTError({ code: "NT2001", message });
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
 */
export function moduleError(code: "NT1701" | "NT1702" | "NT1703", message: string, hint?: string): NTError {
  return new NTError({ code, message, hint });
}
