"use strict";
/* 패널 화면: 맞춤법 / AI 컨펌 / 설정 */

const srt = require("./lib/srt.js");
const { diffChars } = require("./lib/diff.js");
const base64 = require("./lib/base64.js");
const claude = require("./lib/claude.js");
const naver = require("./lib/naver.js");
const report = require("./lib/report.js");
const sampling = require("./lib/sampling.js");
const pr = require("./lib/premiere.js");
const host = require("./lib/host.js");
const bridge = require("./lib/bridge.js");
const ocr = require("./lib/ocr.js");

const DEFAULTS = {
  mode: "subscription", model: claude.DEFAULT_MODEL, engine: "claude", longEdge: 1280,
  range: "all", interval: 3, maxFrames: 40, perSegment: false, withSubs: true, focus: "all", brief: "",
  channel: { about: "", audience: "", tone: "" },
};
const MAX_PAYLOAD = 24 * 1024 * 1024; // base64 이미지 합계 (API 요청 한도 32MB 아래로)
// 화면 받아 적기: Claude 요청 한 번에 보내는 장면 수 (구독 모드는 묶음마다 Claude Code를 새로 띄우므로 크게)
const OCR_BATCH = { subscription: 30, api: 20 };
const OCR_EDGE = 1280; // 화면 받아 적기 프레임 긴 변 (자막 글씨가 읽히는 크기)
const ENGINE_LABEL = { subscription: "Claude (문맥까지 보고 고침 · 내 구독 사용량, 추가 비용 없음)", api: "Claude (문맥까지 보고 고침 · API 요금)" };
const SEVERITY_CLASS = { 필수: "must", 권장: "should", 참고: "info" };
const VERDICT_CLASS = { 컨펌: "ok", "수정 후 컨펌": "fix", "재작업 필요": "redo" };
const VERDICT_ICON = { 컨펌: "✅", "수정 후 컨펌": "⚠️", "재작업 필요": "⛔" };

const state = {
  prefs: Object.assign({}, DEFAULTS),
  apiKey: "",
  seq: null, // sequenceInfo
  segments: [], // {id, index, start, end, text}
  source: "",
  spell: null, // {rows, engine, source, cost}
  review: null,
  reviewMeta: null,
  thumbs: [],
  busy: false,
  cancel: false,
};

/* ───────── 공용 ───────── */

const $ = id => document.getElementById(id);
const all = sel => Array.prototype.slice.call(document.querySelectorAll(sel));
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const show = (id, on) => { $(id).style.display = on ? "" : "none"; };
const dollars = d => (d < 0.01 ? "$0.01 미만" : "$" + d.toFixed(2));

function say(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function savePrefs() {
  host.savePrefs(state.prefs);
}

/** 예상하지 못한 오류를 패널 위쪽에 그대로 보여 줌 (사용자가 읽어 주면 원인을 바로 찾을 수 있게) */
function reportError(where, e) {
  const msg = (e && (e.message || e.reason)) || String(e);
  try {
    const box = $("errorBox");
    box.textContent = `⚠ ${where}: ${msg}\n이 문구를 그대로 알려 주세요.`;
    box.style.display = "";
  } catch (x) { /* 화면도 못 그리면 콘솔에만 */ }
  try { console.error(where, e); } catch (x) { /* 콘솔 없음 */ }
}

/** select의 선택지를 새로 채움 (innerHTML 대신 요소를 만들어서) */
function setOptions(select, options, value) {
  while (select.firstChild) select.removeChild(select.firstChild);
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.setAttribute("value", v);
    o.textContent = label;
    if (String(v) === String(value)) o.setAttribute("selected", "");
    select.appendChild(o);
  }
  try { select.value = String(value); } catch (e) { /* selected 속성으로 충분 */ }
}

/** el에서 부모로 올라가며 attr이 있는 요소를 찾음 (UXP에 closest가 없을 수 있음) */
function withAttr(el, attr, stop) {
  while (el && el !== stop) {
    if (el.getAttribute && el.getAttribute(attr) != null) return el;
    el = el.parentNode;
  }
  return null;
}

function setBusy(on, cancelId) {
  state.busy = on;
  state.cancel = false;
  all("button").forEach(b => {
    if (/\btab\b/.test(b.className) || b.id === cancelId) return;
    b.disabled = on;
  });
  if (cancelId) show(cancelId, on);
}

/** "subscription": PC의 Claude Code(내 구독), "api": API 키 */
const subscription = () => state.prefs.mode === "subscription";

function needKey(msgId) {
  if (subscription() || state.apiKey) return false;
  say(msgId, "설정 탭에서 Anthropic API 키를 먼저 저장해 주세요.", "err");
  return true;
}

function showTab(name) {
  all(".tab").forEach(b => { b.className = "tab" + (b.getAttribute("data-tab") === name ? " on" : ""); });
  ["spell", "confirm", "settings"].forEach(t => show("pane-" + t, t === name));
  if (name === "confirm") updateEstimate();
}

function updateKeyNotice() {
  const needs = !subscription() && !state.apiKey && (state.prefs.engine === "claude");
  show("keyNotice", needs);
}

function updateModeUI() {
  show("subBox", subscription());
  show("apiBox", !subscription());
  const engine = $("engine").value || state.prefs.engine;
  setOptions($("engine"), [["claude", ENGINE_LABEL[state.prefs.mode] || ENGINE_LABEL.api], ["naver", "네이버 맞춤법 검사기 (무료 · 막힐 수 있음)"]], engine);
  updateKeyNotice();
  updateEstimate();
}

async function refreshSequence() {
  try {
    const { sequence } = await pr.getActive();
    state.seq = await pr.sequenceInfo(sequence);
    const s = state.seq;
    $("seqLine").textContent = `시퀀스: ${s.name} · ${srt.formatClock(s.end)}${s.hasInOut ? ` · 인/아웃 ${srt.formatClock(s.inPoint)}~${srt.formatClock(s.outPoint)}` : ""}`;
  } catch (e) {
    state.seq = null;
    $("seqLine").textContent = e.message;
  }
  updateEstimate();
}

async function seekTo(seconds) {
  try {
    const { sequence } = await pr.getActive();
    await pr.seek(sequence, seconds);
  } catch (e) { /* 시퀀스가 닫혔으면 무시 */ }
}

