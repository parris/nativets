// String.fromCharCode / fromCodePoint — number -> char. Retires the \xHH workaround.
console.log(String.fromCharCode(72, 105));            // "Hi"
console.log(String.fromCharCode(65));                 // "A"
console.log(String.fromCharCode());                   // ""
console.log(String.fromCharCode(97, 98, 99, 33));     // "abc!"
console.log(String.fromCharCode(65, 66, 67));         // "ABC"
console.log(String.fromCodePoint(72, 101, 108, 108, 111)); // "Hello"
console.log(String.fromCharCode(233));                // "é" (Latin-1, UTF-8 output)
console.log(String.fromCodePoint(128512));            // "😀" (U+1F600, 4-byte UTF-8)
const n: number = 66;
console.log(String.fromCharCode(n, n + 1));           // "BC"
console.log(String.fromCharCode(9731));               // "☃" snowman (matches node's UTF-8 bytes)
