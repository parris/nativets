// A parameter is borrowed (the caller owns it); moving it out is E0507.
function steal(o: {x:number}): {x:number} {
  return move(o); //~ ERROR NT1604
}
