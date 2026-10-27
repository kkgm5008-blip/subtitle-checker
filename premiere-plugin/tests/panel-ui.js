"use strict";
/*
 * 패널 화면 통합 테스트: jsdom에 index.html을 띄우고 premierepro·uxp·Anthropic API를 가짜로 바꿔
 * 맞춤법 검사 → 마커 → SRT 저장 → 그래픽 텍스트 읽기 → AI 컨펌 → 마커 정리까지 눌러 봅니다.
 * 실행: cd premiere-plugin && npm install && npm test
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const assert = require("assert/strict");
const { JSDOM } = require("jsdom");

const PLUGIN = process.argv[2] || path.join(__dirname, "..", "plugin");
const html = fs.readFileSync(path.join(PLUGIN, "index.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
const dom = new JSDOM(html, { url: "https://plugin.local/" });
const { window } = dom;

/* ---------- premierepro mock ---------- */
const log = { seeks: [], exports: [], transactions: [] };
let markers = [];
const temp = new Map();
const tick = s => ({ seconds: s, ticks: String(Math.round(s * 254016000000)) });

function component(match, params, display = "") {
  return {
    getMatchName: async () => match,
    getDisplayName: async () => display,
    getParamCount: () => params.length,
    // 프리미어 26처럼 '소스 텍스트'가 null이면 시간값도 비어 있음
    getParam: i => ({ displayName: params[i][0], getStartValue: async () => params[i][1], getValueAtTime: async () => (params[i][1] == null ? "" : params[i][1]) }),
  };
}
function clip(start, end, comps, name = "clip") {
  return {
    getStartTime: async () => tick(start), getEndTime: async () => tick(end), getName: async () => name, getInPoint: async () => tick(0),
    getComponentChain: async () => ({ getComponentCount: () => comps.length, getComponentAtIndex: i => comps[i] }),
  };
}
const nativeText = (display, name, start, end) => clip(start, end, [component("AE.ADBE Motion", []), component("AE.ADBE Text", [["소스 텍스트", null], ["글꼴", { value: { value: "Pretendard" } }]], display)], name);
// 화면에 실제로 보이는 글자 (가짜 Claude가 받아 적음)
const SCREEN = [
  { start: 2, end: 4, text: "오늘은 브이로그를 찍어볼께요" },
  { start: 5, end: 7, text: "구독 좋아요" },
  { start: 8, end: 9, text: "다음에 또 봐요!" },
  { start: 11, end: 13, text: "그럼 안되요" },
  { start: 0, end: 20, text: "코코의 하루" },
];
const tracks = [
  [clip(0, 10, [component("AE.ADBE Motion", [["Position", 1]])])],
  [
    clip(2, 4, [component("AE.ADBE Motion", []), component("AE.ADBE Text", [["Source Text", { value: { value: "\u0000\u0003" + JSON.stringify({ mTextParam: { textEditValue: "오늘은 브이로그를 찍어볼께요" } }) } }], ["Font", { value: { value: "Arial" } }]])]),
    clip(5, 7, [component("AE.ADBE Capsule", [["Text", { getText: () => "구독 좋아요" }]])]),
    nativeText("텍스트(다음에 또 봐요)", "그래픽", 8, 9),
    nativeText("텍스트", "그래픽", 11, 13),
  ],
  [nativeText("텍스트", "코코의 하루", 0, 20)],
];
const sequence = {
  name: "브이로그 01",
  getEndTime: async () => tick(60), getInPoint: async () => tick(10), getOutPoint: async () => tick(30),
  getFrameSize: async () => ({ width: 1920, height: 1080 }),
  setPlayerPosition: async t => { log.seeks.push(t.seconds); return true; },
  getPlayerPosition: async () => tick(12),
  getVideoTrackCount: async () => tracks.length,
  getVideoTrack: async i => ({ getTrackItems: () => tracks[i] }),
};
const project = {
  lockedAccess(cb) { cb(); },
  executeTransaction(cb, label) {
    const actions = [];
    cb({ addAction: a => actions.push(a) });
    log.transactions.push({ label, actions });
    for (const a of actions) a.apply();
    return true;
  },
  getActiveSequence: async () => sequence,
};
function makeMarker(name, start, dur, comments) {
  const m = { name, start, dur, comments, color: null };
  return Object.assign(m, {
    getName: () => m.name, getStart: () => tick(m.start), getComments: () => m.comments,
    createSetColorByIndexAction: idx => ({ apply: () => { m.color = idx; } }),
  });
}
const ppro = {
  Project: { getActiveProject: async () => project },
  TickTime: { createWithSeconds: tick, TIME_ZERO: tick(0) },
  Constants: { TrackItemType: { CLIP: 1 }, MarkerColor: { GREEN: 0, RED: 1, MAGENTA: 3, ORANGE: 4, YELLOW: 5, BLUE: 6, CYAN: 7 } },
  Marker: { MARKER_TYPE_COMMENT: "Comment" },
  Markers: {
    getMarkers: async () => ({
      getMarkers: () => markers.slice(),
      createAddMarkerAction: (name, type, start, dur, comments) => ({ apply: () => markers.push(makeMarker(name, start.seconds, dur.seconds, comments)) }),
      createRemoveMarkerAction: m => ({ apply: () => { markers = markers.filter(x => x !== m); } }),
    }),
  },
  Exporter: {
    exportSequenceFrame: async (seq, t, name, dir, w, h) => {
      assert.equal(seq, sequence); assert.equal(dir, "/tmp/uxp-temp");
      log.exports.push({ t: t.seconds, name, w, h });
      temp.set(name, new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]).buffer);
      return true;
    },
  },
};

