// Generic FUNCTION DEFINITIONS are monomorphized (M3): one specialization per distinct
// type-argument tuple, resolved from explicit call-site type args or inferred from the
// argument types. node runs this unchanged (it just strips the annotations).
function id<T>(x: T): T {
  return x;
}
function first<T>(xs: T[]): T {
  return xs[0];
}
function pair<A, B>(a: A, b: B): string {
  return "(" + a + ", " + b + ")";
}
function mapAll<T, U>(xs: T[], f: (t: T) => U): U[] {
  return xs.map((x) => f(x));
}

// the SAME generic at three different type arguments
console.log(id(41) + 1);
console.log(id("hello") + "!");
console.log(id(true));

// explicit call-site type arguments
console.log(id<string>("pinned"));

// inference through an array parameter
const ns: number[] = [3, 1, 4];
const ws: string[] = ["ab", "cde"];
console.log(first(ns));
console.log(first(ws));

// two type parameters
console.log(pair(1, "x"));
console.log(pair("y", 2));

// generic over a callback, returning a generic-typed array
console.log(mapAll(ns, (n) => n * 2).join(","));
console.log(mapAll(ws, (w) => w.length).join("-"));
