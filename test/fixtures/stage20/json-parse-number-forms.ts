console.log(JSON.parse("-123") as number);
console.log(JSON.parse("1.5") as number);
console.log(JSON.parse("6.02e2") as number);
console.log(JSON.parse("0e+1") as number);
console.log(JSON.parse("1e400") as number);