/* ---------- uxp mock ---------- */
const saved = [];
let openFile = null;
const secure = new Map();
const formats = { utf8: Symbol("utf8"), binary: Symbol("binary") };
const uxp = {
  host: { name: "premierepro", version: "26.5.0" },
  storage: {
    formats,
    secureStorage: {
      setItem: async (k, v) => secure.set(k, new Uint8Array(Buffer.from(v))),
      getItem: async k => secure.get(k) || null,
      removeItem: async k => { if (!secure.delete(k)) throw new Error("none"); },
    },
    localFileSystem: {
      getTemporaryFolder: async () => ({
        nativePath: "/tmp/uxp-temp",
        getEntry: async name => {
          if (!temp.has(name)) throw new Error("no entry");
          return { name, read: async o => { assert.equal(o.format, formats.binary); return temp.get(name); }, delete: async () => temp.delete(name) };
        },
        getEntries: async () => [...temp.keys()].map(name => ({ name })),
      }),
      getFileForOpening: async opts => { assert.deepEqual(opts.types, ["srt", "vtt", "txt"]); return openFile; },
      getFileForSaving: async (name, opts) => ({ name, write: async t => saved.push({ name, types: opts.types, text: t }) }),
      getPluginFolder: async () => ({ getEntry: async n => ({ read: async () => fs.readFileSync(path.join(PLUGIN, n), "utf8") }) }),
    },
  },
  shell: { openExternal: async url => { log.opened = url; return ""; } },
};

