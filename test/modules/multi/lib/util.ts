import { PREFIX, stars } from "./shared.ts";

console.log("[util] init");

export function banner(title: string): string {
  return PREFIX + title + " " + stars(3);
}

export function double(n: number): number {
  return n * 2;
}

export function triple(n: number): number {
  return n * 3;
}
