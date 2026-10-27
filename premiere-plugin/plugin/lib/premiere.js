"use strict";
/*
 * 프리미어 프로 UXP API 호출 모음 (프리미어 25.6 이상).
 * require("premierepro")와 require("uxp")는 프리미어 안에서만 동작하므로 쓸 때 불러옵니다.
 */

const { textOfValue, isTextComponent, textOfComponentName, textOfClipName } = require("./textvalue.js");
const { AI_PREFIX } = require("./report.js");

let _ppro = null;
const ppro = () => _ppro || (_ppro = require("premierepro"));
const uxp = () => require("uxp");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const secs = t => (t && typeof t.seconds === "number" ? t.seconds : 0);
const at = s => ppro().TickTime.createWithSeconds(Math.max(0, s));

async function getActive() {
  const project = await ppro().Project.getActiveProject();
  if (!project) throw new Error("열려 있는 프로젝트가 없어요. 프로젝트를 먼저 열어 주세요.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("열려 있는 시퀀스가 없어요. 타임라인에서 시퀀스를 열어 주세요.");
  return { project, sequence };
}

async function sequenceInfo(sequence) {
  const end = secs(await sequence.getEndTime());
  let inP = 0, outP = end;
  try { inP = secs(await sequence.getInPoint()); outP = secs(await sequence.getOutPoint()); } catch (e) { /* 인/아웃 없음 */ }
  const hasInOut = outP > inP + 0.05 && outP <= end + 0.05 && (inP > 0.01 || outP < end - 0.05);
  let width = 1920, height = 1080;
  try {
    const size = await sequence.getFrameSize();
    if (size && size.width && size.height) { width = size.width; height = size.height; }
  } catch (e) { /* 기본값 사용 */ }
  return {
    name: sequence.name,
    end,
    inPoint: hasInOut ? inP : 0,
    outPoint: hasInOut ? Math.min(outP, end) : end,
    hasInOut,
    width,
    height,
  };
}

async function findEntry(folder, name, base) {
  for (let i = 0; i < 25; i++) {
    try { return await folder.getEntry(name); } catch (e) { /* 아직 안 써짐 */ }
    try {
      const hit = (await folder.getEntries()).find(e => e.name.startsWith(base));
      if (hit) return hit;
    } catch (e) { /* 목록 실패 */ }
    await sleep(200);
  }
  return null;
}

/**
 * 시퀀스의 각 시점을 이미지로 내보내고 바이트를 읽어 옴
 * @returns {Promise<Array<{time:number, bytes:ArrayBuffer, mediaType:string}>>}
 */
async function exportFrames(sequence, times, size, { onProgress, isCancelled } = {}) {
  const P = ppro(), storage = uxp().storage;
  const temp = await storage.localFileSystem.getTemporaryFolder();
  const stamp = Date.now();
  let ext = "jpg";
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    if (isCancelled && isCancelled()) throw new Error("취소했어요.");
    let entry = null;
    for (const tryExt of ext === "jpg" ? ["jpg", "png"] : ["png"]) {
      const base = `frame_${stamp}_${i}`;
      const name = `${base}.${tryExt}`;
      let ok = false;
      try { ok = await P.Exporter.exportSequenceFrame(sequence, at(times[i]), name, temp.nativePath, size.width, size.height); }
      catch (e) { ok = false; }
      entry = ok ? await findEntry(temp, name, base) : null;
      if (entry) { ext = tryExt; break; }
    }
    if (!entry) throw new Error(`${i + 1}번째 프레임을 내보내지 못했어요. 프리미어를 최신 버전(25.6 이상)으로 업데이트했는지 확인해 주세요.`);
    const bytes = await entry.read({ format: storage.formats.binary });
    try { await entry.delete(); } catch (e) { /* 임시 폴더는 플러그인이 닫힐 때 비워짐 */ }
    frames.push({ time: times[i], bytes, mediaType: ext === "png" ? "image/png" : "image/jpeg" });
    if (onProgress) onProgress(i + 1, times.length);
  }
  return frames;
}

async function playerPosition(sequence) {
  return secs(await sequence.getPlayerPosition());
}

