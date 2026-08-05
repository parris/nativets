class MyErr extends Error {
  constructor(m: string) {
    super(m);
  }
}

function boom(): string {
  const e = new MyErr("boom");
  return e.message;
}

const e = new MyErr("kaboom");
console.log(e.message);
console.log(boom());
console.log(e.message.length);
