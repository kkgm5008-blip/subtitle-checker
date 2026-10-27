"use strict";
/*
 * Claude API 호출: 자막 맞춤법 검사와 영상 컨펌(프레임 + 자막 검토).
 *
 * Adobe UXP는 Anthropic SDK가 지원하는 런타임(Node, 브라우저 등)이 아니고
 * 이 플러그인은 빌드 단계 없이 그대로 설치되므로, Messages API를 fetch로 직접 호출합니다.
 */

const { formatClock } = require("./srt.js");

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// 가격: 100만 토큰당 달러 (입력 / 출력)
const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 (가장 꼼꼼함 · 기본)", input: 4, output: 20, fallback: true },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 (절반 가격)", input: 2, output: 10, fallback: true },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 (가장 저렴 · 맞춤법용)", input: 0.1, output: 0.5, fallback: false },
};
const DEFAULT_MODEL = "claude-opus-5-5";

class ClaudeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ClaudeError";
    this.status = status || 0;
  }
}

function modelInfo(model) {
  return MODELS[model] || MODELS[DEFAULT_MODEL];
}

function buildRequest({ apiKey, model, system, content, schema, effort, maxTokens }) {
  const id = MODELS[model] ? model : DEFAULT_MODEL;
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const body = {
    model: id,
    max_tokens: maxTokens || 16000,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: effort || "high", format: { type: "json_schema", schema } },
  };
  // 안전 분류기가 거절하면 서버에서 권장 모델로 다시 실행 (Haiku에는 대체 모델이 없음)
  if (modelInfo(id).fallback) {
    headers["anthropic-beta"] = FALLBACK_BETA;
    body.fallbacks = "default";
  }
  return { url: API_URL, headers, body };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function friendlyError(status, detail, model) {
  const d = detail ? ` (${detail})` : "";
  if (status === 401) return "API 키가 올바르지 않아요. 설정 탭에서 키를 다시 확인해 주세요.";
  if (status === 403) return "이 API 키로는 요청할 수 없어요" + d;
  if (status === 404) return `모델을 찾을 수 없어요 (${model}). 설정 탭에서 다른 모델을 골라 주세요.`;
  if (status === 413) return "보내는 프레임이 너무 많거나 커요. 최대 프레임 수나 프레임 크기를 줄여 주세요.";
  if (status === 429) return "Claude 사용량 한도에 걸렸어요. 잠시 후 다시 시도해 주세요" + d;
  if (status >= 500) return "Claude 서버가 혼잡해요. 잠시 후 다시 시도해 주세요.";
  return "요청이 거절됐어요" + d;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function send(request, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const sleep = opts.sleep || wait;
  const retries = opts.retries != null ? opts.retries : 2;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
    } catch (e) {
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      throw new ClaudeError("Claude에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
    if (res.ok) return res.json();
    let detail = "";
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ""; } catch (e) { /* 본문 없음 */ }
    if (RETRYABLE.has(res.status) && attempt < retries) {
      const after = +((res.headers && res.headers.get && res.headers.get("retry-after")) || 0);
      await sleep(Math.min(30000, after > 0 ? after * 1000 : 2000 * Math.pow(2, attempt)));
      continue;
    }
    throw new ClaudeError(friendlyError(res.status, detail, request.body.model), res.status);
  }
}

/** 구조화 출력(JSON) 응답을 꺼냄 */
function readJson(data) {
  if (!data || !Array.isArray(data.content)) throw new ClaudeError("Claude 응답을 읽지 못했어요.");
  if (data.stop_reason === "refusal") {
    throw new ClaudeError("Claude가 이 요청을 처리하지 않았어요. 요청사항이나 프레임 구간을 바꿔 다시 시도해 주세요.");
  }
  if (data.stop_reason === "max_tokens") {
    throw new ClaudeError("응답이 너무 길어 중간에 끊겼어요. 프레임 수나 자막 수를 줄여서 다시 시도해 주세요.");
  }
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ClaudeError("Claude 응답 형식이 깨졌어요. 다시 시도해 주세요.");
  }
}

function usageCost(model, usage) {
  if (!usage) return null;
  const info = modelInfo(model);
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const output = usage.output_tokens || 0;
  return { input, output, dollars: (input * info.input + output * info.output) / 1e6 };
}

