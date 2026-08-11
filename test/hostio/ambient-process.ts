// Every ambient `process.*` member the NT1028 hint claims we implement, in one program.
//
// This fixture exists to keep that SENTENCE honest. The hint enumerates a surface
// ("the ambient process.argv/process.env/process.platform/process.exit/
// process.stdout.write"), and a diagnostic that advertises a feature we do not actually
// compile is worse than one that says nothing — it sends the reader at a wall. So each
// name it lists is exercised here and differentially checked against node.
console.log("argv=" + process.argv.slice(2).join(","));
console.log("env=" + process.env.GREETING);
const plat: string = process.platform;
console.log("platform-nonempty=" + (plat.length > 0));
process.stdout.write("written-without-newline");
process.stdout.write("\n");
process.exit(3);
