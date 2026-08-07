// The ONE deliberately-allowed un-awaited async call: the canonical entrypoint as the
// LAST top-level statement. With nothing after it, node's suspend-and-resume and our
// run-it-now produce identical output, so it is not a divergence.
//
// This pins that the exception survived arrows joining the guard: `main` is an async
// ARROW here, so before this lane it was never guarded at all, and after it the
// entrypoint carve-out is the only thing keeping it legal.
const greet = async (who: string): Promise<string> => `hello, ${who}`;

const main = async (): Promise<void> => {
  console.log(await greet("world"));
  console.log(await greet("arrow"));
};

main();
