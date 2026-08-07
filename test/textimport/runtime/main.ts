// THE REAL PAYLOAD: the twelve C files `src/driver.ts` embeds — ~305KB in total, of
// which runtime/runtime.c alone is ~147KB. This is the case the feature exists for, so
// it is tested on the actual bytes rather than on a stand-in.
//
// As in utf8/main.ts, the `.length` lines are the one deliberate difference from the
// oracle (nativets counts UTF-8 bytes, node counts UTF-16 units — docs/divergences.md
// §A.2); every other line, including the verbatim dump of all twelve files, is
// byte-identical source and is therefore node-verified.
import runtimeSource from "../../../runtime/runtime.c" with { type: "text" };
import actorSource from "../../../runtime/nt_actor.c" with { type: "text" };
import actorHeader from "../../../runtime/nt_actor.h" with { type: "text" };
import hamtSource from "../../../runtime/nt_hamt.c" with { type: "text" };
import hamtHeader from "../../../runtime/nt_hamt.h" with { type: "text" };
import mapsetSource from "../../../runtime/nt_mapset.c" with { type: "text" };
import bytesSource from "../../../runtime/nt_bytes.c" with { type: "text" };
import bytesHeader from "../../../runtime/nt_bytes.h" with { type: "text" };
import pvecSource from "../../../runtime/nt_pvec.c" with { type: "text" };
import pvecHeader from "../../../runtime/nt_pvec.h" with { type: "text" };
import httpSource from "../../../runtime/nt_http.c" with { type: "text" };
import guiSource from "../../../runtime/nt_gui.c" with { type: "text" };

const all: string[] = [
  runtimeSource, actorSource, actorHeader, hamtSource, hamtHeader, mapsetSource,
  bytesSource, bytesHeader, pvecSource, pvecHeader, httpSource, guiSource,
];

let total = 0;
for (const s of all) {
  const bytes = new TextEncoder().encode(s);
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (h * 31 + bytes[i]) % 1000000007;
  console.log(s.length, bytes.length, h); // s.length: bytes here, Buffer.byteLength in the oracle
  total = total + bytes.length;
}
console.log(total);

// The C source really is intact — the compiler feeds exactly this text to clang.
console.log(runtimeSource.startsWith("/*"));
console.log(runtimeSource.indexOf("double js_str_len(const char *s)") > 0);

// And every byte of all twelve, verbatim.
for (const s of all) console.log(s);
