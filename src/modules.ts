/*
 * Module linker (self-hosting SH1) — `import` / `export` across `.ts` files.
 *
 * nativets does a WHOLE-PROGRAM compile, not separate compilation: from the entry
 * file we resolve the import graph, load each module exactly once, and merge every
 * module's AST into ONE Program. The checker, ownership pass and codegen therefore
 * never see a module — they see the same single Program they always have, and the
 * emitted IR is still a single triple-free `.ll`.
 *
 *   entry.ts ──import──▶ lib/util.ts ──import──▶ shared.ts
 *                    └──import──▶ other.ts ─────────┘   (diamond: shared runs ONCE)
 *
 * Ordering: modules are emitted in dependency (post-order DFS) order, so a module's
 * top-level statements run after every module it imports and before the entry's —
 * matching ESM evaluation order for an acyclic graph.
 *
 * Names: each non-entry module's top-level bindings are renamed with a per-module
 * prefix (`_m3_helper`), so two files may declare the same symbol without colliding.
 * The rename is applied UNIFORMLY to every occurrence of the name inside that module
 * (including inner scopes that shadow it) — a consistent alpha-rename, which preserves
 * semantics. An import binding is renamed to the *final* name of the exporting
 * module's binding, which is what wires the graph together.
 *
 * Cycles, unresolvable files, and missing exports are refused with an NT17xx
 * diagnostic (see diagnostics.ts) — never a hang, never a miscompile.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

import { parse } from "./parser.ts";
import { moduleError, mutationError } from "./diagnostics.ts";
import { resolveStaticFieldReads } from "./ast.ts";
import type {
  Program, Stmt, Expr, Ty, Declarator, Param, ArrowFunction, VarDecl, FuncDecl, ImportDecl,
  RecTypeEntry,
} from "./ast.ts";

/** How the linker reads a module. Injectable so tests can link in-memory graphs. */
export type ReadModule = (path: string) => string;

const defaultRead: ReadModule = (p) => readFileSync(p, "utf8");

interface ModuleInfo {
  path: string;
  source: string;
  program: Program;
  /** exported name → the FINAL (post-rename) name of the binding that backs it */
  finalExports: Map<string, string>;
  /** exported type name → its shape, with class tags already renamed */
  finalTypes: Map<string, Ty>;
  /** exported names that are `async` (following re-exports) — an importer needs these
   *  to refuse a call without `await`, since erasure hides it (NT1020) */
  asyncExports: Set<string>;
}

/* ---------------------------------------------------------------- renaming */

/*
 * Character classes, spelled out — the same discipline as `src/lexer.ts`. nativets has no
 * `RegExp` (docs/divergences.md), so the compiler's own source may not use one.
 */
/** `[A-Za-z_$]`. */
function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
}
/** `[A-Za-z0-9_$]` (= `[\w$]`). */
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9");
}

/**
 * `s.replace(/([A-Za-z_$][\w$]*)\{/g, …)` — rewrite every class tag in a type encoding.
 *
 * A maximal identifier run is what the regex matches: `[\w$]*` is greedy, and backtracking
 * can never help, because giving a word character back only exposes another word character
 * where `\{` must be. So the question at each identifier is simply "is the character right
 * after the run a `{`?" — and when it is not, every start position inside that run fails
 * identically, so the scan skips the whole run exactly as the engine's own restarts do.
 */
/**
 * Rewrite every nominal back-edge `@Name` inside a recursive shape — the `@` twin of
 * `rewriteTags`, and needed for the same reason: a non-entry module's declarations are
 * alpha-renamed, so the references have to follow. A maximal identifier run after an `@` is
 * the whole name, so there is no partial match to worry about.
 *
 * A MAP, not a single from/to pair. This took its own name only, which is right for a
 * SELF-recursive declaration and wrong for every mutual cycle: `Call.callee: Expr` and
 * `Expr = Num | Call` are two entries of one SCC, so `Call`'s shape carries `@Expr` — a
 * reference to a SIBLING, which the single-name form left unrenamed and therefore DANGLING
 * in the merged table. src/ast.ts is a 46-declaration cycle imported by every other module,
 * so this was the shape that mattered, and it did not fail loudly: `genInspect` unfolds a
 * `@N` and re-enters itself, `expandTypeRef` returns an unknown name UNCHANGED, and JSC
 * makes that tail call a loop — the compiler HUNG. See test/modules/rectypes.
 *
 * A name absent from the map is left alone: it is either an entry-module declaration (which
 * keeps its own name) or a reference this module did not mint, and guessing at it is the one
 * thing a nominal encoding must not do.
 *
 * QUOTED RUNS ARE SKIPPED. `@` is legal inside a string-literal TAG (`kind: "user@host"`) and
 * inside a property KEY (`{ "x@y": 1 }`), both of which land verbatim in the encoding — the
 * same trap `hasTypeRef` documents, and it matters more here than it did when this function
 * only ever saw recursive SHAPES: it now runs over every Ty in a non-entry module, so a tag
 * that merely spells one of that module's recursive names would otherwise be rewritten into a
 * different string literal. A `"` is not escaped inside a Ty (`widenLiteralTys` assumes the
 * same), so the next `"` closes the run.
 */
