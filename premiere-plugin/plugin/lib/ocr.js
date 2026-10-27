"use strict";
/*
 * 화면 보고 받아 적기: 그래픽 클립마다 프레임 한 장을 뽑아 Claude가 화면 글자를 받아 적고,
 * 받아 적은 글자 덩어리를 어느 클립의 글자인지 나눠 줍니다.
 *
 * 한 화면에 그래픽이 여럿 겹치기도 해서 (예: 영상 내내 떠 있는 코너 제목 + 자막)
 * 같은 글자가 어느 클립이 떠 있는 장면들에 나타나는지를 비교해 주인을 정합니다.
 */

/** 클립 c가 시각 t에 화면에 있는지 */
const activeAt = (c, t) => c.start <= t && t < c.end;

/**
 * 클립마다 프레임을 뽑을 시각을 고름: 다른 그래픽과 덜 겹치고, 가운데에 가까운 때
 * @param {Array<{start:number,end:number}>} clips
 * @param {number[]} targets 받아 적을 클립 번호(0부터)
 * @returns {Array<{clip:number, time:number}>}
 */
function planShots(clips, targets) {
  return targets.map(i => {
    const c = clips[i];
    const len = Math.max(0, c.end - c.start);
    // 나타나고 사라지는 효과를 피해서 앞뒤를 조금 띄움
    const lo = c.start + Math.min(0.3, len * 0.25), hi = c.end - Math.min(0.15, len * 0.25);
    const mid = (lo + hi) / 2;
    let best = null;
    for (let k = 0; k <= 8; k++) {
      const t = lo + (hi - lo) * (k / 8);
      let overlap = 0;
      for (let j = 0; j < clips.length; j++) if (j !== i && activeAt(clips[j], t)) overlap++;
      const score = overlap * 1e6 + Math.abs(t - mid);
      if (!best || score < best.score) best = { score, time: t };
    }
    return { clip: i, time: Math.round(best.time * 1000) / 1000 };
  });
}

const squash = s => String(s || "").replace(/\s+/g, "");

function bigrams(s) {
  const a = Array.from(s), m = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a[i] + a[i + 1];
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** 두 글자가 얼마나 같은지 0~1 (띄어쓰기 무시, 받아 적을 때 한두 글자 달라도 같은 글로 봄) */
function similarity(a, b) {
  const x = squash(a), y = squash(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  if (Math.min(x.length, y.length) / Math.max(x.length, y.length) < 0.7) return 0;
  const A = bigrams(x), B = bigrams(y);
  let both = 0;
  A.forEach((n, g) => { both += Math.min(n, B.get(g) || 0); });
  return (2 * both) / (x.length - 1 + y.length - 1);
}

const SAME = 0.8;

/**
 * 받아 적은 글자 덩어리를 클립에 나눔
 * @param {Array<{start:number,end:number,known?:string}>} clips known: 이미 정확히 아는 글자 (있으면 그 덩어리는 그 클립 것으로 보고 뺌)
 * @param {Array<{clip:number,time:number}>} shots planShots 결과
 * @param {string[][]} blocks shots와 같은 순서, 장면마다 받아 적은 글자 덩어리
 * @returns {string[]} 클립마다 받아 적은 글자 (못 찾으면 "")
 */
function assignBlocks(clips, shots, blocks) {
  // 1. 비슷한 덩어리끼리 묶음
  const groups = []; // {rep, shots:Set}
  const items = []; // {shot, text, group}
  shots.forEach((shot, f) => {
    for (const raw of blocks[f] || []) {
      const text = String(raw || "").trim();
      if (!text) continue;
      let g = groups.findIndex(gr => similarity(gr.rep, text) >= SAME);
      if (g === -1) { groups.push({ rep: text, shots: new Set() }); g = groups.length - 1; }
      groups[g].shots.add(f);
      items.push({ shot: f, text, group: g });
    }
  });
  // 2. 클립마다 그 클립이 화면에 있는 장면들
  const activeShots = clips.map(c => new Set(shots.map((s, f) => (activeAt(c, s.time) ? f : -1)).filter(f => f >= 0)));
  const jaccard = (a, b) => {
    let inter = 0;
    a.forEach(x => { if (b.has(x)) inter++; });
    const union = a.size + b.size - inter;
    return union ? inter / union : 0;
  };
  // 3. 덩어리마다 주인: 그 장면에 떠 있는 클립 중, 덩어리가 나타난 장면들과 클립이 떠 있는 장면들이 가장 잘 맞는 클립
  const owned = clips.map(() => []);
  for (const it of items) {
    const shot = shots[it.shot];
    const candidates = clips.map((c, i) => i).filter(i => activeAt(clips[i], shot.time));
    if (!candidates.includes(shot.clip)) candidates.push(shot.clip);
    if (candidates.some(i => clips[i].known && similarity(clips[i].known, it.text) >= SAME)) continue;
    let owner = shot.clip, best = jaccard(groups[it.group].shots, activeShots[shot.clip] || new Set());
    for (const i of candidates) {
      const score = jaccard(groups[it.group].shots, activeShots[i]);
      if (score > best + 1e-9) { best = score; owner = i; }
    }
    owned[owner].push(it);
  }
  // 4. 클립의 글자: 자기 장면에서 받은 덩어리 (없으면 다른 장면에서 처음 받은 것)
  return clips.map((c, i) => {
    const own = shots.findIndex(s => s.clip === i);
    let mine = owned[i].filter(it => it.shot === own);
    if (!mine.length && owned[i].length) mine = owned[i].filter(it => it.shot === owned[i][0].shot);
    const out = [];
    for (const it of mine) if (!out.some(t => similarity(t, it.text) >= SAME)) out.push(it.text);
    return out.join("\n");
  });
}

module.exports = { planShots, assignBlocks, similarity };
