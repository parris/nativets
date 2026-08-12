/*
 * Recursive-descent parser with precedence climbing.
 *
 * It accepts a broad surface — including features the checker/codegen do not yet
 * implement (arrays, objects, spread, destructuring, try/catch, optional chain).
 * Parsing them (rather than erroring at the token level) lets the checker reject
 * them with a precise NT-coded diagnostic that `coverage` can report.
 */

import { lex, LexError, decodeEscapeAt, type Token } from "./lexer.ts";
import { parseError, nyi, NYI, mutationError, decoratorError, nulLiteral, unknownTypeName, NTError } from "./diagnostics.ts";
import {
  makeNullable, makeMapTy, makeSetTy, makeFuncTy, objectType, typeParamTy, eraseTypeParams, mapTypesDeep, mapTypesDeepExpr,
  isObjectTy, isFuncTy, classTag, makeUnionTy, unionDiscriminant, widenLiteralTys, stringLitTy, isUnionTy,
  isNullableTy, nullishKind,
  tagValueIsEncodable, keyIsEncodable, objectFields, isStringLitTy, HOST_MODULES, unionMembers,
  makeGeneralUnionTy, isGeneralUnionArm, generalUnionArmTypeof, extractUnionMembers, unionWidenedMembers,
  resolveStaticFieldReads, collectBindingNames, fieldsStoredViaThis, typeRefTy, expandTypeRef, makeArrayTy, exprLoc,
} from "./ast.ts";
import type {
  Program, Stmt, Expr, Param, VarDecl, Declarator, Ty, BinaryOp, SwitchCase, ObjectProperty, FuncDecl,
  ImportDecl, TextImport, ExportTable, RecTypeEntry, AssignOp, Loc, CallExpr,
} from "./ast.ts";

/** Options for parsing ONE module of a program (see src/modules.ts). */
export interface ParseOpts {
  /** Type-level names imported from already-parsed dependencies (`import type`,
   *  and the instance shape of an imported `class`). Seeds the alias table so an
   *  annotation naming an imported type resolves to its real shape. */
  typeEnv?: Map<string, Ty>;
  /** LOCAL names bound to an imported `export async function`. The floating-async guard
   *  is per-parse, so without this an imported async call written without `await` would
   *  be erased into a silent wrong answer (node yields a Promise). Parallel to typeEnv:
   *  the linker maps each dependency's async exports onto this module's local names. */
  asyncEnv?: Set<string>;
  /** This module's path, as it should appear in a runtime panic's `at <file>:<line>:<col>`. */
  file?: string;
  /** OUT-param: receives every type alias this parse declared. `coverage` parses a file
   *  one statement at a time, so without this a `type`/`interface` declared in one
   *  statement would be invisible to the next — most visibly a `@@mutable type`, whose
   *  tag is what makes a later `r.f = v` legal. Unused by the normal pipeline. */
  collectTypes?: Map<string, Ty>;
  /**
   * Names DECLARED in the original source but stripped before this parse sees it — for a
   * caller that parses a fragment rather than a file. `coverage` is the only one: it erases
   * the import preamble AND every `type`/`interface` declaration, then parses what is left
   * one statement at a time (src/coverage-preprocess.ts).
   *
   * Without it the surviving annotations name types nothing declares, and NT2003
   * ("Cannot find name") fires on a program that is perfectly well formed — a refusal
   * invented by the stripping, not found in the source. Unused by the normal pipeline,
   * which parses whole files and reads the imports itself.
   */
  externalTypeNames?: string[];
}

export class ParseError extends Error {}

interface Op { prec: number; right?: boolean; logical?: boolean; }
/* A `Map`, not `Record<string, Op> = { … }` — the operator is a RUNTIME key
 * (`BIN.get(t.value)` below), which is the whole reason this table exists, and an object
 * literal cannot construct a dictionary here (see src/ast.ts HOST_MODULES and
 * test/record-dict.test.ts). The `.set` chain is free under bun: `Map.prototype.set`
 * returns its receiver (ES2024 24.1.3.9 step 8). */
const BIN: Map<string, Op> = new Map<string, Op>()
  .set("**", { prec: 14, right: true })
  .set("*", { prec: 13 }).set("/", { prec: 13 }).set("%", { prec: 13 })
  .set("+", { prec: 12 }).set("-", { prec: 12 })
  .set("<<", { prec: 11 }).set(">>", { prec: 11 }).set(">>>", { prec: 11 })
  .set("<", { prec: 10 }).set("<=", { prec: 10 }).set(">", { prec: 10 }).set(">=", { prec: 10 })
  .set("===", { prec: 9 }).set("!==", { prec: 9 }).set("==", { prec: 9 }).set("!=", { prec: 9 })
  .set("&", { prec: 8 }).set("^", { prec: 7 }).set("|", { prec: 6 })
  .set("&&", { prec: 5, logical: true }).set("||", { prec: 4, logical: true })
  .set("??", { prec: 3, logical: true });
// The lexer has tokenized `**=` since it was written (`PUNCT_3`); it was simply never
// listed here, so `a **= 2` came out as `Expected ';' but found '**='`. It is listed with
// the rest now — see `compoundArith` in codegen.ts, which is where `**` stops being like
// its neighbours (it is `js_pow`, not an LLVM instruction).
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>="]);
// Access modifiers erased on class members and, on ctor params, promoted to parameter properties.
const PARAM_ACCESS = new Set(["private", "public", "protected", "readonly"]);
// What follows a class member's NAME. A modifier keyword (`readonly`, `static`, …) counts
// as a modifier only when the next token is NOT one of these — otherwise the keyword is
// itself the member's name (`static(): T`, `private: T`).
const MEMBER_START = new Set(["(", ":", "?", "="]);
// Class-member modifiers/accessors that change semantics — still deferred (NT1015).
// (`static` is handled in `parseClass`; it stays listed so `static static` and friends
// still land on the deferral rather than silently parsing.)
const REJECTED_MEMBER_MODS = new Set(["static", "abstract", "declare", "override", "get", "set", "async"]);
const SCALARS = new Set(["number", "boolean", "string", "void", "undefined", "null"]);
/**
 * AMBIENT type names — names TypeScript's own lib declares, so a program may use one
 * without declaring or importing it. They are NOT all supported: most still erase through
 * the fallback below exactly as they always did. This set exists only so NT2003 ("Cannot
 * find name") can tell "you never declared this" from "this is a global you never have to
 * declare", and a name in here keeps whatever behavior it had.
 *
 * DELIBERATELY GENEROUS. The refusal can only make fewer programs compile, so a name
 * wrongly OUT of this set is a false refusal on valid code — strictly worse than the
 * silent erasure it replaces — while a name wrongly IN it merely preserves the status quo
 * for that name. Every doubtful name is therefore listed. Measured against the corpus:
 * `unknown`, `any`, `never`, `ReadonlyMap` and `this` are the ones that actually occur.
 */
const AMBIENT_TYPES = new Set([
  // TypeScript's own type-system keywords
  "any", "unknown", "never", "object", "symbol", "bigint", "this", "typeof", "keyof", "infer", "asserts", "is",
  // ECMAScript globals
  "Object", "Function", "Array", "ReadonlyArray", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Math", "JSON", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "ReadonlyMap", "ReadonlySet",
  "Promise", "PromiseLike", "Date", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
  "TypeError", "URIError", "AggregateError", "Proxy", "Reflect", "Generator", "GeneratorFunction",
  "AsyncGenerator", "Iterable", "Iterator", "IterableIterator", "AsyncIterable", "AsyncIterator",
  "AsyncIterableIterator", "ArrayLike", "ConcatArray", "TemplateStringsArray", "IArguments",
  "ArrayBuffer", "SharedArrayBuffer", "ArrayBufferLike", "ArrayBufferView", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  // lib.es5 utility types
  "Partial", "Required", "Readonly", "Record", "Pick", "Omit", "Exclude", "Extract", "NonNullable",
  "Parameters", "ConstructorParameters", "ReturnType", "InstanceType", "ThisParameterType",
  "OmitThisParameter", "ThisType", "Awaited", "NoInfer",
  "Uppercase", "Lowercase", "Capitalize", "Uncapitalize",
  // web / host globals a nativets program may name (fetch tier, text encoding, node)
  "Response", "Request", "Headers", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
  "Blob", "File", "FormData", "AbortController", "AbortSignal", "Event", "EventTarget",
  "ReadableStream", "WritableStream", "TransformStream", "Console", "Buffer", "NodeJS", "globalThis",
]);
/**
 * The three ambient names allowed past `refuseUnknownName`, and the ONLY three — a
 * documented residue, not a judgement that they are safe. All three are refused inside an
 * `as`/`satisfies` assertion regardless (`parseAssertedType`), which is where the erasure
 * stops being a confusing refusal and becomes a wrong answer.
 *
 * TWO OF THE THREE STILL ERASE TO `number`. `unknown` no longer does: it resolves to the
 * opaque `"unknown"` placeholder instead (see the arm at the end of `resolveNamed`, and
 * the `ScalarTy` comment in src/ast.ts for why an uninhabited type-level name is the whole
 * mechanism rather than a half-finished one). It stays in this set because the set gates
 * the parse-time REFUSAL, and refusing here is fatal to the whole file — measured: with
 * `unknown` removed from this set a linked `src/cli.ts` stops PARSING, taking every
 * per-function self-hosting number with it. The entry that follows describes what the
 * placeholder replaced.
 *
 * WHY THEY ARE HERE. src/ uses all three, and none has an honest rewrite today:
 *
 *   - `never` (13 sites: src/cli.ts, src/ast.ts, src/checker.ts, src/modules.ts,
 *     src/parser.ts) is a DIVERGENT return (`function usage(): never`) or an
 *     EXHAUSTIVENESS witness (`default: { const impossible: never = e; return impossible; }`).
 *     The witness is load-bearing and says so in src/ast.ts: "add an `Expr` member and this
 *     stops compiling". There is no way to keep that tsc-checked invariant without `never`,
 *     so refusing it would mean deleting a real invariant to satisfy a subset limitation.
 *     Supporting it means a BOTTOM type — assignable to everything, inhabited by nothing,
 *     and a return type that excuses the missing `return`.
 *   - `unknown` (18 sites: src/checker.ts, src/ownership.ts, src/codegen.ts) is the
 *     parameter of a REFLECTIVE walk (`scanUsesActors(node: unknown)`), where it is the
 *     correct TypeScript type and a concrete one would be a lie. Those functions are
 *     already refused for their own reasons (`for…in`, `Object.values`, index signatures)
 *     — and that claim is now MEASURED rather than asserted: erasing to the opaque
 *     placeholder instead of to `number` moves a linked `src/cli.ts` from 125 refused
 *     functions to 125. Not one clears. What the 19 affected diagnostics stop doing is
 *     naming `number`, a type none of those sources contains.
 *   - `object` (2 sites, src/ownership.ts) is an IDENTITY set over heterogeneous AST nodes
 *     (`Set<object>`, `Map<string, object>`), where it is likewise the correct type.
 *
 * WHY THE RESIDUE IS SAFE, as far as it goes. An ANNOTATION is CHECKED against the value
 * it annotates, so an erased `number` that is wrong produces a refusal — misattributed and
 * confusing, but never a wrong answer. An ASSERTION is not: it ADOPTS the type outright,
 * which is why `xs as any[]` silently re-typed a `string[]` as a `number[]`. That case is
 * refused for every name including these two.
 *
 * THE HOLE THAT ARGUMENT LEFT, since it is the one someone will re-open. "The annotation is
 * checked" covers the value flowing INTO the slot; it says nothing about what the BODY then
 * does with a binding it believes is a `number`. A parameter written `e: unknown` IS a
 * `number` from that point on, and `e as string` inside the body names no ambient type, so
 * nothing here refuses it — the erasure was ADOPTED by an assertion after all, one indirection
 * later. It reached clang as "'%t0' defined with type 'double' but expected 'ptr'":
 *
 *     function asStr(e: unknown): string { return e as string; }
 *     console.log(asStr(42));            // node: "42", exit 0
 *
 * `Checker.type`'s `AsExpr` case now refuses an assertion that crosses the scalar/reference
 * boundary (`reprClass`, src/checker.ts), which closes it wherever it is reached from — the
 * erasure is only one of the ways to get there, and `(n as string)` on an honest `number`
 * emitted the same invalid IR with no ambient name in sight.
 *
 * That hole is now closed for `unknown` a second, earlier way: nothing is assignable to
 * the placeholder, so `asStr(42)` is refused at the CALL and the body's cast is never
 * reached. `never` and `object` still erase, so it stays open for them.
 *
 * This set should shrink to empty. Removing an entry needs the feature, not just the
 * deletion: a bottom type for `never`, and for `object` either an opaque unusable `Ty` —
 * the route `unknown` took — or reflective walks the subset can express. `unknown` is
 * half-way: it has the opaque `Ty`, and it stays listed here only because the parse-time
 * refusal is file-fatal. Rewriting src/'s 18 sites is what would let it leave entirely.
 */
const ERASURE_STILL_ALLOWED = new Set(["unknown", "never", "object"]);
/**
 * Ambient names `parseGenericType` DOES map to a real shape once type ARGUMENTS are
 * written — mapped to the shortest spelling that compiles, for the hint.
 *
 * Reaching `resolveNamed` with one of these proves it was written BARE: an applied
 * `Map<K,V>` is claimed by `parseGenericType` and never gets here, and a bare `Map` has no
 * `<` for `parseGenericType` to open. So the refusal can give the one edit that fixes the
 * line rather than the catalog's general advice.
 *
 * Every key is a `case` label in `parseGenericType`; keep the two in step. A label missing
 * here only costs the specific hint, never correctness — the general one still fires.
 */
const NEEDS_TYPE_ARGS = new Map<string, string>()
  .set("Map", "Map<string, number>").set("ReadonlyMap", "ReadonlyMap<string, number>")
  .set("Record", "Record<string, number>")
  .set("Set", "Set<string>").set("ReadonlySet", "ReadonlySet<string>")
  .set("Array", "Array<number>").set("ReadonlyArray", "ReadonlyArray<number>")
  .set("Promise", "Promise<number>").set("Awaited", "Awaited<number>")
  .set("Partial", "Partial<{ a: number }>").set("Required", "Required<{ a: number }>")
  .set("Readonly", "Readonly<{ a: number }>").set("NonNullable", "NonNullable<number>")
  .set("Extract", "Extract<number, number>").set("Exclude", "Exclude<number, string>")
  .set("Omit", "Omit<{ a: number }, \"a\">").set("Pick", "Pick<{ a: number }, \"a\">")
  .set("Parameters", "Parameters<(n: number) => void>")
  .set("ReturnType", "ReturnType<() => number>");
/**
 * Why THIS ambient name cannot be resolved, and what to write instead (NT1035).
 *
 * The advice genuinely differs by name — "add the type arguments" fixes a bare `Map` and
 * is nonsense for `any` — so the catalog's shared hint is overridden per group. Anything
 * not named here keeps the catalog text, which is why this can stay a partial list.
 */
function ambientTypeHint(id: string): string | undefined {
  const applied = NEEDS_TYPE_ARGS.get(id);
  if (applied !== undefined) {
    return `\`${id}\` is supported WITH its type arguments — write \`${applied}\`. Bare \`${id}\` says nothing about what it holds, and a container's element type decides how its contents are stored, compared and printed here, so there is nothing to guess from`;
  }
  if (id === "any") {
    return "`any` turns type checking OFF, which a compiler whose rule is reject-never-miscompile cannot honour: nativets picks a value's machine representation from its STATIC type (a `number` is a `double`, a `string` is a `ptr`), so a slot typed `any` has no representation to pick. Write the concrete type. For a value that really is one of several, use a union this subset supports — `T | undefined`, `T | null`, or a discriminated union of object types";
  }
  if (id === "unknown") {
    return "`unknown` means \"some type — narrow before use\", and nativets carries no runtime type tag to narrow from: a value's representation is fixed at compile time. Write the concrete type, or a discriminated union of object types (a literal-typed tag field `switch` narrows on) when the value really is one of several";
  }
  if (id === "never") {
    return "`never` is the uninhabited type and nativets does not model it. In RETURN position (`function f(): never`) write what the function would return if it returned, or `void` — divergence is not tracked here. As an EXHAUSTIVENESS witness (`const impossible: never = x`) delete the binding: it asserts a `switch` covered every case, which this subset cannot verify";
  }
  if (id === "object") {
    return "`object` means \"any non-primitive\" — a bound, not a shape — and nativets compiles a record from its FIELDS. Write the record type out (`{ a: number, b: string }`), or declare a `type`/`interface` for it";
  }
  if (id === "symbol" || id === "bigint") {
    return `\`${id}\` is not implemented — nativets' primitives are \`number\` (an IEEE-754 double), \`string\`, \`boolean\`, \`null\` and \`undefined\`. ${id === "bigint" ? "For integers beyond a double's exact range there is no substitute here yet" : "Use a `string` for a unique key"}`;
  }
  if (id === "this") {
    return "`this` in TYPE position is the polymorphic this-type, which only means something under inheritance — nativets resolves a class's methods against the class it found them on. Name the class instead (`): C`)";
  }
  return undefined;
}
/**
 * Compile-time class ATTRIBUTES (`@@name`) the checker understands. An attribute changes
 * how a class is CHECKED and COMPILED and has zero runtime footprint — so an unknown one
 * must never be silently ignored (NT1023), the way a misspelled `#[derive]` is a hard
 * error in Rust rather than a comment. See docs/decorators.md.
 */
const KNOWN_ATTRS = new Set(["mutable"]);

/**
 * A receiver that can be evaluated TWICE with no observable difference — a plain name,
 * `this`, or a chain of field reads over one. Compound field assignment (`o.f += v`) and
 * `o.f++` desugar to a read plus a write, so they need this; a computed receiver
 * (`f().x += 1`) is refused rather than silently double-evaluated.
 */
function isSimplePath(e: Expr): boolean {
  if (e.kind === "Identifier") return true;
  return e.kind === "MemberExpr" && isSimplePath(e.object);
}

/**
 * True if `e` is a member/element access carrying a `?.` anywhere to its left, i.e. an
 * `OptionalExpression`. Deliberately a SYNTACTIC test on the tree the parser just built,
 * which is what the spec rule is: `IsValidSimpleAssignmentTarget(OptionalExpression)` is
 * `false`, so `a?.b = v`, `a?.[i] = v`, `a?.b++` and `a?.[i]++` are all EARLY errors —
 * node reports a SyntaxError before running a line (test262
 * `optional-chaining/static-semantics-simple-assignment.js` and
 * `optional-chaining/update-expression-postfix.js`).
 *
 * We refuse here rather than in the checker because it is not a type question: a
 * genuinely-mutable receiver (`Uint8Array`, a `@@mutable` record) reaches codegen with
 * every type rule satisfied, and used to COMPILE — accepting a program node rejects
 * outright. `isOptChainExpr` in checker.ts answers the same question for the type/lowering
 * side; this is the parse-time half, and the two must agree on what "one chain" means.
 */
function isOptChainTarget(e: Expr): boolean {
  if (e.kind === "MemberExpr") return !!e.optional || isOptChainTarget(e.object);
  if (e.kind === "IndexExpr") return !!e.optional || isOptChainTarget(e.object);
  return false;
}

/**
 * The hint every RECURSIVE-type refusal carries, in one place. There are two spellings of
 * the same failure — a `type`/`interface` naming itself (`resolveNamed`) and a class FIELD
 * naming its own class (`parseClass`) — reached by different code paths, and a reader who
 * gets different advice for the same cause learns the wrong lesson. Deliberately NOT the
 * catalog's shared NT1030 hint, which tells you to reorder: reordering fixes a forward
 * reference and cannot fix a cycle.
 */
const RECURSIVE_TYPE_HINT =
  "a type is encoded STRUCTURALLY, as a string (`Ty` in src/ast.ts), so a type that contains itself has no finite encoding. " +
  "Reordering cannot help; nominal recursive types are not implemented — see docs/divergences.md";

/*
 * `@@mutable` + RECURSIVE used to be refused HERE, for the whole DECLARATION, in both
 * spellings — `recursiveMutableError`. Neither is refused at the declaration any more:
 * the record split at the field in piece 2, the class in piece 4, and both now land on
 * `Checker.checkCycleCapableField`, which refuses the one WRITE that can close a cycle.
 *
 * What the old refusal was right about, and what the new one still carries: a cycle here
 * is not a leak, it is a SILENT WRONG ANSWER. Measured against a control, `__objLive()`
 * is 1 with and without the cycle — the leak is the pre-existing shallow-drop one and the
 * cycle adds nothing. What it costs is `console.log`:
 *   node:     <ref *1> N { v: 7, next: [Circular *1] }
 *   nativets: N { v: 7, next: N { v: 7, next: N { v: 7, next: [N] } } }
 * because `genInspect` unfolds the back-edge and stops on util.inspect's DEPTH limit,
 * which is a cap on nesting and not a cycle detector. Every walk here assumes a tree.
 */

/** Truncate for a diagnostic: a type dump is unbounded and a hint has to stay readable. */
function clip(s: string, n: number): string { return s.length <= n ? s : `${s.slice(0, n)}…`; }

/**
 * Is the field named `key` of the object type `t` string-literal typed — i.e. usable as a
 * union discriminant?
 *
 * A LOOP, not `objectFields(t).find((f) => f.key === key)!.ty`. `.find` over an array of
 * RECORDS is NT1001 in the subset this file has to stay inside (the element it answers
 * would alias its owner), and this call sits three arrows deep inside `.some`/`.every`,
 * where a `for` cannot go — so the loop has to live in a function of its own.
 *
 * A MEMBER WITH NO SUCH FIELD ANSWERS FALSE, which is what the `!` spelling meant rather
 * than a widening: the only caller passes a `k` drawn from `common`, and `common` is the
 * keys `keys.every((ks) => ks.includes(k))` kept — so every member has the field and the
 * missing case is unreachable. It is spelled totally anyway, because "unreachable" is a
 * claim about today's callers and `!` on a genuinely absent field is a TypeError under
 * node inside the code that BUILDS a diagnostic.
 */
function hasStringLitField(t: Ty, key: string): boolean {
  for (const f of objectFields(t)) if (f.key === key) return isStringLitTy(f.ty);
  return false;
}

/** The shared refusal for `?.` in a write position — one message for all four spellings. */
function optChainWriteError(what: string): never {
  throw parseError(
    `'?.' cannot appear in a write position: ${what}`,
    "an optional chain is not a valid assignment target (node reports a SyntaxError). " +
    "Guard the base and write through a plain access instead — `if (a) { a[i] = v; }`",
  );
}

// A parser is a CURSOR: `this.pos` advances, `this.typeAliases` accumulates. That is real
// in-place mutation of one owned object, so it is `@@mutable` (docs/decorators.md) — spelled
// as a PRAGMA comment because this file must satisfy two toolchains at once: bun runs it
// today (where `@@mutable` is a syntax error) and nativets must compile it tomorrow (where
// the attribute is load-bearing). See src/lexer.ts.
//@@mutable
class Parser {
  private pos = 0;
  private tmpCounter = 0;
  /**
   * Type-level aliases (`type X = …` / `interface X { … }`), recorded at parse time
   * and substituted wherever `X` appears in an annotation. Purely type-level — the
   * declarations themselves are ERASED (no runtime footprint), so this map is their
   * entire trace. A name declared in this file but not yet parsed is refused (NT1030 —
   * see `declaredTypeLines`); a name from anywhere else still falls back to `number`.
   */
  private typeAliases = new Map<string, Ty>();
  /**
   * Every `interface X` / `type X` name declared ANYWHERE in this file, to the line it is
   * declared on — collected from the token stream before parsing starts.
   *
   * `typeAliases` only knows what has been parsed SO FAR, so it cannot tell "you never
   * declared this" from "you have not declared it yet"; both used to fall back to
   * `number`. This map is what separates them, and only the second is refused (NT1030) —
   * a name absent from this map is an import or a stdlib type and keeps the old fallback.
   */
  private declaredTypeLines = new Map<string, number>();
  /**
   * Where each TOP-LEVEL `type`/`interface` declaration starts, as a token index — the
   * first token of the whole declaration, so any `export` or `@@`/`@` decorator prefix is
   * included. This is the input to `hoistTypeDecls`, which re-parses each declaration on
   * its own before the file proper.
   *
   * Top-level ONLY (brace depth 0). A `type` declared inside a function body or a generic
   * function's scope can mean something different there (a type PARAMETER in scope resolves
   * to a `#T` marker, not to a shape), so hoisting it to file scope could change what it
   * resolves to. Those keep the old source-order behavior.
   */
  private typeDeclStarts = new Map<string, number>();
  /**
   * The `>>` / `>>>` token whose `>`s are being spent one nested type-argument list at a
   * time — its INDEX, and how many of them this parser has taken (see `eatTypeClose`).
   *
   * Two scalars rather than a map because AT MOST ONE token is ever partly spent: a
   * partial spend means we are between the closes of nested lists, and every one of those
   * closes targets the SAME token. Any other `>>` belongs to a list already closed.
   *
   * Parser-LOCAL, which is the whole point — this state used to live in the token itself
   * (`t.value = t.value.slice(1)`) and the token array is shared with every sub-parser.
   */
  // ANNOTATED: a class field initialized to `-1` is NT1015 here (the initializer is a
  // unary expression, not a literal the field type can be read off). `blocker-metric`
  // reported it the moment this field was added — the subset rule this file lives under.
  private angleTok: number = -1;
  private angleSpent: number = 0;
  /** The `interface`/`type` name whose own body is being parsed — a reference to it from
   *  in there is RECURSIVE, which reordering cannot fix, so it is reported differently. */
  private declaringType: string | undefined;
  /** Set by `resolveNamed` when the declaration being parsed referred to ITSELF, so the
   *  shape it produced contains a `@Name` back-edge and has to be registered in
   *  `recTypes`. Read and reset by whichever of parseTypeAlias/parseInterface set
   *  `declaringType`. */
  private declaringTypeIsRecursive = false;
  /** Recursive declaration name -> its shape, the table `@Name` resolves through. Published
   *  on the Program; empty (and so absent) for every non-recursive program. */
  private recTypes = new Map<string, Ty>();
  /**
   * Type names `hoistTypeDecls` proved to be in a CYCLE, each mapped to the name it is
   * blocked on (itself, for a directly self-recursive type). Hoisting resolves a forward
   * reference; what it cannot resolve, however it is reordered, is a type that contains
   * itself. Naming those as an ordering problem would be the exact misdirection NT1030
   * exists to end, so `resolveNamed` reports them as recursion instead.
   */
  private cyclicTypes = new Map<string, string>();
  /**
   * MUTUAL recursion. `declaringType` mints a back-edge for the ONE name being declared,
   * which is all self-recursion needs. A cycle spanning several declarations needs every
   * member of the strongly-connected component to be a back-edge at once — resolving
   * `interface A { b?: B }` needs B's shape, which needs A's — so `hoistTypeDecls` proves
   * the component first and then re-parses each member with this set populated.
   *
   * A name is in here only once the SCC round has produced a shape for it, so a `@Name`
   * the table cannot resolve is never minted (see `resolveCycle`).
   */
  private cycleNames = new Set<string>();
  /**
   * Why the SCC round gave a component back, when it did — the members that never settled
   * and the reason each one stalled.
   *
   * A component is ALL OR NOTHING (see `resolveCycle`), so one member nativets cannot
   * represent takes the other forty-four down with it and every one of them is reported as
   * plain recursion. That is true but useless: the recursion is solved, and the thing that
   * actually blocks the file is the member's own refusal. This carries it into the HINT, so
   * the real blocker is never masked by the refusal in front of it. Deliberately the hint
   * and not the message: the message is what `test/selfhost-ratchet.baseline.json` records
   * as a blocker's identity, and this changes no blocker.
   */
  private cycleStall = "";
  private cycleStallSize: { total: number; left: number } | undefined;
  /** The type name `resolveNamed` last refused on. Read by `hoistTypeDecls` off a
   *  sub-parser to build the dependency edge it needs to tell a cycle from a chain. */
  private blockedOn: string | undefined;
  /** The module path of the inline `import("m").T` currently being resolved, if any — set
   *  by `parseImportType` around its one `resolveNamed` call. While it is set, the `number`
   *  fallback is a REFUSAL (NT1035) rather than an answer: that caller dropped the path, so
   *  a `number` there is the annotation quietly changing meaning, not a resolution. */
  private erasedImportOf: string | undefined;
  /** Set while an `as`/`satisfies` assertion's type is being parsed. It withdraws the
   *  `ERASURE_STILL_ALLOWED` escape: an assertion ADOPTS the type it names instead of
   *  checking a value against it, so an erasure there is a wrong answer rather than a
   *  confusing refusal. See `parseAssertedType`. */
  private erasureIsFatal = false;
  /** Every `class X` declared in this file. A class declares a TYPE too (`parseClass`
   *  registers its instance shape), and classes are NOT hoisted — so the hoisting
   *  fixpoint has to know to keep its hands off a declaration that names one. */
  private declaredClassNames = new Set<string>();
  /**
   * Every identifier an `import` in this file BINDS, collected lexically from the token
   * stream in the constructor (`scanExternalNames`) — like `declaredTypeLines` and for the
   * same reason: a hoisting sub-parser starts in the MIDDLE of the file and never sees the
   * import list at all. Its declaration is somewhere this parse CANNOT SEE, so "I have no
   * shape for it" says nothing about whether it exists and NT2003 must not fire.
   *
   * ONE SOURCE ONLY. This used to be the union of three, which made "a name in here" an
   * ambiguous claim — `refuseUnknownName` could not tell an import from a stripped fragment
   * name from a generic parameter, and so could not act differently on them. The other two
   * are now `fragmentNames` and `genericParamNames`; `isExternal` is the old union, for the
   * arms that genuinely do not care which.
   *
   * The import half is deliberately BLIND to whether the import actually seeded a type.
   * `modules.ts` seeds `typeEnv` from the exporting module's `finalTypes`, and a type that
   * module refused for its own reason is simply absent — so an imported name can reach the
   * fallback while being perfectly well declared one file over. Blaming the annotation
   * there would move the report AWAY from the real cause. The unseeded-import case is a
   * separate diagnostic belonging to the linker, which is the only pass that can tell
   * "your dependency refused this type" from "no such name".
   *
   * Over-collects on purpose: every specifier, type-only or not, plus the default and
   * namespace forms. A name in here is only ever a reason NOT to refuse.
   */
  private externalNames = new Set<string>();
  /** SPLIT OUT of `externalNames`: names a fragment-parsing caller stripped and handed
   *  back (`ParseOpts.externalTypeNames`; `coverage` is the only caller). */
  private fragmentNames = new Set<string>();
  /** SPLIT OUT of `externalNames`: a generic DECLARATION's own type parameters
   *  (`type X<T> = …`), collected by `skipGenerics`. */
  private genericParamNames = new Set<string>();
  /** The union `refuseUnknownName` used to consult as one set. */
  private isExternal(id: string): boolean {
    return this.externalNames.has(id) || this.fragmentNames.has(id) || this.genericParamNames.has(id);
  }
  /** True on a sub-parser built by `hoistTypeDecls` — i.e. this parse is resolving ONE
   *  declaration ahead of the file, and may only use what hoisting can actually see. */
  private hoisting = false;
  /** Top-level functions synthesized from class members (ctor + methods), appended to
   *  the program body after parsing so they hoist like ordinary function declarations. */
  private hoistedFns: Stmt[] = [];
  /** True while parsing a class member body in which `this.field = expr` (FieldAssign) is
   *  legal — the constructor (building the instance) and, since the decorators lane, any
   *  METHOD. A method that assigns a field is a "setter": for an `@@mutable` class it
   *  mutates in place, for an ordinary class it copy-on-writes (docs/decorators.md). */
  private thisWritable = false;
  /** Set when the member body currently being parsed assigned `this.f` at least once. */
  private thisAssigned = false;
  /**
   * True while parsing a CONSTRUCTOR body, as opposed to a method's. Both may assign
   * `this.f`, but only one of them can close a cycle: a constructor writes into a block
   * that nothing else can reach yet, so the value it stores cannot already point back at
   * the receiver — unless it names the receiver itself. The checker's cycle rule reads
   * this to exempt the constructor (see `cycleCapableThisWrite`), which it MUST: a field
   * initializer and a parameter property both desugar into constructor field writes, and
   * a recursive field's initializer (`parent: Scope | null = null`) is exactly one of them.
   */
  private inCtorBody = false;
  /**
   * async/await (networking tier). nativets has no event loop and no promises, so
   * `async` is ERASED and `await` is an IDENTITY pass-through over an
   * already-resolved value (`fetch` is a blocking call). The payoff: ordinary
   * idiomatic source compiles here AND runs unchanged under node, which stays the
   * byte-for-byte oracle. The cost: there is NO concurrency, so anything that would
   * only make sense with real promises (an un-awaited async result, `.then`,
   * `Promise.all`) must be REJECTED rather than silently serialized — these two sets
   * are how the parser spots the first case. See docs/divergences.md.
   */
  private asyncFns = new Set<string>();          // names of `async function f`
  /** Exported names that are `export async function` — published on the ExportTable so
   *  an importing module can seed its OWN `asyncFns` (see ParseOpts.asyncEnv). */
  private exportAsync = new Set<string>();
  /** Arrow nodes that were written `async` — the bridge from an erased async ARROW back
   *  to the NAME it gets bound to, which is what `asyncFns` (and the guard) work in. */
  /** HIGHER-ORDER async. `asyncFns` is name tracking, and a name does not survive a call
   *  boundary: `run(one)` binds the async arrow to `run`'s parameter, where the guard has
   *  never heard of it. The declared TYPE is what crosses that boundary — a parameter
   *  annotated `(…) => Promise<T>` is exactly as promise-returning as an `async function`
   *  — but `Promise<T>` ERASES to `T` in `parseGenericType`, so the fact has to be caught
   *  syntactically while the annotation is being read. `parseFuncType` sets this to
   *  whether the OUTERMOST function type it just parsed returns a written `Promise<…>`;
   *  every reader resets it to false immediately before parsing the annotation. */
  private fnTyReturnsPromise = false;
  /** Parameter INDICES annotated `(…) => Promise<T>`, per callable — by function name for a
   *  `function f(…)`, by arrow NODE for `const f = (…) => …` (bound to its name in
   *  parseDeclarator). This is the only place the async-ness of an argument can be
   *  RE-ESTABLISHED after it crosses a call, so it is also what says whether an escape is
   *  safe: handing an async value to a parameter NOT in this set loses it silently. */
  // `number[]` values, not `Set<number>`: a Map whose VALUES are a collection is
  // `NT1014` ("Map with Set<number> values"), and it was the first blocker of five of the
  // twelve modules once the `Set<Expr>` above it cleared. The set was only ever tested
  // with `.has`, which `.includes` answers, and the index lists are two or three entries
  // long — so nothing is lost but the nesting.
  private promiseParamsByFn = new Map<string, number[]>();
  /** Filled by whichever parameter list was parsed last; read immediately after. */
  private lastPromiseParams: number[] = [];
  private lastPromiseParamNames: string[] = [];   // `string[]` — it feeds `asyncParamScopes`
  /** SCOPED, unlike `asyncFns`. A parameter name is not a module-level fact: two unrelated
   *  functions both taking an `f` — one `() => Promise<number>`, one `() => number` — must
   *  not contaminate each other, and putting parameters in the flat set did exactly that
   *  (`twice(f: () => number) { return f() + f(); }` was rejected because a DIFFERENT
   *  function's `f` was promise-typed). One frame per function/arrow body being parsed. */
  private asyncParamScopes: string[][] = [];   // `string[][]` — see `typeParamScopes`
  /** Every argument position that hands a function value to a call, checked once the whole
   *  file is parsed — declarations hoist, so neither the callee nor an `async function`
   *  argument is necessarily known yet at the call site. `scopedAsync` is the part that
   *  CANNOT be re-derived later: it is the enclosing parameter scope at the call. */
  private asyncEscapes: {
    callee: string | null; index: number; argName: string | null;
    asyncArrow: boolean; scopedAsync: boolean; line: number; col: number;
  }[] = [];
  /** `return <a function value>`, checked post-parse for the same hoisting reason. */
  private returnEscapes: { argName: string | null; asyncArrow: boolean; scopedAsync: boolean; declared: boolean; line: number; col: number }[] = [];
  /** Functions whose RETURN type is written `(…) => Promise<T>` — they hand an async
   *  function back, so `pick()()` is a call to an async function. */
  private returnsAsyncFn = new Set<string>();
  /** Whether the function body currently being parsed declares such a return type — the
   *  one thing that makes `return <an async function>` legal (see parseReturn). */
  private returnsAsyncFnStack: boolean[] = [];
  private identCalls: { node: Expr; name: string; line: number; col: number; scopedAsync?: boolean }[] = [];
  /** True while parsing the ctor body of a class that `extends Error` — enables `super(msg)`
   *  (desugared to `this.message = msg`, since nativets models Error as `{message:string}`). */
  private inErrorCtor = false;
  /** Decorators parsed immediately before a declaration, consumed by `parseClass`. */
  private pendingDecorators: { attrs: string[]; wrappers: string[] } | null = null;
  /** Classes carrying `@@mutable` — TRUE in-place mutation (see docs/decorators.md).
   *  Published on the Program so the ownership pass and the checker can see it. */
  private mutableClasses = new Set<string>();
  /** `static` FIELD names, class-qualified (`C.f`) — the module-level bindings they
   *  lower to, and what a `C.f` read is rewritten to once the file is parsed. */
  private staticFieldNames = new Set<string>();
  /** RECORD type names carrying `@@mutable` (`@@mutable type Cell = { n: number }`) —
   *  an extension of the class attribute to a `type`/`interface` declaration. The record
   *  is tagged with this name (`Cell{n:number}`), so mutability is NOMINAL rather than
   *  structural; published on the Program for the checker + ownership pass. */
  private mutableRecords = new Set<string>();
  /** Module surface (SH1): `import` declarations and the export table. Empty for an
   *  ordinary single-file program, in which case `parseProgram` leaves them off the
   *  Program entirely — so every existing single-module path is untouched. */
  private imports: ImportDecl[] = [];
  /** SH5: `import src from "./x.c" with { type: "text" }` — a COMPILE-TIME text import.
   *  Recorded, not resolved: reading the file is the linker's job (src/modules.ts), which
   *  is what owns path resolution and file I/O. The parser stays pure. */
  private textImports: TextImport[] = [];
  /** Host FFI (SH4): the canonical names imported from a `node:` builtin module, plus
   *  the `as`-alias→canonical map applied when an identifier is parsed. A `node:` import
   *  binds a compiler BUILTIN, so there is no module to link — it is erased like a type. */
  private hostImports = new Set<string>();
  private hostAliases = new Map<string, string>();
  private exportValues = new Map<string, string>();
  private exportReexports = new Map<string, { source: string; imported: string; line: number }>();
  private exportTypes = new Set<string>();
  private file?: string;
  private collectTypes?: Map<string, Ty>;
  constructor(private toks: Token[], opts: ParseOpts = {}) {
    if (opts.typeEnv) for (const [k, v] of opts.typeEnv) this.typeAliases = this.typeAliases.set(k, v);
    if (opts.asyncEnv) for (const n of opts.asyncEnv) this.asyncFns = this.asyncFns.add(n);
    this.file = opts.file;
    this.collectTypes = opts.collectTypes;
    if (opts.externalTypeNames) for (const n of opts.externalTypeNames) this.fragmentNames = this.fragmentNames.add(n);
    // Pre-scan for declared type names. Lexical on purpose: `interface`/`type` followed by
    // an identifier is unambiguous in the token stream, and this has to run BEFORE any
    // parsing so a name's declaration is known no matter where it sits in the file.
    let depth = 0; // brace depth, so `typeDeclStarts` can keep to top-level declarations
    for (let i = 0; i + 1 < toks.length; i++) {
      // FIELDS, not the elements. `const t = toks[i]!` binds an array ELEMENT, which is a
      // borrow — the array owns it and frees it — so naming it would make a second owner
      // (NT1605). Reading through the index is what the refusal's hint prescribes, and the
      // fields here are all scalars, so each read is a copy.
      const tType = toks[i]!.type;
      const tValue = toks[i]!.value;
      const tLine = toks[i]!.line;
      const nType = toks[i + 1]!.type;
      const nValue = toks[i + 1]!.value;
      if (tType === "punct" && tValue === "{") depth++;
      else if (tType === "punct" && tValue === "}") depth--;
      else if (tType === "ident" && tValue === "class" && nType === "ident") this.declaredClassNames = this.declaredClassNames.add(nValue);
      else if ((tValue === "interface" || tValue === "type") && tType === "ident" && nType === "ident") {
        // `type X =` only — `type` is not a reserved word, so `const type = 1` must not
        // register `= 1` as a declaration. `interface` is always a declaration.
        if (tValue === "interface" || toks[i + 2]?.value === "=" || toks[i + 2]?.value === "<") {
          if (!this.declaredTypeLines.has(nValue)) this.declaredTypeLines = this.declaredTypeLines.set(nValue, tLine);
          if (depth === 0 && !this.typeDeclStarts.has(nValue)) {
            // Walk back over the declaration's prefix so a re-parse from here sees the
            // whole thing: `export`, then any `@@attr` / `@wrapper` pair before it.
            let s = i;
            if (s > 0 && toks[s - 1]!.value === "export") s--;
            while (s >= 2 && toks[s - 1]!.type === "ident" && (toks[s - 2]!.value === "@@" || toks[s - 2]!.value === "@")) s -= 2;
            this.typeDeclStarts = this.typeDeclStarts.set(nValue, s);
          }
        }
      }
    }
    this.scanExternalNames(toks);
  }