async function ask(params, opts) {
  const request = buildRequest(params);
  const data = await send(request, opts);
  return { result: readJson(data), cost: usageCost(request.body.model, data.usage), model: data.model || request.body.model };
}

/* ───────── 맞춤법 검사 ───────── */

const SPELL_TYPES = ["맞춤법", "띄어쓰기", "오타", "문장부호", "외래어 표기", "확인 필요"];

const SPELL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixes"],
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "corrected", "issues"],
        properties: {
          id: { type: "integer", description: "자막 번호" },
          corrected: { type: "string", description: "고친 자막 전체. 원문의 줄바꿈 위치 유지" },
          issues: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "before", "after", "reason"],
              properties: {
                type: { type: "string", enum: SPELL_TYPES },
                before: { type: "string", description: "원문에서 틀린 부분 그대로" },
                after: { type: "string", description: "고친 표기" },
                reason: { type: "string", description: "한 문장 이유" },
              },
            },
          },
        },
      },
    },
  },
};

const SPELL_SYSTEM = `당신은 한국어 영상 자막 교정 전문가입니다. 국립국어원 표준 맞춤법, 띄어쓰기, 외래어 표기법을 기준으로 자막의 틀린 표기만 고칩니다.

규칙:
- 뜻, 말투(반말·존댓말), 구어체, 유행어, 의도적인 줄임말·감탄사·사투리는 바꾸지 않습니다. 틀린 표기만 고칩니다.
- 자막은 문장 끝 마침표를 생략하는 관례가 있으니 마침표가 없는 것은 오류가 아닙니다. 원문의 문장부호 스타일을 따릅니다.
- 원문의 줄바꿈(\\n)과 서식 태그(<i>, {\\an8} 등)는 그대로 둡니다.
- 인명·상호·브랜드·작품명은 명백한 오타가 아니면 그대로 둡니다.
- 문맥상 틀렸을 수도 있지만 확신이 없는 곳은 corrected에 반영하지 말고 issues에 type "확인 필요"로만 남깁니다.
- 고칠 곳이 없는 자막은 fixes에 넣지 않습니다.`;

/** 요청 하나에 너무 많은 자막이 들어가지 않게 나눔 */
function batchSegments(segments, maxChars = 6000, maxCount = 80) {
  const batches = [];
  let cur = [], size = 0;
  for (const s of segments) {
    const len = String(s.text).length + 20;
    if (cur.length && (cur.length >= maxCount || size + len > maxChars)) { batches.push(cur); cur = []; size = 0; }
    cur.push(s); size += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function spellPrompt(batch) {
  const lines = batch.map(s => `[${s.id}]${s.start != null ? ` (${formatClock(s.start)})` : ""} ${JSON.stringify(s.text)}`);
  return `다음은 영상 자막입니다. 각 줄은 [번호] (시간) "자막" 형식이고, 자막은 JSON 문자열로 적혀 있습니다.\n\n${lines.join("\n")}\n\n고칠 곳이 있는 자막만 fixes에 넣으세요. 모두 맞으면 fixes를 빈 배열로 두세요.`;
}

/**
 * @param {Array<{id:number,start:?number,text:string}>} batch
 * @returns {Promise<{fixes: Map<number,{corrected:string,issues:Array}>, cost}>}
 */
async function checkSpelling({ apiKey, model, batch }, opts) {
  const { result, cost } = await ask({
    apiKey, model, system: SPELL_SYSTEM, schema: SPELL_SCHEMA, effort: "medium", maxTokens: 16000,
    content: [{ type: "text", text: spellPrompt(batch) }],
  }, opts);
  return { fixes: normalizeFixes(result, batch), cost };
}

function normalizeFixes(result, batch) {
  const byId = new Map(batch.map(s => [s.id, s]));
  const fixes = new Map();
  for (const f of (result && result.fixes) || []) {
    const seg = byId.get(f.id);
    if (!seg) continue;
    const corrected = typeof f.corrected === "string" && f.corrected.trim() ? f.corrected : seg.text;
    const issues = Array.isArray(f.issues) ? f.issues.filter(i => i && (i.before || i.after || i.reason)) : [];
    if (corrected === seg.text && !issues.length) continue;
    fixes.set(f.id, { corrected, issues });
  }
  return fixes;
}

/* ───────── 영상 컨펌 ───────── */

const VERDICTS = ["컨펌", "수정 후 컨펌", "재작업 필요"];
const SEVERITIES = ["필수", "권장", "참고"];
const CATEGORIES = ["맞춤법", "띄어쓰기", "오타", "자막 가독성", "자막 내용", "화면 구성", "색·밝기", "브랜드·로고", "요청사항", "기타"];

const CONFIRM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "good_points", "issues"],
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    summary: { type: "string", description: "편집자에게 주는 총평 2~4문장" },
    good_points: { type: "array", items: { type: "string" }, description: "잘된 점 0~3개" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "category", "severity", "current", "suggestion", "detail"],
        properties: {
          time: { type: "number", description: "문제가 보인 프레임의 시간(초). 프레임 라벨의 초 값" },
          category: { type: "string", enum: CATEGORIES },
          severity: { type: "string", enum: SEVERITIES },
          current: { type: "string", description: "지금 화면에 있는 그대로 (틀린 글자는 정확히 인용)" },
          suggestion: { type: "string", description: "이렇게 바꾸면 됨" },
          detail: { type: "string", description: "왜 문제인지 한두 문장" },
        },
      },
    },
  },
};

