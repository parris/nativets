// `instanceof` against a class the compiler can name. `src/cli.ts`'s error `guard`
// (`if (e instanceof NTError) …; if (e instanceof BuildError) …`) is the shape that
// mattered. A value's static type IS its exact class here (no user-class inheritance
// beyond `extends Error`, no polymorphic references), so `x instanceof C` is decided
// from the static type — exactly what node computes, just at compile time.

class NTError {
  code: string;
  constructor(code: string) { this.code = code; }
}

class BuildError {
  message: string;
  constructor(message: string) { this.message = message; }
}

function describe(e: NTError): string {
  if (e instanceof NTError) return "diagnostic " + e.code;
  if (e instanceof BuildError) return "build failure";
  return "unknown";
}

function describeBuild(e: BuildError): string {
  if (e instanceof NTError) return "diagnostic";
  if (e instanceof BuildError) return "build failure: " + e.message;
  return "unknown";
}

console.log(describe(new NTError("NT0001")));
console.log(describeBuild(new BuildError("clang exploded")));
console.log(new NTError("x") instanceof NTError, new NTError("x") instanceof BuildError);
console.log(!(new BuildError("y") instanceof NTError));

// The built-in constructors we can decide from a static type.
const xs: number[] = [1, 2, 3];
const bytes = new Uint8Array(2);
const m = new Map<string, number>();
const s = new Set<number>();
console.log(xs instanceof Array, bytes instanceof Array);
console.log(bytes instanceof Uint8Array, xs instanceof Uint8Array);
console.log(m instanceof Map, s instanceof Set, m instanceof Set);

// It composes like any other boolean.
const e = new NTError("NT1606");
console.log(e instanceof NTError && e.code === "NT1606");
console.log(e instanceof BuildError || xs instanceof Array);
