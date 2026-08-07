import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const banner = readFileSync(fileURLToPath(new URL("./data.txt", import.meta.url)), "utf8");

export function fromLib(): string { return banner; }