/* ---------- fake Anthropic API + fake 구독 연결 프로그램 ---------- */
const apiCalls = [];
const bridgeCalls = [];
function spellAnswer(text) {
    const fixes = [];
    for (const m of text.matchAll(/\[(\d+)\][^"]*"((?:[^"\\]|\\.)*)"/g)) {
      const t = JSON.parse('"' + m[2] + '"');
      if (t.includes("안되요") || t.includes("볼께요")) {
        fixes.push({ id: +m[1], corrected: t.replace("안되요", "안 돼요").replace("볼께요", "볼게요"), issues: [{ type: "맞춤법", before: "안되요", after: "안 돼요", reason: "‘되어요’의 준말" }] });
      }
    }
    return { fixes };
}
const REVIEW = { verdict: "수정 후 컨펌", summary: "전체 흐름은 좋아요. 자막 오타 하나만 고치면 됩니다.", good_points: ["컷 호흡이 좋아요"],
  issues: [{ time: 15.5, team: "검수팀", category: "맞춤법", severity: "필수", current: "볼께요", suggestion: "볼게요", alternatives: [], detail: "‘-ㄹ게요’가 표준" },
    { time: 22.5, team: "카피라이팅팀", category: "멘트", severity: "참고", current: "다음에 또 봐요", suggestion: "다음 편: 코코 첫 수영", alternatives: ["구독하면 코코가 웃어요", "다음 주에 또 만나요"], detail: "마지막 자막에 다음 편 예고" }] };
/** "[장면 k] 0:08.6" 라벨을 읽어 그때 화면에 보이는 글자를 돌려줌 */
function ocrAnswer(text) {
  const scenes = [];
  for (const m of text.matchAll(/\[장면 (\d+)\] (\d+):(\d+(?:\.\d)?)/g)) {
    const t = +m[2] * 60 + +m[3];
    scenes.push({ scene: +m[1], blocks: SCREEN.filter(x => x.start <= t && t < x.end).map(x => x.text) });
  }
  return { scenes };
}
const reply = (status, obj) => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });
let bridgeUp = true;
const bridgeState = { loggedIn: true, noOpus: false };
global.fetch = async (url, init) => {
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) {
    // 연결 프로그램은 41235에서 기다림 (41234는 다른 프로그램이 쓰는 중이라고 가정)
    if (!bridgeUp || new URL(url).port !== "41235") throw new TypeError("fetch failed");
    const p = new URL(url).pathname;
    assert.equal(init.headers["X-Subtitle-Checker"], "1");
    bridgeCalls.push({ method: init.method, path: p, body: init.body });
    if (p === "/health") return reply(200, { ok: true, bridge: "1.3.2", version: "2.1.300 (Claude Code)", auth: { checked: true, loggedIn: bridgeState.loggedIn, method: "claude.ai", plan: "pro" } });
    if (p === "/jobs") return reply(200, { ok: true, id: "j" + bridgeCalls.length });
    if (/\/files\//.test(p)) { assert.equal(init.body, "/9j/AQID"); return reply(200, { ok: true }); }
    const job = JSON.parse(init.body);
    if (bridgeState.noOpus && job.model === "opus") return reply(200, { type: "result", subtype: "success", is_error: true, result: "There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it." });
    const out = /"fixes"/.test(job.prompt) ? spellAnswer(job.prompt) : /"verdict"/.test(job.prompt) ? REVIEW : /"scenes"/.test(job.prompt) ? ocrAnswer(job.prompt) : { ok: true };
    return reply(200, { type: "result", subtype: "success", is_error: false, result: JSON.stringify(out) });
  }
  const body = JSON.parse(init.body);
  apiCalls.push({ url, headers: init.headers, body });
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  const props = body.output_config.format.schema.properties;
  let out;
  if (props.fixes) {
    out = spellAnswer(body.messages[0].content[0].text);
  } else if (props.scenes) {
    out = ocrAnswer(body.messages[0].content.filter(c => c.type === "text").map(c => c.text).join("\n"));
  } else if (props.verdict) {
    const imgs = body.messages[0].content.filter(c => c.type === "image");
    assert.ok(imgs.length > 0 && imgs.every(i => i.source.media_type === "image/jpeg" && i.source.data === "/9j/AQID"));
    out = REVIEW;
  } else {
    out = { ok: true };
  }
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 5000, output_tokens: 800 } }) };
};

/* ---------- globals + module hooks ---------- */
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.Blob = window.Blob;
global.URL.createObjectURL = () => "blob:thumb";
global.URL.revokeObjectURL = () => {};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "premierepro") return ppro;
  if (request === "uxp") return uxp;
  return origLoad.apply(this, arguments);
};

const $ = id => window.document.getElementById(id);
const click = id => $(id).dispatchEvent(new window.Event("click", { bubbles: true }));
const change = (id, v) => { if (typeof v === "boolean") $(id).checked = v; else $(id).value = v; $(id).dispatchEvent(new window.Event("change", { bubbles: true })); };
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));
async function until(pred, what) {
  for (let i = 0; i < 200; i++) { if (pred()) return; await settle(10); }
  throw new Error("timeout waiting for " + what + " — spellMsg=" + $("spellMsg").textContent + " confirmMsg=" + $("confirmMsg").textContent);
}

