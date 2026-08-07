import { one, twice } from "./lib.ts";

async function main(): Promise<void> {
  console.log(await one());
  console.log(await twice(21));
}

await main();
