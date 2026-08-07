// `async` is ERASED (see the async/await note in src/parser.ts): an exported
// `async function` is an ordinary exported function whose `await`s are identity.
export async function one(): Promise<number> {
  return 1;
}