  /**
   * Collect every identifier an `import` in this file BINDS (see `externalNames`).
   *
   * Lexical, and deliberately crude: from an `import` keyword, take every identifier up to
   * the `from` (or, for a side-effect / text import, up to the module string), skipping the
   * punctuation and the `type`/`as` keywords. `as` is handled by simply keeping the LAST
   * identifier of each specifier as well as the first — the local binding is what matters,
   * and over-collecting the imported name too is harmless because this set is only ever a
   * reason to DECLINE a refusal.
   *
   * "Over-collecting is harmless" holds for ONE EXTRA NAME PER SPECIFIER. It does not hold
   * for the whole file, which is what this scan used to do. The module-specifier stop was
   * `u.type === "string"`, and `TokenType` (src/lexer.ts) spells a string token `"str"` —
   * so the comparison could never be true. The `from` stop hid it for every ordinary
   * import; a BARE SIDE-EFFECT import (`import "./m.ts";`) has no `from`, so the scan ran
   * to END OF FILE and declared every identifier in the module external. `externalNames`
   * is the escape `refuseUnknownName` consults, so a single bare import turned NT2003 off
   * for the whole file and `const x: Bogus = 1;` COMPILED — a "reject, never miscompile"
   * hole. See test/forward-type-ref.test.ts ("import scanning"). Found by tsc — TS2367,
   * "these types have no overlap" — the first time this project was semantically
   * type-checked (tsconfig.src.json, test/tsc.test.ts).
   */
  private scanExternalNames(toks: Token[]): void {
    for (let i = 0; i < toks.length; i++) {
      // Fields, not the element — see the scan above (NT1605: an element is a borrow).
      if (toks[i]!.type !== "ident" || toks[i]!.value !== "import") continue;
      // `import("m").T` — an inline import TYPE, not a declaration. It binds nothing.
      if (toks[i + 1]?.value === "(") continue;
      // `import.meta.url` — the META PROPERTY, not a declaration either, and the second
      // trigger for the same hole as the specifier stop below: there is no `from` and
      // often no string literal after it, so the scan ran to end of file and declared the
      // rest of the module external. `import.meta.url` is idiomatic (every fixture that
      // resolves a sibling file uses it), so this was the COMMON way to lose NT2003 —
      // 67 of the 496 `.ts` files in the tree could not have reported it.
      if (toks[i + 1]?.value === ".") continue;
      for (let j = i + 1; j < toks.length; j++) {
        const uType = toks[j]!.type;
        const uValue = toks[j]!.value;
        if (uType === "str") break;                          // reached the module specifier
        if (uType === "ident" && uValue === "from") break;
        if (uType !== "ident") continue;                     // `{` `}` `,` `*` punctuation
        if (uValue === "type" || uValue === "as") continue;  // modifier keywords, not bindings
        this.externalNames = this.externalNames.add(uValue);
      }
    }
  }

  /**
   * TYPE HOISTING. In TypeScript every type declaration in a scope is hoisted: a type may
   * be used above the line that declares it, and source order is irrelevant (types are
   * erased, so there is nothing to order). This parser, though, SUBSTITUTES a named type
   * for its shape as it goes — `typeAliases` only holds what has been parsed so far — so a
   * use above the declaration had no shape to substitute.
   *
   * Fix it by resolving the top-level type declarations FIRST, to a fixpoint. Each round
   * re-parses every still-unresolved declaration on its own (a sub-parser over the same
   * tokens, positioned at the declaration's first token, seeded with what is known so far);
   * one that still names an unresolved type is deferred to the next round. A round that
   * resolves nothing means the remainder is a CYCLE.
   *
   * A cycle is a DIFFERENT, unsolved problem — `Ty` is a flat string (src/ast.ts), so a
   * type that contains itself has no finite encoding. Those names are simply left out of
   * `typeAliases`, and the main parse below refuses them exactly as it always did. Forward
   * reference and recursion stay two diagnostics, and the one that can be fixed is fixed.
   *
   * Nothing here reports errors. A declaration that fails for any OTHER reason (a general
   * union, a bad decorator) is dropped from the fixpoint so the main parse reports it at
   * its real position, with its own message — this pass never becomes the blamed frame.
   */
  private hoistTypeDecls(): void {
    let pending = [...this.typeDeclStarts.keys()];
    let blocker = new Map<string, string>(); // name -> the unresolved type it stopped on
    while (pending.length) {
      //@@mutable
      const deferred: string[] = [];
      for (const name of pending) {
        const sub = new Parser(this.toks, { typeEnv: this.typeAliases, file: this.file });
        sub.pos = this.typeDeclStarts.get(name)!;
        sub.hoisting = true;
        // SEEDED, like `recTypes` in `resolveCycle`: each declaration is re-parsed in a
        // FRESH sub-parser, which has never seen the `//@@mutable` on some OTHER
        // declaration in this file. `discriminatedUnion` asks this set whether a tagged
        // arm is a record, so without seeding it, a union with a tagged member resolved
        // during hoisting (i.e. any RECURSIVE one) fell back to the general-union refusal
        // and stalled the whole cycle. A tag the sub-parser discovers has to come back
        // too, and that is the HARVEST below — not aliasing.
        //
        // A COPY, deliberately, so each set has ONE owner. Handing over the receiver and
        // relying on the sub's `.add` to be seen here is a bun-ism: `Set.add` mutates and
        // returns the receiver under node, but a nativets `Set` is PERSISTENT — `.add`
        // answers a NEW set and leaves this one alone (docs/divergences.md §A). Both
        // spellings compile and exit 0, and they disagree, so self-hosting this file would
        // have silently dropped every `@@mutable` tag a sub-parser found. See
        // test/single-owner.test.ts.
        sub.mutableRecords = new Set(this.mutableRecords);
        let parsed = false;
        try {
          sub.parseStatement();
          parsed = true;
        } catch (e) {
          if (e instanceof NTError && e.diag.code === NYI.FORWARD_TYPE.code) {
            deferred.push(name);
            // Bound to a LOCAL first, so the guard narrows the thing that is read. The
            // direct `if (sub.blockedOn !== undefined) … sub.blockedOn` is `.set value
            // expects string, got ?Ustring` here — narrowing needs a stable access path
            // and a field of another object is not one (docs/self-hosting.md). This was
            // the first blocker of five of the twelve modules.
            const why = sub.blockedOn;
            if (why !== undefined) blocker = blocker.set(name, why);
          }
          // any other refusal — leave it to the main parse, where it belongs
        }
        // THE HARVEST. On every path, including the throwing one: a sub-parser that
        // recorded a tag and only then failed still recorded it, which is what sharing
        // used to give for free.
        for (const n of sub.mutableRecords) this.mutableRecords = this.mutableRecords.add(n);
        if (!parsed) continue;
        const ty = sub.typeAliases.get(name);
        if (ty !== undefined) this.typeAliases = this.typeAliases.set(name, ty);
        // A shape with a `@Name` back-edge is meaningless without the table that resolves
        // it, and the sub-parser is where both were produced. Carry it back with the alias.
        for (const [n, shape] of sub.recTypes) this.recTypes = this.recTypes.set(n, shape);
      }
      // A COPY, not a move. `pending = deferred` HANDS THE ARRAY OVER, so the reads below
      // are "use of moved value" — and they are only reachable on the path this branch does
      // NOT take, which the ownership pass does not track. Spreading keeps `deferred` owned
      // by this scope for the lines that follow; the list is one round's worth of stuck
      // type names, so the copy is small and this is a fixpoint loop, not a hot path.
      if (deferred.length < pending.length) { pending = [...deferred]; continue; }
      // No progress. Everything left is stuck — but on WHAT matters: stuck on another
      // stuck name is a cycle (unfixable), stuck on a name that failed for its own reason
      // is not, and must not be reported as recursion.
      const stuck = new Set(deferred);
      for (const name of deferred) {
        const b = blocker.get(name);
        if (b !== undefined && stuck.has(b)) this.cyclicTypes = this.cyclicTypes.set(name, b);
      }
      this.resolveCycle([...this.cyclicTypes.keys()]);
      return;
    }
  }

  /**
   * The sentence that stops a big component's ONE unrepresentable member from hiding behind
   * forty-four recursion refusals. Empty (so the hint is byte-identical to before) unless
   * the SCC round actually gave a component back.
   */
  private cycleStallHint(): string {
    if (!this.cycleStall) return "";
    const n = this.cycleStallSize;
    const scale = n ? `${n.total - n.left} of the ${n.total} declarations in this cycle were encoded; ` : "";
    return `. NOTE — the recursion itself is not what stopped this file: ${scale}` +
      `what is left is not recursion but ${this.cycleStall}. ` +
      `A cycle is encoded all-or-nothing (a back-edge is only minted where it resolves), so fixing that is what unblocks the rest`;
  }

  /**
   * The SCC round — MUTUAL recursion (Lane C).
   *
   * `hoistTypeDecls` above has proved that `names` are stuck on each other: no ordering
   * resolves them, because resolving any one of them needs another's shape. That is the
   * same problem self-recursion has, one declaration wider, and it takes the same answer —
   * the nominal `@Name` back-edge — applied to the whole component at once: re-parse every
   * member with EVERY member's name resolving to a reference. Each member then has a finite
   * shape whose recursive positions are `@Name`, and `recTypes` is the table that resolves
   * them.
   *
   * Still a FIXPOINT, because the members are not independent even with back-edges
   * available. A union member may not be a bare `@Name` — `unionDiscriminant` needs each
   * member's SHAPE to find the tag — so `type Expr = TemplateLiteral | …` is expanded ONE
   * LEVEL at the member boundary (see `discriminatedUnion`), which needs
   * `interface TemplateLiteral` to have been resolved in an earlier round. Object members
   * settle first, unions that select over them settle next.
   *
   * ALL OR NOTHING. If a round stalls with members left, the whole component is abandoned
   * and every one of them keeps the NT1030 refusal it had — because a shape carrying a
   * `@Name` the table cannot resolve is a dangling reference, and this file's rule is that
   * a `@Name` is minted only where it resolves.
   */
  private resolveCycle(names: string[]): void {
    if (!names.length) return;
    for (const n of names) this.cycleNames = this.cycleNames.add(n);
    const recBefore = new Map(this.recTypes); // restored wholesale if the round stalls
    let resolved = new Map<string, Ty>();
    // A COPY: `names` is a PARAMETER, so the caller owns it and `pending = names` would
    // make this scope a second owner (NT1604). The loop rebinds `pending` each round
    // anyway, so it was never the same array for long.
    let pending = [...names];
    while (pending.length) {
      //@@mutable
      const deferred: string[] = [];
      let why = new Map<string, string>(); // residual member -> the error it stalled with
      for (const name of pending) {
        const sub = new Parser(this.toks, { typeEnv: this.typeAliases, file: this.file });
        sub.pos = this.typeDeclStarts.get(name)!;
        sub.hoisting = true;
        // COPIES, seeded from here and harvested back below — ONE owner each, for the
        // reason spelled out in `hoistTypeDecls`: a nativets `Map`/`Set` is persistent, so
        // handing over the receiver and expecting the sub-parser's writes to appear here
        // is a bun-ism that self-hosting would silently lose.
        //
        // `cycleNames` is seeded only. Nothing under `parseStatement` writes it — the one
        // `.add` is the loop above, and a sub-parser never reaches `resolveCycle` (it is
        // reached from `parseProgram`, and subs call `parseStatement`) — so it is
        // read-only in there and has nothing to give back.
        sub.cycleNames = new Set(this.cycleNames);
        sub.recTypes = new Map(this.recTypes); // an earlier round's shapes are what unions expand through
        sub.mutableRecords = new Set(this.mutableRecords); // and see hoistTypeDecls for the tag
        let parsed = false;
        try {
          sub.parseStatement();
          parsed = true;
        } catch (e) {
          deferred.push(name); // may only need a member that has not settled yet
          // `e.message` DIRECTLY. The `(e as { message?: string })` this replaces was a
          // defensive cast for a binding that used to type as `string`; the binding is
          // `NTError` now (raise inference reaches `parseStatement`'s callees), and the
          // assertion became `'{message:?Ustring}' is not a valid assertion for 'NTError…'`
          // — the FIRST BLOCKER of five of the twelve modules.
          //
          // The general lesson, recorded in docs/self-hosting.md before it bit here: a MORE
          // PRECISE catch binding can invalidate an `as` assertion that only type-checked
          // because the binding was imprecise. The cast was never load-bearing — every
          // throw reaching this `catch` comes from `parseStatement`, which raises NTError.
          // The USE is in the `then` and the RETHROW in the `else`, so no path does both.
          // Written as `if (!(e instanceof NTError)) throw e;` the rethrow MOVES `e` and the
          // read below it is "use of moved value" — the two are on exclusive paths, which
          // the ownership pass does not track. (The rethrow exists only for tsc, which
          // types a catch binding `unknown`; this compiler infers `NTError` here.)
          if (e instanceof NTError) {
            why = why.set(name, e.message.split("\n")[0]!);
          } else {
            throw e;
          }
        }
        // THE HARVEST, on every path (see hoistTypeDecls). A back-edge shape this round
        // minted is what the NEXT round's unions expand through, so losing it stalls the
        // component; the stall path below rolls `recTypes` back wholesale regardless.
        for (const [n, shape] of sub.recTypes) this.recTypes = this.recTypes.set(n, shape);
        for (const n of sub.mutableRecords) this.mutableRecords = this.mutableRecords.add(n);
        if (!parsed) continue;
        const ty = sub.typeAliases.get(name);
        if (ty === undefined) { deferred.push(name); continue; }
        resolved = resolved.set(name, ty);
      }
      if (deferred.length === 0) break;
      if (deferred.length === pending.length) {
        // Stalled with members left: abandon the component whole (see the note above), and
        // carry WHY out with it — `cycleStall` explains why this paragraph is not the end
        // of the story for a big component.
        // A SAMPLE, not the whole list. The residuals entangle — a union stalls because a
        // member it selects over stalled — so every one of them restates the others, and
        // ast.ts's four together run to 2 KB of type dump. Shortest reason first: it is the
        // least entangled, and therefore the one worth reading.
        const sample = [...deferred]
          .sort((a, b) => (why.get(a) ?? "").length - (why.get(b) ?? "").length)
          .slice(0, 2)
          .map((n: string) => `'${n}': ${clip(why.get(n) ?? "no shape was produced", 160)}`);
        this.cycleStall = sample.join("; ") + (deferred.length > sample.length ? ` (and ${deferred.length - sample.length} more that select over them)` : "");
        this.cycleStallSize = { total: names.length, left: deferred.length };
        // SINGLE-OWNER now, by the two routes the note that used to sit here named. Neither
        // is `x = x.delete(k)`: that is right about nativets but wrong about bun, where
        // node's `.delete` returns a BOOLEAN and would leave `x === true` (measured).
        //
        // `cycleNames` is REBUILT — filtering the survivors into a fresh Set is the only
        // spelling of "remove these keys" that means the same thing under both runtimes.
        let keptCycle = new Set<string>();
        for (const n of this.cycleNames) if (!names.includes(n)) keptCycle = keptCycle.add(n);
        this.cycleNames = keptCycle;
        // `recTypes` is RESTORED WHOLESALE, which is what the `.clear()` + replay below it
        // always spelled the long way — `recBefore` is a snapshot taken on entry, so
        // assigning a copy of it IS the rollback. `.clear()` has no rebinding form at all
        // (node's returns `undefined`), and it did not need one.
        this.recTypes = new Map(recBefore);
        return;
      }
      pending = deferred;
    }
    for (const [n, ty] of resolved) this.typeAliases = this.typeAliases.set(n, ty);
    // These names are no longer an ordering failure, so the NT1030 the main parse would
    // report for them is withdrawn. Rebuilt rather than deleted from, for the reason on the
    // stall path above: a discarded `.delete` does nothing here, and the rebinding form
    // would store a boolean under bun.
    let keptCyclic = new Map<string, string>();
    for (const [n, b] of this.cyclicTypes) if (!names.includes(n)) keptCyclic = keptCyclic.set(n, b);
    this.cyclicTypes = keptCyclic;
  }

  private freshTmp(): string { return `__d${this.tmpCounter++}`; }
  /** `const` declarators desugared from binding patterns in the parameter list being
   *  parsed; spliced at the top of that function's body (see parsePatternParam). */
  private paramPrelude: Stmt[] = [];
  private ident(name: string): Expr { return { kind: "Identifier", name }; }
  /** The implicit `undefined` an optional param/field erases to. A FACTORY rather than an
   *  inline literal at each site: an object literal assigned INTO an `Expr`-typed slot has
   *  its `kind` widened to `string` before the union is matched, so it is refused, while
   *  the same literal RETURNED from an `Expr`-returning function is contextually typed and
   *  accepted (the `ident` precedent above). One spelling, and the compiler can read it. */
  private undef(): Expr { return { kind: "UndefinedLiteral" }; }

  /**
   * In-scope generic type parameters (M3). Pushed while parsing a generic function's
   * signature + body, so a use of `T` in an annotation resolves to the MARKER `#T`
   * (which the checker later substitutes per instantiation) instead of erasing to
   * `number`. Empty for ordinary code, so nothing else changes.
   */
  // `string[][]`, not `Set<string>[]`. An ARRAY OF Set is NT1001 ("arrays of Set") and
  // was the first blocker of five of the twelve modules through the link — the note on
  // `inheritedTypeParams` below already knew this and went flat for the same reason; the
  // STACKS could not, because a pop has to remove exactly one frame's names. A frame here
  // holds one to three type parameters, so `.includes` answers the membership query at the
  // same cost the Set did.
  private typeParamScopes: string[][] = [];
  /**
   * Type parameters INHERITED from a parser that is lexically outside this one — the
   * frames open around a `${…}` substitution, which `parseSubstitution` hands to the
   * fragment's own parser.
   *
   * FLAT, where the stack it comes from is not, and that is not a simplification: this
   * query is "does ANY open frame declare `id`", so a merged set answers it identically,
   * and the alternative spelling costs a self-hosting blocker. A `Set<string>[]` cannot be
   * built as a local in the subset `src/` must stay inside (NT1001, "arrays of Set"), and
   * appending to the sub-parser's own stack from here is NT1606 (it is another object's
   * array). A flat `Set<string>` is neither. The sub-parser still pushes and POPS its own
   * frames on top of this for arrows written inside the substitution, so nesting inside
   * the fragment behaves exactly as it does anywhere else.
   */
  private inheritedTypeParams = new Set<string>();
  private inTypeParamScope(id: string): boolean {
    if (this.inheritedTypeParams.has(id)) return true;
    for (let i = this.typeParamScopes.length - 1; i >= 0; i--) if (this.typeParamScopes[i]!.includes(id)) return true;
    return false;
  }

  /** Resolve a named type to a concrete `Ty`: an in-scope type parameter marker, a
   *  recorded alias, `Error`, a scalar, else `number` (unknown named types erase to
   *  number, matching prior behavior). */
  private resolveNamed(id: string): Ty {
    if (this.inTypeParamScope(id)) return typeParamTy(id);
    // BEFORE the alias lookup, deliberately. Inside its own body a name is always the
    // back-edge, and an alias may well be registered for it already: type hoisting resolves
    // every top-level declaration in a sub-parser and the main parse then re-parses the
    // same declaration with that result in scope. Looking the alias up first made the
    // second parse UNFOLD one level (`?U@N` became `?U{v:number,next:?U@N}`), so the same
    // type had two spellings and `===` — which is the whole point of a string encoding —
    // stopped holding between an annotation and a literal.
    // The local copy and the `!== undefined` are not nullability logic — `id` is a
    // `string`, so the bare `id === this.declaringType` already answered false when it was
    // unset. They are there because comparing `T` with `T | undefined` is NT2001 in the
    // subset this file must compile in, and the guard only narrows a LOCAL: a `this.<field>`
    // does not narrow across `&&`, so guarding the field in place moved the refusal onto the
    // right operand rather than clearing it. Same answer on every input.
    const declaring = this.declaringType;
    if (declaring !== undefined && id === declaring) {
      this.declaringTypeIsRecursive = true;
      return typeRefTy(id);
    }
    // MUTUAL recursion: a member of a cycle, named from INSIDE a type declaration's body.
    // Same back-edge, and it must come BEFORE the alias lookup for the same reason — a
    // shape resolved in an earlier round is registered under the name, and unfolding it
    // here would give one type two spellings.
    //
    // `declaringType !== undefined` is the invariant, not a convenience: a `@Name` may only
    // appear NESTED inside a shape (src/ast.ts), so a value's own static type is always the
    // expanded shape. Without the guard, `const a: A = …` annotated `@A` and every pass that
    // reasons about a VALUE saw a reference instead of an object.
    if (this.declaringType !== undefined && this.cycleNames.has(id)) {
      this.declaringTypeIsRecursive = true;
      return typeRefTy(id);
    }
    const alias = this.typeAliases.get(id);
    if (alias) return alias;
    if (id === "Uint8Array" || id === "TextEncoder" || id === "TextDecoder") return id as Ty; // stdlib batch-2 bytes types
    if (id === "Response" || id === "Headers") return id as Ty; // networking tier: fetch's Response/Headers
    if (id === "Date" || id === "URL" || id === "URLSearchParams") return id as Ty; // stdlib batch-3 web APIs
    // Declared in this file, but not yet — so `typeAliases` does not have it and the
    // fallback below would erase it to `number`. That erasure is silent and the failure
    // it causes surfaces much later, blaming whatever value was annotated with it.
    // HOIST MODE ONLY. A class declares a type as well, and classes are not part of the
    // hoisting fixpoint (their instance shape is only known once `parseClass` runs). If a
    // declaration names one, resolving it HERE would erase the class to `number` for every
    // use above it — a silent erasure whose failure surfaces later, blaming the value. So
    // the declaration is left unresolved and the main parse reports it on the TYPE, exactly
    // as it did before hoisting existed. Never reaches the user: `hoistTypeDecls` catches it.
    if (this.hoisting && this.declaredClassNames.has(id)) {
      this.blockedOn = id;
      throw nyi(NYI.FORWARD_TYPE, `type '${id}' names a class, which type hoisting does not resolve`);
    }
    const declaredAt = this.declaredTypeLines.get(id);
    if (declaredAt !== undefined) {
      const used = this.prevLine(declaredAt);
      this.blockedOn = id;
      // Two different failures, and the advice differs: one is fixed by moving a line,
      // the other cannot be fixed by reordering at all. Saying "declare it earlier" for a
      // recursive type would be the same kind of misdirection this diagnostic exists to
      // end, so each carries its own hint rather than the catalog's shared one.
      // SELF-recursion never reaches here — it is the back-edge, handled at the top of this
      // function. So does a MUTUAL cycle whose members `resolveCycle` could encode. What is
      // left is a cycle the SCC round gave back, and `cycleStall` says why.
      const through = this.cyclicTypes.get(id);
      if (through !== undefined) {
        throw nyi(
          NYI.FORWARD_TYPE,
          through === id
            ? `recursive type '${id}' — it refers to itself (declared at line ${declaredAt})`
            : `recursive type '${id}' — it contains itself through '${through}' (declared at line ${declaredAt})`,
          RECURSIVE_TYPE_HINT + this.cycleStallHint(),
        );
      }
      // Not a cycle, so it is genuinely unresolved: either a declaration this file rejects
      // for its own reason (reported where it is declared), or a nested `type` that type
      // hoisting deliberately leaves in source order (see `typeDeclStarts`).
      throw nyi(
        NYI.FORWARD_TYPE,
        `use of type '${id}' before its declaration (used at line ${used}, declared at line ${declaredAt})`,
        "top-level `type`/`interface` declarations are hoisted, so this one is not top-level (a type declared inside a function or block stays in source order) or its own declaration was rejected — move it to the top level, above its first use; see docs/divergences.md",
      );
    }
    if (id === "Error") return "{message:string}" as Ty;
    if (SCALARS.has(id)) return id as Ty;
    this.refuseUnknownName(id);
    // Nothing above claimed the name, so the answer is the erasure. For an inline
    // `import("m").T` that is never acceptable — see `parseImportType`.
    if (this.erasedImportOf !== undefined) {
      throw nyi(
        NYI.AMBIENT_TYPE,
        `the inline import type 'import("${this.erasedImportOf}").${id}'`,
        `'${id}' is not in scope in this file, and an inline import type is resolved against this file's scope — the module path is dropped, so there is nothing left to look '${id}' up in. Import it by name instead (\`import type { ${id} } from "${this.erasedImportOf}"\`) and annotate with the bare \`${id}\``,
        this.prevLoc(),
      );
    }
    // `unknown` erases to an OPAQUE PLACEHOLDER rather than to `number` — the "opaque
    // unusable `Ty`" `ERASURE_STILL_ALLOWED` names as the precondition for removing it
    // from that set. It is a TYPE-LEVEL name with no representation and no inhabitants:
    // nothing is assignable TO it (so no value ever carries it), and no operation on it
    // is supported (so it never reaches codegen). That is not a limitation to fix later
    // — it is the whole mechanism. A placeholder that could hold a value would need a
    // runtime tag this compiler does not have.
    //
    // WHY A PLACEHOLDER AND NOT A REFUSAL. Refusing `unknown` outright is the honest
    // shape, and it is what `ambientTypeHint` already writes advice for, but the refusal
    // fires in the PARSER, and a parse refusal is fatal to the whole FILE rather than
    // scoped to one function body. Measured: deleting "unknown" from
    // `ERASURE_STILL_ALLOWED` takes a linked `src/cli.ts` from "125 of 767 functions
    // refused" to "does not parse" — every per-function self-hosting number in
    // docs/self-hosting.md goes dark, because src/ names `unknown` 18 times.
    //
    // WHAT IT BUYS, measured per function rather than assumed. It clears NOTHING: the
    // count is 125 either way. Every one of the 19 functions that erasure blocks is a
    // REFLECTIVE walk (`Object.values(node)`, `Object.keys(obj)` + `obj[k]`,
    // `Set<object>` identity) or a caller of one, and each of those is independently
    // outside the subset. What changes is that all 19 diagnostics stop naming a type the
    // source never contained: `Cannot compare number with null` becomes `Cannot compare
    // unknown with null`, and `arg 0 expects number, got Stmt[]` becomes `arg 0 expects
    // unknown, got Stmt[]`. A diagnostic that names a type the program does not contain
    // sends the reader to fix the wrong thing, which is a defect in its own right.
    //
    // IT ALSO CLOSES THE HOLE `ERASURE_STILL_ALLOWED` DOCUMENTS. `function asStr(e:
    // unknown): string { return e as string; }` reached clang as "'%t0' defined with
    // type 'double' but expected 'ptr'" because `e` really WAS a `number` and the
    // assertion adopted the erasure one indirection later. With no value assignable to
    // the placeholder, `asStr(42)` is refused at the CALL and the cast is unreachable.
    //
    // THE COST, stated because it is a real one. Erasure makes a program work whenever
    // every value reaching the slot happens to be a number: `function handle(e:
    // unknown){…}; handle(42)` prints today and is refused here. That only ever held in
    // the degenerate case where `unknown` was not needed — `handle("x")` was already
    // refused, and with a lying message — but it is capability given up, not merely
    // honesty gained.
    if (id === "unknown") return "unknown" as Ty;
    return "number" as Ty;
  }

