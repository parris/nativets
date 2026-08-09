function pick<T>(xs: T[], i: number): T { { const i: number = 0; return xs[i]; } }
console.log(pick<number>([9, 8], 1));
console.log(pick<string>(["a", "b"], 1));
const i: number = 42;
console.log(i);
