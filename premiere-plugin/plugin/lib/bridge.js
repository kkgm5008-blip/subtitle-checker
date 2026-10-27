"use strict";
/*
 * 구독 모드: 이 PC에서 켜 둔 '구독 연결 프로그램'(bridge/claude-bridge.ps1)을 거쳐
 * Claude Code(claude -p)로 실행합니다. Claude Code에 로그인한 Claude 구독을 쓰므로
 * API 비용이 따로 들지 않고, 구독 사용량에서 차감됩니다.
 *
 * 흐름: POST /jobs → 이미지마다 PUT /jobs/{id}/files/{이름} (base64) → POST /jobs/{id}/run
 * 연결 프로그램은 41234부터 빈 포트를 열어서, 여기서는 포트를 차례로 찾아봅니다 (51234는 1.3.1 이전 버전).
 */

const PORTS = [41234, 41235, 41236, 41237, 51234];
const HOSTS = ["127.0.0.1", "localhost"];
const BRIDGE_VERSION = "1.3.2";
const HEADERS = { "X-Subtitle-Checker": "1" };
const HEALTH_TIMEOUT = 12000; // 연결 프로그램은 이때 claude auth status를 돌려서 몇 초 걸릴 수 있음
const RUN_TIMEOUT = 30 * 60 * 1000;

let found = null; // { base, port }

class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BridgeError";
    this.code = code || "";
  }
}

const NOT_RUNNING = "구독 연결 프로그램이 꺼져 있어요. 설치 묶음(zip)을 푼 폴더에서 claude-bridge.ps1을 마우스 오른쪽 버튼으로 눌러 'PowerShell에서 실행'을 고르세요 (윈도우 11은 '추가 옵션 표시' 안에 있어요). 파란 창에 '준비 완료'가 보이면 그 창을 켜 둔 채로 다시 눌러 주세요.";

/** 프리미어 안에서는 XMLHttpRequest로 (Adobe 예제가 localhost에 쓰는 방식), 그 밖에서는 fetch */
function xhr(url, init) {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open(init.method || "GET", url);
    Object.keys(init.headers || {}).forEach(k => req.setRequestHeader(k, init.headers[k]));
    req.timeout = init.timeout || RUN_TIMEOUT;
    req.onload = () => resolve({ ok: req.status >= 200 && req.status < 300, status: req.status, text: async () => req.responseText });
    req.onerror = () => reject(new Error("network"));
    req.ontimeout = () => reject(new Error("timeout"));
    req.send(init.body || null);
  });
}

const transport = opts => opts.fetch || (typeof XMLHttpRequest !== "undefined" ? xhr : fetch);

async function request(url, init, fetchImpl) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), init.timeout || RUN_TIMEOUT); });
  let text;
  try {
    const res = await Promise.race([fetchImpl(url, Object.assign({}, init, { headers: Object.assign({}, HEADERS, init.headers || {}) })), timeout]);
    text = await Promise.race([res.text(), timeout]);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* 아래에서 처리 */ }
  return data;
}

/** 켜져 있는 연결 프로그램을 포트·주소를 바꿔 가며 찾음. /health 응답을 돌려줌 */
async function locate(fetchImpl) {
  found = null;
  for (const port of PORTS) {
    for (const host of HOSTS) {
      const base = `http://${host}:${port}`;
      const t0 = Date.now();
      let data;
      try { data = await request(base + "/health", { method: "GET", timeout: HEALTH_TIMEOUT }, fetchImpl); } catch (e) {
        // 바로 거절되면 localhost로 한 번 더, 오래 걸렸으면 다른 프로그램이 붙잡고 있는 포트라 다음 포트로
        if (Date.now() - t0 > 3000) break;
        continue;
      }
      if (!data || typeof data.ok !== "boolean") continue; // 다른 프로그램이 쓰는 포트
      found = { base, port };
      return Object.assign({ port }, data);
    }
  }
  throw new BridgeError(NOT_RUNNING, "not_running");
}