/* ───────── 자막 불러오기 ───────── */

function setSegments(list, source) {
  state.segments = list.map((s, i) => Object.assign({}, s, { id: i + 1 }));
  state.source = source;
  state.spell = null;
  show("spellResult", false);
  const timed = state.segments.some(s => s.start != null);
  $("sourceLine").textContent = `${source} · ${state.segments.length}개${timed ? "" : " (타임코드 없음)"}`;
  $("perSegment").disabled = !timed;
  if (!timed) $("perSegment").checked = false;
  say("spellMsg", "");
  updateEstimate();
}

const VIA_ORDER = ["값", "레이어 이름", "클립 이름", "화면"];

function viaSummary(list) {
  const n = {};
  list.forEach(c => { n[c.via] = (n[c.via] || 0) + 1; });
  return VIA_ORDER.filter(v => n[v]).map(v => `${v === "값" ? "그래픽 값" : v} ${n[v]}`).join(" · ");
}

const NO_GRAPHICS = "타임라인에서 텍스트 그래픽 클립을 찾지 못했어요. 캡션 자막이면 텍스트 패널 ··· 메뉴의 'SRT 파일로 내보내기'로 저장한 뒤 '자막 파일 열기'를 쓰세요. 그래픽인데도 안 보이면 설정 → 자가 진단 결과를 보내 주세요.";

const clipSegment = c => ({ index: c.index, start: c.start, end: c.end, text: c.text, track: c.track, via: c.via });

async function scanClips(sequence) {
  const scan = await pr.scanTextClips(sequence, { onProgress: (t, n, clips) => say("readMsg", `그래픽 클립 찾는 중… 트랙 ${t}/${n} · 클립 ${clips}개 살펴봄`) });
  return scan.clips;
}

/** 클립 중 targets의 글자를 화면을 보고 받아 적음. 바쁨 표시는 부른 쪽에서 */
async function screenRead(sequence, clips, targets) {
  await refreshSequence();
  if (!state.seq) throw new Error("열려 있는 시퀀스가 없어요.");
  const shots = ocr.planShots(clips, targets);
  const size = sampling.frameSize(state.seq.width, state.seq.height, Math.min(OCR_EDGE, state.prefs.longEdge));
  const raw = await pr.exportFrames(sequence, shots.map(s => s.time), size, {
    onProgress: (i, n) => say("readMsg", `자막 장면 뽑는 중… ${i}/${n}`),
    isCancelled: () => state.cancel,
  });
  const frames = raw.map(f => ({ time: f.time, mediaType: f.mediaType, data: base64.encode(f.bytes) }));
  const blocks = [];
  let failed = 0, cost = 0;
  const per = OCR_BATCH[state.prefs.mode] || OCR_BATCH.api;
  for (let b = 0; b < frames.length; b += per) {
    if (state.cancel) throw new Error("취소했어요.");
    const part = frames.slice(b, b + per);
    say("readMsg", `${subscription() ? "Claude Code(내 구독)가" : "Claude가"} 화면 글자를 받아 적는 중… ${b + part.length}/${frames.length}장`);
    try {
      const res = await claude.readScreenText({ mode: state.prefs.mode, apiKey: state.apiKey, model: state.prefs.model, shots: part });
      blocks.push(...res.blocks);
      if (res.cost) cost += res.cost.dollars;
    } catch (e) {
      if ([401, 403, 404].includes(e.status) || (e.name === "BridgeError" && e.code !== "bad_json")) throw e;
      part.forEach(() => blocks.push([]));
      failed += part.length;
    }
  }
  const known = clips.map((c, i) => ({ start: c.start, end: c.end, known: targets.includes(i) ? "" : c.text }));
  const texts = ocr.assignBlocks(known, shots, blocks);
  const read = targets.filter(i => texts[i]).length;
  const out = clips.map((c, i) => (targets.includes(i) && texts[i] ? Object.assign({}, c, { text: texts[i], via: "화면" }) : c));
  return { clips: out, read, failed, cost };
}

function finishRead(clips, note, kind) {
  const list = clips.filter(c => c.text);
  if (list.length) setSegments(list.map(clipSegment), `타임라인 그래픽 (${state.seq ? state.seq.name : "시퀀스"}) · ${viaSummary(list)}`);
  say("readMsg", note, kind || (list.length ? "ok" : "err"));
}

async function readTimeline() {
  if (state.busy) return;
  setBusy(true, "btnReadCancel");
  say("readMsg", "타임라인의 그래픽 클립을 읽는 중…");
  try {
    const { sequence } = await pr.getActive();
    let clips = await scanClips(sequence);
    if (!clips.length) { say("readMsg", NO_GRAPHICS, "err"); return; }
    const missing = clips.map((c, i) => i).filter(i => !clips[i].text);
    const named = clips.filter(c => c.text && c.via !== "값").length;
    let note = `그래픽 ${clips.length}개 중 ${clips.length - missing.length}개의 글자를 읽었어요.`;
    if (missing.length && subscription()) {
      // 구독 모드는 추가 비용이 없으니 못 읽은 클립은 바로 화면을 보고 받아 적음
      say("readMsg", `${missing.length}개는 프리미어가 글자를 알려 주지 않아서 화면을 보고 받아 적을게요…`);
      try {
        const r = await screenRead(sequence, clips, missing);
        clips = r.clips;
        note = `그래픽 ${clips.length}개 중 ${clips.filter(c => c.text).length}개의 글자를 읽었어요 (화면에서 받아 적음 ${r.read}개).` +
          (r.failed ? ` ${r.failed}장은 받아 적지 못했어요. '화면 보고 받아 적기'를 다시 눌러 보세요.` : "") +
          (missing.length - r.read > r.failed ? " 글자가 안 보이는 그래픽은 뺐어요." : "");
      } catch (e) {
        // 받아 적기가 안 돼도 이름에서 읽은 것은 살림
        finishRead(clips, `${note} 나머지 ${missing.length}개는 화면에서 받아 적지 못했어요: ${e.message}`, "err");
        return;
      }
    } else if (missing.length) {
      note += ` ${missing.length}개는 프리미어가 글자를 알려 주지 않아요. '화면 보고 받아 적기'를 누르면 Claude가 화면을 보고 읽어요.`;
    }
    if (named) note += " 레이어·클립 이름에서 읽은 글자는 실제 화면과 다를 수 있어요. 정확하게 하려면 '화면 보고 받아 적기'를 누르세요.";
    finishRead(clips, note);
  } catch (e) {
    say("readMsg", e.message, "err");
  } finally {
    setBusy(false, "btnReadCancel");
  }
}

