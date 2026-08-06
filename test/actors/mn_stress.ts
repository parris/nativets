// v6 STRESS: many actors, many messages, and STRINGS — the case that would expose an
// unsound refcount. Every string message is deep-copied on send into the shared RC side
// table (runtime.c) and released by the receiver, so under M:N two scheduler threads are
// hammering that table concurrently; each record also carries a string field, and the
// workers build arrays past the flat->trie boundary so nt_pvec's node refcounts and the
// Stage-44 transient are exercised from several threads at once.
//
// Asserted: only invariants. Every reply arrives (count), the payload is intact (sum),
// and the string refcount BALANCES back to what it was — a leak or a double free shows up
// here, not as a lucky interleaving.
type Job = { tag: string; n: number };

const worker = (id: number): void => {
  let acc = 0;
  while (true) {
    const j: Job = receive();
    if (j.tag === "stop") {
      send(0, { tag: "done", n: acc });
      return;
    }
    let xs = [0];                      // grow past 32 => persistent trie + transients
    for (let k = 0; k < 40; k = k + 1) {
      xs = [...xs, k];
    }
    acc = acc + j.n + xs.length - 41;
  }
};

const W = 6;
const M = 40;
let pids = [0];
for (let i = 0; i < W; i = i + 1) {
  pids = [...pids, spawn(worker, i)];
}
for (let r = 1; r <= M; r = r + 1) {
  for (let i = 1; i <= W; i = i + 1) {
    send(pids[i], { tag: "work-" + r, n: r });
  }
}
for (let i = 1; i <= W; i = i + 1) {
  send(pids[i], { tag: "stop", n: 0 });
}

let got = 0;
let sum = 0;
while (got < W) {
  const d: Job = receive();
  sum = sum + d.n;
  got = got + 1;
}
console.log("replies=" + got);
console.log("sum=" + sum);