function rewriteRefs(t: string, renames: Map<string, string>): string {
  if (renames.size === 0) return t;
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (t[i] === `"`) {
      const close = t.indexOf(`"`, i + 1);
      if (close < 0) { out += t.slice(i); break; }
      out += t.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (t[i] !== "@" || i + 1 >= t.length || !isIdentStart(t[i + 1]!)) { out += t[i]; i++; continue; }
    let j = i + 1;
    while (j < t.length && isIdentPart(t[j]!)) j++;
    const to = renames.get(t.slice(i + 1, j));
    out += to === undefined ? t.slice(i, j) : `@${to}`;
    i = j;
  }
  return out;
}

function rewriteTags(t: string, tags: Map<string, string>): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (!isIdentStart(t[i]!)) { out += t[i]; i++; continue; }
    let j = i;
    while (j < t.length && isIdentPart(t[j]!)) j++;
    const name = t.slice(i, j);
    // `j < t.length` FIRST: an identifier that ENDS the string leaves `j` at index ==
    // length, which node answers `undefined` and nativets panics on (Stage 41). The
    // spelling matches `renameTag` above, which already guards `i + 1 >= t.length`.
    if (j < t.length && t[j] === "{") {
      out += `${tags.get(name) ?? name}{`;
      i = j + 1;
    } else {
      out += name;
      i = j;
    }
  }
  return out;
}

/**
 * Rewrite class-instance tags AND nominal back-edges inside a Ty
 * (`Point{x:number}` → `_m1_Point{x:number}`, `@Expr` → `@_m1_Expr`).
 *
 * Both halves are the same job — a NOMINAL name embedded in a structural encoding — and
 * both must move when a module is alpha-renamed. Doing only the tags left every signature
 * in a non-entry module carrying the module's own pre-rename `@N`, so an argument typed by
 * the (correctly renamed) IMPORTED shape was refused against the callee's stale one:
 * `expects …callee:@Expr…, got …callee:@_m0_Expr…`, two spellings of one type.
 */
function rewriteTy<T extends Ty | undefined>(t: T, tags: Map<string, string>, refs: Map<string, string>): T {
  if (t === undefined || (tags.size === 0 && refs.size === 0)) return t;
  // A tag is an identifier immediately followed by `{`. Field names are followed by
  // `:`, so `{a:{b:number}}` never matches — only genuine class tags do.
  return rewriteRefs(rewriteTags(t as string, tags), refs) as T;
}

/**
 * Alpha-rename a module in place: every occurrence of a mapped name becomes its
 * mapped form, and every Ty string has its class tags rewritten. Uniform renaming
 * (declarations AND uses, at every depth) keeps the module's meaning identical.
 */
class Renamer {
  constructor(private names: Map<string, string>, private tags: Map<string, string>, private refs: Map<string, string> = new Map()) {}

  private n(name: string): string { return this.names.get(name) ?? name; }
  /** A class member lowers to the FuncDecl `C.m` — rename the `C` head only. */
  private dotted(name: string): string {
    const i = name.indexOf(".");
    if (i < 0) return this.n(name);
    return `${this.n(name.slice(0, i))}${name.slice(i)}`;
  }
  private t<T extends Ty | undefined>(t: T): T { return rewriteTy(t, this.tags, this.refs); }

  program(p: Program): void { p.body.forEach((s) => this.stmt(s)); }

  private param(p: Param): void {
    p.name = this.n(p.name);
    p.annot = this.t(p.annot);
    if (p.default) this.expr(p.default);
  }
  private decl(d: Declarator): void {
    d.name = this.n(d.name);
    d.annot = this.t(d.annot);
    d.ty = this.t(d.ty);
    if (d.init) this.expr(d.init);
  }

