/*
 * Hand-written lexer. No `typescript` dependency.
 *
 * Token kinds:
 *   num       numeric literal (raw text)
 *   ident     identifier or keyword
 *   str       string literal (value already unescaped)
 *   template  template literal raw inner text (between backticks); the parser
 *             splits it into quasis + ${} expression sources
 *   punct     operator/punctuator
 *   eof
 */

export type TokenType = "num" | "ident" | "str" | "template" | "punct" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

const PUNCT_4 = [">>>="];
const PUNCT_3 = ["===", "!==", ">>>", "...", "<<=", ">>=", "**="];
const PUNCT_2 = [
  "**", "==", "!=", "<=", ">=", "&&", "||", "??", "?.",
  "++", "--", "+=", "-=", "*=", "/=", "%=", "<<", ">>",
  "&=", "|=", "^=", "=>", "|>",
];
const PUNCT_1 = [
  "(", ")", "{", "}", "[", "]", ",", ";", ".",
  "=", "+", "-", "*", "/", "%", "<", ">", "!", "?", ":",
  "&", "|", "^", "~",
];

export class LexError extends Error {}

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "`": "`", "0": "\0",
};

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") { line++; col = 1; } else { col++; }
      i++;
    }
  };

  while (i < source.length) {
    const c = source[i]!;

    if (c === " " || c === "\t" || c === "\r" || c === "\n") { advance(); continue; }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      advance(2);
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) advance();
      advance(2);
      continue;
    }

    const sl = line, sc = col;

    // number
    if (c >= "0" && c <= "9") {
      let s = "";
      while (i < source.length && source[i]! >= "0" && source[i]! <= "9") { s += source[i]; advance(); }
      if (source[i] === ".") { s += "."; advance(); while (i < source.length && source[i]! >= "0" && source[i]! <= "9") { s += source[i]; advance(); } }
      if (source[i] === "e" || source[i] === "E") {
        s += source[i]; advance();
        if (source[i] === "+" || source[i] === "-") { s += source[i]; advance(); }
        while (i < source.length && source[i]! >= "0" && source[i]! <= "9") { s += source[i]; advance(); }
      }
      tokens.push({ type: "num", value: s, line: sl, col: sc });
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let s = "";
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i]!)) { s += source[i]; advance(); }
      tokens.push({ type: "ident", value: s, line: sl, col: sc });
      continue;
    }

    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      advance();
      let s = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          advance();
          const e = source[i]!;
          if (e === "x") {
            // `\xHH` — two-hex-digit byte escape (e.g. `\x1b` = ESC), as node does.
            advance();
            const h = (source[i] ?? "") + (source[i + 1] ?? "");
            if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new LexError(`Invalid \\x escape at ${line}:${col}`);
            s += String.fromCharCode(parseInt(h, 16));
            advance(); advance();
            continue;
          }
          s += ESCAPES[e] ?? e;
          advance();
        } else {
          if (source[i] === "\n") throw new LexError(`Unterminated string at ${line}:${col}`);
          s += source[i];
          advance();
        }
      }
      if (source[i] !== quote) throw new LexError(`Unterminated string at ${sl}:${sc}`);
      advance(); // closing quote
      tokens.push({ type: "str", value: s, line: sl, col: sc });
      continue;
    }

    // template literal — capture raw inner text (basic: no nested backticks)
    if (c === "`") {
      advance();
      let raw = "";
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") { raw += source[i]; advance(); raw += source[i]; advance(); continue; }
        raw += source[i];
        advance();
      }
      if (source[i] !== "`") throw new LexError(`Unterminated template at ${sl}:${sc}`);
      advance();
      tokens.push({ type: "template", value: raw, line: sl, col: sc });
      continue;
    }

    const four = source.slice(i, i + 4);
    if (PUNCT_4.includes(four)) { tokens.push({ type: "punct", value: four, line: sl, col: sc }); advance(4); continue; }
    const three = source.slice(i, i + 3);
    if (PUNCT_3.includes(three)) { tokens.push({ type: "punct", value: three, line: sl, col: sc }); advance(3); continue; }
    const two = source.slice(i, i + 2);
    if (PUNCT_2.includes(two)) { tokens.push({ type: "punct", value: two, line: sl, col: sc }); advance(2); continue; }
    if (PUNCT_1.includes(c)) { tokens.push({ type: "punct", value: c, line: sl, col: sc }); advance(); continue; }

    throw new LexError(`Unexpected character '${c}' at ${line}:${col}`);
  }

  tokens.push({ type: "eof", value: "", line, col });
  return tokens;
}
