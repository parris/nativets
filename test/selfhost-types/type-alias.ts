// `type X = ...` aliases: scalar, object shape, and reference to another alias.
type Id = number;
type User = { id: Id; name: string };

function greet(u: User): string {
  return "Hi " + u.name + " (#" + u.id + ")";
}

const u: User = { id: 7, name: "Ada" };
console.log(greet(u));

type Count = Id;
const c: Count = 41;
console.log(c + 1);
