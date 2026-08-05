// read-keys.ts — exercises the raw single-key input primitive (readKey/rawMode).
//
// Enters raw mode, reads one key at a time until EOF (readKey() returns ""),
// echoing each key on its own line, then leaves raw mode. When stdin is piped
// (not a tty), rawMode is a graceful no-op and readKey degrades to a byte-at-a-
// time read of the shared stdin buffer — so this is deterministic under a piped
// keystroke script and differential-testable against node.
rawMode(true);
let k: string = readKey();
while (k.length > 0) {
  console.log("key=" + k);
  k = readKey();
}
rawMode(false);
console.log("done");
