import { describeFile } from "./io.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const file = join(dir, "note.txt");
writeFileSync(file, "twelve chars");
console.log(describeFile(file));
console.log(describeFile(join(dir, "absent.txt")));
