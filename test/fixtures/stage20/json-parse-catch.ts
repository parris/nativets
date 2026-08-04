function p(s: string): string {
  try { JSON.parse(s); return "OK"; } catch (e) { return "THROW"; }
}
console.log(p("{bad json"));
console.log(p("42"));
