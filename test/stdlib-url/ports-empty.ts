// Ports (non-default kept, default dropped), empty path/query/hash, host lowercasing.
console.log(new URL("http://example.com:8080/p").host);
console.log(new URL("http://example.com:8080/p").port);
console.log(new URL("http://example.com:80/p").host);
console.log(new URL("https://example.com:443/p").host);
console.log("[" + new URL("https://example.com:443/p").port + "]");
console.log(new URL("https://Example.COM/Path").hostname);
console.log(new URL("https://Example.COM/Path").pathname);
console.log(new URL("https://example.com").pathname);
console.log("[" + new URL("https://example.com").search + "]");
console.log("[" + new URL("https://example.com").hash + "]");
console.log(new URL("https://example.com/?").pathname);
console.log("[" + new URL("https://example.com/?").search + "]");
console.log("[" + new URL("https://example.com/#").hash + "]");
