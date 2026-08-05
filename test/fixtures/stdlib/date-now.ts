// Date.now() is non-deterministic, so we DON'T assert its exact value against node.
// Instead we print only time-INDEPENDENT facts that hold for both node and our binary
// whenever they run — so stdout is identical byte-for-byte through the differential harness.
const t1: number = Date.now();

// positive, and a plausible "now" (after 2020-01-01, before 2100-01-01 in ms).
console.log(t1 > 0);                 // true
console.log(t1 > 1577836800000);     // true  (2020-01-01T00:00:00Z)
console.log(t1 < 4102444800000);     // true  (2100-01-01T00:00:00Z)

// integer millisecond value (no fractional part), like node.
console.log(Number.isInteger(t1));   // true

// monotonic non-decreasing within a process.
let spin: number = 0;
for (let i: number = 0; i < 100000; i = i + 1) { spin = spin + 1; }
const t2: number = Date.now();
console.log(t2 >= t1);               // true
console.log(spin);                   // 100000 (keeps the loop from being wholly dead)