const FOCUS = {
  all: "전체 컨펌: 맞춤법·자막·화면 구성·요청사항을 모두 봅니다.",
  text: "자막·맞춤법 위주: 화면에 보이는 모든 글자와 자막을 집중적으로 봅니다. 화면 구성은 심각한 문제만 짚습니다.",
  visual: "화면·편집 위주: 구성, 빈 화면, 색·밝기, 브랜드 노출을 집중적으로 봅니다. 글자는 명백한 오타만 짚습니다.",
};

const CONFIRM_SYSTEM = `당신은 영상 편집 결과물을 업로드 전에 최종 검수(컨펌)하는 시니어 PD입니다. 편집자가 보낸 시퀀스의 프레임(정지 화면)과 자막 목록을 보고, 고쳐야 할 점을 시간과 함께 구체적으로 알려줍니다. 편집자가 바로 고칠 수 있게 '지금 상태'와 '바꿀 내용'을 짧고 정확하게 씁니다.

검토 항목:
1. 화면에 보이는 모든 글자(자막, 타이틀, 그래픽, 하단 이름표)의 맞춤법·띄어쓰기·오타. 틀린 글자는 current에 화면 그대로 인용하고 suggestion에 고친 글을 씁니다.
2. 자막 가독성: 화면 밖으로 잘림, 배경과 겹쳐 안 읽힘, 한 줄이 너무 김, 세이프 영역 침범, 글자 크기·위치가 장면마다 들쭉날쭉함.
3. 자막 내용: 자막 목록이 있으면 화면 내용과 어긋나는 곳, 같은 말의 표기가 앞뒤로 다른 곳(예: 브이로그/VLOG).
4. 화면 구성: 검은 화면·빈 프레임, 지우지 않은 기본 문구('텍스트 입력', 'Title Here' 등)나 워터마크, 초점이 나간 컷, 장면 사이 급격한 색·밝기 차이, 로고·브랜드 노출 문제.
5. 요청사항(브리프)과 어긋나는 점.

규칙:
- 프레임은 시간 간격을 두고 뽑은 정지 화면입니다. 움직임, 소리, 컷 사이의 내용은 볼 수 없으니 추측하지 않습니다.
- time에는 문제를 본 프레임 라벨의 초 값을 그대로 씁니다. 같은 문제가 여러 프레임에 이어지면 처음 보인 프레임 하나로 묶습니다.
- severity: 업로드 전에 반드시 고칠 것은 "필수", 고치면 좋아지는 것은 "권장", 취향 차이나 확인이 필요한 것은 "참고".
- verdict: 필수가 없으면 "컨펌", 필수가 있지만 부분 수정으로 끝나면 "수정 후 컨펌", 전체를 다시 손봐야 하면 "재작업 필요".
- 고칠 점이 없으면 issues를 빈 배열로 둡니다. 문제를 지어내지 않습니다.`;