async function seek(sequence, seconds) {
  return sequence.setPlayerPosition(at(seconds));
}

function inTransaction(project, label, build) {
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction(compound => build(compound), label);
  });
  return ok;
}

/** 이름이 prefix로 시작하는 시퀀스 마커를 지움. 지운 개수를 돌려줌 */
async function removeMarkers(project, sequence, prefix = AI_PREFIX) {
  const owner = await ppro().Markers.getMarkers(sequence);
  const targets = owner.getMarkers().filter(m => String(m.getName() || "").startsWith(prefix));
  if (!targets.length) return 0;
  inTransaction(project, "AI 검수 마커 지우기", compound => {
    for (const m of targets) compound.addAction(owner.createRemoveMarkerAction(m));
  });
  return targets.length;
}

/**
 * @param {Array<{name, start, duration, comments, color}>} items color: "RED" | "ORANGE" | "YELLOW" | "BLUE" ...
 */
async function addMarkers(project, sequence, items) {
  const P = ppro();
  if (!items.length) return 0;
  const owner = await P.Markers.getMarkers(sequence);
  inTransaction(project, "AI 검수 마커 추가", compound => {
    for (const it of items) {
      compound.addAction(owner.createAddMarkerAction(it.name, P.Marker.MARKER_TYPE_COMMENT, at(it.start), at(it.duration || 0), it.comments));
    }
  });
  // 색은 마커가 생긴 뒤에만 바꿀 수 있어서 한 번 더
  try {
    const colors = P.Constants && P.Constants.MarkerColor;
    const fresh = (await P.Markers.getMarkers(sequence)).getMarkers();
    inTransaction(project, "AI 검수 마커 색", compound => {
      for (const m of fresh) {
        const name = m.getName(), start = secs(m.getStart());
        const it = items.find(x => x.name === name && Math.abs(x.start - start) < 0.05);
        const idx = it && colors ? colors[it.color] : undefined;
        if (typeof idx === "number") compound.addAction(m.createSetColorByIndexAction(idx));
      }
    });
  } catch (e) { /* 색 지정 실패는 무시 (마커는 이미 생김) */ }
  return items.length;
}

const TEXT_PARAM = /source\s*text|소스\s*텍스트|^text$|^텍스트$/i;

/** 자가 진단용: 속성 값이 어떤 모양인지 짧게 */
function describeValue(v) {
  if (v == null) return String(v);
  if (typeof v === "string") return `문자열 ${v.length}자 ${JSON.stringify(v.slice(0, 50))}`;
  if (typeof v !== "object") return `${typeof v} ${String(v).slice(0, 20)}`;
  if (typeof v.getText === "function") return "MogrtText";
  if (v.value && typeof v.value === "object" && "value" in v.value) return "키프레임→" + describeValue(v.value.value);
  if (v.value !== undefined && v.value !== v) return "키프레임→" + describeValue(v.value);
  try { return "객체{" + Object.keys(v).slice(0, 6).join(",") + "}"; } catch (e) { return "객체"; }
}

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { return fallback; }
}

/**
 * 클립 하나를 살펴서 텍스트 그래픽인지, 글자를 어떻게 읽었는지 돌려줌
 * @returns {Promise<{isText:boolean, text:string, via:string, name:string, dump:?string[]}>}
 * via: "값" (속성 값) | "레이어 이름" | "클립 이름" | "" (못 읽음)
 */
