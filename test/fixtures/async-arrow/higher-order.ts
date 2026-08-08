// HIGHER-ORDER async — the shapes that are ACCEPTED, and the pin that the new refusals
// do not over-reach into them.
//
// `async` is erased and `await` is an identity pass-through, so an async function value
// is compiled correctly exactly when the promise it returns is awaited on the far side of
// the call. The declared type is what carries "this is an async function" across the call
// boundary that the name-based guard cannot cross: a parameter or return type written
// `(…) => Promise<T>`. Every call below awaits, so every one of them is an ordinary
// sequential call and node agrees byte for byte.
//
// Behaviours borrowed from test262: an async function's result is a promise no matter
// how the function is reached (test/language/statements/async-function/
// evaluation-body-that-returns.js), and an async ARROW behaves identically to an async
// function declaration in that respect (test/language/expressions/async-arrow-function/).

const one = async (): Promise<number> => 1;

// 1. An async arrow reaching a `() => Promise<T>` PARAMETER, awaited there.
async function callit(f: () => Promise<number>): Promise<number> {
  return await f();
}

// 2. The same parameter shape on an ARROW.
const callitArrow = async (f: () => Promise<number>): Promise<number> => await f();

// 3. A PLAIN function passed where an async one is expected. Under node `await` on a
//    non-promise is still fine, so this is legal and prints the same thing.
const plain = (): number => 41;

// 4. An async function handed BACK through a `() => Promise<T>` return type.
function pick(): () => Promise<number> {
  return one;
}

// 5. An ordinary (non-async) higher-order call is untouched by any of this.
function twice(f: () => number): number {
  return f() + f();
}

async function main(): Promise<void> {
  console.log(await callit(one));
  console.log(await callitArrow(one));
  console.log(await callit(plain as () => Promise<number>));
  console.log(await pick()());
  console.log(twice(plain));
}

await main();
