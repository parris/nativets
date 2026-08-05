// URL functional subset — all components of a full absolute URL.
const u = "https://example.com/path?a=1&b=2#frag";
console.log(urlProtocol(u));
console.log(urlHost(u));
console.log(urlHostname(u));
console.log(urlPathname(u));
console.log(urlSearch(u));
console.log(urlHash(u));
console.log(urlSearchParam(u, "a"));
console.log(urlSearchParam(u, "b"));
