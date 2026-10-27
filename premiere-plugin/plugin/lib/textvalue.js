"use strict";
/*
 * 타임라인 그래픽(텍스트 레이어, MOGRT)에서 글자를 꺼냅니다.
 *
 * 프리미어 25.6~26.x의 UXP는 텍스트 레이어의 '소스 텍스트' 값을 빈 값으로 돌려주는 일이 많아서
 * (Adobe 포럼에 같은 문제 보고가 있음) 다음 순서로 시도합니다.
 * 1. 효과 속성 값: MogrtText 객체, 키프레임, JSON 문자열(앞에 이진 머리말이 붙기도 함)
 * 2. 효과 이름: 효과 컨트롤 패널의 "텍스트(안녕하세요)"처럼 괄호 안에 적힌 레이어 이름
 * 3. 클립 이름: 타임라인 클립에 보이는 이름 ("그래픽" 같은 기본 이름은 뺌)
 * 2와 3은 실제 화면 글자와 다를 수 있어서, 화면을 보고 다시 읽는 기능(ocr.js)을 따로 둡니다.
 */

const TEXT_KEYS = ["textEditValue", "mText", "text"];
const TEXT_PARAM = /source\s*text|소스\s*텍스트|^text$|^텍스트$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g;

const clean = s => String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();

function fromJson(obj, depth) {
  if (!obj || typeof obj !== "object" || depth > 6) return "";
  for (const k of TEXT_KEYS) {
    if (typeof obj[k] === "string" && clean(obj[k])) return clean(obj[k]);
  }
  for (const v of Object.values(obj)) {
    const found = fromJson(v, depth + 1);
    if (found) return found;
  }
  return "";
}

/** JSON이 깨졌거나 잘려 있어도 "textEditValue":"..." 부분만 꺼냄 */
function fromJsonFragment(s) {
  for (const k of TEXT_KEYS) {
    const m = new RegExp(`"${k}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(s);
    if (!m) continue;
    try {
      const t = clean(JSON.parse(m[1]));
      if (t) return t;
    } catch (e) { /* 다음 키 */ }
  }
  return "";
}

function fromString(s, paramName) {
  const t = clean(s);
  if (!t) return "";
  const a = t.search(/[{[]/);
  if (a !== -1 && /"(textEditValue|mText|text)"/.test(t)) {
    const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (b > a) {
      try { return fromJson(JSON.parse(t.slice(a, b + 1)), 0); } catch (e) { /* 아래 */ }
    }
    return fromJsonFragment(t);
  }
  if (t[0] === "{" || t[0] === "[") {
    let parsed = null;
    try { parsed = JSON.parse(t); } catch (e) { /* JSON이 아님: "{웃음} 진짜?" 같은 자막일 수 있음 */ }
    if (parsed && typeof parsed === "object") return fromJson(parsed, 0);
  }
  // JSON이 아닌 문자열은 이름이 '텍스트'인 속성일 때만 글자로 봄 (글꼴 이름 등과 구분)
  return TEXT_PARAM.test(String(paramName || "").trim()) ? t : "";
}

/**
 * @param {*} value ComponentParam.getStartValue()나 getValueAtTime()이 돌려준 값
 * @param {string} paramName ComponentParam.displayName
 */
function textOfValue(value, paramName) {
  if (value == null) return "";
  if (typeof value === "string") return fromString(value, paramName);
  if (typeof value !== "object") return "";
  if (typeof value.getText === "function") {
    try { return clean(value.getText()); } catch (e) { return ""; }
  }
  // Keyframe: { value: { value: ... } }
  if (value.value !== undefined && value.value !== value) return textOfValue(value.value, paramName);
  return "";
}

/** 텍스트 레이어·MOGRT로 보이는 효과인지 (matchName 기준) */
function isTextComponent(matchName) {
  return /ADBE (Text|Capsule)|Graphic|Mogrt|Text/i.test(String(matchName || ""));
}

/** 효과 이름 "텍스트(안녕하세요)", "Text (Hello)"에서 괄호 안 레이어 이름 */
function textOfComponentName(displayName) {
  const m = /^\s*(?:텍스트|text|그래픽|graphic|모션 그래픽 템플릿|motion graphics template)\s*[(（]([\s\S]+)[)）]\s*$/i.exec(String(displayName || ""));
  if (!m) return "";
  const t = clean(m[1]);
  return isGenericName(t) ? "" : t;
}

const GENERIC = /^(그래픽|graphic|graphics|텍스트|text|새 텍스트 레이어|new text layer|제목|title|모양|shape|사각형|rectangle|타원|ellipse|클립|clip|자막|caption|captions|subtitle|모션 그래픽 템플릿|motion graphics template)(\s*[\d(（][\d\s)）]*)?$/i;

/** "그래픽", "Text 2"처럼 프리미어가 붙인 기본 이름이거나 파일 이름인지 */
function isGenericName(name) {
  const t = clean(name);
  if (!t) return true;
  if (GENERIC.test(t)) return true;
  return /\.(mogrt|prgraphic|aegraphic|png|jpe?g|psd|ai|svg|gif|mov|mp4|mxf)$/i.test(t);
}

/** 타임라인 클립 이름에서 글자 (기본 이름이면 빈 문자열) */
function textOfClipName(name) {
  return isGenericName(name) ? "" : clean(name);
}

module.exports = { textOfValue, isTextComponent, textOfComponentName, textOfClipName, isGenericName, clean };
