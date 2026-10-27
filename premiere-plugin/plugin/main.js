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

const DEFAULTS = {
  model: claude.DEFAULT_MODEL, engine: "claude", longEdge: 1280,
  range: "all", interval: 3, maxFrames: 40, perSegment: false, withSubs: true, focus: "all", brief: "",
};
const MAX_PAYLOAD = 24 * 1024 * 1024; // base64 이미지 합계 (API 요청 한도 32MB 아래로)
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

function needKey(msgId) {
  if (state.apiKey) return false;
  say(msgId, "설정 탭에서 Anthropic API 키를 먼저 저장해 주세요.", "err");
  return true;
}

function showTab(name) {
  all(".tab").forEach(b => { b.className = "tab" + (b.getAttribute("data-tab") === name ? " on" : ""); });
  ["spell", "confirm", "settings"].forEach(t => show("pane-" + t, t === name));
  if (name === "confirm") updateEstimate();
}

function updateKeyNotice() {
  const needs = !state.apiKey && (state.prefs.engine === "claude");
  show("keyNotice", needs);
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

async function readTimeline() {
  setBusy(true);
  say("spellMsg", "타임라인의 그래픽 클립을 읽는 중…");
  try {
    const { sequence } = await pr.getActive();
    const list = await pr.readTimelineTexts(sequence, (t, n) => say("spellMsg", `트랙 읽는 중 ${t}/${n}…`));
    if (!list.length) {
      say("spellMsg", "그래픽 텍스트를 찾지 못했어요. 캡션 자막이면 텍스트 패널에서 SRT로 내보낸 뒤 '자막 파일 열기'를 쓰거나, AI 컨펌으로 화면 속 글자를 검사하세요.", "err");
      return;
    }
    setSegments(list, `타임라인 그래픽 (${state.seq ? state.seq.name : "시퀀스"})`);
    say("spellMsg", `그래픽 텍스트 ${list.length}개를 읽었어요.`, "ok");
  } catch (e) {
    say("spellMsg", e.message, "err");
  } finally {
    setBusy(false);
  }
}

async function openFile() {
  try {
    const file = await host.openTextFile(["srt", "vtt", "txt"]);
    if (!file) return;
    const list = srt.parseSubtitleFile(file.name, file.text);
    if (!list.length) { say("spellMsg", "파일에서 자막을 찾지 못했어요. 내용을 확인해 주세요.", "err"); return; }
    setSegments(list, file.name);
    if (srt.looksGarbled(file.text)) say("spellMsg", "글자가 깨져 보여요. 파일을 UTF-8로 다시 저장해서 열어 주세요.", "err");
    else say("spellMsg", `${list.length}개 자막을 불러왔어요.`, "ok");
  } catch (e) {
    say("spellMsg", e.message, "err");
  }
}

/* ───────── 맞춤법 검사 ───────── */

async function runSpell() {
  if (!state.segments.length) { say("spellMsg", "먼저 자막을 불러와 주세요.", "err"); return; }
  const engine = $("engine").value;
  if (engine === "claude" && needKey("spellMsg")) return;
  const rows = state.segments.map(seg => ({ seg, corrected: seg.text, issues: [], error: null, ignored: false }));
  const byId = new Map(rows.map(r => [r.seg.id, r]));
  let cost = 0;
  setBusy(true, "btnSpellCancel");
  try {
    if (engine === "claude") {
      const batches = claude.batchSegments(state.segments.map(s => ({ id: s.id, start: s.start, text: s.text })));
      for (let b = 0; b < batches.length; b++) {
        if (state.cancel) break;
        say("spellMsg", `Claude가 검사 중… ${b + 1}/${batches.length}묶음`);
        try {
          const res = await claude.checkSpelling({ apiKey: state.apiKey, model: state.prefs.model, batch: batches[b] });
          res.fixes.forEach((fix, id) => Object.assign(byId.get(id), fix));
          if (res.cost) cost += res.cost.dollars;
        } catch (e) {
          if ([401, 403, 404].includes(e.status)) throw e;
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
    state.spell = { rows, engine: engine === "claude" ? claude.MODELS[state.prefs.model].label : "네이버 맞춤법 검사기", source: state.source, cost };
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
    const track = r.seg.track ? `<span class="chip">V${r.seg.track}</span>` : "";
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
  $("estimate").textContent = `${srt.formatClock(r.start)}~${srt.formatClock(r.end)}${note} · 프레임 ${n}장 (${size.width}x${size.height}) · 예상 비용 약 ${dollars(cost)}`;
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
  if (needKey("confirmMsg")) return;
  readConfirmForm();
  await refreshSequence();
  if (!state.seq) { say("confirmMsg", "열려 있는 시퀀스가 없어요.", "err"); return; }
  const times = plannedTimes();
  const range = confirmRange();
  const size = sampling.frameSize(state.seq.width, state.seq.height, state.prefs.longEdge);
  setBusy(true, "btnConfirmCancel");
  try {
    const { sequence } = await pr.getActive();
    const raw = await pr.exportFrames(sequence, times, size, {
      onProgress: (i, n) => say("confirmMsg", `프레임 뽑는 중… ${i}/${n}`),
      isCancelled: () => state.cancel,
    });
    let frames = raw.map(f => ({ time: f.time, mediaType: f.mediaType, data: base64.encode(f.bytes), bytes: f.bytes }));
    const fitted = fitPayload(frames);
    const trimmed = fitted.length < frames.length;
    frames = fitted;
    if (state.cancel) throw new Error("취소했어요.");
    const segs = state.prefs.withSubs ? state.segments.filter(s => s.start == null || (s.end > range.start && s.start < range.end)) : [];
    const info = { name: state.seq.name, start: range.start, end: range.end, width: state.seq.width, height: state.seq.height, frameCount: frames.length };
    // 요청을 보낸 뒤에는 멈춰도 비용이 그대로라 멈추기 버튼을 숨김
    show("btnConfirmCancel", false);
    say("confirmMsg", `Claude가 프레임 ${frames.length}장을 보는 중… (보통 1~3분)` + (trimmed ? " · 용량이 커서 일부 프레임만 보냈어요" : ""));
    const res = await claude.reviewVideo({
      apiKey: state.apiKey, model: state.prefs.model, frames, segments: segs, brief: state.prefs.brief, focus: state.prefs.focus, info,
    });
    state.review = res.review;
    state.reviewMeta = { sequence: info.name, start: info.start, end: info.end, frames: frames.length, model: res.model, cost: res.cost };
    makeThumbs(frames);
    say("confirmMsg", `컨펌을 받았어요${res.cost ? ` · 비용 약 ${dollars(res.cost.dollars)}` : ""}.` + (trimmed ? " (용량 때문에 프레임 일부만 보냈어요. 설정에서 프레임 크기를 줄이면 더 많이 보낼 수 있어요.)" : ""), "ok");
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
  v.textContent = `${VERDICT_ICON[r.verdict] || ""} ${r.verdict}`;
  const good = r.goodPoints.length ? `<div class="notes">${r.goodPoints.map(g => "👍 " + esc(g)).join("<br>")}</div>` : "";
  $("reviewSummary").innerHTML = `<div>${esc(r.summary)}</div>${good}`;
  if (!r.issues.length) { $("issueList").innerHTML = `<div class="hint">수정할 점이 없어요.</div>`; return; }
  $("issueList").innerHTML = r.issues.map(i => {
    const thumb = state.thumbs[i.frame] ? `<img class="thumb" src="${state.thumbs[i.frame]}">` : "";
    return `<div class="card"><div class="cardhead"><button data-seek="${i.time}">${srt.formatClock(i.time)}</button><span class="chip sev-${SEVERITY_CLASS[i.severity] || "info"}">${esc(i.severity)}</span><span class="chip">${esc(i.category)}</span></div>` +
      (i.current ? `<div class="line"><b>지금</b>${esc(i.current)}</div>` : "") +
      (i.suggestion ? `<div class="line"><b>수정</b>${esc(i.suggestion)}</div>` : "") +
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

async function testKey() {
  const key = $("apiKey").value.trim() || state.apiKey;
  if (!key) { say("keyMsg", "키를 먼저 넣어 주세요.", "err"); return; }
  say("keyMsg", "연결 확인 중…");
  setBusy(true);
  try {
    await claude.ping({ apiKey: key, model: state.prefs.model });
    say("keyMsg", `연결됐어요 (${claude.MODELS[state.prefs.model].label}).`, "ok");
  } catch (e) {
    say("keyMsg", e.message, "err");
  } finally {
    setBusy(false);
  }
}

/* ───────── 시작 ───────── */

function fillForm() {
  const p = state.prefs;
  $("model").innerHTML = Object.keys(claude.MODELS).map(id => `<option value="${id}"${id === p.model ? " selected" : ""}>${esc(claude.MODELS[id].label)}</option>`).join("");
  const set = (id, v) => { $(id).value = String(v); };
  set("model", p.model); set("engine", p.engine); set("longEdge", p.longEdge);
  set("range", p.range); set("interval", p.interval); set("maxFrames", p.maxFrames); set("focus", p.focus);
  $("brief").value = p.brief || "";
  $("withSubs").checked = !!p.withSubs;
  $("perSegment").checked = false;
  $("perSegment").disabled = true;
  if (state.apiKey) $("apiKey").value = state.apiKey;
}

function bind() {
  all(".tab").forEach(b => b.addEventListener("click", () => showTab(b.getAttribute("data-tab"))));
  $("btnRefresh").addEventListener("click", refreshSequence);
  $("btnGoSettings").addEventListener("click", () => showTab("settings"));

  $("btnReadTimeline").addEventListener("click", readTimeline);
  $("btnOpenFile").addEventListener("click", openFile);
  $("btnSpellRun").addEventListener("click", runSpell);
  $("btnSpellCancel").addEventListener("click", () => { state.cancel = true; });
  $("onlyChanged").addEventListener("change", renderSpell);
  $("btnSpellMarkers").addEventListener("click", spellMarkers);
  $("btnSaveSrt").addEventListener("click", saveCorrected);
  $("btnSpellReport").addEventListener("click", saveSpellReport);
  $("engine").addEventListener("change", () => { state.prefs.engine = $("engine").value; savePrefs(); updateKeyNotice(); });

  $("spellList").addEventListener("click", e => {
    const seekEl = withAttr(e.target, "data-seek", $("spellList"));
    if (seekEl) { seekTo(+seekEl.getAttribute("data-seek")); return; }
    const ign = withAttr(e.target, "data-ignore", $("spellList"));
    if (ign && state.spell) {
      const row = state.spell.rows.find(r => r.seg.id === +ign.getAttribute("data-ignore"));
      if (row) { row.ignored = !row.ignored; renderSpell(); }
    }
  });
  $("issueList").addEventListener("click", e => {
    const seekEl = withAttr(e.target, "data-seek", $("issueList"));
    if (seekEl) seekTo(+seekEl.getAttribute("data-seek"));
  });

  ["range", "interval", "maxFrames", "perSegment", "withSubs", "focus"].forEach(id => $(id).addEventListener("change", () => { readConfirmForm(); updateEstimate(); }));
  $("brief").addEventListener("change", readConfirmForm);
  $("btnConfirm").addEventListener("click", runConfirm);
  $("btnConfirmCancel").addEventListener("click", () => { state.cancel = true; });
  $("btnConfirmMarkers").addEventListener("click", confirmMarkers);
  $("btnConfirmReport").addEventListener("click", saveConfirmReport);
  $("btnClearMarkers").addEventListener("click", clearMarkers);

  $("btnSaveKey").addEventListener("click", saveKey);
  $("btnTestKey").addEventListener("click", testKey);
  $("btnGetKey").addEventListener("click", () => host.openExternal("https://console.anthropic.com/settings/keys"));
  $("model").addEventListener("change", () => { state.prefs.model = $("model").value; savePrefs(); updateEstimate(); });
  $("longEdge").addEventListener("change", () => { state.prefs.longEdge = +$("longEdge").value; savePrefs(); updateEstimate(); });
}

window.addEventListener("load", async () => {
  state.prefs = host.loadPrefs(DEFAULTS);
  if (!claude.MODELS[state.prefs.model]) state.prefs.model = claude.DEFAULT_MODEL;
  state.apiKey = await host.loadApiKey();
  fillForm();
  bind();
  updateKeyNotice();
  await refreshSequence();
});