/** 프리미어가 정확한 글자를 준 클립만 빼고 모두 화면을 보고 받아 적음 */
async function readScreen() {
  if (state.busy) return;
  if (needKey("readMsg")) return;
  setBusy(true, "btnReadCancel");
  say("readMsg", "타임라인의 그래픽 클립을 찾는 중…");
  try {
    const { sequence } = await pr.getActive();
    const clips = await scanClips(sequence);
    if (!clips.length) { say("readMsg", NO_GRAPHICS, "err"); return; }
    const targets = clips.map((c, i) => i).filter(i => clips[i].via !== "값");
    if (!targets.length) { finishRead(clips, `그래픽 ${clips.length}개의 글자를 프리미어에서 정확히 읽었어요. 화면을 볼 필요가 없어요.`); return; }
    const r = await screenRead(sequence, clips, targets);
    finishRead(r.clips, `화면을 보고 ${r.read}개를 받아 적었어요 (그래픽 ${clips.length}개).` +
      (r.failed ? ` ${r.failed}장은 받아 적지 못해서 이름에서 읽은 글자를 썼어요.` : "") +
      (r.cost ? ` 비용 약 ${dollars(r.cost)}.` : ""));
  } catch (e) {
    say("readMsg", e.message, "err");
  } finally {
    setBusy(false, "btnReadCancel");
  }
}

async function openFile() {
  try {
    const file = await host.openTextFile(["srt", "vtt", "txt"]);
    if (!file) return;
    const list = srt.parseSubtitleFile(file.name, file.text);
    if (!list.length) { say("readMsg", "파일에서 자막을 찾지 못했어요. 내용을 확인해 주세요.", "err"); return; }
    setSegments(list, file.name);
    if (srt.looksGarbled(file.text)) say("readMsg", "글자가 깨져 보여요. 파일을 UTF-8로 다시 저장해서 열어 주세요.", "err");
    else say("readMsg", `${list.length}개 자막을 불러왔어요.`, "ok");
  } catch (e) {
    say("readMsg", e.message, "err");
  }
}

/* ───────── 맞춤법 검사 ───────── */

async function runSpell() {
  if (state.busy) return;
  if (!state.segments.length) { say("spellMsg", "먼저 자막을 불러와 주세요.", "err"); return; }
  const engine = $("engine").value;
  if (engine === "claude" && needKey("spellMsg")) return;
  const rows = state.segments.map(seg => ({ seg, corrected: seg.text, issues: [], error: null, ignored: false }));
  const byId = new Map(rows.map(r => [r.seg.id, r]));
  let cost = 0;
  setBusy(true, "btnSpellCancel");
  try {
    if (engine === "claude") {
      const list = state.segments.map(s => ({ id: s.id, start: s.start, text: s.text }));
      // 구독 모드는 묶음마다 Claude Code를 새로 띄우므로 크게 묶음
      const batches = subscription() ? claude.batchSegments(list, 20000, 250) : claude.batchSegments(list);
      for (let b = 0; b < batches.length; b++) {
        if (state.cancel) break;
        say("spellMsg", `${subscription() ? "Claude Code(내 구독)로" : "Claude가"} 검사 중… ${b + 1}/${batches.length}묶음`);
        try {
          const res = await claude.checkSpelling({ mode: state.prefs.mode, apiKey: state.apiKey, model: state.prefs.model, batch: batches[b] });
          res.fixes.forEach((fix, id) => Object.assign(byId.get(id), fix));
          if (res.cost) cost += res.cost.dollars;
        } catch (e) {
          // 키·연결 문제는 다음 묶음도 똑같이 실패하므로 바로 멈춤
          if ([401, 403, 404].includes(e.status) || (e.name === "BridgeError" && e.code !== "bad_json")) throw e;
          batches[b].forEach(s => (byId.get(s.id).error = e.message));
        }
      }
    } else {
      naver.resetKey();
      for (let i = 0; i < rows.length; i++) {
        if (state.cancel) break;
        say("spellMsg", `네이버 검사기로 검사 중… ${i + 1}/${rows.length}`);
        const r = rows[i];
        try {
          const res = await naver.checkSegment(r.seg.text);
          r.corrected = res.corrected || r.seg.text;
        } catch (e) {
          r.error = e.message;
        }
        await new Promise(ok => setTimeout(ok, 150)); // 너무 빠른 연속 호출 방지
      }
    }
    const label = claude.MODELS[state.prefs.model].label.split(" (")[0] + (subscription() ? " · 내 구독" : " · API");
    state.spell = { rows, engine: engine === "claude" ? label : "네이버 맞춤법 검사기", source: state.source, cost };
    const failed = rows.filter(r => r.error).length;
    say("spellMsg", (state.cancel ? "중간에 멈췄어요. " : "검사를 마쳤어요. ") + (failed ? `${failed}개 자막은 검사하지 못했어요.` : ""), failed ? "err" : "ok");
    renderSpell();
  } catch (e) {
    say("spellMsg", e.message, "err");
  } finally {
    setBusy(false, "btnSpellCancel");
  }
}

const isChanged = r => !r.error && (r.corrected !== r.seg.text || r.issues.length > 0);

function diffHtml(a, b, side) {
  return diffChars(a, b)
    .filter(op => op.type === "eq" || op.type === side)
    .map(op => (op.type === "eq" ? esc(op.text) : `<span class="${side}">${esc(op.text).replace(/ /g, "␣")}</span>`))
    .join("")
    .replace(/\n/g, "<br>");
}

