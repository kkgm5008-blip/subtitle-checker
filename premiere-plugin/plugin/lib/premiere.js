"use strict";
/*
 * 프리미어 프로 UXP API 호출 모음 (프리미어 25.6 이상).
 * require("premierepro")와 require("uxp")는 프리미어 안에서만 동작하므로 쓸 때 불러옵니다.
 */

const { textOfValue, isTextComponent } = require("./textvalue.js");
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

async function textOfItem(item) {
  const chain = await item.getComponentChain();
  const count = await chain.getComponentCount();
  const texts = [];
  for (let i = 0; i < count; i++) {
    const comp = chain.getComponentAtIndex(i);
    let match = "";
    try { match = await comp.getMatchName(); } catch (e) { continue; }
    if (!isTextComponent(match)) continue;
    const paramCount = await comp.getParamCount();
    for (let j = 0; j < paramCount; j++) {
      const param = comp.getParam(j);
      let value;
      try { value = await param.getStartValue(); } catch (e) { continue; }
      const text = textOfValue(value, param.displayName);
      if (text && !texts.includes(text)) texts.push(text);
    }
  }
  return texts.join("\n");
}

/** 비디오 트랙의 그래픽·텍스트 클립에서 글자를 읽어 자막 목록처럼 돌려줌 */
async function readTimelineTexts(sequence, onProgress) {
  const P = ppro();
  const trackCount = await sequence.getVideoTrackCount();
  const found = [];
  for (let t = 0; t < trackCount; t++) {
    const track = await sequence.getVideoTrack(t);
    const items = await track.getTrackItems(P.Constants.TrackItemType.CLIP, false);
    for (const item of items || []) {
      let text = "";
      try { text = await textOfItem(item); } catch (e) { continue; }
      if (!text) continue;
      found.push({ start: secs(await item.getStartTime()), end: secs(await item.getEndTime()), text, track: t + 1 });
    }
    if (onProgress) onProgress(t + 1, trackCount);
  }
  found.sort((a, b) => a.start - b.start || a.track - b.track);
  return found.map((s, i) => ({ index: i + 1, start: s.start, end: s.end, text: s.text, track: s.track }));
}

module.exports = { getActive, sequenceInfo, exportFrames, playerPosition, seek, addMarkers, removeMarkers, readTimelineTexts };
