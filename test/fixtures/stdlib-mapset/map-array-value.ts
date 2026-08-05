// Map<string, number[]>: array values ride the i64 slot as a heap ref.
const m = new Map<string, number[]>();
const m2 = m.set("evens", [2, 4, 6]).set("odds", [1, 3]);
const e = m2.get("evens") ?? [0]; // .get is `number[] | undefined`; ?? narrows the hit
const o = m2.get("odds") ?? [0];
console.log(e[0], e[1], e[2], e.length, o.length, m2.size);
