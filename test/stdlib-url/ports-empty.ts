// Ports (non-default kept, default dropped), empty path/query/hash, host lowercasing.
console.log(urlHost("http://example.com:8080/p"));
console.log(urlHost("http://example.com:80/p"));
console.log(urlHost("https://example.com:443/p"));
console.log(urlHostname("https://Example.COM/Path"));
console.log(urlPathname("https://Example.COM/Path"));
console.log(urlPathname("https://example.com"));
console.log("[" + urlSearch("https://example.com") + "]");
console.log("[" + urlHash("https://example.com") + "]");
console.log(urlPathname("https://example.com/?"));
console.log("[" + urlSearch("https://example.com/?") + "]");
console.log("[" + urlHash("https://example.com/#") + "]");