  /**
   * NT2003 — the name is declared NOWHERE. Everything above this point in `resolveNamed`
   * has already claimed the name it knows how to resolve; what is left either belongs to
   * some scope this parser cannot see, or does not exist at all. This separates the two,
   * and only the second is refused.
   *
   * WHY IT HAS TO BE HERE, and not in the checker or a post-link pass: the erasure to
   * `number` is DESTRUCTIVE. `Ty` (src/ast.ts) is a flat structural string with no
   * inhabitant meaning "unresolved 'Nope'", so once this line returns `number` the name is
   * gone from the program and no later pass can recover it — a checker-side rule would be
   * reasoning about a `number` that is indistinguishable from one the user wrote. The
   * parser is the last place that still holds the SPELLING.
   *
   * The cost of putting it here is that the parser's view is FILE-LOCAL, so the four ways a
   * name can be legitimately unresolved at this instant each need their own escape, and all
   * four are checked before the throw:
   *   - a generic type PARAMETER — `typeParamScopes`, at the top of `resolveNamed`;
   *   - declared later in this file as a `type`/`interface` — `declaredTypeLines`, above,
   *     which reports the ordering problem instead;
   *   - declared later in this file as a CLASS — `declaredClassNames`, below;
   *   - declared somewhere this parse cannot see — `externalNames`, which is the union of
   *     what this file IMPORTS and what a fragment-parsing caller stripped before handing
   *     the text over. The import half is the reason the check cannot simply be
   *     "not in `typeAliases`": `modules.ts` seeds imported types from the exporting
   *     module's `finalTypes`, and a type that module refused for its OWN reason never gets
   *     seeded, so a perfectly well-declared name reaches this line. That case is real and
   *     live in src/ (`Ty`/`Expr`/`Stmt` from src/ast.ts are unseeded today because their
   *     declarations are refused there), and blaming the annotation for it would move the
   *     report one file away from the cause. It stays on the old fallback.
   *
   * SPECULATION-SAFE. `tryCallTypeArgs` parses `<…>` after a primary as a type-argument
   * list and BACKTRACKS on any throw, so `i < n` speculatively resolves `n` as a type name
   * and lands here — 199 times over the corpus. Throwing is correct in that frame precisely
   * because it is caught: the throw is what tells the speculation this was not a type. So
   * this must stay a THROW and must never record the refusal as a side effect.
   */
  private refuseUnknownName(id: string): void {
    // A generic DECLARATION's own type parameter — `type Box<T> = { v: T }`. `T` IS
    // declared (right there in the `<…>`, which is why `skipGenerics` collects it and why
    // NT2003 must not fire), but nothing SUBSTITUTES the type argument, so falling through
    // to the erasure made every instantiation the `number` shape whatever was written.
    //
    // That is the ambient half's bug from a third source, and it reproduces all three of
    // that bug's failures: a misattributed NT2001 ("'a' declared number[] but initialized
    // with string[]" for `type Arr<T> = T[]; const a: Arr<string> = ["x"]`), a misdirected
    // NT1002 ("number method 'toUpperCase'" on a value that is a string), and — the one
    // that proves it is not merely a bad message — INVALID IR: `type W<T> = T; const v = s
    // as W<string>; v + 1` reached clang as `store double %t1` against a `ptr`. The
    // checker never noticed the string had been retyped, exactly as it did not for
    // `s as unknown`. See test/type-erasure.test.ts.
    //
    // NT1013 because that is what the gap IS — the argument needs monomorphizing, not a
    // better name. It costs src/ nothing: the compiler's own source declares zero generic
    // `type`/`interface` aliases, and zero of the 871 fallback resolutions in a linked
    // `src/cli.ts` parse arrive from this source.
    //
    // AFTER the import/fragment arms would be wrong — this one is checked FIRST, but only
    // for a name those two do NOT also claim. `genericParamNames` is file-wide and
    // over-collected on purpose (see `skipGenerics`), and the standing rule for all three
    // sets is that over-collection may only ever PRESERVE today's behavior for a name, so a
    // `T` that is also an import binding keeps the old escape rather than gaining a refusal.
    if (this.genericParamNames.has(id) && !this.externalNames.has(id) && !this.fragmentNames.has(id)) {
      throw nyi(
        NYI.GENERIC,
        `the type parameter '${id}' of a generic type alias`,
        `'${id}' is a type PARAMETER, and nothing in this subset substitutes the type argument for it — so the declaration would silently become its \`number\` shape for every instantiation. Write the concrete type out, or declare one alias per instantiation (\`type ArrOfString = string[]\`)`,
        this.prevLoc(),
      );
    }
    // Imported (unseeded), or stripped by a fragment-parsing caller. STILL ERASES.
    //
    // MEASURED, because the previous note here over-stated this by conflating two
    // populations. Over a linked `src/cli.ts` parse — the real compile path, what
    // test/blocker-metric.ts measures — 871 resolutions land here and ALL 871 are imports
    // (`Ty` 330, `Expr` 235, `Stmt` 152; 144 of the 871 sit inside an assertion). The
    // "2,400" figure was the COVERAGE path, where 1,355 of 2,225 hits are `fragment` —
    // coverage strips every `type`/`interface` and hands the bare names back, so those are
    // an artifact of that tool and cannot occur in a real compile.
    //
    // So the CONFLATION is real but it is not what blocks a refusal: the fragment case
    // never arises here outside `coverage`. What blocks it is that an unseeded import is
    // genuinely declared one file over — `modules.ts` seeds `typeEnv` from the exporting
    // module's `finalTypes`, and a type that module refused for its own reason is simply
    // absent — so refusing would blame the annotation for a cause one file away, and would
    // refuse 871 sites of the compiler's own source. That diagnostic belongs to the linker,
    // which is the only pass that can tell "your dependency refused this type" from "no
    // such name". Reaching this line with an import name is exactly that condition.
    //
    // The silent wrong answer previously recorded here as motivation — a `lib.ts` recursive
    // `type Node`, a `main.ts` doing `xs as Node[]` — was NOT caused by this erasure. It
    // reproduced identically with a local, fully-resolved type and no import at all
    // (`type T = {v:string}; const raw = {v:"hi"}; const n = raw as T; console.log(n.v)`).
    // Root cause, found and fixed by the `as` lane: a DOUBLE FREE, not a retype. `as`
    // reinterprets a PLACE, so that declarator gives one allocation two owning names, and
    // `Ownership.expr` hard-coded `consume: false` for `AsExpr` where `satisfies` and `!`
    // both thread it — so the scope emitted two `nt_obj_free` calls for one pointer and the
    // allocator's double-free check raised SIGTRAP. That is why only an IDENTIFIER operand
    // failed (a cast object LITERAL has no other owner) and why stdout looked empty: the
    // abort discarded the buffered `hi` rather than never producing it. Kept here because
    // the misattribution, not the bug, is what would send the next reader to this line.
    if (this.isExternal(id)) return;
    // A global the program never had to declare — and one nothing above claimed, so
    // returning here would hand the caller its `number`. REFUSED instead (NT1035): the
    // name is real TypeScript, but `number` is not what it means, and a wrong type that
    // silently becomes a REAL type is the seed of a miscompile rather than a lost nicety.
    //
    // AFTER the `externalNames` arm, deliberately. A file may import a type whose name
    // collides with a lib global (`Set`, `Event`, `Console` are ordinary identifiers), and
    // for an import the "this is TypeScript's `Set`" reading is a guess. Refusing on it
    // would be a FALSE refusal on valid code, which is the one outcome the `AMBIENT_TYPES`
    // comment rightly calls worse than the erasure — so an imported name keeps the old
    // fallback and only a genuinely ambient one is refused.
    if (AMBIENT_TYPES.has(id)) {
      // The documented residue — see `ERASURE_STILL_ALLOWED`. Never inside an assertion,
      // which is the position where an erased type is ADOPTED instead of checked.
      if (!this.erasureIsFatal && ERASURE_STILL_ALLOWED.has(id)) return;
      throw nyi(
        NYI.AMBIENT_TYPE,
        `the type '${id}'`,
        ambientTypeHint(id),
        this.prevLoc(),
      );
    }
    const at = this.prevLoc();
    // Declared in this file as a CLASS, and not yet parsed — the class case of the same
    // ordering problem `declaredTypeLines` handles for `type`/`interface`, and it needs its
    // own arm because classes are NOT hoisted: `parseClass` registers the instance shape
    // (and a self-marker for uses inside the class's own body) only when it runs, so a name
    // used above it has no shape to substitute. That is an ordering failure, not a missing
    // name — reordering genuinely fixes it — so it is NT1030 with reordering advice rather
    // than NT2003. Reaching here at all proves the class is unparsed: once `parseClass` has
    // run, `typeAliases` answers and `resolveNamed` returns long before this point.
    if (this.declaredClassNames.has(id)) {
      this.blockedOn = id;
      throw nyi(
        NYI.FORWARD_TYPE,
        `use of class type '${id}' before its declaration${at === undefined ? "" : ` (used at line ${at.line})`}`,
        "a class is not hoisted the way `type`/`interface` is — its instance shape only exists once the class body has been parsed, so a class named in an annotation must be declared ABOVE its first use. Move the `class` declaration up; see docs/divergences.md",
      );
    }
    throw unknownTypeName(id, at);
  }

  /**
   * The position of the token just CONSUMED (`this.pos - 1`), or undefined before the
   * first one — the location every type-resolution refusal below points at.
   *
   * BOUNDS-CHECKED RATHER THAN COMPARED. The four callers each used to write
   *
   *     const t0 = this.toks[this.pos - 1];
   *     …  t0 === undefined ? undefined : { line: t0.line, col: t0.col }
   *
   * which is correct TypeScript under `noUncheckedIndexedAccess` and NT2001 here: an index
   * expression has the ELEMENT type in this subset, so comparing one with `undefined` has
   * no overlap to narrow. Asking the index instead answers exactly the same question, and
   * `this.pos - 1` is the only reachable way out — `pos` starts at 0 and never passes the
   * `eof` token, so the guard fires only at the very start of a parse.
   *
   * The fields are read through the index rather than through a bound `const t`: binding
   * one MOVES the record out of the array (NT1605), which is a second refusal the same
   * spelling used to carry.
   */
  private prevLoc(): { line: number; col: number; file?: string } | undefined {
    const i = this.pos - 1;
    if (i < 0 || i >= this.toks.length) return undefined;
    // `file` is carried, not omitted. A fileless span is rendered against the ENTRY
    // source (src/cli.ts::diagSources skips it), so every one of these type-resolution
    // refusals used to underline the wrong file's line whenever it fired in an IMPORTED
    // module — the same defect the `delete` refusal in `parseUnary` had. It is also what
    // makes the record fit `nyi`'s `{line,col,file?}` parameter in this subset, which has
    // no width subtyping: `{line,col}` is a DIFFERENT type here, not a narrower one.
    return { line: this.toks[i]!.line, col: this.toks[i]!.col, file: this.file };
  }

  /** The LINE of the token just consumed, or `fallback` before the first one — the
   *  `this.toks[this.pos - 1]?.line ?? fallback` spelling, without the optional chain on
   *  an index (NT1002). Identical for a real token, including line 0. */
  private prevLine(fallback: number): number {
    const i = this.pos - 1;
    return i < 0 || i >= this.toks.length ? fallback : this.toks[i]!.line;
  }

  /**
   * The token `o` ahead — a COPY of it, not the element.
   *
   * `return this.toks[i]!` is `NT1605`: an array element is a borrow, the array owns it
   * and frees it, so handing it out makes a second owner of one pointer. The refusal's
   * hint prescribes reading THROUGH the index, and a `Token` is four scalars, so building
   * one field by field is exactly that — every read is a copy and the array keeps its
   * element. 130 call sites are unchanged, which is why the copy lives here rather than
   * at each of them.
   *
   * IT IS ONLY SOUND BECAUSE NOTHING WRITES A TOKEN. `eatTypeClose` used to (it split a
   * `>>` in place, and callers observed that through the alias `peek` handed back); that
   * mutation is now parser-local state, and it was the only one in this file. A future
   * write to a peeked token would be LOST rather than refused, so it is pinned by
   * test/generics.test.ts's nested-close cases, which are precisely what would break.
   */
  private peek(o = 0): Token {
    const i = this.pos + o;
    return { type: this.toks[i]!.type, value: this.toks[i]!.value, line: this.toks[i]!.line, col: this.toks[i]!.col };
  }
  private next(): Token { const t = this.peek(); this.pos++; return t; }
  private at(v: string): boolean {
    const t = this.peek();
    return (t.type === "punct" || t.type === "ident") && t.value === v;
  }
  private eat(v: string): Token {
    if (!this.at(v)) {
      const t = this.peek();
      throw parseError(`Expected '${v}' but found '${t.value || t.type}' at ${t.line}:${t.col}`);
    }
    return this.next();
  }
  private expectIdent(): string {
    const t = this.peek();
    if (t.type !== "ident") throw parseError(`Expected identifier at ${t.line}:${t.col}`);
    return this.next().value;
  }
  /**
   * A `PropertyName`, as the STRING it names — which for a `NumericLiteral` is not its
   * source text. ECMA-262 `PropName` of a `NumericLiteral` is `ToString(ToNumber(literal))`,
   * so `{ 1e3: … }` names the property `"1000"`, `{ 0x10: … }` names `"16"`, and `{ 1.0: … }`
   * names `"1"`. Returning the token spelling named three properties that do not exist.
   *
   * It hid for so long because the CANONICAL spellings — `0`, `1`, `42`, `0.5` — are their
   * own `ToString(ToNumber(…))`, and those are what a hand-written test reaches for. The
   * forms that differ are the ones nobody types twice.
   *
   * `String(Number(text))` and not a hand-rolled decoder: the lexer keeps radix-prefixed
   * literals as raw text precisely so this one round trip decodes every form — `0x`/`0b`/`0o`
   * either case, exponents, a bare trailing `.` — and `Number::toString`'s own switch to
   * exponential notation (`1e21` → `1e+21`, `1e-7` → `1e-7`) is then node's by construction
   * rather than by imitation. The `_` separator is already dropped by the lexer, which is
   * required: `Number("1_000")` is `NaN`.
   *
   * The normalized key then feeds the array-index rule (`isArrayIndexKey`), so this fixes
   * the key's POSITION as well as its name — `1e3` is not an index spelling but `1000` is.
   * It cannot manufacture a false index: the predicate still tests the canonical spelling,
   * and `1e-7`/`1.5` canonicalize to forms it rejects.
   */
  private expectKey(): string {
    const t = this.peek();
    if (t.type === "ident") { this.next(); return t.value; }
    // Only a QUOTED key can carry text the type encoding cannot hold — an identifier is
    // safe by construction, and a numeric key is now `String(Number(…))`, which is digits,
    // `.`, `-`, `+`, `e`, `Infinity` or `NaN`. Refused here, at the one production that
    // still knows the key's source position, rather than downstream where the corrupted
    // type string no longer remembers which key wrecked it. NT1040.
    if (t.type === "str") {
      this.next();
      if (!keyIsEncodable(t.value)) {
        throw nyi(NYI.KEY_ENCODING, `the object key ${JSON.stringify(t.value)} at ${t.line}:${t.col} (its text would be read as type syntax)`, undefined, { line: t.line, col: t.col });
      }
      return t.value;
    }
    if (t.type === "num") { this.next(); return String(Number(t.value)); }
    throw parseError(`Expected property key at ${t.line}:${t.col}`);
  }

  parseProgram(): Program {
    this.hoistTypeDecls();
    //@@mutable
    let body: Stmt[] = [];
    while (this.peek().type !== "eof") body.push(this.parseStatement());
    this.checkFloatingAsyncCalls(body);
    this.checkAsyncEscapes();
    // Class members lower to top-level functions (`C.constructor`, `C.method`) so they
    // register + hoist alongside ordinary functions for the checker/codegen.
    //
    // A SPREAD, not a push loop. `for (const f of this.hoistedFns) body.push(f)` moves each
    // element out of the for-of binding, which is a BORROW of the array's element — NT1604,
    // and pushing it elsewhere would make a second owner. Spreading both arrays into one
    // literal is the bulk move the loop was spelling by hand: it consumes `hoistedFns`
    // whole (nothing reads it after this), keeps the order, and owns one array at the end.
    // `body.push(...this.hoistedFns)` is not the alternative — a spread into a variadic
    // call is NT1006.
    body = [...body, ...this.hoistedFns];
    // A static field is a module-level `const C.f` (see `parseClass`), so every `C.f` READ
    // becomes that identifier — here, once the whole file is parsed, because a function
    // body may legally read a static of a class declared further down.
    if (this.staticFieldNames.size) {
      // The rewrite is by NAME and has no scope, so a binding that shadows the class name
      // would redirect `C.f` to the static instead of the shadowing value — a silent wrong
      // answer. Refuse the program instead (reject, never miscompile).
      const bound = collectBindingNames(body);
      for (const f of this.staticFieldNames) {
        const cls = f.slice(0, f.indexOf("."));
        if (bound.has(cls)) throw nyi(NYI.CLASS_FEATURE, `a binding shadows class '${cls}', which has static fields (\`${f}\`); rename it`);
      }
      // ANNOTATED. The contextual type from `resolveStaticFieldReads`'s `onAssign?:
      // (name: string, at: Loc | undefined) => never` does not reach an arrow parameter
      // through an OPTIONAL parameter position here, so both are spelled out — this was
      // the first blocker of five of the twelve modules, and it took giving the diagnostic
      // a location to find (`ArrowFunction.loc`; it named `n` at three sites and pointed
      // at none of them).
      body = resolveStaticFieldReads(body, this.staticFieldNames, (n: string, at: Loc | undefined) => {
        throw mutationError(`assignment to the static field '${n}'`,
          "a static field is module-level storage initialized once where the class is declared — it is a `const`, so give the class a static METHOD that returns the value you want instead; for state that CHANGES (`C.f++`, `C.f += 1`), use a module-level `let`, or a field of a `@@mutable` class instance",
          at);
      });
    }
    // BUILT IN ONE CONSTRUCTION, not assembled by seven conditional field writes.
    // `program.mutableClasses = …` is NT1606 ("objects are immutable") and was the first
    // blocker of five of the twelve modules; every field here is OPTIONAL, so `undefined`
    // means exactly what "not attached" meant before and an ordinary program's `Program`
    // is unchanged. The same move `check` needed for `program.body` in src/checker.ts.
    //
    // Recursive-type shapes: a `Map` spread would give `[string, Ty][]`, a TUPLE array —
    // see `Program.recTypes` for why it is a record instead.
    //@@mutable
    const recs: RecTypeEntry[] = [];
    for (const [n, shape] of this.recTypes) recs.push({ name: n, ty: shape });
    // Bound to a LOCAL, then written back: a method call on a nullable FIELD receiver is
    // NT1002 even under a guard, because narrowing needs a stable access path and
    // `this.<field>` is not one. Same shape as `sub.blockedOn` above.
    const collect = this.collectTypes;
    if (collect !== undefined) {
      let acc = collect;
      for (const [k, v] of this.typeAliases) acc = acc.set(k, v);
      this.collectTypes = acc;
    }
    let types = new Map<string, Ty>();
    for (const n of this.exportTypes) { const t = this.typeAliases.get(n); if (t) types = types.set(n, t); }
    const hasExports = this.exportValues.size > 0 || this.exportReexports.size > 0 || this.exportTypes.size > 0;
    const program: Program = {
      kind: "Program",
      body,
      mutableClasses: this.mutableClasses.size ? [...this.mutableClasses] : undefined,
      mutableRecords: this.mutableRecords.size ? [...this.mutableRecords] : undefined,
      recTypes: this.recTypes.size ? recs : undefined,
      hostImports: this.hostImports.size ? [...this.hostImports] : undefined,
      imports: this.imports.length ? this.imports : undefined,
      textImports: this.textImports.length ? this.textImports : undefined,
      exports: hasExports
        ? { values: this.exportValues, reexports: this.exportReexports, types, asyncValues: this.exportAsync }
        : undefined,
    };
    return program;
  }

  /**
   * Reject calling an `async function` without `await` — under node that yields a
   * *Promise* (and lets the caller interleave); here the body already ran to
   * completion, so anything that uses the value, or that expects other code to run
   * while it is pending, would silently diverge. The ONE allowed exception is the
   * canonical entrypoint `main();` as the LAST top-level statement: with nothing
   * after it, node's "suspend, run the rest, resume" and our "run it now" produce
   * identical output. Everything else is NT1020, pointing at the actor model
   * (`spawn`/`send`/`receive`) for actual concurrency.
   */
  private checkFloatingAsyncCalls(body: Stmt[]): void {
    // THE ENTRYPOINT IS FOUND BY ITS INDEX IN `identCalls`, not by holding its node.
    //
    // This used to bind `const last = body[body.length - 1]!` and then `last.expr`, which
    // is NT1605 twice over: an array element is a borrow, and so is a linear field read out
    // of one. A COPY is not available here either — the test below is `c.node === …`, an
    // IDENTITY comparison, and a copy is a different object. So the pass runs the other way
    // round: walk `body` once, and at its last statement ask which `identCalls` entry (if
    // any) that statement's expression IS. Everything that escapes the walk is an `int`.
    //
    // Never index -1: an empty body is ordinary, and there node answers `undefined` while
    // nativets PANICS on the read (test/tsc.test.ts). The walk handles it by never running.
    let entryIdx = -1;
    let seen = 0;
    for (const s of body) {
      seen++;
      if (seen !== body.length || s.kind !== "ExprStmt") continue;
      let j = 0;
      for (const c of this.identCalls) {
        if (c.node === s.expr) entryIdx = j;
        j++;
      }
    }
    let idx = -1;
    for (const c of this.identCalls) {
      idx++;
      if (!(c.scopedAsync || this.asyncFns.has(c.name))) continue;
      if ((c.node.kind === "CallExpr" && (c.node.awaited ?? false)) || idx === entryIdx) continue;
      throw nyi(
        NYI.ASYNC,
        `calling async function '${c.name}' without 'await' at ${c.line}:${c.col} (its value is a Promise under node; nativets runs it to completion immediately)`,
      );
    }
  }

  /**
   * Reject handing an async function VALUE to a parameter that is not declared to receive
   * one. `checkFloatingAsyncCalls` re-establishes async-ness on the far side of a call from
   * the parameter's declared type (`(…) => Promise<T>`) — so an escape is safe exactly when
   * the callee declares that type at that position. Everything else drops the promise on
   * the floor: `twice(f: () => number)` given an async arrow computes `1 + 1` where node
   * concatenates two pending promises. An unknown callee (a method, a builtin, a value) is
   * also an escape, because there is no declared parameter to carry the fact.
   */
  private checkAsyncEscapes(): void {
    const why = "(under node the value it returns is a Promise, so the promise would be dropped)";
    for (const e of this.asyncEscapes) {
      if (!this.isAsyncValue(e.asyncArrow, e.argName, e.scopedAsync)) continue;
      if (e.callee !== null && (this.promiseParamsByFn.get(e.callee) ?? []).includes(e.index)) continue;
      const shown = e.argName !== null ? `'${e.argName}'` : "an async arrow";
      const where = e.callee !== null ? `to '${e.callee}'` : "to a call";
      throw nyi(
        NYI.ASYNC,
        `passing async function ${shown} as argument ${e.index + 1} ${where} at ${e.line}:${e.col} ` +
        `— that parameter is not declared '(…) => Promise<T>' ${why}`,
      );
    }
    for (const r of this.returnEscapes) {
      if (r.declared || !this.isAsyncValue(r.asyncArrow, r.argName, r.scopedAsync)) continue;
      const shown = r.argName !== null ? `'${r.argName}'` : "an async arrow";
      throw nyi(
        NYI.ASYNC,
        `returning async function ${shown} at ${r.line}:${r.col} from a function whose return type ` +
        `is not declared '(…) => Promise<T>' ${why}`,
      );
    }
  }

  /** Is this escaped value an async function? `scopedAsync` was decided at the escape (it
   *  depends on the parameter scope there); a NAME is resolved now, so a hoisted
   *  `async function` declared later than the escape still counts. */
  private isAsyncValue(asyncArrow: boolean, name: string | null, scopedAsync: boolean): boolean {
    return asyncArrow || scopedAsync || (name !== null && this.asyncFns.has(name));
  }

  /** The `(…) => Promise<T>` parameter names of the frames open OUTSIDE this parser — the
   *  `asyncParamScopes` twin of `inheritedTypeParams`, flat for the same reason. */
  private inheritedAsyncParams = new Set<string>();

  /** Is `n` a `(…) => Promise<T>` parameter of some enclosing body being parsed? */
  private inAsyncParamScope(n: string): boolean {
    if (this.inheritedAsyncParams.has(n)) return true;
    for (const s of this.asyncParamScopes) if (s.includes(n)) return true;
    return false;
  }

  // ---- types (permissive; we only need scalars precisely) ----
  /**
   * A type ANNOTATION. `parseTypeInner` does the real work and keeps string-literal
   * types (`"square"`) intact, because they are what makes a union discriminated;
   * this wrapper WIDENS them away again for every type that is not itself a union.
   * That is what keeps `let d: "n" | "s"` collapsing to `string` (and a literal field
   * of an ordinary record typed `string`) while `type Shape = Square | Circle` keeps
   * the tags it needs. `widenLiteralTys` deliberately does not descend into a nested
   * `U<…>`, so `{ s: Shape }` keeps the union's tags too.
   */
  private parseType(): Ty {
    const t = this.parseTypeInner();
    return isUnionTy(t) ? t : widenLiteralTys(t);
  }
  // A type is a union of atoms. Supported: the two NULLABLE shapes `T | undefined` /
  // `T | null` (either arm order); a union of literal atoms that COLLAPSE to one base
  // (`"a" | "b" | "c"` → string); and a DISCRIMINATED union of object types (SH2).
  // Anything else is rejected with an NYI code (never miscompiled).
  private parseTypeInner(): Ty {
    if (this.at("|")) this.next(); // leading union bar: `type X = | A | B`
    //@@mutable
    const arms: Ty[] = [this.parseTypeAtom()];
    let sawIntersect = false;
    while (this.at("|") || this.at("&")) { if (this.at("&")) sawIntersect = true; this.next(); arms.push(this.parseTypeAtom()); }
    if (arms.length === 1) return arms[0]!;
    // Literal arms of the same base collapse (`"a" | "b"` → string), exactly as before.
    // The arrow is written out rather than passed by NAME: `.map(widenLiteralTys)` is a
    // first-class function value, which this subset refuses (NT1003). It is also the safer
    // spelling in plain TypeScript — `.map` hands the callback (value, index, array), so a
    // by-name callee silently gains two arguments it never declared.
    const uniq = [...new Set(arms.map((a) => widenLiteralTys(a)))];
    if (uniq.length === 1) return uniq[0]!;
    if (!sawIntersect && uniq.length === 2) {
      const [a, b] = uniq as [Ty, Ty];
      if (a === "undefined" || a === "null") return makeNullable(a, b);
      if (b === "undefined" || b === "null") return makeNullable(b, a);
    }
    if (!sawIntersect) {
      // NULLISH HOIST. `T | undefined` / `T | null` is the two-arm case just above; with
      // THREE or more arms the nullish one is still not a union member — it is the
      // existing `?U`/`?N` encoding's tag — so lift it out and build the rest as an
      // ordinary discriminated union. `src/ast.ts`'s `ForStmt.init: VarDecl | Expr | null`
      // is the forcing case. Exactly ONE distinct nullish arm: `?U`/`?N` has room for one
      // (the runtime tag is 0=undefined / 1=null / 2=present but `Ty` spells only one), so
      // `A | B | null | undefined` stays refused rather than silently losing an arm.
      const nullish = [...new Set(uniq.filter((a) => a === "undefined" || a === "null"))];
      if (nullish.length === 1) {
        const rest = arms.filter((a) => a !== "undefined" && a !== "null");
        if (rest.length >= 2) {
          const inner = this.discriminatedUnion(rest);
          if (inner) return makeNullable(nullish[0] as "undefined" | "null", inner);
        }
      }
      const u = this.discriminatedUnion(arms);
      if (u) return u;
      // A GENERAL union: nothing inside the value distinguishes the arms, so it is
      // boxed [tag, value] and `typeof` is the discriminant. Only arms `typeof` can
      // actually tell apart are accepted — see `generalUnionArmsOk`.
      if (uniq.every((a) => isGeneralUnionArm(a)) && new Set(uniq.map((a) => generalUnionArmTypeof(a))).size === uniq.length) return makeGeneralUnionTy(uniq);
    }
    throw nyi(NYI.OPTIONAL_CHAIN, `general union type '${arms.map((a) => widenLiteralTys(a)).join(sawIntersect ? " & " : " | ")}' (only 'T | undefined' / 'T | null', a DISCRIMINATED union of object types — a common literal-typed tag field at the same position in every member — and a general union of arms \`typeof\` can tell apart are supported)`);
  }

  /**
   * Build a discriminated union from `arms`, or return null if they are not all object
   * types (letting the caller report the general-union refusal). Arms that ARE all
   * objects but carry no usable discriminant get a precise refusal here instead —
   * "you wrote a union of records but I cannot tell them apart" is a different and
   * far more actionable message than "general union".
   */
  private discriminatedUnion(rawArms: Ty[]): Ty | null {
    // THE UNION-MEMBER RULE (Lane C). A member may not be a bare `@Name`. There is no box
    // (SH2): a union value IS the member's object block, and `unionDiscriminant` proves the
    // tag sits at the SAME slot index in every member — which needs each member's SHAPE.
    // So a reference is expanded ONE LEVEL at the member boundary and only references BELOW
    // it are left folded:
    //     U<{kind:"Negate",operand:@Expr}|…>     not   U<@Negate|…>
    // The expansion is one level, not transitive, so it stays finite even when the member's
    // own fields point back at this very union.
    //
    // MEASURED, not argued: `objectFields("@N")` returns `[]`, so `unionDiscriminant` on
    // `U<@A|@B>` returns undefined and the union is REFUSED (NT1009) rather than silently
    // built with a phantom tag. Getting this rule wrong costs a refusal, never a
    // miscompile — see test/forward-type-ref.test.ts.
    // FLATTENING. TypeScript flattens `A | (B | C)` to `A | B | C`, and so does this: an
    // arm that is itself a `U<…>` contributes its MEMBERS, not itself. Without it a nested
    // arm reaches `arms.every(isObjectTy)` as a `U<…>` — not an object type — and the whole
    // union is misreported as "general". `src/ast.ts` needs it twice over, since `Expr` and
    // `Stmt` are aliases that other unions select over.
    //
    // The flattened result is an ORDINARY union: `unionDiscriminant` below still has to
    // prove the tag sits at the same slot index in every spliced member, and a nested
    // union's members already satisfy that among THEMSELVES, never across the splice. So
    // flattening widens what is ACCEPTED without weakening the invariant — the failure mode
    // is still the NT1009 refusal below, never a phantom tag.
    //@@mutable
    const arms: Ty[] = [];
    for (const a of rawArms.map((a) => expandTypeRef(a, this.recTypes))) {
      // Appended one at a time: `push(...xs)` is a SPREAD into a variadic call, which this
      // subset refuses (NT1006). Same order, same result.
      if (isUnionTy(a)) { for (const m of unionMembers(a)) arms.push(m); } else arms.push(a);
    }
    // THE TAG RULE. `classTag(a) === undefined` used to be required of every arm. That
    // clause dates to SH2 behavior 1, when the only carrier of a tag was a CLASS instance
    // — and for that subject it is VACUOUS: a class field annotation is parsed with
    // `parseType`, which WIDENS a string-literal type, so a class instance type can never
    // hold the literal-typed discriminant `unionDiscriminant` demands. Removed outright,
    // a union of two classes still fails one step below with "not string-literal typed".
    //
    // Its only LIVE effect was to block a `@@mutable` RECORD, which did not exist when it
    // was written and whose fields ARE parsed with `parseTypeInner` (literals kept). A
    // tagged record is a sound member for the same reason the whole encoding works: there
    // is no box, a union value IS the member's object block, and a tagged block has the
    // same slots as an untagged one — the tag is a NAME the checker reads for mutability
    // and method resolution, never a runtime word.
    //
    // So the relaxation is exactly as wide as the dead guard was: a tag is admitted only
    // when it names a `@@mutable` record declared here. A CLASS-tagged arm still returns
    // null, so it keeps the byte-identical general-union refusal it has today rather than
    // falling through to a different (and, for a class, less accurate) message.
    const armTagOk = (a: Ty): boolean => {
      const tag = classTag(a);
      return tag === undefined || this.mutableRecords.has(tag);
    };
    if (!arms.every((a) => isObjectTy(a) && armTagOk(a))) return null;
    const members = [...new Set(arms)];
    const shown = members.map((m) => widenLiteralTys(m)).join(" | ");
    if (members.length < 2) return null;
    const ty = makeUnionTy(members);
    const d = unionDiscriminant(ty);
    if (d) return ty;
    // Say WHICH way it failed — a missing tag field, a non-literal tag, a duplicated
    // tag value, or a tag at a different position in different members.
    const keys = members.map((m) => objectFields(m).map((f) => f.key));
    const common = keys[0]!.filter((k) => keys.every((ks) => ks.includes(k)));
    const why =
      common.length === 0
        ? "the members share no field at all, so nothing can tell them apart"
        : common.some((k) => members.every((m) => hasStringLitField(m, k)))
          ? `the shared tag field must sit at the SAME position in every member and carry a DISTINCT string-literal type in each (shared fields: ${common.join(", ")})`
          : `the shared field(s) ${common.join(", ")} are not string-literal typed — a discriminant needs \`kind: "a"\`, not \`kind: string\``;
    throw nyi(NYI.OPTIONAL_CHAIN, `union of object types '${shown}' without a usable discriminant — ${why}`);
  }
  // A single type atom: literal / function / object / tuple / import-type /
  // scalar-or-named, plus `[]` suffixes and `["key"]` lookups.
  private parseTypeAtom(): Ty {
    let base: Ty;
    let baseName: string | undefined; // source spelling of `base`, for the lookup diagnostic
    const t = this.peek();
    // A string-literal type is KEPT as `"a"` here; `parseType` widens it back to
    // `string` unless it ends up as a union member's discriminant (see above).
    if (t.type === "str") {
      this.next();
      base = tagValueIsEncodable(t.value) ? stringLitTy(t.value) : "string";
    }
    else if (t.type === "num") { this.next(); base = "number"; }   // numeric-literal type: 0
    // A TEMPLATE-LITERAL type (`` `${string}[]` ``) erases to plain `string`: the raw
    // inner text is dropped and the pattern is NOT enforced. A pattern that only ever
    // constrains type-level strings cannot reach emitted code, and node — which strips
    // types without checking them — has no opinion to disagree with. Recorded as a
    // deliberate divergence in docs/divergences.md.
    else if (t.type === "template") { this.next(); base = "string"; }
    else if (this.at("(")) base = this.parseParenOrFuncType();
    else if (this.at("{")) base = this.parseObjectType();
    else if (this.at("[")) base = this.parseTupleType();
    else if (this.at("import")) base = this.parseImportType();    // inline import type: import("m").T
    // A TYPE QUERY (`typeof x`) or the `keyof` operator. Refused HERE, before the name
    // path below can absorb the KEYWORD as if it were a type: both sit in `AMBIENT_TYPES`,
    // so `resolveNamed("typeof")` used to answer `number` and leave the OPERAND in the
    // token stream, where it re-parsed as a stray expression statement — silently for
    // `typeof S` (the stray `S;` is legal, so `X` just quietly meant `number`) and as
    // `'T' is not defined` for `keyof T`, a diagnostic naming a line nobody wrote.
    else if (this.at("typeof") || this.at("keyof")) base = this.refuseTypeQuery();
    else {
      const id = this.expectIdent();
      baseName = id;
      if (id === "true" || id === "false") base = "boolean";       // boolean-literal type
      else if (this.at("<")) base = this.parseGenericType(id);      // `Name<...>` — erase the args
      else base = this.resolveNamed(id);
    }
    // `[` after a type atom is one of TWO constructs, told apart by what follows it: an
    // empty `[]` is the array suffix, anything else is an indexed access (lookup) type.
    // Before this split the loop ate both brackets unconditionally, so every `T["k"]`
    // died here as an anonymous `Expected ']'`.
    let suffix = "";
    while (this.at("[")) {
      this.eat("[");
      if (this.at("]")) {
        this.eat("]");
        // `((n: number) => number)[]` — an ARRAY OF FUNCTIONS. Refused HERE, at the one
        // place source can form it, because the `Ty` encoding cannot tell it apart from
        // a function RETURNING an array: the suffix is not parenthesized, so
        //   makeFuncTy(["number"], "number[]")      === "(number)=>number[]"
        //   makeFuncTy(["number"], "number") + "[]" === "(number)=>number[]"
        // are the same string. `isArrayTy` reads it as the function (see ast.ts — the
        // alternative was a wild free on `const g = () => arr`), so letting the
        // annotation through would type an array of functions AS a function.
        // Arrays of functions are already NT1001 in their array-literal spelling
        // ("arrays of X is not supported yet", checker.ts); this gives the annotation
        // the SAME diagnostic instead of a downstream one about the empty literal.
        // Whoever implements them has to fix the encoding first, which is the point.
        if (isFuncTy((base + suffix) as Ty)) throw nyi(NYI.ARRAY, `arrays of ${base}${suffix}`);
        // `makeArrayTy`, not `+= "[]"` — a NULLABLE element parenthesizes, or the prefix
        // encoding swallows the suffix and `(T|null)[]` reads as `T[]|null` (see ast.ts).
        base = makeArrayTy((base + suffix) as Ty);
        if (baseName !== undefined) baseName = baseName + suffix + "[]"; // keep the lookup diagnostic's spelling
        suffix = "";
        continue; // T[], T[][]
      }
      base = this.parseIndexedAccessTy((base + suffix) as Ty, (baseName ?? base) + suffix);
      suffix = "";
      baseName = undefined;
    }
    return (base + suffix) as Ty;
  }

