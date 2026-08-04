function greet(name: string): string { return "hi " + name; }
function shout(s: string): string { return s + "!"; }

const m = shout(greet("sam"));
console.log(m);
