const fs = require("fs");
const s = fs.readFileSync("./plugins/truthdare.js", "utf8");
const findArray = (startToken, arrName) => {
  const idx = s.indexOf(startToken);
  if (idx === -1) return null;
  const start = s.indexOf(arrName, idx);
  if (start === -1) return null;
  const open = s.indexOf("[", start);
  let depth = 1;
  let i = open + 1;
  for (; i < s.length; i++) {
    if (s[i] == "[") depth++;
    else if (s[i] == "]") {
      depth--;
      if (depth == 0) break;
    }
  }
  return s.slice(open + 1, i);
};
const modes = ["mild", "flirty", "romantic", "adult"];

modes.forEach((m) => {
  const startToken = m + ": {";
  const truthArr = findArray(startToken, "truth");
  const dareArr = findArray(startToken, "dare");
  const truthCount = truthArr ? (truthArr.match(/"(.*?)"/g) || []).length : 0;
  const dareCount = dareArr ? (dareArr.match(/"(.*?)"/g) || []).length : 0;
  console.log(m, " truth=", truthCount, " dare=", dareCount);
});