  /**
   * `typeof x` / `keyof T` in TYPE position — always a refusal, never a `Ty`.
   *
   * Neither can be ANSWERED here, and that is the whole argument for refusing rather than
   * implementing. `Ty` is produced by this parser, before any inference has run, so a type
   * query has no value environment to ask for `x`'s type; and `keyof T` has no `Ty`
   * inhabitant at all — "one of these keys" is the same unrepresentable thing `NT1029`
   * already refuses for `T[keyof T]`.
   *
   * It has to be the PARSER that says so, for the reason `refuseUnknownName` gives: the
   * erasure to `number` is destructive, and once it has happened no later pass can tell the
   * result from a `number` the user wrote.
   *
   * Resolving `typeof S` for the narrow case that IS decidable here — a `const` with a
   * literal initializer — was considered and rejected. It puts the accept/reject boundary
   * on the SYNTAX of the initializer (`const S = "a"` would compile, `const S = f()` would
   * keep erasing silently), which is exactly the trade docs/self-hosting.md rejected for a
   * `new Map`-position-only entries form: a partial answer that keeps the silent case is
   * worse than no answer.
   *
   * SPECULATION-SAFE, like `refuseUnknownName`: `tryCallTypeArgs` backtracks on any throw,
   * so this must stay a throw with no side effect.
   */
  /**
   * `: Ty`, not `: never`. The body always throws, so both are true — but `never` is not
   * modelled here (it erases to `number`, see `AMBIENT_HINTS`), so
   * `base = this.refuseTypeQuery()` was `Cannot assign number to string 'base'`: the FIRST
   * BLOCKER of five of the twelve modules through the link, on a call that cannot return.
   *
   * `Ty` is the type the one call site wants and the type the function would produce if it
   * produced anything, which is exactly what that hint prescribes ("write what the function
   * would return if it returned"). tsc still proves the body diverges.
   */
  private refuseTypeQuery(): Ty {
    const kw = this.next().value;                  // `typeof` / `keyof`
    const operand = this.peek();
    const shown = operand.type === "ident" || operand.type === "str" ? `${kw} ${operand.value}` : kw;
    throw nyi(
      NYI.TYPE_QUERY,
      kw === "typeof"
        ? `the type query '${shown}' (a \`typeof\` in TYPE position)`
        : `the type operator '${shown}'`,
    );
  }

  /**
   * An indexed access type `T["key"]` (TypeScript's "lookup type"), the `[` already eaten.
   *
   * Resolved PRECISELY or not at all. When `base` is a record whose fields are known here
   * and `key` is a string literal naming one of them, the lookup BECOMES that field's
   * type — exact, no erasure. Every other shape is refused as NT1029, saying which way it
   * failed, because a lookup's result decides how the annotated value is stored and
   * printed: guessing it would be a silent wrong answer, not a lost type-level nicety.
   *
   * `display` is the SOURCE spelling of the base (`resolveNamed` has usually erased the
   * name away by now), so the message names what was actually written.
   */
  private parseIndexedAccessTy(base: Ty, display: string): Ty {
    const t = this.peek();
    if (t.type !== "str") {
      // `T[number]`, `T[K]`, `T[keyof T]` — an index that is not one named field.
      throw nyi(
        NYI.INDEXED_ACCESS,
        `indexed access type '${display}[${t.value || t.type}]' — the index is not a string literal`,
        `only a single named field can be looked up: \`${display}["someField"]\`. \`T[number]\` (array element), \`T[K]\` and \`T[keyof T]\` would each have to stand for several types at once, which this subset has no way to represent — name the field, or write its type directly`,
      );
    }
    this.next();
    this.eat("]");
    const key = t.value;
    if (!isObjectTy(base)) {
      // Includes the common cross-module case: an unknown named type erases to `number`
      // in `resolveNamed`, so its fields never reach this file at all.
      throw nyi(
        NYI.INDEXED_ACCESS,
        `indexed access type '${display}["${key}"]' — '${display}' is not a record type whose fields are known in this file`,
        `a lookup needs the base's fields at hand: declare '${display}' as a \`type\`/\`interface\` in THIS file, or write the field's type directly instead of looking it up`,
      );
    }
    // First match wins and the type is returned BY VALUE, exactly as `.find(…)` then
    // `.ty` did. Written as a loop because `.find` over an array of records is NT1001 in
    // the subset this file has to stay inside — see `hasStringLitField`.
    for (const x of objectFields(base)) if (x.key === key) return x.ty;
    const have = objectFields(base).map((x) => x.key);
    throw nyi(
      NYI.INDEXED_ACCESS,
      `indexed access type '${display}["${key}"]' — '${display}' has no field '${key}'`,
      have.length === 0
        ? `'${display}' has no fields to look up`
        : `'${display}' has: ${have.join(", ")}`,
    );
  }
  /**
   * Inline import type `import("./mod").Name` (optionally qualified) — resolved to the
   * referenced named type, or REFUSED. The module path is dropped either way.
   *
   * Dropping the path is what makes this a resolution problem rather than a lookup: the
   * only thing left to resolve is the bare `Name`, against THIS file's scope. That works
   * whenever the file already has the name — a `type`/`interface` declared here, or a
   * seeded `import type` — and `import("./m").T` then means exactly what `T` means.
   *
   * When it does not, the name reaches `resolveNamed`'s `number` fallback, and until
   * NT1035 that is what the annotation silently became. It is live in this tree:
   * src/coverage.ts:167 writes `new Map<string, import("./ast.ts").Ty>()`, and `Ty` is a
   * structural type STRING, so the map's value type quietly said `number` instead.
   *
   * `erasedImportOf` is how the fallback is intercepted rather than inspected: the answer
   * IS `number`, indistinguishable from a `number` the user wrote, so there is nothing to
   * test after the call. Cleared in a `finally` — `resolveNamed` throws on several paths
   * (a forward reference, a recursive type), and a flag left set would make the next
   * unrelated name in this file report as an import type.
   */
  private parseImportType(): Ty {
    this.eat("import"); this.eat("(");
    const path = this.next().value;                 // module path string literal
    this.eat(")"); this.eat(".");
    let name = this.expectIdent();
    while (this.at(".")) { this.eat("."); name = this.expectIdent(); } // import("m").Ns.Type
    // The name belongs to the OTHER module, so "declared nowhere in this file" says nothing
    // about it — NT2003 would be a false refusal by construction. This escape suppresses it;
    // `erasedImportOf` is what stops the suppression from becoming a silent `number`.
    this.externalNames = this.externalNames.add(name);
    this.erasedImportOf = path;
    try { return this.resolveNamed(name); } finally { this.erasedImportOf = undefined; }
  }
  // A generic type reference `Name<T, U>` in type position. Generics carry no runtime
  // in this subset, so the arg list is parsed for grammar and then ERASED to a concrete
  // supported shape (never miscompiled): container/wrapper/utility types map to their
  // erasure; a type parameter or unknown generic falls back through `resolveNamed`.
  private parseGenericType(id: string): Ty {
    // `Extract` is the one utility type here that READS its arguments rather than
    // discarding them, and the tag it selects on is a string-LITERAL type — which
    // `parseType` widens to `string` on its way out. So its argument list is parsed with
    // literals kept; everything else is untouched, because a literal that escapes into an
    // ordinary annotation is the thing `parseType`'s wrapper exists to prevent.
    const a = this.parseTypeArgs(id === "Extract");
    switch (id) {
      // `Readonly*` is a compile-time-only distinction in TypeScript, and nativets'
      // Map/Set/array ARE immutable (B2: `.set`/`.add` return a new collection), so the
      // readonly spellings are the same types. Without these two cases they fell through
      // `default:` and an unknown named type erases to `number` — a guess that turned a
      // program node runs into `'m' declared number but initialized with Map<…>`.
      case "Map":
      case "ReadonlyMap": return makeMapTy(a[0] ?? "string", a[1] ?? "number");
      case "Record": return makeMapTy(a[0] ?? "string", a[1] ?? "number"); // dictionary → Map
      case "Set":
      case "ReadonlySet": return makeSetTy(a[0] ?? "string");
      case "Array":
      case "ReadonlyArray": return makeArrayTy(a[0] ?? "number");          // Array<T> → T[]
      // single-arg wrapper/mapped types erase to their inner type
      case "Promise":
      case "Awaited":
      case "Partial":
      case "Required":
      case "Readonly":
      case "NonNullable": return a[0] ?? "number";
      // `Extract<T, U>` RESOLVES rather than erases — see `extractType`.
      case "Extract": return this.extractType(a[0] ?? "number", a[1]);
      // multi-arg utility types erase to their first (subject) type argument
      case "Exclude":
      case "Omit":
      case "Pick":
      case "Parameters":
      case "ReturnType": return a[0] ?? "number";
      // unknown generic / type parameter used with args: erase args, resolve the base name
      default: return this.resolveNamed(id);
    }
  }
  /**
   * `Extract<T, U>` — the members of `T` assignable to `U`, TypeScript's
   * `T extends U ? T : never` distributed over `T`.
   *
   * WHY IT IS RESOLVED HERE AND NOT ERASED. It sat in `parseGenericType`'s "multi-arg
   * utility types erase to their first (subject) type argument" group, which made
   * `Extract<Expr, { kind: "ArrowFunction" }>` the whole 30-member `Expr` union — so every
   * field read on such a PARAMETER was refused, since a field is readable off an un-narrowed
   * union only when it sits at the same slot with the same widened type in every member.
   * That was 31 of 136 remaining `NT2001` blockers over the linked stage-1 program, the
   * largest single bucket, and it is not a narrowing gap at all: there is nothing to narrow,
   * the parameter's declared type IS the member. `tsc` is authoritative about what a type
   * means and it sees the member; erasing to `T` was us disagreeing with it about a type.
   *
   * IT SELECTS; IT NEVER REINTERPRETS. The result is a member of `T` handed back unchanged,
   * so the value is always read at its own layout — `Extract` cannot produce the slot
   * confusion `objectLayoutFits` exists to refuse. What CAN is the `as` that consumes the
   * result (`e as Extract<Expr, {kind:"CallExpr"}>` is the commonest `as` shape in `src/`),
   * and that is a checked assertion since `481c463`: a tag load, a compare, and a panic on a
   * mismatch. This resolution was gated on that landing, because before it every one of
   * those casts would have become an unchecked union downcast reading one member's bytes at
   * another member's offsets — the `2.12e-314` failure this project has had three times.
   *
   * THE THREE ANSWERS, and the two fallbacks:
   *   - ONE survivor  → the member, tags widened. Exactly what narrowing already produces
   *                     (`unionMemberFor`), so a value that reaches this parameter by a
   *                     `switch (e.kind)` and one that reaches it by an `Extract` annotation
   *                     have the SAME `Ty`, and neither the checker nor codegen can tell
   *                     which route it took.
   *   - SEVERAL       → the sub-union. Still discriminated by construction: a subset of a
   *                     union whose tag is at one index with distinct values has both
   *                     properties, so `unionDiscriminant` holds without re-deriving it.
   *   - NONE          → TypeScript's `never`, which this subset cannot represent. REFUSED
   *                     rather than quietly answered with `T`: a pattern that selects
   *                     nothing is a typo in a tag value (`{kind:"Aggregate"}` for
   *                     `"AggregateError"`), and erasing it to the full union turns that
   *                     typo into thirty confusing field-read refusals somewhere else.
   *
   * The fallbacks BOTH widen, never narrow, which is what makes them safe to leave silent:
   * a non-union subject (`Extract<number, number>`, a type parameter, an unresolved import)
   * keeps its old erasure to `T`, and so does a pattern that is not an object type. A wider
   * type refuses more field reads and permits fewer casts; it cannot turn into a wrong
   * answer. The one residue worth naming is a pattern whose tag is a UNION of literals —
   * `Extract<Expr, { kind: "MemberExpr" | "IndexExpr" }>`, twice in `src/` — where
   * `parseTypeInner` has already collapsed `"MemberExpr" | "IndexExpr"` to `string`. Every
   * member then matches by widened type and the answer is the whole union again, i.e. the
   * old erasure, arrived at by the rule rather than by a special case. Recorded in
   * docs/divergences.md.
   */
  private extractType(subject: Ty, pattern: Ty | undefined): Ty {
    // `parseType`'s discipline, restated: this method's arguments came through
    // `parseTypeInner` (to keep the pattern's tag), so a literal can still be sitting in
    // `subject` itself (`Extract<"a", "a">`) and must not escape into an annotation.
    const erased = isUnionTy(subject) ? subject : widenLiteralTys(subject);
    if (pattern === undefined || !isUnionTy(subject) || !isObjectTy(pattern)) return erased;
    const keep = extractUnionMembers(subject, pattern);
    if (keep.length === 1) return widenLiteralTys(keep[0]!);
    if (keep.length >= 2) return makeUnionTy(keep);
    throw nyi(NYI.UTILITY_TYPE, `Extract<…, ${widenLiteralTys(pattern)}> selects no member of '${unionWidenedMembers(subject).join(" | ")}'`);
  }
  // generic type-argument list `<T, U>` — parsed everywhere a `<...>` type-arg list
  // appears (annotations, `new X<..>()`, call-site `f<..>()`); the args are erased.
  //
  // `keepLiterals` is for `Extract` alone (see `extractType`): its pattern argument's
  // string-literal field types ARE the selector, and `parseType` widens them to `string`
  // on the way out. Off everywhere else, so no literal type reaches an ordinary annotation.
  private parseTypeArgs(keepLiterals = false): Ty[] {
    this.eat("<");
    //@@mutable
    const tys: Ty[] = [];
    // A type ARGUMENT is inside the assertion but is not the type being asserted — see
    // `parseAssertedType` for where that line is drawn and why.
    const fatal = this.erasureIsFatal;
    this.erasureIsFatal = false;
    try {
      if (!this.at(">")) { do { tys.push(keepLiterals ? this.parseTypeInner() : this.parseType()); } while (this.at(",") && (this.eat(","), true)); }
    } finally { this.erasureIsFatal = fatal; }
    this.eatTypeClose();
    return tys;
  }
  /**
   * Close a `<…>` type-argument list. NESTED generics end in a single `>>` / `>>>`
   * token (`Map<string, Set<Expr>>`), because the lexer sees the shift operators —
   * which is right everywhere except here. So split the token: consume one `>` and
   * leave the remainder in place for the enclosing list to close with.
   */
  private eatTypeClose(): void {
    const i = this.pos;
    const t = this.peek();
    if (t.type === "punct" && (t.value === ">>" || t.value === ">>>")) {
      const spent = (this.angleTok === i ? this.angleSpent : 0) + 1;
      // NOT CONSUMED until the last `>` is spent. `sec<Array<Array<number>>, string>`
      // closes two lists at a `>>` whose next token is the OUTER list's comma; advancing
      // past the whole token at the inner close would let the inner list keep reading and
      // swallow `string` as a third argument of its own (test/generics.test.ts n5/n6).
      if (spent < t.value.length) { this.angleTok = i; this.angleSpent = spent; return; }
      this.angleTok = -1;
      this.angleSpent = 0;
      this.next();
      return;
    }
    this.eat(">");
  }
  /**
   * Tuple type `[T, U, …]`, modeled as an array of the first element type.
   *
   * That model is only honest when the elements AGREE. `[T, T]` really is a `T[]` — every
   * element has type `T`, and only the arity is lost, which the Stage-41 bounds panic
   * already covers. `[T, U]` is not: keeping `T` and discarding `U` invents a type for
   * element 1 that the program never wrote, and the parser is the last pass that still
   * holds the spelling, so the mistake is unattributable from here on (NT1033's argument,
   * verbatim). It surfaced as diagnostics blaming correct code for a mismatch we had just
   * manufactured — `(t: [number, string]): string => t[1]` rejected as "return type number
   * does not match declared string" — and, behind that, as a latent silent wrong answer
   * held off only by the array-literal homogeneity check in a different pass.
   *
   * So the heterogeneous case is REFUSED (NT1037) and the homogeneous case is kept.
   */
  private parseTupleType(): Ty {
    this.eat("[");
    //@@mutable
    const tys: Ty[] = [];
    if (!this.at("]")) { do { tys.push(this.parseType()); } while (this.at(",") && (this.eat(","), true)); }
    this.eat("]");
    const head = tys[0] ?? "number";
    for (const t of tys) {
      if (t !== head) throw nyi(NYI.TUPLE, `the tuple type \`[${tys.join(", ")}]\` (its elements do not share one type, and nativets would keep only \`${head}\` and discard the rest)`);
    }
    return makeArrayTy(head);
  }
  /**
   * A leading `(` in type position is either a function type's parameter list
   * (`(a: T) => U`) or a PARENTHESIZED type (`(() => Scope) | null`, `(number)[]`).
   * Parens carry no meaning of their own — they only group — so try the function-type
   * grammar and fall back to "parse a type, expect `)`", which is transparent.
   */
  private parseParenOrFuncType(): Ty {
    const save = this.pos;
    // The half-spent `>>` goes back too. A speculative parse that closed one level of a
    // nested list and then failed used to leave the token PERMANENTLY split, so the retry
    // read `Array<Array<number>>` one `>` short — which is why the annotation and the
    // return type each worked alone but not in the same file (test/generics.test.ts n4).
    const saveTok = this.angleTok, saveSpent = this.angleSpent;
    try { return this.parseFuncType(); } catch { this.pos = save; this.angleTok = saveTok; this.angleSpent = saveSpent; }
    this.eat("(");
    const inner = this.parseType();
    this.eat(")");
    return inner;
  }

