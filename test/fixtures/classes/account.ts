class Account {
  owner: string;
  balance: number;
  vip: boolean;
  constructor(owner: string, balance: number, vip: boolean) {
    this.owner = owner;
    this.balance = balance;
    this.vip = vip;
  }
  canWithdraw(amount: number): boolean {
    return amount <= this.balance;
  }
  describe(): string {
    return this.owner + ": " + this.balance + (this.vip ? " [VIP]" : "");
  }
}

function report(a: Account): string {
  if (a.canWithdraw(100)) {
    return a.owner + " ok";
  }
  return a.owner + " short";
}

let acc = new Account("alice", 250, true);
console.log(acc.describe());
console.log(acc.canWithdraw(100));
console.log(acc.canWithdraw(1000));
console.log(report(acc));

acc = new Account("bob", 50, false);
console.log(acc.describe());
console.log(report(acc));
