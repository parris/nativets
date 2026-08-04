console.log(JSON.parse("\"ok\"") as string);
console.log((JSON.parse("\"\"") as string).length);
console.log((JSON.parse("\"a\\nb\"") as string).length);
console.log(JSON.parse("\"a\\u0041b\"") as string);
console.log(JSON.parse("\"x\\ty\"") as string);
