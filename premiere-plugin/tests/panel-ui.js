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

function component(match, params) {
  return {
    getMatchName: async () => match,
    getParamCount: () => params.length,
    getParam: i => ({ displayName: params[i][0], getStartValue: async () => params[i][1] }),
  };
}
function clip(start, end, comps) {
  return {
    getStartTime: async () => tick(start), getEndTime: async () => tick(end), getName: async () => "clip",
    getComponentChain: async () => ({ getComponentCount: () => comps.length, getComponentAtIndex: i => comps[i] }),
  };
}
const tracks = [
  [clip(0, 10, [component("AE.ADBE Motion", [["Position", 1]])])],
  [
    clip(2, 4, [component("AE.ADBE Motion", []), component("AE.ADBE Text", [["Source Text", { value: { value: JSON.stringify({ textEditValue: "오늘은 브이로그를 찍어볼께요" }) } }], ["Font", { value: { value: "Arial" } }]])]),
    clip(5, 7, [component("AE.ADBE Capsule", [["Text", { getText: () => "구독 좋아요" }]])]),
  ],
];
const sequence = {
  name: "브이로그 01",
  getEndTime: async () => tick(60), getInPoint: async () => tick(10), getOutPoint: async () => tick(30),
  getFrameSize: async () => ({ width: 1920, height: 1080 }),
  setPlayerPosition: async t => { log.seeks.push(t.seconds); return true; },
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
const reply = (status, obj) => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });
let bridgeUp = true;
global.fetch = async (url, init) => {
  if (url.startsWith("http://127.0.0.1:51234")) {
    if (!bridgeUp) throw new TypeError("fetch failed");
    const p = new URL(url).pathname;
    assert.equal(init.headers["X-Subtitle-Checker"], "1");
    bridgeCalls.push({ method: init.method, path: p, body: init.body });
    if (p === "/health") return reply(200, { ok: true, version: "2.1.300 (Claude Code)" });
    if (p === "/jobs") return reply(200, { ok: true, id: "j" + bridgeCalls.length });
    if (/\/files\//.test(p)) { assert.equal(init.body, "/9j/AQID"); return reply(200, { ok: true }); }
    const job = JSON.parse(init.body);
    const out = /"fixes"/.test(job.prompt) ? spellAnswer(job.prompt) : /"verdict"/.test(job.prompt) ? REVIEW : { ok: true };
    return reply(200, { type: "result", subtype: "success", is_error: false, result: JSON.stringify(out) });
  }
  const body = JSON.parse(init.body);
  apiCalls.push({ url, headers: init.headers, body });
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  const props = body.output_config.format.schema.properties;
  let out;
  if (props.fixes) {
    out = spellAnswer(body.messages[0].content[0].text);
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

  // read timeline graphics
  click("btnReadTimeline"); await until(() => /그래픽 텍스트 2개/.test($("spellMsg").textContent), "timeline read");
  console.log("timeline:", $("sourceLine").textContent);
  assert.equal($("spellResult").style.display, "none");

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

  // prefs persisted
  const prefs = JSON.parse(window.localStorage.getItem("subtitle-checker.prefs"));
  assert.equal(prefs.range, "inout");
  assert.equal(prefs.interval, 5);
  console.log("ALL UI CHECKS PASSED");
})().catch(e => { console.error("FAIL:", e); process.exit(1); });