  stmt(s: Stmt): void {
    switch (s.kind) {
      case "VarDecl": (s as VarDecl).decls.forEach((d) => this.decl(d)); return;
      case "FuncDecl": {
        const f = s as FuncDecl;
        f.name = this.dotted(f.name);
        f.params.forEach((p) => this.param(p));
        f.returnAnnot = this.t(f.returnAnnot);
        f.returnTy = this.t(f.returnTy);
        f.body.forEach((b) => this.stmt(b));
        return;
      }
      case "ReturnStmt": if (s.argument) this.expr(s.argument); return;
      case "IfStmt": this.expr(s.test); s.consequent.forEach((x) => this.stmt(x)); s.alternate?.forEach((x) => this.stmt(x)); return;
      case "WhileStmt": this.expr(s.test); s.body.forEach((x) => this.stmt(x)); return;
      case "DoWhileStmt": s.body.forEach((x) => this.stmt(x)); this.expr(s.test); return;
      case "ForStmt":
        if (s.init) { if ((s.init as Stmt).kind === "VarDecl") this.stmt(s.init as Stmt); else this.expr(s.init as Expr); }
        if (s.test) this.expr(s.test);
        if (s.update) this.expr(s.update);
        s.body.forEach((x) => this.stmt(x));
        return;
      case "ForOfStmt": s.name = this.n(s.name); s.annot = this.t(s.annot); s.elemTy = this.t(s.elemTy); this.expr(s.iterable); s.body.forEach((x) => this.stmt(x)); return;
      case "ForInStmt": s.name = this.n(s.name); this.expr(s.object); s.body.forEach((x) => this.stmt(x)); return;
      case "SwitchStmt": this.expr(s.discriminant); s.cases.forEach((c) => { if (c.test) this.expr(c.test); c.body.forEach((x) => this.stmt(x)); }); return;
      case "ThrowStmt": this.expr(s.argument); return;
      case "TryStmt":
        s.block.forEach((x) => this.stmt(x));
        if (s.param) s.param = this.n(s.param);
        s.catchTy = this.t(s.catchTy);
        s.handler?.forEach((x) => this.stmt(x));
        s.finalizer?.forEach((x) => this.stmt(x));
        return;
      case "ExprStmt": this.expr(s.expr); return;
      case "BlockStmt": case "MultiStmt": (s.kind === "BlockStmt" ? s.body : s.stmts).forEach((x) => this.stmt(x)); return;
      default: return; // Break/Continue
    }
  }

  expr(e: Expr): void {
    e.ty = this.t(e.ty);
    switch (e.kind) {
      case "Identifier": e.name = this.n(e.name); return;
      case "TemplateLiteral": e.exprs.forEach((x) => this.expr(x)); return;
      case "ArrayLiteral": e.elements.forEach((x) => this.expr(x)); return;
      case "ObjectLiteral": e.properties.forEach((p) => this.expr(p.value)); return; // keys are data
      case "SpreadExpr": this.expr(e.argument); return;
      case "MemberExpr": this.expr(e.object); return;                                // property is data
      case "IndexExpr": this.expr(e.object); this.expr(e.index); return;
      case "UnaryExpr": this.expr(e.operand); return;
      case "TypeofExpr": this.expr(e.operand); return;
      case "UpdateExpr": if (e.targetExpr) this.expr(e.targetExpr); else e.target = this.n(e.target); return;
      case "BinaryExpr": case "LogicalExpr": this.expr(e.left); this.expr(e.right); return;
      case "ConditionalExpr": this.expr(e.test); this.expr(e.consequent); this.expr(e.alternate); return;
      case "SequenceExpr": e.exprs.forEach((x) => this.expr(x)); return;
      case "AssignExpr": e.target = this.n(e.target); this.expr(e.value); return;
      case "IndexAssign": this.expr(e.object); this.expr(e.index); this.expr(e.value); return;
      case "FieldAssign": this.expr(e.object); this.expr(e.value); return;
      case "AsExpr": case "SatisfiesExpr": e.ty = this.t(e.ty)!; this.expr(e.expr); return;
      // PRE-EXISTING BUG, and the two kinds that were missing. `NonNullExpr` (`x!`) and
      // `InExpr` (`k in o`) fell through to `default`, which is the LITERAL case — so
      // every module-level name underneath one of them kept its unprefixed spelling in a
      // non-entry module. `export const table = […]` read as `table[0]!` from a second
      // module was `'table' is not defined`, and `fields(m)[0]!` was `NT1003 unknown
      // callee`. Both are correct TypeScript that node runs. Found via src/ast.ts:404
      // (`unionTagValues`), which is why seven modules reported an ast.ts blocker.
      case "NonNullExpr": this.expr(e.expr); return;
      case "InExpr": this.expr(e.key); this.expr(e.object); return;
      case "InstanceOfExpr": e.className = this.n(e.className); this.expr(e.object); return;
      case "NewExpr":
        e.callee = this.n(e.callee);
        if (e.typeArgs) e.typeArgs = e.typeArgs.map((t) => this.t(t)!);
        e.args.forEach((a) => this.expr(a));
        return;
      case "CallExpr": this.expr(e.callee); e.args.forEach((a) => this.expr(a)); return;
      case "ArrowFunction": {
        const a = e as ArrowFunction;
        a.params.forEach((p) => this.param(p));
        if (a.paramTys) a.paramTys = a.paramTys.map((t) => this.t(t)!);
        a.retTy = this.t(a.retTy);
        if (a.exprBody) this.expr(a.body as Expr); else (a.stmts as Stmt[]).forEach((s) => this.stmt(s));
        return;
      }
      // The kinds with no sub-expressions, listed rather than defaulted. `default: return`
      // is what let `NonNullExpr` and `InExpr` be silently skipped for as long as they
      // have existed: a walker whose fall-through means "nothing to do" cannot tell a
      // leaf from a node someone forgot. The `never` binding below makes a new `Expr`
      // kind a TYPE error here instead of a missed rename at run time.
      case "NumberLiteral": case "StringLiteral": case "BooleanLiteral":
      case "UndefinedLiteral": case "NullLiteral":
        return;
      default: {
        const unhandled: never = e;
        void unhandled;
        return;
      }
    }
  }
}

