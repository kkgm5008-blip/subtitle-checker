"use strict";
/*
 * Claude 호출: 자막 맞춤법 검사와 영상 컨펌(프레임 + 자막 검토).
 *
 * 두 가지 방식:
 * - "subscription": PC의 Claude Code(내 Claude 구독)로 실행. bridge.js 참고.
 * - "api": Anthropic API 키로 Messages API 호출 (사용한 만큼 과금).
 *   Adobe UXP는 Anthropic SDK가 지원하는 런타임(Node, 브라우저 등)이 아니고
 *   이 플러그인은 빌드 단계 없이 그대로 설치되므로, Messages API를 fetch로 직접 호출합니다.
 */

const { formatClock } = require("./srt.js");
const bridge = require("./bridge.js");

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// 가격: 100만 토큰당 달러 (입력 / 출력)
// alias: 구독 모드에서 Claude Code에 넘기는 모델 이름
const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 (가장 꼼꼼함 · 기본)", alias: "opus", input: 4, output: 20, fallback: true },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 (빠름 · API 절반 가격)", alias: "sonnet", input: 2, output: 10, fallback: true },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 (가장 가벼움 · 맞춤법용)", alias: "haiku", input: 0.1, output: 0.5, fallback: false },
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
  if (params.mode === "subscription") {
    const { result } = await bridge.run({
      system: params.system, content: params.content, schema: params.schema, model: modelInfo(params.model).alias,
    }, opts);
    return { result, cost: null, model: params.model };
  }
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
async function checkSpelling({ mode, apiKey, model, batch }, opts) {
  const { result, cost } = await ask({
    mode, apiKey, model, system: SPELL_SYSTEM, schema: SPELL_SCHEMA, effort: "medium", maxTokens: 16000,
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

/* ───────── 화면 보고 받아 적기 (그래픽 자막 글자 읽기) ───────── */

const OCR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenes"],
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scene", "blocks"],
        properties: {
          scene: { type: "integer", description: "장면 번호" },
          blocks: { type: "array", items: { type: "string" }, description: "따로 떨어진 글자 상자마다 하나. 상자 안 줄바꿈은 \\n" },
        },
      },
    },
  },
};

const OCR_SYSTEM = `당신은 영상 자막을 받아 적는 속기사입니다. 각 이미지는 프리미어 시퀀스의 한 장면입니다. 편집하면서 얹은 글자(자막, 타이틀, 설명 그래픽, 이름표, 강조 문구)를 화면에 보이는 그대로 받아 적습니다.

규칙:
- 받아 적은 글로 맞춤법 검사를 할 것이므로 맞춤법·띄어쓰기·오타·문장부호를 절대 고치지 않습니다. 틀린 글자도 화면 그대로 적습니다.
- 띄어쓰기도 화면 그대로입니다. 한 상자 안에서 줄이 바뀐 곳은 \\n으로 적습니다.
- 위치나 디자인이 달라 따로 떨어진 글자 상자는 blocks에 따로 넣습니다. 한 상자는 한 항목입니다.
- 촬영된 화면 속 글자(간판, 제품 포장, 옷의 글씨, 화면 녹화 속 메뉴 글자 등)와 이모지 그림은 넣지 않습니다.
- 편집으로 얹은 글자가 없는 장면은 blocks를 빈 배열로 둡니다.
- 흐리거나 가려져 읽기 어려운 글자는 보이는 만큼만 적고, 지어내지 않습니다.
- 모든 장면을 scenes에 장면 번호와 함께 넣습니다.`;

function ocrContent(shots) {
  const content = [{ type: "text", text: `장면 ${shots.length}개입니다. 장면마다 편집으로 얹은 글자를 화면 그대로 받아 적어 주세요.` }];
  shots.forEach((s, i) => {
    content.push({ type: "text", text: `[장면 ${i + 1}] ${formatClock(s.time)}` });
    content.push({ type: "image", source: { type: "base64", media_type: s.mediaType, data: s.data } });
  });
  return content;
}

/**
 * @param {Array<{time:number, data:string, mediaType:string}>} p.shots base64 이미지
 * @returns {Promise<{blocks:string[][], cost}>} shots와 같은 순서
 */
async function readScreenText(p, opts) {
  const { result, cost } = await ask({
    mode: p.mode, apiKey: p.apiKey, model: p.model, system: OCR_SYSTEM, schema: OCR_SCHEMA, effort: "medium", maxTokens: 16000,
    content: ocrContent(p.shots),
  }, opts);
  return { blocks: normalizeScenes(result, p.shots.length), cost };
}

function normalizeScenes(result, n) {
  const out = Array.from({ length: n }, () => []);
  for (const sc of (result && result.scenes) || []) {
    const k = +sc.scene - 1;
    if (!(k >= 0 && k < n) || !Array.isArray(sc.blocks)) continue;
    out[k] = sc.blocks.map(b => String(b == null ? "" : b).replace(/\\n/g, "\n").trim()).filter(Boolean);
  }
  return out;
}

/* ───────── 영상 컨펌: 밤샘 콘텐츠 컴퍼니 검수팀 리뷰 ───────── */