function renderSpell() {
  const sp = state.spell;
  if (!sp) return;
  show("spellResult", true);
  const changed = sp.rows.filter(isChanged);
  const errors = sp.rows.filter(r => r.error).length;
  $("spellSummary").textContent = `전체 ${sp.rows.length}개 · 수정 제안 ${changed.length}개${errors ? ` · 실패 ${errors}개` : ""} · ${sp.engine}${sp.cost ? ` · 이번 검사 비용 약 ${dollars(sp.cost)}` : ""}`;
  const only = $("onlyChanged").checked;
  const rows = sp.rows.filter(r => !only || isChanged(r) || r.error);
  if (!rows.length) {
    $("spellList").innerHTML = `<div class="hint">${changed.length ? "" : "고칠 곳을 찾지 못했어요. 👍"}</div>`;
    return;
  }
  $("spellList").innerHTML = rows.map(r => {
    const time = r.seg.start != null ? `<button data-seek="${r.seg.start}">${srt.formatClock(r.seg.start)}</button>` : `<span class="chip">#${r.seg.index}</span>`;
    const kinds = [...new Set(r.issues.map(i => i.type))].map(k => `<span class="chip">${esc(k)}</span>`).join("");
    const track = (r.seg.track ? `<span class="chip">V${r.seg.track}</span>` : "") + (r.seg.via && r.seg.via !== "값" ? `<span class="chip">${esc(r.seg.via)}</span>` : "");
    let body;
    if (r.error) body = `<div class="line">${esc(r.seg.text)}</div><div class="notes">⚠ ${esc(r.error)}</div>`;
    else if (!isChanged(r)) body = `<div class="line">${esc(r.seg.text)}</div>`;
    else {
      body = `<div class="line"><b>원문</b>${diffHtml(r.seg.text, r.corrected, "del")}</div>` +
        (r.corrected !== r.seg.text ? `<div class="line"><b>수정</b>${diffHtml(r.seg.text, r.corrected, "ins")}</div>` : "") +
        (r.issues.length ? `<div class="notes">${r.issues.map(i => `· ${esc(i.before)} → ${esc(i.after)}${i.reason ? ` — ${esc(i.reason)}` : ""}`).join("<br>")}</div>` : "");
    }
    const toggle = isChanged(r) ? `<button data-ignore="${r.seg.id}">${r.ignored ? "다시 넣기" : "이 제안 빼기"}</button>` : "";
    return `<div class="card${r.ignored ? " ignored" : ""}${r.error ? " err" : ""}"><div class="cardhead">${time}${track}${kinds}${toggle}</div>${body}</div>`;
  }).join("");
}

/** 사용자가 뺀 제안은 원문으로 돌려서 내보냄 */
function acceptedRows() {
  return state.spell.rows.map(r => (r.ignored ? Object.assign({}, r, { corrected: r.seg.text, issues: [] }) : r));
}

async function spellMarkers() {
  if (!state.spell) return;
  const items = report.spellMarkers(acceptedRows());
  if (!items.length) { say("spellMsg", "타임코드가 있는 수정 제안이 없어서 마커를 만들 곳이 없어요.", "err"); return; }
  try {
    const { project, sequence } = await pr.getActive();
    await pr.removeMarkers(project, sequence, report.AI_PREFIX + " 맞춤법]");
    const n = await pr.addMarkers(project, sequence, items);
    say("spellMsg", `타임라인에 마커 ${n}개를 표시했어요. 마커 패널에서 하나씩 넘겨 보세요.`, "ok");
  } catch (e) {
    say("spellMsg", "마커를 만들지 못했어요: " + e.message, "err");
  }
}

async function saveCorrected() {
  if (!state.spell) return;
  const segs = report.correctedSegments(acceptedRows());
  const timed = segs.every(s => s.start != null);
  const base = String(state.source || "자막").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "").slice(0, 40);
  try {
    const ok = timed
      ? await host.saveTextFile(`${base}_교정.srt`, srt.writeSrt(segs), ["srt"])
      : await host.saveTextFile(`${base}_교정.txt`, segs.map(s => s.text).join("\n"), ["txt"]);
    if (ok) say("spellMsg", timed ? "교정된 SRT를 저장했어요. 프로젝트로 가져와 캡션 트랙에 올리면 됩니다." : "교정된 텍스트를 저장했어요.", "ok");
  } catch (e) {
    say("spellMsg", "저장하지 못했어요: " + e.message, "err");
  }
}

async function saveSpellReport() {
  if (!state.spell) return;
  try {
    const text = report.spellReport(acceptedRows(), { source: state.spell.source, engine: state.spell.engine });
    if (await host.saveTextFile("맞춤법_검사_리포트.txt", text, ["txt"])) say("spellMsg", "리포트를 저장했어요.", "ok");
  } catch (e) {
    say("spellMsg", "저장하지 못했어요: " + e.message, "err");
  }
}

/* ───────── AI 컨펌 ───────── */

function confirmRange() {
  const s = state.seq;
  if (!s) return null;
  return $("range").value === "inout" && s.hasInOut ? { start: s.inPoint, end: s.outPoint } : { start: 0, end: s.end };
}

function plannedTimes() {
  const r = confirmRange();
  if (!r) return [];
  return sampling.planFrameTimes({
    start: r.start, end: r.end,
    interval: +$("interval").value, maxFrames: +$("maxFrames").value,
    segments: state.segments, perSegment: $("perSegment").checked,
  });
}

function updateEstimate() {
  if (!state.seq) { $("estimate").textContent = "시퀀스를 열면 예상 프레임 수와 비용을 보여드려요."; return; }
  const n = plannedTimes().length;
  const size = sampling.frameSize(state.seq.width, state.seq.height, state.prefs.longEdge);
  const info = claude.MODELS[state.prefs.model] || claude.MODELS[claude.DEFAULT_MODEL];
  const subChars = $("withSubs").checked ? state.segments.reduce((a, s) => a + s.text.length + 12, 0) : 0;
  const input = n * sampling.imageTokens(size.width, size.height) + Math.min(subChars, 20000) + 4000;
  const output = 10000;
  const cost = (input * info.input + output * info.output) / 1e6;
  const r = confirmRange();
  const note = $("range").value === "inout" && !state.seq.hasInOut ? " (인·아웃이 없어 전체로 검토)" : "";
  const price = subscription() ? "내 Claude 구독 사용량에서 차감 (추가 비용 없음)" : `예상 비용 약 ${dollars(cost)}`;
  $("estimate").textContent = `${srt.formatClock(r.start)}~${srt.formatClock(r.end)}${note} · 프레임 ${n}장 (${size.width}x${size.height}) · ${price}`;
}

