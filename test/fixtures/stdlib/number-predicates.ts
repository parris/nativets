// Number.isInteger / isFinite / isSafeInteger — booleans, no coercion.
console.log(Number.isInteger(42));        // true
console.log(Number.isInteger(42.5));      // false
console.log(Number.isInteger(0));         // true
console.log(Number.isInteger(-7));        // true
console.log(Number.isInteger(1 / 0));     // false (Infinity)
console.log(Number.isInteger(0 / 0));     // false (NaN)

console.log(Number.isFinite(42));         // true
console.log(Number.isFinite(1 / 0));      // false
console.log(Number.isFinite(-1 / 0));     // false
console.log(Number.isFinite(0 / 0));      // false
console.log(Number.isFinite(3.14));       // true

console.log(Number.isSafeInteger(42));                 // true
console.log(Number.isSafeInteger(9007199254740991));   // true (2^53 - 1)
console.log(Number.isSafeInteger(9007199254740992));   // false (2^53)
console.log(Number.isSafeInteger(1.5));                // false
console.log(Number.isSafeInteger(1 / 0));              // false

const x: number = 100;
console.log(Number.isInteger(x), Number.isFinite(x), Number.isSafeInteger(x));
