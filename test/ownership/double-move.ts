// Moving twice is a use-after-move (the second move reads an already-moved value).
const a: number[] = [1, 2, 3];
const b = move(a);
const c = move(a); //~ ERROR NT1601
