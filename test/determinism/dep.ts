// Every `choosePrefixBase` candidate appears as a literal here, so the alpha-rename
// prefix must ESCALATE past all three preferred bases and land on the counter. That
// escalation is the branch that used to read the clock — see test/determinism.test.ts.
export const bases: string[] = ["_m", "_nt_m", "_nativets_module_"];
export function two(): number { return 2; }
