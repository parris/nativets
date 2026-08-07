// An async ARROW that IS awaited stays perfectly legal. The floating-async guard
// tracks arrows by name now, so this is the pin that it does not OVER-reject: every
// call below is awaited, so every one of them is an ordinary sequential call.
const one = async (): Promise<number> => 1;

const twice = async (n: number): Promise<number> => {
  const v = await one();
  return n * 2 + v - 1;
};

// A single-expression arrow body that awaits, and a shorthand-param arrow.
const inc = async (n: number): Promise<number> => (await one()) + n;

async function main(): Promise<void> {
  console.log(await one());
  console.log(await twice(21));
  console.log(await inc(9));
  // An immediately-invoked async arrow is guarded on the callee node, so this is the
  // pin that AWAITING one is still fine.
  console.log(await (async (): Promise<number> => 7)());
  // A direct alias is guarded too — awaited, it stays an ordinary call.
  const alias = one;
  console.log(await alias());
}

await main();