function readConfirmForm() {
  Object.assign(state.prefs, {
    range: $("range").value, interval: +$("interval").value, maxFrames: +$("maxFrames").value,
    perSegment: $("perSegment").checked, withSubs: $("withSubs").checked, focus: $("focus").value, brief: $("brief").value,
  });
  savePrefs();
}

/** 이미지 합계가 너무 크면 고르게 줄임 */
function fitPayload(frames) {
  const sizes = frames.map(f => f.data.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= MAX_PAYLOAD) return frames;
  const keep = Math.max(1, Math.floor(frames.length * MAX_PAYLOAD / total));
  const out = [];
  for (let k = 0; k < keep; k++) out.push(frames[Math.round(k * (frames.length - 1) / Math.max(1, keep - 1))]);
  return out.filter((f, i) => out.indexOf(f) === i);
}

async function runConfirm() {
  if (state.busy) return;
  if (needKey("confirmMsg")) return;
  readConfirmForm();
  // 첫 await 전에 바쁨 표시 (빠르게 두 번 눌러도 한 번만 실행)
  setBusy(true, "btnConfirmCancel");
  try {
    await refreshSequence();
    if (!state.seq) { say("confirmMsg", "열려 있는 시퀀스가 없어요.", "err"); return; }
    const times = plannedTimes();
    const range = confirmRange();
    const size = sampling.frameSize(state.seq.width, state.seq.height, state.prefs.longEdge);
    const { sequence } = await pr.getActive();
    const raw = await pr.exportFrames(sequence, times, size, {
      onProgress: (i, n) => say("confirmMsg", `프레임 뽑는 중… ${i}/${n}`),
      isCancelled: () => state.cancel,
    });
    let frames = raw.map(f => ({ time: f.time, mediaType: f.mediaType, data: base64.encode(f.bytes), bytes: f.bytes }));
    // API 요청에는 32MB 한도가 있어서 줄임 (구독 모드는 파일로 보내서 한도 없음)
    const fitted = subscription() ? frames : fitPayload(frames);
    const trimmed = fitted.length < frames.length;
    frames = fitted;
    if (state.cancel) throw new Error("취소했어요.");
    const segs = state.prefs.withSubs ? state.segments.filter(s => s.start == null || (s.end > range.start && s.start < range.end)) : [];
    const info = { name: state.seq.name, start: range.start, end: range.end, width: state.seq.width, height: state.seq.height, frameCount: frames.length };
    // 요청을 보낸 뒤에는 멈춰도 비용이 그대로라 멈추기 버튼을 숨김
    show("btnConfirmCancel", false);
    const looking = `검수팀이 프레임 ${frames.length}장을 보는 중… (보통 ${subscription() ? "2~5" : "1~3"}분)` + (trimmed ? " · 용량이 커서 일부 프레임만 보냈어요" : "");
    say("confirmMsg", subscription() ? "구독 연결 프로그램으로 프레임 보내는 중…" : looking);
    const res = await claude.reviewVideo({
      mode: state.prefs.mode, apiKey: state.apiKey, model: state.prefs.model, frames, segments: segs,
      brief: state.prefs.brief, focus: state.prefs.focus, channel: state.prefs.channel, info,
    }, {
      onUpload: (i, n) => say("confirmMsg", i < n ? `구독 연결 프로그램으로 프레임 보내는 중… ${i}/${n}` : looking),
    });
    state.review = res.review;
    state.reviewMeta = { sequence: info.name, start: info.start, end: info.end, frames: frames.length, model: res.model, cost: res.cost };
    makeThumbs(frames);
    say("confirmMsg", `검수팀 리뷰가 왔어요${res.cost ? ` · 비용 약 ${dollars(res.cost.dollars)}` : ""}.` + (trimmed ? " (용량 때문에 프레임 일부만 보냈어요. 설정에서 프레임 크기를 줄이면 더 많이 보낼 수 있어요.)" : ""), "ok");
    renderReview();
  } catch (e) {
    say("confirmMsg", e.message, "err");
  } finally {
    setBusy(false, "btnConfirmCancel");
  }
}

function makeThumbs(frames) {
  state.thumbs.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { /* 무시 */ } });
  state.thumbs = frames.map(f => {
    try { return URL.createObjectURL(new Blob([f.bytes], { type: f.mediaType })); } catch (e) { return null; }
  });
}

function renderReview() {
  const r = state.review;
  if (!r) return;
  show("confirmResult", true);
  const v = $("verdict");
  v.className = "verdict v-" + (VERDICT_CLASS[r.verdict] || "fix");
  v.textContent = `${VERDICT_ICON[r.verdict] || ""} 검수팀 판정: ${r.verdict}`;
  const good = r.goodPoints.length ? `<div class="notes">${r.goodPoints.map(g => "👍 " + esc(g)).join("<br>")}</div>` : "";
  $("reviewSummary").innerHTML = `<div>${esc(r.summary)}</div>${good}`;
  if (!r.issues.length) { $("issueList").innerHTML = `<div class="hint">고칠 점이 없어요. 그대로 올려도 좋아요.</div>`; return; }
  $("issueList").innerHTML = r.issues.map(i => {
    const thumb = state.thumbs[i.frame] ? `<img class="thumb" src="${state.thumbs[i.frame]}">` : "";
    const alts = i.alternatives.length ? `<div class="notes">${i.alternatives.map((a, k) => `대안 ${k + 1}. ${esc(a)}`).join("<br>")}</div>` : "";
    return `<div class="card"><div class="cardhead"><button data-seek="${i.time}">${srt.formatClock(i.time)}</button><span class="chip sev-${SEVERITY_CLASS[i.severity] || "info"}">${esc(i.severity)}</span><span class="chip team">${esc(i.team)}</span><span class="chip">${esc(i.category)}</span></div>` +
      (i.current ? `<div class="line"><b>지금</b>${esc(i.current)}</div>` : "") +
      (i.suggestion ? `<div class="line"><b>제안</b>${esc(i.suggestion)}</div>` : "") + alts +
      (i.detail ? `<div class="notes">${esc(i.detail)}</div>` : "") + thumb + `</div>`;
  }).join("");
}

