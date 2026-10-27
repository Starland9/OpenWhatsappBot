"use strict";
/**
 * Tiny JavaScript lexer for the static lint of test/i18n.test.js (no parser dependency).
 *
 * `scan(source)` returns
 *   - `masked`:   source with comments blanked (same offsets, newlines kept);
 *   - `skeleton`: masked, with the CONTENT of string / template / regex literals blanked too, so that
 *                 brackets, commas and identifiers can be searched without being fooled by text;
 *   - `tokens`:   every string / template literal { start, end, quote, text, nested, hasInterpolation }
 *                 (`text` = the literal's own text; for a template, only the static parts outside `${}`);
 *                 `nested` = the literal sits inside a `${}` of a template.
 */

const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

function scan(src) {
  const n = src.length;
  const skeleton = src.split("");
  const masked = src.split("");
  const tokens = [];
  let i = 0;
  let templateDepth = 0;

  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== "\n") arr[k] = " ";
  };
  const isIdChar = (c) => /[A-Za-z0-9_$]/.test(c);

  function lexString(quote) {
    const start = i;
    i++;
    while (i < n && src[i] !== quote) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "\n") break; // unterminated: stop at the end of the line
      else i++;
    }
    const end = Math.min(i + 1, n);
    tokens.push({
      start,
      end,
      quote,
      text: src.slice(start + 1, Math.max(start + 1, end - 1)),
      nested: templateDepth > 0,
      hasInterpolation: false,
    });
    blank(skeleton, start + 1, end - 1);
    i = end;
  }

  function lexTemplate() {
    const start = i;
    const nested = templateDepth > 0;
    i++;
    let text = "";
    let hasInterpolation = false;
    templateDepth++;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        i++;
        break;
      } else if (c === "$" && src[i + 1] === "{") {
        hasInterpolation = true;
        i += 2;
        lexCode(true);
        i++; // skip the closing }
      } else {
        text += c;
        i++;
      }
    }
    templateDepth--;
    tokens.push({ start, end: i, quote: "`", text, nested, hasInterpolation });
    blank(skeleton, start + 1, i - 1);
  }

  function skipRegex() {
    const start = i;
    i++;
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "\n") {
        i = start + 1; // not a regex after all
        return false;
      } else if (c === "[") {
        inClass = true;
        i++;
      } else if (c === "]") {
        inClass = false;
        i++;
      } else if (c === "/" && !inClass) {
        i++;
        break;
      } else i++;
    }
    while (i < n && /[a-z]/i.test(src[i])) i++;
    blank(skeleton, start + 1, i);
    return true;
  }

  function lexCode(insideInterpolation) {
    let braces = 0;
    let lastSignificant = "";
    let lastWord = "";
    let word = "";
    const endWord = () => {
      if (word) lastWord = word;
      word = "";
    };
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && d === "/") {
        const e = src.indexOf("\n", i);
        const end = e < 0 ? n : e;
        blank(skeleton, i, end);
        blank(masked, i, end);
        i = end;
        continue;
      }
      if (c === "/" && d === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e < 0 ? n : e + 2;
        blank(skeleton, i, end);
        blank(masked, i, end);
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        endWord();
        lexString(c);
        lastSignificant = '"';
        lastWord = "";
        continue;
      }
      if (c === "`") {
        endWord();
        lexTemplate();
        lastSignificant = "`";
        lastWord = "";
        continue;
      }
      if (c === "/") {
        endWord();
        const regexAllowed = REGEX_KEYWORDS.has(lastWord) || (!isIdChar(lastSignificant) && REGEX_PRECEDERS.has(lastSignificant));
        if (regexAllowed && skipRegex()) {
          lastSignificant = "/";
          lastWord = "";
          continue;
        }
        lastSignificant = "/";
        lastWord = "";
        i++;
        continue;
      }
      if (c === "{") braces++;
      else if (c === "}") {
        if (insideInterpolation && braces === 0) return;
        braces--;
      }
      if (/\s/.test(c)) {
        endWord();
      } else if (isIdChar(c)) {
        word += c;
        lastSignificant = c;
      } else {
        endWord();
        lastWord = "";
        lastSignificant = c;
      }
      i++;
    }
  }

  lexCode(false);
  return { masked: masked.join(""), skeleton: skeleton.join(""), tokens };
}

/** Offset -> 1-based line number. */
function lineMap(src) {
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") starts.push(k + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Index of the bracket closing the one at `open` (skeleton text), or -1. */
function matchBracket(skeleton, open) {
  let depth = 0;
  for (let k = open; k < skeleton.length; k++) {
    const c = skeleton[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Split the span (from, to) of the skeleton on top-level commas -> [{ start, end }] (trimmed). */
function splitTopLevel(skeleton, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  const push = (end) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(skeleton[s])) s++;
    while (e > s && /\s/.test(skeleton[e - 1])) e--;
    if (e > s) parts.push({ start: s, end: e });
  };
  for (let k = from; k < to; k++) {
    const c = skeleton[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      push(k);
      start = k + 1;
    }
  }
  push(to);
  return parts;
}

/** End of the property value that starts at `from`: first top-level `,` or closing bracket before `limit`. */
function valueEnd(skeleton, from, limit) {
  let depth = 0;
  for (let k = from; k < limit; k++) {
    const c = skeleton[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return k;
      depth--;
    } else if (c === "," && depth === 0) return k;
  }
  return limit;
}

module.exports = { scan, lineMap, matchBracket, splitTopLevel, valueEnd };
