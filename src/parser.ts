/*
 * Recursive-descent parser with precedence climbing.
 *
 * It accepts a broad surface — including features the checker/codegen do not yet
 * implement (arrays, objects, spread, destructuring, try/catch, optional chain).
 * Parsing them (rather than erroring at the token level) lets the checker reject
 * them with a precise NT-coded diagnostic that `coverage` can report.
 */

import { lex, type Token } from "./lexer.ts";
import { parseError } from "./diagnostics.ts";
import type {
  Program, Stmt, Expr, Param, VarDecl, Declarator, Ty, BinaryOp, SwitchCase, ObjectProperty,
} from "./ast.ts";

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
const SCALARS = new Set(["number", "boolean", "string", "void", "undefined", "null"]);

class Parser {
  private pos = 0;
  private tmpCounter = 0;
  constructor(private toks: Token[]) {}

  private freshTmp(): string { return `__d${this.tmpCounter++}`; }
  private ident(name: string): Expr { return { kind: "Identifier", name }; }

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
    return { kind: "Program", body };
  }

  // ---- types (permissive; we only need scalars precisely) ----
  private parseType(): Ty {
    let base: Ty;
    if (this.at("(")) base = this.parseFuncType();
    else if (this.at("{")) base = this.parseObjectType();
    else if (this.at("[")) base = this.parseTupleType();
    else { const id = this.expectIdent(); base = (id === "Error" ? "{message:string}" : SCALARS.has(id) ? id : "number") as Ty; }
    let suffix = "";
    while (this.at("[")) { this.eat("["); this.eat("]"); suffix += "[]"; } // T[], T[][]
    while (this.at("|") || this.at("&")) { this.next(); this.parseTypeAtomLoose(); } // unions
    return (base + suffix) as Ty;
  }
  // tuple type `[T, U, ...]` — modeled as an array of the first element type
  private parseTupleType(): Ty {
    this.eat("[");
    const tys: Ty[] = [];
    if (!this.at("]")) { do { tys.push(this.parseType()); } while (this.at(",") && (this.eat(","), true)); }
    this.eat("]");
    return `${tys[0] ?? "number"}[]` as Ty;
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
        const key = this.expectIdent();
        if (this.at("?")) this.eat("?"); // optional marker: ignored (treated as present)
        this.eat(":");
        fields.push(`${key}:${this.parseType()}`);
      } while ((this.at(",") || this.at(";")) && (this.next(), true));
    }
    this.eat("}");
    return `{${fields.join(",")}}` as Ty;
  }
  private parseTypeAtomLoose(): void {
    this.expectIdent();
    while (this.at("[")) { this.eat("["); this.eat("]"); }
  }

  // ---- statements ----
  parseStatement(): Stmt {
    if (this.at("let") || this.at("const")) { const d = this.parseVarDecl(); this.eat(";"); return d; }
    if (this.at("function")) return this.parseFuncDecl();
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

  // `const [a, b, ...rest] = expr` → __d = expr; a = __d[0]; b = __d[1]; rest = __d.slice(2)
  private parseArrayDestructure(declKind: "let" | "const"): VarDecl {
    this.eat("[");
    const elems: { name: string; rest: boolean }[] = [];
    if (!this.at("]")) {
      do {
        if (this.at("]")) break;
        let rest = false;
        if (this.at("...")) { this.eat("..."); rest = true; }
        elems.push({ name: this.expectIdent(), rest });
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat("]"); this.eat("=");
    const init = this.parseAssign();
    const tmp = this.freshTmp();
    const decls: Declarator[] = [{ name: tmp, init }];
    elems.forEach((el, i) => {
      const init: Expr = el.rest
        ? { kind: "CallExpr", callee: { kind: "MemberExpr", object: this.ident(tmp), property: "slice" }, args: [{ kind: "NumberLiteral", value: i }] }
        : { kind: "IndexExpr", object: this.ident(tmp), index: { kind: "NumberLiteral", value: i } };
      decls.push({ name: el.name, init });
    });
    return { kind: "VarDecl", declKind, decls };
  }

  private parseFuncDecl(): Stmt {
    this.eat("function");
    const name = this.expectIdent();
    this.eat("(");
    const params: Param[] = [];
    if (!this.at(")")) {
      do {
        let rest = false;
        if (this.at("...")) { this.eat("..."); rest = true; }
        const pname = this.expectIdent();
        let annot: Ty | undefined;
        if (this.at(":")) { this.eat(":"); annot = this.parseType(); }
        let def: Expr | undefined;
        if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
        params.push({ name: pname, annot, default: def, rest });
      } while (this.at(",") && (this.eat(","), true));
    }
    this.eat(")");
    let returnAnnot: Ty | undefined;
    if (this.at(":")) { this.eat(":"); returnAnnot = this.parseType(); }
    return { kind: "FuncDecl", name, params, returnAnnot, body: this.parseBlock() };
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
      const then = this.toks[i + 2];
      return !!after && (after.value === "=>" || (after.value === ":" && !!then)); // (a): T =>
    }
    return false;
  }

  private parseArrow(): Expr {
    const params: Param[] = [];
    if (this.at("(")) {
      this.eat("(");
      if (!this.at(")")) {
        do {
          let rest = false;
          if (this.at("...")) { this.eat("..."); rest = true; }
          const name = this.expectIdent();
          let annot: Ty | undefined;
          if (this.at(":")) { this.eat(":"); annot = this.parseType(); }
          let def: Expr | undefined;
          if (this.at("=")) { this.eat("="); def = this.parseAssign(); }
          params.push({ name, annot, default: def, rest });
        } while (this.at(",") && (this.eat(","), true));
      }
      this.eat(")");
    } else {
      params.push({ name: this.expectIdent() });
    }
    if (this.at(":")) { this.eat(":"); this.parseType(); }
    this.eat("=>");
    if (this.at("{")) return { kind: "ArrowFunction", params, body: this.parseBlock(), exprBody: false };
    return { kind: "ArrowFunction", params, body: this.parseAssign(), exprBody: true };
  }

  private parseAssign(): Expr {
    if (this.looksLikeArrow()) return this.parseArrow();
    const left = this.parsePipe();
    const t = this.peek();
    if (t.type === "punct" && ASSIGN_OPS.has(t.value)) {
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
    if (this.at("typeof")) { this.eat("typeof"); return { kind: "TypeofExpr", operand: this.parseUnary() }; }
    if (this.at("new")) {
      this.eat("new");
      const callee = this.expectIdent();
      this.eat("(");
      const args: Expr[] = [];
      if (!this.at(")")) { args.push(this.parseAssign()); while (this.at(",")) { this.eat(","); args.push(this.parseAssign()); } }
      this.eat(")");
      return { kind: "NewExpr", callee, args };
    }
    if (this.at("++") || this.at("--")) {
      const op = this.next().value as "++" | "--";
      const operand = this.parseUnary();
      if (operand.kind !== "Identifier") throw parseError("Invalid update target");
      return { kind: "UpdateExpr", op, prefix: true, target: operand.name };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at(".")) {
        this.eat(".");
        expr = { kind: "MemberExpr", object: expr, property: this.expectIdent() };
      } else if (this.at("?.")) {
        this.eat("?.");
        expr = { kind: "MemberExpr", object: expr, property: this.expectIdent(), optional: true } as any;
      } else if (this.at("[")) {
        this.eat("[");
        const index = this.parseExpression();
        this.eat("]");
        expr = { kind: "IndexExpr", object: expr, index };
      } else if (this.at("(")) {
        this.eat("(");
        const args: Expr[] = [];
        if (!this.at(")")) {
          do {
            if (this.at("...")) { this.eat("..."); args.push({ kind: "SpreadExpr", argument: this.parseAssign() }); }
            else args.push(this.parseAssign());
          } while (this.at(",") && (this.eat(","), true));
        }
        this.eat(")");
        expr = { kind: "CallExpr", callee: expr, args };
      } else if ((this.at("++") || this.at("--")) && expr.kind === "Identifier") {
        const op = this.next().value as "++" | "--";
        expr = { kind: "UpdateExpr", op, prefix: false, target: expr.name };
      } else break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "num") { this.next(); return { kind: "NumberLiteral", value: Number(t.value) }; }
    if (t.type === "str") { this.next(); return { kind: "StringLiteral", value: t.value }; }
    if (t.type === "template") { this.next(); return this.buildTemplate(t.value); }
    if (t.type === "ident") {
      if (t.value === "true" || t.value === "false") { this.next(); return { kind: "BooleanLiteral", value: t.value === "true" }; }
      if (t.value === "undefined") { this.next(); return { kind: "UndefinedLiteral" }; }
      if (t.value === "null") { this.next(); return { kind: "NullLiteral" }; }
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
        let depth = 1;
        let src = "";
        while (i < raw.length && depth > 0) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") { depth--; if (depth === 0) break; }
          src += raw[i]; i++;
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

function decodeEscape(ch: string): string {
  const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "`": "`", "$": "$" };
  return map[ch] ?? ch;
}

export function parse(source: string): Program {
  return new Parser(lex(source)).parseProgram();
}

export function parseExpressionFrom(source: string): Expr {
  return new Parser(lex(source)).parseExpression();
}
