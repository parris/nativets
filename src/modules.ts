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
import { moduleError } from "./diagnostics.ts";
import type {
  Program, Stmt, Expr, Ty, Declarator, Param, ArrowFunction, VarDecl, FuncDecl, ImportDecl,
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
function rewriteTags(t: string, tags: Map<string, string>): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (!isIdentStart(t[i]!)) { out += t[i]; i++; continue; }
    let j = i;
    while (j < t.length && isIdentPart(t[j]!)) j++;
    const name = t.slice(i, j);
    if (t[j] === "{") {
      out += `${tags.get(name) ?? name}{`;
      i = j + 1;
    } else {
      out += name;
      i = j;
    }
  }
  return out;
}

/** Rewrite class-instance tags inside a Ty (`Point{x:number}` → `_m1_Point{x:number}`). */
function rewriteTy<T extends Ty | undefined>(t: T, tags: Map<string, string>): T {
  if (t === undefined || tags.size === 0) return t;
  // A tag is an identifier immediately followed by `{`. Field names are followed by
  // `:`, so `{a:{b:number}}` never matches — only genuine class tags do.
  return rewriteTags(t as string, tags) as T;
}

/**
 * Alpha-rename a module in place: every occurrence of a mapped name becomes its
 * mapped form, and every Ty string has its class tags rewritten. Uniform renaming
 * (declarations AND uses, at every depth) keeps the module's meaning identical.
 */
class Renamer {
  constructor(private names: Map<string, string>, private tags: Map<string, string>) {}

  private n(name: string): string { return this.names.get(name) ?? name; }
  /** A class member lowers to the FuncDecl `C.m` — rename the `C` head only. */
  private dotted(name: string): string {
    const i = name.indexOf(".");
    if (i < 0) return this.n(name);
    return `${this.n(name.slice(0, i))}${name.slice(i)}`;
  }
  private t<T extends Ty | undefined>(t: T): T { return rewriteTy(t, this.tags); }

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
    this.expr(d.init);
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
        if (a.exprBody) this.expr(a.body as Expr); else (a.body as Stmt[]).forEach((s) => this.stmt(s));
        return;
      }
      default: return; // literals
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
 */
function choosePrefixBase(sources: string[]): string {
  for (const base of ["_m", "_nt_m", "_nativets_module_"]) {
    if (!sources.some((s) => s.includes(base))) return base;
  }
  return `_nts${Date.now().toString(36)}_m`;
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

  const visit = (path: string, importer: string | null, line: number): void => {
    if (done.has(path)) return;
    const at = stack.indexOf(path);
    if (at >= 0) {
      const cycle = [...stack.slice(at), path].map(show).join("\n  → ");
      throw moduleError("NT1702", `import cycle:\n  → ${cycle}`,
        "break the cycle — move the shared declarations into a third module that both import");
    }
    const src = load(path, importer, line);
    stack.push(path);
    // A discovery parse, just for the import list: the REAL parse happens post-order
    // below, seeded with the dependencies' type exports (unknowable until then).
    const imports = parse(src).imports ?? [];
    deps.set(path, imports);
    for (const imp of imports) visit(resolveSpecifier(path, imp.source), path, imp.line);
    stack.pop();
    done.add(path);
    order.push(path);
  };

  visit(entry, null, 0);
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
    // `String.fromCharCode(0)`, not `"\0"`: that escape is not in nativets' lexer, so the
    // literal form would decode to the character `0` once this file compiles itself.
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
  const sources = new Map<string, string>([[entry, entrySource]]);
  const deps = new Map<string, ImportDecl[]>();
  const order = moduleOrder(entry, read, sources, deps);
  const prefixBase = choosePrefixBase([...sources.values()]);

  const mods = new Map<string, ModuleInfo>();
  const body: Stmt[] = [];
  /** `@@mutable` class names, under their FINAL (post-rename) names. Losing these across
   *  the link would silently downgrade a mutable class to copy-on-write, so they travel
   *  with the merged program (see docs/decorators.md). */
  const mutableClasses = new Set<string>();
  /** `@@mutable` RECORD tags, likewise under their final (post-rename) names. A record
   *  type binds no VALUE, so it is not in `topLevelNames` — but its tag is embedded in
   *  every Ty that mentions it, so it is renamed per module through `tags` for exactly
   *  the reason class tags are: two modules may each declare a `Cell`. */
  const mutableRecords = new Set<string>();
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
    for (const imp of deps.get(path) ?? []) { // import list from the discovery parse
      const dep = mods.get(resolveSpecifier(path, imp.source));
      if (!dep) continue;
      for (const spec of imp.specs) {
        const t = dep.finalTypes.get(spec.imported);
        if (t !== undefined) typeEnv.set(spec.local, t);
      }
    }

    // 2. The real parse, with imported types in scope. A text import (SH5) becomes a
    //    `const` at the head of the body BEFORE the rename below, so it is an ordinary
    //    top-level binding of this module and is mangled like any other.
    const program = parse(source, { typeEnv, file: path });
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
    for (const h of program.hostImports ?? []) hostImports.add(h);
    new Renamer(names, tags).program(program);

    // 4. Publish this module's export table under the final names.
    const finalExports = new Map<string, string>();
    const finalTypes = new Map<string, Ty>();
    for (const [exported, local] of program.exports?.values ?? []) finalExports.set(exported, names.get(local) ?? local);
    for (const [exported, ref] of program.exports?.reexports ?? []) {
      const dep = mods.get(resolveSpecifier(path, ref.source))!;
      const target = dep.finalExports.get(ref.imported);
      if (target === undefined) {
        throw moduleError("NT1703", `module '${ref.source}' has no exported member '${ref.imported}' (re-exported by ${show(path)}:${ref.line})`,
          `exported members: ${[...dep.finalExports.keys()].join(", ") || "(none)"}`);
      }
      finalExports.set(exported, target);
    }
    for (const [exported, ty] of program.exports?.types ?? []) finalTypes.set(exported, rewriteTy(ty, tags));

    mods.set(path, { path, source, program, finalExports, finalTypes });
    body.push(...program.body);
  });

  const merged: Program = { kind: "Program", body };
  if (mutableClasses.size) merged.mutableClasses = [...mutableClasses];
  if (mutableRecords.size) merged.mutableRecords = [...mutableRecords];
  if (hostImports.size) merged.hostImports = [...hostImports];
  return merged;
}

/** The module paths an entry file pulls in, in evaluation order (for tooling/tests). */
export function moduleGraph(entrySource: string, entryPath: string, read: ReadModule = defaultRead): string[] {
  const sources = new Map<string, string>([[resolve(entryPath), entrySource]]);
  return moduleOrder(resolve(entryPath), read, sources);
}
