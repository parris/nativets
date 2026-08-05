const items: number[] = [];
const meta = {};
const o = { items, meta, n: 3 };
console.log(JSON.stringify(o, null, 2));
const emptyArr: string[] = [];
console.log(JSON.stringify(emptyArr, null, 2));
const emptyObj = {};
console.log(JSON.stringify(emptyObj, null, 2));
