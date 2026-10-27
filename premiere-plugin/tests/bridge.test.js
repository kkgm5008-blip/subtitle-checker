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
    assert.match(u.origin, /^http:\/\/(127\.0\.0\.1|localhost):(41234|41235|41236|41237|51234)$/);
    assert.equal(init.headers["X-Subtitle-Checker"], "1");
    let body;
    if (overrides[u.pathname]) body = overrides[u.pathname];
    else if (u.pathname === "/health") body = { ok: true, bridge: "1.3.2", version: "2.1.300 (Claude Code)", auth: { checked: true, loggedIn: true, method: "claude.ai" } };
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
  const code = t => bridge.runFailure(t).code;
  assert.equal(code("error: unknown option '--tools'"), "old_claude");
  assert.equal(code("Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win)."), "git_bash");
  assert.equal(code("There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it."), "model_unavailable");
  assert.equal(code("Credit balance is too low"), "api_billing");
  assert.equal(code("OAuth token has expired. Please run /login"), "login_required");
  assert.equal(code("You've hit your limit · resets 3pm"), "usage_limit");
  assert.match(bridge.friendlyRunError("Invalid API key · Please run /login"), /로그인/);
  assert.match(bridge.friendlyRunError("Claude AI usage limit reached|1700000000"), /사용량 한도/);
  assert.match(bridge.friendlyRunError("이상한 오류"), /실행 중 오류: 이상한 오류/);
});

test("연결 프로그램 찾기: 닫힌 포트·다른 프로그램을 건너뛰고, 끊기면 다시 찾음", async () => {
  const seen = [];
  let open = 41236;
  const fetch = async (url, init) => {
    const u = new URL(url);
    seen.push(u.host + u.pathname);
    if (+u.port === 41235) return { ok: true, status: 200, text: async () => "<html>다른 프로그램</html>" };
    if (+u.port !== open) throw new TypeError("connection refused");
    const body = u.pathname === "/health" ? { ok: true, bridge: "1.3.2", version: "v" } : u.pathname === "/jobs" ? { ok: true, id: "j" } : { type: "result", subtype: "success", is_error: false, result: '{"ok":true}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const h = await bridge.health({ fetch });
  assert.equal(h.port, 41236);
  assert.deepEqual(seen.slice(0, 5), ["127.0.0.1:41234/health", "localhost:41234/health", "127.0.0.1:41235/health", "localhost:41235/health", "127.0.0.1:41236/health"]);
  seen.length = 0;
  await bridge.run({ system: "s", content: [{ type: "text", text: "t" }], schema: {}, model: "opus" }, { fetch });
  assert.deepEqual(seen, ["127.0.0.1:41236/jobs", "127.0.0.1:41236/jobs/j/run"], "찾은 포트를 계속 씀");
  // 창을 닫았다가 다시 켜서 포트가 바뀜: 한 번은 꺼져 있다고 알리고, 다음에는 새 포트를 찾음
  open = 41234;
  await assert.rejects(bridge.run({ system: "s", content: [], schema: {}, model: "opus" }, { fetch }), e => e.code === "not_running");
  seen.length = 0;
  await bridge.run({ system: "s", content: [], schema: {}, model: "opus" }, { fetch });
  assert.equal(seen[0], "127.0.0.1:41234/health");
});

test("연결 프로그램이 꺼져 있으면 켜는 방법을 알려 줌", async () => {
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(bridge.health({ fetch: down }), e => e.code === "not_running" && /PowerShell에서 실행/.test(e.message) && /추가 옵션 표시/.test(e.message));
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
  assert.deepEqual(calls.filter(c => c.path !== "/health").map(c => c.method + " " + c.path), ["POST /jobs", "POST /jobs/job1/run"]);
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
