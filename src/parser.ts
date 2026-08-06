/*
 * Recursive-descent parser with precedence climbing.
 *
 * It accepts a broad surface — including features the checker/codegen do not yet
 * implement (arrays, objects, spread, destructuring, try/catch, optional chain).
 * Parsing them (rather than erroring at the token level) lets the checker reject
 * them with a precise NT-coded diagnostic that `coverage` can report.
 */

import { lex, type Token } from "./lexer.ts";
import { parseError, nyi, NYI, mutationError, decoratorError } from "./diagnostics.ts";
import { makeNullable, makeMapTy, makeSetTy, makeFuncTy, objectType, typeParamTy, eraseTypeParams, mapTypesDeep, isObjectTy, classTag } from "./ast.ts";
import type {
  Program, Stmt, Expr, Param, VarDecl, Declarator, Ty, BinaryOp, SwitchCase, ObjectProperty, FuncDecl,
  ImportDecl, ExportTable,
} from "./ast.ts";

/** Options for parsing ONE module of a program (see src/modules.ts). */
export interface ParseOpts {
  /** Type-level names imported from already-parsed dependencies (`import type`,
   *  and the instance shape of an imported `class`). Seeds the alias table so an
   *  annotation naming an imported type resolves to its real shape. */
  typeEnv?: Map<string, Ty>;
  /** This module's path, as it should appear in a runtime panic's `at <file>:<line>:<col>`. */
  file?: string;
  /** OUT-param: receives every type alias this parse declared. `coverage` parses a file
   *  one statement at a time, so without this a `type`/`interface` declared in one
   *  statement would be invisible to the next — most visibly a `@@mutable type`, whose
   *  tag is what makes a later `r.f = v` legal. Unused by the normal pipeline. */
  collectTypes?: Map<string, Ty>;
}

export class ParseError extends Error {}

