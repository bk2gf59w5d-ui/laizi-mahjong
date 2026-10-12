// 赖子麻将核心引擎（湖北十三张玩法）
// 牌编号 0..26：万 0-8，条 9-17，筒 18-26；rank = t % 9

export const SUITS = ['万', '条', '筒'];
export const tileSuit = (t: number) => Math.floor(t / 9);
export const tileRank = (t: number) => t % 9; // 0..8
export const tileLabel = (t: number) => `${tileRank(t) + 1}${SUITS[tileSuit(t)]}`;

export function buildWall(): number[] {
  const wall: number[] = [];
  for (let t = 0; t < 27; t++) for (let k = 0; k < 4; k++) wall.push(t);
  // Fisher-Yates
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  return wall;
}

// 翻牌定赖子：翻到 rank r，则赖子为同花色 r+1（9 翻 1）
export function laiziFromFlip(flip: number): number {
  const s = tileSuit(flip);
  return s * 9 + ((tileRank(flip) + 1) % 9);
}

export function toCounts(hand: number[]): number[] {
  const c = new Array(27).fill(0);
  for (const t of hand) c[t]++;
  return c;
}

// ---------- 和牌判定 ----------
// 14 张牌，赖子 laizi 可当本身或最多 1 张万能牌
const memo = new Map<string, boolean>();
function partKey(c: number[], w: number) {
  return c.join(',') + '|' + w;
}

// 剩余牌（去掉将）能否全部由刻子/顺子组成
// w = 还允许使用的万能牌张数；万能牌 = 消耗一张实体赖子(c[L])当任意牌
// anchor：剩余牌中编号最小的【非赖子】牌。赖子永不作 anchor——
// 否则当赖子是剩余最小牌时递归会卡在赖子身上，漏掉「7筒+赖(8筒)+9筒」这类和法。
// 赖子参与牌型的方式：① 赖子开头当本身的顺子（赖子=3条 → 3,4,5条）
// ② 顺子缺张/两张+赖 里当万能 ③ 三张赖子当本身刻子。
function partitionSets(c: number[], w: number, L: number): boolean {
  let first = -1;
  for (let i = 0; i < 27; i++) if (c[i] > 0 && i !== L) { first = i; break; }
  if (first === -1) {
    // 只剩赖子：赖子必须搭配普通牌（3张赖子不作刻由上层 c[L]≥2 禁止保证）
    return c[L] === 0;
  }
  const key = partKey(c, w);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  let ok = false;
  // 刻子
  if (c[first] >= 3) {
    c[first] -= 3;
    ok = partitionSets(c, w, L);
    c[first] += 3;
  }
  if (!ok && c[first] === 2 && w >= 1 && c[L] >= 1) {
    // 两张 + 一张赖子当万能
    c[first] -= 2; c[L] -= 1;
    ok = partitionSets(c, w - 1, L);
    c[first] += 2; c[L] += 1;
  }
  // 顺子
  if (!ok && tileRank(first) <= 6) {
    const need: number[] = [];
    for (let k = 0; k < 3; k++) {
      if (c[first + k] === 0) need.push(first + k);
    }
    if (need.length <= w && c[L] >= need.length) {
      for (let k = 0; k < 3; k++) c[first + k] -= 1;
      c[L] -= need.length;
      ok = partitionSets(c, w - need.length, L);
      for (let k = 0; k < 3; k++) c[first + k] += 1;
      c[L] += need.length;
    }
  }
  // 赖子开头、当本身的顺子（如赖子=3条，组成 3,4,5条；缺张仍可用万能补）
  if (!ok && c[L] >= 1 && tileRank(L) <= 6) {
    const need: number[] = [];
    for (let k = 1; k < 3; k++) {
      if (c[L + k] === 0) need.push(L + k);
    }
    if (need.length <= w && c[L] - 1 >= need.length) {
      for (let k = 0; k < 3; k++) c[L + k] -= 1;
      c[L] -= need.length;
      ok = partitionSets(c, w - need.length, L);
      for (let k = 0; k < 3; k++) c[L + k] += 1;
      c[L] += need.length;
    }
  }
  memo.set(key, ok);
  if (memo.size > 100000) memo.clear();
  return ok;
}

