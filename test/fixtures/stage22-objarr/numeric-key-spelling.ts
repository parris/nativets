// A NumericLiteral PropertyName is not its source text. ECMA-262 `PropName` of a
// `NumericLiteral` is `ToString(ToNumber(literal))`, so the key is the number's CANONICAL
// spelling — `1e3` names the property `"1000"`, not `"1e3"`.
//
// The canonical spellings (`1`, `0.5`, `42`) round-trip to themselves, which is why every
// test written before this one passed while `1e3`, `1.0` and `0x10` silently kept their
// raw token text as the key.

// Each of these is a DIFFERENT spelling of a key that is not itself.
console.log(JSON.stringify({ 1e3: "x", 1.0: "y", 0x10: "z" }));

// Every numeric-literal form the lexer accepts: exponent (either case), a trailing/leading
// fraction, radix prefixes, and the `_` separator.
console.log(JSON.stringify({ 1E3: "a" }));
console.log(JSON.stringify({ 100.: "b" }));
console.log(JSON.stringify({ 0b101: "c", 0o17: "d", 0X1f: "e" }));
console.log(JSON.stringify({ 1_000: "f" }));
console.log(JSON.stringify({ 1.50: "g" }));

// The canonical spelling is not always shorter, and is not always a decimal integer:
// `Number::toString` switches to exponential at 1e21 and below 1e-6.
console.log(JSON.stringify({ 1e21: "big", 1e-7: "small" }));

// Beyond 2**53 the double is not the digits that were written, and the key is the DOUBLE's
// spelling — the trailing digits change.
console.log(JSON.stringify({ 12345678901234567890: "wide" }));

// Normalization feeds the array-index rule: `1e3` is not an index key by spelling but
// `1000` is, so the key moves to the FRONT of the enumeration. Reading the raw text got
// both the name and the position wrong at once.
const idx = { z: 1, 1e1: 2, 0x2: 3, a: 4 };
console.log(JSON.stringify(Object.keys(idx)));
console.log(JSON.stringify(idx));

// ...and it does NOT make an index of a form whose canonical spelling still is not one:
// `1e-7` and `1.5` name ordinary string keys that keep their insertion position.
console.log(JSON.stringify(Object.keys({ m: 1, 1e-7: 2, 1.5: 3, 0x1: 4 })));

// Two spellings of the SAME key are one property, last value wins — exactly as two copies
// of a string key are. This only collides once the numeric key is normalized.
console.log(JSON.stringify({ 1e3: "first", "1000": "second" }));
console.log(JSON.stringify({ "16": "first", 0x10: "second", 16: "third" }));

// All four enumeration sites read the one canonical order.
const f = { d: 1, 0x3: 2, c: 3, 1e0: 4 };
let acc = "";
for (const k in f) acc += k + ",";
console.log(acc);
console.log(f);
console.log(JSON.stringify(Object.values(f)));

// A normalized key is still a key: reachable by index expression, and by a shorthand-free
// member read where the canonical spelling is an identifier-safe name.
const r = { 1e2: "hundred", 0.5: "half" };
console.log(r["100"], r["0.5"]);
