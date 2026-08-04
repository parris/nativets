const obj = { n: 5, arr: [1, 2] };
const s = JSON.stringify(obj);
const back = JSON.parse(s);
console.log(s);
console.log(back.arr[1]);
