"use strict";
/*
 * 구독 모드: 이 PC에서 켜 둔 '구독 연결 프로그램'(bridge/claude-bridge.ps1)을 거쳐
 * Claude Code(claude -p)로 실행합니다. Claude Code에 로그인한 Claude 구독을 쓰므로
 * API 비용이 따로 들지 않고, 구독 사용량에서 차감됩니다.
 *
 * 흐름: POST /jobs → 이미지마다 PUT /jobs/{id}/files/{이름} (base64) → POST /jobs/{id}/run
 */

const BRIDGE_URL = "http://127.0.0.1:51234";
const HEADERS = { "X-Subtitle-Checker": "1" };

class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BridgeError";
    this.code = code || "";
  }
}

const NOT_RUNNING = "구독 연결 프로그램이 꺼져 있어요. PC에서 claude-bridge.ps1을 마우스 오른쪽 버튼으로 눌러 'PowerShell에서 실행'으로 켜 주세요.";

/** 프리미어 안에서는 XMLHttpRequest로 (Adobe 예제가 localhost에 쓰는 방식), 그 밖에서는 fetch */
function xhr(url, init) {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open(init.method || "GET", url);
    Object.keys(init.headers || {}).forEach(k => req.setRequestHeader(k, init.headers[k]));
    req.timeout = 30 * 60 * 1000;
    req.onload = () => resolve({ ok: req.status >= 200 && req.status < 300, status: req.status, text: async () => req.responseText });
    req.onerror = () => reject(new Error("network"));
    req.ontimeout = () => reject(new Error("timeout"));
    req.send(init.body || null);
  });
}

const transport = opts => opts.fetch || (typeof XMLHttpRequest !== "undefined" ? xhr : fetch);

async function call(path, init, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(BRIDGE_URL + path, Object.assign({}, init, { headers: Object.assign({}, HEADERS, init.headers || {}) }));
  } catch (e) {
    throw new BridgeError(NOT_RUNNING, "not_running");
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* 아래에서 처리 */ }
  if (!data) throw new BridgeError("구독 연결 프로그램의 응답을 읽지 못했어요. 프로그램 창을 닫고 다시 켜 주세요.", "bad_response");
  if (data.ok === false) {
    if (data.error === "claude_not_found") throw new BridgeError("PC에서 Claude Code를 찾지 못했어요. 설치하고 한 번 로그인한 뒤 구독 연결 프로그램을 다시 켜 주세요.", data.error);
    throw new BridgeError(`구독 연결 프로그램 오류: ${data.detail || data.error}`, data.error);
  }
  return data;
}

async function health(opts = {}) {
  return call("/health", { method: "GET" }, transport(opts));
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

/** Messages API 형식의 content 블록을 프롬프트 글 + 이미지 파일 목록으로 바꿈 */
function toJob(content) {
  const files = [];
  const parts = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") {
      const ext = block.source.media_type === "image/png" ? "png" : "jpg";
      const name = `frame_${pad3(files.length + 1)}.${ext}`;
      files.push({ name, data: block.source.data });
      parts.push(`(이미지 파일: ${name})`);
    }
  }
  return { files, text: parts.join("\n\n") };
}

function outputRule(schema, imageCount) {
  const read = imageCount
    ? `이 작업 폴더에 이미지 ${imageCount}장(frame_001 …)이 있습니다. 위에 적힌 순서대로 Read 도구로 모두 열어 본 뒤 판단하세요. 못 본 이미지에 대해 추측하지 마세요.\n\n`
    : "";
  return `${read}[답하는 방법]\n아래 JSON 스키마를 따르는 JSON 객체 하나만 출력하세요. 앞뒤 설명이나 코드 블록 표시 없이 JSON만 씁니다.\n${JSON.stringify(schema)}`;
}

/** Claude Code가 돌려준 글에서 JSON 객체를 꺼냄 */
function extractJson(text) {
  const s = String(text || "").trim();
  const tries = [s, s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a !== -1 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") return v;
    } catch (e) { /* 다음 방법 */ }
  }
  throw new BridgeError("Claude 답에서 결과를 읽지 못했어요. 다시 시도해 주세요.", "bad_json");
}

function friendlyRunError(result) {
  const t = String(result || "");
  if (/log ?in|\/login|not logged|authenticat|invalid api key|oauth/i.test(t)) {
    return "Claude Code 로그인이 필요해요. PC에서 PowerShell을 열고 claude 를 한 번 실행해 로그인한 뒤 다시 시도해 주세요.";
  }
  if (/usage limit|rate limit|limit reached|사용량/i.test(t)) {
    return "Claude 구독 사용량 한도에 걸렸어요. 한도가 풀린 뒤 다시 시도하거나, 프레임 수를 줄여 보세요.";
  }
  if (/model/i.test(t) && /not (found|available)|access/i.test(t)) {
    return "지금 구독 요금제에서 이 모델을 쓸 수 없어요. 설정 탭에서 Sonnet으로 바꿔 보세요.";
  }
  return "Claude Code 실행 중 오류: " + t.slice(0, 300);
}

/**
 * @param {object} p
 * @param {string} p.system 시스템 프롬프트
 * @param {Array} p.content Messages API 형식 content 블록 (text, image)
 * @param {object} p.schema 결과 JSON 스키마
 * @param {string} p.model "opus" | "sonnet" | "haiku"
 */
async function run(p, opts = {}) {
  const fetchImpl = transport(opts);
  const job = toJob(p.content);
  const { id } = await call("/jobs", { method: "POST" }, fetchImpl);
  for (let i = 0; i < job.files.length; i++) {
    const f = job.files[i];
    await call(`/jobs/${id}/files/${f.name}`, { method: "PUT", headers: { "content-type": "text/plain" }, body: f.data }, fetchImpl);
    if (opts.onUpload) opts.onUpload(i + 1, job.files.length);
  }
  const prompt = `${job.text}\n\n${outputRule(p.schema, job.files.length)}`;
  const out = await call(`/jobs/${id}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ system: p.system, prompt, model: p.model }),
  }, fetchImpl);
  if (out.is_error || (out.subtype && out.subtype !== "success")) throw new BridgeError(friendlyRunError(out.result || out.subtype), "run_failed");
  return { result: extractJson(out.result), model: p.model };
}

module.exports = { BRIDGE_URL, BridgeError, health, run, toJob, extractJson, friendlyRunError };