function confirmIntro({ info, brief, focus, segments }) {
  const parts = [];
  parts.push(`[시퀀스]\n- 이름: ${info.name || "(이름 없음)"}\n- 검토 구간: ${formatClock(info.start)} ~ ${formatClock(info.end)} (총 ${Math.round(info.end - info.start)}초)\n- 화면 크기: ${info.width}x${info.height}\n- 보내는 프레임: ${info.frameCount}장`);
  parts.push(`[검토 초점]\n${FOCUS[focus] || FOCUS.all}`);
  parts.push(`[편집자 요청사항]\n${(brief || "").trim() || "(없음. 일반적인 업로드 기준으로 검토하세요.)"}`);
  if (segments && segments.length) {
    let budget = 20000;
    const lines = [];
    for (const s of segments) {
      const line = `- ${s.start != null ? formatClock(s.start) : `#${s.id}`} ${s.text.replace(/\n/g, " / ")}`;
      if ((budget -= line.length) < 0) { lines.push(`- (이후 ${segments.length - lines.length}개 생략)`); break; }
      lines.push(line);
    }
    parts.push(`[자막 목록]\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * @param {object} p
 * @param {Array<{time:number, data:string, mediaType:string}>} p.frames base64 이미지
 */
function confirmContent(p) {
  const content = [{ type: "text", text: confirmIntro(p) }];
  p.frames.forEach((f, i) => {
    content.push({ type: "text", text: `[프레임 ${i + 1}] ${formatClock(f.time)} (${f.time.toFixed(2)}초)` });
    content.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
  });
  content.push({ type: "text", text: "위 프레임과 자막을 검토 항목대로 보고 컨펌 결과를 주세요." });
  return content;
}

async function reviewVideo(p, opts) {
  const { result, cost, model } = await ask({
    apiKey: p.apiKey, model: p.model, system: CONFIRM_SYSTEM, schema: CONFIRM_SCHEMA, effort: "high", maxTokens: 32000,
    content: confirmContent(p),
  }, opts);
  return { review: normalizeReview(result, p.frames, p.info), cost, model };
}

function normalizeReview(r, frames, info) {
  const times = frames.map(f => f.time);
  const nearest = t => times.reduce((best, x, i) => (Math.abs(x - t) < Math.abs(times[best] - t) ? i : best), 0);
  const issues = (Array.isArray(r && r.issues) ? r.issues : []).map(it => {
    let t = +it.time;
    if (!isFinite(t)) t = info.start;
    t = Math.min(info.end, Math.max(info.start, t));
    return {
      time: t,
      frame: times.length ? nearest(t) : -1,
      category: CATEGORIES.includes(it.category) ? it.category : "기타",
      severity: SEVERITIES.includes(it.severity) ? it.severity : "참고",
      current: String(it.current || ""),
      suggestion: String(it.suggestion || ""),
      detail: String(it.detail || ""),
    };
  }).sort((a, b) => a.time - b.time);
  return {
    verdict: VERDICTS.includes(r && r.verdict) ? r.verdict : issues.some(i => i.severity === "필수") ? "수정 후 컨펌" : "컨펌",
    summary: String((r && r.summary) || ""),
    goodPoints: (Array.isArray(r && r.good_points) ? r.good_points : []).map(String).filter(Boolean),
    issues,
  };
}

/** 연결 테스트: 가장 작은 요청 */
async function ping({ apiKey, model }, opts) {
  const { result } = await ask({
    apiKey, model, effort: "low", maxTokens: 2000,
    system: "연결 테스트입니다. ok를 true로 답하세요.",
    schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    content: [{ type: "text", text: "연결 확인" }],
  }, opts);
  return !!result.ok;
}

module.exports = {
  MODELS, DEFAULT_MODEL, ClaudeError, buildRequest, send, readJson, usageCost,
  SPELL_TYPES, SPELL_SCHEMA, batchSegments, spellPrompt, checkSpelling, normalizeFixes,
  VERDICTS, SEVERITIES, CATEGORIES, CONFIRM_SCHEMA, confirmContent, reviewVideo, normalizeReview, ping,
};