(async () => {
  await until(() => window.document.readyState === "complete", "jsdom load");
  await settle(50);
  require(path.join(PLUGIN, "main.js"));
  window.dispatchEvent(new window.Event("load"));
  await until(() => /브이로그 01/.test($("seqLine").textContent), "sequence line");
  console.log("seqLine:", $("seqLine").textContent);

  // spell: no segments yet
  click("btnSpellRun"); await settle();
  assert.match($("spellMsg").textContent, /먼저 자막/);

  // ── 구독 모드 (기본값): API 키 없이 PC의 Claude Code로 ──
  assert.equal($("mode").value, "subscription");
  assert.equal($("keyNotice").style.display, "none", "no key notice in subscription mode");
  assert.equal($("subBox").style.display, "");
  assert.equal($("apiBox").style.display, "none");
  bridgeUp = false;
  click("btnTestSub"); await until(() => /꺼져 있어요/.test($("subMsg").textContent), "bridge down message");
  bridgeUp = true;
  click("btnTestSub"); await until(() => /연결됐어요/.test($("subMsg").textContent), "bridge ok");
  console.log("subMsg:", $("subMsg").textContent);
  assert.match($("subMsg").textContent, /1\. 구독 연결 프로그램 ✅ \(v1\.3\.2 · 포트 41235\)\n2\. Claude Code ✅ 2\.1\.300 \(Claude Code\)\n3\. Claude 로그인 ✅ \(pro\)\n4\. Claude Opus 5\.5 응답 ✅/);
  // 로그인이 안 돼 있으면 3단계에서 멈추고 방법을 알려 줌 (Claude에게 묻지 않음)
  bridgeState.loggedIn = false;
  const runsBeforeLogin = bridgeCalls.filter(c => c.path.endsWith("/run")).length;
  click("btnTestSub"); await until(() => /3\. Claude 로그인 ❌/.test($("subMsg").textContent) && !$("btnTestSub").disabled, "not logged in");
  assert.match($("subMsg").textContent, /\/login/);
  assert.equal(bridgeCalls.filter(c => c.path.endsWith("/run")).length, runsBeforeLogin);
  bridgeState.loggedIn = true;
  openFile = { name: "구독.srt", read: async () => "1\n00:00:01,000 --> 00:00:02,000\n그럼 안되요\n" };
  click("btnOpenFile"); await until(() => /1개/.test($("sourceLine").textContent), "srt loaded (sub)");
  click("btnSpellRun"); await until(() => $("spellResult").style.display === "", "spell result (sub)");
  console.log("spellSummary (sub):", $("spellSummary").textContent);
  assert.match($("spellSummary").textContent, /수정 제안 1개 · Claude Opus 5\.5 · 내 구독/);
  assert.doesNotMatch($("spellSummary").textContent, /\$/);
  assert.equal(apiCalls.length, 0, "no API calls in subscription mode");
  change("range", "all"); await settle();
  assert.match($("estimate").textContent, /구독 사용량에서 차감/);
  click("btnConfirm"); await until(() => /검수팀 리뷰가 왔어요/.test($("confirmMsg").textContent), "confirm (sub)");
  const puts = bridgeCalls.filter(c => c.method === "PUT");
  console.log("bridge uploads:", puts.length, "| verdict:", $("verdict").textContent);
  assert.ok(puts.length > 0);
  assert.equal(apiCalls.length, 0);
  assert.doesNotMatch($("confirmMsg").textContent, /비용/);

  // 채널 정보는 저장되고 검수팀 요청에 들어감
  change("chAbout", "반려견 코코 채널"); change("chTone", "귀엽게");
  click("btnConfirm"); await until(() => bridgeCalls.filter(c => c.path.endsWith("/run")).length >= 4, "confirm with channel");
  await until(() => !$("btnConfirm").disabled, "confirm done");
  const lastRun = JSON.parse(bridgeCalls.filter(c => c.path.endsWith("/run")).at(-1).body);
  assert.match(lastRun.prompt, /- 채널·브랜드: 반려견 코코 채널\n- 톤앤매너: 귀엽게/);
  assert.match(lastRun.system, /검수팀장/);

  // ── API 키 모드로 바꾸기 ──
  change("mode", "api"); await settle();
  assert.equal($("subBox").style.display, "none");
  assert.equal($("apiBox").style.display, "");
  assert.equal($("keyNotice").style.display, "", "key notice shown without key");
  log.exports.length = 0;

  // settings: bad key, then good key
  $("apiKey").value = "abc"; click("btnSaveKey"); await settle();
  assert.match($("keyMsg").textContent, /sk-ant-/);
  $("apiKey").value = "sk-ant-test-123"; click("btnSaveKey"); await until(() => /보안 저장소/.test($("keyMsg").textContent), "key saved");
  assert.equal($("keyNotice").style.display, "none");
  click("btnTestKey"); await until(() => /연결됐어요/.test($("keyMsg").textContent), "ping");
  assert.equal(apiCalls.at(-1).headers["x-api-key"], "sk-ant-test-123");
  click("btnGetKey"); await settle();
  assert.match(log.opened, /console\.anthropic\.com/);
  assert.equal($("model").options.length, 3);


  // open SRT
  openFile = { name: "브이로그.srt", read: async () => "1\n00:00:01,000 --> 00:00:02,000\n그럼 안되요\n\n2\n00:00:03,000 --> 00:00:04,000\n좋아요\n\n3\n00:00:15,000 --> 00:00:16,000\n찍어볼께요\n" };
  click("btnOpenFile"); await until(() => /3개/.test($("sourceLine").textContent), "srt loaded");
  console.log("sourceLine:", $("sourceLine").textContent);
  assert.equal($("perSegment").disabled, false);

  // spell check with Claude
  click("btnSpellRun"); await until(() => $("spellResult").style.display === "", "spell result");
  console.log("spellSummary:", $("spellSummary").textContent);
  assert.match($("spellSummary").textContent, /수정 제안 2개/);
  const list = $("spellList");
  assert.equal(list.querySelectorAll(".card").length, 2, "only changed shown");
  assert.ok(list.querySelector(".del") && list.querySelector(".ins"));
  assert.match(list.innerHTML, /␣/, "inserted space visible");
  change("onlyChanged", false); await settle();
  assert.equal(list.querySelectorAll(".card").length, 3);
  change("onlyChanged", true); await settle();

  // seek
  list.querySelector("[data-seek]").dispatchEvent(new window.Event("click", { bubbles: true })); await settle();
  assert.deepEqual(log.seeks, [1]);

  // ignore second suggestion, then markers + srt
  list.querySelectorAll("[data-ignore]")[1].dispatchEvent(new window.Event("click", { bubbles: true })); await settle();
  assert.ok(list.querySelector(".card.ignored"));
  click("btnSpellMarkers"); await until(() => /마커 1개/.test($("spellMsg").textContent), "spell markers");
  assert.equal(markers.length, 1);
  assert.match(markers[0].name, /^\[AI 맞춤법\]/);
  assert.equal(markers[0].color, 5, "YELLOW");
  click("btnSaveSrt"); await until(() => saved.length === 1, "srt saved");
  assert.equal(saved[0].name, "브이로그_교정.srt");
  assert.match(saved[0].text, /그럼 안 돼요/);
  assert.match(saved[0].text, /찍어볼께요/, "ignored suggestion kept original");
  click("btnSpellReport"); await until(() => saved.length === 2, "report saved");
  assert.match(saved[1].text, /자막 맞춤법 검사 리포트/);

  // read timeline graphics (API 모드: 못 읽은 1개는 버튼으로 안내만, 돈이 드니 자동으로 받아 적지 않음)
  assert.match($("engine").options[0].textContent, /API 요금/);
  const callsBefore = apiCalls.length;
  click("btnReadTimeline"); await until(() => /그래픽 5개 중 4개의 글자를 읽었어요/.test($("readMsg").textContent), "timeline read");
  console.log("timeline:", $("sourceLine").textContent, "|", $("readMsg").textContent);
  assert.match($("readMsg").textContent, /1개는 프리미어가 글자를 알려 주지 않아요/);
  assert.match($("sourceLine").textContent, /그래픽 값 2 · 레이어 이름 1 · 클립 이름 1 · 4개/);
  assert.equal(apiCalls.length, callsBefore);
  assert.equal($("spellResult").style.display, "none");
  // 화면 보고 받아 적기: 정확한 값이 없는 3개(레이어 이름·클립 이름·못 읽음)를 화면에서
  log.exports.length = 0;
  click("btnReadScreen"); await until(() => /화면을 보고 3개를 받아 적었어요/.test($("readMsg").textContent), "screen read");
  console.log("screen:", $("sourceLine").textContent, "|", $("readMsg").textContent, "| shots:", log.exports.map(e => e.t).join(","));
  assert.equal(log.exports.length, 3);
  assert.ok(log.exports.every(e => e.w === 1280));
  const ocrReq = apiCalls.at(-1).body;
  assert.ok(ocrReq.output_config.format.schema.properties.scenes);
  assert.equal(ocrReq.messages[0].content.filter(c => c.type === "image").length, 3);
  assert.match($("sourceLine").textContent, /그래픽 값 2 · 화면 3 · 5개/);
  assert.match($("readMsg").textContent, /비용 약/);
  click("btnSpellRun"); await until(() => $("spellResult").style.display === "" && !$("btnSpellRun").disabled, "spell after screen read");
  const spellText = apiCalls.filter(c => c.body.output_config.format.schema.properties.fixes).at(-1).body.messages[0].content[0].text;
  assert.match(spellText, /"다음에 또 봐요!"/, "screen text, not stale layer name");
  assert.match(spellText, /"그럼 안되요"/);
  assert.match(spellText, /"코코의 하루"/);
  assert.equal((spellText.match(/코코의 하루/g) || []).length, 1, "persistent title not glued onto every subtitle");
  assert.match($("spellList").innerHTML, /<span class="chip">화면<\/span>/);
  console.log("spellSummary (graphics):", $("spellSummary").textContent);
  assert.match($("spellSummary").textContent, /수정 제안 2개/);

  // confirm: in/out range, per segment
  change("range", "inout"); change("interval", "5"); change("maxFrames", "20");
  console.log("estimate:", $("estimate").textContent);
  assert.match($("estimate").textContent, /0:10\.0~0:30\.0/);
  log.exports.length = 0;
  // 두 번 눌러도 한 번만 실행
  click("btnConfirm"); click("btnConfirm"); await until(() => log.exports.length > 0 && /검수팀 리뷰가 왔어요/.test($("confirmMsg").textContent), "confirm 2");
  console.log("exports:", log.exports.map(e => e.t).join(","), log.exports[0].w + "x" + log.exports[0].h);
  assert.ok(log.exports.every(e => e.t >= 10 && e.t < 30));
  assert.equal(new Set(log.exports.map(e => e.t)).size, log.exports.length, "ran once");
  assert.equal(log.exports[0].w, 1280);
  const req = apiCalls.at(-1);
  assert.equal(req.body.model, "claude-opus-5-5");
  assert.equal(req.body.fallbacks, "default");
  const intro = req.body.messages[0].content[0].text;
  assert.match(intro, /브이로그 01/);
  assert.doesNotMatch(intro, /오늘은 브이로그를/, "subtitles outside in/out are not sent");
  console.log("verdict:", $("verdict").textContent, "|", $("confirmMsg").textContent);
  assert.match($("verdict").className, /v-fix/);
  assert.equal($("issueList").querySelectorAll(".card").length, 2);
  assert.ok($("issueList").querySelector("img.thumb"));
  assert.match($("verdict").textContent, /검수팀 판정: 수정 후 컨펌/);
  assert.match($("issueList").textContent, /카피라이팅팀/);
  assert.match($("issueList").textContent, /대안 1\. 구독하면 코코가 웃어요/);
  $("issueList").querySelector("[data-seek]").dispatchEvent(new window.Event("click", { bubbles: true })); await settle();
  assert.equal(log.seeks.at(-1), 15.5);

  click("btnConfirmMarkers"); await until(() => /마커 2개/.test($("confirmMsg").textContent), "confirm markers");
  assert.equal(markers.length, 3);
  assert.deepEqual(markers.filter(m => /컨펌/.test(m.name)).map(m => m.color), [1, 6]);
  click("btnConfirmMarkers"); await until(() => markers.length === 3 && /마커 2개/.test($("confirmMsg").textContent), "no duplicates");
  click("btnConfirmReport"); await until(() => saved.length === 3, "confirm report");
  assert.match(saved[2].text, /판정: 수정 후 컨펌/);
  click("btnClearMarkers"); await until(() => /3개를 지웠어요/.test($("confirmMsg").textContent), "clear markers");
  assert.equal(markers.length, 0);

  // buttons re-enabled, cancel hidden
  assert.equal($("btnConfirm").disabled, false);
  assert.equal($("btnConfirmCancel").style.display, "none");

  // 자가 진단: API 모드 (키 저장됨), 모든 단계 통과, 테스트 마커는 남지 않음
  const marksBefore = markers.length;
  click("btnDiag"); await until(() => /자가 진단: \d+개 중/.test($("diagText").value) && !$("btnDiag").disabled, "diagnostics");
  console.log($("diagText").value);
  assert.match($("diagText").value, /자가 진단: 7개 중 7개 통과/);
  assert.match($("diagText").value, /프리미어 premierepro 26\.5\.0 · 플러그인 1\.\d+\.\d+/);
  assert.match($("diagText").value, /프레임 1장 내보내기 — 1280x720 JPG/);
  assert.match($("diagText").value, /그래픽 텍스트 읽기 — 클립 6개 중 텍스트 그래픽 5개 · 글자 읽음 4개 \(그래픽 값 2 · 레이어 이름 1 · 클립 이름 1\) · 못 읽음 1개/);
  assert.match($("diagText").value, /\[텍스트 그래픽 구조\]\n클립 "/);
  assert.match($("diagText").value, /효과 2: AE\.ADBE Text \/ "텍스트"\n    속성 1 "소스 텍스트": null \/ 시간값 문자열 0자 ""/);
  assert.equal(markers.length, marksBefore, "test marker removed");
  // 구독 모드에서 연결 프로그램이 꺼져 있으면 그 단계만 실패
  change("mode", "subscription"); bridgeUp = false;
  click("btnDiag"); await until(() => /구독 연결 프로그램/.test($("diagText").value) && !$("btnDiag").disabled, "diagnostics sub");
  assert.match($("diagText").value, /7개 중 6개 통과/);
  assert.match($("diagText").value, /❌ 구독 연결 프로그램 — 구독 연결 프로그램이 꺼져 있어요/);
  click("btnDiagSave"); await until(() => saved.some(x => x.name === "자가진단_결과.txt"), "diag saved");
  bridgeUp = true;

  // 구독 모드: 못 읽은 그래픽은 타임라인 읽기에서 바로 화면을 보고 받아 적음 (추가 비용 없음)
  assert.match($("engine").options[0].textContent, /내 구독 사용량/);
  const runsBefore = bridgeCalls.filter(c => c.path.endsWith("/run")).length;
  click("btnReadTimeline"); await until(() => /화면에서 받아 적음 1개/.test($("readMsg").textContent), "timeline read (sub)");
  console.log("timeline (sub):", $("readMsg").textContent);
  assert.equal(bridgeCalls.filter(c => c.path.endsWith("/run")).length, runsBefore + 1);
  assert.match($("sourceLine").textContent, /그래픽 값 2 · 레이어 이름 1 · 클립 이름 1 · 화면 1 · 5개/);
  assert.equal($("btnReadCancel").style.display, "none");
  // 연결 프로그램이 꺼져 있어도 이름에서 읽은 것은 남김
  bridgeUp = false;
  click("btnReadTimeline"); await until(() => /받아 적지 못했어요: 구독 연결 프로그램이 꺼져/.test($("readMsg").textContent), "timeline read (bridge down)");
  assert.match($("sourceLine").textContent, /4개/);
  bridgeUp = true; change("mode", "api");

  // prefs persisted
  const prefs = JSON.parse(window.localStorage.getItem("subtitle-checker.prefs"));
  assert.equal(prefs.range, "inout");
  assert.equal(prefs.interval, 5);
  assert.equal($("version").textContent, "v1.3.2", "version shown in header");
  assert.equal($("errorBox").style.display, "none", "no unexpected errors: " + $("errorBox").textContent);
  // 버튼 처리 중 예상 못 한 오류는 패널 위쪽에 그대로 보임
  const srtLib = require(path.join(PLUGIN, "lib", "srt.js"));
  const origClock = srtLib.formatClock;
  srtLib.formatClock = () => { throw new TypeError("formatClock 테스트 오류"); };
  change("range", "all"); await until(() => $("errorBox").style.display === "", "error box");
  srtLib.formatClock = origClock;
  console.log("errorBox:", $("errorBox").textContent);
  assert.match($("errorBox").textContent, /^⚠ range: formatClock 테스트 오류\n이 문구를 그대로 알려 주세요\./);
  // 요금제에서 Opus를 못 쓰면 Sonnet으로 바꿔서 연결
  change("mode", "subscription"); bridgeState.noOpus = true;
  click("btnTestSub"); await until(() => /연결됐어요/.test($("subMsg").textContent) && !$("btnTestSub").disabled, "opus fallback");
  console.log("subMsg (no opus):", $("subMsg").textContent);
  assert.match($("subMsg").textContent, /Sonnet 5\.5로 바꿨어요/);
  assert.equal($("model").value, "claude-sonnet-5-5");
  assert.equal(JSON.parse(window.localStorage.getItem("subtitle-checker.prefs")).model, "claude-sonnet-5-5");
  assert.equal($("errorBox").style.display, "", "earlier forced error still shown");
  console.log("ALL UI CHECKS PASSED");
})().catch(e => { console.error("FAIL:", e); process.exit(1); });