// useWild: 0 或 1，表示允许当万能牌使用的赖子张数
// drawn = 刚摸来的那张牌（-1 表示未知/不适用）：
// 将头含赖子时，与赖子配对的那张真牌不能是刚摸来的（赖子只能变「牌面已有的真牌」）
function canHuWithWild(c0: number[], laizi: number, useWild: number, drawn: number): boolean {
  const c = c0.slice();
  const L = laizi;
  // 选将
  for (let p = 0; p < 27; p++) {
    if (c[p] >= 2) {
      c[p] -= 2;
      if (partitionSets(c, useWild, L)) { c[p] += 2; return true; }
      c[p] += 2;
    }
    if (c[p] >= 1 && p !== L && p !== drawn && useWild >= 1 && c[L] >= 1) {
      // p（牌面已有的真牌）+ 赖子当万能 组成将；p 不能是刚摸来的那张
      c[p] -= 1; c[L] -= 1;
      if (partitionSets(c, useWild - 1, L)) { c[p] += 1; c[L] += 1; return true; }
      c[p] += 1; c[L] += 1;
    }
  }
  return false;
}

// 14 张（等效）hand 是否可胡；返回 false 或 { usedWild: 0|1 }
// kongs = 副露中杠的个数：每个杠物理占 4 张但只算 3 张牌权，
// 所以带 k 个杠时物理张数 = 14 + k（听牌判定为 13 + k）
// drawn = 刚摸来的牌（将头规则用，见 canHuWithWild）
export function checkHu(hand: number[], laizi: number, kongs = 0, drawn = -1): { usedWild: number } | null {
  if (hand.length !== 14 + kongs) return null;
  const c = toCounts(hand);
  // 规则：和牌牌面最多 1 张赖子（无论当万能还是本身）；3 张赖子不作刻、赖子+赖子不成将
  if (c[laizi] >= 2) return null;
  // 不带赖子胡（2 倍）：优先检查
  if (canHuWithWild(c, laizi, 0, drawn)) return { usedWild: 0 };
  if (canHuWithWild(c, laizi, 1, drawn)) return { usedWild: 1 };
  return null;
}

// 13 张（等效）是否听牌：返回可胡的牌列表及是否用赖子
// 每张候选牌都按「刚摸来的是它」判定（赖子组将规则）
export function tenpaiWaits(hand: number[], laizi: number, kongs = 0): { tile: number; usedWild: number }[] {
  const waits: { tile: number; usedWild: number }[] = [];
  if (hand.length !== 13 + kongs) return waits;
  const base = toCounts(hand);
  for (let t = 0; t < 27; t++) {
    if (base[t] >= 4) continue;
    const h = hand.concat(t);
    const r = checkHu(h, laizi, kongs, t); // 14 + kongs 物理张，t 视为刚摸的
    if (r) waits.push({ tile: t, usedWild: r.usedWild });
  }
  return waits;
}

// 手牌强度（用于出牌评估 / AI）：返回 { shanten, hasPair }
export function handStrength(hand13: number[], laizi: number): { shanten: number } {
  // 将 = 任意对子（可用 1 赖子辅助），其余凑完整面子，允许赖子本身参与
  let best = 4;
  const c0 = toCounts(hand13);
  const tryPair = (p: number, useWild: boolean) => {
    const c = c0.slice();
    c[p] -= useWild ? 1 : 2;
    // 计算最多完整面子数
    let sets = maxSets(c, laizi);
    let sh = 4 - sets - 1;
    if (sh < best) best = sh;
  };
  for (let p = 0; p < 27; p++) {
    if (c0[p] >= 2) tryPair(p, false);
    if (c0[p] >= 1 && c0[laizi] >= 1 && p !== laizi) {
      // 赖子当本身 + p 组成将（此时不消耗万能额度）
      tryPair(p, true);
    }
  }
  return { shanten: best };
}