/* ------------------------------------------------------------- name census */

/**
 * Every name a module contributes to the SHARED namespace, i.e. everything a rename
 * must cover. That is its top-level functions/classes (which become LLVM functions)
 * plus every binding that ends up in `main`'s frame — and `main`'s frame is FLAT, so
 * a `const` nested in a top-level `if`, a top-level `for-of` loop variable and a
 * `catch` parameter all count. Function bodies are NOT walked: each has its own
 * frame, so its locals cannot collide across modules.
 */
function topLevelNames(p: Program): string[] {
  //@@mutable
  const out: string[] = [];
  const walk = (list: Stmt[]): void => {
    for (const s of list) {
      switch (s.kind) {
        // A class lowers to the FuncDecls `C.constructor` / `C.m` — the head is the class name.
        case "FuncDecl": out.push(s.name.split(".")[0]!); break;
        case "VarDecl": for (const d of s.decls) out.push(d.name); break;
        case "IfStmt": walk(s.consequent); if (s.alternate) walk(s.alternate); break;
        case "WhileStmt": case "DoWhileStmt": case "BlockStmt": walk(s.body); break;
        case "ForStmt":
          if (s.init && (s.init as Stmt).kind === "VarDecl") walk([s.init as Stmt]);
          walk(s.body);
          break;
        case "ForOfStmt": case "ForInStmt": out.push(s.name); walk(s.body); break;
        case "SwitchStmt": for (const c of s.cases) walk(c.body); break;
        case "TryStmt":
          if (s.param) out.push(s.param);
          walk(s.block);
          if (s.handler) walk(s.handler);
          if (s.finalizer) walk(s.finalizer);
          break;
        case "MultiStmt": walk(s.stmts); break;
        default: break;
      }
    }
  };
  walk(p.body);
  return [...new Set(out)];
}

/** Which of a module's top-level names are CLASSES (their Ty carries the name as a tag). */
function classNames(p: Program): Set<string> {
  const out = new Set<string>();
  for (const s of p.body) if (s.kind === "FuncDecl" && s.name.endsWith(".constructor")) out.add(s.name.slice(0, -".constructor".length));
  return out;
}

