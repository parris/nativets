// v0 actor: per-sender FIFO. A single sender (main) posts 1,2,3 to one worker,
// which receives and prints them in order — messages from one sender never reorder.
const worker = (x: number) => {
  console.log(receive());
  console.log(receive());
  console.log(receive());
};
const p = spawn(worker, 0);
send(p, 1);
send(p, 2);
send(p, 3);
__drain();
