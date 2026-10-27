"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const lib = name => require(path.join(__dirname, "..", "plugin", "lib", name));
const bridge = lib("bridge.js");
const claude = lib("claude.js");

/** 구독 연결 프로그램 흉내: 요청을 기록하고 run에는 Claude Code의 --output-format json 모양으로 답함 */
function fakeBridge(answer, calls, overrides = {}) {
  return async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method, headers: init.headers, body: init.body });
    assert.equal(u.origin, "http://127.0.0.1:51234");
    assert.equal(init.headers["X-Subtitle-Checker"], "1");
    let body;
    if (overrides[u.pathname]) body = overrides[u.pathname];
    else if (u.pathname === "/health") body = { ok: true, version: "2.1.300 (Claude Code)" };
    else if (u.pathname === "/jobs") body = { ok: true, id: "job1" };
    else if (/\/files\//.test(u.pathname)) body = { ok: true };
    else if (u.pathname === "/jobs/job1/run") {
      const job = JSON.parse(init.body);
      body = { type: "result", subtype: "success", is_error: false, result: answer(job) };
    }
    return { ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
}

test("content 블록 → 프롬프트 글 + 이미지 파일", () => {
  const job = bridge.toJob([
    { type: "text", text: "소개" },
    { type: "text", text: "[프레임 1]" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "BBB" } },
  ]);
  assert.deepEqual(job.files, [{ name: "frame_001.jpg", data: "AAA" }, { name: "frame_002.png", data: "BBB" }]);
  assert.equal(job.text, "소개\n\n[프레임 1]\n\n(이미지 파일: frame_001.jpg)\n\n(이미지 파일: frame_002.png)");
});

test("답에서 JSON 꺼내기: 그대로, 코드 블록, 앞뒤 설명", () => {
  assert.deepEqual(bridge.extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(bridge.extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(bridge.extractJson('결과입니다:\n{"a":{"b":3}}\n끝'), { a: { b: 3 } });
  assert.throws(() => bridge.extractJson("JSON 없음"), /결과를 읽지 못했어요/);
});

test("실행 오류 메시지", () => {
  assert.match(bridge.friendlyRunError("Invalid API key · Please run /login"), /로그인/);
  assert.match(bridge.friendlyRunError("Claude AI usage limit reached|1700000000"), /사용량 한도/);
  assert.match(bridge.friendlyRunError("이상한 오류"), /실행 중 오류: 이상한 오류/);
});

test("연결 프로그램이 꺼져 있으면 켜는 방법을 알려 줌", async () => {
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(bridge.health({ fetch: down }), e => e.code === "not_running" && /PowerShell에서 실행/.test(e.message));
  const calls = [];
  const noClaude = fakeBridge(() => "", calls, { "/health": { ok: false, error: "claude_not_found" } });
  await assert.rejects(bridge.health({ fetch: noClaude }), /Claude Code를 찾지 못했어요/);
});

test("구독 모드 맞춤법: 모델 별칭, 프롬프트 규칙, 결과 정리, 비용 없음", async () => {
  const calls = [];
  const fetch = fakeBridge(job => {
    assert.equal(job.model, "sonnet");
    assert.match(job.system, /자막 교정 전문가/);
    assert.match(job.prompt, /\[1\] \(0:01\.0\) "안되요"/);
    assert.match(job.prompt, /JSON 객체 하나만/);
    assert.match(job.prompt, /"fixes"/);
    assert.doesNotMatch(job.prompt, /Read 도구/, "이미지가 없으면 Read 안내 없음");
    return "```json\n" + JSON.stringify({ fixes: [{ id: 1, corrected: "안 돼요", issues: [] }] }) + "\n```";
  }, calls);
  const res = await claude.checkSpelling({ mode: "subscription", model: "claude-sonnet-5-5", batch: [{ id: 1, start: 1, text: "안되요" }] }, { fetch });
  assert.equal(res.fixes.get(1).corrected, "안 돼요");
  assert.equal(res.cost, null);
  assert.deepEqual(calls.map(c => c.method + " " + c.path), ["POST /jobs", "POST /jobs/job1/run"]);
});

test("구독 모드 컨펌: 프레임을 파일로 올리고 Read 안내, 판정 정리", async () => {
  const calls = [];
  const ups = [];
  const fetch = fakeBridge(job => {
    assert.equal(job.model, "opus");
    assert.match(job.prompt, /\[프레임 1\] 0:01\.5 \(1\.50초\)\n\n\(이미지 파일: frame_001\.jpg\)/);
    assert.match(job.prompt, /이미지 2장/);
    assert.match(job.prompt, /Read 도구로 모두 열어/);
    return JSON.stringify({ verdict: "컨펌", summary: "좋아요", good_points: [], issues: [] });
  }, calls);
  const frames = [{ time: 1.5, mediaType: "image/jpeg", data: "AAA" }, { time: 3, mediaType: "image/jpeg", data: "BBB" }];
  const info = { name: "S", start: 0, end: 5, width: 1920, height: 1080, frameCount: 2 };
  const res = await claude.reviewVideo({ mode: "subscription", model: "claude-opus-5-5", frames, segments: [], brief: "", focus: "all", info }, { fetch, onUpload: (i, n) => ups.push(`${i}/${n}`) });
  assert.equal(res.review.verdict, "컨펌");
  assert.equal(res.cost, null);
  assert.deepEqual(ups, ["1/2", "2/2"]);
  const puts = calls.filter(c => c.method === "PUT");
  assert.deepEqual(puts.map(c => c.path), ["/jobs/job1/files/frame_001.jpg", "/jobs/job1/files/frame_002.jpg"]);
  assert.equal(puts[0].body, "AAA");
});

test("구독 모드: Claude Code가 로그인 오류를 내면 로그인 안내", async () => {
  const calls = [];
  const fetch = fakeBridge(() => "", calls, { "/jobs/job1/run": { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" } });
  await assert.rejects(claude.ping({ mode: "subscription", model: "claude-opus-5-5" }, { fetch }), e => e.name === "BridgeError" && /로그인이 필요해요/.test(e.message));
});
