// `UpdateExpr` in its NAME form (`x++`/`++x`/`x--`) inside a non-entry module.
//
// `Renamer.expr`'s `UpdateExpr` arm renames `target` only when `targetExpr` is absent —
// the two spellings are different programs (`x++` names a BINDING, `o.f++`/`a[i]++` update
// an expression the walk has already rewritten, and its `target` is not a binding
// reference at all). `state` covers the ASSIGNMENT form (`counter = counter + 1`) and no
// case covered this one, so the condition was untested.
//
// The entry declares its OWN `counter` under the same name. The entry keeps its names and
// the module is mangled, so a missed rename collapses the two cells into one and the
// numbers below diverge from node while both sides still exit 0 — the silent-wrong-answer
// shape `loopvar` records for `ForOfStmt.name2`.
import { bumpTwice, backOne, current } from "./ticker.ts";

let counter = 100;
counter++;
console.log(counter); // 101 — the ENTRY's own cell

console.log(bumpTwice()); // 2   — the module's cell, from 0
console.log(backOne()); // 1
console.log(current()); // 1

console.log(counter); // 101 still: the module never touched this binding
