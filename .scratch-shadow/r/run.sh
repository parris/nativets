#!/bin/zsh
cd "$(dirname "$0")"
for f in *.ts; do
  no=$(node "$f" 2>&1); nec=$?
  ne=$(bun run ../../src/cli.ts run "$f" 2>&1); nte=$?
  no1=$(echo "$no" | tr '\n' '|')
  ne1=$(echo "$ne" | tr '\n' '|')
  if [[ "$no1" == "$ne1" && $nec == $nte ]]; then v="OK  "; else v="DIFF"; fi
  print -r -- "$v $f  node[$nec]=$no1  nts[$nte]=$ne1"
done
