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
  makeNullable, makeMapTy, makeSetTy, makeFuncTy, objectType, typeParamTy, eraseTypeParams, mapTypesDeep,
  isObjectTy, isFuncTy, classTag, makeUnionTy, unionDiscriminant, widenLiteralTys, stringLitTy, isUnionTy,
  tagValueIsEncodable, objectFields, isStringLitTy, HOST_MODULES, unionMembers,
  makeGeneralUnionTy, isGeneralUnionArm, typeofTagOf,
  resolveStaticFieldReads, collectBindingNames, typeRefTy, expandTypeRef, makeArrayTy,
} from "./ast.ts";
import type {
  Program, Stmt, Expr, Param, VarDecl, Declarator, Ty, BinaryOp, SwitchCase, ObjectProperty, FuncDecl,
  ImportDecl, TextImport, ExportTable,
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
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="]);
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

/**
 * `@@mutable` + RECURSIVE — the one combination that can build a real CYCLE, refused.
 *
 * A recursive value is a TREE as long as nobody can write into it: linearity forbids a
 * second owner, so `a.next = b; b.next = a` is NT1601 and `link(o: N) { this.next = o }` is
 * NT1604. `@@mutable class N { next?: N; loop() { this.next = this } }` compiled and ran,
 * and `this` is not a second owner — so the graph closes.
 *
 * MEASURED, and the measurement corrected the reason this was written down for. The
 * predicted cost was a LEAK (drop is shallow, so a cycle is never freed). Against a control
 * it is not: `__objLive()` is 1 after the identical class WITHOUT the cycle, so that leak is
 * the pre-existing shallow-drop one and the cycle adds nothing. What a cycle actually costs
 * is a SILENT WRONG ANSWER, which is worse — `console.log` prints
 *   node:     <ref *1> N { v: 7, next: [Circular *1] }
 *   nativets: N { v: 7, next: N { v: 7, next: N { v: 7, next: [N] } } }
 * because `genInspect` unfolds the back-edge and stops on util.inspect's DEPTH limit, which
 * is a cap on nesting and not a cycle detector. Every walk over a value assumes a tree.
 */
function recursiveMutableError(name: string, what: string): NTError {
  return nyi(
    NYI.FORWARD_TYPE,
    `'@@mutable ${what} ${name}' is RECURSIVE — it contains itself, and it can be mutated in place`,
    "in-place mutation of a self-containing value can close a CYCLE (`this.next = this`), and every walk over a " +
    "value here assumes a tree: `console.log` unfolds until util.inspect's depth limit and prints nesting where " +
    "node prints `[Circular *1]`, and the deep copies (structuredClone, an actor message) have no seen-set either. " +
    "Drop the `@@mutable` and rebuild the value (`{ ...n, next: x }`), or make the recursive field non-recursive — " +
    "see docs/divergences.md",
  );
}

/** Truncate for a diagnostic: a type dump is unbounded and a hint has to stay readable. */
function clip(s: string, n: number): string { return s.length <= n ? s : `${s.slice(0, n)}…`; }

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
  /** Every `class X` declared in this file. A class declares a TYPE too (`parseClass`
   *  registers its instance shape), and classes are NOT hoisted — so the hoisting
   *  fixpoint has to know to keep its hands off a declaration that names one. */
  private declaredClassNames = new Set<string>();
  /**
   * Names whose declaration this parse CANNOT SEE — so "I have no shape for it" says
   * nothing about whether it exists, and NT2003 must not fire. Two sources:
   *
   *   1. every identifier an `import` in this file binds, collected lexically from the
   *      token stream in the constructor (`scanExternalNames`), like `declaredTypeLines`
   *      and for the same reason: a hoisting sub-parser starts in the MIDDLE of the file
   *      and never sees the import list at all;
   *   2. `ParseOpts.externalTypeNames`, for a caller parsing a FRAGMENT of a file whose
   *      declarations it already stripped — `coverage`, which erases the module preamble
   *      and every `type`/`interface` and then parses statement by statement.
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
  private awaitedCalls = new Set<Expr>();        // call nodes that are the operand of an `await`
  /** Arrow nodes that were written `async` — the bridge from an erased async ARROW back
   *  to the NAME it gets bound to, which is what `asyncFns` (and the guard) work in. */
  private asyncFnExprs = new Set<Expr>();
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
  private promiseParamsByFn = new Map<string, Set<number>>();
  private promiseParamsByArrow = new Map<Expr, Set<number>>();
  /** Filled by whichever parameter list was parsed last; read immediately after. */
  private lastPromiseParams = new Set<number>();
  private lastPromiseParamNames = new Set<string>();
  /** SCOPED, unlike `asyncFns`. A parameter name is not a module-level fact: two unrelated
   *  functions both taking an `f` — one `() => Promise<number>`, one `() => number` — must
   *  not contaminate each other, and putting parameters in the flat set did exactly that
   *  (`twice(f: () => number) { return f() + f(); }` was rejected because a DIFFERENT
   *  function's `f` was promise-typed). One frame per function/arrow body being parsed. */
  private asyncParamScopes: Set<string>[] = [];
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
  private readonly mutableClasses = new Set<string>();
  /** `static` FIELD names, class-qualified (`C.f`) — the module-level bindings they
   *  lower to, and what a `C.f` read is rewritten to once the file is parsed. */
  private readonly staticFieldNames = new Set<string>();
  /** RECORD type names carrying `@@mutable` (`@@mutable type Cell = { n: number }`) —
   *  an extension of the class attribute to a `type`/`interface` declaration. The record
   *  is tagged with this name (`Cell{n:number}`), so mutability is NOMINAL rather than
   *  structural; published on the Program for the checker + ownership pass. */
  private readonly mutableRecords = new Set<string>();
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
  private readonly hostImports = new Set<string>();
  private readonly hostAliases = new Map<string, string>();
  private exportValues = new Map<string, string>();
  private exportReexports = new Map<string, { source: string; imported: string; line: number }>();
  private exportTypes = new Set<string>();
  private file?: string;
  private collectTypes?: Map<string, Ty>;
  constructor(private toks: Token[], opts: ParseOpts = {}) {
    if (opts.typeEnv) for (const [k, v] of opts.typeEnv) this.typeAliases.set(k, v);
    if (opts.asyncEnv) for (const n of opts.asyncEnv) this.asyncFns.add(n);
    this.file = opts.file;
    this.collectTypes = opts.collectTypes;
    if (opts.externalTypeNames) for (const n of opts.externalTypeNames) this.externalNames.add(n);
    // Pre-scan for declared type names. Lexical on purpose: `interface`/`type` followed by
    // an identifier is unambiguous in the token stream, and this has to run BEFORE any
    // parsing so a name's declaration is known no matter where it sits in the file.
    let depth = 0; // brace depth, so `typeDeclStarts` can keep to top-level declarations
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i]!;
      const n = toks[i + 1]!;
      if (t.type === "punct" && t.value === "{") depth++;
      else if (t.type === "punct" && t.value === "}") depth--;
      else if (t.type === "ident" && t.value === "class" && n.type === "ident") this.declaredClassNames.add(n.value);
      else if ((t.value === "interface" || t.value === "type") && t.type === "ident" && n.type === "ident") {
        // `type X =` only — `type` is not a reserved word, so `const type = 1` must not
        // register `= 1` as a declaration. `interface` is always a declaration.
        if (t.value === "interface" || toks[i + 2]?.value === "=" || toks[i + 2]?.value === "<") {
          if (!this.declaredTypeLines.has(n.value)) this.declaredTypeLines.set(n.value, t.line);
          if (depth === 0 && !this.typeDeclStarts.has(n.value)) {
            // Walk back over the declaration's prefix so a re-parse from here sees the
            // whole thing: `export`, then any `@@attr` / `@wrapper` pair before it.
            let s = i;
            if (s > 0 && toks[s - 1]!.value === "export") s--;
            while (s >= 2 && toks[s - 1]!.type === "ident" && (toks[s - 2]!.value === "@@" || toks[s - 2]!.value === "@")) s -= 2;
            this.typeDeclStarts.set(n.value, s);
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
   */
  private scanExternalNames(toks: Token[]): void {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.type !== "ident" || t.value !== "import") continue;
      // `import("m").T` — an inline import TYPE, not a declaration. It binds nothing.
      if (toks[i + 1]?.value === "(") continue;
      for (let j = i + 1; j < toks.length; j++) {
        const u = toks[j]!;
        if (u.type === "string") break;                       // reached the module specifier
        if (u.type === "ident" && u.value === "from") break;
        if (u.type !== "ident") continue;                     // `{` `}` `,` `*` punctuation
        if (u.value === "type" || u.value === "as") continue; // modifier keywords, not bindings
        this.externalNames.add(u.value);
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
    const blocker = new Map<string, string>(); // name -> the unresolved type it stopped on
    while (pending.length) {
      const deferred: string[] = [];
      for (const name of pending) {
        const sub = new Parser(this.toks, { typeEnv: this.typeAliases, file: this.file });
        sub.pos = this.typeDeclStarts.get(name)!;
        sub.hoisting = true;
        try {
          sub.parseStatement();
        } catch (e) {
          if (e instanceof NTError && e.diag.code === NYI.FORWARD_TYPE.code) {
            deferred.push(name);
            if (sub.blockedOn !== undefined) blocker.set(name, sub.blockedOn);
            continue;
          }
          continue; // a real refusal — leave it to the main parse, where it belongs
        }
        const ty = sub.typeAliases.get(name);
        if (ty !== undefined) this.typeAliases.set(name, ty);
        // A shape with a `@Name` back-edge is meaningless without the table that resolves
        // it, and the sub-parser is where both were produced. Carry it back with the alias.
        for (const [n, shape] of sub.recTypes) this.recTypes.set(n, shape);
      }
      if (deferred.length < pending.length) { pending = deferred; continue; }
      // No progress. Everything left is stuck — but on WHAT matters: stuck on another
      // stuck name is a cycle (unfixable), stuck on a name that failed for its own reason
      // is not, and must not be reported as recursion.
      const stuck = new Set(deferred);
      for (const name of deferred) {
        const b = blocker.get(name);
        if (b !== undefined && stuck.has(b)) this.cyclicTypes.set(name, b);
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
    for (const n of names) this.cycleNames.add(n);
    const recBefore = new Map(this.recTypes); // restored wholesale if the round stalls
    const resolved = new Map<string, Ty>();
    let pending = names;
    while (pending.length) {
      const deferred: string[] = [];
      const why = new Map<string, string>(); // residual member -> the error it stalled with
      for (const name of pending) {
        const sub = new Parser(this.toks, { typeEnv: this.typeAliases, file: this.file });
        sub.pos = this.typeDeclStarts.get(name)!;
        sub.hoisting = true;
        sub.cycleNames = this.cycleNames;
        sub.recTypes = this.recTypes; // shared: an earlier round's shapes are what unions expand through
        try {
          sub.parseStatement();
        } catch (e) {
          deferred.push(name); // may only need a member that has not settled yet
          why.set(name, String((e as { message?: string }).message ?? e).split("\n")[0]!);
          continue;
        }
        const ty = sub.typeAliases.get(name);
        if (ty === undefined) { deferred.push(name); continue; }
        resolved.set(name, ty);
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
          .map((n) => `'${n}': ${clip(why.get(n) ?? "no shape was produced", 160)}`);
        this.cycleStall = sample.join("; ") + (deferred.length > sample.length ? ` (and ${deferred.length - sample.length} more that select over them)` : "");
        this.cycleStallSize = { total: names.length, left: deferred.length };
        for (const n of names) this.cycleNames.delete(n);
        this.recTypes.clear();
        for (const [n, s] of recBefore) this.recTypes.set(n, s);
        return;
      }
      pending = deferred;
    }
    for (const [n, ty] of resolved) this.typeAliases.set(n, ty);
    // These names are no longer an ordering failure, so the NT1030 the main parse would
    // report for them is withdrawn.
    for (const n of names) this.cyclicTypes.delete(n);
  }

  private freshTmp(): string { return `__d${this.tmpCounter++}`; }
  /** `const` declarators desugared from binding patterns in the parameter list being
   *  parsed; spliced at the top of that function's body (see parsePatternParam). */
  private paramPrelude: Stmt[] = [];
  private ident(name: string): Expr { return { kind: "Identifier", name }; }

  /**
   * In-scope generic type parameters (M3). Pushed while parsing a generic function's
   * signature + body, so a use of `T` in an annotation resolves to the MARKER `#T`
   * (which the checker later substitutes per instantiation) instead of erasing to
   * `number`. Empty for ordinary code, so nothing else changes.
   */
  private typeParamScopes: Set<string>[] = [];
  private inTypeParamScope(id: string): boolean {
    for (let i = this.typeParamScopes.length - 1; i >= 0; i--) if (this.typeParamScopes[i]!.has(id)) return true;
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
    if (id === this.declaringType) {
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
      const used = this.toks[this.pos - 1]?.line ?? declaredAt;
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
    if (AMBIENT_TYPES.has(id)) return;      // a global the program never had to declare
    if (this.externalNames.has(id)) return; // imported, or stripped by a fragment-parsing caller
    const t = this.toks[this.pos - 1];
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
        `use of class type '${id}' before its declaration${t === undefined ? "" : ` (used at line ${t.line})`}`,
        "a class is not hoisted the way `type`/`interface` is — its instance shape only exists once the class body has been parsed, so a class named in an annotation must be declared ABOVE its first use. Move the `class` declaration up; see docs/divergences.md",
      );
    }
    throw unknownTypeName(id, t === undefined ? undefined : { line: t.line, col: t.col });
  }

  private peek(o = 0): Token { return this.toks[this.pos + o]!; }
  private next(): Token { return this.toks[this.pos++]!; }
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
  private expectKey(): string {
    const t = this.peek();
    if (t.type === "ident" || t.type === "str") { this.next(); return t.value; }
    if (t.type === "num") { this.next(); return t.value; }
    throw parseError(`Expected property key at ${t.line}:${t.col}`);
  }

  parseProgram(): Program {
    this.hoistTypeDecls();
    const body: Stmt[] = [];
    while (this.peek().type !== "eof") body.push(this.parseStatement());
    this.checkFloatingAsyncCalls(body);
    this.checkAsyncEscapes();
    // Class members lower to top-level functions (`C.constructor`, `C.method`) so they
    // register + hoist alongside ordinary functions for the checker/codegen.
    body.push(...this.hoistedFns);
    // A static field is a module-level `const C.f` (see `parseClass`), so every `C.f` READ
    // becomes that identifier — here, once the whole file is parsed, because a function
    // body may legally read a static of a class declared further down.
    if (this.staticFieldNames.size) {
      // The rewrite is by NAME and has no scope, so a binding that shadows the class name
      // would redirect `C.f` to the static instead of the shadowing value — a silent wrong
      // answer. Refuse the program instead (reject, never miscompile).
      const bound = new Set<string>();
      collectBindingNames(body, bound);
      for (const f of this.staticFieldNames) {
        const cls = f.slice(0, f.indexOf("."));
        if (bound.has(cls)) throw nyi(NYI.CLASS_FEATURE, `a binding shadows class '${cls}', which has static fields (\`${f}\`); rename it`);
      }
      resolveStaticFieldReads(body, this.staticFieldNames, (n) => {
        throw mutationError(`assignment to the static field '${n}'`,
          "a static field is module-level storage initialized once where the class is declared — it is a `const`, so give the class a static METHOD that returns the value you want instead");
      });
    }
    const program: Program = { kind: "Program", body };
    // `@@mutable` classes (decorators lane). Attached only when the source used the
    // attribute, so an ordinary program's Program is byte-identical to what it was.
    if (this.mutableClasses.size) program.mutableClasses = [...this.mutableClasses];
    if (this.mutableRecords.size) program.mutableRecords = [...this.mutableRecords];
    // Recursive-type shapes (`@Name` back-edges). Absent unless the source declared one.
    if (this.recTypes.size) program.recTypes = [...this.recTypes];
    // Host FFI (SH4) — attached only when the source imported a `node:` builtin.
    if (this.hostImports.size) program.hostImports = [...this.hostImports];
    if (this.collectTypes) for (const [k, v] of this.typeAliases) this.collectTypes.set(k, v);
    // Only attach the module surface when the source actually used it, so a
    // single-file program's Program is byte-identical to what it always was.
    if (this.imports.length) program.imports = this.imports;
    if (this.textImports.length) program.textImports = this.textImports;
    if (this.exportValues.size || this.exportReexports.size || this.exportTypes.size) {
      const types = new Map<string, Ty>();
      for (const n of this.exportTypes) { const t = this.typeAliases.get(n); if (t) types.set(n, t); }
      program.exports = { values: this.exportValues, reexports: this.exportReexports, types, asyncValues: this.exportAsync } satisfies ExportTable;
    }
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
    const last = body[body.length - 1];
    const entrypoint = last && last.kind === "ExprStmt" ? last.expr : null;
    for (const c of this.identCalls) {
      if (!(c.scopedAsync || this.asyncFns.has(c.name))) continue;
      if (this.awaitedCalls.has(c.node) || c.node === entrypoint) continue;
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
      if (e.callee !== null && this.promiseParamsByFn.get(e.callee)?.has(e.index)) continue;
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

  /** Is `n` a `(…) => Promise<T>` parameter of some enclosing body being parsed? */
  private inAsyncParamScope(n: string): boolean {
    for (const s of this.asyncParamScopes) if (s.has(n)) return true;
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
    const arms: Ty[] = [this.parseTypeAtom()];
    let sawIntersect = false;
    while (this.at("|") || this.at("&")) { if (this.at("&")) sawIntersect = true; this.next(); arms.push(this.parseTypeAtom()); }
    if (arms.length === 1) return arms[0]!;
    // Literal arms of the same base collapse (`"a" | "b"` → string), exactly as before.
    const uniq = [...new Set(arms.map(widenLiteralTys))];
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
      if (uniq.every(isGeneralUnionArm) && new Set(uniq.map(typeofTagOf)).size === uniq.length) return makeGeneralUnionTy(uniq);
    }
    throw nyi(NYI.OPTIONAL_CHAIN, `general union type '${arms.map(widenLiteralTys).join(sawIntersect ? " & " : " | ")}' (only 'T | undefined' / 'T | null', a DISCRIMINATED union of object types — a common literal-typed tag field at the same position in every member — and a general union of arms \`typeof\` can tell apart are supported)`);
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
    const arms: Ty[] = [];
    for (const a of rawArms.map((a) => expandTypeRef(a, this.recTypes))) {
      if (isUnionTy(a)) arms.push(...unionMembers(a)); else arms.push(a);
    }
    if (!arms.every((a) => isObjectTy(a) && classTag(a) === undefined)) return null;
    const members = [...new Set(arms)];
    const shown = members.map(widenLiteralTys).join(" | ");
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
        : common.some((k) => members.every((m) => isStringLitTy(objectFields(m).find((f) => f.key === k)!.ty)))
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
  private refuseTypeQuery(): never {
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
    const f = objectFields(base).find((x) => x.key === key);
    if (!f) {
      const have = objectFields(base).map((x) => x.key);
      throw nyi(
        NYI.INDEXED_ACCESS,
        `indexed access type '${display}["${key}"]' — '${display}' has no field '${key}'`,
        have.length === 0
          ? `'${display}' has no fields to look up`
          : `'${display}' has: ${have.join(", ")}`,
      );
    }
    return f.ty;
  }
  // Inline import type `import("./mod").Name` (optionally qualified) — erased to the
  // referenced named type (an alias if known, else `number`). The module path is dropped.
  private parseImportType(): Ty {
    this.eat("import"); this.eat("(");
    this.next(); // module path string literal
    this.eat(")"); this.eat(".");
    let name = this.expectIdent();
    while (this.at(".")) { this.eat("."); name = this.expectIdent(); } // import("m").Ns.Type
    // The name belongs to the OTHER module, so "declared nowhere in this file" says nothing
    // about it — NT2003 would be a false refusal by construction. Keep the old fallback.
    this.externalNames.add(name);
    return this.resolveNamed(name);
  }
  // A generic type reference `Name<T, U>` in type position. Generics carry no runtime
  // in this subset, so the arg list is parsed for grammar and then ERASED to a concrete
  // supported shape (never miscompiled): container/wrapper/utility types map to their
  // erasure; a type parameter or unknown generic falls back through `resolveNamed`.
  private parseGenericType(id: string): Ty {
    const a = this.parseTypeArgs();
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
      // multi-arg utility types erase to their first (subject) type argument
      case "Extract":
      case "Exclude":
      case "Omit":
      case "Pick":
      case "Parameters":
      case "ReturnType": return a[0] ?? "number";
      // unknown generic / type parameter used with args: erase args, resolve the base name
      default: return this.resolveNamed(id);
    }
  }
  // generic type-argument list `<T, U>` — parsed everywhere a `<...>` type-arg list
  // appears (annotations, `new X<..>()`, call-site `f<..>()`); the args are erased.
  private parseTypeArgs(): Ty[] {
    this.eat("<");
    const tys: Ty[] = [];
    if (!this.at(">")) { do { tys.push(this.parseType()); } while (this.at(",") && (this.eat(","), true)); }
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
    const t = this.peek();
    if (t.type === "punct" && (t.value === ">>" || t.value === ">>>")) {
      t.value = t.value.slice(1); // leaves `>` (or `>>`) for the outer level
      return;
    }
    this.eat(">");
  }
  // tuple type `[T, U, ...]` — modeled as an array of the first element type
  private parseTupleType(): Ty {
    this.eat("[");
    const tys: Ty[] = [];
    if (!this.at("]")) { do { tys.push(this.parseType()); } while (this.at(",") && (this.eat(","), true)); }
    this.eat("]");
    return makeArrayTy(tys[0] ?? "number");
  }
  /**
   * A leading `(` in type position is either a function type's parameter list
   * (`(a: T) => U`) or a PARENTHESIZED type (`(() => Scope) | null`, `(number)[]`).
   * Parens carry no meaning of their own — they only group — so try the function-type
   * grammar and fall back to "parse a type, expect `)`", which is transparent.
   */
  private parseParenOrFuncType(): Ty {
    const save = this.pos;
    try { return this.parseFuncType(); } catch { this.pos = save; }
    this.eat("(");
    const inner = this.parseType();
    this.eat(")");
    return inner;
  }

  private parseFuncType(): Ty {
    this.eat("(");
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
    const fields: string[] = [];
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
    return `{${fields.join(",")}}` as Ty;
  }

  // Consume a generic type-parameter list `<T, U extends V, W = X>` (balanced angles)
  // and return the declared PARAMETER NAMES. Constraints (`extends V`) and defaults
  // (`= X`) are erased: monomorphization specializes on the types that actually flow,
  // so a constraint adds no information the instantiation doesn't already carry.
  private parseTypeParamList(): string[] {
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
  // Skip an erased generic type-parameter list (names discarded).
  /**
   * A generic DECLARATION's own type parameters (`type X<T> = …`, `interface X<T> { … }`).
   *
   * They are still ERASED — `T` in the body falls back to `number` exactly as it always
   * did, and nothing about what the declaration means changes here. What changed is that
   * "declared nowhere" is now a refusal (NT2003), and `T` IS declared: right there in the
   * `<…>` this function was throwing away. So the names are kept as a reason NOT to refuse
   * — the same role an import binding plays — rather than as a reason to resolve, which
   * would make `T` a `#T` marker and change every generic alias in the tree.
   *
   * Not `typeParamScopes` for that reason, and file-wide rather than scoped for the same
   * one: over-collecting here can only ever preserve today's behavior for a name.
   */
  private skipGenerics(): void { for (const p of this.parseTypeParamList()) this.externalNames.add(p); }

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
    this.typeAliases.set(name, this.recordTypeDecl(name, this.applyRecordAttrs(dec, name, rhs, "type"), recursive));
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
    this.mutableRecords.add(name);
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
    this.typeAliases.set(name, this.recordTypeDecl(name, this.applyRecordAttrs(dec, name, shape, "interface"), recursive));
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
    if (this.mutableRecords.has(name)) throw recursiveMutableError(name, "record");
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
    this.recTypes.set(name, shape);
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
      this.hostImports.add(c.name);
      if (c.alias !== c.name) this.hostAliases.set(c.alias, c.name);
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
        for (const c of clause) if (!c.typeOnly) this.exportReexports.set(c.alias, { source, imported: c.name, line: kw.line });
        // A re-export is also a dependency edge (the module must be loaded/ordered).
        this.imports.push({ source, specs: [], line: kw.line });
      } else {
        // `export { type T }` re-publishes a local type alias; a plain spec is a value.
        for (const c of clause) c.typeOnly ? this.exportTypes.add(c.name) : this.exportValues.set(c.alias, c.name);
      }
      if (this.at(";")) this.eat(";");
      return { kind: "MultiStmt", stmts: [] };
    }
    // `export type X = …` / `export interface X { … }` — type-level, erased, but the
    // shape is published so an importing module's annotations resolve to it.
    if (this.at("type") && this.peek(1).type === "ident") { const name = this.peek(1).value; const s = this.parseTypeAlias(); this.exportTypes.add(name); return s; }
    if (this.at("interface")) { const name = this.peek(1).value; const s = this.parseInterface(); this.exportTypes.add(name); return s; }
    // `export class C { … }` — the class name is BOTH a value (its ctor/methods lower
    // to `C.constructor` / `C.m`) and a type (the tagged instance shape).
    if (this.at("class")) { const name = this.peek(1).value; const s = this.parseClass(); this.exportValues.set(name, name); this.exportTypes.add(name); return s; }
    // `export function f() {…}` — and `export async function f() {…}`, which is the
    // same thing: `async` is ERASED here exactly as at statement level (see the
    // async/await note above), so the export publishes an ordinary function.
    if (this.at("function") || (this.at("async") && this.peek(1).value === "function")) {
      const isAsync = this.at("async");
      if (isAsync) { this.next(); this.asyncFns.add(this.peek(1).value); }
      const s = this.parseFuncDecl() as FuncDecl;
      this.exportValues.set(s.name, s.name);
      // Publish the async-ness: erasure makes it invisible in the exported value, and
      // an importing module needs it to refuse a call without `await` (NT1020).
      if (isAsync) this.exportAsync.add(s.name);
      return s;
    }
    if (this.at("let") || this.at("const")) {
      const d = this.parseVarDecl();
      this.eat(";");
      for (const decl of d.decls) {
        this.exportValues.set(decl.name, decl.name);
        // `export const f = async () => …` is just as promise-returning as `export async
        // function f`, so it publishes async-ness the same way. parseDeclarator has
        // already put an async arrow (or an alias of one) into `asyncFns`.
        if (this.asyncFns.has(decl.name)) this.exportAsync.add(decl.name);
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
    const attrs: string[] = [];
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
    const t = this.peek();
    throw decoratorError(
      `decorator on a '${t.value || t.type}' declaration at ${t.line}:${t.col}`,
      "decorators attach to a `class` or a record `type`/`interface` (the `@@` form), or to a class METHOD (`@wrapper m() { … }`) — not to a function, variable or statement",
    );
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
      this.asyncFns.add(this.peek(1).value); // the declared name (after `function`)
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
        (this.asyncFnExprs.has(init) || (init.kind === "Identifier" && this.asyncFns.has(init.name)))) {
      this.asyncFns.add(name);
    }
    // `const run = (f: () => Promise<T>) => …` — bind the arrow's promise-typed parameters
    // to the name calls will actually use, so `run(one)` is a legal escape.
    if (init !== undefined && this.promiseParamsByArrow.has(init)) {
      this.promiseParamsByFn.set(name, this.promiseParamsByArrow.get(init)!);
    }
    return { name, annot, annotHead, init };
  }
  private parseVarDecl(): VarDecl {
    const declKind = this.next().value as "let" | "const";
    if (this.at("{")) return this.parseObjectDestructure(declKind);
    if (this.at("[")) return this.parseArrayDestructure(declKind);
    const decls: Declarator[] = [this.parseDeclarator()];
    while (this.at(",")) { this.eat(","); decls.push(this.parseDeclarator()); }
    return { kind: "VarDecl", declKind, decls };
  }

  // `const { name, age: alias } = expr` → __d = expr; name = __d.name; alias = __d.age
  private parseObjectDestructure(declKind: "let" | "const"): VarDecl {
    this.eat("{");
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
    const decls: Declarator[] = [{ name: tmp, init }];
    for (const p of props) decls.push({ name: p.binding, init: { kind: "MemberExpr", object: this.ident(tmp), property: p.key } });
    return { kind: "VarDecl", declKind, decls };
  }

  // `const [a, , ...rest] = expr` → __d = expr; a = __d[0]; rest = __d.slice(2)
  // Elision holes (a bare `,`) advance the positional index without binding.
  private parseArrayDestructure(declKind: "let" | "const"): VarDecl {
    this.eat("[");
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
    const decls: Declarator[] = [{ name: tmp, init }];
    elems.forEach((el, i) => {
      if (el.name === null) return; // elision hole — no binding
      const init: Expr = el.rest
        ? { kind: "CallExpr", callee: { kind: "MemberExpr", object: this.ident(tmp), property: "slice" }, args: [{ kind: "NumberLiteral", value: i }] }
        : { kind: "IndexExpr", object: this.ident(tmp), index: { kind: "NumberLiteral", value: i } };
      decls.push({ name: el.name, init });
    });
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
      if (!def) def = { kind: "UndefinedLiteral" };
    }
    return { name, annot, default: def, rest };
  }

  /** Parse a `( … )` parameter list (rest / optional / annotated / default params).
   *  When `ctor` is set, an access modifier (`private`/`public`/`protected`/`readonly`)
   *  prefixing a param makes it a *parameter property* (marked `paramProp`), which
   *  `parseClass` desugars into a field + a `this.x = x` constructor initialization. */
  private parseParamList(ctor = false): Param[] {
    this.eat("(");
    const params: Param[] = [];
    const promiseIdx = new Set<number>();
    const promiseNames = new Set<string>();
    if (!this.at(")")) {
      do {
        if (this.at(")")) break; // trailing comma in the param list
        // Parameter property: consume + record access modifiers. A modifier only counts
        // when another identifier (the param name) follows — `readonly` as a bare param
        // name (`f(readonly: number)`) is left alone (next token is `:`/`,`/`)`).
        let paramProp = false;
        if (ctor) {
          while (this.peek().type === "ident" && PARAM_ACCESS.has(this.peek().value) && this.peek(1).type === "ident") {
            paramProp = true; this.next();
          }
        }
        if (this.at("[") || this.at("{")) { params.push(this.parsePatternParam()); continue; } // `function f([a, b]: T[])`
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
          if (t.asyncFn) { promiseNames.add(pname); promiseIdx.add(params.length); }
        }
        let def: Expr | undefined;
        if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
        if (paramProp && rest) throw nyi(NYI.CLASS_FEATURE, "a rest parameter cannot be a parameter property");
        const p = this.mkParam(pname, annot, def, rest, optional);
        if (paramProp) p.paramProp = true;
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
    if (typeParams.length) this.typeParamScopes.push(new Set(typeParams));
    try {
      const params = this.parseParamList();
      if (this.lastPromiseParams.size) this.promiseParamsByFn.set(name, this.lastPromiseParams);
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
        if (retAsyncFn) this.returnsAsyncFn.add(name);
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
    const isMutable = !!dec?.attrs.includes("mutable");
    if (isMutable) this.mutableClasses.add(name);
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
    this.typeAliases.set(name, selfMarker);
    this.eat("{");
    const fields: { key: string; ty: Ty }[] = [];
    const fieldInits: { field: string; value: Expr }[] = []; // declared-and-initialized fields → ctor prelude
    const methods: { name: string; params: Param[]; returnAnnot?: Ty; body: Stmt[]; setter: boolean; wrappers: string[]; typeParams?: string[] }[] = [];
    const statics: { name: string; params: Param[]; returnAnnot?: Ty; body: Stmt[] }[] = []; // `static m(…)`
    const staticFields: Stmt[] = []; // `static f = init` → a module-level `const C.f`
    let ctorParams: Param[] | null = null;
    let ctorBody: Stmt[] = [];
    while (!this.at("}") && this.peek().type !== "eof") {
      if (this.at(";")) { this.eat(";"); continue; }
      // `@wrapper` on a MEMBER (docs/decorators.md). `@@` attributes are class-level only.
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
      if (memberTypeParams.length) this.typeParamScopes.push(new Set(memberTypeParams));
      try {
      if (member === "constructor" && this.at("(") && !isStatic) {
        // TS forbids type parameters on a constructor (only `class C<T>` carries them),
        // so this is a syntax error rather than a deferred feature.
        if (memberTypeParams.length) throw parseError(`Type parameters on a constructor at ${tok.line}:${tok.col} — put them on the class (\`class ${name}<T>\`)`);
        if (ctorParams) throw parseError(`Duplicate constructor at ${tok.line}:${tok.col}`);
        ctorParams = this.parseParamList(true); // ctor: access-modified params → parameter properties
        const patternPrelude = this.takeParamPrelude(); // binding patterns → `const` decls at the top
        for (const p of ctorParams) if (p.rest) throw nyi(NYI.CLASS_FEATURE, "rest parameter in a constructor");
        if (this.at(":")) { this.eat(":"); this.parseType(); } // ctor return annot (ignored)
        this.thisWritable = true; this.inErrorCtor = extendsError;
        ctorBody = [...patternPrelude, ...this.parseBlock()];
        this.thisWritable = false; this.inErrorCtor = false;
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
      if (ty === undefined) {
        if (init === undefined) throw nyi(NYI.CLASS_FEATURE, `class field '${member}' needs a type annotation`);
        ty = this.inferFieldTy(init, member);
      }
      if (optional) ty = makeNullable("undefined", ty);
      // A STATIC field is not a slot on the instance — it is module-level storage under a
      // class-qualified name (`C.f`), initialized where the class is DECLARED, which is
      // exactly a module-level `const C.f = init`. The dotted name cannot collide with any
      // user binding (no source identifier contains a `.`), so it needs no other marker:
      // a read of `C.f` finds it in scope and nothing else can.
      if (isStatic) {
        if (init === undefined) throw nyi(NYI.CLASS_FEATURE, `static field '${name}.${member}' has no initializer (it would read as \`undefined\`)`);
        staticFields.push({ kind: "VarDecl", declKind: "const", decls: [{ name: `${name}.${member}`, annot: ty, init }] });
        this.staticFieldNames.add(`${name}.${member}`);
        continue;
      }
      fields.push({ key: member, ty });
      // An optional field with no initializer still needs one: a class instance is a heap
      // block and every field is a real slot, so "absent" has to be WRITTEN as the
      // `undefined` arm of the nullable box. Without this the slot stays zero and a read
      // dereferences NULL. A constructor that assigns the field simply overwrites this.
      if (init === undefined && optional) init = { kind: "UndefinedLiteral" };
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
    const paramPropInits: Stmt[] = [];
    for (const p of ctorParams ?? []) {
      if (!p.paramProp) continue;
      fields.push({ key: p.name, ty: p.annot ?? "number" });
      // `paramProp: true` marks this as the DEFINITIONAL store — the reason a parameter
      // property is a CONSUMING parameter rather than a borrow (src/ownership.ts).
      paramPropInits.push({ kind: "ExprStmt", expr: { kind: "FieldAssign", object: this.ident("this"), field: p.name, value: this.ident(p.name), viaThis: true, paramProp: true } });
    }
    // Field initializers (`name = init`): `this.name = init`, in declaration order, prepended
    // after the parameter-property inits and before the explicit ctor body (TS field-init order).
    const fieldInitStmts: Stmt[] = fieldInits.map(fi => ({
      kind: "ExprStmt", expr: { kind: "FieldAssign", object: this.ident("this"), field: fi.field, value: fi.value, viaThis: true },
    }) as Stmt);
    const prelude = [...paramPropInits, ...fieldInitStmts];
    // A class with initializers but no explicit constructor gets a synthesized zero-arg ctor
    // that runs just the inits (paramProps imply an explicit ctor, so `prelude` is field-inits).
    if (ctorParams === null && prelude.length) ctorParams = [];
    if (prelude.length) ctorBody = [...prelude, ...ctorBody];

    // `extends Error` inherits a `message: string` field (slot 0); `super(msg)` sets it.
    if (extendsError) fields.unshift({ key: "message", ty: "string" });
    // A bare `class X extends Error {}` (no own fields, no ctor) gets a forwarding default
    // constructor `constructor(message: string) { this.message = message }`, so `new X("m")`
    // works and `x.message === "m"` — matching node's implicit `super(...arguments)`.
    if (extendsError && ctorParams === null && fields.length === 1) {
      ctorParams = [{ name: "message", annot: "string" }];
      ctorBody = [{ kind: "ExprStmt", expr: { kind: "FieldAssign", object: this.ident("this"), field: "message", value: this.ident("message"), viaThis: true } }];
    }

    // Reject-don't-miscompile: fields are only initialized by the constructor. Without an
    // explicit ctor, only initialized (and, for Error subclasses, `message`) fields are set;
    // any other field would be uninitialized garbage — refuse rather than emit it.
    if (!hadExplicitCtor) {
      const covered = new Set([...fieldInits.map(fi => fi.field), ...(extendsError ? ["message"] : [])]);
      for (const f of fields) if (!covered.has(f.key)) throw nyi(NYI.CLASS_FEATURE, `class '${name}' field '${f.key}' has no initializer and no constructor to initialize it`);
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
    for (const f of fields) {
      if (!f.ty.includes(selfMarker)) continue;
      selfRecursive = true;
      f.ty = f.ty.split(selfMarker).join(typeRefTy(name)) as Ty;
    }
    const objTy = `${name}${objectType(fields)}` as Ty; // class-tagged instance type
    if (selfRecursive && isMutable) throw recursiveMutableError(name, "class");
    if (selfRecursive) this.recTypes.set(name, objTy);
    this.typeAliases.set(name, objTy); // uses of `name` as a type resolve to the instance shape
    const thisParam: Param = { name: "this", annot: objTy };
    const emitted: FuncDecl[] = [];
    /** `const __dec_C_m = w(…)` statements — the ONE-TIME decorator applications. */
    const decorators: Stmt[] = [];
    // Constructor → `C.constructor(this, …ctorParams): void` (caller allocates `this`).
    const ctor = {
      kind: "FuncDecl", name: `${name}.constructor`,
      params: [thisParam, ...(ctorParams ?? [])], returnAnnot: "void", body: ctorBody,
    } as FuncDecl;
    // A CLASS `@wrapper` wraps the CONSTRUCTOR: the thing being decorated is
    // `(instance, …ctorArgs) => instance` — nativets allocates the instance, the
    // initializer fills it in and hands it back, and the wrapper may do anything
    // around that. (Our classes are not first-class values, so the constructor is
    // the closest expressible reading of Python's `C = wrap(C)`.)
    if (dec?.wrappers.length) {
      ctor.returnAnnot = selfMarker;
      ctor.body = [...ctor.body, { kind: "ReturnStmt", argument: this.ident("this") }];
      ctor.untrackThis = true; // `return this` hands the caller's own allocation back
      this.applyWrappers(ctor, dec.wrappers, emitted, decorators);
    } else {
      emitted.push(ctor);
    }
    // Each method → `C.method(this, …params)`.
    for (const m of methods) {
      const fn = {
        kind: "FuncDecl", name: `${name}.${m.name}`,
        params: [thisParam, ...m.params], returnAnnot: m.returnAnnot, body: m.body,
        // A GENERIC method is the same FuncDecl carrying `typeParams`, so the checker's
        // existing template registration (`declareGeneric`) picks it up with no special
        // case: `this` is simply its first parameter, and it is never generic.
        ...(m.typeParams ? { typeParams: m.typeParams } : {}),
      } as FuncDecl;
      if (m.setter) { fn.setter = true; this.lowerSetter(fn, name, isMutable, selfMarker); }
      if (m.wrappers.length) this.applyWrappers(fn, m.wrappers, emitted, decorators);
      else emitted.push(fn);
    }
    // Each STATIC method → the plain top-level `C.m(…params)`: no `this`, so it differs
    // from an instance method only in the missing receiver — which is exactly what the
    // `isStatic` flag tells the checker, so `C.m(a)` resolves to this function and
    // `inst.m(a)` does not.
    for (const m of statics) {
      emitted.push({
        kind: "FuncDecl", name: `${name}.${m.name}`,
        params: m.params, returnAnnot: m.returnAnnot, body: m.body, isStatic: true,
      } as FuncDecl);
    }
    // Substitute the self MARKER for the real instance type, everywhere it reached.
    const unself = (t: Ty): Ty => (t.includes(selfMarker) ? (t.split(selfMarker).join(objTy) as Ty) : t);
    mapTypesDeep(emitted, unself);
    mapTypesDeep(decorators, unself);
    this.hoistedFns.push(...emitted);
    // The decorator applications run WHERE THE CLASS WAS DECLARED (a module-level
    // `const`), so each wrapper is applied exactly ONCE — Python's `m = w(m)`, not a
    // per-call wrap. Function declarations hoist, so a decorator defined further down
    // the file is still in scope here.
    // Static-field initializers run WHERE THE CLASS WAS DECLARED — before the decorator
    // applications, which is TS's order (static fields are part of class definition).
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
  private applyWrappers(fn: FuncDecl, wrappers: string[], emitted: FuncDecl[], decorators: Stmt[]): void {
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
      body: { kind: "CallExpr", callee: this.ident(inner.name), args: names.map((n) => this.ident(n)) },
      exprBody: true,
    };
    // Bottom-up application: the decorator written CLOSEST to the method wraps first.
    let init: Expr = arrow;
    for (let i = wrappers.length - 1; i >= 0; i--) init = { kind: "CallExpr", callee: this.ident(wrappers[i]!), args: [init] };
    const cname = `__dec_${fn.name.replace(".", "_")}`;
    const fnTy = makeFuncTy(fn.params.map((p) => p.annot ?? "number"), fn.returnAnnot);
    decorators.push({ kind: "VarDecl", declKind: "const", decls: [{ name: cname, annot: fnTy, init }] });
    // The replacement method: forward everything to the (once-)decorated value.
    emitted.push({
      kind: "FuncDecl", name: fn.name, params: fn.params, returnAnnot: fn.returnAnnot,
      body: [{ kind: "ReturnStmt", argument: { kind: "CallExpr", callee: this.ident(cname), args: fn.params.map((p) => this.ident(p.name)) } }],
    } as FuncDecl);
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
  private lowerSetter(fn: FuncDecl, cls: string, isMutable: boolean, selfTy: Ty): void {
    const returns = valueReturns(fn.body);
    if (!isMutable) {
      fn.copyThis = true;
      const bad = returns.find((r) => !(r.kind === "Identifier" && r.name === "this"));
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
    const asyncArrow = this.asyncFnExprs.has(argument);
    if (asyncArrow || argument.kind === "Identifier") {
      const argName = argument.kind === "Identifier" ? argument.name : null;
      this.returnEscapes.push({
        argName, asyncArrow,
        scopedAsync: argName !== null && this.inAsyncParamScope(argName),
        declared: this.returnsAsyncFnStack[this.returnsAsyncFnStack.length - 1] === true,
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
    const cases: SwitchCase[] = [];
    while (!this.at("}")) {
      let test: Expr | null = null;
      if (this.at("case")) { this.eat("case"); test = this.parseExpression(); }
      else this.eat("default");
      this.eat(":");
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
      const stmts: Stmt[] = [{ kind: "VarDecl", declKind: "const", decls: [{ name: tmp, init: rhs }] }];
      pattern.elements.forEach((el, i) => {
        if (el.kind !== "Identifier") throw parseError("array assignment pattern must be identifiers");
        stmts.push({ kind: "ExprStmt", expr: { kind: "AssignExpr", op: "=", target: el.name, value: { kind: "IndexExpr", object: this.ident(tmp), index: { kind: "NumberLiteral", value: i } } } });
      });
      return { kind: "MultiStmt", stmts };
    }
    this.eat(";");
    return { kind: "ExprStmt", expr: pattern };
  }

  private parseBlock(): Stmt[] {
    this.eat("{");
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
    if (first.value === "..." || first.value === "[" || first.value === "{") return true;
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
    const params: Param[] = [];
    const arrowPromiseIdx = new Set<number>();
    const arrowPromiseNames = new Set<string>();
    if (this.at("(")) {
      this.eat("(");
      if (!this.at(")")) {
        do {
          if (this.at("[") || this.at("{")) { params.push(this.parsePatternParam()); continue; } // `([k, v]) => …`
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
            if (t.asyncFn) { arrowPromiseNames.add(name); arrowPromiseIdx.add(params.length); }
          }
          let def: Expr | undefined;
          if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
          params.push(this.mkParam(name, annot, def, rest, optional));
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
    const mk = (a: Expr): Expr => { if (promiseIdx.size) this.promiseParamsByArrow.set(a, promiseIdx); return a; };
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
      if (this.at("{")) return mk({ kind: "ArrowFunction", params, stmts: [...prelude, ...this.parseBlock()], exprBody: false, retAnnot });
      const body = this.parseAssign();
      // A pattern parameter needs statements to bind its names, so an expression body
      // becomes a block: `([a, b]) => a + b` ≡ `(__d0) => { const a = …, b = …; return a + b; }`.
      if (prelude.length) return mk({ kind: "ArrowFunction", params, stmts: [...prelude, { kind: "ReturnStmt", argument: body }], exprBody: false, retAnnot });
      return mk({ kind: "ArrowFunction", params, body, exprBody: true, retAnnot });
    } finally { this.returnsAsyncFnStack.pop(); this.asyncParamScopes.pop(); }
  }

  private parseAssign(): Expr {
    // Generic arrow `<T>(x: T): T => x` — a leading `<` can only start a generic arrow
    // in this subset (no JSX / old-style casts), so it is unambiguous: erase the type-param
    // list and parse the arrow that follows.
    // `async (x) => …` / `async x => …` — `async` is erased (see the async/await note).
    if (this.at("async") && (this.peek(1).value === "(" || this.peek(2).value === "=>")) {
      this.next();
      const arrow = this.parseArrow();
      // Remember WHICH node this is: erasure loses the `async`, but a `const` binding
      // this arrow is every bit as promise-returning as an `async function`, and the
      // floating-async guard is by NAME. parseDeclarator turns this back into a name.
      this.asyncFnExprs.add(arrow);
      return arrow;
    }
    if (this.at("<")) {
      // An arrow is a VALUE, so it has no single instantiation site to specialize (M3
      // monomorphizes DECLARATIONS). Its type params are still brought into scope so the
      // annotations become `#T` markers — the checker then prefers the CONTEXTUAL type
      // where there is one, and otherwise erases the marker to `number` (pre-M3 behavior).
      const tps = this.parseTypeParamList();
      if (tps.length) this.typeParamScopes.push(new Set(tps));
      let arrow: Expr;
      try { arrow = this.parseArrow(); } finally { if (tps.length) this.typeParamScopes.pop(); }
      if (tps.length && arrow.kind === "ArrowFunction") {
        // A marker is only meaningful on the arrow's OWN parameter annotations (where the
        // checker substitutes the contextual type). Everywhere else inside the arrow there
        // is nothing to resolve it against, so erase to `number` right here — a `#T` must
        // never reach the checker or codegen.
        // The RETURN annotation is one of those own positions too (`<T>(x: T): T => x`):
        // the checker resolves it against the contextual type exactly as it does a
        // parameter, so the marker must survive the blanket erasure here.
        const own = arrow.params.map((p) => p.annot);
        const ownRet = arrow.retAnnot;
        mapTypesDeep(arrow, eraseTypeParams);
        arrow.params.forEach((p, i) => { if (own[i] !== undefined) p.annot = own[i]; });
        if (ownRet !== undefined) arrow.retAnnot = ownRet;
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
        const op = this.next().value as any;
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
        const op = this.next().value;
        const value = this.parseAssign();
        if (op === "=") return { kind: "FieldAssign", object: left.object, field: left.property, value, viaThis };
        // Compound `o.f op= v` desugars to `o.f = o.f op v`, which re-evaluates the
        // RECEIVER — sound only for a side-effect-free path (`a`, `this`, `a.b.c`).
        if (!isSimplePath(left.object)) {
          throw mutationError(
            `compound assignment '${op}' to a field of a computed receiver`,
            "the receiver would be evaluated twice; bind it first — `const o = …; o.f = o.f + v`",
          );
        }
        const bin = op.slice(0, -1) as BinaryOp;
        return {
          kind: "FieldAssign", object: left.object, field: left.property, viaThis,
          value: { kind: "BinaryExpr", op: bin, left: { ...left }, right: value },
        };
      }
      if (left.kind !== "Identifier") throw parseError("Invalid assignment target");
      const op = this.next().value as any;
      return { kind: "AssignExpr", op, target: left.name, value: this.parseAssign() };
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
      const rhs = this.parseConditional();
      if (rhs.kind !== "CallExpr") {
        throw parseError(`Right side of '|>' must be a call (e.g. \`x |> f()\`) at ${op.line}:${op.col}`);
      }
      if (rhs.callee.kind !== "Identifier") {
        throw parseError(`'|>' target must be a named function or function-valued variable (member/method callees are unsupported) at ${op.line}:${op.col}`);
      }
      // Thread the piped value into argument slot 0; written args shift right.
      left = { ...rhs, args: [left, ...rhs.args] };
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
        test = { kind: "AsExpr", expr: test, ty: this.parseType() };
      }
      else { this.eat("satisfies"); test = { kind: "SatisfiesExpr", expr: test, ty: this.parseType() }; }
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
        left = { kind: "InExpr", key: left, object, loc: { line: t.line, col: t.col } };
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
      const operand = this.parseUnary();
      this.awaitedCalls.add(operand); // marks a `await f()` call as legitimately consumed
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
          `arrays are immutable: \`delete xs[i]\` would punch a hole in place at ${kw.line}:${kw.col}`,
          "node's array `delete` leaves a HOLE — `length` is unchanged and the slot reads `undefined` — which a dense array cannot represent. " +
          "Build a new array without the element: `xs.filter((_, i) => i !== 0)`, or `[...xs.slice(0, i), ...xs.slice(i + 1)]`",
        );
      }
      // NOTE (mutable records): `@@mutable` does NOT make `delete` legal. A record's
      // SHAPE is its type — fields are static slots resolved at compile time — so removing
      // a key would change the value's type mid-program, which is a different (and much
      // larger) feature than assigning a slot in place. Refused precisely instead.
      throw mutationError(
        `objects are immutable: \`delete o.k\` would remove a key in place at ${kw.line}:${kw.col}`,
        "a record's shape is its TYPE (fields are static slots), so a key cannot be removed at runtime even from a `@@mutable` record. " +
        "Declare the field optional (`k?: T`) and set it to `undefined`, or rebuild without the key",
      );
    }
    if (this.at("new")) {
      this.eat("new");
      const callee = this.expectIdent();
      const typeArgs = this.at("<") ? this.parseTypeArgs() : undefined; // new Map<K,V>() / new Set<T>()
      this.eat("(");
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
    let tys: Ty[];
    try {
      tys = this.parseTypeArgs();
    } catch {
      this.pos = save;
      return null;
    }
    if (this.at("(")) return tys;
    this.pos = save;
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
        expr = pendingTypeArgs
          ? { kind: "CallExpr", callee: expr, args, typeArgs: pendingTypeArgs, loc: callLoc }
          : { kind: "CallExpr", callee: expr, args, loc: callLoc };
        pendingTypeArgs = null;
        // Record plain `f(...)` calls so an un-awaited call to an `async function`
        // can be rejected after the whole program is parsed (see checkFloatingAsyncCalls).
        if (expr.callee.kind === "Identifier") {
          const loc = expr.callee.loc ?? { line: 0, col: 0 };
          const scopedAsync = this.inAsyncParamScope(expr.callee.name);
          this.identCalls.push({ node: expr, name: expr.callee.name, line: loc.line, col: loc.col, scopedAsync });
        } else if (this.asyncFnExprs.has(expr.callee)) {
          // An immediately-invoked async arrow, `(async () => …)()`. It never binds a
          // name, so the name-based path above cannot see it; the callee NODE is the
          // identity. Recorded under a descriptive name so the guard reads the same.
          this.identCalls.push({ node: expr, name: "(async arrow)", line: callLoc.line, col: callLoc.col });
          this.asyncFns.add("(async arrow)"); // not a legal identifier, so it collides with nothing
        } else if (expr.callee.kind === "CallExpr" && expr.callee.callee.kind === "Identifier" &&
                   this.returnsAsyncFn.has(expr.callee.callee.name)) {
          // `pick()()`, where `pick(): () => Promise<T>` — the callee is the RESULT of a
          // call, so there is no name; the declared return type is the identity.
          const label = `${expr.callee.callee.name}()`;
          this.identCalls.push({ node: expr, name: label, line: callLoc.line, col: callLoc.col });
          this.asyncFns.add(label); // `pick()` is not an identifier, so it collides with nothing
        }
        // Record every argument that could hand an ASYNC function VALUE across this call —
        // the one place the guard's name tracking ends. Resolved after the file is parsed
        // (see checkAsyncEscapes): both the callee and an `async function` argument hoist.
        const calleeName = expr.callee.kind === "Identifier" ? expr.callee.name : null;
        args.forEach((a, i) => {
          const asyncArrow = this.asyncFnExprs.has(a);
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
      } else if ((this.at("++") || this.at("--")) && expr.kind === "Identifier") {
        const op = this.next().value as "++" | "--";
        expr = { kind: "UpdateExpr", op, prefix: false, target: expr.name };
      } else if ((this.at("++") || this.at("--")) && (expr.kind === "MemberExpr" || expr.kind === "IndexExpr")) {
        const op = this.next().value as "++" | "--";
        expr = { kind: "UpdateExpr", op, prefix: false, target: "", targetExpr: this.updateTarget(expr) };
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
        const args: Expr[] = [];
        if (!this.at(")")) { do { if (this.at(")")) break; args.push(this.parseAssign()); } while (this.at(",") && (this.eat(","), true)); }
        this.eat(")");
        if (args.length !== 1) throw nyi(NYI.CLASS_FEATURE, `super(...) with ${args.length} arguments (an Error subclass takes a single message)`);
        return { kind: "FieldAssign", object: this.ident("this"), field: "message", value: args[0]!, viaThis: true };
      }
      this.next();
      // SH4: `import { readFileSync as rfs }` renames a HOST BUILTIN, which has no
      // declaration to alpha-rename — so the alias is resolved here, at the use site.
      const name = this.hostAliases.get(t.value) ?? t.value;
      return { kind: "Identifier", name, loc: { line: t.line, col: t.col } };
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
    this.eat("[");
    const elements: Expr[] = [];
    if (!this.at("]")) {
      do {
        if (this.at("]")) break; // trailing comma
        if (this.at("...")) { this.eat("..."); elements.push({ kind: "SpreadExpr", argument: this.parseAssign() }); }
        else elements.push(this.parseAssign());
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat("]");
    return { kind: "ArrayLiteral", elements };
  }

  private parseObjectLiteral(): Expr {
    this.eat("{");
    const properties: ObjectProperty[] = [];
    if (!this.at("}")) {
      do {
        if (this.at("}")) break;
        if (this.at("...")) { this.eat("..."); properties.push({ key: "", value: this.parseAssign(), spread: true }); continue; }
        const key = this.expectKey();
        if (this.at(":")) { this.eat(":"); properties.push({ key, value: this.parseAssign() }); }
        else properties.push({ key, value: { kind: "Identifier", name: key } }); // shorthand
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat("}");
    return { kind: "ObjectLiteral", properties };
  }

  private buildTemplate(raw: string, tok: Token): Expr {
    const quasis: string[] = [];
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
        // Find the substitution's matching `}`. Braces inside a nested template's TEXT
        // or inside a quoted string are not delimiters, so skip both wholesale — the
        // lexer captured them verbatim and `parseExpressionFrom` re-lexes them below.
        let depth = 1;
        let src = "";
        while (i < raw.length && depth > 0) {
          const ch = raw[i]!;
          if (ch === "\\") { src += ch + (raw[i + 1] ?? ""); i += 2; continue; }
          if (ch === "`" || ch === '"' || ch === "'") { const [txt, next] = skipQuoted(raw, i); src += txt; i = next; continue; }
          if (ch === "{") depth++;
          else if (ch === "}") { depth--; if (depth === 0) break; }
          src += ch; i++;
        }
        i++;
        exprs.push(parseExpressionFrom(src));
        continue;
      }
      cur += raw[i]; i++;
    }
    quasis.push(cur);
    return { kind: "TemplateLiteral", quasis, exprs };
  }
}

/**
 * Copy a quoted run (a `'`/`"` string or a nested `` ` `` template) starting at `i`
 * verbatim, returning `[text, indexAfterIt]`. A nested template's own `${…}`
 * substitutions are skipped recursively, so `` `${a ? `}` : b}` `` stays intact.
 */
function skipQuoted(raw: string, i: number): [string, number] {
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
        if (c2 === "`" || c2 === '"' || c2 === "'") { const [t, n] = skipQuoted(raw, i); out += t; i = n; continue; }
        if (c2 === "{") depth++;
        else if (c2 === "}") depth--;
        out += c2; i++;
      }
      continue;
    }
    out += ch; i++;
  }
  return [out + q, i + 1];
}

/** Every `return <expr>` in a statement list, recursively. Expressions are not walked,
 *  so a nested arrow's own returns (a different function) are correctly ignored. */
function valueReturns(list: Stmt[]): Expr[] {
  const out: Expr[] = [];
  const walk = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      switch (s.kind) {
        case "ReturnStmt": if (s.argument) out.push(s.argument); break;
        case "IfStmt": walk(s.consequent); if (s.alternate) walk(s.alternate); break;
        case "WhileStmt": case "DoWhileStmt": case "ForStmt": case "ForOfStmt": case "ForInStmt":
        case "BlockStmt": walk(s.body); break;
        case "SwitchStmt": for (const c of s.cases) walk(c.body); break;
        case "TryStmt": walk(s.block); if (s.handler) walk(s.handler); if (s.finalizer) walk(s.finalizer); break;
        case "MultiStmt": walk(s.stmts); break;
        default: break;
      }
    }
  };
  walk(list);
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
  return checkNoNul(tokens);
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
function checkNoNul(tokens: Token[]): Token[] {
  const nul = String.fromCharCode(0);
  for (const t of tokens) {
    if (t.type === "str" && t.value.indexOf(nul) >= 0) throw nulLiteral("this string literal", t.line, t.col);
    if (t.type === "template" && t.value.indexOf(nul) >= 0) throw nulLiteral("this template literal", t.line, t.col);
  }
  return tokens;
}

export function parse(source: string, opts: ParseOpts = {}): Program {
  return new Parser(tokenize(source), opts).parseProgram();
}

export function parseExpressionFrom(source: string): Expr {
  return new Parser(tokenize(source)).parseExpression();
}
