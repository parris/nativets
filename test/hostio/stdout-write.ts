// `process.stdout.write(s)` — bytes to stdout with NO trailing newline, which is
// what a compiler's `emit` path needs (src/cli.ts writes the whole .ll this way).
// Interleaved with console.log to pin ordering through one shared buffer, and the
// final write has no newline at all so the flush-at-exit path is covered too.
process.stdout.write("a");
process.stdout.write("bc");
console.log("|end");
process.stdout.write("no trailing newline");
