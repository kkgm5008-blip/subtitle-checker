"use strict";
/* UXP 저장소: 설정, API 키(보안 저장소), 파일 열기/저장, 외부 링크 */

const uxp = () => require("uxp");

const PREFS_KEY = "subtitle-checker.prefs";
const API_KEY_NAME = "subtitle-checker.anthropic-api-key";

function utf8Decode(bytes) {
  let out = "", i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

function loadPrefs(defaults) {
  try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); }
  catch (e) { return Object.assign({}, defaults); }
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 저장 실패해도 이번 세션은 동작 */ }
}

async function loadApiKey() {
  try {
    const bytes = await uxp().storage.secureStorage.getItem(API_KEY_NAME);
    if (bytes && bytes.length) return utf8Decode(bytes).trim();
  } catch (e) { /* 보안 저장소에 없음 */ }
  try { return (localStorage.getItem(API_KEY_NAME) || "").trim(); } catch (e) { return ""; }
}

/** 보안 저장소에 저장. 안 되면 이 컴퓨터의 플러그인 저장소에 저장 */
async function saveApiKey(key) {
  try {
    const ss = uxp().storage.secureStorage;
    if (key) await ss.setItem(API_KEY_NAME, key);
    else await ss.removeItem(API_KEY_NAME).catch(() => {});
    try { localStorage.removeItem(API_KEY_NAME); } catch (e) { /* 없음 */ }
    return "secure";
  } catch (e) {
    try {
      if (key) localStorage.setItem(API_KEY_NAME, key);
      else localStorage.removeItem(API_KEY_NAME);
    } catch (e2) { /* 저장 불가 */ }
    return "local";
  }
}

async function openTextFile(types) {
  const file = await uxp().storage.localFileSystem.getFileForOpening({ types });
  if (!file) return null;
  return { name: file.name, text: await file.read() };
}

async function saveTextFile(suggestedName, text, types) {
  const file = await uxp().storage.localFileSystem.getFileForSaving(suggestedName, { types });
  if (!file) return false;
  await file.write(text);
  return true;
}

async function openExternal(url) {
  try { await uxp().shell.openExternal(url, "브라우저에서 페이지를 엽니다"); return true; }
  catch (e) { return false; }
}

/** 프리미어 버전과 플러그인 버전 (자가 진단용) */
async function environment() {
  let app = "", plugin = "";
  try { const h = uxp().host; app = `${h.name || ""} ${h.version || ""}`.trim(); } catch (e) { /* 알 수 없음 */ }
  try {
    const folder = await uxp().storage.localFileSystem.getPluginFolder();
    plugin = JSON.parse(await (await folder.getEntry("manifest.json")).read()).version || "";
  } catch (e) { /* 알 수 없음 */ }
  return { app: app || "알 수 없음", plugin: plugin || "알 수 없음" };
}

module.exports = { utf8Decode, loadPrefs, savePrefs, loadApiKey, saveApiKey, openTextFile, saveTextFile, openExternal, environment };
