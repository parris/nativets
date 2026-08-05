// ARRAYS AS MESSAGES fall out of the same machinery: the deep-copy walk already handles
// arrays (and arrays of records), and the shape tag distinguishes `number[]` from
// `string[]` from `{id:number,name:string}[]` on the wire.

const worker = (x: number): void => {
  const xs: number[] = receive();
  let t = 0;
  for (const v of xs) { t = t + v; }
  console.log("sum=" + t);

  const names: string[] = receive();
  console.log(names.join("|"));

  const rows: { id: number; name: string }[] = receive();
  for (const r of rows) { console.log(r.id + ":" + r.name); }
};

const w = spawn(worker, 0);
send(w, [1, 2, 3, 4]);
send(w, ["a", "b"]);
send(w, [{ id: 1, name: "one" }, { id: 2, name: "two" }]);
__drain();
