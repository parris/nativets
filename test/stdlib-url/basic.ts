// URL — all components of a full absolute URL, via the real `new URL(u)` class.
const u = new URL("https://example.com/path?a=1&b=2#frag");
console.log(u.protocol);
console.log(u.host);
console.log(u.hostname);
console.log(u.pathname);
console.log(u.search);
console.log(u.hash);
console.log(u.origin);
console.log(u.searchParams.get("a"));
console.log(u.searchParams.get("b"));
