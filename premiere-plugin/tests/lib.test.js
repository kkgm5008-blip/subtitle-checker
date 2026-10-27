"use strict";
// 실행: node --test premiere-plugin/tests
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const lib = name => require(path.join(__dirname, "..", "plugin", "lib", name));
const srt = lib("srt.js");
const { diffChars } = lib("diff.js");
const base64 = lib("base64.js");
const sampling = lib("sampling.js");
const { textOfValue, isTextComponent } = lib("textvalue.js");
const report = lib("report.js");
const naver = lib("naver.js");
const { utf8Decode } = lib("host.js");

test("SRT 파싱: 번호, 여러 줄, 윈도우 줄바꿈, BOM", () => {
  const text = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n안녕하세요\r\n둘째 줄\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n반가워요\r\n";
  const segs = srt.parseSrt(text);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { index: 1, start: 1, end: 2.5, text: "안녕하세요\n둘째 줄" });
  assert.equal(segs[1].start, 3);
});

test("VTT 파싱: 헤더, 큐 이름, 시 없는 타임코드, 설정", () => {
  const text = "WEBVTT\n\nintro\n00:01.000 --> 00:02.000 align:start\n첫 자막\n\nNOTE 메모\n\n00:00:05.250 --> 00:00:06.000\n둘째";
  const segs = srt.parseVtt(text);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].start, 1);
  assert.equal(segs[0].text, "첫 자막");
  assert.equal(segs[1].start, 5.25);
});

test("SRT 쓰기와 다시 읽기", () => {
  const segs = [{ start: 0, end: 1.234, text: "가" }, { start: 61.5, end: 3725.004, text: "나\n다" }];
  const out = srt.writeSrt(segs);
  assert.match(out, /^1\n00:00:00,000 --> 00:00:01,234\n가\n/);
  assert.match(out, /00:01:01,500 --> 01:02:05,004/);
  const back = srt.parseSrt(out);
  assert.equal(back[1].text, "나\n다");
  assert.equal(back[1].end, 3725.004);
});

test("TXT는 줄 단위, 긴 줄은 문장 단위로 나눔", () => {
  const long = "가".repeat(300) + ". " + "나".repeat(300) + ".";
  const segs = srt.splitPlainText("첫 줄\n\n" + long, 450);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].start, null);
  assert.ok(segs.every(s => s.text.length <= 450));
});

test("지원하지 않는 확장자", () => {
  assert.throws(() => srt.parseSubtitleFile("a.ass", ""), /지원하지 않는/);
});

test("시간 표시", () => {
  assert.equal(srt.formatClock(5.26), "0:05.3");
  assert.equal(srt.formatClock(125), "2:05.0");
  assert.equal(srt.formatClock(3725), "1:02:05");
});

test("글자 단위 비교: 띄어쓰기와 맞춤법", () => {
  const ops = diffChars("안되요 그럼", "안 돼요 그럼");
  const del = ops.filter(o => o.type === "del").map(o => o.text).join("");
  const ins = ops.filter(o => o.type === "ins").map(o => o.text).join("");
  assert.equal(del, "되");
  assert.equal(ins, " 돼");
  const rebuilt = ops.filter(o => o.type !== "del").map(o => o.text).join("");
  assert.equal(rebuilt, "안 돼요 그럼");
  assert.deepEqual(diffChars("같음", "같음"), [{ type: "eq", text: "같음" }]);
});

test("base64는 Node Buffer와 같은 결과", () => {
  for (const n of [0, 1, 2, 3, 4, 100, 70000]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
    assert.equal(base64.encode(bytes.buffer), Buffer.from(bytes).toString("base64"));
  }
});

test("프레임 시점: 간격대로, 최대 장수, 구간 안", () => {
  const t = sampling.planFrameTimes({ start: 10, end: 40, interval: 5, maxFrames: 40 });
  assert.deepEqual(t, [12.5, 17.5, 22.5, 27.5, 32.5, 37.5]);
  const many = sampling.planFrameTimes({ start: 0, end: 600, interval: 1, maxFrames: 20 });
  assert.equal(many.length, 20);
  assert.ok(many[0] < 1 && many[19] > 598);
});

test("프레임 시점: 자막마다 한 장 + 빈 구간은 간격대로", () => {
  const segments = [{ start: 20, end: 22 }, { start: 22.2, end: 24 }, { start: 100, end: 102 }];
  const t = sampling.planFrameTimes({ start: 0, end: 110, interval: 10, maxFrames: 80, segments, perSegment: true });
  assert.ok(t.includes(21) && t.includes(23.1) && t.includes(101));
  assert.ok(t.includes(5) && t.includes(15), "첫 자막 전 빈 구간도 채움");
  assert.ok(t.some(x => x > 30 && x < 100), "자막 사이 긴 빈 구간도 채움");
  assert.deepEqual(t, t.slice().sort((a, b) => a - b));
});

