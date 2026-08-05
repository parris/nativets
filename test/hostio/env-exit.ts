// Read an env var, then exit with a specific code (the trailing line is dead).
console.log("GREETING=" + process.env.GREETING);
process.exit(7);
console.log("this line never runs");