/**
 * A rename prefix guaranteed not to collide with anything the sources already use.
 * We prefer the short, readable `_m` and only escalate if a program literally
 * contains that text.
 *
 * The escalation is a PURE FUNCTION OF THE SOURCES. It used to end at
 * `` `_nts${Date.now().toString(36)}_m` ``, which minted a different set of global
 * names on every run of the same inputs — and the one file in the tree guaranteed to
 * contain all three preferred bases is THIS one (they are the candidate list, right
 * below), so the clock branch was reached by exactly the module the self-hosting
 * measurement cares most about. That broke three things at once: the message-identity
 * ratchet in test/selfhost-ratchet.test.ts, the byte-identical-message attribution in
 * test/sh6.test.ts, and SH7's definition of done ("nativets-2 and nativets-3 are
 * byte-identical" — a compiler naming globals from the clock cannot reproduce itself).
 * Counting instead of reading the clock keeps the same no-collision guarantee, and
 * terminates: each candidate is longer than the last, so a finite source set must
 * eventually fail to contain one. Pinned in test/modules.test.ts.
 *
 * Exported for TOOLING: a mangled top-level name is `${base}${i}_${original}`, so `base`
 * is what lets a reader turn a linked name back into the module index it came from.
 * `test/blocker-metric.ts` attributes every blocker that way — exactly, for every
 * function, rather than through a `loc` most nodes do not carry.
 */
export function choosePrefixBase(sources: string[]): string {
  for (const base of ["_m", "_nt_m", "_nativets_module_"]) {
    if (!sources.some((s) => s.includes(base))) return base;
  }
  for (let n = 0; ; n++) {
    const base = `_nts${n}_m`;
    if (!sources.some((s) => s.includes(base))) return base;
  }
}

/* -------------------------------------------------------------- resolution */

function resolveSpecifier(fromPath: string, spec: string): string {
  return resolve(dirname(fromPath), spec);
}

/** A module path as the user would type it — relative to the cwd when it is below it. */
function show(path: string): string {
  const r = relative(process.cwd(), path);
  return r && !r.startsWith("..") ? r : path;
}

/**
 * Post-order DFS over the import graph: dependencies before dependents, once each.
 * Fills `sources` and `deps` (each module's import list, from a discovery parse that
 * the caller reuses) and refuses a cycle or an unreadable module with an NT17xx code.
 */
function moduleOrder(
  entry: string,
  read: ReadModule,
  sources: Map<string, string>,
  deps: Map<string, ImportDecl[]> = new Map(),
): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  /** Aligned with `stack`: was the edge that reached `stack[i]` an `import type`? */
  const edges: boolean[] = [];

  const load = (path: string, importer: string | null, line: number): string => {
    const cached = sources.get(path);
    if (cached !== undefined) return cached;
    let src: string;
    try {
      src = read(path);
    } catch {
      const where = importer ? ` (imported by ${show(importer)}:${line})` : "";
      throw moduleError("NT1701", `cannot read module '${show(path)}'${where}`,
        "check the path and the file extension — module specifiers are relative and explicit (`./util.ts`), exactly as node resolves them");
    }
    sources.set(path, src);
    return src;
  };

  const visit = (path: string, importer: string | null, line: number, typeOnly: boolean): void => {
    if (done.has(path)) return;
    const at = stack.indexOf(path);
    if (at >= 0) {
      // The chain, with each module's INCOMING edge marked when it is `import type`.
      //
      // A type-only edge is erased by node and bun, so at RUN TIME a cycle it closes does
      // not exist — and tsc permits one outright. We refuse it anyway, and the reason is
      // ORDERING, not evaluation: the loop below links modules in post-order and seeds each
      // one's type environment from the modules linked BEFORE it, so a type reachable only
      // by going forward in that order has nothing to resolve against. Simply dropping the
      // edge here was measured and is NOT sound — the name is then never seeded, and an
      // unresolved type falls through parser.ts's last resort to `number`, silently.
      //
      // So the diagnostic's job is to point at the edge that is one declaration from being
      // gone, instead of leaving the reader to conclude their program is cyclic. It is not.
      const names = [...stack.slice(at), path];
      const marks = [...edges.slice(at + 1), typeOnly]; // marks[i-1] is names[i]'s edge
      const cycle = names.map((p, i) => (i > 0 && marks[i - 1] ? `${show(p)}   (this edge is \`import type\`)` : show(p))).join("\n  → ");
      throw moduleError("NT1702", `import cycle:\n  → ${cycle}`,
        marks.some((m) => m)
          ? "node erases an `import type`, so this cycle does not exist at run time — but nativets resolves each module's types from the modules linked BEFORE it, and a cycle has no such order (docs/divergences.md). Move the shared TYPE into a module that both import — usually the one that does not import the other"
          : "break the cycle — move the shared declarations into a third module that both import");
    }
    const src = load(path, importer, line);
    stack.push(path);
    edges.push(typeOnly);
    // A discovery parse, just for the import list: the REAL parse happens post-order
    // below, seeded with the dependencies' type exports (unknowable until then).
    const imports = parse(src).imports ?? [];
    deps.set(path, imports);
    // An `import type { … }` clause (or one whose every specifier is `type`-prefixed)
    // binds no value. It is still an edge — see the refusal above — but it is a
    // DIFFERENT KIND of edge, and the user needs to be told which one they hit.
    for (const imp of imports) visit(resolveSpecifier(path, imp.source), path, imp.line,
      imp.specs.length > 0 && imp.specs.every((s) => s.typeOnly === true));
    stack.pop();
    edges.pop();
    done.add(path);
    order.push(path);
  };

  visit(entry, null, 0, false);
  return order;
}