interface Op { prec: number; right?: boolean; logical?: boolean; }
const BIN: Record<string, Op> = {
  "**": { prec: 14, right: true },
  "*": { prec: 13 }, "/": { prec: 13 }, "%": { prec: 13 },
  "+": { prec: 12 }, "-": { prec: 12 },
  "<<": { prec: 11 }, ">>": { prec: 11 }, ">>>": { prec: 11 },
  "<": { prec: 10 }, "<=": { prec: 10 }, ">": { prec: 10 }, ">=": { prec: 10 },
  "===": { prec: 9 }, "!==": { prec: 9 }, "==": { prec: 9 }, "!=": { prec: 9 },
  "&": { prec: 8 }, "^": { prec: 7 }, "|": { prec: 6 },
  "&&": { prec: 5, logical: true }, "||": { prec: 4, logical: true },
  "??": { prec: 3, logical: true },
};
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="]);
// Access modifiers erased on class members and, on ctor params, promoted to parameter properties.
const PARAM_ACCESS = new Set(["private", "public", "protected", "readonly"]);
// Class-member modifiers/accessors that change semantics — still deferred (NT1015).
const REJECTED_MEMBER_MODS = new Set(["static", "abstract", "declare", "override", "get", "set", "async"]);
const SCALARS = new Set(["number", "boolean", "string", "void", "undefined", "null"]);
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
   * entire trace. Unknown named types still fall back to `number`, as before.
   */
  private typeAliases = new Map<string, Ty>();
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
  private awaitedCalls = new Set<Expr>();        // call nodes that are the operand of an `await`
  private identCalls: { node: Expr; name: string; line: number; col: number }[] = [];
  /** True while parsing the ctor body of a class that `extends Error` — enables `super(msg)`
   *  (desugared to `this.message = msg`, since nativets models Error as `{message:string}`). */
  private inErrorCtor = false;
  /** Decorators parsed immediately before a declaration, consumed by `parseClass`. */
  private pendingDecorators: { attrs: string[]; wrappers: string[] } | null = null;
  /** Classes carrying `@@mutable` — TRUE in-place mutation (see docs/decorators.md).
   *  Published on the Program so the ownership pass and the checker can see it. */
  private readonly mutableClasses = new Set<string>();
  /** RECORD type names carrying `@@mutable` (`@@mutable type Cell = { n: number }`) —
   *  an extension of the class attribute to a `type`/`interface` declaration. The record
   *  is tagged with this name (`Cell{n:number}`), so mutability is NOMINAL rather than
   *  structural; published on the Program for the checker + ownership pass. */
  private readonly mutableRecords = new Set<string>();
  /** Module surface (SH1): `import` declarations and the export table. Empty for an
   *  ordinary single-file program, in which case `parseProgram` leaves them off the
   *  Program entirely — so every existing single-module path is untouched. */
  private imports: ImportDecl[] = [];
  private exportValues = new Map<string, string>();
  private exportReexports = new Map<string, { source: string; imported: string; line: number }>();
  private exportTypes = new Set<string>();
  private file?: string;
  private collectTypes?: Map<string, Ty>;
  constructor(private toks: Token[], opts: ParseOpts = {}) {
    if (opts.typeEnv) for (const [k, v] of opts.typeEnv) this.typeAliases.set(k, v);
    this.file = opts.file;
    this.collectTypes = opts.collectTypes;
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
    const alias = this.typeAliases.get(id);
    if (alias) return alias;
    if (id === "Uint8Array" || id === "TextEncoder" || id === "TextDecoder") return id as Ty; // stdlib batch-2 bytes types
    if (id === "Response" || id === "Headers") return id as Ty; // networking tier: fetch's Response/Headers
    if (id === "Date" || id === "URL" || id === "URLSearchParams") return id as Ty; // stdlib batch-3 web APIs
    return (id === "Error" ? "{message:string}" : SCALARS.has(id) ? id : "number") as Ty;
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
    const body: Stmt[] = [];
    while (this.peek().type !== "eof") body.push(this.parseStatement());
    this.checkFloatingAsyncCalls(body);
    // Class members lower to top-level functions (`C.constructor`, `C.method`) so they
    // register + hoist alongside ordinary functions for the checker/codegen.
    body.push(...this.hoistedFns);
    const program: Program = { kind: "Program", body };
    // `@@mutable` classes (decorators lane). Attached only when the source used the
    // attribute, so an ordinary program's Program is byte-identical to what it was.
    if (this.mutableClasses.size) program.mutableClasses = [...this.mutableClasses];
    if (this.mutableRecords.size) program.mutableRecords = [...this.mutableRecords];
    if (this.collectTypes) for (const [k, v] of this.typeAliases) this.collectTypes.set(k, v);
    // Only attach the module surface when the source actually used it, so a
    // single-file program's Program is byte-identical to what it always was.
    if (this.imports.length) program.imports = this.imports;
    if (this.exportValues.size || this.exportReexports.size || this.exportTypes.size) {
      const types = new Map<string, Ty>();
      for (const n of this.exportTypes) { const t = this.typeAliases.get(n); if (t) types.set(n, t); }
      program.exports = { values: this.exportValues, reexports: this.exportReexports, types } satisfies ExportTable;
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
      if (!this.asyncFns.has(c.name) || this.awaitedCalls.has(c.node) || c.node === entrypoint) continue;
      throw nyi(
        NYI.ASYNC,
        `calling async function '${c.name}' without 'await' at ${c.line}:${c.col} (its value is a Promise under node; nativets runs it to completion immediately)`,
      );
    }
  }

  // ---- types (permissive; we only need scalars precisely) ----
  // A type is a union of atoms. The supported unions are the two restricted
  // NULLABLE shapes `T | undefined` / `T | null` (either arm order) and a union of
  // literal atoms that COLLAPSE to one base (`"a" | "b" | "c"` → string) — the arms
  // dedupe to a single type. A general/heterogeneous >2-arm union is rejected with
  // an NYI code (never miscompiled) — see the checker's §5 note and the Excluded table.
  private parseType(): Ty {
    if (this.at("|")) this.next(); // leading union bar: `type X = | A | B`
    const arms: Ty[] = [this.parseTypeAtom()];
    let sawIntersect = false;
    while (this.at("|") || this.at("&")) { if (this.at("&")) sawIntersect = true; this.next(); arms.push(this.parseTypeAtom()); }
    if (arms.length === 1) return arms[0]!;
    const uniq = [...new Set(arms)];
    if (uniq.length === 1) return uniq[0]!; // collapsed literal union (all arms identical)
    if (!sawIntersect && uniq.length === 2) {
      const [a, b] = uniq as [Ty, Ty];
      if (a === "undefined" || a === "null") return makeNullable(a, b);
      if (b === "undefined" || b === "null") return makeNullable(b, a);
    }
    throw nyi(NYI.OPTIONAL_CHAIN, `general union type '${arms.join(sawIntersect ? " & " : " | ")}' (only 'T | undefined' / 'T | null' are supported)`);
  }
  // A single type atom: literal / function / object / tuple / import-type /
  // scalar-or-named, plus `[]` suffixes.
  private parseTypeAtom(): Ty {
    let base: Ty;
    const t = this.peek();
    if (t.type === "str") { this.next(); base = "string"; }        // string-literal type: "a"
    else if (t.type === "num") { this.next(); base = "number"; }   // numeric-literal type: 0
    else if (this.at("(")) base = this.parseParenOrFuncType();
    else if (this.at("{")) base = this.parseObjectType();
    else if (this.at("[")) base = this.parseTupleType();
    else if (this.at("import")) base = this.parseImportType();    // inline import type: import("m").T
    else {
      const id = this.expectIdent();
      if (id === "true" || id === "false") base = "boolean";       // boolean-literal type
      else if (this.at("<")) base = this.parseGenericType(id);      // `Name<...>` — erase the args
      else base = this.resolveNamed(id);
    }
    let suffix = "";
    while (this.at("[")) { this.eat("["); this.eat("]"); suffix += "[]"; } // T[], T[][]
    return (base + suffix) as Ty;
  }
  // Inline import type `import("./mod").Name` (optionally qualified) — erased to the
  // referenced named type (an alias if known, else `number`). The module path is dropped.
  private parseImportType(): Ty {
    this.eat("import"); this.eat("(");
    this.next(); // module path string literal
    this.eat(")"); this.eat(".");
    let name = this.expectIdent();
    while (this.at(".")) { this.eat("."); name = this.expectIdent(); } // import("m").Ns.Type
    return this.resolveNamed(name);
  }
  // A generic type reference `Name<T, U>` in type position. Generics carry no runtime
  // in this subset, so the arg list is parsed for grammar and then ERASED to a concrete
  // supported shape (never miscompiled): container/wrapper/utility types map to their
  // erasure; a type parameter or unknown generic falls back through `resolveNamed`.
  private parseGenericType(id: string): Ty {
    const a = this.parseTypeArgs();
    switch (id) {
      case "Map": return makeMapTy(a[0] ?? "string", a[1] ?? "number");
      case "Record": return makeMapTy(a[0] ?? "string", a[1] ?? "number"); // dictionary → Map
      case "Set": return makeSetTy(a[0] ?? "string");
      case "Array":
      case "ReadonlyArray": return `${a[0] ?? "number"}[]` as Ty;          // Array<T> → T[]
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
    return `${tys[0] ?? "number"}[]` as Ty;
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
    return `(${params.join(",")})=>${this.parseType()}` as Ty;
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
        let ft = this.parseType();
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
  private skipGenerics(): void { this.parseTypeParamList(); }

  // `type X = <type>;` — record the alias, erase the declaration. RHS uses the normal
  // type grammar (so `type Dir = "n" | "s"` collapses to string; a general union throws NYI).
  private parseTypeAlias(): Stmt {
    const dec = this.pendingDecorators;
    this.pendingDecorators = null;
    this.eat("type");
    const name = this.expectIdent();
    if (this.at("<")) this.skipGenerics(); // erased type params
    this.eat("=");
    const rhs = this.parseType();
    if (this.at(";")) this.eat(";");
    this.typeAliases.set(name, this.applyRecordAttrs(dec, name, rhs, "type"));
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
    if (this.at("extends")) { this.eat("extends"); this.parseType(); while (this.at(",")) { this.eat(","); this.parseType(); } }
    const shape = this.parseObjectType();
    this.typeAliases.set(name, this.applyRecordAttrs(dec, name, shape, "interface"));
    return { kind: "MultiStmt", stmts: [] }; // erased (no runtime)
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
    if (!this.at("{")) throw nyi(NYI.MODULE, `default import 'import ${this.peek().value} from …' at ${kw.line}:${kw.col}`);
    const clause = this.parseNamedClause();
    if (this.at(",")) throw nyi(NYI.MODULE, `a combined default + named import at ${kw.line}:${kw.col}`);
    this.eat("from");
    const source = this.parseSpecifier("from");
    if (this.at(";")) this.eat(";");
    this.imports.push({
      source,
      specs: clause.map((c) => ({ imported: c.name, local: c.alias, typeOnly: typeOnly || c.typeOnly })),
      line: kw.line,
    });
    return { kind: "MultiStmt", stmts: [] };
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
    if (this.at("function")) { const s = this.parseFuncDecl() as FuncDecl; this.exportValues.set(s.name, s.name); return s; }
    if (this.at("let") || this.at("const")) {
      const d = this.parseVarDecl();
      this.eat(";");
      for (const decl of d.decls) this.exportValues.set(decl.name, decl.name);
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
    if (this.at("throw")) { this.eat("throw"); const a = this.parseExpression(); this.eat(";"); return { kind: "ThrowStmt", argument: a }; }
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
    if (this.at(":")) { this.eat(":"); annot = this.parseType(); }
    let init: Expr;
    if (this.at("=")) { this.eat("="); init = this.parseAssign(); }
    else init = { kind: "UndefinedLiteral" };
    return { name, annot, init };
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
        if (this.at(":")) { this.eat(":"); annot = this.parseType(); }
        let def: Expr | undefined;
        if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
        if (paramProp && rest) throw nyi(NYI.CLASS_FEATURE, "a rest parameter cannot be a parameter property");
        const p = this.mkParam(pname, annot, def, rest, optional);
        if (paramProp) p.paramProp = true;
        params.push(p);
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat(")");
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
      const prelude = this.takeParamPrelude(); // binding patterns → `const` decls at the top
      let returnAnnot: Ty | undefined;
      if (this.at(":")) { this.eat(":"); returnAnnot = this.parseType(); }
      const body = [...prelude, ...this.parseBlock()];
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
    this.eat("class");
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
    const methods: { name: string; params: Param[]; returnAnnot?: Ty; body: Stmt[]; setter: boolean; wrappers: string[] }[] = [];
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
      const tok = this.peek();
      // Modifiers/accessors that change semantics (static/get/set/…) stay deferred (NT1015).
      const nextV = this.peek(1).value, nextIsMemberStart = nextV === "(" || nextV === ":" || nextV === "?" || nextV === "=";
      if (tok.type === "ident" && REJECTED_MEMBER_MODS.has(tok.value) && !nextIsMemberStart) throw nyi(NYI.CLASS_FEATURE, `class member modifier/accessor '${tok.value}' at ${tok.line}:${tok.col}`);
      if (this.at("[")) throw nyi(NYI.CLASS_FEATURE, `computed/index class member at ${tok.line}:${tok.col}`);
      const member = this.expectIdent();
      if (memberWrappers.length && !(this.peek().value === "(" && member !== "constructor")) {
        throw decoratorError(
          `decorator on class member '${member}' at ${tok.line}:${tok.col}`,
          "a `@wrapper` attaches to a METHOD. Decorate the whole class (`@wrapper class C { … }`) to wrap its constructor; fields cannot be decorated",
        );
      }
      if (member === "constructor" && this.at("(")) {
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
        // A METHOD may assign `this.f` too. Whether it does is the whole distinction
        // between a plain method and a SETTER (docs/decorators.md), so record it.
        this.thisWritable = true; this.thisAssigned = false;
        const body = [...prelude, ...this.parseBlock()];
        const setter = this.thisAssigned;
        this.thisWritable = false; this.thisAssigned = false;
        methods.push({ name: member, params, returnAnnot, body, setter, wrappers: memberWrappers });
        continue;
      }
      // field declaration: `name: Type;` / `name = init;` / `name: Type = init;` (optional `?`).
      // A field type comes from its annotation if present, else is inferred from the initializer
      // (`inferFieldTy`). An initializer is desugared into `this.name = init` prepended to the
      // constructor (after parameter-property inits) — mirroring the TS class-field semantics.
      if (this.at("?")) this.eat("?");
      let ty: Ty | undefined;
      if (this.at(":")) { this.eat(":"); ty = this.parseType(); }
      let init: Expr | undefined;
      if (this.at("=")) { this.eat("="); init = this.parseAssign(); }
      if (this.at(";")) this.eat(";");
      if (ty === undefined) {
        if (init === undefined) throw nyi(NYI.CLASS_FEATURE, `class field '${member}' needs a type annotation`);
        ty = this.inferFieldTy(init, member);
      }
      fields.push({ key: member, ty });
      if (init !== undefined) fieldInits.push({ field: member, value: init });
    }
    this.eat("}");
    const hadExplicitCtor = ctorParams !== null; // captured before any ctor synthesis below

    // Parameter properties (`constructor(private x: T)`): declare a field `x` and initialize
    // it (`this.x = x`) at the top of the ctor body — the TS desugaring.
    const paramPropInits: Stmt[] = [];
    for (const p of ctorParams ?? []) {
      if (!p.paramProp) continue;
      fields.push({ key: p.name, ty: p.annot ?? "number" });
      paramPropInits.push({ kind: "ExprStmt", expr: { kind: "FieldAssign", object: this.ident("this"), field: p.name, value: this.ident(p.name), viaThis: true } });
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

    // A FIELD naming its own class is a self-referential instance shape, which our
    // structural object types cannot express — it keeps the pre-existing erasure to
    // `number` rather than becoming a new rejection (the self marker exists for method
    // SIGNATURES, which is where a setter needs it).
    for (const f of fields) if (f.ty.includes(selfMarker)) f.ty = f.ty.split(selfMarker).join("number") as Ty;
    const objTy = `${name}${objectType(fields)}` as Ty; // class-tagged instance type
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
      } as FuncDecl;
      if (m.setter) { fn.setter = true; this.lowerSetter(fn, name, isMutable, selfMarker); }
      if (m.wrappers.length) this.applyWrappers(fn, m.wrappers, emitted, decorators);
      else emitted.push(fn);
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
    return { kind: "MultiStmt", stmts: decorators };
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
    this.eat("return");
    if (this.at(";")) { this.eat(";"); return { kind: "ReturnStmt", argument: null }; }
    const argument = this.parseExpression();
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
      let init: Expr;
      if (this.at("=")) { this.eat("="); init = this.parseAssign(); } else init = { kind: "UndefinedLiteral" };
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
          if (this.at(":")) { this.eat(":"); annot = this.parseType(); }
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
    if (this.at(":")) { this.eat(":"); this.parseType(); }
    this.eat("=>");
    if (this.at("{")) return { kind: "ArrowFunction", params, body: [...prelude, ...this.parseBlock()], exprBody: false };
    const body = this.parseAssign();
    // A pattern parameter needs statements to bind its names, so an expression body
    // becomes a block: `([a, b]) => a + b` ≡ `(__d0) => { const a = …, b = …; return a + b; }`.
    if (prelude.length) return { kind: "ArrowFunction", params, body: [...prelude, { kind: "ReturnStmt", argument: body }], exprBody: false };
    return { kind: "ArrowFunction", params, body, exprBody: true };
  }

  private parseAssign(): Expr {
    // Generic arrow `<T>(x: T): T => x` — a leading `<` can only start a generic arrow
    // in this subset (no JSX / old-style casts), so it is unambiguous: erase the type-param
    // list and parse the arrow that follows.
    // `async (x) => …` / `async x => …` — `async` is erased (see the async/await note).
    if (this.at("async") && (this.peek(1).value === "(" || this.peek(2).value === "=>")) { this.next(); return this.parseArrow(); }
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
        const own = arrow.params.map((p) => p.annot);
        mapTypesDeep(arrow, eraseTypeParams);
        arrow.params.forEach((p, i) => { if (own[i] !== undefined) p.annot = own[i]; });
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
        const op = this.next().value as any;
        return { kind: "IndexAssign", op, object: left.object, index: left.index, value: this.parseAssign(), loc: left.loc };
      }
      if (left.kind === "MemberExpr") {
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
    while (this.at("as")) { this.eat("as"); test = { kind: "AsExpr", expr: test, ty: this.parseType() }; }
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
      if (t.type === "ident" && t.value === "instanceof" && BIN["<"]!.prec >= minPrec) {
        this.next();
        const cls = this.peek();
        if (cls.type !== "ident") throw nyi(NYI.INSTANCEOF, `'instanceof' with a computed right operand at ${cls.line}:${cls.col}`);
        this.next();
        left = { kind: "InstanceOfExpr", object: left, className: cls.value };
        continue;
      }
      if (t.type !== "punct") break;
      const info = BIN[t.value];
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
      this.eat("delete");
      this.parseUnary();
      // NOTE (mutable records): `@@mutable` does NOT make `delete` legal. A record's
      // SHAPE is its type — fields are static slots resolved at compile time — so removing
      // a key would change the value's type mid-program, which is a different (and much
      // larger) feature than assigning a slot in place. Refused precisely instead.
      throw mutationError(
        "objects are immutable: `delete o.k` would remove a key in place",
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
        this.eat(".");
        expr = { kind: "MemberExpr", object: expr, property: this.expectIdent() };
      } else if (this.at("?.")) {
        const t = this.eat("?.");
        // Optional call `?.()` and optional index `?.[]` are out of the A2 subset.
        if (this.at("(")) throw nyi(NYI.OPTIONAL_CHAIN, `optional call '?.()' at ${t.line}:${t.col}`);
        if (this.at("[")) throw nyi(NYI.OPTIONAL_CHAIN, `optional element access '?.[]' at ${t.line}:${t.col}`);
        expr = { kind: "MemberExpr", object: expr, property: this.expectIdent(), optional: true };
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
          this.identCalls.push({ node: expr, name: expr.callee.name, line: loc.line, col: loc.col });
        }
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
    if (t.type === "template") { this.next(); return this.buildTemplate(t.value); }
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
      return { kind: "Identifier", name: t.value, loc: { line: t.line, col: t.col } };
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

  private buildTemplate(raw: string): Expr {
    const quasis: string[] = [];
    const exprs: Expr[] = [];
    let cur = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "\\") { cur += decodeEscape(raw[i + 1]!); i += 2; continue; }
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

function decodeEscape(ch: string): string {
  const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "`": "`", "$": "$" };
  return map[ch] ?? ch;
}

export function parse(source: string, opts: ParseOpts = {}): Program {
  return new Parser(lex(source), opts).parseProgram();
}

export function parseExpressionFrom(source: string): Expr {
  return new Parser(lex(source)).parseExpression();
}
