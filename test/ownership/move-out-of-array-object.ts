// Moving an object element out of the array leaves a hole — E0508.
const xs: {x:number}[] = [{x: 1}, {x: 2}];
const first = xs[0]; //~ ERROR NT1605