async function confirmMarkers() {
  if (!state.review) return;
  const items = report.confirmMarkers(state.review);
  if (!items.length) { say("confirmMsg", "표시할 수정 사항이 없어요.", "ok"); return; }
  try {
    const { project, sequence } = await pr.getActive();
    await pr.removeMarkers(project, sequence, report.AI_PREFIX + " 컨펌");
    const n = await pr.addMarkers(project, sequence, items);
    say("confirmMsg", `타임라인에 마커 ${n}개를 표시했어요. 빨강=필수, 주황=권장, 파랑=참고.`, "ok");
  } catch (e) {
    say("confirmMsg", "마커를 만들지 못했어요: " + e.message, "err");
  }
}

async function clearMarkers() {
  try {
    const { project, sequence } = await pr.getActive();
    const n = await pr.removeMarkers(project, sequence, report.AI_PREFIX);
    say("confirmMsg", n ? `AI 마커 ${n}개를 지웠어요.` : "지울 AI 마커가 없어요.", "ok");
  } catch (e) {
    say("confirmMsg", "마커를 지우지 못했어요: " + e.message, "err");
  }
}

async function saveConfirmReport() {
  if (!state.review) return;
  try {
    const text = report.confirmReport(state.review, state.reviewMeta);
    if (await host.saveTextFile("AI_컨펌_리포트.txt", text, ["txt"])) say("confirmMsg", "리포트를 저장했어요.", "ok");
  } catch (e) {
    say("confirmMsg", "저장하지 못했어요: " + e.message, "err");
  }
}

/* ───────── 설정 ───────── */

async function saveKey() {
  const key = $("apiKey").value.trim();
  if (key && !/^sk-ant-/.test(key)) { say("keyMsg", "Anthropic API 키는 sk-ant- 로 시작해요. 다시 확인해 주세요.", "err"); return; }
  const where = await host.saveApiKey(key);
  state.apiKey = key;
  updateKeyNotice();
  say("keyMsg", key ? (where === "secure" ? "키를 보안 저장소에 저장했어요." : "키를 저장했어요 (보안 저장소를 쓸 수 없어 플러그인 저장소에 저장).") : "키를 지웠어요.", "ok");
}

const modelName = id => claude.MODELS[id].label.split(" (")[0];

function authLine(auth) {
  if (!auth || !auth.checked) return "3. Claude 로그인: 확인 못 함 (Claude Code가 옛 버전이면 PowerShell에서 claude update)";
  if (!auth.loggedIn) return null;
  const who = [auth.email, auth.plan].filter(Boolean).join(", ");
  return `3. Claude 로그인 ✅${who ? ` (${who})` : ""}`;
}

/** 구독 연결 확인: 연결 프로그램 → Claude Code → 로그인 → 실제 짧은 질문까지 차례로, 막힌 곳과 해결 방법을 보여 줌 */
async function testSubscription() {
  if (state.busy) return;
  setBusy(true);
  const lines = [];
  const out = kind => say("subMsg", lines.join("\n"), kind);
  try {
    lines.push("1. 구독 연결 프로그램 찾는 중…"); out();
    let h;
    try { h = await bridge.health(); } catch (e) {
      if (e.code === "claude_not_found") { lines[0] = "1. 구독 연결 프로그램 ✅"; lines.push("2. Claude Code ❌ " + e.message); }
      else lines[0] = "1. 구독 연결 프로그램 ❌ " + e.message;
      out("err");
      return;
    }
    lines[0] = `1. 구독 연결 프로그램 ✅ (${h.bridge ? "v" + h.bridge : "옛 버전"} · 포트 ${h.port})`;
    if (!h.bridge) lines.push("   ⚠ 옛 연결 프로그램이에요. 창을 닫고 새 설치 묶음의 claude-bridge.ps1로 다시 켜 주세요.");
    lines.push(`2. Claude Code ✅ ${h.version || ""}`.trim());
    const auth = authLine(h.auth);
    if (auth === null) {
      lines.push("3. Claude 로그인 ❌ 로그인이 안 돼 있어요. PowerShell을 새로 열고 claude 를 실행한 뒤 /login 으로 내 Claude 계정(Pro·Max 구독)에 로그인하고, 연결 프로그램 창을 닫았다가 다시 켜 주세요.");
      out("err");
      return;
    }
    lines.push(auth);
    if (h.auth && /api.?key|console/i.test(h.auth.method || "")) lines.push("   ⚠ Claude Code가 API 키로 로그인돼 있으면 구독이 아니라 API 요금이 나가요. claude → /logout → /login 에서 Claude 계정으로 로그인하세요.");
    let model = state.prefs.model;
    lines.push(`4. ${modelName(model)}에게 짧게 물어보는 중… (보통 10~30초)`); out();
    try {
      await claude.ping({ mode: "subscription", model });
    } catch (e) {
      if (e.code !== "model_unavailable" || model === "claude-sonnet-5-5") throw e;
      // 요금제에서 Opus를 못 쓰면 Sonnet으로 바꿔서 다시
      lines[lines.length - 1] = `4. ${modelName(model)}은(는) 지금 요금제에서 쓸 수 없어서 Sonnet으로 다시 해 볼게요…`; out();
      model = "claude-sonnet-5-5";
      await claude.ping({ mode: "subscription", model });
      state.prefs.model = model;
      savePrefs();
      setOptions($("model"), Object.keys(claude.MODELS).map(id => [id, claude.MODELS[id].label]), model);
      updateEstimate();
      lines.push("   설정의 Claude 모델을 Sonnet 5.5로 바꿨어요.");
    }
    lines[lines.findIndex(l => l.startsWith("4."))] = `4. ${modelName(model)} 응답 ✅`;
    lines.push(`연결됐어요. 내 구독으로 ${modelName(model)}을(를) 씁니다 (추가 비용 없음).`);
    out("ok");
  } catch (e) {
    const i = lines.findIndex(l => l.startsWith("4."));
    if (i !== -1) lines[i] = lines[i].replace(/에게 짧게 물어보는 중….*$/, " 응답 ❌");
    lines.push(e.message);
    out("err");
  } finally {
    setBusy(false);
  }
}

