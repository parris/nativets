// process.platform — the host FFI value node reports for the machine it runs on.
//
// This is a REAL differential: on a macOS box both sides must print `darwin`, on a
// Linux runner both must print `linux`. Nothing here is hardcoded to one platform, so
// the test is the same assertion everywhere and CI checks the other branch for free.
const p: string = process.platform;
console.log(p);
console.log(p.length > 0);
// The value is one of node's documented spellings, not an invented one.
console.log(p === "darwin" || p === "linux" || p === "win32");
// It is a plain string, so ordinary string operations apply to it.
console.log(p.toUpperCase());
console.log(`platform=${p}`);
