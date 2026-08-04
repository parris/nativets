// Set of numbers (number elements → double-bitcast key slots, NT_K_NUM tag).
const s = new Set<number>().add(1).add(2).add(2).add(3); // dup 2
console.log(s.has(1), s.has(2), s.has(4), s.size);