async function testKey() {
  const key = $("apiKey").value.trim() || state.apiKey;
  if (!key) { say("keyMsg", "키를 먼저 넣어 주세요.", "err"); return; }
  say("keyMsg", "연결 확인 중…");
  setBusy(true);
  try {
    await claude.ping({ mode: "api", apiKey: key, model: state.prefs.model });
    say("keyMsg", `연결됐어요 (${claude.MODELS[state.prefs.model].label}).`, "ok");
  } catch (e) {
    say("keyMsg", e.message, "err");
  } finally {
    setBusy(false);
  }
}

/* ───────── 자가 진단 ───────── */

const DIAG_PREFIX = report.AI_PREFIX + " 진단]";

function diagReport(lines) {
  const passed = lines.filter(l => l.ok).length;
  const extras = lines.filter(l => l.extra).map(l => l.extra);
  return [`자가 진단: ${lines.length}개 중 ${passed}개 통과`].concat(lines.map(l => `${l.ok ? "✅" : "❌"} ${l.name}${l.detail ? ` — ${l.detail}` : ""}`), extras).join("\n");
}

function renderDiag(lines) {
  $("diagList").innerHTML = lines.map(l => `<div class="line">${l.ok ? "✅" : "❌"} <b>${esc(l.name)}</b>${esc(l.detail)}</div>`).join("");
  $("diagText").value = diagReport(lines);
  show("diagText", true);
  show("diagHint", true);
}

async function runDiagnostics() {
  if (state.busy) return;
  setBusy(true);
  const lines = [];
  const step = async (name, fn) => {
    try {
      const r = await fn();
      lines.push(Object.assign({ ok: true, name }, r && typeof r === "object" ? r : { detail: r || "" }));
    }
    catch (e) { lines.push({ ok: false, name, detail: (e && e.message) || String(e) }); }
    renderDiag(lines);
  };
  try {
    const env = await host.environment();
    lines.push({ ok: true, name: "환경", detail: `프리미어 ${env.app} · 플러그인 ${env.plugin} · ${subscription() ? "내 구독" : "API 키"} · ${state.prefs.model}` });
    renderDiag(lines);
    let ctx = null, info = null, pos = 0;
    await step("열린 시퀀스", async () => {
      ctx = await pr.getActive();
      info = await pr.sequenceInfo(ctx.sequence);
      return `${info.name} · ${srt.formatClock(info.end)} · ${info.width}x${info.height}${info.hasInOut ? ` · 인/아웃 ${srt.formatClock(info.inPoint)}~${srt.formatClock(info.outPoint)}` : ""}`;
    });
    if (ctx) {
      await step("재생헤드 읽기·이동", async () => {
        pos = await pr.playerPosition(ctx.sequence);
        await pr.seek(ctx.sequence, pos);
        return `${srt.formatClock(pos)} (같은 자리로 다시 이동)`;
      });
      await step("프레임 1장 내보내기", async () => {
        const size = sampling.frameSize(info.width, info.height, state.prefs.longEdge);
        const t = Math.min(pos, Math.max(0, info.end - 0.1));
        const [f] = await pr.exportFrames(ctx.sequence, [t], size);
        return `${size.width}x${size.height} ${f.mediaType === "image/png" ? "PNG" : "JPG"} · ${Math.max(1, Math.round(f.bytes.byteLength / 1024))}KB`;
      });
      await step("그래픽 텍스트 읽기", async () => {
        const scan = await pr.scanTextClips(ctx.sequence, { dump: 2 });
        const clips = scan.clips, read = clips.filter(c => c.text);
        const first = read.length ? ` · 첫 번째 "${read[0].text.replace(/\n/g, " ").slice(0, 30)}"` : "";
        const missing = clips.length - read.length;
        const dump = scan.dumps.map(d => d.join("\n")).join("\n");
        return {
          detail: `클립 ${scan.scanned}개 중 텍스트 그래픽 ${clips.length}개 · 글자 읽음 ${read.length}개${read.length ? ` (${viaSummary(read)})` : ""}${missing ? ` · 못 읽음 ${missing}개 (화면 보고 받아 적기로 읽음)` : ""}${first}`,
          extra: dump ? `[${clips.length ? "텍스트 그래픽" : "위쪽 트랙 클립"} 구조]\n${dump}` : "",
        };
      });
      await step("마커 만들기·지우기", async () => {
        await pr.addMarkers(ctx.project, ctx.sequence, [{ name: DIAG_PREFIX + " 테스트", start: pos, duration: 0, comments: "자가 진단용 마커", color: "GREEN" }]);
        const removed = await pr.removeMarkers(ctx.project, ctx.sequence, DIAG_PREFIX);
        if (!removed) throw new Error("마커를 만들었지만 다시 찾지 못했어요");
        return "만들고 지움";
      });
    }
    if (subscription()) {
      await step("구독 연결 프로그램", async () => {
        const h = await bridge.health();
        const auth = authLine(h.auth);
        if (auth === null) throw new Error(`연결 프로그램 v${h.bridge || "옛 버전"} · ${h.version || "Claude Code"} · Claude 로그인이 안 돼 있어요 (PowerShell에서 claude → /login)`);
        return `v${h.bridge || "옛 버전"} · 포트 ${h.port} · ${h.version || "Claude Code"} · ${auth.replace(/^3\. /, "")} (실제로 물어보려면 '구독 연결 확인')`;
      });
    } else {
      await step("API 키", async () => {
        if (!state.apiKey) throw new Error("설정 탭에 API 키가 없어요");
        return "저장돼 있음 (키가 맞는지는 '연결 테스트')";
      });
    }
  } finally {
    setBusy(false);
  }
}

async function saveDiagnostics() {
  const text = $("diagText").value;
  if (!text) return;
  try { await host.saveTextFile("자가진단_결과.txt", text, ["txt"]); } catch (e) { /* 저장 취소 */ }
}

/* ───────── 시작 ───────── */