const VERDICTS = ["컨펌", "수정 후 컨펌", "재작업 필요"];
const SEVERITIES = ["필수", "권장", "참고"];
const CATEGORIES = [
  "맞춤법", "띄어쓰기", "오타", "자막 가독성", "자막 내용",
  "자막 느낌", "멘트", "디자인", "편집 호흡",
  "화면 구성", "색·밝기", "브랜드·로고", "요청사항", "기타",
];
// 검수팀이 주관하고, 분야별로 컴퍼니의 담당 팀이 의견을 냄
const TEAMS = ["검수팀", "카피라이팅팀", "디자인팀", "영상제작팀", "브랜딩팀"];
const TEAM_OF = {
  맞춤법: "검수팀", 띄어쓰기: "검수팀", 오타: "검수팀", "자막 내용": "검수팀", 요청사항: "검수팀", 기타: "검수팀",
  "자막 느낌": "카피라이팅팀", 멘트: "카피라이팅팀",
  디자인: "디자인팀", "자막 가독성": "디자인팀", "색·밝기": "디자인팀",
  "편집 호흡": "영상제작팀", "화면 구성": "영상제작팀",
  "브랜드·로고": "브랜딩팀",
};

const CONFIRM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "good_points", "issues"],
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    summary: { type: "string", description: "검수팀장이 편집자에게 주는 총평 2~4문장" },
    good_points: { type: "array", items: { type: "string" }, description: "잘된 점 0~3개" },
    issues: {
      type: "array",
      description: "시간순 의견. 꼭 고칠 오류와 더 좋게 만드는 제안을 함께",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "team", "category", "severity", "current", "suggestion", "alternatives", "detail"],
        properties: {
          time: { type: "number", description: "그 장면 프레임 라벨의 초 값" },
          team: { type: "string", enum: TEAMS, description: "의견을 낸 팀" },
          category: { type: "string", enum: CATEGORIES },
          severity: { type: "string", enum: SEVERITIES },
          current: { type: "string", description: "지금 화면·자막 그대로 (글자는 정확히 인용)" },
          suggestion: { type: "string", description: "가장 추천하는 수정안. 자막·멘트는 바꿀 문구 그대로, 디자인은 바로 따라 할 수 있게 구체적으로" },
          alternatives: { type: "array", items: { type: "string" }, description: "다른 느낌의 대안 0~3개 (자막·멘트·디자인 제안일 때)" },
          detail: { type: "string", description: "왜 이렇게 바꾸면 좋은지 한두 문장" },
        },
      },
    },
  },
};

const FOCUS = {
  all: "전체 리뷰: 업로드 전에 꼭 고칠 오류와, 더 좋게 만드는 제안(자막 느낌·멘트·디자인·편집 호흡)을 모두 냅니다.",
  text: "오류 위주: 맞춤법·오타·자막 가독성·화면 실수처럼 꼭 고칠 것을 집중해서 봅니다. 제안은 효과가 큰 것 몇 개만 냅니다.",
  visual: "제안 위주: 자막 느낌, 멘트, 디자인, 편집 호흡을 더 좋게 만드는 제안을 넉넉히 냅니다. 명백한 오류도 함께 짚습니다.",
};

const CONFIRM_SYSTEM = `당신은 AI 콘텐츠 회사 '밤샘 콘텐츠 컴퍼니'의 검수팀장 석지안입니다. 편집자가 프리미어에서 보낸 영상(시간 간격으로 뽑은 정지 화면 + 자막 목록)을 검수팀이 주관해서 보고, 분야별로 컴퍼니 팀들의 의견을 모아 "몇 분 몇 초에 이렇게 바꾸면 좋겠다"는 피드백을 줍니다.

팀별 담당:
- 검수팀: 화면 속 모든 글자(자막, 타이틀, 그래픽, 이름표)의 맞춤법·띄어쓰기·오타, 자막과 화면 내용 불일치, 같은 말의 표기 흔들림(예: 브이로그/VLOG), 요청사항 위반, 지우지 않은 기본 문구('텍스트 입력', 'Title Here')나 워터마크.
- 카피라이팅팀: 자막 느낌과 멘트. 자막 말투·길이·강조가 장면 분위기와 맞는지, 첫 자막이 스크롤을 멈추게 하는지, 밋밋하거나 설명조인 멘트를 더 후킹·공감·위트 있게 바꿀 수 있는지. 바꿀 문구를 그대로 써 주고, alternatives에 결이 다른 대안(예: 위트형, 공감형, 정보형)을 2~3개 줍니다.
- 디자인팀: 자막 디자인(글꼴 굵기, 크기, 색, 외곽선·배경 박스, 위치·세이프 영역), 강조 단어 색, 그래픽·이모지·스티커, 장면 사이 색·밝기 차이. 편집자가 바로 따라 할 수 있게 구체적으로 씁니다 (예: "하단 중앙, 흰 글자 + 검은 외곽선 4px, 강조 단어만 노란색").
- 영상제작팀: 편집 호흡. 첫 3초 후킹, 같은 화면이 오래 이어지는 구간(같은 장면 프레임이 연속), 컷 순서, 마지막 저장·구독 유도.
- 브랜딩팀: 채널 톤앤매너와 어긋나는 표현·디자인, 로고·브랜드 노출.

규칙:
- 프레임은 정지 화면입니다. 소리와 움직임은 볼 수 없으니 추측하지 않습니다. 멘트는 자막 목록과 화면 글자를 기준으로 봅니다. 편집 호흡은 프레임 시간과 장면 변화로만 판단합니다.
- time에는 그 장면 프레임 라벨의 초 값을 그대로 씁니다. 같은 문제가 여러 프레임에 이어지면 처음 프레임 하나로 묶습니다.
- 의견마다 current(지금)와 suggestion(추천 수정안)을 구체적으로 씁니다. "더 재밌게", "임팩트 있게" 같은 막연한 말만 쓰지 않습니다.
- severity: 업로드 전에 반드시 고칠 오류는 "필수", 하면 확실히 좋아지는 제안은 "권장", 취향·선택 사항은 "참고". 취향 제안을 "필수"로 올리지 않습니다.
- 의견은 영상 길이에 맞게 효과 큰 순서로 최대 20개까지. 좋은 장면을 억지로 고치지 않고, 문제나 제안을 지어내지 않습니다.
- verdict: 필수가 없으면 "컨펌", 필수가 있지만 부분 수정으로 끝나면 "수정 후 컨펌", 전체를 다시 손봐야 하면 "재작업 필요".
- 채널 정보가 있으면 타깃과 톤앤매너에 맞춰 제안합니다.`;

