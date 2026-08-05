// searchParams.get: percent + '+' decoding; userinfo stripped; missing/valueless keys.
const h = "https://example.com/?x=b+c%20d&e=%2F";
console.log("[" + urlSearch(h) + "]");
console.log(urlSearchParam(h, "x"));
console.log(urlSearchParam(h, "e"));
const i = "https://user:pass@example.com/p?q=1";
console.log(urlHostname(i));
console.log(urlSearchParam(i, "q"));
console.log("[" + urlSearchParam(i, "missing") + "]");
const j = "https://example.com/?flag&k=v";
console.log("[" + urlSearchParam(j, "flag") + "]");
console.log(urlSearchParam(j, "k"));
