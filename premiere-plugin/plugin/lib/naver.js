"use strict";
/*
 * 네이버 맞춤법 검사기 (무료). 저장소 루트의 spellcheck.py를 옮긴 것입니다.
 * 네이버가 공식 제공하는 오픈 API가 아니라 검색 화면이 쓰는 내부 주소라서,
 * 네이버 쪽 변경으로 막히면 Claude 엔진을 쓰면 됩니다.
 */

const SPELLER_URL = "https://m.search.naver.com/p/csearch/ocontent/util/SpellerProxy";
const PASSPORT_PAGE = "https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=%EB%A7%9E%EC%B6%A4%EB%B2%95%EA%B2%80%EC%82%AC%EA%B8%B0";
const MAX_CHARS = 490;
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  referer: "https://search.naver.com/",
};

let passportKey = null;

class NaverError extends Error {}

function findPassportKey(html) {
  const m = /passportKey=([^&"'}\\\s]+)/.exec(html || "");
  return m ? m[1] : null;
}

/** JSON 또는 JSONP(콜백함수(...)) 응답 */
function parseBody(body) {
  let s = String(body || "").trim();
  if (!s.startsWith("{")) {
    const a = s.indexOf("("), b = s.lastIndexOf(")");
    if (a !== -1 && b > a) s = s.slice(a + 1, b);
  }
  return JSON.parse(s);
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, m => ENTITIES[m]);
}

async function fetchPassportKey(fetchImpl) {
  const res = await fetchImpl(PASSPORT_PAGE, { headers: HEADERS });
  if (!res.ok) throw new NaverError("네이버 검색 페이지를 열지 못했어요");
  return findPassportKey(await res.text());
}

async function request(text, key, fetchImpl) {
  // UXP에 URLSearchParams가 없을 수 있어 직접 만듦
  const params = { where: "nexearch", color_blindness: "0", q: text };
  if (key) params.passportKey = key;
  const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const res = await fetchImpl(`${SPELLER_URL}?${query}`, { headers: HEADERS });
  if (!res.ok) throw new NaverError(`네이버 맞춤법 검사기 응답 오류 (${res.status})`);
  try {
    return parseBody(await res.text());
  } catch (e) {
    throw new NaverError("네이버 맞춤법 검사기 응답을 해석하지 못했어요");
  }
}

function resultOf(data) {
  return data && data.message && data.message.result;
}

/** 짧은 문장 하나(490자 이하)를 검사 */
async function checkText(text, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  if (!text || !text.trim()) return { corrected: text, errorCount: 0 };
  if (text.length > MAX_CHARS) throw new NaverError(`한 번에 ${MAX_CHARS}자까지만 검사할 수 있어요`);
  if (passportKey === null) {
    try { passportKey = await fetchPassportKey(fetchImpl); } catch (e) { passportKey = ""; }
  }
  let result = resultOf(await request(text, passportKey, fetchImpl));
  if (!result) {
    // 키가 만료됐으면 새로 받아서 한 번 더
    passportKey = await fetchPassportKey(fetchImpl);
    result = resultOf(await request(text, passportKey, fetchImpl));
  }
  if (!result) throw new NaverError("네이버 맞춤법 검사기가 예상과 다른 응답을 줬어요. Claude 엔진으로 바꿔 보세요.");
  return { corrected: stripTags(result.html).trim(), errorCount: parseInt(result.errata_count, 10) || 0 };
}

/** 긴 글을 문장 경계 위주로 나눔 */
function splitLongText(text, maxLen = MAX_CHARS) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let buf = "";
  for (const part of text.split(/(?<=[.!?。！？\n])\s+/)) {
    if (buf.length + part.length + 1 > maxLen) {
      if (buf) chunks.push(buf.trim());
      buf = part;
      while (buf.length > maxLen) { chunks.push(buf.slice(0, maxLen)); buf = buf.slice(maxLen); }
    } else buf = (buf + " " + part).trim();
  }
  if (buf) chunks.push(buf.trim());
  return chunks;
}

/** 자막 한 줄을 검사. 여러 줄 자막은 줄마다 검사해서 줄바꿈을 지킴 */
async function checkSegment(text, opts) {
  const lines = String(text).split("\n");
  const out = [];
  let errors = 0;
  for (const line of lines) {
    const parts = [];
    for (const chunk of splitLongText(line)) {
      const r = await checkText(chunk, opts);
      parts.push(r.corrected);
      errors += r.errorCount;
    }
    out.push(parts.join(" "));
  }
  return { corrected: out.join("\n"), errorCount: errors };
}

function resetKey() {
  passportKey = null;
}

module.exports = { NaverError, findPassportKey, parseBody, stripTags, checkText, checkSegment, splitLongText, resetKey };
