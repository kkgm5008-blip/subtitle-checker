"use strict";
/*
 * 타임라인 그래픽(텍스트 레이어, MOGRT)의 효과 속성 값에서 글자를 꺼냅니다.
 * 프리미어 버전에 따라 값이 MogrtText 객체, 키프레임, JSON 문자열 등으로 오기 때문에
 * 알려진 모양을 차례로 확인하고, 모르는 모양이면 빈 문자열을 돌려줍니다.
 */

const TEXT_KEYS = ["textEditValue", "mText", "text"];
const TEXT_PARAM = /source\s*text|소스\s*텍스트|^text$|^텍스트$/i;

function fromJson(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  for (const k of TEXT_KEYS) {
    if (typeof obj[k] === "string" && obj[k].trim()) return obj[k];
  }
  for (const v of Object.values(obj)) {
    const found = fromJson(v, depth + 1);
    if (found) return found;
  }
  return "";
}

function fromString(s, paramName) {
  const t = s.trim();
  if (!t) return "";
  if (t[0] === "{" || t[0] === "[") {
    try { return fromJson(JSON.parse(t), 0); } catch (e) { return ""; }
  }
  // JSON이 아닌 문자열은 이름이 '텍스트'인 속성일 때만 글자로 봄 (글꼴 이름 등과 구분)
  return TEXT_PARAM.test(String(paramName || "").trim()) ? t : "";
}

/**
 * @param {*} value ComponentParam.getStartValue()가 돌려준 값
 * @param {string} paramName ComponentParam.displayName
 */
function textOfValue(value, paramName) {
  if (value == null) return "";
  if (typeof value === "string") return fromString(value, paramName);
  if (typeof value !== "object") return "";
  if (typeof value.getText === "function") {
    try { return String(value.getText() || "").trim(); } catch (e) { return ""; }
  }
  // Keyframe: { value: { value: ... } }
  if (value.value !== undefined && value.value !== value) return textOfValue(value.value, paramName);
  return "";
}

/** 텍스트 레이어·MOGRT로 보이는 효과인지 (matchName 기준) */
function isTextComponent(matchName) {
  return /ADBE (Text|Capsule)|Graphic|Mogrt|Text/i.test(String(matchName || ""));
}

module.exports = { textOfValue, isTextComponent };
