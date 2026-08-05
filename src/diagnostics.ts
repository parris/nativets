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
} as const;

type NyiSpec = { code: string; milestone: Milestone; hint: string };

export function nyi(spec: NyiSpec, what: string): NTError {
  return new NTError({ code: spec.code, message: `${what} is not supported yet`, milestone: spec.milestone, hint: spec.hint });
}

export function typeError(message: string): NTError {
  return new NTError({ code: "NT2001", message });
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
