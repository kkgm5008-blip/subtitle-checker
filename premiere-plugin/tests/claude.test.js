"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const claude = require(path.join(__dirname, "..", "plugin", "lib", "claude.js"));

function reply(obj, extra = {}) {
  return Object.assign({
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 1000, output_tokens: 500 },
  }, extra);
}

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    return {
      ok: r.status === 200,
      status: r.status,
      headers: { get: k => (r.headers || {})[k] || null },
      json: async () => r.body,
    };
  };
}

/** 구조화 출력 스키마 규칙: 모든 object에 additionalProperties:false, properties의 키가 모두 required */
function assertStrictSchema(schema, where = "root") {
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${where}: additionalProperties`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${where}: required`);
    for (const [k, v] of Object.entries(schema.properties)) assertStrictSchema(v, `${where}.${k}`);
  } else if (schema.type === "array") {
    assertStrictSchema(schema.items, `${where}[]`);
  }
  for (const banned of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    assert.equal(schema[banned], undefined, `${where}: ${banned} 미지원`);
  }
}

test("스키마가 구조화 출력 제한을 지킴", () => {
  assertStrictSchema(claude.SPELL_SCHEMA);
  assertStrictSchema(claude.CONFIRM_SCHEMA);
});

test("요청 모양: 헤더, 모델, 폴백, 출력 형식", () => {
  const req = claude.buildRequest({ apiKey: "k", model: "claude-opus-5-5", system: "s", content: [{ type: "text", text: "t" }], schema: { type: "object" }, effort: "high" });
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "k");
  assert.equal(req.headers["anthropic-version"], "2026-10-21");
  assert.equal(req.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(req.body.fallbacks, "default");
  assert.deepEqual(req.body.output_config, { effort: "high", format: { type: "json_schema", schema: { type: "object" } } });
  assert.equal(req.body.thinking, undefined, "Opus 5.5는 thinking을 보내지 않음");
  assert.equal(req.body.temperature, undefined);

  const haiku = claude.buildRequest({ apiKey: "k", model: "claude-haiku-5-5", system: "s", content: [], schema: {} });
  assert.equal(haiku.body.fallbacks, undefined, "Haiku에는 폴백 없음");
  assert.equal(haiku.headers["anthropic-beta"], undefined);

  const unknown = claude.buildRequest({ apiKey: "k", model: "gpt-x", system: "s", content: [], schema: {} });
  assert.equal(unknown.body.model, claude.DEFAULT_MODEL);
});

test("맞춤법 검사: 요청 내용과 결과 정리", async () => {
  const calls = [];
  const batch = [{ id: 1, start: 1.5, text: "안되요\n진짜" }, { id: 2, start: 3, text: "좋아요" }, { id: 3, start: null, text: "할께요" }];
  const fetch = fakeFetch([{ status: 200, body: reply({ fixes: [
    { id: 1, corrected: "안 돼요\n진짜", issues: [{ type: "맞춤법", before: "안되요", after: "안 돼요", reason: "돼요" }] },
    { id: 2, corrected: "좋아요", issues: [] },
    { id: 99, corrected: "없는 번호", issues: [] },
    { id: 3, corrected: "할게요", issues: [{ type: "맞춤법", before: "할께요", after: "할게요", reason: "" }] },
  ] }) }], calls);
  const res = await claude.checkSpelling({ apiKey: "k", model: "claude-sonnet-5-5", batch }, { fetch });
  assert.deepEqual([...res.fixes.keys()], [1, 3]);
  assert.equal(res.fixes.get(1).corrected, "안 돼요\n진짜");
  assert.ok(res.cost.dollars > 0);
  const sent = calls[0].body;
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.equal(sent.output_config.effort, "medium");
  const prompt = sent.messages[0].content[0].text;
  assert.ok(prompt.includes('[1] (0:01.5) "안되요\\n진짜"'), prompt);
  assert.ok(prompt.includes('[3] "할께요"'));
});

test("자막 묶음 나누기", () => {
  const segs = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, start: i, text: "가".repeat(50) }));
  const batches = claude.batchSegments(segs, 6000, 80);
  assert.ok(batches.length >= 3);
  assert.equal(batches.flat().length, 200);
  assert.ok(batches.every(b => b.length <= 80));
});

