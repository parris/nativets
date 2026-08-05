// todo.ts — a tiny IMMUTABLE todo list, driven by argv (Host I/O FFI).
//
// Reads a sequence of commands from the command line and applies them to an
// immutable todo list, then prints the resulting list (id, status, text):
//
//   nativets run examples/todo.ts -- add "buy milk" add "walk dog" done 0 list
//     todos:
//     0. [x] buy milk
//     1. [ ] walk dog
//
// It compiles + runs identically under plain `node` and under nativets
// (byte-for-byte), and cross-compiles to macOS / Linux / iOS / Android
// unchanged (the runtime host layer is libc-only).
//
// Everything here stays inside the *current* nativets immutable subset:
//   - A todo is a structural record `{ id, done, text }`; the list is an
//     array of those records. There are NO classes.
//   - The list is IMMUTABLE. Adding is a functional spread into a reassigned
//     local (`list = [...list, item]`), never `.push`. Completing an item
//     rebuilds the whole list with `.map`, producing a NEW record for every
//     element (`{ ...t, done: ... }`) — never `arr[i] = v` or `o.f = v`.
//   - The list starts genuinely EMPTY: `let list: Todo[] = []` — an empty array
//     literal takes its element type from the annotation (no sentinel record).
//   - Object array elements are LINEAR: you can't bind one to a local
//     (`const t = list[i]` would move it out — NT1605), so `.map` rebuilds
//     the list by copying each record's fields into a fresh record instead.

// A single todo. `id` is a stable integer; `done` is its completion flag;
// `text` is the label.
type Todo = { id: number; done: boolean; text: string };

// Complete the todo whose id === target, returning a brand-new list. Every
// element is rebuilt as a fresh record, so the original list is never mutated
// and no array element is moved out. `.map` currently takes an EXPRESSION-body
// arrow only (a block body `{ return ... }` is NT1003), so the new record is
// the parenthesized object-literal expression `({ ... })`.
function complete(list: Todo[], target: number): Todo[] {
  return list.map((t) => ({ id: t.id, done: t.done || t.id === target, text: t.text }));
}

// --- Apply the argv command stream to an immutable list. ---
//
// Grammar (each token is its own argv entry, so quote multi-word text):
//   add <text>   append a new, not-done todo
//   done <id>    mark the todo with that id complete
//   list         no-op marker (the final list is always printed at the end)
const args: string[] = process.argv.slice(2);

// The annotation supplies the element type of the empty literal.
let list: Todo[] = [];
let nextId: number = 0;

let i: number = 0;
while (i < args.length) {
  const cmd: string = args[i];
  if (cmd === "add" && i + 1 < args.length) {
    list = [...list, { id: nextId, done: false, text: args[i + 1] }];
    nextId = nextId + 1;
    i = i + 2;
  } else if (cmd === "done" && i + 1 < args.length) {
    list = complete(list, parseInt(args[i + 1]));
    i = i + 2;
  } else {
    // "list" or an unrecognized token: skip it. The list is printed below.
    i = i + 1;
  }
}

// --- Print the final list. ---
console.log("todos:");
for (const t of list) {
  const status: string = t.done ? "x" : " ";
  console.log(t.id + ". [" + status + "] " + t.text);
}
