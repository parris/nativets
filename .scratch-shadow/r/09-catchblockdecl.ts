const a: number = 1;
try { throw "b"; } catch (err) { const a: number = 2; console.log(a); }
console.log(a);
