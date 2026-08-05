// Sum the numbers passed on the command line.
const args = process.argv.slice(2);
let total = 0;
for (const a of args) {
  total = total + Number(a);
}
console.log(total);
