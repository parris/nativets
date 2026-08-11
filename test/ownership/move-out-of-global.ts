// A module-level linear binding is owned by the MODULE scope, which drops it when the
// program ends. A function body only BORROWS it, so handing it out is E0507 — otherwise
// the caller becomes a second owner and the pointer is freed twice.
//
//   const shared = { a: 1 };
//   function getShared() { return shared; }
//   const x = getShared();          // x and shared are both owners
//
// That program compiled clean and aborted in the allocator with NO stdout and NO stderr
// (the abort discards the buffered stream), which is the worst signature available.
const shared = { a: 1 };

function getShared(): { a: number } {
  return shared; //~ ERROR NT1604
}

// The same escape one indirection later: binding the global to a local makes the local an
// owner too, and the FUNCTION drops it at exit — a double free with no `return` involved.
function readShared(): number {
  const t = shared; //~ ERROR NT1604
  return t.a;
}

console.log(getShared().a, readShared());