function fillForm() {
  const p = state.prefs;
  setOptions($("model"), Object.keys(claude.MODELS).map(id => [id, claude.MODELS[id].label]), p.model);
  const set = (id, v) => { try { $(id).value = String(v); } catch (e) { reportError(`설정 표시 (${id})`, e); } };
  set("mode", p.mode); set("engine", p.engine); set("longEdge", p.longEdge);
  set("range", p.range); set("interval", p.interval); set("maxFrames", p.maxFrames); set("focus", p.focus);
  $("brief").value = p.brief || "";
  $("withSubs").checked = !!p.withSubs;
  const ch = p.channel || {};
  $("chAbout").value = ch.about || ""; $("chAudience").value = ch.audience || ""; $("chTone").value = ch.tone || "";
  $("perSegment").checked = false;
  $("perSegment").disabled = true;
  if (state.apiKey) $("apiKey").value = state.apiKey;
}

const missing = [];

/** 요소에 이벤트 연결. 처리 중 오류는 패널에 보여 주고, 요소가 없으면 모아 두었다가 알림 */
function on(id, event, fn) {
  const el = $(id);
  if (!el) { missing.push(id); return; }
  el.addEventListener(event, async ev => {
    try { await fn(ev); } catch (e) { reportError(id, e); }
  });
}

function bind() {
  all(".tab").forEach(b => b.addEventListener("click", () => { try { showTab(b.getAttribute("data-tab")); } catch (e) { reportError("탭", e); } }));
  on("btnRefresh", "click", refreshSequence);
  on("btnGoSettings", "click", () => showTab("settings"));

  on("btnReadTimeline", "click", readTimeline);
  on("btnReadScreen", "click", readScreen);
  on("btnReadCancel", "click", () => { state.cancel = true; });
  on("btnOpenFile", "click", openFile);
  on("btnSpellRun", "click", runSpell);
  on("btnSpellCancel", "click", () => { state.cancel = true; });
  on("onlyChanged", "change", renderSpell);
  on("btnSpellMarkers", "click", spellMarkers);
  on("btnSaveSrt", "click", saveCorrected);
  on("btnSpellReport", "click", saveSpellReport);
  on("engine", "change", () => { state.prefs.engine = $("engine").value; savePrefs(); updateKeyNotice(); });

  on("spellList", "click", e => {
    const seekEl = withAttr(e.target, "data-seek", $("spellList"));
    if (seekEl) { seekTo(+seekEl.getAttribute("data-seek")); return; }
    const ign = withAttr(e.target, "data-ignore", $("spellList"));
    if (ign && state.spell) {
      const row = state.spell.rows.find(r => r.seg.id === +ign.getAttribute("data-ignore"));
      if (row) { row.ignored = !row.ignored; renderSpell(); }
    }
  });
  on("issueList", "click", e => {
    const seekEl = withAttr(e.target, "data-seek", $("issueList"));
    if (seekEl) seekTo(+seekEl.getAttribute("data-seek"));
  });

  ["range", "interval", "maxFrames", "perSegment", "withSubs", "focus"].forEach(id => on(id, "change", () => { readConfirmForm(); updateEstimate(); }));
  on("brief", "change", readConfirmForm);
  on("btnConfirm", "click", runConfirm);
  on("btnConfirmCancel", "click", () => { state.cancel = true; });
  on("btnConfirmMarkers", "click", confirmMarkers);
  on("btnConfirmReport", "click", saveConfirmReport);
  on("btnClearMarkers", "click", clearMarkers);

  on("mode", "change", () => { state.prefs.mode = $("mode").value; savePrefs(); updateModeUI(); });
  on("btnTestSub", "click", testSubscription);
  on("btnDiag", "click", runDiagnostics);
  on("btnDiagSave", "click", saveDiagnostics);
  on("btnSaveKey", "click", saveKey);
  on("btnTestKey", "click", testKey);
  on("btnGetKey", "click", () => host.openExternal("https://console.anthropic.com/settings/keys"));
  on("model", "change", () => { state.prefs.model = $("model").value; savePrefs(); updateEstimate(); });
  on("longEdge", "change", () => { state.prefs.longEdge = +$("longEdge").value; savePrefs(); updateEstimate(); });
  ["chAbout", "chAudience", "chTone"].forEach(id => on(id, "change", () => {
    state.prefs.channel = { about: $("chAbout").value.trim(), audience: $("chAudience").value.trim(), tone: $("chTone").value.trim() };
    savePrefs();
  }));
}

async function start() {
  const steps = [
    ["설정 불러오기", () => {
      state.prefs = host.loadPrefs(DEFAULTS);
      if (!claude.MODELS[state.prefs.model]) state.prefs.model = claude.DEFAULT_MODEL;
      if (state.prefs.mode !== "api") state.prefs.mode = "subscription";
    }],
    ["버튼 연결", () => {
      bind();
      if (missing.length) throw new Error("패널 파일 일부가 없어요 (" + missing.join(", ") + "). 플러그인을 지우고 다시 설치해 주세요.");
    }],
    ["화면 채우기", fillForm],
    ["사용 방식 표시", updateModeUI],
    ["API 키 불러오기", async () => {
      state.apiKey = await host.loadApiKey();
      if (state.apiKey) $("apiKey").value = state.apiKey;
      updateKeyNotice();
    }],
  ];
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { reportError(`패널 시작 (${name})`, e); }
  }
  host.environment().then(env => { $("version").textContent = "v" + env.plugin; }).catch(() => {});
  await refreshSequence();
}

// 프리미어 버전에 따라 load 이벤트가 이미 지나갔을 수도 있어서 여러 번 시도 (한 번만 실행)
let started = false;
function boot() {
  if (started || !document.getElementById("btnReadTimeline")) return;
  started = true;
  start().catch(e => reportError("패널 시작", e));
}
try {
  window.addEventListener("error", ev => reportError("오류", (ev && (ev.error || ev.message)) || ev));
  window.addEventListener("unhandledrejection", ev => reportError("오류", ev && ev.reason));
} catch (e) { /* 지원하지 않으면 버튼별 오류 표시만 */ }
window.addEventListener("load", boot);
try { document.addEventListener("DOMContentLoaded", boot); } catch (e) { /* 없음 */ }
setTimeout(boot, 0);
setTimeout(boot, 1000);
