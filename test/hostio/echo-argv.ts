// Echo the user CLI args (process.argv[2..]) + their count.
const args = process.argv.slice(2);
console.log(args.join(" "));
console.log(args.length);
console.log(process.argv.length);
