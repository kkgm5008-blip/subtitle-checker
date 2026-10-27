"use strict";
/*
 * 자막 파일(SRT / VTT / TXT) 파싱과 생성.
 * 저장소 루트의 srt_io.py와 같은 규칙을 따르되, VTT의 글자 큐 이름과
 * 시(hour)가 빠진 타임코드(00:01.000)도 읽습니다.
 */

const TIME_RE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTimestamp(ts) {
  const m = TIME_RE.exec(ts || "");
  if (!m) return 0;
  const h = +(m[1] || 0), mi = +m[2], s = +m[3];
  const ms = +(m[4] + "00").slice(0, 3);
  return h * 3600 + mi * 60 + s + ms / 1000;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

/** SRT 형식 타임코드 (00:01:02,345) */
function formatTimestamp(seconds) {
  const totalMs = Math.round(Math.max(0, seconds || 0) * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** 화면 표시용 짧은 시간 (1:02.3, 1:02:03) */
function formatClock(seconds) {
  if (seconds == null || isNaN(seconds)) return "";
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h) return `${h}:${pad(m, 2)}:${pad(Math.floor(s), 2)}`;
  return `${m}:${pad(s.toFixed(1), 4)}`;
}

function normalize(content) {
  return String(content || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function parseSrt(content) {
  const blocks = normalize(content).trim().split(/\n\s*\n/);
  const segments = [];
  let autoIdx = 1;
  for (const block of blocks) {
    const lines = block.split("\n").filter(l => l.trim() !== "");
    const timeAt = lines.findIndex(l => l.includes("-->"));
    if (timeAt === -1) continue;
    const idx = timeAt === 1 && /^\d+$/.test(lines[0].trim()) ? parseInt(lines[0], 10) : autoIdx;
    const [startStr, endStr] = lines[timeAt].split("-->");
    const text = lines.slice(timeAt + 1).join("\n").trim();
    if (!text) continue;
    segments.push({ index: idx, start: parseTimestamp(startStr), end: parseTimestamp(endStr), text });
    autoIdx = idx + 1;
  }
  return segments;
}

function parseVtt(content) {
  return parseSrt(normalize(content).replace(/^WEBVTT[^\n]*\n/, ""));
}

/** 타임코드가 없는 일반 텍스트(.txt)를 줄 단위로 나눔. 너무 긴 줄은 문장 단위로 다시 나눔 */
function splitPlainText(text, maxLen = 450) {
  const lines = normalize(text).split("\n").map(l => l.trim()).filter(Boolean);
  const segments = [];
  const push = t => segments.push({ index: segments.length + 1, start: null, end: null, text: t });
  for (const line of lines) {
    if (line.length <= maxLen) { push(line); continue; }
    let buf = "";
    for (const part of line.split(/(?<=[.!?。！？])\s+/)) {
      if (buf && buf.length + part.length + 1 > maxLen) { push(buf); buf = part; }
      else buf = (buf + " " + part).trim();
    }
    if (buf) push(buf);
  }
  return segments;
}

function parseSubtitleFile(name, content) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (ext === "srt") return parseSrt(content);
  if (ext === "vtt") return parseVtt(content);
  if (ext === "txt") return splitPlainText(content);
  throw new Error(`지원하지 않는 파일 형식입니다: .${ext} (srt, vtt, txt만 가능)`);
}

function writeSrt(segments) {
  return segments.map((seg, i) => {
    const start = seg.start || 0;
    const end = seg.end != null ? seg.end : start + 2;
    return `${i + 1}\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${seg.text}\n`;
  }).join("\n");
}

/** UTF-8이 아닌 파일(EUC-KR 등)을 UTF-8로 읽으면 깨진 글자(�)가 생김 */
function looksGarbled(text) {
  const bad = (String(text).match(/�/g) || []).length;
  return bad > 3;
}

module.exports = { parseTimestamp, formatTimestamp, formatClock, parseSrt, parseVtt, splitPlainText, parseSubtitleFile, writeSrt, looksGarbled };