function confirmIntro({ info, brief, focus, segments, channel }) {
  const parts = [];
  parts.push(`[시퀀스]\n- 이름: ${info.name || "(이름 없음)"}\n- 검토 구간: ${formatClock(info.start)} ~ ${formatClock(info.end)} (총 ${Math.round(info.end - info.start)}초)\n- 화면 크기: ${info.width}x${info.height}${info.height > info.width ? " (세로 영상: 릴스·쇼츠)" : ""}\n- 보내는 프레임: ${info.frameCount}장`);
  const ch = channel || {};
  const chLines = [["채널·브랜드", ch.about], ["타깃 시청자", ch.audience], ["톤앤매너", ch.tone]].filter(([, v]) => v && String(v).trim());
  parts.push(`[채널 정보]\n${chLines.length ? chLines.map(([k, v]) => `- ${k}: ${String(v).trim()}`).join("\n") : "- (입력 없음. 일반적인 유튜브·릴스 기준으로 판단하세요.)"}`);
  parts.push(`[검토 초점]\n${FOCUS[focus] || FOCUS.all}`);
  parts.push(`[편집자 요청사항]\n${(brief || "").trim() || "(없음)"}`);
  if (segments && segments.length) {
    let budget = 20000;
    const lines = [];
    for (const s of segments) {
      const line = `- ${s.start != null ? formatClock(s.start) : `#${s.id}`} ${s.text.replace(/\n/g, " / ")}`;
      if ((budget -= line.length) < 0) { lines.push(`- (이후 ${segments.length - lines.length}개 생략)`); break; }
      lines.push(line);
    }
    parts.push(`[자막 목록 (멘트)]\n${lines.join("\n")}`);
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
  content.push({ type: "text", text: "위 프레임과 자막을 팀별 담당대로 보고 검수팀 리뷰를 주세요." });
  return content;
}

async function reviewVideo(p, opts) {
  const { result, cost, model } = await ask({
    mode: p.mode, apiKey: p.apiKey, model: p.model, system: CONFIRM_SYSTEM, schema: CONFIRM_SCHEMA, effort: "high", maxTokens: 32000,
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
    const category = CATEGORIES.includes(it.category) ? it.category : "기타";
    return {
      time: t,
      frame: times.length ? nearest(t) : -1,
      team: TEAMS.includes(it.team) ? it.team : TEAM_OF[category],
      category,
      severity: SEVERITIES.includes(it.severity) ? it.severity : "참고",
      current: String(it.current || ""),
      suggestion: String(it.suggestion || ""),
      alternatives: (Array.isArray(it.alternatives) ? it.alternatives : []).map(a => String(a || "").trim()).filter(Boolean).slice(0, 3),
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
async function ping({ mode, apiKey, model }, opts) {
  const { result } = await ask({
    mode, apiKey, model, effort: "low", maxTokens: 2000,
    system: "연결 테스트입니다. ok를 true로 답하세요.",
    schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    content: [{ type: "text", text: "연결 확인" }],
  }, opts);
  return !!result.ok;
}

module.exports = {
  MODELS, DEFAULT_MODEL, ClaudeError, buildRequest, send, readJson, usageCost,
  SPELL_TYPES, SPELL_SCHEMA, batchSegments, spellPrompt, checkSpelling, normalizeFixes,
  OCR_SCHEMA, readScreenText, normalizeScenes,
  VERDICTS, SEVERITIES, CATEGORIES, TEAMS, CONFIRM_SCHEMA, confirmContent, reviewVideo, normalizeReview, ping,
};