async function call(path, init, fetchImpl) {
  if (!found) await locate(fetchImpl);
  let res;
  try {
    res = await fetchImpl(found.base + path, Object.assign({}, init, { headers: Object.assign({}, HEADERS, init.headers || {}) }));
  } catch (e) {
    found = null; // 창을 닫았다 다시 켰으면 포트가 바뀌었을 수 있음
    throw new BridgeError(NOT_RUNNING, "not_running");
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* 아래에서 처리 */ }
  if (!data) throw new BridgeError("구독 연결 프로그램의 응답을 읽지 못했어요. 프로그램 창을 닫고 다시 켜 주세요.", "bad_response");
  if (data.ok === false) throw bridgeFailure(data);
  return data;
}

const CLAUDE_NOT_FOUND = "PC에서 Claude Code를 찾지 못했어요. PowerShell을 열고 irm https://claude.ai/install.ps1 | iex 로 설치한 뒤, claude 를 한 번 실행해 내 Claude 계정으로 로그인해 주세요.";

function bridgeFailure(data) {
  if (data.error === "claude_not_found") return new BridgeError(CLAUDE_NOT_FOUND, data.error);
  if (data.error === "claude_failed") {
    const f = runFailure(data.detail);
    return new BridgeError(f.message, f.code);
  }
  return new BridgeError(`구독 연결 프로그램 오류: ${data.detail || data.error}`, data.error);
}

/**
 * 연결 프로그램과 Claude Code 상태
 * @returns {Promise<{port:number, bridge:string, version:string, auth:?{checked,loggedIn,method,plan,email}}>}
 */
async function health(opts = {}) {
  const data = await locate(transport(opts));
  if (data.ok === false) throw bridgeFailure(data);
  return data;
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

/** Claude Code가 남긴 오류 글을 알아듣기 쉬운 말과 종류(code)로 */
function runFailure(result) {
  const t = String(result || "");
  if (/unknown option|unknown command|invalid (choice|value)|argument .* is invalid/i.test(t)) {
    return { code: "old_claude", message: "Claude Code가 옛 버전이에요. PowerShell에서 claude update 를 실행한 뒤 다시 시도해 주세요." };
  }
  if (/git-?bash|CLAUDE_CODE_GIT_BASH_PATH/i.test(t)) {
    return { code: "git_bash", message: "Claude Code가 Git Bash를 찾지 못했어요. https://git-scm.com/downloads/win 에서 Git for Windows를 설치하고, PowerShell에서 claude update 를 한 뒤 연결 프로그램을 다시 켜 주세요." };
  }
  if (/usage limit|rate limit|limit reached|사용량|hit your limit|out of extra usage/i.test(t)) {
    return { code: "usage_limit", message: "Claude 구독 사용량 한도에 걸렸어요. 한도가 풀린 뒤 다시 시도하거나, 프레임 수를 줄이거나 설정에서 Sonnet으로 바꿔 보세요." };
  }
  if (/(model|opus|sonnet|haiku)/i.test(t) && /not (found|available|supported|included)|no access|access to|upgrade|invalid model|issue with the selected model/i.test(t)) {
    return { code: "model_unavailable", message: "지금 구독 요금제에서 이 모델을 쓸 수 없어요. 설정 탭에서 Sonnet으로 바꿔 보세요." };
  }
  if (/log ?in|\/login|not logged|authenticat|invalid api key|oauth|401|credential/i.test(t)) {
    return { code: "login_required", message: "Claude Code 로그인이 필요해요. PowerShell을 새로 열고 claude 를 실행한 뒤 /login 으로 내 Claude 계정(구독)에 로그인하고, 연결 프로그램 창을 닫았다가 다시 켜 주세요." };
  }
  if (/credit balance|billing/i.test(t)) {
    return { code: "api_billing", message: "Claude Code가 구독이 아니라 API 계정으로 로그인돼 있어요. claude 를 실행해 /logout 후 /login 에서 'Claude 계정(구독)'으로 다시 로그인해 주세요." };
  }
  return { code: "run_failed", message: "Claude Code 실행 중 오류: " + t.slice(0, 300) };
}

function friendlyRunError(result) {
  return runFailure(result).message;
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
  if (out.is_error || (out.subtype && out.subtype !== "success")) {
    const f = runFailure(out.result || out.subtype);
    throw new BridgeError(f.message, f.code);
  }
  return { result: extractJson(out.result), model: p.model };
}

module.exports = { PORTS, BRIDGE_VERSION, BridgeError, health, run, toJob, extractJson, friendlyRunError, runFailure };