/* ------------------------------------------------------- text imports (SH5) */

/**
 * `import src from "./x.c" with { type: "text" }` — read the file NOW and hand back
 * `const src = "<its bytes>";`, prepended to the importing module's body.
 *
 * This is the whole implementation: after it runs, `src` is an ordinary `const string`
 * and nothing downstream (checker, ownership, codegen) knows a text import existed. The
 * bytes reach the `.ll` as an interned string constant, so the compiled program does no
 * file I/O at run time — which is the point, since this is how the compiler embeds its
 * own C runtime into a single self-contained executable.
 *
 * Two refusals, both of the reject-don't-miscompile kind:
 *   - an unreadable file is NT1701, like an unresolvable module;
 *   - a file containing a NUL byte is NT1704. nativets strings are NUL-terminated, so
 *     inlining one would silently truncate the constant at that byte.
 */
function materializeTextImports(program: Program, path: string, read: ReadModule): Stmt[] {
  // `.map`, not a `push` loop: `arr.push` is NT1606 here, and this file has to stay
  // inside the subset nativets can compile ITSELF in.
  return (program.textImports ?? []).map((t) => {
    const target = resolveSpecifier(path, t.source);
    const where = `(imported by ${show(path)}:${t.line}:${t.col})`;
    let text: string;
    try {
      text = read(target);
    } catch {
      throw moduleError("NT1701", `cannot read the text import '${show(target)}' ${where}`,
        "a `with { type: \"text\" }` specifier is a path relative to the importing file, like an import specifier — check the path and the extension");
    }
    // `String.fromCharCode(0)`, not a `"\0"` literal. The reason changed but the spelling
    // did not: the escape IS in nativets' lexer now, and a literal holding a NUL is
    // exactly what NT1705 refuses — so writing one here would make this file
    // un-self-hostable. Same spelling in `src/lexer.ts`'s `escapeChar`.
    const nul = text.indexOf(String.fromCharCode(0));
    if (nul >= 0) {
      throw moduleError("NT1704", `the text import '${show(target)}' ${where} contains a NUL byte at offset ${nul}`,
        "nativets strings are NUL-terminated, so a NUL in the file would silently truncate the constant. Text imports are for TEXT — read a binary file at run time instead");
    }
    const decl: VarDecl = {
      kind: "VarDecl",
      declKind: "const",
      decls: [{ name: t.local, annot: "string", init: { kind: "StringLiteral", value: text } }],
    };
    return decl as Stmt;
  });
}

/* ------------------------------------------------------------------ linker */

/**
 * Resolve + merge the module graph rooted at `entryPath` into one Program.
 * A source with no `import`/`export` is returned exactly as `parse()` gave it, so
 * every single-file program takes an unchanged path through the compiler.
 */
