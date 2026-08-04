function greet(name: string): string { return "hi " + name; }
function shout(s: string): string { return s + "!"; }

const m = "sam" |> greet() |> shout();
console.log(m);