const memoSets = new Map<string, number>();
function maxSets(c0: number[], laizi: number): number {
  const c = c0.slice();
  let first = -1;
  for (let i = 0; i < 27; i++) if (c[i] > 0) { first = i; break; }
  if (first === -1) return 0;
  const key = c.join(',');
  const hit = memoSets.get(key);
  if (hit !== undefined) return hit;
  let best = 0;
  // 刻子
  if (c[first] >= 3) {
    c[first] -= 3;
    best = Math.max(best, 1 + maxSets(c, laizi));
    c[first] += 3;
  }
  // 顺子
  if (tileRank(first) <= 6 && c[first + 1] > 0 && c[first + 2] > 0) {
    c[first]--; c[first + 1]--; c[first + 2]--;
    best = Math.max(best, 1 + maxSets(c, laizi));
    c[first]++; c[first + 1]++; c[first + 2]++;
  }
  // 跳过
  c[first]--;
  best = Math.max(best, maxSets(c, laizi));
  c[first]++;
  memoSets.set(key, best);
  if (memoSets.size > 100000) memoSets.clear();
  return best;
}

// ---------- 出牌评估（提示 & AI 共用） ----------
export interface DiscardEval {
  tile: number;
  tenpai: boolean;
  outs: number;               // 可胡牌张数
  outsNoWild: number;         // 其中不带赖子可胡的张数（2 倍）
  maxMult: number;            // 理论最高倍数（未计亮赖子）
  shanten: number;
  score: number;
  waits: { tile: number; usedWild: number }[]; // 听牌时的可胡牌
}

export function evalDiscards(hand14: number[], laizi: number, revealedCount: number, kongs = 0, flip = -1): DiscardEval[] {
  const results: DiscardEval[] = [];
  const uniq = Array.from(new Set(hand14));
  for (const t of uniq) {
    if (t === laizi) continue; // 赖子只能亮出，不能打出
    const rest = hand14.slice();
    rest.splice(rest.indexOf(t), 1);
    const waits = tenpaiWaits(rest, laizi, kongs); // rest 物理张数 = 13 + kongs
    const restCounts = toCounts(rest);
    // 赖子皮（翻出那张牌）全局只有 3 张在流通，其余牌 4 张
    const remain = (tile: number) => (tile === flip ? 3 : 4) - restCounts[tile];
    const multBase = Math.pow(2, revealedCount);
    if (waits.length > 0) {
      const outs = waits.reduce((s, w) => s + remain(w.tile), 0);
      const outsNoWild = waits.filter(w => w.usedWild === 0)
        .reduce((s, w) => s + remain(w.tile), 0);
      const maxMult = (waits.some(w => w.usedWild === 0) ? 2 : 1) * multBase;
      // 听牌优先：可胡张数多优先；不带赖子（2 倍）加分
      const score = 100000 + outs * 100 + outsNoWild * 60 + maxMult;
      results.push({ tile: t, tenpai: true, outs, outsNoWild, maxMult, shanten: 0, score, waits });
    } else {
      const { shanten } = handStrength(rest, laizi);
      const score = (4 - shanten) * 1000;
      results.push({ tile: t, tenpai: false, outs: 0, outsNoWild: 0, maxMult: multBase, shanten, score, waits: [] });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

export function bestDiscard(hand14: number[], laizi: number, revealedCount: number, kongs = 0, flip = -1): DiscardEval {
  return evalDiscards(hand14, laizi, revealedCount, kongs, flip)[0];
}

// ---------- AI 决策 ----------
// 是否碰：碰后模拟最优出牌，比较前后向听数
export function aiShouldPong(hand13: number[], laizi: number, tile: number, revealedCount: number): boolean {
  const pair = hand13.filter(t => t === tile).length;
  if (pair < 2) return false;
  const before = handStrength(hand13, laizi).shanten;
  const sim = hand13.slice();
  sim.splice(sim.indexOf(tile), 1);
  sim.splice(sim.indexOf(tile), 1); // 11 张
  const full = sim.concat([tile, tile, tile]); // 11 + 3 = 14
  const ev = evalDiscards(full, laizi, revealedCount).filter(e => sim.includes(e.tile));
  if (ev.length === 0) return Math.random() < 0.25;
  const after = ev[0].tenpai ? 0 : ev[0].shanten;
  if (after <= before) return true;
  return Math.random() < 0.25;
}

// AI 是否亮赖子
export function aiShouldReveal(hand14: number[], laizi: number): boolean {
  const n = hand14.filter(t => t === laizi).length;
  if (n < 2) return false;
  if (n >= 3) return Math.random() < 0.8;
  return Math.random() < 0.5;
}
