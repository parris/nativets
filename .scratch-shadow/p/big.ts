// stress: many collisions in one frame, plus reassignment through renamed slots
let total: number = 0;
const v: number = 1;
{ const v: number = 2; total = total + v; }
{ const v: number = 3; total = total + v; }
{ const v: string = "xy"; total = total + v.length; }
for (let v = 0; v < 2; v++) { total = total + v; }
for (const v of [5, 6]) { total = total + v; }
while (total < 100) { const v: number = 50; total = total + v; }
do { const v: number = 7; total = total + v; } while (false);
switch (v) { default: { const v: number = 11; total = total + v; } }
try { const v: number = 13; total = total + v; } catch (v) { total = total + 1; }
try { throw "q"; } catch (v) { total = total + v.length; }
total = total + v;
console.log(total);
