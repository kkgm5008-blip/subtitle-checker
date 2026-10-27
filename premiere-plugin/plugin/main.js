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

const DEFAULTS = {
  mode: "subscription", model: claude.DEFAULT_MODEL, engine: "claude", longEdge: 1280,
  range: "all", interval: 3, maxFrames: 40, perSegment: false, withSubs: true, focus: "all", brief: "",
  channel: { about: "", audience: "", tone: "" },
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

async function readTimeline() {
  if (state.busy) return;
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

async function testSubscription() {
  say("subMsg", "구독 연결 프로그램 확인 중…");
  setBusy(true);
  try {
    const h = await bridge.health();
    say("subMsg", `연결 프로그램 확인 (${h.version || "Claude Code"}). Claude에게 짧게 물어보는 중…`);
    await claude.ping({ mode: "subscription", model: state.prefs.model });
    say("subMsg", `연결됐어요. 내 구독으로 ${claude.MODELS[state.prefs.model].label.split(" (")[0]}을(를) 씁니다.`, "ok");
  } catch (e) {
    say("subMsg", e.message, "err");
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
  return [`자가 진단: ${lines.length}개 중 ${passed}개 통과`].concat(lines.map(l => `${l.ok ? "✅" : "❌"} ${l.name}${l.detail ? ` — ${l.detail}` : ""}`)).join("\n");
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
    try { lines.push({ ok: true, name, detail: (await fn()) || "" }); }
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
        const list = await pr.readTimelineTexts(ctx.sequence);
        return list.length ? `${list.length}개 · 첫 번째 "${list[0].text.replace(/\n/g, " ").slice(0, 30)}"` : "0개 (그래픽 자막이 없으면 정상)";
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
        return `${h.version || "연결됨"} (Claude 로그인까지 보려면 '구독 연결 확인')`;
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
  $("model").innerHTML = Object.keys(claude.MODELS).map(id => `<option value="${id}"${id === p.model ? " selected" : ""}>${esc(claude.MODELS[id].label)}</option>`).join("");
  const set = (id, v) => { $(id).value = String(v); };
  set("mode", p.mode); set("model", p.model); set("engine", p.engine); set("longEdge", p.longEdge);
  set("range", p.range); set("interval", p.interval); set("maxFrames", p.maxFrames); set("focus", p.focus);
  $("brief").value = p.brief || "";
  $("withSubs").checked = !!p.withSubs;
  const ch = p.channel || {};
  $("chAbout").value = ch.about || ""; $("chAudience").value = ch.audience || ""; $("chTone").value = ch.tone || "";
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

  $("mode").addEventListener("change", () => { state.prefs.mode = $("mode").value; savePrefs(); updateModeUI(); });
  $("btnTestSub").addEventListener("click", testSubscription);
  $("btnDiag").addEventListener("click", runDiagnostics);
  $("btnDiagSave").addEventListener("click", saveDiagnostics);
  $("btnSaveKey").addEventListener("click", saveKey);
  $("btnTestKey").addEventListener("click", testKey);
  $("btnGetKey").addEventListener("click", () => host.openExternal("https://console.anthropic.com/settings/keys"));
  $("model").addEventListener("change", () => { state.prefs.model = $("model").value; savePrefs(); updateEstimate(); });
  $("longEdge").addEventListener("change", () => { state.prefs.longEdge = +$("longEdge").value; savePrefs(); updateEstimate(); });
  ["chAbout", "chAudience", "chTone"].forEach(id => $(id).addEventListener("change", () => {
    state.prefs.channel = { about: $("chAbout").value.trim(), audience: $("chAudience").value.trim(), tone: $("chTone").value.trim() };
    savePrefs();
  }));
}

window.addEventListener("load", async () => {
  state.prefs = host.loadPrefs(DEFAULTS);
  if (!claude.MODELS[state.prefs.model]) state.prefs.model = claude.DEFAULT_MODEL;
  if (state.prefs.mode !== "api") state.prefs.mode = "subscription";
  state.apiKey = await host.loadApiKey();
  fillForm();
  bind();
  updateModeUI();
  await refreshSequence();
});