test("프레임 크기: 비율 유지, 확대 안 함, 세로 영상", () => {
  assert.deepEqual(sampling.frameSize(1920, 1080, 1280), { width: 1280, height: 720 });
  assert.deepEqual(sampling.frameSize(1080, 1920, 1280), { width: 720, height: 1280 });
  assert.deepEqual(sampling.frameSize(640, 360, 1280), { width: 640, height: 360 });
});

test("그래픽 텍스트 값 읽기", () => {
  assert.equal(textOfValue({ getText: () => "모그릿 글자" }, "Text"), "모그릿 글자");
  assert.equal(textOfValue({ value: { value: JSON.stringify({ textEditValue: "안녕하세요" }) } }, "Source Text"), "안녕하세요");
  assert.equal(textOfValue(JSON.stringify({ a: { mText: "깊은 곳" } }), "x"), "깊은 곳");
  assert.equal(textOfValue("그냥 글자", "소스 텍스트"), "그냥 글자");
  assert.equal(textOfValue("Arial-Bold", "Font"), "", "글꼴 이름은 글자로 보지 않음");
  assert.equal(textOfValue(12, "Size"), "");
  assert.ok(isTextComponent("AE.ADBE Text"));
  assert.ok(isTextComponent("AE.ADBE Capsule"));
  assert.ok(!isTextComponent("AE.ADBE Motion"));
});

test("맞춤법 리포트·마커·교정 자막", () => {
  const rows = [
    { seg: { index: 1, start: 1, end: 2, text: "안되요" }, corrected: "안 돼요", issues: [{ type: "맞춤법", before: "안되요", after: "안 돼요", reason: "되어요의 준말" }], error: null },
    { seg: { index: 2, start: 3, end: 4, text: "좋아요" }, corrected: "좋아요", issues: [], error: null },
    { seg: { index: 3, start: 5, end: 6, text: "몰라" }, corrected: "몰라", issues: [], error: "실패" },
  ];
  const text = report.spellReport(rows, { source: "a.srt", engine: "Claude" });
  assert.match(text, /수정 제안 1개/);
  assert.match(text, /수정: 안 돼요/);
  assert.match(text, /검사 실패/);
  const markers = report.spellMarkers(rows);
  assert.equal(markers.length, 1);
  assert.ok(markers[0].name.startsWith(report.AI_PREFIX));
  assert.equal(markers[0].start, 1);
  assert.equal(markers[0].duration, 1);
  const segs = report.correctedSegments(rows);
  assert.deepEqual(segs.map(s => s.text), ["안 돼요", "좋아요", "몰라"]);
});

test("컨펌 리포트·마커", () => {
  const review = {
    verdict: "수정 후 컨펌", summary: "전체적으로 좋아요.", goodPoints: ["컷 호흡"],
    issues: [{ time: 12.5, frame: 0, category: "맞춤법", severity: "필수", current: "할께요", suggestion: "할게요", detail: "표준어" }],
  };
  const text = report.confirmReport(review, { sequence: "S", start: 0, end: 60, frames: 20, model: "m" });
  assert.match(text, /판정: 수정 후 컨펌/);
  assert.match(text, /\[0:12\.5\] \[필수\] 맞춤법/);
  const m = report.confirmMarkers(review);
  assert.equal(m[0].color, "RED");
  assert.match(m[0].name, /^\[AI 컨펌·필수\] 맞춤법: 할께요/);
  assert.match(m[0].comments, /수정: 할게요/);
});

test("네이버: passportKey 찾기, JSONP, 태그 제거", () => {
  assert.equal(naver.findPassportKey('...passportKey=abc123&where=1...'), "abc123");
  assert.deepEqual(naver.parseBody('cb({"a":1});'), { a: 1 });
  assert.equal(naver.stripTags("<em class='red_text'>안 돼요</em><br>&quot;좋아&quot;"), '안 돼요 "좋아"');
});

test("네이버: 가짜 응답으로 한 줄 검사", async () => {
  naver.resetKey();
  const calls = [];
  const fakeFetch = async url => {
    calls.push(url);
    if (url.startsWith("https://search.naver.com")) return { ok: true, text: async () => "x passportKey=KEY1& y" };
    return { ok: true, text: async () => JSON.stringify({ message: { result: { html: "<em class='red_text'>안 돼요</em>", errata_count: 1 } } }) };
  };
  const r = await naver.checkSegment("안되요\n좋아요", { fetch: fakeFetch });
  assert.equal(r.corrected, "안 돼요\n안 돼요");
  assert.equal(r.errorCount, 2);
  assert.ok(calls[1].includes("passportKey=KEY1"));
  assert.ok(calls[1].includes(encodeURIComponent("안되요")));
});

test("UTF-8 디코딩 (보안 저장소 값)", () => {
  assert.equal(utf8Decode(new Uint8Array(Buffer.from("sk-ant-api03-한글🙂"))), "sk-ant-api03-한글🙂");
});