export function linkProgram(entrySource: string, entryPath?: string, read: ReadModule = defaultRead): Program {
  const first = parse(entrySource, { file: entryPath });
  if (!first.imports?.length) {
    // Ordinary single-module program — but it may still inline text (SH5), which is a
    // read, not a graph edge, so it needs no linking pass.
    if (first.textImports?.length) {
      first.body = [...materializeTextImports(first, resolve(entryPath ?? "entry.ts"), read), ...first.body];
    }
    return first;
  }

  const entry = resolve(entryPath ?? "entry.ts");
  const sources = new Map<string, string>().set(entry, entrySource);
  const deps = new Map<string, ImportDecl[]>();
  const order = moduleOrder(entry, read, sources, deps);
  const prefixBase = choosePrefixBase([...sources.values()]);

  const mods = new Map<string, ModuleInfo>();
  let body: Stmt[] = [];
  /** `@@mutable` class names, under their FINAL (post-rename) names. Losing these across
   *  the link would silently downgrade a mutable class to copy-on-write, so they travel
   *  with the merged program (see docs/decorators.md). */
  const mutableClasses = new Set<string>();
  /** `@@mutable` RECORD tags, likewise under their final (post-rename) names. A record
   *  type binds no VALUE, so it is not in `topLevelNames` — but its tag is embedded in
   *  every Ty that mentions it, so it is renamed per module through `tags` for exactly
   *  the reason class tags are: two modules may each declare a `Cell`. */
  const mutableRecords = new Set<string>();
  /* Recursive-type shapes (`@Name` back-edges, ast.ts). Merged across modules under the
   * SAME per-module renaming class tags get: two modules may each declare a recursive
   * `Node`, and a shape is only meaningful next to the name its back-edge resolves through,
   * so a collision here would silently give one module's nodes the other's layout. */
  const recTypes = new Map<string, Ty>();
  /** Host builtins (SH4) imported ANYWHERE in the graph. These are canonical builtin
   *  names, not module bindings, so they are never renamed — a `node:` import binds a
   *  compiler builtin, and the merged program simply needs the union. The compiler's
   *  own source is exactly this shape (src/modules.ts imports node:fs; src/cli.ts is
   *  the entry), so without the union a non-entry module's host call would vanish. */
  const hostImports = new Set<string>();

  order.forEach((path, i) => {
    const source = sources.get(path)!;
    const isEntry = path === entry;

    // 1. Type environment: every imported name that names a TYPE in its module
    //    (an `export type`/`interface`, or an exported class's instance shape).
    const typeEnv = new Map<string, Ty>();
    /** …and, on the same walk, every imported name that is an `export async function`,
     *  under the LOCAL name this module calls it by (so `import { one as o }` guards
     *  `o()`). Without it an un-awaited imported call is silently erased. */
    const asyncEnv = new Set<string>();
    for (const imp of deps.get(path) ?? []) { // import list from the discovery parse
      const dep = mods.get(resolveSpecifier(path, imp.source));
      if (!dep) continue;
      for (const spec of imp.specs) {
        const t = dep.finalTypes.get(spec.imported);
        if (t !== undefined) typeEnv.set(spec.local, t);
        if (dep.asyncExports.has(spec.imported)) asyncEnv.add(spec.local);
      }
    }

    // 2. The real parse, with imported types in scope. A text import (SH5) becomes a
    //    `const` at the head of the body BEFORE the rename below, so it is an ordinary
    //    top-level binding of this module and is mangled like any other.
    const program = parse(source, { typeEnv, asyncEnv, file: path });
    if (program.textImports?.length) program.body = [...materializeTextImports(program, path, read), ...program.body];

    // 3. Rename map: imported locals → the exporting module's final names; own
    //    top-level bindings → a module-unique name (the entry keeps its own names,
    //    so the emitted IR still reads like the program you wrote).
    const names = new Map<string, string>();
    const tags = new Map<string, string>();
    for (const imp of program.imports ?? []) {
      const depPath = resolveSpecifier(path, imp.source);
      const dep = mods.get(depPath)!;
      for (const spec of imp.specs) {
        if (spec.typeOnly) continue; // type-level only: already seeded above, binds nothing
        const target = dep.finalExports.get(spec.imported);
        if (target === undefined) {
          throw moduleError("NT1703", `module '${imp.source}' has no exported member '${spec.imported}' (imported by ${show(path)}:${imp.line})`,
            `exported members: ${[...dep.finalExports.keys()].join(", ") || "(none)"}`);
        }
        names.set(spec.local, target);
      }
    }
    if (!isEntry) {
      const prefix = `${prefixBase}${i}_`;
      const classes = classNames(program);
      for (const n of topLevelNames(program)) {
        names.set(n, `${prefix}${n}`);
        if (classes.has(n)) tags.set(n, `${prefix}${n}`);
      }
    }
    if (!isEntry) for (const r of program.mutableRecords ?? []) tags.set(r, `${prefixBase}${i}_${r}`);
    for (const c of program.mutableClasses ?? []) mutableClasses.add(names.get(c) ?? c);
    for (const r of program.mutableRecords ?? []) mutableRecords.add(tags.get(r) ?? r);
    // Every declaration of this module's cycle(s) is renamed FIRST, so a shape's references
    // to its SIBLINGS are rewritten with the same map its own name is — a mutual cycle is
    // one unit and renaming half of it leaves the other half dangling. The entry keeps its
    // own names, so the map is empty there and `rewriteRefs` is the identity.
    const refRenames = new Map<string, string>();
    if (!isEntry) for (const e of program.recTypes ?? []) refRenames.set(e.name, `${prefixBase}${i}_${e.name}`);
    for (const e of program.recTypes ?? []) {
      recTypes.set(refRenames.get(e.name) ?? e.name, rewriteRefs(rewriteTags(e.ty, tags), refRenames) as Ty);
    }
    for (const h of program.hostImports ?? []) hostImports.add(h);
    new Renamer(names, tags, refRenames).program(program);

    // 4. Publish this module's export table under the final names.
    const finalExports = new Map<string, string>();
    const finalTypes = new Map<string, Ty>();
    const asyncExports = new Set<string>(program.exports?.asyncValues ?? []);
    for (const [exported, local] of program.exports?.values ?? []) finalExports.set(exported, names.get(local) ?? local);
    for (const [exported, ref] of program.exports?.reexports ?? []) {
      const dep = mods.get(resolveSpecifier(path, ref.source))!;
      const target = dep.finalExports.get(ref.imported);
      if (target === undefined) {
        throw moduleError("NT1703", `module '${ref.source}' has no exported member '${ref.imported}' (re-exported by ${show(path)}:${ref.line})`,
          `exported members: ${[...dep.finalExports.keys()].join(", ") || "(none)"}`);
      }
      finalExports.set(exported, target);
      // A re-export forwards async-ness too: `export { one } from "./lib.ts"` is still
      // a promise-returning function to whoever imports it from HERE.
      if (dep.asyncExports.has(ref.imported)) asyncExports.add(exported);
    }
    // The back-edges travel with the exported SHAPE too, and under the same map. The
    // importing module gets this type verbatim through its `typeEnv`, so an unrenamed `@N`
    // here is a reference that resolves — if at all — against the IMPORTER's names: exactly
    // the "one module's nodes with the other's layout" hazard `recTypes` is renamed to
    // prevent, arriving by the other door.
    for (const [exported, ty] of program.exports?.types ?? []) {
      finalTypes.set(exported, rewriteTy(ty, tags, refRenames));
    }

    mods.set(path, { path, source, program, finalExports, finalTypes, asyncExports });
    body.push(...program.body);
  });

  // A STATIC field lowers to a module-level `const C.f`, and a read of one is rewritten to
  // that binding — but only the declaring module could do it at parse time, so a read from
  // ANOTHER module is still a `C.f` member expression here. Finish the job over the merged
  // body, where every static field is visible under its FINAL (mangled) name: a dotted
  // binding name is one, and nothing else can produce one (no source identifier has a `.`).
  const staticFields = new Set<string>();
  const scanStatics = (list: Stmt[]): void => {
    for (const s of list) {
      if (s.kind === "VarDecl") { for (const d of s.decls) if (d.name.includes(".")) staticFields.add(d.name); }
      else if (s.kind === "MultiStmt") scanStatics(s.stmts); // a class lowers to one of these
    }
  };
  scanStatics(body);
  if (staticFields.size) {
    body = resolveStaticFieldReads(body, staticFields, (n, at) => {
      throw mutationError(`assignment to the static field '${n}'`,
        "a static field is module-level storage initialized once where the class is declared — it is a `const`, so give the class a static METHOD that returns the value you want instead",
        at);
    });
  }
  const merged: Program = { kind: "Program", body };
  if (mutableClasses.size) merged.mutableClasses = [...mutableClasses];
  if (mutableRecords.size) merged.mutableRecords = [...mutableRecords];
  if (recTypes.size) {
    // A record array, not a `Map` spread's `[string, Ty][]` — see `Program.recTypes`.
    let recs: RecTypeEntry[] = [];
    for (const [n, shape] of recTypes) recs = [...recs, { name: n, ty: shape }];
    merged.recTypes = recs;
  }
  if (hostImports.size) merged.hostImports = [...hostImports];
  return merged;
}

/** The module paths an entry file pulls in, in evaluation order (for tooling/tests). */
export function moduleGraph(entrySource: string, entryPath: string, read: ReadModule = defaultRead): string[] {
  const sources = new Map<string, string>().set(resolve(entryPath), entrySource);
  return moduleOrder(resolve(entryPath), read, sources);
}
