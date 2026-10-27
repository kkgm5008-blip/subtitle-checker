"use strict";
/* 검사 결과를 리포트 글과 프리미어 마커 정보로 바꿉니다. */

const { formatClock, formatTimestamp } = require("./srt.js");

// 플러그인이 만든 마커는 이름이 이 글자로 시작해서, 나중에 골라 지울 수 있음
const AI_PREFIX = "[AI";

const SEVERITY_COLOR = { 필수: "RED", 권장: "ORANGE", 참고: "BLUE" };

function clip(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * @param {Array<{seg:{index,start,end,text}, corrected:string, issues:Array, error?:string}>} rows
 */
function spellReport(rows, meta = {}) {
  const changed = rows.filter(r => !r.error && (r.corrected !== r.seg.text || r.issues.length));
  const lines = [
    "# 자막 맞춤법 검사 리포트",
    "",
    `- 출처: ${meta.source || ""}`,
    `- 검사 엔진: ${meta.engine || ""}`,
    `- 전체 ${rows.length}개 중 수정 제안 ${changed.length}개`,
    "",
  ];
  for (const r of rows) {
    const tc = r.seg.start != null ? `[${formatTimestamp(r.seg.start)} - ${formatTimestamp(r.seg.end)}]` : `[#${r.seg.index}]`;
    lines.push(`${tc} 원문: ${r.seg.text.replace(/\n/g, " / ")}`);
    if (r.error) lines.push(`  ⚠ 검사 실패: ${r.error}`);
    else if (r.corrected !== r.seg.text) lines.push(`  수정: ${r.corrected.replace(/\n/g, " / ")}`);
    for (const i of r.issues || []) lines.push(`  - ${i.type}: ${i.before} → ${i.after}${i.reason ? ` (${i.reason})` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

function spellMarkers(rows) {
  return rows
    .filter(r => !r.error && r.seg.start != null && (r.corrected !== r.seg.text || r.issues.length))
    .map(r => {
      const kinds = [...new Set((r.issues || []).map(i => i.type))];
      const unsure = kinds.length === 1 && kinds[0] === "확인 필요";
      const notes = (r.issues || []).map(i => `- ${i.type}: ${i.before} → ${i.after}${i.reason ? ` (${i.reason})` : ""}`);
      return {
        name: `${AI_PREFIX} 맞춤법] ${clip(kinds.join("·") || "수정 제안", 30)}`,
        start: r.seg.start,
        duration: Math.max(0, (r.seg.end || r.seg.start) - r.seg.start),
        comments: [`원문: ${r.seg.text}`, `수정: ${r.corrected}`].concat(notes).join("\n"),
        color: unsure ? "BLUE" : "YELLOW",
      };
    });
}

function confirmReport(review, meta = {}) {
  const lines = [
    "# 밤샘 콘텐츠 컴퍼니 검수팀 리뷰",
    "",
    `- 시퀀스: ${meta.sequence || ""}`,
    `- 검토 구간: ${formatClock(meta.start)} ~ ${formatClock(meta.end)} · 프레임 ${meta.frames || 0}장`,
    `- 모델: ${meta.model || ""}`,
    "",
    `## 판정: ${review.verdict}`,
    "",
    review.summary,
    "",
  ];
  if (review.goodPoints.length) {
    lines.push("## 잘된 점", "");
    review.goodPoints.forEach(g => lines.push(`- ${g}`));
    lines.push("");
  }
  lines.push(`## 의견 (${review.issues.length}개)`, "");
  if (!review.issues.length) lines.push("- 없음");
  for (const i of review.issues) {
    lines.push(`- [${formatClock(i.time)}] [${i.severity}] ${i.team || "검수팀"} · ${i.category}`);
    if (i.current) lines.push(`  지금: ${i.current}`);
    if (i.suggestion) lines.push(`  제안: ${i.suggestion}`);
    (i.alternatives || []).forEach((a, k) => lines.push(`  대안 ${k + 1}: ${a}`));
    if (i.detail) lines.push(`  이유: ${i.detail}`);
  }
  return lines.join("\n");
}

function confirmMarkers(review) {
  return review.issues.map(i => ({
    name: `${AI_PREFIX} 컨펌·${i.severity}] ${i.team || "검수팀"} · ${clip(i.category + (i.current ? ": " + i.current : ""), 40)}`,
    start: i.time,
    duration: 0,
    comments: [
      i.current && `지금: ${i.current}`,
      i.suggestion && `제안: ${i.suggestion}`,
      ...(i.alternatives || []).map((a, k) => `대안 ${k + 1}: ${a}`),
      i.detail && `이유: ${i.detail}`,
    ].filter(Boolean).join("\n"),
    color: SEVERITY_COLOR[i.severity] || "BLUE",
  }));
}

/** 교정 결과를 반영한 자막 목록 (SRT 저장용) */
function correctedSegments(rows) {
  return rows.map(r => Object.assign({}, r.seg, { text: r.error ? r.seg.text : r.corrected }));
}

module.exports = { AI_PREFIX, spellReport, spellMarkers, confirmReport, confirmMarkers, correctedSegments };
