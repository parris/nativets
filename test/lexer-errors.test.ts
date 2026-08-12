/*
 * EVERY WAY THE LEXER REFUSES A PROGRAM — pinned by MESSAGE, not just by code.
 *
 * These exist to guard a refactor rather than to describe a feature. `src/lexer.ts` raises
 * eleven `LexError`s, and six of them are in `decodeEscapeAt` — a function called from
 * inside `lex` and again from `parser.ts`'s `buildTemplate`, in neither case inside a
 * `try`. That is `NT1004` (a throw may cross exactly ONE frame, and only when every call
 * site of its function catches), and it is what stops `src/parser.ts` from reaching IR:
 *
 *     error[NT1004]: `throw` that is not inside a `try` in the same function
 *          --> src/lexer.ts:239:5
 *
 * The fix is to FUNNEL — the deep helpers stop throwing and report the failure back, and
 * `lex` raises once, where the throw is legal because `tokenize` already calls `lex`
 * inside a `try`. Rewriting how a module reports failure is exactly the change that can
 * silently drop an error path, turning a refusal into a WRONG ANSWER (an unterminated
 * string that lexes to something, an invalid escape that decodes to garbage). So every
 * path is nailed down first.
 *
 * WHY MESSAGES AND NOT JUST CODES. All eleven surface as `NT0001`, so a code assertion
 * cannot tell "the octal guard still fires" from "some other guard fired instead" — and a
 * funnel that reported one shared message for everything would pass a code-only test
 * completely. The message text and the position are the part that identifies the path.
 *
 * BOTH CARRIERS FOR THE ESCAPE ERRORS. A quoted string reaches `decodeEscapeAt` through
 * `lex`; a template literal reaches the SAME function through `parser.ts`'s
 * `buildTemplate`, which is a different caller in a different module. A funnel that fixes
 * only the lexer's own call site would leave the template path throwing, so the two are
 * tested separately and deliberately.
 */
import { test, expect, describe } from "bun:test";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const B = String.fromCharCode(92);   // a backslash, without writing one in a template
const NL = String.fromCharCode(10);
const BT = String.fromCharCode(96);  // a backtick, likewise

/** The refusal a source earns: its code and the first line of its message. */
function refusal(source: string): { code: string; message: string } {
  try {
    sourceToIR(source);
  } catch (e) {
    if (e instanceof NTError) return { code: e.diag.code, message: e.diag.message.split(NL)[0] };
    throw e;
  }
  throw new Error("expected a refusal, but the source compiled");
}

describe("the lexer's refusals, by message", () => {
  // ---- decodeEscapeAt, reached through a QUOTED STRING (caller: `lex`) --------------
  test("l1. a legacy octal escape", () => {
    const r = refusal('console.log("a' + B + '1b");' + NL);
    expect(r.code).toBe("NT0001");
    expect(r.message).toBe("Octal escape sequences are not allowed at 1:15");
  });

  test("l2. `\\0` followed by a digit is the same production", () => {
    expect(refusal('console.log("a' + B + '01b");' + NL).message).toBe("Octal escape sequences are not allowed at 1:15");
  });

  test("l3. a malformed `\\x` escape", () => {
    expect(refusal('console.log("a' + B + 'xZZb");' + NL).message).toBe("Invalid " + B + "x escape at 1:15");
  });

  test("l4. a malformed `\\u{…}` escape", () => {
    expect(refusal('console.log("a' + B + 'u{ZZ}b");' + NL).message).toBe("Invalid " + B + "u{…} escape at 1:15");
  });

  test("l5. a `\\u{…}` code point above 10FFFF — the message carries the value", () => {
    expect(refusal('console.log("a' + B + 'u{110000}b");' + NL).message)
      .toBe("Invalid " + B + "u{…} escape at 1:15: 110000 is above 10FFFF");
  });

  test("l6. a malformed four-digit `\\u` escape", () => {
    expect(refusal('console.log("a' + B + 'uZZZZb");' + NL).message).toBe("Invalid " + B + "u escape at 1:15");
  });

  // ---- the same function, reached through a TEMPLATE (caller: `buildTemplate`) ------
  test("l7. an octal escape inside a template — the other caller of the same decoder", () => {
    expect(refusal('console.log(' + BT + 'a' + B + '1b' + BT + ');' + NL).message)
      .toBe("Octal escape sequences are not allowed at 1:13");
  });

  test("l8. a malformed `\\x` inside a template", () => {
    expect(refusal('console.log(' + BT + 'a' + B + 'xZZb' + BT + ');' + NL).message)
      .toBe("Invalid " + B + "x escape at 1:13");
  });

  test("l9. a malformed `\\u` inside a template", () => {
    expect(refusal('console.log(' + BT + 'a' + B + 'uZZZZb' + BT + ');' + NL).message)
      .toBe("Invalid " + B + "u escape at 1:13");
  });

  // ---- the scanners' own refusals --------------------------------------------------
  test("l10. an unterminated quoted string", () => {
    expect(refusal('console.log("abc);' + NL).message).toBe("Unterminated string at 1:19");
  });

  test("l11. a newline inside a quoted string is that same refusal, at the newline", () => {
    expect(refusal('console.log("ab' + NL + 'c");' + NL).message).toBe("Unterminated string at 1:16");
  });

  test("l12. an unterminated template", () => {
    expect(refusal('console.log(' + BT + 'abc);' + NL).message).toBe("Unterminated template at 1:13");
  });

  test("l13. a character that starts no token", () => {
    expect(refusal("console.log(1 # 2);" + NL).message).toBe("Unexpected character '#' at 1:15");
  });

  // ---- and the negative: none of this fires on a program that is FINE ---------------
  test("l14. the escapes that are legal still decode — the guard is not a blanket refusal", () => {
    // `A` is `A`, `\x41` is `A`, `\n` is a newline, `\\` is one backslash, and `\8`
    // is the NonOctalDecimalEscapeSequence that stays accepted (docs/divergences.md).
    const ir = sourceToIR('console.log("' + B + 'u0041' + B + 'x41' + B + B + B + '8");' + NL);
    expect(ir.length).toBeGreaterThan(0);
  });
});
