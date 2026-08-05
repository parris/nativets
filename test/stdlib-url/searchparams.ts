// searchParams: percent + '+' decoding; userinfo stripped; missing/valueless keys.
const h = new URL("https://example.com/?x=b+c%20d&e=%2F");
console.log("[" + h.search + "]");
console.log(h.searchParams.get("x"));
console.log(h.searchParams.get("e"));
const i = new URL("https://user:pass@example.com/p?q=1");
console.log(i.hostname);
console.log(i.searchParams.get("q"));
console.log("[" + (i.searchParams.get("missing") ?? "") + "]");
console.log(i.searchParams.has("missing"));
const j = new URL("https://example.com/?flag&k=v");
console.log("[" + (j.searchParams.get("flag") ?? "") + "]");
console.log(j.searchParams.get("k"));
