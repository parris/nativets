// Set<number>: number elements (NT_K_NUM tag), dedup + membership.
const s = new Set<number>().add(5).add(10).add(5); // dup 5
console.log(s.has(5), s.has(10), s.has(7), s.size);
