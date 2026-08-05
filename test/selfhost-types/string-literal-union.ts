// String-literal-union types collapse to `string` (parse + type-check literal assignment).
type Direction = "north" | "south" | "east" | "west";

function opposite(d: Direction): Direction {
  if (d === "north") return "south";
  if (d === "south") return "north";
  if (d === "east") return "west";
  return "east";
}

const start: Direction = "north";
console.log(opposite(start));
console.log(opposite("east"));
console.log(start === "north");