  private parseFuncType(): Ty {
    this.eat("(");
    //@@mutable
    const params: Ty[] = [];
    if (!this.at(")")) {
      do {
        this.expectIdent(); // param name (required in fn type annotations)
        this.eat(":");
        params.push(this.parseType());
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat(")");
    this.eat("=>");
    // Peek BEFORE parsing: `Promise<T>` erases to `T` (parseGenericType), so the only
    // place the promise is still visible is the token stream. Assigned (not or-ed) after
    // the return type is parsed, so the OUTERMOST function type has the last word:
    // `() => (() => Promise<T>)` returns a function, not a promise.
    const retPromise = this.peek().value === "Promise" && this.peek(1).value === "<";
    const ret = this.parseType();
    this.fnTyReturnsPromise = retPromise;
    return `(${params.join(",")})=>${ret}` as Ty;
  }
  /** Parse a type annotation, reporting whether it is a promise-returning FUNCTION type
   *  (`(…) => Promise<T>`) — see `fnTyReturnsPromise`. */
  private parseTypeAsyncAware(): { ty: Ty; asyncFn: boolean } {
    this.fnTyReturnsPromise = false;
    const ty = this.parseType();
    return { ty, asyncFn: this.fnTyReturnsPromise };
  }
  private parseObjectType(): Ty {
    this.eat("{");
    //@@mutable
    const fields: string[] = [];
    // A FIELD's annotation is inside the assertion but is not the type being asserted —
    // see `parseAssertedType`.
    const fatal = this.erasureIsFatal;
    this.erasureIsFatal = false;
    try { return this.parseObjectTypeFields(fields); } finally { this.erasureIsFatal = fatal; }
  }
  private parseObjectTypeFields(
    //@@mutable
    fields: string[],
  ): Ty {
    if (!this.at("}")) {
      do {
        if (this.at("}")) break; // tolerate a trailing `,`/`;` separator (interface bodies)
        const key = this.expectIdent();
        const optional = this.at("?"); // `{ a?: T }` ≡ `{ a: T | undefined }`
        if (optional) this.eat("?");
        this.eat(":");
        // `parseTypeInner`, not `parseType`: a field's literal type must survive long
        // enough for this record to become a union member's discriminant. Every path
        // that does NOT end up in a union widens it back (see `parseType`).
        let ft = this.parseTypeInner();
        if (optional) ft = makeNullable("undefined", ft);
        fields.push(`${key}:${ft}`);
      } while ((this.at(",") || this.at(";")) && (this.next(), true));
    }
    this.eat("}");
    // Round-tripped through `objectFields`/`objectType` rather than joined straight, so an
    // ANNOTATION gets the same canonical array-index-first key order a LITERAL gets. If only
    // one side were canonical the two spellings of one shape would stop being identical
    // strings, and tagged-union membership is a string-identity test.
    return objectType(objectFields(`{${fields.join(",")}}` as Ty));
  }

  // Consume a generic type-parameter list `<T, U extends V, W = X>` (balanced angles)
  // and return the declared PARAMETER NAMES. Constraints (`extends V`) and defaults
  // (`= X`) are erased: monomorphization specializes on the types that actually flow,
  // so a constraint adds no information the instantiation doesn't already carry.
  private parseTypeParamList(): string[] {
    //@@mutable
    const names: string[] = [];
    this.eat("<");
    let depth = 1;
    let expectName = true; // at depth 1, the token right after `<` or `,` is a param name
    while (depth > 0 && this.peek().type !== "eof") {
      const t = this.next();
      const v = t.value;
      if (v === "<") depth++;
      else if (v === ">") depth--;
      else if (v === ">>") depth -= 2;   // `>>` token closing two nested params
      else if (v === ">>>") depth -= 3;
      else if (depth === 1 && v === ",") expectName = true;
      else if (depth === 1 && expectName && t.type === "ident") { names.push(v); expectName = false; }
    }
    return names;
  }
  /**
   * A generic DECLARATION's own type parameters (`type X<T> = …`, `interface X<T> { … }`).
   *
   * Collected, not discarded, because `T` IS declared — right there in the `<…>` this
   * function used to throw away — so NT2003 ("Cannot find name") would be a false refusal.
   *
   * They no longer ERASE. `T` in the body used to fall through to `number`, which made
   * every instantiation the `number` shape whatever argument was written; that is NT1013
   * now (see `refuseUnknownName`), because the erasure escaped the checker into codegen.
   * Kept in their OWN set for that: while these names shared `externalNames` with import
   * bindings, "the name is in the set" could not distinguish the two and the arm could not
   * refuse one without refusing the other.
   *
   * Not `typeParamScopes`, which is the mechanism for a generic FUNCTION's parameters —
   * those are monomorphized for real and must keep working. File-wide rather than scoped
   * because it only has to be a reason to refuse the declaration, not a resolution.
   */
  private skipGenerics(): void { for (const p of this.parseTypeParamList()) this.genericParamNames = this.genericParamNames.add(p); }

  // `type X = <type>;` — record the alias, erase the declaration. RHS uses the normal
  // type grammar (so `type Dir = "n" | "s"` collapses to string; a general union throws NYI).
  private parseTypeAlias(): Stmt {
    const dec = this.pendingDecorators;
    this.pendingDecorators = null;
    this.eat("type");
    const name = this.expectIdent();
    if (this.at("<")) this.skipGenerics(); // erased type params
    this.eat("=");
    // Stored RAW (literal types intact) so `type Square = { kind: "square" }` can later
    // be a union member; every USE goes through `parseType`, which widens.
    const outer = this.declaringType, outerRec = this.declaringTypeIsRecursive;
    this.declaringType = name; // a reference to `name` in here is recursion, not ordering
    this.declaringTypeIsRecursive = false;
    const rhs = this.parseTypeInner();
    const recursive = this.declaringTypeIsRecursive;
    this.declaringType = outer;
    this.declaringTypeIsRecursive = outerRec;
    if (this.at(";")) this.eat(";");
    this.typeAliases = this.typeAliases.set(name, this.recordTypeDecl(name, this.applyRecordAttrs(dec, name, rhs, "type"), recursive));
    return { kind: "MultiStmt", stmts: [] }; // erased (no runtime)
  }

  /**
   * `@@mutable` on a `type`/`interface` declaration (extension of Stage 45's class
   * attribute — see docs/decorators.md).
   *
   * The record is TAGGED with its declaration name, exactly the way a class instance
   * type is (`Cell{n:number}` vs the untagged literal `{n:number}`), and the tag is
   * published on the Program. That makes mutability NOMINAL: two structurally identical
   * records, one decorated and one not, stay distinguishable, so an undecorated record
   * can never be silently mutated because some other declaration happens to share its
   * shape. Every downstream rule then reuses the class machinery unchanged — `classTag`,
   * the checker's field-assignment check, and the ownership pass's NT1607/NT1604/NT1602.
   */
  private applyRecordAttrs(dec: { attrs: string[]; wrappers: string[] } | null, name: string, shape: Ty, what: string): Ty {
    if (!dec || (!dec.attrs.length && !dec.wrappers.length)) return shape;
    if (dec.wrappers.length) {
      throw decoratorError(
        `runtime decorator '@${dec.wrappers[0]}' on a '${what}' declaration`,
        "a `@wrapper` is a real function applied to a runtime value; a type declaration has none (it is erased). Only the compile-time `@@` form applies to a type",
      );
    }
    const unknown = dec.attrs.filter((a) => a !== "mutable");
    if (unknown.length) {
      throw decoratorError(
        `compile-time attribute '@@${unknown[0]}' on a '${what}' declaration`,
        "the only attribute a type declaration accepts is `@@mutable`",
      );
    }
    if (!isObjectTy(shape) || classTag(shape) !== undefined) {
      throw decoratorError(
        `'@@mutable ${what} ${name}' does not declare a RECORD (it resolves to '${shape}')`,
        "`@@mutable` marks a record whose fields may be assigned in place, so the declaration must be an object type — `@@mutable type Cell = { n: number }`. Arrays, scalars and aliases of another named record cannot carry it",
      );
    }
    this.mutableRecords = this.mutableRecords.add(name);
    return `${name}${shape}` as Ty;
  }

  // `interface X [extends …] { fields }` — record the structural record, erase the
  // declaration. Field-only bodies (`k: T` / `k?: T`, `,`/`;`-separated); reuses the
  // object-type grammar. Uses of `X` in annotations resolve to this shape.
  private parseInterface(): Stmt {
    const dec = this.pendingDecorators;
    this.pendingDecorators = null;
    this.eat("interface");
    const name = this.expectIdent();
    if (this.at("<")) this.skipGenerics();
    // The BASE list is resolved, not discarded. Note it is resolved BEFORE `declaringType`
    // is set: a base naming the interface itself is not the `@Name` back-edge (an interface
    // cannot inherit from itself — there is no field to hold the pointer), so it stays an
    // ordinary unresolved-name failure and `hoistTypeDecls` reports it as recursion.
    //@@mutable
    const bases: { ty: Ty; spelling: string }[] = [];
    if (this.at("extends")) {
      this.eat("extends");
      bases.push(this.parseBaseType());
      while (this.at(",")) { this.eat(","); bases.push(this.parseBaseType()); }
    }
    const outer = this.declaringType, outerRec = this.declaringTypeIsRecursive;
    this.declaringType = name; // see parseTypeAlias: self-reference here is recursion
    this.declaringTypeIsRecursive = false;
    const own = this.parseObjectType();
    const recursive = this.declaringTypeIsRecursive;
    this.declaringType = outer;
    this.declaringTypeIsRecursive = outerRec;
    const shape = this.inheritFields(name, bases, own);
    this.typeAliases = this.typeAliases.set(name, this.recordTypeDecl(name, this.applyRecordAttrs(dec, name, shape, "interface"), recursive));
    return { kind: "MultiStmt", stmts: [] }; // erased (no runtime)
  }

  /** One entry of an `extends` list, kept with its SOURCE spelling — `resolveNamed` has
   *  erased the name away by the time a refusal needs to say what was written. */
  private parseBaseType(): { ty: Ty; spelling: string } {
    const t = this.peek();
    const ty = this.parseType();
    return { ty, spelling: t.type === "ident" ? t.value : String(ty) };
  }

  /**
   * INTERFACE INHERITANCE, as a field-set union.
   *
   * An interface is erased structurally — a declaration binds a name to a `Ty` string and
   * nothing else — so `interface B extends A { b }` simply MEANS the fields of `A` followed
   * by `b`. Base fields go FIRST, in base order, which is the only ordering that is stable:
   * it makes a derived interface's layout a PREFIX-extension of its base's, so a chain
   * (`C extends B extends A`) lays A's fields at the same indices in A, B and C, and the
   * common tagged-union idiom
   *
   *     interface Base { kind: string }
   *     interface Add extends Base { kind: "add"; lhs: number }
   *     interface Neg extends Base { kind: "neg"; arg: number }
   *
   * puts `kind` at index 0 in every member — the same-slot invariant `unionDiscriminant`
   * (src/ast.ts) proves before it will build a `U<…>`. Appending instead would put the tag
   * at a different index in members with different field counts and the union would be
   * refused.
   *
   * A REDECLARED field overrides the base's type and KEEPS the base's slot, which is what
   * makes the idiom above narrow `kind` from `string` to `"add"` without moving it.
   * TypeScript additionally requires the override to be assignable to the base's member
   * (TS2430) and we do not check that — but types are erased before node ever sees the
   * program, so an incompatible override cannot change the ANSWER, only tsc's opinion of it.
   *
   * Slot order is load-bearing everywhere here (`fieldIndex` is a `getelementptr` offset),
   * and this function is the only thing that decides it for an inheriting interface: the
   * merged string is what every later use of the name resolves to, so there is exactly one
   * layout per declaration and no site can disagree about it.
   */
  private inheritFields(name: string, bases: { ty: Ty; spelling: string }[], own: Ty): Ty {
    if (bases.length === 0) return own;
    //@@mutable
    const fields: { key: string; ty: Ty }[] = [];
    const put = (f: { key: string; ty: Ty }): void => {
      const i = fields.findIndex((g) => g.key === f.key);
      if (i < 0) fields.push(f); else fields[i] = { key: f.key, ty: f.ty }; // override, base slot
    };
    for (const b of bases) {
      // A base with no field list of its own is the case that must never be silently
      // accepted: dropping it is precisely the defect this function exists to end, and it
      // was a WRONG ANSWER rather than a missing one (`JSON.stringify(x)` printed the
      // derived fields only, exit 0). `classTag` catches both nominal carriers — a class
      // instance type and a `@@mutable` record — which are tagged `Name{…}`.
      if (!isObjectTy(b.ty) || classTag(b.ty) !== undefined) {
        throw nyi(
          NYI.IFACE_EXTENDS,
          `'interface ${name} extends ${b.spelling}' — '${b.spelling}' is not a plain record type whose fields are known in this file (it resolves to '${b.ty}')`,
        );
      }
      for (const f of objectFields(b.ty)) put(f);
    }
    for (const f of objectFields(own)) put(f);
    return objectType(fields);
  }

  /**
   * The tail every recursive declaration shares: a shape containing a `@Name` back-edge is
   * only meaningful next to the table that resolves it, so the two are produced together.
   * `recTypes` maps the name to the FINAL shape — after `applyRecordAttrs`, since a
   * `@@mutable` record is tagged and `@N` must resolve to what `N` actually means.
   *
   * A recursive shape must be an OBJECT. Every other carrier of a back-edge (`type L = L[]`,
   * `type F = () => F`) has no slot layout to give the reference a pointer identity, so it
   * is refused rather than encoded into something codegen would have to guess at.
   */
  private recordTypeDecl(name: string, shape: Ty, recursive: boolean): Ty {
    if (!recursive) return shape;
    // `@@mutable` + recursive used to be refused HERE, for the whole declaration. It is not
    // refused any more: the hazard is not the declaration, it is the one ASSIGNMENT that can
    // close a cycle, and the checker refuses exactly that (`cycleCapableField`). `n.label = s`
    // on a recursive node cannot make a cycle; `n.next = m` can. Refusing the declaration
    // refused both — see docs/decorators.md. The CLASS spelling was held back one more
    // lane and then split the same way (piece 4, `parseClass`): a `this.f = v` write in a
    // METHOD is checked, one in a CONSTRUCTOR is not, because a constructor writes into a
    // block nothing else can reach yet.
    // A DISCRIMINATED UNION is also a legal carrier, and it is the one src/ast.ts's `Expr`
    // needs. It qualifies for exactly the reason an object does: there is no box, so a
    // `U<…>` value IS the member's object block and the reference has a pointer to be.
    if (!isObjectTy(shape) && !isUnionTy(shape)) {
      throw nyi(
        NYI.FORWARD_TYPE,
        `recursive type '${name}' — it refers to itself, and its shape is not an object type (${shape})`,
        "a recursive type is represented as an object whose recursive field holds a POINTER back; " +
        "a self-referential array/function/scalar alias has no such field. Wrap it in an object — " +
        "`interface " + name + " { items: " + name + "[] }` — see docs/divergences.md",
      );
    }
    this.recTypes = this.recTypes.set(name, shape);
    return shape;
  }

  // ---- modules (SH1) --------------------------------------------------------
  // `import`/`export` are recorded on the Program and ERASED from the statement
  // stream: they bind/expose names, they never execute. The linker (src/modules.ts)
  // resolves the graph and merges every module into one Program. Anything outside
  // the supported surface is refused with NT1017 (never miscompiled).

  /** A module specifier string, validated to be a relative path (`./x.ts`, `../y.ts`). */
  private parseSpecifier(what: string): string {
    const t = this.peek();
    if (t.type !== "str") throw parseError(`Expected a module path string after '${what}' at ${t.line}:${t.col}`);
    this.next();
    if (!t.value.startsWith("./") && !t.value.startsWith("../")) {
      throw nyi(NYI.MODULE, `the module specifier '${t.value}' (only relative paths like './util.ts' are resolved — there is no node_modules resolution)`);
    }
    return t.value;
  }

  /** `{ a, b as c }` — an import or export clause. A `type`-modified spec is kept but
   *  flagged: it binds no value, yet the linker still uses it to seed type aliases. */
  private parseNamedClause(): { name: string; alias: string; typeOnly: boolean }[] {
    this.eat("{");
    //@@mutable
    const out: { name: string; alias: string; typeOnly: boolean }[] = [];
    while (!this.at("}")) {
      // inline type modifier: `import { type T, x }` / `export { type T }`
      const typeOnly = this.at("type") && this.peek(1).type === "ident" && this.peek(1).value !== "as";
      if (typeOnly) this.next();
      const name = this.expectIdent();
      let alias = name;
      if (this.at("as")) { this.eat("as"); alias = this.expectIdent(); }
      out.push({ name, alias, typeOnly });
      if (this.at(",")) this.eat(","); else break;
    }
    this.eat("}");
    return out;
  }

  private parseImport(): Stmt {
    const kw = this.eat("import");
    if (this.at("(")) throw nyi(NYI.MODULE, `dynamic 'import()' at ${kw.line}:${kw.col}`);
    // `import "./side-effect.ts";` — run the module, bind nothing.
    if (this.peek().type === "str") {
      const source = this.parseSpecifier("import");
      if (this.at(";")) this.eat(";");
      this.imports.push({ source, specs: [], line: kw.line });
      return { kind: "MultiStmt", stmts: [] };
    }
    if (this.at("*")) throw nyi(NYI.MODULE, `namespace import 'import * as ns' at ${kw.line}:${kw.col}`);
    // `import type { T } from …` — the whole clause is type-level, so it is erased
    // (the linker still visits the module so its type exports resolve).
    const typeOnly = this.at("type") && this.peek(1).value === "{";
    if (typeOnly) this.next();
    // `import src from "./x.c" with { type: "text" }` (SH5) — the ONE default-import
    // shape that is supported, because it is not really an import: the attribute makes
    // it a compile-time string constant. Recognized by the trailing `with`, so a plain
    // `import x from "./y.ts"` still gets the NT1017 below.
    if (!typeOnly && this.peek().type === "ident" && this.peek(1).value === "from"
        && this.peek(2).type === "str" && this.peek(3).value === "with") return this.parseTextImport(kw);
    if (!this.at("{")) throw nyi(NYI.MODULE, `default import 'import ${this.peek().value} from …' at ${kw.line}:${kw.col}`);
    const clause = this.parseNamedClause();
    if (this.at(",")) throw nyi(NYI.MODULE, `a combined default + named import at ${kw.line}:${kw.col}`);
    this.eat("from");
    // Host FFI (SH4): `node:fs` & friends name COMPILER BUILTINS, not files. The import
    // binds them (a builtin is out of scope until imported, so user code that defines its
    // own `join` is unaffected) and is then erased — there is nothing to link.
    const spec = this.peek();
    if (spec.type === "str" && spec.value.startsWith("node:")) {
      this.next();
      if (this.at(";")) this.eat(";");
      this.bindHostImport(spec.value, clause, typeOnly, kw);
      return { kind: "MultiStmt", stmts: [] };
    }
    const source = this.parseSpecifier("from");
    // An attribute on a NAMED import means something we do not implement (`type: "json"`
    // binds parsed JSON, not a module) — refused rather than silently ignored.
    if (this.at("with")) throw nyi(NYI.MODULE, `an import attribute on a named import at ${kw.line}:${kw.col} (only \`import s from "./f.txt" with { type: "text" }\` is supported)`);
    if (this.at(";")) this.eat(";");
    this.imports.push({
      source,
      specs: clause.map((c) => ({ imported: c.name, local: c.alias, typeOnly: typeOnly || c.typeOnly })),
      line: kw.line,
    });
    return { kind: "MultiStmt", stmts: [] };
  }

  /**
   * `import src from "./x.c" with { type: "text" }` (SH5) — a COMPILE-TIME text import.
   *
   * The referenced file is NOT a module: it is read verbatim by the linker and the
   * identifier is bound to a string constant. Only `type: "text"` is implemented — every
   * other attribute (notably node's `type: "json"`) is NT1017, because accepting one and
   * treating it as text would silently change what the program means.
   */
  private parseTextImport(kw: Token): Stmt {
    const local = this.expectIdent();
    this.eat("from");
    const source = this.parseSpecifier("from");
    this.eat("with");
    const attrs = this.parseImportAttributes(kw);
    if (this.at(";")) this.eat(";");
    // Exactly `type: "text"`, nothing more: an unrecognized attribute changes what the
    // import MEANS, so it is named back to the user rather than ignored.
    const first = attrs[0]!;
    if (attrs.length !== 1 || first.key !== "type" || first.value !== "text") {
      const shown = attrs.map((a) => `${a.key}: "${a.value}"`).join(", ");
      throw nyi(NYI.MODULE, `the import attribute \`with { ${shown} }\` at ${kw.line}:${kw.col} (only \`type: "text"\` is implemented — it inlines the file as a compile-time string)`);
    }
    this.textImports.push({ local, source, line: kw.line, col: kw.col });
    return { kind: "MultiStmt", stmts: [] }; // erased; the linker materializes the const
  }

  /** `{ type: "text" }` — an import-attributes clause. Keys may be identifiers or
   *  strings; every value must be a string literal (the spec allows nothing else). */
  private parseImportAttributes(kw: Token): { key: string; value: string }[] {
    this.eat("{");
    //@@mutable
    const out: { key: string; value: string }[] = [];
    while (!this.at("}")) {
      const key = this.expectKey();
      this.eat(":");
      const v = this.peek();
      if (v.type !== "str") throw parseError(`Expected a string import-attribute value at ${v.line}:${v.col}`);
      this.next();
      out.push({ key, value: v.value });
      if (this.at(",")) this.eat(","); else break;
    }
    this.eat("}");
    if (out.length === 0) throw nyi(NYI.MODULE, `an empty import-attributes clause at ${kw.line}:${kw.col}`);
    return out;
  }

  /** Bind the named members of a `node:` builtin module (SH4). Each one must have a
   *  native implementation — the surface is `HOST_MODULES` — otherwise NT1028. */
  private bindHostImport(
    mod: string,
    clause: { name: string; alias: string; typeOnly: boolean }[],
    typeOnly: boolean,
    kw: Token,
  ): void {
    const members = HOST_MODULES.get(mod);
    if (!members)
      throw nyi(NYI.HOSTMOD, `the built-in module '${mod}' at ${kw.line}:${kw.col} (implemented: ${[...HOST_MODULES.keys()].map((m) => `'${m}'`).join(", ")})`);
    for (const c of clause) {
      if (typeOnly || c.typeOnly) continue; // a type-only import binds no value
      if (!members.includes(c.name))
        throw nyi(NYI.HOSTMOD, `'${c.name}' from '${mod}' at ${kw.line}:${kw.col} (implemented: ${members.join(", ")})`);
      this.hostImports = this.hostImports.add(c.name);
      if (c.alias !== c.name) this.hostAliases = this.hostAliases.set(c.alias, c.name);
    }
  }

  private parseExport(): Stmt {
    const kw = this.eat("export");
    if (this.at("default")) throw nyi(NYI.MODULE, `'export default' at ${kw.line}:${kw.col} (use a named export: \`export function f() {}\`)`);
    if (this.at("*")) throw nyi(NYI.MODULE, `'export * from …' at ${kw.line}:${kw.col} (list the names: \`export { a, b } from "./m.ts"\`)`);
    // `export { a, b as c };` and the re-export `export { x } from "./y.ts";`
    if (this.at("{")) {
      const clause = this.parseNamedClause();
      if (this.at("from")) {
        this.eat("from");
        const source = this.parseSpecifier("from");
        for (const c of clause) if (!c.typeOnly) this.exportReexports = this.exportReexports.set(c.alias, { source, imported: c.name, line: kw.line });
        // A re-export is also a dependency edge (the module must be loaded/ordered).
        this.imports.push({ source, specs: [], line: kw.line });
      } else {
        // `export { type T }` re-publishes a local type alias; a plain spec is a value.
        //
        // REBOUND, not called for effect. A nativets `Set`/`Map` is PERSISTENT: `.add`/
        // `.set` answer a NEW collection and leave the receiver alone (docs/divergences.md
        // §A), so the ternary this used to be — `c.typeOnly ? this.exportTypes.add(…) :
        // this.exportValues.set(…)` in statement position — recorded NOTHING once this file
        // compiles itself, and `export { a, b }` published an empty table. Measured on the
        // exact shape with both arms the same type (so nothing refuses it): node prints
        // `1 1`, nativets prints `0 0`, both exit 0. Every other write to these three fields
        // was already spelled this way; only this one hid inside a ternary, which is
        // precisely why `test/discarded-mutator.test.ts` could not see it and now can.
        for (const c of clause) {
          if (c.typeOnly) this.exportTypes = this.exportTypes.add(c.name);
          else this.exportValues = this.exportValues.set(c.alias, c.name);
        }
      }
      if (this.at(";")) this.eat(";");
      return { kind: "MultiStmt", stmts: [] };
    }
    // `export type X = …` / `export interface X { … }` — type-level, erased, but the
    // shape is published so an importing module's annotations resolve to it.
    if (this.at("type") && this.peek(1).type === "ident") { const name = this.peek(1).value; const s = this.parseTypeAlias(); this.exportTypes = this.exportTypes.add(name); return s; }
    if (this.at("interface")) { const name = this.peek(1).value; const s = this.parseInterface(); this.exportTypes = this.exportTypes.add(name); return s; }
    // `export class C { … }` — the class name is BOTH a value (its ctor/methods lower
    // to `C.constructor` / `C.m`) and a type (the tagged instance shape).
    if (this.at("class")) { const name = this.peek(1).value; const s = this.parseClass(); this.exportValues = this.exportValues.set(name, name); this.exportTypes = this.exportTypes.add(name); return s; }
    // `export function f() {…}` — and `export async function f() {…}`, which is the
    // same thing: `async` is ERASED here exactly as at statement level (see the
    // async/await note above), so the export publishes an ordinary function.
    if (this.at("function") || (this.at("async") && this.peek(1).value === "function")) {
      const isAsync = this.at("async");
      if (isAsync) { this.next(); this.asyncFns = this.asyncFns.add(this.peek(1).value); }
      const s = this.parseFuncDecl() as FuncDecl;
      this.exportValues = this.exportValues.set(s.name, s.name);
      // Publish the async-ness: erasure makes it invisible in the exported value, and
      // an importing module needs it to refuse a call without `await` (NT1020).
      if (isAsync) this.exportAsync = this.exportAsync.add(s.name);
      return s;
    }
    if (this.at("let") || this.at("const")) {
      const d = this.parseVarDecl();
      this.eat(";");
      for (const decl of d.decls) {
        this.exportValues = this.exportValues.set(decl.name, decl.name);
        // `export const f = async () => …` is just as promise-returning as `export async
        // function f`, so it publishes async-ness the same way. parseDeclarator has
        // already put an async arrow (or an alias of one) into `asyncFns`.
        if (this.asyncFns.has(decl.name)) this.exportAsync = this.exportAsync.add(decl.name);
      }
      return d;
    }
    throw nyi(NYI.MODULE, `'export' of a '${this.peek().value || this.peek().type}' declaration at ${kw.line}:${kw.col}`);
  }

  /**
   * A decorated declaration — the two sigils (docs/decorators.md):
   *   `@@name`  compile-time ATTRIBUTE (checker-visible, zero runtime footprint)
   *   `@name`   runtime WRAPPER (an ordinary user function returning the replacement)
   * Both bind to the declaration that follows; only a `class` (optionally `export`ed)
   * can be decorated at statement level — anything else is NT1023 rather than ignored.
   */
  private parseDecorated(): Stmt {
    //@@mutable
    const attrs: string[] = [];
    //@@mutable
    const wrappers: string[] = [];
    while (this.at("@@") || this.at("@")) {
      const sig = this.next();
      const t = this.peek();
      const name = this.expectIdent();
      if (sig.value === "@@") {
        if (!KNOWN_ATTRS.has(name)) {
          throw decoratorError(
            `unknown compile-time attribute '@@${name}' at ${t.line}:${t.col}`,
            `known attributes: ${[...KNOWN_ATTRS].map((a) => `@@${a}`).join(", ")}. ` +
            "`@@` is a compile-time attribute the compiler reads (it changes how the class is checked and compiled), so an unrecognized one is an error, never a comment. For a runtime wrapper use the single-`@` form",
          );
        }
        attrs.push(name);
      } else {
        wrappers.push(name);
      }
    }
    this.pendingDecorators = { attrs, wrappers };
    if (this.at("export")) return this.parseExport();
    if (this.at("class") && this.peek(1).type === "ident") return this.parseClass();
    // `@@mutable type X = { … }` / `@@mutable interface X { … }` — a RECORD declaration
    // (the extension of the class attribute; see applyRecordAttrs / docs/decorators.md).
    if (this.at("type") && this.peek(1).type === "ident" && (this.peek(2).value === "=" || this.peek(2).value === "<")) return this.parseTypeAlias();
    if (this.at("interface") && this.peek(1).type === "ident") return this.parseInterface();
    // `@@mutable let xs: T[] = []` — an ACCUMULATOR binding (see applyVarAttrs).
    if (this.at("let") || this.at("const")) {
      const dec = this.pendingDecorators;
      this.pendingDecorators = null;
      const d = this.parseVarDecl();
      if (this.at(";")) this.eat(";");
      return this.applyVarAttrs(dec, d);
    }
    const t = this.peek();
    throw decoratorError(
      `decorator on a '${t.value || t.type}' declaration at ${t.line}:${t.col}`,
      "decorators attach to a `class`, a record `type`/`interface` or a `let`/`const` array accumulator (the `@@` form), or to a class METHOD (`@wrapper m() { … }`) — not to a function or a statement",
    );
  }

  /**
   * `@@mutable let xs: T[] = []` — the ACCUMULATOR opt-in (docs/decorators.md).
   *
   * Unlike the class and record forms, this attribute is attached to a BINDING and not to
   * a type. That is the whole design decision: mutability that travelled with the type
   * would make every `T[]` in the program appendable through any handle, and the value
   * this binding eventually hands out (returned, stored, passed on) is an ordinary
   * immutable array again — so `.push` can only ever be written where the attribute is,
   * next to the `let` whose ownership the ownership pass can establish.
   *
   * One declarator only: `@@mutable let a = [], b = []` would have to say which binding it
   * means, and a destructuring pattern lowers to several declarators none of which the
   * user wrote.
   */
  private applyVarAttrs(
    dec: { attrs: string[]; wrappers: string[] } | null,
    // `//@@mutable` on the PARAMETER — the binding-level opt-in, so `VarDecl` stays
    // structural. See `eatTypeClose` for why the type-level attribute is not the answer.
    //@@mutable
    d: VarDecl,
  ): VarDecl {
    if (!dec || (!dec.attrs.length && !dec.wrappers.length)) return d;
    if (dec.wrappers.length) {
      throw decoratorError(
        `runtime decorator '@${dec.wrappers[0]}' on a variable declaration`,
        "a `@wrapper` replaces a class or a method, not a binding. To transform a value, call the function: `const x = w(v)`",
      );
    }
    const unknown = dec.attrs.filter((a) => a !== "mutable");
    if (unknown.length) {
      throw decoratorError(
        `compile-time attribute '@@${unknown[0]}' on a variable declaration`,
        "the only attribute a `let`/`const` accepts is `@@mutable`",
      );
    }
    if (d.decls.length !== 1) {
      throw decoratorError(
        `'@@mutable' on a declaration that binds ${d.decls.length} names`,
        "`@@mutable` marks ONE accumulator binding — split the declaration (`@@mutable let a: T[] = []` on its own line). Destructuring patterns cannot carry it",
      );
    }
    d.mutable = true;
    return d;
  }

  // ---- statements ----
  parseStatement(): Stmt {
    if (this.at("@@") || this.at("@")) return this.parseDecorated();
    // Module syntax. `import`/`export` only start a declaration at statement level;
    // `import(` in a TYPE is handled by parseImportType, and an expression starting
    // with the identifier `export` is not valid TS, so no lookahead guard is needed
    // beyond keeping `import.` / `import(` out (dynamic import → NT1017 above).
    if (this.at("import") && this.peek(1).value !== ".") return this.parseImport();
    if (this.at("export")) return this.parseExport();
    // Type-level declarations — parsed, recorded, and ERASED (no runtime). Guarded so
    // `type`/`interface` used as ordinary identifiers still parse as expressions.
    if (this.at("type") && this.peek(1).type === "ident" && (this.peek(2).value === "=" || this.peek(2).value === "<")) return this.parseTypeAlias();
    if (this.at("interface") && this.peek(1).type === "ident") return this.parseInterface();
    if (this.at("class") && this.peek(1).type === "ident") return this.parseClass();
    if (this.at("let") || this.at("const")) { const d = this.parseVarDecl(); this.eat(";"); return d; }
    if (this.at("function")) return this.parseFuncDecl();
    // `async function f() {…}` — `async` is ERASED (see the async/await note above):
    // the body is compiled as an ordinary function and `await` inside it is identity.
    if (this.at("async") && this.peek(1).value === "function") {
      this.next();
      this.asyncFns = this.asyncFns.add(this.peek(1).value); // the declared name (after `function`)
      return this.parseFuncDecl();
    }
    if (this.at("return")) return this.parseReturn();
    if (this.at("if")) return this.parseIf();
    if (this.at("while")) return this.parseWhile();
    if (this.at("do")) return this.parseDoWhile();
    if (this.at("for")) return this.parseFor();
    if (this.at("switch")) return this.parseSwitch();
    if (this.at("throw")) { const t = this.peek(); this.eat("throw"); const a = this.parseExpression(); this.eat(";"); return { kind: "ThrowStmt", argument: a, line: t.line, col: t.col }; }
    if (this.at("try")) return this.parseTry();
    if (this.at("break")) { this.eat("break"); this.eat(";"); return { kind: "BreakStmt" }; }
    if (this.at("continue")) { this.eat("continue"); this.eat(";"); return { kind: "ContinueStmt" }; }
    if (this.at("{")) return { kind: "BlockStmt", body: this.parseBlock() };
    if (this.at("[")) return this.parseArrayAssignOrExpr();
    const expr = this.parseExpression();
    this.eat(";");
    return { kind: "ExprStmt", expr };
  }

  private parseDeclarator(): Declarator {
    const name = this.expectIdent();
    let annot: Ty | undefined;
    // Keep the annotation's leading identifier as WRITTEN, before `parseType` erases it.
    // `Record<K,V>` and `Map<K,V>` erase to the same `Ty`, so a mismatch diagnostic built
    // from the erasure alone names a `Map` in a program whose author wrote `Record`.
    let annotHead: string | undefined;
    if (this.at(":")) {
      this.eat(":");
      if (this.peek().type === "ident") annotHead = this.peek().value;
      annot = this.parseType();
    }
    // No `=` means NO initializer — left absent, not synthesized as `undefined`.
    // See the note on `Declarator` in ast.ts: the two are different programs.
    let init: Expr | undefined;
    if (this.at("=")) { this.eat("="); init = this.parseAssign(); }
    // `const f = async () => …` makes `f` an async function under every name the guard
    // cares about, exactly as `async function f` would — and a DIRECT alias (`const g = f`)
    // carries that along, so a chain `const c = b; const b = a` stays guarded.
    //
    // The escape into a PARAMETER (`run(one)` then `f()` inside `run`) is no longer a hole:
    // it is carried by the declared TYPE instead of the name (see fnTyReturnsPromise) and,
    // where the type does not carry it, refused at the argument (see checkAsyncEscapes).
    if (init !== undefined &&
        ((init.kind === "ArrowFunction" && (init.isAsync ?? false)) || (init.kind === "Identifier" && this.asyncFns.has(init.name)))) {
      this.asyncFns = this.asyncFns.add(name);
    }
    // `const run = (f: () => Promise<T>) => …` — bind the arrow's promise-typed parameters
    // to the name calls will actually use, so `run(one)` is a legal escape.
    if (init !== undefined && init.kind === "ArrowFunction" && init.promiseParams !== undefined) {
      // Bound to a LOCAL first: `init.promiseParams` is `?Unumber[]` and the guard above
      // proves it present, but narrowing needs a stable access path and a FIELD of another
      // object is not one — the same shape as `sub.blockedOn` and `this.collectTypes`.
      const pp = init.promiseParams;
      if (pp !== undefined) this.promiseParamsByFn = this.promiseParamsByFn.set(name, pp);
    }
    return { name, annot, annotHead, init };
  }
  private parseVarDecl(): VarDecl {
    const declKind = this.next().value as "let" | "const";
    if (this.at("{")) return this.parseObjectDestructure(declKind);
    if (this.at("[")) return this.parseArrayDestructure(declKind);
    //@@mutable
    const decls: Declarator[] = [this.parseDeclarator()];
    while (this.at(",")) { this.eat(","); decls.push(this.parseDeclarator()); }
    return { kind: "VarDecl", declKind, decls };
  }

  // `const { name, age: alias } = expr` → __d = expr; name = __d.name; alias = __d.age
  private parseObjectDestructure(declKind: "let" | "const"): VarDecl {
    this.eat("{");
    //@@mutable
    const props: { key: string; binding: string }[] = [];
    if (!this.at("}")) {
      do {
        const key = this.expectIdent();
        let binding = key;
        if (this.at(":")) { this.eat(":"); binding = this.expectIdent(); }
        props.push({ key, binding });
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat("}"); this.eat("=");
    const init = this.parseAssign();
    const tmp = this.freshTmp();
    //@@mutable
    const decls: Declarator[] = [{ name: tmp, init }];
    for (const p of props) decls.push({ name: p.binding, init: { kind: "MemberExpr", object: this.ident(tmp), property: p.key } });
    return { kind: "VarDecl", declKind, decls };
  }

  // `const [a, , ...rest] = expr` → __d = expr; a = __d[0]; rest = __d.slice(2)
  // Elision holes (a bare `,`) advance the positional index without binding.
  private parseArrayDestructure(declKind: "let" | "const"): VarDecl {
    this.eat("[");
    //@@mutable
    const elems: { name: string | null; rest: boolean }[] = [];
    while (!this.at("]")) {
      if (this.at(",")) { elems.push({ name: null, rest: false }); this.eat(","); continue; } // hole
      let rest = false;
      if (this.at("...")) { this.eat("..."); rest = true; }
      elems.push({ name: this.expectIdent(), rest });
      if (this.at(",")) this.eat(","); else break;
    }
    this.eat("]"); this.eat("=");
    const init = this.parseAssign();
    const tmp = this.freshTmp();
    //@@mutable
    const decls: Declarator[] = [{ name: tmp, init }];
    // A for-of with an explicit positional index rather than `.forEach((el, i) =>`: an
    // early `return` inside an INLINED ARROW does not narrow the rest of that body (the
    // same guard as `continue` in a loop body does), so `el.name` stayed `string | null`
    // here and the push was NT2001 in the subset this file must compile in. Behavior is
    // identical — an elision hole still consumes an index, which is why `i` advances
    // before the guard rather than after it.
    let idx = 0;
    for (const el of elems) {
      const i = idx;
      idx++;
      if (el.name === null) continue; // elision hole — no binding
      const init: Expr = el.rest
        ? { kind: "CallExpr", callee: { kind: "MemberExpr", object: this.ident(tmp), property: "slice" }, args: [{ kind: "NumberLiteral", value: i }] }
        : { kind: "IndexExpr", object: this.ident(tmp), index: { kind: "NumberLiteral", value: i } };
      decls.push({ name: el.name, init });
    }
    return { kind: "VarDecl", declKind, decls };
  }

  /**
   * A BINDING PATTERN in parameter position — `([k, v]) => …`, `({ name, age }) => …`.
   *
   * Reuses the Stage-15 declaration desugaring: the parameter itself becomes a fresh
   * temp (`__d0`), and the pattern turns into `const` declarators reading out of it,
   * queued in `paramPrelude` for the caller to splice at the top of the body. Nothing
   * downstream (checker, ownership, codegen) sees a pattern — only ordinary locals.
   */
  private parsePatternParam(): Param {
    const tmp = this.freshTmp();
    //@@mutable
    const decls: Declarator[] = [];
    if (this.at("[")) {
      this.eat("[");
      let i = 0;
      while (!this.at("]")) {
        if (this.at(",")) { this.eat(","); i++; continue; } // elision hole — no binding
        const rest = this.at("...") && (this.eat("..."), true);
        const name = this.expectIdent();
        decls.push({
          name,
          init: rest
            ? { kind: "CallExpr", callee: { kind: "MemberExpr", object: this.ident(tmp), property: "slice" }, args: [{ kind: "NumberLiteral", value: i }] }
            : { kind: "IndexExpr", object: this.ident(tmp), index: { kind: "NumberLiteral", value: i } },
        });
        i++;
        if (this.at(",")) this.eat(","); else break;
      }
      this.eat("]");
    } else {
      this.eat("{");
      while (!this.at("}")) {
        const key = this.expectIdent();
        const binding = this.at(":") ? (this.eat(":"), this.expectIdent()) : key;
        decls.push({ name: binding, init: { kind: "MemberExpr", object: this.ident(tmp), property: key } });
        if (this.at(",")) this.eat(","); else break;
      }
      this.eat("}");
    }
    if (this.at("?")) this.eat("?");
    let annot: Ty | undefined;
    if (this.at(":")) { this.eat(":"); annot = this.parseType(); }
    let def: Expr | undefined;
    if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
    if (decls.length) this.paramPrelude.push({ kind: "VarDecl", declKind: "const", decls });
    return { name: tmp, annot, default: def, rest: false };
  }

  /** Take (and clear) the pattern-parameter prelude. Called right after a parameter
   *  list is parsed, before the body — so a nested arrow's prelude never mixes in. */
  private takeParamPrelude(): Stmt[] {
    const p = this.paramPrelude;
    this.paramPrelude = [];
    return p;
  }

  // Build a Param, applying optional-param (`x?: T`) erasure: an optional param is a
  // nullable `T | undefined` with an implicit `undefined` default, so it can be omitted
  // (mirrors the optional-field `{ a?: T }` encoding).
  private mkParam(name: string, annot: Ty | undefined, def: Expr | undefined, rest: boolean, optional: boolean): Param {
    if (optional) {
      annot = makeNullable("undefined", annot ?? "number");
      if (!def) def = this.undef();
    }
    return { name, annot, default: def, rest };
  }

  /** Parse a `( … )` parameter list (rest / optional / annotated / default params).
   *  When `ctor` is set, an access modifier (`private`/`public`/`protected`/`readonly`)
   *  prefixing a param makes it a *parameter property* (marked `paramProp`), which
   *  `parseClass` desugars into a field + a `this.x = x` constructor initialization. */
  private parseParamList(ctor = false): Param[] {
    this.eat("(");
    //@@mutable
    const params: Param[] = [];
    //@@mutable
    const promiseIdx: number[] = [];
    //@@mutable
    const promiseNames: string[] = [];
    if (!this.at(")")) {
      do {
        if (this.at(")")) break; // trailing comma in the param list
        // Parameter property: consume + record access modifiers. A modifier only counts
        // when another identifier (the param name) follows — `readonly` as a bare param
        // name (`f(readonly: number)`) is left alone (next token is `:`/`,`/`)`).
        // `@@mutable` before a parameter — the per-parameter append opt-in
        // (docs/decorators.md). No new lexer syntax was needed: a line comment whose
        // whole body is `@@name` already lexes to `@@` + `name` at ANY position, so the
        // pragma spelling works INSIDE a parameter list and the source stays valid
        // TypeScript. Only `@@mutable` is meaningful here; anything else is NT1023 for
        // the same reason an unknown attribute always is — an attribute changes how code
        // compiles, so silently ignoring a misspelled one would change the meaning.
        let pmutable = false;
        while (this.at("@@")) {
          this.eat("@@");
          const an = this.expectIdent();
          if (an !== "mutable") {
            throw decoratorError(
              `compile-time attribute '@@${an}' on a parameter`,
              "the only attribute a parameter accepts is `@@mutable`, which marks an array parameter `.push` may append to in place",
            );
          }
          // A CONSTRUCTOR parameter is refused: the call site is `new C(…)`, which the
          // ownership pass's call-site rules (see `checkMutableArgs`) do not resolve, and
          // an unchecked marked position is a silent wrong answer, not a missing feature.
          if (ctor) throw decoratorError("'@@mutable' on a constructor parameter", "mark a plain function's or a method's array parameter instead; a constructor's call site (`new C(…)`) is not checked for iterator invalidation yet");
          pmutable = true;
        }
        let paramProp = false;
        if (ctor) {
          while (this.peek().type === "ident" && PARAM_ACCESS.has(this.peek().value) && this.peek(1).type === "ident") {
            paramProp = true; this.next();
          }
        }
        if (this.at("[") || this.at("{")) {
          // A destructuring pattern binds several names, none of which the user wrote —
          // the same reason `@@mutable let [a, b] = …` is refused (applyVarAttrs).
          if (pmutable) throw decoratorError("'@@mutable' on a destructuring parameter", "`@@mutable` marks ONE array parameter — give it a plain name (`out: T[]`)");
          params.push(this.parsePatternParam());
          continue; // `function f([a, b]: T[])`
        }
        let rest = false;
        if (this.at("...")) { this.eat("..."); rest = true; }
        const pname = this.expectIdent();
        const optional = this.at("?"); if (optional) this.eat("?"); // `f(x?: T)`
        let annot: Ty | undefined;
        if (this.at(":")) {
          this.eat(":");
          const t = this.parseTypeAsyncAware();
          annot = t.ty;
          // A `(…) => Promise<T>` parameter holds an async function, whoever passed it.
          // Calling it is exactly `one()` on an `async function one`, so it gets the same
          // floating-async guard — scoped to this body (see asyncParamScopes).
          if (t.asyncFn) { promiseNames.push(pname); promiseIdx.push(params.length); }
        }
        let def: Expr | undefined;
        if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
        if (paramProp && rest) throw nyi(NYI.CLASS_FEATURE, "a rest parameter cannot be a parameter property");
        // `//@@mutable` on the BINDING — two field stamps follow. Not on `Param`'s type:
        // a nominal member breaks the structural reads (docs/self-hosting.md).
        //@@mutable
        const p = this.mkParam(pname, annot, def, rest, optional);
        if (paramProp) p.paramProp = true;
        if (pmutable) p.mutable = true;
        params.push(p);
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat(")");
    this.lastPromiseParams = promiseIdx;
    this.lastPromiseParamNames = promiseNames;
    return params;
  }

  private parseFuncDecl(): Stmt {
    this.eat("function");
    const name = this.expectIdent();
    // M3: a generic type-parameter list `f<T, U>` is RECORDED (not erased). Its names are
    // in scope for the whole signature + body, so annotations mentioning them resolve to
    // `#T` markers and the checker can monomorphize per call site.
    const typeParams = this.at("<") ? this.parseTypeParamList() : [];
    if (typeParams.length) this.typeParamScopes.push(typeParams);
    try {
      const params = this.parseParamList();
      if (this.lastPromiseParams.length) this.promiseParamsByFn = this.promiseParamsByFn.set(name, this.lastPromiseParams);
      const promiseNames = this.lastPromiseParamNames;
      const prelude = this.takeParamPrelude(); // binding patterns → `const` decls at the top
      let returnAnnot: Ty | undefined;
      let retAsyncFn = false;
      if (this.at(":")) {
        this.eat(":");
        const t = this.parseTypeAsyncAware();
        returnAnnot = t.ty;
        // `function pick(): () => Promise<T>` hands an async function BACK: `pick()()` is
        // then a call to an async function, and gets the same floating-async guard.
        retAsyncFn = t.asyncFn;
        if (retAsyncFn) this.returnsAsyncFn = this.returnsAsyncFn.add(name);
      }
      this.returnsAsyncFnStack.push(retAsyncFn);
      this.asyncParamScopes.push(promiseNames);
      let body: Stmt[];
      try { body = [...prelude, ...this.parseBlock()]; }
      finally { this.returnsAsyncFnStack.pop(); this.asyncParamScopes.pop(); }
      return typeParams.length
        ? { kind: "FuncDecl", name, params, returnAnnot, body, typeParams }
        : { kind: "FuncDecl", name, params, returnAnnot, body };
    } finally {
      if (typeParams.length) this.typeParamScopes.pop();
    }
  }

  /** Infer a class field's type from its initializer when it carries no annotation.
   *  Handles the shapes the accepted subset can lower — scalar literals and immutable
   *  collections. Anything else is deferred (NT1015) with a hint to add an annotation. */
  private inferFieldTy(init: Expr, field: string): Ty {
    switch (init.kind) {
      case "NumberLiteral": return "number";
      case "BooleanLiteral": return "boolean";
      case "StringLiteral": case "TemplateLiteral": return "string";
      case "NewExpr": {
        if (init.callee === "Map") return makeMapTy(init.typeArgs?.[0] ?? "string", init.typeArgs?.[1] ?? "number");
        if (init.callee === "Set") return makeSetTy(init.typeArgs?.[0] ?? "string");
        break;
      }
    }
    throw nyi(NYI.CLASS_FEATURE, `cannot infer a type for class field '${field}' from its initializer; add a type annotation (\`${field}: T = …\`)`);
  }

  // ---- classes (minimal: fields + constructor + methods; no inheritance/static/
  // getters/access-modifiers/parameter-properties/field-initializers — those are
  // deferred with NT1015). A class INSTANCE is a heap object whose slots are the
  // declared fields in order; its type is the structural object type TAGGED with the
  // class name (`Point{x:number,y:number}`). Each method + the constructor lower to a
  // top-level function taking the instance as an explicit first `this` param.
  private parseClass(): Stmt {
    const dec = this.pendingDecorators;
    this.pendingDecorators = null;
    const classTok = this.eat("class");
    const name = this.expectIdent();
    // `@@mutable` — TRUE in-place mutation: a field-assigning method mutates the receiver
    // and every handle observes it. Without it a field-assigning method is COPY-ON-WRITE
    // (it returns a new instance). See docs/decorators.md.
    // The null test is written out: `dec?.attrs.includes(…)` calls a method on the
    // `string[] | undefined` the optional chain produces, which is NT1002 in the subset
    // this file has to stay inside. `!!(undefined)` is `false`, so the two agree on all
    // three inputs (verified against node).
    const isMutable = dec !== null && dec.attrs.includes("mutable");
    if (isMutable) this.mutableClasses = this.mutableClasses.add(name);
    if (this.at("<")) throw nyi(NYI.CLASS_FEATURE, `generic class '${name}' (type parameters)`);
    // Only `extends Error` is supported: nativets models Error as `{message:string}`, so the
    // subclass inherits a `message` field and `super(msg)` sets it. General user-class
    // inheritance is still deferred (no vtables / field-layout inheritance).
    let extendsError = false;
    if (this.at("extends")) {
      this.eat("extends");
      const sup = this.expectIdent();
      if (sup !== "Error") throw nyi(NYI.CLASS_FEATURE, `class inheritance ('extends ${sup}'); only 'extends Error' is supported`);
      extendsError = true;
    }
    if (this.at("implements")) throw nyi(NYI.CLASS_FEATURE, "class 'implements' clause");
    // A method may name its OWN class in a signature (`bump(): Counter`) — the very shape a
    // setter needs — but the instance type is not known until the fields are parsed. So the
    // class name resolves to a self MARKER inside its own body and is substituted for the
    // real instance type once it exists (below). Without this, `Counter` erased to `number`.
    const selfMarker = `#self:${name}#` as Ty;
    this.typeAliases = this.typeAliases.set(name, selfMarker);
    this.eat("{");
    //@@mutable
    const fields: { key: string; ty: Ty }[] = [];
    //@@mutable
    const fieldInits: { field: string; value: Expr }[] = []; // declared-and-initialized fields → ctor prelude
    //@@mutable
    const methods: { name: string; params: Param[]; returnAnnot?: Ty; body: Stmt[]; setter: boolean; wrappers: string[]; typeParams?: string[] }[] = [];
    //@@mutable
    const statics: { name: string; params: Param[]; returnAnnot?: Ty; body: Stmt[] }[] = []; // `static m(…)`
    //@@mutable
    const staticFields: Stmt[] = []; // `static f = init` → a module-level `const C.f`
    let ctorParams: Param[] | null = null;
    let ctorBody: Stmt[] = [];
    while (!this.at("}") && this.peek().type !== "eof") {
      if (this.at(";")) { this.eat(";"); continue; }
      // `@wrapper` on a MEMBER (docs/decorators.md). `@@` attributes are class-level only.
      //@@mutable
      const memberWrappers: string[] = [];
      while (this.at("@") || this.at("@@")) {
        const sig = this.next();
        const dt = this.peek();
        const dn = this.expectIdent();
        if (sig.value === "@@") {
          throw decoratorError(
            `compile-time attribute '@@${dn}' on a class member at ${dt.line}:${dt.col}`,
            "`@@` attributes describe a whole CLASS (put it on the `class` line); a member takes a runtime wrapper — the single-`@` form, `@wrapper m() { … }`",
          );
        }
        memberWrappers.push(dn);
      }
      // Erase access modifiers (`private`/`public`/`protected`/`readonly`) prefixing a member.
      // They're single-module type-level info; `readonly` is already enforced by the
      // immutability model (a field is only assignable as `this.f =` inside the ctor). A
      // modifier keyword counts only when it PREFIXES a member — a member literally named
      // `readonly(): T` / `private: T` (next token `(`/`:`/`?`/`=`) is left alone.
      while (this.peek().type === "ident" && PARAM_ACCESS.has(this.peek().value)) {
        const nv = this.peek(1).value;
        if (nv === "(" || nv === ":" || nv === "?" || nv === "=") break;
        this.next();
      }
      // `static m(…)` — a static member has NO receiver: the class name is a NAMESPACE,
      // so a static method lowers to the plain top-level function `C.m(…)` with no `this`
      // parameter, and `C.m(args)` calls it directly. A modifier keyword counts only when
      // it PREFIXES a member (same rule as the access modifiers above), so a member
      // literally named `static` is left alone.
      let isStatic = false;
      if (this.peek().type === "ident" && this.peek().value === "static" && !MEMBER_START.has(this.peek(1).value)) {
        this.next();
        isStatic = true;
      }
      const tok = this.peek();
      // Modifiers/accessors that change semantics (static/get/set/…) stay deferred (NT1015).
      // `get`/`set` get their OWN hint, because unlike the rest they have an exact,
      // mechanical rewrite — a getter IS a zero-argument method, and the only thing an
      // accessor adds is dropping the parens at the use site. Naming it matters: the whole
      // of `src/*.ts` holds one getter and no setters (docs/self-hosting.md's construct
      // census), so the rewrite is the answer rather than a placeholder for a future
      // feature. Supporting accessors would make `o.x` sometimes a slot load and sometimes
      // a call, which the checker's dotted-path narrowing and the linearity of a field read
      // both assume it is not.
      if (tok.type === "ident" && REJECTED_MEMBER_MODS.has(tok.value) && !MEMBER_START.has(this.peek(1).value)) {
        const accessor = tok.value === "get" || tok.value === "set";
        throw nyi(
          NYI.CLASS_FEATURE,
          `class member modifier/accessor '${tok.value}' at ${tok.line}:${tok.col}`,
          accessor
            ? `an accessor is a method with the parens dropped — write it as an ordinary method and call it: \`${tok.value === "get" ? "name(): T { … }" : "setName(v: T): void { … }"}\`, then \`this.${tok.value === "get" ? "name()" : "setName(v)"}\` at every use site`
            : undefined,
        );
      }
      if (this.at("[")) throw nyi(NYI.CLASS_FEATURE, `computed/index class member at ${tok.line}:${tok.col}`);
      const member = this.expectIdent();
      if (memberWrappers.length && !(this.peek().value === "(" && member !== "constructor")) {
        throw decoratorError(
          `decorator on class member '${member}' at ${tok.line}:${tok.col}`,
          "a `@wrapper` attaches to a METHOD. Decorate the whole class (`@wrapper class C { … }`) to wrap its constructor; fields cannot be decorated",
        );
      }
      // A GENERIC METHOD (`m<T>(x: T): T`). Read the type-parameter list HERE, before the
      // `(` test below: a `<` fails that test, so without this the member falls through to
      // the FIELD branch and is reported as `class field 'm' needs a type annotation` — a
      // message naming neither the real construct nor a way forward.
      //
      // The names are recorded exactly as for a generic function (`parseFunction`), so the
      // signature and body see them as `#T` markers and the checker monomorphizes per call
      // site. A constraint (`<T extends Ty | undefined>`) is ERASED by parseTypeParamList,
      // which is what generic functions already do — the type argument comes from the
      // argument at each call site, not from the bound.
      const memberTypeParams = this.at("<") ? this.parseTypeParamList() : [];
      if (memberTypeParams.length) this.typeParamScopes.push(memberTypeParams);
      try {
      if (member === "constructor" && this.at("(") && !isStatic) {
        // TS forbids type parameters on a constructor (only `class C<T>` carries them),
        // so this is a syntax error rather than a deferred feature.
        if (memberTypeParams.length) throw parseError(`Type parameters on a constructor at ${tok.line}:${tok.col} — put them on the class (\`class ${name}<T>\`)`);
        if (ctorParams) throw parseError(`Duplicate constructor at ${tok.line}:${tok.col}`);
        const ctorPs = this.parseParamList(true); // ctor: access-modified params → parameter properties
        ctorParams = ctorPs;
        const patternPrelude = this.takeParamPrelude(); // binding patterns → `const` decls at the top
        // Iterated through the CALL RESULT, which is a plain `Param[]`. Reading `ctorParams`
        // (declared `Param[] | undefined`) is NT1011 even right after the assignment: the
        // narrowing does not survive to a separate statement through a mutable binding.
        for (const p of ctorPs) if (p.rest) throw nyi(NYI.CLASS_FEATURE, "rest parameter in a constructor");
        if (this.at(":")) { this.eat(":"); this.parseType(); } // ctor return annot (ignored)
        this.thisWritable = true; this.inErrorCtor = extendsError; this.inCtorBody = true;
        ctorBody = [...patternPrelude, ...this.parseBlock()];
        this.thisWritable = false; this.inErrorCtor = false; this.inCtorBody = false;
        continue;
      }
      if (this.at("(")) {
        const params = this.parseParamList();
        const prelude = this.takeParamPrelude(); // binding patterns → `const` decls at the top
        let returnAnnot: Ty | undefined;
        if (this.at(":")) { this.eat(":"); returnAnnot = this.parseType(); }
        // A static method has no receiver, so it is parsed as a plain function: `this` is
        // not writable (nor readable) inside it, and it can never be a setter.
        if (isStatic) {
          // A `@wrapper` wraps a value with a receiver as its first parameter (see
          // `applyWrappers`); a static has none, so the two do not compose yet. Refuse
          // rather than drop the decorator.
          if (memberWrappers.length) throw nyi(NYI.CLASS_FEATURE, `decorator on static method '${name}.${member}' at ${tok.line}:${tok.col}`);
          // A generic STATIC is deliberately out of scope for this lane. It would need the
          // same treatment as an instance method minus the receiver, but a static resolves
          // through a different call path (`C.m(…)`, no instance), so it is REFUSED rather
          // than half-supported — an unresolved `#T` reaching codegen is the failure mode
          // monomorphization exists to prevent.
          if (memberTypeParams.length) throw nyi(NYI.GENERIC, `generic STATIC method '${name}.${member}' at ${tok.line}:${tok.col} (a generic INSTANCE method is supported)`);
          statics.push({ name: member, params, returnAnnot, body: [...prelude, ...this.parseBlock()] });
          continue;
        }
        // A METHOD may assign `this.f` too. Whether it does is the whole distinction
        // between a plain method and a SETTER (docs/decorators.md), so record it.
        this.thisWritable = true; this.thisAssigned = false;
        const body = [...prelude, ...this.parseBlock()];
        const setter = this.thisAssigned;
        this.thisWritable = false; this.thisAssigned = false;
        methods.push({ name: member, params, returnAnnot, body, setter, wrappers: memberWrappers, typeParams: memberTypeParams.length ? memberTypeParams : undefined });
        continue;
      }
      // Past this point the member is a FIELD, which cannot carry type parameters.
      if (memberTypeParams.length) throw parseError(`Type parameters on class field '${member}' at ${tok.line}:${tok.col}`);
      // field declaration: `name: Type;` / `name = init;` / `name: Type = init;` (optional `?`).
      // A field type comes from its annotation if present, else is inferred from the initializer
      // (`inferFieldTy`). An initializer is desugared into `this.name = init` prepended to the
      // constructor (after parameter-property inits) — mirroring the TS class-field semantics.
      // `f?: T` ≡ `f: T | undefined`, exactly as an interface/object-type field is read
      // (see parseObjectType). The `?` used to be eaten and DISCARDED here, which typed the
      // field `T`: an unassigned one then read back as the zero slot — `0` for a number,
      // a NULL `char*` for a string — instead of `undefined`, and `this.f = undefined` was
      // rejected on code tsc accepts. A silent wrong answer in both directions.
      const optional = this.at("?");
      if (optional) this.eat("?");
      let ty: Ty | undefined;
      if (this.at(":")) { this.eat(":"); ty = this.parseType(); }
      let init: Expr | undefined;
      if (this.at("=")) { this.eat("="); init = this.parseAssign(); }
      if (this.at(";")) this.eat(";");
      // RESOLVED ONCE, into a definite local. `ty` is `Ty | undefined`; assigning it inside
      // the `if` does not narrow it afterwards through a mutable rebind, so every later read
      // saw `?Ustring` (`makeNullable("undefined", ty)` was NT2001). Both arms produce a
      // `Ty` here, so nothing below has to ask again.
      let resolvedTy: Ty;
      if (ty === undefined) {
        if (init === undefined) throw nyi(NYI.CLASS_FEATURE, `class field '${member}' needs a type annotation`);
        resolvedTy = this.inferFieldTy(init, member);
      } else {
        resolvedTy = ty;
      }
      const fieldTy: Ty = optional ? makeNullable("undefined", resolvedTy) : resolvedTy;
      // A STATIC field is not a slot on the instance — it is module-level storage under a
      // class-qualified name (`C.f`), initialized where the class is DECLARED, which is
      // exactly a module-level `const C.f = init`. The dotted name cannot collide with any
      // user binding (no source identifier contains a `.`), so it needs no other marker:
      // a read of `C.f` finds it in scope and nothing else can.
      if (isStatic) {
        if (init === undefined) throw nyi(NYI.CLASS_FEATURE, `static field '${name}.${member}' has no initializer (it would read as \`undefined\`)`);
        staticFields.push({ kind: "VarDecl", declKind: "const", decls: [{ name: `${name}.${member}`, annot: fieldTy, init }] });
        this.staticFieldNames = this.staticFieldNames.add(`${name}.${member}`);
        continue;
      }
      fields.push({ key: member, ty: fieldTy });
      // An optional field with no initializer still needs one: a class instance is a heap
      // block and every field is a real slot, so "absent" has to be WRITTEN as the
      // `undefined` arm of the nullable box. Without this the slot stays zero and a read
      // dereferences NULL. A constructor that assigns the field simply overwrites this.
      //
      // The condition is the field's TYPE, not the `?` token that may have produced it.
      // Gating on `optional` covered `x?: T` and missed the equivalent explicit union
      // `x: T | undefined` — the SAME `Ty` (line 3004 runs the `?` spelling through the
      // very same `makeNullable("undefined", …)`), so nothing downstream could tell the
      // two apart, and the second one left the slot zero. `x: number | undefined` with no
      // initializer is valid strict TypeScript (`tsc --strict` accepts it: `undefined` is
      // in the declared type, so strictPropertyInitialization is satisfied) and node
      // prints `undefined`; the binary died with SIGSEGV. Only the `undefined` arm is
      // filled — `?N` (`T | null`) does not admit `undefined`, and a field typed that way
      // and left unassigned is rejected by tsc for the same reason it has no value here.
      if (init === undefined && isNullableTy(fieldTy) && nullishKind(fieldTy) === "undefined") init = this.undef();
      if (init !== undefined) fieldInits.push({ field: member, value: init });
      } finally {
        // `finally` also runs on the `continue`s above, so the scope is popped on every
        // path out of a member — matching `parseFunction`'s handling for a generic fn.
        if (memberTypeParams.length) this.typeParamScopes.pop();
      }
    }
    this.eat("}");
    const hadExplicitCtor = ctorParams !== null; // captured before any ctor synthesis below

    // Parameter properties (`constructor(private x: T)`): declare a field `x` and initialize
    // it (`this.x = x`) at the top of the ctor body — the TS desugaring.
    //@@mutable
    const paramPropInits: Stmt[] = [];
    for (const p of ctorParams ?? []) {
      if (!p.paramProp) continue;
      fields.push({ key: p.name, ty: p.annot ?? "number" });
      // `paramProp: true` marks this as the DEFINITIONAL store — the reason a parameter
      // property is a CONSUMING parameter rather than a borrow (src/ownership.ts).
      paramPropInits.push({ kind: "ExprStmt", expr: { kind: "FieldAssign", object: this.ident("this"), field: p.name, value: this.ident(p.name), viaThis: true, paramProp: true, inCtor: true } });
    }
    // Field initializers (`name = init`): `this.name = init`, in declaration order, prepended
    // after the parameter-property inits and before the explicit ctor body (TS field-init order).
    const fieldInitStmts: Stmt[] = fieldInits.map(fi => ({
      kind: "ExprStmt", expr: { kind: "FieldAssign", object: this.ident("this"), field: fi.field, value: fi.value, viaThis: true, inCtor: true },
    }) as Stmt);
    const prelude = [...paramPropInits, ...fieldInitStmts];
    // A class with initializers but no explicit constructor gets a synthesized zero-arg ctor
    // that runs just the inits (paramProps imply an explicit ctor, so `prelude` is field-inits).
    // `[] as Param[]` — an empty literal in an ASSIGNMENT position gets no element type
    // from context here (the target is a `let` whose declared type the checker does not
    // carry to this arm), so it is NT1001. The annotation is the supported spelling the
    // diagnostic's own hint prescribes.
    const noCtorParams: Param[] = [];
    if (ctorParams === null && prelude.length) ctorParams = noCtorParams;
    if (prelude.length) ctorBody = [...prelude, ...ctorBody];

    // `extends Error` inherits a `message: string` field (slot 0); `super(msg)` sets it.
    // PREPENDED into a new local, not `fields.unshift(…)`. The `//@@mutable` accumulator
    // opt-in legalizes `.push` only — `unshift` has no in-place runtime primitive (it
    // would have to shift every element), so it stays refused and the spread is the
    // supported spelling. Every use below this line is a READ.
    const allFields = extendsError ? [{ key: "message", ty: "string" as Ty }, ...fields] : fields;
    // A bare `class X extends Error {}` (no own allFields, no ctor) gets a forwarding default
    // constructor `constructor(message: string) { this.message = message }`, so `new X("m")`
    // works and `x.message === "m"` — matching node's implicit `super(...arguments)`.
    if (extendsError && ctorParams === null && allFields.length === 1) {
      ctorParams = [{ name: "message", annot: "string" }];
      ctorBody = [{ kind: "ExprStmt", expr: { kind: "FieldAssign", object: this.ident("this"), field: "message", value: this.ident("message"), viaThis: true, inCtor: true } }];
    }

    // Reject-don't-miscompile: allFields are only initialized by the constructor, so a field
    // nothing stores into is uninitialized garbage — refuse rather than emit it.
    //
    // This used to be gated on `!hadExplicitCtor`, which meant the guard stopped running
    // the moment a class had ANY constructor, and that constructor was never checked for
    // assigning every field. `class C { y: number; z: number; constructor(y: number) {
    // this.y = y } }` then read `z` as the slot's zero and printed `0` where node prints
    // `undefined` — both at exit 0, so nothing observed it. (`tsc --strict` rejects that
    // program with TS2564, which is why no fixture carried the shape; refusing it is this
    // compiler's own job.) There is no value of type `number` to serve, so it is refused
    // for the same reason `let s: string; console.log(s);` is (NT1600).
    //
    // `ctorBody` already carries the prelude — parameter properties and field
    // initializers were folded into it above — so ONE scan covers every way a field can
    // be initialized, and the two cases no longer drift apart.
    const covered = fieldsStoredViaThis(ctorBody);
    // `extends Error`: `message` is slot 0, and the exemption it needs is NARROWER than
    // it looks. `super(msg)` IS a `this.message = msg` store — the parser desugars the
    // call into exactly that `FieldAssign` — so the scan above already sees it and needs
    // no help. What it cannot see is node's IMPLICIT `super(...arguments)`, which only
    // exists when the class declares no constructor of its own.
    //
    // Exempting unconditionally therefore only ever covered the shape where the store is
    // genuinely absent — and that shape is one node REFUSES TO RUN (`ReferenceError:
    // Must call super constructor…`). We compiled it clean and left `message` as an
    // unwritten heap POINTER: `e.message.length` printed `0`, and `JSON.stringify(e.message)`
    // aborted with EXIT 255 and empty stdout.
    const stored = extendsError && !hadExplicitCtor ? covered.add("message") : covered;
    for (const f of allFields) {
      if (stored.has(f.key)) continue;
      // …and it gets its own diagnostic, because "assign it in the constructor" is not the
      // fix: `this.message = m` is a write to the INHERITED slot, and node still throws
      // before reaching it. The only fix is the call.
      if (extendsError && f.key === "message") {
        throw nyi(
          NYI.CLASS_FEATURE,
          `class '${name}' extends Error but its constructor never calls 'super(...)'`,
          `node throws a ReferenceError here — "Must call super constructor in derived class `
            + `before accessing 'this' or returning from derived constructor" — so no instance `
            + `is ever created. Call \`super(message)\` in the constructor`,
        );
      }
      if (!hadExplicitCtor) {
        throw nyi(NYI.CLASS_FEATURE, `class '${name}' field '${f.key}' has no initializer and no constructor to initialize it`);
      }
      // A TRUTHFUL hint, not the generic "this class feature is deferred" one: nothing is
      // deferred here, the program simply has no answer at this type. Each of the three
      // ways out is compiled against node in test/definite-assignment.test.ts (case 29),
      // because a hint that names a fix which does not work is worse than no hint.
      throw nyi(
        NYI.CLASS_FEATURE,
        `class '${name}' field '${f.key}' is never assigned by its constructor`,
        `node reads an unassigned field as \`undefined\`, but '${f.key}' is declared `
          + `'${f.ty}', which has no such value — the slot would be served as its zero `
          + `(\`0\`/\`(null)\`) instead. Assign it in the constructor (\`this.${f.key} = …\`), `
          + `give it an initializer (\`${f.key}: ${f.ty} = …\`), or widen the type to `
          + `\`${f.ty} | undefined\`, which really does read as \`undefined\``,
      );
    }

    // A FIELD naming its own class is a self-referential instance shape, which a flat
    // structural `Ty` cannot express — the same recursion `interface N { next: N }` is
    // refused for (NT1030), in the other spelling. It used to be ERASED here, silently, to
    // `number`. That is the worst outcome available: `class N { v: number; next?: N }`
    // compiled and printed `next: 0` where node prints `next: undefined`, and `kids: N[]`
    // compiled clean as `number[]`. So it is refused, with the SAME message and hint the
    // interface spelling gets — one recursion, told one way.
    //
    // Only a FIELD. A method may still name its own class in a signature (`bump(): Counter`)
    // — that is what the self marker exists for, and it is not recursion: the instance shape
    // does not contain itself, the method merely mentions it.
    // A FIELD naming its own class is genuine recursion, and it is REPRESENTABLE: the
    // marker becomes the nominal back-edge `@Name` (ast.ts), exactly as a self-recursive
    // `interface` does. Routed through the SAME encoding deliberately — `class Scope {
    // parent: Scope | null }` and `interface Scope { parent: Scope | null }` are the same
    // shape and must not acquire two representations.
    //
    // A method SIGNATURE naming the class keeps the old substitution (`unself`, below): the
    // instance shape does not contain itself there, so there is no cycle to break.
    let selfRecursive = false;
    // REBUILT, not mutated through the loop element. `f.ty = …` on a `for-of` binding is
    // NT1606 and stays that way: an element is a BORROW (its owner is the array), which
    // is the one receiver the `//@@mutable` opt-in deliberately does not reach. Building
    // the resolved list is the supported spelling and says the same thing.
    //@@mutable
    const resolvedFields: { key: string; ty: Ty }[] = [];
    for (const f of allFields) {
      if (f.ty.includes(selfMarker)) {
        selfRecursive = true;
        resolvedFields.push({ key: f.key, ty: f.ty.split(selfMarker).join(typeRefTy(name)) as Ty });
      } else {
        resolvedFields.push(f);
      }
    }
    const objTy = `${name}${objectType(resolvedFields)}` as Ty; // class-tagged instance type
    // `@@mutable` + recursive is no longer refused HERE either (piece 4). The class
    // spelling now goes the same way the RECORD spelling went in piece 2: the hazard is
    // not the declaration, it is the one WRITE that can close a cycle, and the checker
    // refuses exactly that (`cycleCapableField`, via `cycleCapableThisWrite`). The reason
    // the class was held back — "the receiver is `this`, not a binding the rule can reason
    // about" — did not survive reading the rule: it is TYPE-level (receiver type, field
    // name, field type), and `this` has the class's own tagged instance type right here.
    if (selfRecursive) this.recTypes = this.recTypes.set(name, objTy);
    this.typeAliases = this.typeAliases.set(name, objTy); // uses of `name` as a type resolve to the instance shape
    const thisParam: Param = { name: "this", annot: objTy };
    //@@mutable
    // `Stmt[]`, matching `hoistedFns` (which these are pushed into) and `mapTypesDeep`'s
    // parameter. A `FuncDecl[]` is NOT a `Stmt[]` here: the union's member carries
    // `kind:"FuncDecl"` — a string LITERAL — while a `FuncDecl[]` element widens to
    // `kind:string`, so the element types genuinely differ and the call was NT2001. Every
    // value pushed is a `FuncDecl`, which IS a member, so nothing else changes.
    let emitted: Stmt[] = [];
    /** `const __dec_C_m = w(…)` statements — the ONE-TIME decorator applications. */
    let decorators: Stmt[] = [];
    // Constructor → `C.constructor(this, …ctorParams): void` (caller allocates `this`).
    // ANNOTATED, not `as FuncDecl`. An `as` assertion demands the literal already have the
    // target's exact slot layout, so a literal omitting the optional fields is NT2001; an
    // ANNOTATION is a context the literal gets reshaped INTO (`retypeLiteral`), which is
    // what fills the omitted slots. Same program, and the spelling the checker supports.
    //@@mutable
    const ctor: FuncDecl = {
      kind: "FuncDecl", name: `${name}.constructor`,
      params: [thisParam, ...(ctorParams ?? [])], returnAnnot: "void", body: ctorBody,
    };
    // A CLASS `@wrapper` wraps the CONSTRUCTOR: the thing being decorated is
    // `(instance, …ctorArgs) => instance` — nativets allocates the instance, the
    // initializer fills it in and hands it back, and the wrapper may do anything
    // around that. (Our classes are not first-class values, so the constructor is
    // the closest expressible reading of Python's `C = wrap(C)`.)
    // Bound and tested explicitly: `dec?.wrappers.length` is an OPTIONAL CHAIN, which
    // tests the field without NARROWING `dec` for the body — `dec.wrappers` inside is then
    // 'possibly null'. The same shape as `sub.blockedOn` and `this.collectTypes`.
    const decd = dec;
    if (decd !== null && decd.wrappers.length > 0) {
      ctor.returnAnnot = selfMarker;
      ctor.body = [...ctor.body, { kind: "ReturnStmt", argument: this.ident("this") }];
      ctor.untrackThis = true; // `return this` hands the caller's own allocation back
      this.applyWrappers(ctor, decd.wrappers, emitted, decorators);
    } else {
      emitted.push(ctor);
    }
    // Each method → `C.method(this, …params)`.
    for (const m of methods) {
      // The optional field is SET, not conditionally spread. `...(c ? { f: v } : {})` is a
      // ternary whose arms are two different shapes (`{typeParams:string[]}` vs `{}`), so
      // it is NT2001 — and `undefined` means exactly what the absent key meant, because
      // every reader is `s.typeParams?.length`. Annotated rather than `as FuncDecl` for
      // the reason the constructor above is: an annotation RESHAPES the literal into the
      // declared layout, an assertion demands it already match.
      //@@mutable
      const fn: FuncDecl = {
        kind: "FuncDecl", name: `${name}.${m.name}`,
        params: [thisParam, ...m.params], returnAnnot: m.returnAnnot, body: m.body,
        // A GENERIC method is the same FuncDecl carrying `typeParams`, so the checker's
        // existing template registration (`declareGeneric`) picks it up with no special
        // case: `this` is simply its first parameter, and it is never generic.
        typeParams: m.typeParams,
      };
      if (m.setter) { fn.setter = true; this.lowerSetter(fn, name, isMutable, selfMarker); }
      if (m.wrappers.length) this.applyWrappers(fn, m.wrappers, emitted, decorators);
      else emitted.push(fn);
    }
    // Each STATIC method → the plain top-level `C.m(…params)`: no `this`, so it differs
    // from an instance method only in the missing receiver — which is exactly what the
    // `isStatic` flag tells the checker, so `C.m(a)` resolves to this function and
    // `inst.m(a)` does not.
    for (const m of statics) {
      // Annotated through a local, for the same reason the two literals above are: an
      // assertion demands the exact layout, an annotation reshapes into it.
      const sfn: FuncDecl = {
        kind: "FuncDecl", name: `${name}.${m.name}`,
        params: m.params, returnAnnot: m.returnAnnot, body: m.body, isStatic: true,
      };
      emitted.push(sfn);
    }
    // Substitute the self MARKER for the real instance type, everywhere it reached.
    const unself = (t: Ty): Ty => (t.includes(selfMarker) ? (t.split(selfMarker).join(objTy) as Ty) : t);
    emitted = mapTypesDeep(emitted, unself);
    decorators = mapTypesDeep(decorators, unself);
    // A LOOP, not `push(...emitted)`: a spread into a variadic call is NT1006, and the
    // loop is what the spread means. `hoistedFns` is an accumulator field, so the push is
    // the in-place one the array opt-in legalizes.
    for (const f of emitted) this.hoistedFns.push(f);
    // The decorator applications run WHERE THE CLASS WAS DECLARED (a module-level
    // `const`), so each wrapper is applied exactly ONCE — Python's `m = w(m)`, not a
    // per-call wrap. Function declarations hoist, so a decorator defined further down
    // the file is still in scope here.
    // Static-field initializers run WHERE THE CLASS WAS DECLARED — before the decorator
    // applications, which is TS's order (static allFields are part of class definition).
    return { kind: "MultiStmt", stmts: [...staticFields, ...decorators] };
  }

  /**
   * A `@wrapper` decorator — a REAL runtime wrapper (docs/decorators.md). The decorated
   * function `f` is split in three:
   *
   *   `C.m$inner(this, …p)`   the original body, renamed
   *   `const __dec_C_m = w((__self, …p) => C.m$inner(__self, …p));`   applied ONCE
   *   `C.m(this, …p) { return __dec_C_m(this, …p); }`                 the replacement
   *
   * so `w` is an ordinary user function of type `(fn) => fn` over the method's own
   * signature with the receiver as the first parameter. Stacked decorators apply
   * BOTTOM-UP, exactly like Python: `@a @b m` ≡ `a(b(m))`.
   */
  private applyWrappers(
    fn: FuncDecl,
    wrappers: string[],
    //@@mutable
    emitted: Stmt[],
    //@@mutable
    decorators: Stmt[],
  ): void {
    const label = fn.name.replace(".", "::");
    if (fn.returnAnnot === undefined) {
      throw decoratorError(
        `decorated method '${label}' has no return type annotation`,
        "a decorator is typed `(fn) => fn` over the method's own signature, so the signature must be written out — annotate the return type (and every parameter)",
      );
    }
    for (const p of fn.params) {
      if (p.rest || p.default !== undefined) {
        throw decoratorError(
          `decorated method '${label}' has a ${p.rest ? "rest" : "default"} parameter`,
          "a decorator wraps a fixed arity; give the method plain annotated parameters (or drop the decorator)",
        );
      }
    }
    const inner: FuncDecl = { ...fn, name: `${fn.name}$inner` };
    emitted.push(inner);
    // `(__self, …p) => C.m$inner(__self, …p)` — the method, bound to an explicit receiver.
    const names = fn.params.map((p, i) => (i === 0 ? "__self" : p.name));
    const arrow: Expr = {
      kind: "ArrowFunction",
      params: fn.params.map((p, i) => ({ name: names[i]!, annot: p.annot })),
      body: { kind: "CallExpr", callee: this.ident(inner.name), args: names.map((n: string) => this.ident(n)) },
      exprBody: true,
    };
    // Bottom-up application: the decorator written CLOSEST to the method wraps first.
    let init: Expr = arrow;
    for (let i = wrappers.length - 1; i >= 0; i--) init = { kind: "CallExpr", callee: this.ident(wrappers[i]!), args: [init] };
    const cname = `__dec_${fn.name.replace(".", "_")}`;
    const fnTy = makeFuncTy(fn.params.map((p) => p.annot ?? "number"), fn.returnAnnot);
    decorators.push({ kind: "VarDecl", declKind: "const", decls: [{ name: cname, annot: fnTy, init }] });
    // The replacement method: forward everything to the (once-)decorated value.
    const forward: FuncDecl = {
      kind: "FuncDecl", name: fn.name, params: fn.params, returnAnnot: fn.returnAnnot,
      body: [{ kind: "ReturnStmt", argument: { kind: "CallExpr", callee: this.ident(cname), args: fn.params.map((p) => this.ident(p.name)) } }],
    };
    emitted.push(forward);
  }

  /**
   * A SETTER — a method that assigns `this.f` — in the two flavors (docs/decorators.md):
   *
   *  - `@@mutable` class: TRUE in-place mutation. The body is emitted as written; the
   *    receiver really changes and every handle observes it.
   *  - ordinary class: COPY-ON-WRITE. `copyThis` makes the method operate on a fresh
   *    shallow copy of the receiver, so the caller's instance is unchanged and the NEW
   *    instance is what comes back. Because the copy is the only observable result, an
   *    ordinary setter may only ever hand back `this` — returning anything else (or
   *    `void`) would throw the copy away, so it is rejected rather than miscompiled.
   *
   * Decision 2 — a setter that does not return gets an IMPLICIT `return this`: the new
   * instance for an ordinary class, the mutated receiver for an `@@mutable` one.
   */
  private lowerSetter(
    // `//@@mutable` on the PARAMETER — this function stamps `copyThis`/`returnAnnot` onto
    // the FuncDecl its caller owns, which is the whole point of taking it by reference.
    //@@mutable
    fn: FuncDecl,
    cls: string,
    isMutable: boolean,
    selfTy: Ty,
  ): void {
    const returns = valueReturns(fn.body);
    if (!isMutable) {
      fn.copyThis = true;
      // A LOOP, not `.find`. `.find` over an array whose element is the `Expr` UNION is
      // NT1001 — it would hand back a heap element the array still owns — and the result
      // is only ever tested for presence here, so a boolean says the same thing without
      // borrowing anything.
      let bad = false;
      for (const r of returns) {
        if (!(r.kind === "Identifier" && r.name === "this")) { bad = true; break; }
      }
      if (bad || (fn.returnAnnot !== undefined && fn.returnAnnot !== selfTy)) {
        throw decoratorError(
          `method '${cls}.${fn.name.split(".")[1]}' assigns a field, so it produces a NEW ${cls}, but it does not return one`,
          `an ordinary (undecorated) class is immutable: a field-assigning method copies the instance and must hand the copy back — write \`return this;\` (or nothing, which inserts it) and annotate \`: ${cls}\`. To mutate the receiver in place instead, put \`@@mutable\` on the class`,
        );
      }
    }
    if (returns.length === 0) {
      fn.body = [...fn.body, { kind: "ReturnStmt", argument: this.ident("this") }];
      if (fn.returnAnnot === undefined || fn.returnAnnot === "void") fn.returnAnnot = selfTy;
    } else if (fn.returnAnnot === undefined && returns.every((r) => r.kind === "Identifier" && r.name === "this")) {
      fn.returnAnnot = selfTy;
    }
  }

  private parseReturn(): Stmt {
    const kw = this.eat("return");
    if (this.at(";")) { this.eat(";"); return { kind: "ReturnStmt", argument: null }; }
    const argument = this.parseExpression();
    // Returning an async function VALUE is the same escape as passing one (see
    // checkAsyncEscapes), and the same declaration carries it back: only a return type
    // written `(…) => Promise<T>` says the caller is getting an async function. Recorded,
    // not thrown, because an `async function` returned before its declaration hoists.
    const asyncArrow = argument.kind === "ArrowFunction" && (argument.isAsync ?? false);
    if (asyncArrow || argument.kind === "Identifier") {
      const argName = argument.kind === "Identifier" ? argument.name : null;
      this.returnEscapes.push({
        argName, asyncArrow,
        scopedAsync: argName !== null && this.inAsyncParamScope(argName),
        // `length > 0 &&` first: outside any function the stack is empty, and index -1
        // is a panic under nativets rather than the `undefined === true` -> false that
        // node answers. Same result, reachable both ways. See test/tsc.test.ts.
        declared: this.returnsAsyncFnStack.length > 0 &&
          this.returnsAsyncFnStack[this.returnsAsyncFnStack.length - 1]! === true,
        line: kw.line, col: kw.col,
      });
    }
    this.eat(";");
    return { kind: "ReturnStmt", argument };
  }

  private parseIf(): Stmt {
    this.eat("if"); this.eat("(");
    const test = this.parseExpression();
    this.eat(")");
    const consequent = this.parseControlled();
    let alternate: Stmt[] | null = null;
    if (this.at("else")) {
      this.eat("else");
      alternate = this.at("if") ? [this.parseIf()] : this.parseControlled();
    }
    return { kind: "IfStmt", test, consequent, alternate };
  }

  private parseWhile(): Stmt {
    this.eat("while"); this.eat("(");
    const test = this.parseExpression();
    this.eat(")");
    return { kind: "WhileStmt", test, body: this.parseControlled() };
  }

  private parseDoWhile(): Stmt {
    this.eat("do");
    const body = this.parseControlled();
    this.eat("while"); this.eat("(");
    const test = this.parseExpression();
    this.eat(")"); this.eat(";");
    return { kind: "DoWhileStmt", body, test };
  }

  private parseFor(): Stmt {
    this.eat("for"); this.eat("(");
    if (this.at("let") || this.at("const")) {
      const declKind = this.next().value as "let" | "const";
      // `for (const [k, v] of m)` — the Map-entries binding. Kept as two names on
      // the ForOfStmt (the checker resolves it against the Map's K/V) rather than
      // desugared through a temp, since there is no tuple type to bind to.
      if (this.at("[")) {
        this.eat("[");
        const k = this.expectIdent(); this.eat(",");
        const v = this.expectIdent(); this.eat("]");
        this.eat("of");
        const iterable = this.parseExpression(); this.eat(")");
        return { kind: "ForOfStmt", name: k, name2: v, iterable, body: this.parseControlled() };
      }
      const name = this.expectIdent();
      let annot: Ty | undefined;
      if (this.at(":")) { this.eat(":"); annot = this.parseType(); }
      if (this.at("of")) { this.eat("of"); const iterable = this.parseExpression(); this.eat(")"); return { kind: "ForOfStmt", name, annot, iterable, body: this.parseControlled() }; }
      if (this.at("in")) { this.eat("in"); const object = this.parseExpression(); this.eat(")"); return { kind: "ForInStmt", name, object, body: this.parseControlled() }; }
      let init: Expr | undefined; // `for (let i; …)` — absent, not synthesized (see ast.ts)
      if (this.at("=")) { this.eat("="); init = this.parseAssign(); }
      //@@mutable
      const decls: Declarator[] = [{ name, annot, init }];
      while (this.at(",")) { this.eat(","); decls.push(this.parseDeclarator()); }
      this.eat(";");
      const forInit: VarDecl = { kind: "VarDecl", declKind, decls };
      const test = this.at(";") ? null : this.parseExpression(); this.eat(";");
      const update = this.at(")") ? null : this.parseSequenceExpr(); this.eat(")");
      return { kind: "ForStmt", init: forInit, test, update, body: this.parseControlled() };
    }
    const init = this.at(";") ? null : this.parseExpression(); this.eat(";");
    const test = this.at(";") ? null : this.parseExpression(); this.eat(";");
    const update = this.at(")") ? null : this.parseSequenceExpr(); this.eat(")");
    return { kind: "ForStmt", init, test, update, body: this.parseControlled() };
  }

  private parseSwitch(): Stmt {
    this.eat("switch"); this.eat("(");
    const discriminant = this.parseExpression();
    this.eat(")"); this.eat("{");
    //@@mutable
    const cases: SwitchCase[] = [];
    while (!this.at("}")) {
      let test: Expr | null = null;
      if (this.at("case")) { this.eat("case"); test = this.parseExpression(); }
      else this.eat("default");
      this.eat(":");
      //@@mutable
      const body: Stmt[] = [];
      while (!this.at("case") && !this.at("default") && !this.at("}")) body.push(this.parseStatement());
      cases.push({ test, body });
    }
    this.eat("}");
    return { kind: "SwitchStmt", discriminant, cases };
  }

  private parseTry(): Stmt {
    this.eat("try");
    const block = this.parseBlock();
    let param: string | null = null;
    let handler: Stmt[] | null = null;
    let finalizer: Stmt[] | null = null;
    if (this.at("catch")) {
      this.eat("catch");
      if (this.at("(")) { this.eat("("); param = this.expectIdent(); if (this.at(":")) { this.eat(":"); this.parseType(); } this.eat(")"); }
      handler = this.parseBlock();
    }
    if (this.at("finally")) { this.eat("finally"); finalizer = this.parseBlock(); }
    return { kind: "TryStmt", block, param, handler, finalizer };
  }

  // `[a, b] = expr;` (destructuring assignment) → __d = expr; a = __d[0]; b = __d[1]
  private parseArrayAssignOrExpr(): Stmt {
    const pattern = this.parseArrayLiteral() as Extract<Expr, { kind: "ArrayLiteral" }>;
    if (this.at("=")) {
      this.eat("=");
      const rhs = this.parseAssign();
      this.eat(";");
      const tmp = this.freshTmp();
      //@@mutable
      const stmts: Stmt[] = [{ kind: "VarDecl", declKind: "const", decls: [{ name: tmp, init: rhs }] }];
      // for-of, not `.forEach((el, i) =>` — see the note in `parseArrayDestructure`: an
      // early exit inside an inlined arrow does not narrow the body after it, so the
      // `kind !== "Identifier"` throw left `el` un-narrowed and `el.name` was NT2001.
      let idx = 0;
      for (const el of pattern.elements) {
        const i = idx;
        idx++;
        if (el.kind !== "Identifier") throw parseError("array assignment pattern must be identifiers");
        stmts.push({ kind: "ExprStmt", expr: { kind: "AssignExpr", op: "=", target: el.name, value: { kind: "IndexExpr", object: this.ident(tmp), index: { kind: "NumberLiteral", value: i } } } });
      }
      return { kind: "MultiStmt", stmts };
    }
    this.eat(";");
    return { kind: "ExprStmt", expr: pattern };
  }

  private parseBlock(): Stmt[] {
    this.eat("{");
    //@@mutable
    const body: Stmt[] = [];
    while (!this.at("}")) body.push(this.parseStatement());
    this.eat("}");
    return body;
  }
  private parseControlled(): Stmt[] {
    return this.at("{") ? this.parseBlock() : [this.parseStatement()];
  }

  // ---- expressions ----
  parseExpression(): Expr { return this.parseAssign(); }

  private parseSequenceExpr(): Expr {
    const first = this.parseAssign();
    if (!this.at(",")) return first;
    //@@mutable
    const exprs = [first];
    while (this.at(",")) { this.eat(","); exprs.push(this.parseAssign()); }
    return { kind: "SequenceExpr", exprs };
  }

  /** Can this token begin an expression? (Used to tell the `await` operator from an identifier.) */
  private startsExpression(t: Token): boolean {
    if (t.type === "ident" || t.type === "num" || t.type === "str" || t.type === "template") return true;
    return t.type === "punct" && ["(", "[", "{", "!", "-", "+", "~", "..."].includes(t.value);
  }

  private looksLikeArrow(): boolean {
    const t = this.peek();
    if (t.type === "ident" && this.peek(1).value === "=>") return true;
    if (t.type === "punct" && t.value === "(") {
      let depth = 0;
      let i = this.pos;
      for (; i < this.toks.length; i++) {
        const v = this.toks[i]!.value;
        if (v === "(") depth++;
        else if (v === ")") { depth--; if (depth === 0) break; }
      }
      const after = this.toks[i + 1];
      if (!after) return false;
      if (after.value === "=>") return true;
      // `(a): T => …` — an arrow with a RETURN-TYPE annotation. A trailing `:` alone is
      // not enough: `cond ? (t.slice(2) as Ty) : t` and `cond ? (x) : y` are ternary arms
      // that also end `) :`. Commit to the arrow grammar only when the parens really hold
      // a parameter list AND a top-level `=>` follows the annotation.
      return after.value === ":" && this.parenHoldsParams(i) && this.annotEndsInArrow(i + 2);
    }
    return false;
  }

  /**
   * Do the tokens between `this.pos` (`(`) and `end` (its matching `)`) look like a
   * PARAMETER LIST rather than a parenthesized expression? Checking the first parameter's
   * shape is enough to separate the two: a parameter starts with `...`, a binding pattern,
   * or an identifier followed by one of `, ) : ? =` — an expression like `t.slice(2)` or
   * `a === b` diverges on its very next token.
   */
  private parenHoldsParams(end: number): boolean {
    const first = this.toks[this.pos + 1];
    if (!first || this.pos + 1 >= end) return true; // `()` — the empty parameter list
    // `@@` starts a parameter ATTRIBUTE (`(//@@mutable\n out: T) => …`), so it can only be
    // a parameter list — an expression never begins with it. Without this the arrow was
    // not even RECOGNIZED as one, and the attribute failed at `Unexpected token '@@'`
    // rather than anywhere near the code that reads it.
    if (first.value === "..." || first.value === "[" || first.value === "{" || first.value === "@@") return true;
    if (first.type !== "ident") return false;
    const nxt = this.toks[this.pos + 2];
    return !!nxt && [",", ")", ":", "?", "="].includes(nxt.value);
  }

  /** Scan a return-type annotation from `i` for the `=>` that makes it an arrow. In TYPE
   *  position `<…>` is always a type-argument list, so it nests like any other bracket
   *  (`(x): Map<string, number> => …` must not stop at that comma). */
  private annotEndsInArrow(i: number): boolean {
    let depth = 0;
    for (; i < this.toks.length; i++) {
      const v = this.toks[i]!.value;
      if (v === "(" || v === "[" || v === "{" || v === "<") depth++;
      else if (v === ")" || v === "]" || v === "}") { if (depth === 0) return false; depth--; }
      else if (v === ">" || v === ">>" || v === ">>>") depth -= v.length;
      else if (depth <= 0) {
        if (v === "=>") return true;
        if (v === ";" || v === "," || v === ":" || v === "?" || v === "=") return false;
      }
    }
    return false;
  }

  private parseArrow(): Expr {
    // Where the arrow STARTS, stamped onto every shape below. `cannot infer type of arrow
    // parameter` had no location at all before this (see `ArrowFunction.loc`).
    const startTok = this.peek(0);
    const arrowLoc: Loc = { line: startTok.line, col: startTok.col, file: this.file };
    //@@mutable
    const params: Param[] = [];
    //@@mutable
    const arrowPromiseIdx: number[] = [];
    //@@mutable
    const arrowPromiseNames: string[] = [];
    if (this.at("(")) {
      this.eat("(");
      if (!this.at(")")) {
        do {
          // `//@@mutable` on an ARROW parameter — the same opt-in `parseParamList` reads, and
          // it belongs here for the same reason: an arrow parameter IS a parameter. The
          // compiler's own AST-stamping callbacks are arrows that write a field of the node
          // they are handed, so refusing it here made the attribute's reach depend on which
          // function SPELLING the caller chose.
          let amutable = false;
          while (this.at("@@")) {
            this.eat("@@");
            const an = this.expectIdent();
            if (an !== "mutable") throw decoratorError(`compile-time attribute '@@${an}' on an arrow parameter`, "the only attribute a parameter accepts is `@@mutable`");
            amutable = true;
          }
          if (this.at("[") || this.at("{")) { if (amutable) throw decoratorError("'@@mutable' on a destructuring parameter", "mark a plain parameter instead"); params.push(this.parsePatternParam()); continue; }
          let rest = false;
          if (this.at("...")) { this.eat("..."); rest = true; }
          const name = this.expectIdent();
          const optional = this.at("?"); if (optional) this.eat("?"); // `(x?: T) =>`
          let annot: Ty | undefined;
          if (this.at(":")) {
            this.eat(":");
            const t = this.parseTypeAsyncAware();
            annot = t.ty;
            // see parseParamList — same rule, arrow syntax
            if (t.asyncFn) { arrowPromiseNames.push(name); arrowPromiseIdx.push(params.length); }
          }
          let def: Expr | undefined;
          if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
          //@@mutable
          const ap = this.mkParam(name, annot, def, rest, optional);
          if (amutable) ap.mutable = true;
          params.push(ap);
        } while (this.at(",") && (this.eat(","), true));
      }
      this.eat(")");
    } else {
      params.push({ name: this.expectIdent() });
    }
    const prelude = this.takeParamPrelude();
    // Which parameters are `(…) => Promise<T>` — recorded against the arrow NODE, since an
    // arrow has no name of its own until parseDeclarator binds it (see promiseParamsByFn).
    const promiseIdx = arrowPromiseIdx;
    // STAMPED on the arrow — see `ArrowFunction.promiseParams`.
    const mk = (
      //@@mutable
      a: Expr
    ): Expr => {
      // A NESTED `if`, not `promiseIdx.length && a.kind === "ArrowFunction"`. The tag test
      // narrows `a` to the `ArrowFunction` member — which is what makes the field store
      // well-defined, since `promiseParams` is NOT a field every `Expr` member shares — and
      // the narrowing has to reach the STORE. Splitting the conjunction is the spelling
      // that guarantees it.
      if (promiseIdx.length > 0) {
        if (a.kind === "ArrowFunction") a.promiseParams = promiseIdx;
      }
      return a;
    };
    let retAsyncFn = false;
    // `(x): T => …` — the DECLARED return type. This used to keep only `asyncFn` and drop
    // `ty` on the floor, which is why an arrow was the one function form whose declared
    // return type was never checked against its body (see ArrowFunction.retAnnot).
    let retAnnot: Ty | undefined;
    if (this.at(":")) { this.eat(":"); const t = this.parseTypeAsyncAware(); retAsyncFn = t.asyncFn; retAnnot = t.ty; }
    this.eat("=>");
    // An arrow's body is a function body for the return-escape rule too (see parseReturn).
    this.returnsAsyncFnStack.push(retAsyncFn);
    this.asyncParamScopes.push(arrowPromiseNames);
    try {
      if (this.at("{")) return mk({ kind: "ArrowFunction", params, stmts: [...prelude, ...this.parseBlock()], exprBody: false, retAnnot, loc: arrowLoc });
      const body = this.parseAssign();
      // A pattern parameter needs statements to bind its names, so an expression body
      // becomes a block: `([a, b]) => a + b` ≡ `(__d0) => { const a = …, b = …; return a + b; }`.
      if (prelude.length) return mk({ kind: "ArrowFunction", params, stmts: [...prelude, { kind: "ReturnStmt", argument: body }], exprBody: false, retAnnot , loc: arrowLoc });
      return mk({ kind: "ArrowFunction", params, body, exprBody: true, retAnnot, loc: arrowLoc });
    } finally { this.returnsAsyncFnStack.pop(); this.asyncParamScopes.pop(); }
  }

  private parseAssign(): Expr {
    // Generic arrow `<T>(x: T): T => x` — a leading `<` can only start a generic arrow
    // in this subset (no JSX / old-style casts), so it is unambiguous: erase the type-param
    // list and parse the arrow that follows.
    // `async (x) => …` / `async x => …` — `async` is erased (see the async/await note).
    if (this.at("async") && (this.peek(1).value === "(" || this.peek(2).value === "=>")) {
      this.next();
      //@@mutable
      const arrow = this.parseArrow();
      // Remember WHICH node this is: erasure loses the `async`, but a `const` binding
      // this arrow is every bit as promise-returning as an `async function`, and the
      // floating-async guard is by NAME. parseDeclarator turns this back into a name.
      if (arrow.kind === "ArrowFunction") arrow.isAsync = true;   // STAMPED — see `ArrowFunction.isAsync`
      return arrow;
    }
    if (this.at("<")) {
      // An arrow is a VALUE, so it has no single instantiation site to specialize (M3
      // monomorphizes DECLARATIONS). Its type params are still brought into scope so the
      // annotations become `#T` markers — the checker then prefers the CONTEXTUAL type
      // where there is one, and otherwise erases the marker to `number` (pre-M3 behavior).
      const tps = this.parseTypeParamList();
      if (tps.length) this.typeParamScopes.push(tps);
      let arrow: Expr;
      try { arrow = this.parseArrow(); } finally { if (tps.length) this.typeParamScopes.pop(); }
      // Split, and bound to a CONST first. `arrow` is a `let` assigned inside a `try`, so
      // a tag test on it inside an `&&` does not narrow — the read of `.params` below was
      // `Property 'params' does not exist on <the Expr union>`. A const alias narrows.
      const arrowed = arrow;
      if (tps.length > 0 && arrowed.kind === "ArrowFunction") {
        // A marker is only meaningful on the arrow's OWN parameter annotations (where the
        // checker substitutes the contextual type). Everywhere else inside the arrow there
        // is nothing to resolve it against, so erase to `number` right here — a `#T` must
        // never reach the checker or codegen.
        // The RETURN annotation is one of those own positions too (`<T>(x: T): T => x`):
        // the checker resolves it against the contextual type exactly as it does a
        // parameter, so the marker must survive the blanket erasure here.
        const own = arrowed.params.map((p) => p.annot);
        const ownRet = arrowed.retAnnot;
        // The rewrite RETURNS a new node (see src/ast.ts), so the erased arrow is rebound
        // here and the two `own` positions are restored by REBUILDING the params rather
        // than assigning into them — `p.annot = …` on a `forEach` parameter is a write
        // through a borrow, which is exactly what this walker rewrite exists to remove.
        // STORED IN PLACE on the narrowed node, not rebuilt with a spread. `{ ...erased,
        // kind: "ArrowFunction", … }` assigned to an `Expr` is NT2001 — an object literal for
        // a union must SET its discriminant to one of the literals, and a spread makes the
        // member undecidable. The tag test below narrows `erased` to the member, and a
        // `@@mutable` binding may store its fields, so the two positions that need restoring
        // are simply assigned.
        //@@mutable
        const erased = mapTypesDeepExpr(arrow, eraseTypeParams);
        if (erased.kind === "ArrowFunction") {
          erased.params = erased.params.map((p: Param, i: number): Param =>
            (own[i] !== undefined ? { ...p, annot: own[i] } : p));
          // `??`, not a ternary: the guard proves the first arm is a `string` while the
          // second stays `?Ustring`, so the branches would differ (NT2001).
          erased.retAnnot = ownRet ?? erased.retAnnot;
        }
        arrow = erased;
      }
      return arrow;
    }
    if (this.looksLikeArrow()) return this.parseArrow();
    const left = this.parsePipe();
    const t = this.peek();
    if (t.type === "punct" && ASSIGN_OPS.has(t.value)) {
      // Element assignment `obj[i] = v`: DEFER the mutability decision to the checker.
      // Immutable arrays/objects are rejected there (NT1606); a genuinely-mutable
      // `Uint8Array` (node allows `u[i] = v`) is accepted. The parser can't know the
      // type, so it emits an IndexAssign and lets type inference decide.
      if (left.kind === "IndexExpr") {
        if (isOptChainTarget(left)) optChainWriteError("`a?.[i] = v`");
        const op = this.next().value as AssignOp; // guarded by `ASSIGN_OPS` above
        return { kind: "IndexAssign", op, object: left.object, index: left.index, value: this.parseAssign(), loc: left.loc };
      }
      if (left.kind === "MemberExpr") {
        if (isOptChainTarget(left)) optChainWriteError("`a?.b = v`");
        // Field assignment `o.f = v`. The parser can prove only the SYNTACTIC case —
        // `this.f` inside a member body, where the constructor is building the instance
        // or the method is a setter (docs/decorators.md). Whether any OTHER receiver may
        // be assigned depends on its TYPE (a `@@mutable` record/class), which the parser
        // does not know, so the node is emitted and the checker decides — rejecting with
        // the same NT1606 it used to throw here when it is not mutable.
        const viaThis = this.thisWritable && left.object.kind === "Identifier" && left.object.name === "this";
        if (viaThis) this.thisAssigned = true;
        const inCtor = viaThis && this.inCtorBody;
        const op = this.next().value;
        const value = this.parseAssign();
        if (op === "=") return { kind: "FieldAssign", object: left.object, field: left.property, value, viaThis, inCtor };
        // Compound `o.f op= v` desugars to `o.f = o.f op v`, which re-evaluates the
        // RECEIVER — sound only for a side-effect-free path (`a`, `this`, `a.b.c`).
        if (!isSimplePath(left.object)) {
          throw mutationError(
            `compound assignment '${op}' to a field of a computed receiver`,
            "the receiver would be evaluated twice; bind it first — `const o = …; o.f = o.f + v`",
            exprLoc(left.object) ?? left.loc,
          );
        }
        const bin = op.slice(0, -1) as BinaryOp;
        return {
          kind: "FieldAssign", object: left.object, field: left.property, viaThis, inCtor,
          // `left` itself, not `{ ...left }`. A SPREAD-ONLY literal in a union position has
          // no visible discriminant — the checker cannot tell which member it builds, so it
          // is NT2001 ("must set 'kind' to one of the literals"). The copy was never
          // load-bearing: `left` is already the `MemberExpr` this reads, and the desugaring
          // does not mutate it.
          value: { kind: "BinaryExpr", op: bin, left, right: value },
        };
      }
      if (left.kind !== "Identifier") throw parseError("Invalid assignment target");
      const opTok = this.next();
      const op = opTok.value as AssignOp; // guarded by `ASSIGN_OPS` above
      // LOCATED — see `AssignExpr.loc`. The operator token, not the target, so the caret
      // lands on the assignment itself.
      return {
        kind: "AssignExpr", op, target: left.name, value: this.parseAssign(),
        loc: { line: opTok.line, col: opTok.col, file: this.file },
      };
    }
    return left;
  }

  // Pipeline `|>` — the LOOSEST expression operator (below assignment's RHS,
  // looser than `?:`/logical/comparison/bitwise/arithmetic). Left-associative.
  // Pure desugar (Elixir semantics): `x |> f(a)` ≡ `f(x, a)` — the left operand
  // is threaded as the FIRST argument of the right-hand CALL. So:
  //   `a + b |> f()`        → f(a + b)      (arithmetic on the LHS groups first)
  //   `a |> f(b) |> g(c)`   → g(f(a, b), c) (left-assoc: value flows left→right)
  // The RHS must be a call whose callee is a plain function (named fn or a
  // function-typed value) — a non-call RHS, or a member-callee (`obj.m()`), is a
  // parse error rather than a guess.
  private parsePipe(): Expr {
    let left = this.parseConditional();
    while (this.at("|>")) {
      const op = this.next();
      //@@mutable
      const rhs = this.parseConditional();
      if (rhs.kind !== "CallExpr") {
        throw parseError(`Right side of '|>' must be a call (e.g. \`x |> f()\`) at ${op.line}:${op.col}`);
      }
      if (rhs.callee.kind !== "Identifier") {
        throw parseError(`'|>' target must be a named function or function-valued variable (member/method callees are unsupported) at ${op.line}:${op.col}`);
      }
      // Thread the piped value into argument slot 0; written args shift right.
      //
      // STORED, not rebuilt. `{ ...rhs, args: … }` is a SPREAD-ONLY literal in a union
      // position: it shows the checker no `kind`, so it cannot tell which member it builds
      // (NT2001). The guards above have already narrowed `rhs` to the `CallExpr` member,
      // and a `@@mutable` binding may store its fields — so the one field that changes is
      // simply assigned, and the node keeps its identity.
      rhs.args = [left, ...rhs.args];
      left = rhs;
    }
    return left;
  }

  private parseConditional(): Expr {
    let test = this.parseBinary(0);
    while (this.at("as") || this.at("satisfies")) {
      if (this.at("as")) {
        this.eat("as");
        // `as const` is a CONST ASSERTION, not a type assertion — `const` is a keyword,
        // not a type name. Parsing it as one made it an unknown named type, which erases
        // to `number`, so `{a:1} as const` had the static type `number`.
        //
        // In TypeScript the assertion keeps literal types unwidened and makes the value
        // deeply readonly. nativets already does both unconditionally (values are
        // immutable unless `@@mutable`; a string-literal type widens back to `string`
        // outside a union tag — `parseType`), so there is nothing left for it to change:
        // it is the IDENTITY, and the operand keeps its own inferred type.
        if (this.at("const")) { this.eat("const"); continue; }
        test = { kind: "AsExpr", expr: test, ty: this.parseAssertedType() };
      }
      else { this.eat("satisfies"); test = { kind: "SatisfiesExpr", expr: test, ty: this.parseAssertedType() }; }
    }
    if (this.at("?")) {
      this.eat("?");
      const consequent = this.parseAssign();
      this.eat(":");
      const alternate = this.parseAssign();
      return { kind: "ConditionalExpr", test, consequent, alternate };
    }
    return test;
  }

  /**
   * The type of an `as` / `satisfies` assertion — `parseType`, with the erasure escape
   * withdrawn for its whole extent (including nested annotations and type arguments).
   *
   * An assertion is the one position where an erased type becomes a WRONG ANSWER instead
   * of a confusing refusal. Everywhere else the `number` `resolveNamed` invents is CHECKED
   * against the value's real type, so a mismatch is caught. A cast ADOPTS the type: nothing
   * downstream has anything left to compare it with. `xs as any[]` therefore re-typed a
   * `string[]` as a `number[]`, and because both are `ptr` the LLVM verifier passed it too
   * — node printed `x` and `2`, nativets printed nothing and exited 255.
   *
   * WHERE THE LINE IS. "The type being asserted" is the type CONSTRUCTOR the assertion
   * names, including its array suffixes and union arms — `as any`, `as any[]`,
   * `as unknown[]`, `as never | undefined` are all fatal, and `any[]` is the exact shape
   * that produced the wrong answer above. It stops at a nested BINDER: a field annotation
   * inside a record type (`parseObjectType`) and a type ARGUMENT (`parseTypeArgs`) restore
   * the escape, because those name the parts rather than the whole and src/ needs them —
   * `node as Record<string, unknown>` and `node as { name?: unknown }` are how every
   * reflective walk in checker.ts/ownership.ts/codegen.ts opens a node it has not yet
   * identified. That boundary is a consequence of the residue, not a claim those are safe:
   * it disappears when `ERASURE_STILL_ALLOWED` does.
   *
   * Restores the previous value rather than clearing, because assertions chain
   * (`x as unknown as T`) and the flag must stay set across the whole chain.
   */
  private parseAssertedType(): Ty {
    const prev = this.erasureIsFatal;
    this.erasureIsFatal = true;
    try { return this.parseType(); } finally { this.erasureIsFatal = prev; }
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      // `x instanceof C` — a keyword operator at relational precedence (10). The right
      // operand is a CLASS NAME, not an expression: nativets decides the test from the
      // left operand's static type (see the checker), so a computed constructor has
      // nothing to resolve against and is refused rather than guessed.
      if (t.type === "ident" && t.value === "instanceof" && BIN.get("<")!.prec >= minPrec) {
        this.next();
        const cls = this.peek();
        if (cls.type !== "ident") throw nyi(NYI.INSTANCEOF, `'instanceof' with a computed right operand at ${cls.line}:${cls.col}`);
        this.next();
        left = { kind: "InstanceOfExpr", object: left, className: cls.value };
        continue;
      }
      // `k in o` — the key-presence test, at the same relational precedence, and decided
      // by the CHECKER from the static type exactly as `instanceof` is. Parsed rather
      // than refused here so the decision can see a type: whether an answer exists
      // depends on the object's shape (an optional field has none) and on whether the
      // key is a literal, neither of which the parser knows. What it must not do is fall
      // out of the expression parser as `Expected ')'`, which blamed a paren and bucketed
      // a real gap as a syntax error.
      if (t.type === "ident" && t.value === "in" && BIN.get("<")!.prec >= minPrec) {
        this.next();
        const object = this.parseBinary(BIN.get("<")!.prec + 1);
        left = { kind: "InExpr", key: left, object, loc: { line: t.line, col: t.col, file: this.file } };
        continue;
      }
      if (t.type !== "punct") break;
      const info = BIN.get(t.value);
      if (!info || info.prec < minPrec) break;
      const op = this.next().value;
      const right = this.parseBinary(info.right ? info.prec : info.prec + 1);
      left = info.logical
        ? { kind: "LogicalExpr", op: op as "&&" | "||" | "??", left, right }
        : { kind: "BinaryExpr", op: op as BinaryOp, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.at("!") || this.at("-") || this.at("+") || this.at("~")) {
      const op = this.next().value as "!" | "-" | "+" | "~";
      return { kind: "UnaryExpr", op, operand: this.parseUnary() };
    }
    if (this.at("void")) { this.eat("void"); return { kind: "UnaryExpr", op: "void", operand: this.parseUnary() }; }
    // `await e` — IDENTITY on an already-resolved value (no event loop; `fetch` and
    // friends block). Only treated as the operator when something that can START an
    // expression follows, so `await` stays usable as an ordinary identifier.
    if (this.at("await") && this.startsExpression(this.peek(1))) {
      this.eat("await");
      //@@mutable
      const operand = this.parseUnary();
      // STAMPED on the node, not collected in a `Set<Expr>` — see `CallExpr.awaited`.
      if (operand.kind === "CallExpr") operand.awaited = true;
      return operand;
    }
    if (this.at("typeof")) { this.eat("typeof"); return { kind: "TypeofExpr", operand: this.parseUnary() }; }
    // `delete o.k` removes a key IN PLACE. Objects are immutable (Stage 29), so it
    // cannot mean what node means — refuse it the same way as `o.f = v`, naming the
    // mutation rather than reporting the statement as unparseable.
    if (this.at("delete") && this.startsExpression(this.peek(1))) {
      const kw = this.eat("delete");
      const target = this.parseUnary();
      // node's `delete` does two DIFFERENT things, so it gets two different refusals.
      // An index whose key is not a string literal is the ARRAY reading: node punches a
      // HOLE (`delete xs[0]` leaves `length` at 3 and `Object.keys` at ["1","2"]), which
      // a dense i64 slot array cannot represent — and the record advice below is not just
      // unhelpful there, it is wrong, since an array has no optional fields to declare.
      if (target.kind === "IndexExpr" && target.index.kind !== "StringLiteral") {
        throw mutationError(
          `arrays are immutable: \`delete xs[i]\` would punch a hole in place`,
          "node's array `delete` leaves a HOLE — `length` is unchanged and the slot reads `undefined` — which a dense array cannot represent. " +
          "Build a new array without the element: `xs.filter((_, i) => i !== 0)`, or `[...xs.slice(0, i), ...xs.slice(i + 1)]`",
          { line: kw.line, col: kw.col, file: this.file },
        );
      }
      // NOTE (mutable records): `@@mutable` does NOT make `delete` legal. A record's
      // SHAPE is its type — fields are static slots resolved at compile time — so removing
      // a key would change the value's type mid-program, which is a different (and much
      // larger) feature than assigning a slot in place. Refused precisely instead.
      //
      // BOTH SPANS ARE BUILT EXPLICITLY, and the `file` on them is not cosmetic. Handing
      // `mutationError` the raw `kw` TOKEN relied on `{type,value,line,col}` structurally
      // fitting the `{line,col,file?}` parameter — which TypeScript allows for a variable
      // (no excess-property check) and this compiler refuses (NT2001), and which silently
      // left `file` undefined. `src/cli.ts::diagSources` skips a span with no file and
      // `formatDiagnostic` then renders it against the ENTRY source, so a `delete` in an
      // IMPORTED module underlined the entry file's line of the same number: measured, a
      // `delete o.b` at lib.ts:4 printed `4 | const decoy2 = 2;` from main.ts, marked
      // "mutated here", and never named lib.ts. Exactly the failure the `diagSources`
      // comment in cli.ts records for the producers that were already fixed.
      throw mutationError(
        `objects are immutable: \`delete o.k\` would remove a key in place`,
        "a record's shape is its TYPE (fields are static slots), so a key cannot be removed at runtime even from a `@@mutable` record. " +
        "Declare the field optional (`k?: T`) and set it to `undefined`, or rebuild without the key",
        { line: kw.line, col: kw.col, file: this.file },
      );
    }
    if (this.at("new")) {
      this.eat("new");
      const callee = this.expectIdent();
      const typeArgs = this.at("<") ? this.parseTypeArgs() : undefined; // new Map<K,V>() / new Set<T>()
      this.eat("(");
      //@@mutable
      const args: Expr[] = [];
      if (!this.at(")")) { args.push(this.parseAssign()); while (this.at(",")) { this.eat(","); if (this.at(")")) break; args.push(this.parseAssign()); } }
      this.eat(")");
      // Route the constructed value through postfix so `new Map().set(...)`,
      // `new Set().add(x).has(x)`, `err.message`, etc. chain like any primary.
      return this.parsePostfix({ kind: "NewExpr", callee, args, typeArgs });
    }
    if (this.at("++") || this.at("--")) {
      const op = this.next().value as "++" | "--";
      const operand = this.parseUnary();
      if (operand.kind === "Identifier") return { kind: "UpdateExpr", op, prefix: true, target: operand.name };
      if (operand.kind === "MemberExpr" || operand.kind === "IndexExpr")
        return { kind: "UpdateExpr", op, prefix: true, target: "", targetExpr: this.updateTarget(operand) };
      throw parseError("Invalid update target");
    }
    return this.parsePostfix();
  }

  /**
   * Vet a member/index `++`/`--` target, mirroring plain assignment exactly (Stage 29):
   * `this.f` is writable only while the constructor is building the instance, any other
   * field is NT1606; an INDEX target is deferred to the checker, which accepts a mutable
   * `Uint8Array` element and rejects an immutable array/object element.
   */
  private updateTarget(target: Expr): Expr {
    // `++`/`--` is a read AND a write, so the same early error applies as for `=`.
    if (isOptChainTarget(target)) optChainWriteError("`a?.b++` / `a?.[i]++`");
    if (target.kind === "MemberExpr") {
      // Same split as plain assignment: `this.f` is decided here (syntax), every other
      // receiver is deferred to the checker, which knows whether it is `@@mutable`.
      if (this.thisWritable && target.object.kind === "Identifier" && target.object.name === "this") this.thisAssigned = true;
      else if (!isSimplePath(target.object)) {
        throw mutationError(
          "`o.f++` on a computed receiver",
          "the receiver would be evaluated twice; bind it first — `const o = …; o.f++`",
          exprLoc(target.object) ?? target.loc,
        );
      }
    }
    return target;
  }

  // Disambiguate a `<` after a primary between call-site TYPE ARGUMENTS (`f<T>(x)`)
  // and the LESS-THAN operator (`a < b`). Speculatively parse a balanced `<...>` type-arg
  // list; commit (return true, position past `>`) only when it is IMMEDIATELY followed by
  // `(` — a call. Any parse failure, or a `>` not followed by `(`, backtracks fully so the
  // binary parser reads `<` as comparison. This matches TS/Node's rule (a following `(`
  // is what promotes `<...>` to type args), keeping ordinary comparisons (`i < n`,
  // `x < f(y)`, `a < b > c`) untouched.
  private tryCallTypeArgs(): Ty[] | null {
    const save = this.pos;
    // Restored on BOTH backtracks, including the one after a SUCCESSFUL `parseTypeArgs`
    // that simply was not followed by `(` — `a < b >> c` reaches here.
    const saveTok = this.angleTok, saveSpent = this.angleSpent;
    let tys: Ty[];
    try {
      tys = this.parseTypeArgs();
    } catch {
      this.pos = save;
      this.angleTok = saveTok;
      this.angleSpent = saveSpent;
      return null;
    }
    if (this.at("(")) return tys;
    this.pos = save;
    this.angleTok = saveTok;
    this.angleSpent = saveSpent;
    return null;
  }

  private parsePostfix(start?: Expr): Expr {
    let expr = start ?? this.parsePrimary();
    let pendingTypeArgs: Ty[] | null = null; // explicit `f<T>` awaiting its `(` (M3)
    for (;;) {
      if (this.at("!") && this.peek().line === this.toks[this.pos - 1]!.line) {
        // Postfix `!` — TypeScript's NON-NULL ASSERTION. It is a type-level claim with no
        // runtime meaning (tsc and node both erase it), so it parses and is DROPPED: the
        // operand's own type flows through unchanged, and node stays the oracle because
        // node runs the same source with the `!` stripped.
        //
        // Two things keep this from swallowing a PREFIX `!`. It is only consulted in the
        // postfix loop, i.e. immediately after a complete operand, where a prefix `!`
        // cannot appear; and TypeScript forbids a line terminator before it, so
        // `a` NEWLINE `!b.c()` stays two statements — hence the same-line check.
        // `a != b` / `a !== b` are single tokens and never reach here.
        const bang = this.eat("!");
        expr = { kind: "NonNullExpr", expr, loc: { line: bang.line, col: bang.col, file: this.file } };
      } else if (this.at(".")) {
        const dot = this.eat(".");
        expr = { kind: "MemberExpr", object: expr, property: this.expectIdent(), loc: { line: dot.line, col: dot.col, file: this.file } };
      } else if (this.at("?.")) {
        const t = this.eat("?.");
        // Optional CALL `?.()` is still out of the A2 subset — a call has no nullable-box
        // result shape here. Optional ELEMENT access `?.[i]` is the same guard as `?.b`
        // with an index in place of a field name, so it reuses the whole opt-chain path.
        if (this.at("(")) throw nyi(NYI.OPTIONAL_CHAIN, `optional call '?.()' at ${t.line}:${t.col}`);
        if (this.at("[")) {
          this.eat("[");
          const index = this.parseExpression();
          this.eat("]");
          // Carries its location like a written `a[i]`: `?.` guards the BASE, so a present
          // base out of range still panics and reports here.
          expr = { kind: "IndexExpr", object: expr, index, optional: true, loc: { line: t.line, col: t.col, file: this.file } };
        } else {
          expr = { kind: "MemberExpr", object: expr, property: this.expectIdent(), optional: true, loc: { line: t.line, col: t.col, file: this.file } };
        }
      } else if (this.at("[")) {
        const br = this.eat("[");
        const index = this.parseExpression();
        this.eat("]");
        // A WRITTEN index carries its location: out of range panics and reports here.
        expr = { kind: "IndexExpr", object: expr, index, loc: { line: br.line, col: br.col, file: this.file } };
      } else if (this.at("(")) {
        const lp = this.eat("(");
        //@@mutable
        const args: Expr[] = [];
        if (!this.at(")")) {
          do {
            if (this.at(")")) break; // trailing comma in the argument list
            if (this.at("...")) { this.eat("..."); args.push({ kind: "SpreadExpr", argument: this.parseAssign() }); }
            else args.push(this.parseAssign());
          } while (this.at(",") && (this.eat(","), true));
        }
        this.eat(")");
        const callLoc = { line: lp.line, col: lp.col, file: this.file };
        // Built into a CONST first, and with ONE literal rather than a ternary. Two things
        // are wrong with the shape this replaces: the ternary's arms differ (`typeArgs`
        // present in one, absent in the other), and `expr` is a `let` REASSIGNED IN A
        // LOOP, so a tag test on it below cannot narrow — every `expr.callee` read was
        // `Property 'callee' does not exist on <the Expr union>`.
        //
        // `typeArgs: pendingTypeArgs ?? undefined` says exactly what the absent key said:
        // the field is optional and every reader is `e.typeArgs?.length`.
        const call: CallExpr = {
          kind: "CallExpr", callee: expr, args, typeArgs: pendingTypeArgs ?? undefined, loc: callLoc,
        };
        expr = call;
        pendingTypeArgs = null;
        // Record plain `f(...)` calls so an un-awaited call to an `async function`
        // can be rejected after the whole program is parsed (see checkFloatingAsyncCalls).
        if (call.callee.kind === "Identifier") {
          const loc = call.callee.loc ?? { line: 0, col: 0 };
          const scopedAsync = this.inAsyncParamScope(call.callee.name);
          this.identCalls.push({ node: call, name: call.callee.name, line: loc.line, col: loc.col, scopedAsync });
        } else if (call.callee.kind === "ArrowFunction" && (call.callee.isAsync ?? false)) {
          // An immediately-invoked async arrow, `(async () => …)()`. It never binds a
          // name, so the name-based path above cannot see it; the callee NODE is the
          // identity. Recorded under a descriptive name so the guard reads the same.
          this.identCalls.push({ node: call, name: "(async arrow)", line: callLoc.line, col: callLoc.col });
          this.asyncFns = this.asyncFns.add("(async arrow)"); // not a legal identifier, so it collides with nothing
        } else if (call.callee.kind === "CallExpr" && call.callee.callee.kind === "Identifier" &&
                   this.returnsAsyncFn.has(call.callee.callee.name)) {
          // `pick()()`, where `pick(): () => Promise<T>` — the callee is the RESULT of a
          // call, so there is no name; the declared return type is the identity.
          const label = `${call.callee.callee.name}()`;
          this.identCalls.push({ node: call, name: label, line: callLoc.line, col: callLoc.col });
          this.asyncFns = this.asyncFns.add(label); // `pick()` is not an identifier, so it collides with nothing
        }
        // Record every argument that could hand an ASYNC function VALUE across this call —
        // the one place the guard's name tracking ends. Resolved after the file is parsed
        // (see checkAsyncEscapes): both the callee and an `async function` argument hoist.
        const calleeName = call.callee.kind === "Identifier" ? call.callee.name : null;
        args.forEach((a, i) => {
          const asyncArrow = a.kind === "ArrowFunction" && (a.isAsync ?? false);
          if (!asyncArrow && a.kind !== "Identifier") return;
          const argName = a.kind === "Identifier" ? a.name : null;
          this.asyncEscapes.push({
            callee: calleeName, index: i, argName, asyncArrow,
            scopedAsync: argName !== null && this.inAsyncParamScope(argName),
            line: callLoc.line, col: callLoc.col,
          });
        });
      } else if (this.at("<") && (pendingTypeArgs = this.tryCallTypeArgs())) {
        // Call-site type arguments `f<T>(x)` / `foo<string>()` — RECORDED on the call so
        // M3 can pin the instantiation explicitly (they were previously erased). Only
        // committed when a balanced `<...>` is immediately followed by `(` (a call),
        // otherwise `<` is left for the binary parser to read as less-than (see helper).
        continue; // the following `(` is handled by the call branch next iteration
      } else if (this.at("++") || this.at("--")) {
        // Aliased to a CONST before the tag test. `expr` is a `let` reassigned every
        // iteration of this loop, so a test on it in the `else if` condition does not
        // narrow the body — `expr.name` was `Property 'name' does not exist on <the Expr
        // union>`. The alias is what the narrowing attaches to.
        const target = expr;
        if (target.kind === "Identifier") {
          const op = this.next().value as "++" | "--";
          expr = { kind: "UpdateExpr", op, prefix: false, target: target.name };
        } else if (target.kind === "MemberExpr" || target.kind === "IndexExpr") {
          const op = this.next().value as "++" | "--";
          expr = { kind: "UpdateExpr", op, prefix: false, target: "", targetExpr: this.updateTarget(target) };
        } else break;
      } else break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "num") { this.next(); return { kind: "NumberLiteral", value: Number(t.value) }; }
    if (t.type === "str") { this.next(); return { kind: "StringLiteral", value: t.value }; }
    if (t.type === "template") {
      this.next();
      // The shared escape decoder can fail (a malformed `\xHH`), and a template is split
      // HERE rather than in `lex`, so its LexError has to reach the same NT0001 that
      // `tokenize` gives the identical escape inside a quoted string.
      try { return this.buildTemplate(t.value, t); }
      catch (e) { if (e instanceof LexError) throw parseError(e.message); throw e; }
    }
    // A regex literal LEXES (so the file survives) but has no representation: nativets
    // has no RegExp by design (Tier C). Refused here, located, instead of miscompiled.
    if (t.type === "regex") throw nyi(NYI.REGEX, `regular expression literal ${t.value} at ${t.line}:${t.col}`);
    if (t.type === "ident") {
      if (t.value === "true" || t.value === "false") { this.next(); return { kind: "BooleanLiteral", value: t.value === "true" }; }
      if (t.value === "undefined") { this.next(); return { kind: "UndefinedLiteral" }; }
      if (t.value === "null") { this.next(); return { kind: "NullLiteral" }; }
      // `super(msg)` inside an Error-subclass constructor → set the inherited `message` field.
      if (t.value === "super") {
        if (!this.inErrorCtor) throw nyi(NYI.CLASS_FEATURE, `'super' is only supported in the constructor of a class that extends Error, at ${t.line}:${t.col}`);
        this.next(); this.eat("(");
        //@@mutable
        const args: Expr[] = [];
        if (!this.at(")")) { do { if (this.at(")")) break; args.push(this.parseAssign()); } while (this.at(",") && (this.eat(","), true)); }
        this.eat(")");
        if (args.length !== 1) throw nyi(NYI.CLASS_FEATURE, `super(...) with ${args.length} arguments (an Error subclass takes a single message)`);
        return { kind: "FieldAssign", object: this.ident("this"), field: "message", value: args[0]!, viaThis: true, inCtor: true };
      }
      this.next();
      // SH4: `import { readFileSync as rfs }` renames a HOST BUILTIN, which has no
      // declaration to alpha-rename — so the alias is resolved here, at the use site.
      const name = this.hostAliases.get(t.value) ?? t.value;
      // `file` is carried, exactly as the postfix forms below carry it. An Identifier is
      // the loc `exprLoc` lands on most often (it descends to the first child that has
      // one), so omitting it here was enough on its own to make a cross-module diagnostic
      // unattributable — the span reached the renderer with a line number and no file.
      return { kind: "Identifier", name, loc: { line: t.line, col: t.col, file: this.file } };
    }
    if (this.at("[")) return this.parseArrayLiteral();
    if (this.at("{")) return this.parseObjectLiteral();
    if (this.at("(")) {
      this.eat("(");
      const e = this.parseSequenceExpr();
      this.eat(")");
      return e;
    }
    throw parseError(`Unexpected token '${t.value || t.type}' at ${t.line}:${t.col}`);
  }

  private parseArrayLiteral(): Expr {
    // The `[` — stamped so `cannot infer the element type` can say WHERE (ArrayLiteral.loc).
    const openTok = this.peek(0);
    this.eat("[");
    //@@mutable
    const elements: Expr[] = [];
    if (!this.at("]")) {
      do {
        if (this.at("]")) break; // trailing comma
        if (this.at("...")) { this.eat("..."); elements.push({ kind: "SpreadExpr", argument: this.parseAssign() }); }
        else elements.push(this.parseAssign());
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat("]");
    return { kind: "ArrayLiteral", elements, loc: { line: openTok.line, col: openTok.col, file: this.file } };
  }

  private parseObjectLiteral(): Expr {
    // The `{` — stamped so the union-literal refusals can say WHERE (ObjectLiteral.loc).
    const braceTok = this.peek(0);
    this.eat("{");
    //@@mutable
    const properties: ObjectProperty[] = [];
    if (!this.at("}")) {
      do {
        if (this.at("}")) break;
        if (this.at("...")) { this.eat("..."); properties.push({ key: "", value: this.parseAssign(), spread: true }); continue; }
        const kt = this.peek();
        const key = this.expectKey();
        if (this.at(":")) {
          // NT1038. `__proto__` in exactly this production — `PropertyName :
          // AssignmentExpression` — is the PROTOTYPE SETTER, not a property (ECMAScript
          // B.3.1), and we have no prototype chain to set. Refused HERE rather than in the
          // checker because this is the only point that still knows the production: the
          // shorthand below desugars to `{ key, value: Identifier(key) }`, which is
          // indistinguishable downstream from the `{ __proto__: __proto__ }` that IS the
          // setter. Both `PropertyName` spellings are covered — `expectKey` returns the same
          // string for the identifier `__proto__` and the string `"__proto__"`, and node
          // treats them alike.
          this.eat(":");
          if (key === "__proto__") throw nyi(NYI.PROTO_KEY, "`__proto__` as an object-literal key", undefined, { line: kt.line, col: kt.col });
          properties.push({ key, value: this.parseAssign() });
        } else properties.push({ key, value: { kind: "Identifier", name: key } }); // shorthand
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat("}");
    return { kind: "ObjectLiteral", properties, loc: { line: braceTok.line, col: braceTok.col, file: this.file } };
  }

  private buildTemplate(raw: string, tok: Token): Expr {
    //@@mutable
    const quasis: string[] = [];
    //@@mutable
    const exprs: Expr[] = [];
    const nul = String.fromCharCode(0);
    let cur = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "\\") {
        // The LEXER's decoder, not a second smaller one — see `decodeEscapeAt`.
        const { text, next } = decodeEscapeAt(raw, i, tok.line, tok.col);
        // NT1705, the same rule `tokenize` puts on a quoted string: a template's escapes
        // are decoded here, so this is the only place a `\0`/`\x00` inside one is visible.
        if (text.indexOf(nul) >= 0) throw nulLiteral("this template literal", tok.line, tok.col);
        cur += text;
        i = next;
        continue;
      }
      if (raw[i] === "$" && raw[i + 1] === "{") {
        quasis.push(cur); cur = "";
        i += 2;
        // Where this substitution BEGINS in the real file. `raw` is the template's inner
        // text, so `raw[0]` sits one column past the opening backtick, and walking to `i`
        // gives the `${`'s own position — which `parseExpressionFrom` rebases the fragment
        // onto so its nodes carry file-absolute positions instead of fragment-relative
        // ones. Counted here rather than inside the scan below because the scan CONSUMES
        // escapes and quoted runs in jumps and would lose track of the newlines in them.
        let subLine = tok.line;
        let subCol = tok.col + 1;
        for (let k = 0; k < i; k++) {
          if (raw[k] === "\n") { subLine++; subCol = 1; } else { subCol++; }
        }
        // Find the substitution's matching `}`. Braces inside a nested template's TEXT
        // or inside a quoted string are not delimiters, so skip both wholesale — the
        // lexer captured them verbatim and `parseExpressionFrom` re-lexes them below.
        let depth = 1;
        let src = "";
        while (i < raw.length && depth > 0) {
          const ch = raw[i]!;
          if (ch === "\\") { src += ch + (raw[i + 1] ?? ""); i += 2; continue; }
          if (ch === "`" || ch === '"' || ch === "'") { const run = skipQuoted(raw, i); src += run.text; i = run.next; continue; }
          if (ch === "{") depth++;
          else if (ch === "}") { depth--; if (depth === 0) break; }
          src += ch; i++;
        }
        i++;
        exprs.push(this.parseSubstitution(src, subLine, subCol));
        continue;
      }
      cur += raw[i]; i++;
    }
    quasis.push(cur);
    return { kind: "TemplateLiteral", quasis, exprs };
  }

  /**
   * Parse ONE `${…}` substitution, in a sub-parser that can see this file's TYPES.
   *
   * A substitution is lexed from its own sliced text, so it needs a parser of its own —
   * and the free `parseExpressionFrom` built that parser from nothing but the tokens. The
   * fragment therefore had an EMPTY type environment, and every type name written inside
   * one was refused as undeclared:
   *
   *     interface P { v: number }
   *     console.log(`${xs.map((a: P): number => a.v).length}`);
   *     // node: 2, exit 0.  nativets, before this: NT2003 Cannot find name 'P'
   *
   * The identical annotation OUTSIDE a template compiled, which is what made it a lie
   * rather than a limitation — and the hint said "'P' is not declared in this file" with
   * the declaration two lines above it. A parse-time refusal on valid TypeScript that
   * node runs; a REFUSAL, so never a wrong answer, but a false one.
   *
   * SEEDED WITH COPIES, and not harvested. The tables are copied rather than shared for
   * the reason `hoistTypeDecls` records at length: a nativets `Map`/`Set` is PERSISTENT,
   * so sharing a receiver and relying on the sub-parser's writes to be visible here is a
   * bun-ism that compiles and silently does nothing. Nothing is harvested back because a
   * substitution is an EXPRESSION — `parseExpression` cannot reach `parseTypeAlias`,
   * `parseInterface` or `parseClass`, so a fragment has no declaration to contribute.
   *
   * `file` goes across too: a diagnostic raised inside a substitution of an imported
   * module was otherwise fileless, and a fileless span is rendered against the ENTRY
   * source (see `prevLoc`).
   *
   * THE FLOATING-ASYNC GUARD IS SEEDED **AND HARVESTED**, which the type tables are not,
   * and the asymmetry is the whole point. That guard accumulates during the parse
   * (`identCalls`, `asyncEscapes`, `returnEscapes`, `awaitedCalls`) and is checked ONCE at
   * the end of `parseProgram` — so state left on the sub-parser is state nothing ever
   * checks. With the fragment parsed in isolation, `` `${one()}` `` on an `async function`
   * printed `1` where node prints `[object Promise]`, both exit 0: a SILENT WRONG ANSWER,
   * and the identical call one character outside the backticks is NT1020. That is a worse
   * failure than the false refusal above and it was found the same way.
   *
   * The seed/harvest split follows what each field means. `asyncParamScopes` is seeded
   * because `scopedAsync` can only be decided AT the escape, from the parameter scopes open
   * around it; `asyncFns` is seeded for the same-frame reads, but a name declared LATER in
   * the file still resolves, because what comes back is the raw `identCalls` entry and
   * `checkFloatingAsyncCalls` resolves the name against the finished set. `awaitedCalls`
   * has to come back or `` `${await one()}` `` would be refused as floating.
   */
  private parseSubstitution(src: string, line: number, col: number): Expr {
    const sub = new Parser(rebaseTokens(tokenize(src), line, col), { file: this.file });
    for (const [k, v] of this.typeAliases) sub.typeAliases = sub.typeAliases.set(k, v);
    for (const [k, v] of this.recTypes) sub.recTypes = sub.recTypes.set(k, v);
    for (const [k, v] of this.declaredTypeLines) sub.declaredTypeLines = sub.declaredTypeLines.set(k, v);
    for (const [k, v] of this.cyclicTypes) sub.cyclicTypes = sub.cyclicTypes.set(k, v);
    for (const n of this.declaredClassNames) sub.declaredClassNames = sub.declaredClassNames.add(n);
    for (const n of this.cycleNames) sub.cycleNames = sub.cycleNames.add(n);
    for (const n of this.mutableRecords) sub.mutableRecords = sub.mutableRecords.add(n);
    // The three "do not refuse this name" sets, merged rather than assigned: the
    // constructor's own lexical scan has already filled them from the FRAGMENT's tokens,
    // and over-collection may only ever preserve today's behavior for a name.
    for (const n of this.externalNames) sub.externalNames = sub.externalNames.add(n);
    for (const n of this.fragmentNames) sub.fragmentNames = sub.fragmentNames.add(n);
    for (const n of this.genericParamNames) sub.genericParamNames = sub.genericParamNames.add(n);
    // A generic FUNCTION's type parameters are a STACK of frames, and the substitution is
    // lexically inside every one currently open — `function f<T>(x: T) { return
    // `${g((y: T) => y)}`; }` names `T`. Flattened into `inheritedTypeParams`, which is
    // what that field exists for; the query is "any open frame", so merging is exact.
    for (const s of this.typeParamScopes) for (const n of s) sub.inheritedTypeParams = sub.inheritedTypeParams.add(n);
    for (const n of this.inheritedTypeParams) sub.inheritedTypeParams = sub.inheritedTypeParams.add(n);
    // ---- the floating-async guard: seeded, then harvested on every path.
    for (const n of this.asyncFns) sub.asyncFns = sub.asyncFns.add(n);
    for (const n of this.returnsAsyncFn) sub.returnsAsyncFn = sub.returnsAsyncFn.add(n);
    for (const [k, v] of this.promiseParamsByFn) sub.promiseParamsByFn = sub.promiseParamsByFn.set(k, v);
    for (const s of this.asyncParamScopes) for (const n of s) sub.inheritedAsyncParams = sub.inheritedAsyncParams.add(n);
    for (const n of this.inheritedAsyncParams) sub.inheritedAsyncParams = sub.inheritedAsyncParams.add(n);
    const out = sub.parseExpression();
    for (const c of sub.identCalls) this.identCalls.push(c);
    for (const e of sub.asyncEscapes) this.asyncEscapes.push(e);
    for (const r of sub.returnEscapes) this.returnEscapes.push(r);
    // (no `awaitedCalls` merge: the stamp lives on the shared node and travels for free)
    // (no `asyncFnExprs` merge either: the stamp is on the shared node)
    for (const n of sub.hostImports) this.hostImports = this.hostImports.add(n);
    return out;
  }
}

/**
 * The result of copying one quoted run: the verbatim text, and the index just past it.
 *
 * A RECORD, not the `[string, number]` tuple this started as — the same fix, for the same
 * reason, as `DecodedEscape` in `src/lexer.ts`. `parseTupleType` erases `[T, U]` to `T[]`,
 * so `next` typed as `string` and `i = next` was rejected as `NT2001 Cannot assign string
 * to number 'i'` — a LYING diagnostic, on TypeScript that `tsc` accepts and node runs.
 *
 * That single erasure was the first blocker of FIVE modules at once — `parser`, `modules`,
 * `driver`, `coverage`, `cli` — because every one of them reaches this function through
 * the template-literal builder. `parseTupleType` now REFUSES a heterogeneous tuple
 * outright (NT2601) rather than erasing one element's type into another's, so this
 * particular lie cannot be told again.
 */
export interface QuotedRun { text: string; next: number; }

/**
 * Copy a quoted run (a `'`/`"` string or a nested `` ` `` template) starting at `i`
 * verbatim, returning the text and the index just past it. A nested template's own
 * `${…}` substitutions are skipped recursively, so `` `${a ? `}` : b}` `` stays intact.
 */
function skipQuoted(raw: string, i: number): QuotedRun {
  const q = raw[i]!;
  let out = q;
  i++;
  while (i < raw.length && raw[i] !== q) {
    const ch = raw[i]!;
    if (ch === "\\") { out += ch + (raw[i + 1] ?? ""); i += 2; continue; }
    if (q === "`" && ch === "$" && raw[i + 1] === "{") {
      out += "${"; i += 2;
      let depth = 1;
      while (i < raw.length && depth > 0) {
        const c2 = raw[i]!;
        if (c2 === "\\") { out += c2 + (raw[i + 1] ?? ""); i += 2; continue; }
        if (c2 === "`" || c2 === '"' || c2 === "'") { const run = skipQuoted(raw, i); out += run.text; i = run.next; continue; }
        if (c2 === "{") depth++;
        else if (c2 === "}") depth--;
        out += c2; i++;
      }
      continue;
    }
    out += ch; i++;
  }
  return { text: out + q, next: i + 1 };
}

/** Every `return <expr>` in a statement list, recursively. Expressions are not walked,
 *  so a nested arrow's own returns (a different function) are correctly ignored. */
/** The recursive half of `valueReturns`, with the accumulator as a `//@@mutable`
 *  PARAMETER rather than a capture.
 *
 *  It was a nested `const walk = (stmts) => …` closing over `out`, which is `NT1607` BY
 *  DECISION: a closure has its own environment, so the declaring scope is no longer the
 *  only handle on the accumulator and the in-place append cannot be proved sound. That
 *  refusal stands — this is not a way around it. The per-parameter opt-in is the sanctioned
 *  spelling for exactly this shape (the obligation travels to the call site, which a
 *  capture cannot express), and `walk` is RECURSIVE so the inline-it-at-the-call-sites fix
 *  that unblocked coverage-preprocess.ts is not available here. */
function collectValueReturns(
  stmts: Stmt[],
  //@@mutable
  out: Expr[],
): void {
  for (const s of stmts) {
    switch (s.kind) {
      case "ReturnStmt": if (s.argument) out.push(s.argument); break;
      case "IfStmt":
        collectValueReturns(s.consequent, out);
        if (s.alternate) collectValueReturns(s.alternate, out);
        break;
      case "WhileStmt": case "DoWhileStmt": case "ForStmt": case "ForOfStmt": case "ForInStmt":
      case "BlockStmt": collectValueReturns(s.body, out); break;
      case "SwitchStmt": for (const c of s.cases) collectValueReturns(c.body, out); break;
      case "TryStmt":
        collectValueReturns(s.block, out);
        if (s.handler) collectValueReturns(s.handler, out);
        if (s.finalizer) collectValueReturns(s.finalizer, out);
        break;
      case "MultiStmt": collectValueReturns(s.stmts, out); break;
      default: break;
    }
  }
}

function valueReturns(list: Stmt[]): Expr[] {
  //@@mutable
  const out: Expr[] = [];
  collectValueReturns(list, out);
  return out;
}

/**
 * Tokenize, turning a lexical failure into the ordinary NT0001 syntax error.
 *
 * `LexError` is a plain `Error` subclass and has to stay one — it lives in the compiler's
 * OWN source, and `extends Error` is the only inheritance nativets compiles, so making it
 * an NTError would add a self-hosting blocker to lexer.ts. Translating HERE keeps the
 * lexer self-hostable and still gives the user a code: without this a missing closing
 * quote printed a raw Bun stack trace naming src/lexer.ts. node rejects these too
 * (SyntaxError), so they are syntax errors — the same NT0001 every other parse failure
 * uses — not deferred features. The message already carries `at line:col`.
 */
function tokenize(source: string): Token[] {
  let tokens: Token[];
  try {
    tokens = lex(source);
  } catch (e) {
    if (e instanceof LexError) throw parseError(e.message);
    throw e;
  }
  // The check does not HAND THE ARRAY BACK. A parameter is a BORROW — the caller owns it
  // and drops it — so `return tokens` from inside made the receiver a second owner and was
  // NT1604. It is a pure predicate over the tokens (it only throws), so `void` says what it
  // does and this scope keeps the one ownership it always had.
  checkNoNul(tokens);
  return tokens;
}

/**
 * NT1705 — refuse a string literal whose decoded value contains a NUL (U+0000).
 *
 * Here, over the TOKEN stream, rather than at the one `parsePrimary` site that builds a
 * `StringLiteral`: a `str` token is also an object key, an import specifier and a string
 * LITERAL TYPE, and every one of those becomes a runtime string. One pass over the tokens
 * covers all of them and cannot be forgotten when a new consumer of `str` is added.
 *
 * Template literals are not decoded yet at this point (the token holds RAW inner text, and
 * `buildTemplate` splits it), so a template's own escapes are checked there. A raw NUL
 * BYTE pasted into a template's text is visible here and is caught here.
 */
function checkNoNul(tokens: Token[]): void {
  const nul = String.fromCharCode(0);
  for (const t of tokens) {
    if (t.type === "str" && t.value.indexOf(nul) >= 0) throw nulLiteral("this string literal", t.line, t.col);
    if (t.type === "template" && t.value.indexOf(nul) >= 0) throw nulLiteral("this template literal", t.line, t.col);
  }
}

export function parse(source: string, opts: ParseOpts = {}): Program {
  return new Parser(tokenize(source), opts).parseProgram();
}

/**
 * Re-base a fragment's token stream onto the position the fragment occupies in the REAL
 * file, so every node parsed from it carries a file-absolute `loc`.
 *
 * THE FRAGMENT OFFSET, threaded. A template substitution is lexed from its own source
 * text (`buildTemplate` slices `${…}` out and hands it here), so without this every node
 * inside one is at line 1 of a one-line file. That is not a cosmetic problem: it is a
 * WRONG position rather than a missing one, and it printed the file's first line under
 * the caret — `// line 1` — for a read three lines further down. `src/checker.ts`'s
 * string-coercion arm worked around it by passing NO location at all, on the (correct)
 * grounds that a wrong line is worse than none, and left a note saying this was the fix
 * to make. Every OTHER diagnostic reachable inside a substitution kept the wrong one;
 * NT2001 on `` `${b.missing}` `` reported 1:2 in a 10-line file.
 *
 * Shifting the TOKENS rather than the parsed nodes is what keeps this to one function.
 * Writing `loc` onto the tree afterwards would need one arm per `Expr` member — `loc`
 * sits at slot 3 on `Identifier` and slot 5 on the four call/member forms, and a
 * duck-typed `(e as {loc?: Loc}).loc = …` window names slot 0, i.e. the DISCRIMINANT
 * (see test/cast-write.test.ts, where exactly that corrupted every member it touched).
 * A token is a flat 4-field record with nothing to get wrong.
 *
 * Only relative line 1 takes the column shift: it is the line the `${` sits on, so the
 * fragment's columns are measured from partway across it. Every later line of a
 * multi-line substitution starts at column 1 in both frames.
 */
function rebaseTokens(tokens: Token[], line: number, col: number): Token[] {
  return tokens.map((t) => ({
    type: t.type,
    value: t.value,
    line: line + t.line - 1,
    col: t.line === 1 ? col + t.col - 1 : t.col,
  }));
}

/**
 * `line`/`col` are where `source` STARTS in the enclosing file (1-based). They default to
 * the identity so the standalone callers — and test/diagnostics.test.ts — are unchanged.
 */
export function parseExpressionFrom(source: string, line: number = 1, col: number = 1): Expr {
  return new Parser(rebaseTokens(tokenize(source), line, col)).parseExpression();
}
