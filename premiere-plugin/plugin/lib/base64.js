"use strict";
/* UXP에는 btoa/Buffer가 보장되지 않아서 직접 인코딩합니다. */

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const parts = [];
  let chunk = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < len ? bytes[i + 1] : 0, b2 = i + 2 < len ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    chunk += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] +
      (i + 1 < len ? CHARS[(n >> 6) & 63] : "=") +
      (i + 2 < len ? CHARS[n & 63] : "=");
    if (chunk.length >= 65536) { parts.push(chunk); chunk = ""; }
  }
  parts.push(chunk);
  return parts.join("");
}

module.exports = { encode };