test("컨펌: 프레임 라벨·이미지 순서, 결과 정리", async () => {
  const calls = [];
  const frames = [{ time: 1.5, mediaType: "image/jpeg", data: "AAA" }, { time: 4.5, mediaType: "image/png", data: "BBB" }];
  const info = { name: "시퀀스 01", start: 0, end: 6, width: 1920, height: 1080, frameCount: 2 };
  const fetch = fakeFetch([{ status: 200, body: reply({
    verdict: "수정 후 컨펌", summary: "좋아요", good_points: ["색감"],
    issues: [
      { time: 99, team: "검수팀", category: "맞춤법", severity: "필수", current: "할께요", suggestion: "할게요", alternatives: [], detail: "" },
      { time: 1.4, category: "이상한값", severity: "몰라", current: "", suggestion: "", detail: "x" },
      { time: 3, team: "없는팀", category: "멘트", severity: "권장", current: "안녕", suggestion: "안녕하세요 여러분", alternatives: ["하나", " ", "둘", "셋", "넷"], detail: "" },
    ],
  }) }], calls);
  const channel = { about: "반려견 브이로그", audience: "", tone: "귀엽게" };
  const res = await claude.reviewVideo({ apiKey: "k", model: "claude-opus-5-5", frames, segments: [{ id: 1, start: 1, text: "안녕\n하세요" }], brief: "밝게", focus: "text", channel, info }, { fetch });
  const content = calls[0].body.messages[0].content;
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text.includes("시퀀스 01") && content[0].text.includes("밝게") && content[0].text.includes("안녕 / 하세요"));
  assert.ok(content[0].text.includes("- 채널·브랜드: 반려견 브이로그\n- 톤앤매너: 귀엽게"), "채널 정보, 빈 칸은 뺌");
  assert.match(calls[0].body.system, /검수팀장/);
  assert.deepEqual(content.slice(1, 5).map(c => c.type), ["text", "image", "text", "image"]);
  assert.ok(content[1].text.includes("[프레임 1] 0:01.5"));
  assert.deepEqual(content[4].source, { type: "base64", media_type: "image/png", data: "BBB" });
  assert.equal(calls[0].body.output_config.effort, "high");

  const r = res.review;
  assert.equal(r.verdict, "수정 후 컨펌");
  assert.deepEqual(r.issues.map(i => i.time), [1.4, 3, 6], "구간 밖 시간은 끝으로, 시간순 정렬");
  assert.equal(r.issues[0].category, "기타");
  assert.equal(r.issues[0].severity, "참고");
  assert.equal(r.issues[0].team, "검수팀", "팀이 없으면 분야로 정함");
  assert.equal(r.issues[1].team, "카피라이팅팀", "모르는 팀 이름은 분야 담당 팀으로");
  assert.deepEqual(r.issues[1].alternatives, ["하나", "둘", "셋"], "빈 대안 빼고 최대 3개");
  assert.deepEqual(r.issues[2].alternatives, []);
  assert.equal(r.issues[0].frame, 0);
  assert.equal(r.issues[2].frame, 1);
});

test("오류: 거절, 길이 초과, 키 오류, 재시도", async () => {
  assert.throws(() => claude.readJson(reply({}, { stop_reason: "refusal", content: [] })), /처리하지 않았어요/);
  assert.throws(() => claude.readJson(reply({}, { stop_reason: "max_tokens" })), /끊겼어요/);

  const calls = [];
  const bad = fakeFetch([{ status: 401, body: { error: { message: "invalid x-api-key" } } }], calls);
  await assert.rejects(claude.ping({ apiKey: "k", model: "claude-opus-5-5" }, { fetch: bad }), e => e.status === 401 && /API 키/.test(e.message));

  const calls2 = [];
  const flaky = fakeFetch([
    { status: 529, body: { error: { message: "overloaded" } } },
    { status: 429, body: {}, headers: { "retry-after": "1" } },
    { status: 200, body: reply({ ok: true }) },
  ], calls2);
  const slept = [];
  const ok = await claude.ping({ apiKey: "k", model: "claude-opus-5-5" }, { fetch: flaky, sleep: async ms => slept.push(ms) });
  assert.equal(ok, true);
  assert.equal(calls2.length, 3);
  assert.deepEqual(slept, [2000, 1000]);
});
