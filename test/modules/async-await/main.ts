import { fetchOne, bump } from "./lib.ts";

async function main(): Promise<void> {
  console.log(await fetchOne());
  console.log(await bump(41));
}

await main();
