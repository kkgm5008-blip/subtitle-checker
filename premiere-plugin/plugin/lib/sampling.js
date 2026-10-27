"use strict";
/* 컨펌용 프레임을 어느 시점에서 뽑을지 정하고, 크기와 비용을 어림합니다. */

const MIN_GAP = 0.5;

function dedupe(times) {
  const out = [];
  for (const t of times.slice().sort((a, b) => a - b)) {
    if (!out.length || t - out[out.length - 1] >= MIN_GAP) out.push(t);
  }
  return out;
}

/** 처음과 끝을 지키면서 고르게 count개만 남김 */
function thin(times, count) {
  if (times.length <= count) return times;
  if (count <= 1) return [times[Math.floor(times.length / 2)]];
  const out = [];
  for (let k = 0; k < count; k++) out.push(times[Math.round(k * (times.length - 1) / (count - 1))]);
  return dedupe(out);
}

function round2(t) {
  return Math.round(t * 100) / 100;
}

/**
 * @param {object} o
 * @param {number} o.start 구간 시작(초)
 * @param {number} o.end 구간 끝(초)
 * @param {number} o.interval 몇 초마다 한 장
 * @param {number} o.maxFrames 최대 장수
 * @param {Array<{start:number,end:number}>} [o.segments] 자막 구간
 * @param {boolean} [o.perSegment] 자막 구간마다 한 장 (자막 없는 긴 구간은 interval로 채움)
 */
function planFrameTimes(o) {
  const start = Math.max(0, +o.start || 0);
  const end = Math.max(start, +o.end || 0);
  const interval = Math.max(0.5, +o.interval || 3);
  const maxFrames = Math.max(1, Math.floor(+o.maxFrames || 40));
  if (end - start < 0.05) return [round2(start)];

  const timed = (o.segments || []).filter(s => s.start != null && s.end != null && s.end > start && s.start < end);
  let times = [];
  if (o.perSegment && timed.length) {
    const sorted = timed.slice().sort((a, b) => a.start - b.start);
    let cursor = start - interval / 2;
    for (const s of sorted) {
      const a = Math.max(start, s.start), b = Math.min(end, s.end);
      for (let t = cursor + interval; t <= a - interval / 2; t += interval) times.push(t);
      times.push((a + b) / 2);
      cursor = Math.max(cursor, b);
    }
    for (let t = cursor + interval; t < end; t += interval) times.push(t);
  } else {
    for (let t = start + Math.min(interval / 2, (end - start) / 2); t < end; t += interval) times.push(t);
  }
  times = times.map(t => Math.min(end - 0.04, Math.max(start, t)));
  return thin(dedupe(times), maxFrames).map(round2);
}

/** 시퀀스 비율을 지키며 긴 변을 longEdge로 (원본보다 키우지 않음, 짝수 픽셀) */
function frameSize(seqWidth, seqHeight, longEdge) {
  const w = +seqWidth || 1920, h = +seqHeight || 1080;
  const scale = Math.min(1, (+longEdge || 1280) / Math.max(w, h));
  const even = v => Math.max(2, Math.round(v * scale / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** Claude가 이미지 한 장에 쓰는 대략의 입력 토큰 */
function imageTokens(width, height) {
  return Math.ceil((width * height) / 750);
}

module.exports = { planFrameTimes, frameSize, imageTokens };
