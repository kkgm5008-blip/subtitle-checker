"use strict";
/*
 * 원문과 교정문을 글자 단위로 비교해 바뀐 부분을 찾습니다 (LCS).
 * 띄어쓰기 교정이 잘 보이도록 공백도 하나의 글자로 다룹니다.
 */

const MAX_CELLS = 400000;

function merge(ops) {
  const out = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else out.push({ type: op.type, text: op.text });
  }
  return out;
}

/** [{type: "eq"|"del"|"ins", text}] */
function diffChars(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a === b) return a ? [{ type: "eq", text: a }] : [];
  const A = Array.from(a), B = Array.from(b);
  const n = A.length, m = B.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    return merge([{ type: "del", text: a }, { type: "ins", text: b }]);
  }
  const L = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[at(i, j)] = A[i] === B[j] ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ type: "eq", text: A[i] }); i++; j++; }
    else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) { ops.push({ type: "del", text: A[i] }); i++; }
    else { ops.push({ type: "ins", text: B[j] }); j++; }
  }
  while (i < n) ops.push({ type: "del", text: A[i++] });
  while (j < m) ops.push({ type: "ins", text: B[j++] });
  return merge(ops);
}

module.exports = { diffChars };
