import fs from "fs";
const C = {
"01-const-if": `const a: number = 1;
if (a > 0) { const a: number = 2; console.log(a); }
console.log(a);`,
"02-let-if": `let a: number = 1;
if (a > 0) { let a: number = 2; console.log(a); }
console.log(a);`,
"03-var-if": `var a: number = 1;
if (a > 0) { var a: number = 2; console.log(a); }
console.log(a);`,
"04-const-bareblock": `const a: number = 1;
{ const a: number = 2; console.log(a); }
console.log(a);`,
"05-const-loopbody": `const a: number = 1;
for (let i = 0; i < 2; i++) { const a: number = i + 10; console.log(a); }
console.log(a);`,
"06-forinit": `const i: number = 99;
for (let i = 0; i < 2; i++) { console.log(i); }
console.log(i);`,
"07-tryblock": `const a: number = 1;
try { const a: number = 2; console.log(a); } catch (e) { console.log("x"); }
console.log(a);`,
"08-catchbinding": `const e: number = 1;
try { throw "boom"; } catch (e) { console.log(e); }
console.log(e);`,
"09-catchblockdecl": `const a: number = 1;
try { throw "b"; } catch (err) { const a: number = 2; console.log(a); }
console.log(a);`,
"10-arrowbody": `const a: number = 1;
const f = (): number => { const a: number = 2; return a; };
console.log(f());
console.log(a);`,
"11-nestedfn": `const a: number = 1;
function g(): number { const a: number = 2; return a; }
console.log(g());
console.log(a);`,
"12-param-shadowed": `function h(a: number): number { const a2: number = a; { const a: number = 50; console.log(a); } return a2; }
console.log(h(7));`,
"13-twolevels": `const a: number = 1;
{ const a: number = 2; { const a: number = 3; console.log(a); } console.log(a); }
console.log(a);`,
"14-closure": `const f = (k: number): number => k + 1;
{ const f = (k: number): number => k + 20; console.log(f(1)); }
console.log(f(1));`,
"15-string": `const s: string = "out";
{ const s: string = "in"; console.log(s); }
console.log(s);`,
"16-difftype": `const a: number = 1;
{ const a: string = "two"; console.log(a); }
console.log(a);`,
"17-whilebody": `const a: number = 1;
let n = 0;
while (n < 2) { const a: number = n + 10; console.log(a); n++; }
console.log(a);`,
"18-forof": `const x: number = 1;
for (const x of [10, 20]) { console.log(x); }
console.log(x);`,
"19-fnbody-shadows-outer": `const a: number = 1;
function g(): void { const a: number = 2; console.log(a); }
g();
console.log(a);`,
"20-param-then-block": `function p(a: number): number { { const a: number = 99; console.log(a); } return a; }
console.log(p(5));`,
"21-array-linear": `const xs: number[] = [1, 2];
{ const xs: number[] = [3, 4, 5]; console.log(xs.length); }
console.log(xs.length);`,
"22-sibling-blocks": `{ const a: number = 1; console.log(a); }
{ const a: string = "two"; console.log(a); }`,
"23-loop-const-capture": `const fs2: number[] = [];
for (let i = 0; i < 3; i++) { const c: number = i * 2; fs2.push(c); }
console.log(fs2.join(","));`,
"24-switch-case": `const a: number = 1;
switch (a) { case 1: { const a: number = 7; console.log(a); break; } }
console.log(a);`,
};
for (const [k,v] of Object.entries(C)) fs.writeFileSync(k+".ts", v+"\n");
console.log(Object.keys(C).length);
