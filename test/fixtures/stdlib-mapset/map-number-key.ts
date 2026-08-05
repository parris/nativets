// Map<number,number>: number keys (double-bitcast slot, NT_K_NUM tag).
const m = new Map<number, number>();
const m2 = m.set(1, 100).set(2, 200).set(1, 111); // overwrite key 1
console.log(m2.get(1), m2.get(2), m2.has(3), m2.size);