async function inspectItem(item, start, end, withDump) {
  const name = String(await safe(() => item.getName(), "") || "");
  const chain = await item.getComponentChain();
  const count = await chain.getComponentCount();
  const dump = withDump ? [`클립 "${name}"`] : null;
  const values = [], layers = [];
  let isText = false;
  for (let i = 0; i < count; i++) {
    const comp = chain.getComponentAtIndex(i);
    const match = String(await safe(() => comp.getMatchName(), "") || "");
    const textComp = isTextComponent(match);
    const display = textComp || dump ? String(await safe(() => comp.getDisplayName(), "") || "") : "";
    if (dump) dump.push(`  효과 ${i + 1}: ${match || "?"} / "${display}"`);
    if (!textComp) continue;
    isText = true;
    const layer = textOfComponentName(display);
    if (layer && !layers.includes(layer)) layers.push(layer);
    const paramCount = await safe(() => comp.getParamCount(), 0);
    for (let j = 0; j < paramCount; j++) {
      const param = comp.getParam(j);
      const pname = String((param && param.displayName) || "");
      const startValue = await safe(() => param.getStartValue(), undefined);
      let text = textOfValue(startValue, pname);
      // 시작 값이 비면 시간을 주고 한 번 더 (글자 속성으로 보이는 것만)
      let later;
      // (시퀀스 시간인지 클립 안 시간인지 문서에 없어서 둘 다)
      if (!text && (j === 0 || TEXT_PARAM.test(pname))) {
        for (const time of [() => at((start + end) / 2), async () => item.getInPoint()]) {
          later = await safe(async () => param.getValueAtTime(await time()), undefined);
          text = textOfValue(later, pname);
          if (text) break;
        }
      }
      if (text && !values.includes(text)) values.push(text);
      if (dump && j < 30) dump.push(`    속성 ${j + 1} "${pname}": ${describeValue(startValue)}${later !== undefined ? ` / 시간값 ${describeValue(later)}` : ""}`);
    }
  }
  if (!isText) return { isText, text: "", via: "", name, dump };
  if (values.length) return { isText, text: values.join("\n"), via: "값", name, dump };
  if (layers.length) return { isText, text: layers.join("\n"), via: "레이어 이름", name, dump };
  const fromName = textOfClipName(name);
  return { isText, text: fromName, via: fromName ? "클립 이름" : "", name, dump };
}

/**
 * 비디오 트랙의 텍스트 그래픽 클립을 모두 찾음 (글자를 못 읽은 클립도 text: ""로 포함)
 * @param {object} [o]
 * @param {function} [o.onProgress] (다 읽은 트랙, 전체 트랙, 살펴본 클립 수)
 * @param {number} [o.dump] 자가 진단용으로 속성 구조를 적어 올 클립 수
 * @returns {Promise<{clips:Array<{index,start,end,track,text,via,name}>, scanned:number, dumps:string[][]}>}
 */
async function scanTextClips(sequence, o = {}) {
  const P = ppro();
  const trackCount = await sequence.getVideoTrackCount();
  const found = [], textDumps = [], otherDumps = [];
  const want = o.dump || 0;
  let scanned = 0;
  // 위 트랙부터 (자막·그래픽은 보통 위쪽 트랙에 있음)
  for (let t = trackCount - 1; t >= 0; t--) {
    const track = await sequence.getVideoTrack(t);
    const items = (await safe(() => track.getTrackItems(P.Constants.TrackItemType.CLIP, false), [])) || [];
    for (const item of items) {
      scanned++;
      if (await safe(() => item.isDisabled(), false)) continue;
      const start = secs(await item.getStartTime()), end = secs(await item.getEndTime());
      const withDump = textDumps.length < want || otherDumps.length < Math.min(2, want);
      let info;
      try { info = await inspectItem(item, start, end, withDump); } catch (e) { continue; }
      if (info.dump) {
        if (info.isText && textDumps.length < want) textDumps.push(info.dump);
        else if (!info.isText && otherDumps.length < Math.min(2, want)) otherDumps.push(info.dump);
      }
      if (o.onProgress && scanned % 10 === 0) o.onProgress(trackCount - t - 1, trackCount, scanned);
      if (!info.isText) continue;
      found.push({ start, end, track: t + 1, text: info.text, via: info.via, name: info.name });
    }
    if (o.onProgress) o.onProgress(trackCount - t, trackCount, scanned);
  }
  found.sort((a, b) => a.start - b.start || b.track - a.track);
  return {
    clips: found.map((s, i) => Object.assign({ index: i + 1 }, s)),
    scanned,
    dumps: textDumps.length ? textDumps : otherDumps,
  };
}

module.exports = { getActive, sequenceInfo, exportFrames, playerPosition, seek, addMarkers, removeMarkers, scanTextClips, describeValue };
