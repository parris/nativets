// v0 actor: self() yields a distinct pid per actor. main is actor 0; each spawned
// actor gets the next dense pid. Prints 0 (main), then 1 and 2 (the children).
console.log(self());
const b = (x: number) => { console.log(self()); };
spawn(b, 0);
spawn(b, 0);
__drain();
