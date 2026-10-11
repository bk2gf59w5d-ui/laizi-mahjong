import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  buildWall, laiziFromFlip, tileLabel, tileSuit, tileRank, checkHu,
  evalDiscards, bestDiscard, aiShouldPong, aiShouldReveal,
  type DiscardEval,
} from '@/game/engine';

// 解释推荐打法的原因
function explainEval(e: DiscardEval, hand14: number[], laizi: number, revealedCount: number): string {
  if (e.tenpai) {
    const uniq = (arr: number[]) => [...new Set(arr)].map(tileLabel).join('、');
    const pure = e.waits.filter(w => w.usedWild === 0).map(w => w.tile);
    const wild = e.waits.filter(w => w.usedWild === 1).map(w => w.tile);
    let s = `听 ${uniq(e.waits.map(w => w.tile))}，共 ${e.outs} 张可胡`;
    if (pure.length) s += `；${uniq(pure)} 不带赖子和牌（2 倍）`;
    if (wild.length) s += `；${uniq(wild)} 需用赖子（1 倍）`;
    if (revealedCount > 0) s += `；已亮 ${revealedCount} 个赖子，结算再 ×${2 ** revealedCount}`;
    return s;
  }
  const rest = hand14.slice();
  rest.splice(rest.indexOf(e.tile), 1);
  const suit = tileSuit(e.tile), rank = tileRank(e.tile);
  const near = rest.some(t => tileSuit(t) === suit && t !== e.tile && Math.abs(tileRank(t) - rank) <= 2);
  let s = near
    ? '相比其他打法，这张打出去后留下的搭子最多、向听前进最快'
    : '这张牌与手中其他牌没有连接（难组成顺子/刻子），打它损失最小';
  if (e.tile === laizi) s = '⚠️ 这是赖子（可当万能牌），确定要打吗？' + s;
  return s;
}
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Lightbulb, BookOpen, RotateCcw, Sparkles } from 'lucide-react';

// ---------- 类型 ----------
type Meld = { type: 'pong' | 'kong' | 'kong3'; tile: number };

interface PlayerState {
  name: string;
  isAI: boolean;
  hand: number[];        // 暗牌
  melds: Meld[];         // 碰/杠
  revealed: number[];    // 已亮出的赖子
  discards: number[];
  score: number;
}

interface HandResult {
  winner: number;
  usedWild: number;
  revealedCount: number;
  mult: number;
  handTiles: number[];
  isLiuju: boolean;
}

type Prompt =
  | { kind: 'discard'; huAvailable: boolean; kongTile: number | null; flipTrio: number | null; revealAvail: boolean; revealTwoAvail: boolean; evals: DiscardEval[] }
  | { kind: 'pong'; tile: number }
  | { kind: 'gong'; tile: number }
  | { kind: 'over'; result: HandResult }
  | { kind: 'liuju' }
  | null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const AUTO = new URLSearchParams(window.location.search).has('auto');
const NAMES = ['你', '上家', '对家', '下家'];

function meldExpanded(p: PlayerState): number[] {
  const arr: number[] = [];
  for (const m of p.melds) {
    const n = m.type === 'kong' ? 4 : 3; // kong3（赖子皮三张国杠）只亮 3 张
    for (let i = 0; i < n; i++) arr.push(m.tile);
  }
  return arr;
}

// 展示用：杠展开为 4 张物理牌
function fullTiles(p: PlayerState): number[] {
  return p.hand.concat(meldExpanded(p));
}

// 和/听判定用：每个副露（含杠）只算 3 张牌权——杠的第 4 张是补牌权益，
// 牌型划分永远是 4 组×3 + 将×2 = 14 张
function huTiles(p: PlayerState): number[] {
  const a: number[] = [];
  for (const m of p.melds) for (let i = 0; i < 3; i++) a.push(m.tile);
  return p.hand.concat(a);
}

// ---------- 单张牌 ----------
// 牌面素材：FluffyStuff/riichi-mahjong-tiles（公有领域 / CC0）
const SUIT_IMG = ['Man', 'Sou', 'Pin']; // 万、条、筒
const tileImg = (t: number) => `tiles/${SUIT_IMG[tileSuit(t)]}${tileRank(t) + 1}.png`;

function Tile({ t, small, laizi, dim, noDiscard, onClick }: { t: number; small?: boolean; laizi?: number; dim?: boolean; noDiscard?: boolean; onClick?: () => void }) {
  const isLai = laizi !== undefined && t === laizi;
  return (
    <div
      onClick={onClick}
      title={noDiscard ? `${tileLabel(t)}（赖子只能亮出，不能打出）` : tileLabel(t)}
      className={`relative rounded-md overflow-hidden bg-white border shadow-sm select-none
        ${small ? 'w-7 h-9' : 'w-10 h-14'}
        ${isLai ? 'ring-2 ring-purple-500 border-purple-400' : 'border-stone-300'}
        ${dim ? 'opacity-50' : ''} ${onClick ? 'cursor-pointer active:scale-95 hover:-translate-y-1 transition' : ''}`}
    >
      <img src={tileImg(t)} alt={tileLabel(t)} draggable={false}
        className={`w-full h-full object-cover pointer-events-none ${isLai ? 'saturate-125' : ''}`} />
      {isLai && (
        <div className="absolute inset-0 bg-purple-500/10 pointer-events-none" />
      )}
      {isLai && <Sparkles className={`${small ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} text-purple-500 absolute top-0 right-0 drop-shadow`} />}
    </div>
  );
}

// ---------- 主组件 ----------
export default function App() {
  const [, force] = useReducer(x => x + 1, 0);
  const runIdRef = useRef(0);

  // 游戏状态（ref 存储，避免闭包过期）
  const g = useRef({
    players: [] as PlayerState[],
    wall: [] as number[],
    laiziFlip: -1,
    laizi: -1,
    dealer: 0,
    turn: 0,
    busy: false,
    lastDiscard: null as { by: number; tile: number } | null,
    handNo: 0,
    kongPts: [0, 0, 0, 0],
  });

  const promptRef = useRef<Prompt>(null);
  const [prompt, setPromptState] = useState<Prompt>(null);
  const resolverRef = useRef<((v: unknown) => void) | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [log, setLog] = useState<string[]>([]);

  const setPrompt = (p: Prompt) => { promptRef.current = p; setPromptState(p); };
  const ask = <T,>(p: Prompt) => new Promise<T>(res => { resolverRef.current = res as (v: unknown) => void; setPrompt(p); });
  const answer = (v: unknown) => { const r = resolverRef.current; resolverRef.current = null; setPrompt(null); r?.(v); };

  const pushLog = (s: string) => setLog(l => [s, ...l].slice(0, 30));

  const laizi = g.current.laizi;

  // ---------- 核心动作 ----------
  function newGame() {
    runIdRef.current++;
    setLog([]);
    const players: PlayerState[] = NAMES.map((name, i) => ({
      name, isAI: i !== 0, hand: [], melds: [], revealed: [], discards: [], score: 0,
    }));
    g.current = { players, wall: [], laiziFlip: -1, laizi: -1, dealer: Math.floor(Math.random() * 4), turn: 0, busy: true, lastDiscard: null, handNo: 0, kongPts: [0, 0, 0, 0] };
    force();
    playHand(runIdRef.current);
  }

  function draw(p: PlayerState): boolean {
    const t = g.current.wall.shift();
    if (t === undefined) return false;
    p.hand.push(t);
    return true;
  }
  function tailDraw(p: PlayerState): boolean {
    const t = g.current.wall.pop();
    if (t === undefined) return false;
    p.hand.push(t);
    return true;
  }

  function findKong(p: PlayerState): number | null {
    // 暗杠：手牌 4 张相同（赖子可当原牌参与）
    const counts = new Map<number, number>();
    for (const t of p.hand) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, n] of counts) if (n === 4) return t;
    // 补杠：已有碰且手上有第 4 张
    for (const m of p.melds) {
      if (m.type === 'pong' && p.hand.includes(m.tile)) return m.tile;
    }
    return null;
  }

  // 赖子皮三张国杠：翻出那张牌全局只有 3 张，自摸凑齐 3 张可申报暗杠
  // （按暗杠计分，但只亮 3 张、不从牌尾补牌）
  function findFlipTrio(p: PlayerState): number | null {
    const flip = g.current.laiziFlip;
    if (flip < 0) return null;
    if (p.melds.some(m => m.tile === flip)) return null;
    return p.hand.filter(t => t === flip).length === 3 ? flip : null;
  }

  function huResult(p: PlayerState, seat: number): HandResult {
    const full = fullTiles(p);
    const r = checkHu(huTiles(p), g.current.laizi)!;
    const mult = (r.usedWild === 0 ? 2 : 1) * Math.pow(2, p.revealed.length);
    return { winner: seat, usedWild: r.usedWild, revealedCount: p.revealed.length, mult, handTiles: full, isLiuju: false };
  }

  function settle(result: HandResult) {
    if (!result.isLiuju) {
      const w = g.current.players[result.winner];
      let gain = 0;
      g.current.players.forEach((p, i) => {
        if (i === result.winner) return;
        // 输家按自己亮出的赖子数再加倍：倍数 = 赢家倍数 × 2^(该输家亮赖子数)
        const pay = result.mult * Math.pow(2, p.revealed.length);
        p.score -= pay;
        gain += pay;
      });
      w.score += gain;
      g.current.dealer = result.winner; // 赢家连庄
    }
    force();
  }

  async function takeTurn(seat: number, justPonged = false): Promise<'hu' | 'discard'> {
    const p = g.current.players[seat];
    g.current.turn = seat;
    force();

    const tryHu = () => checkHu(huTiles(p), g.current.laizi);
    // 碰牌后必须打出一张，不能碰完直接和
    let hu = justPonged ? null : tryHu();

    if (seat === 0) {
      // 人类回合：循环处理 胡/杠/亮赖子，最后出牌
      while (true) {
        const kongTile = findKong(p);
        const flipTrio = findFlipTrio(p);
        const laiziCount = p.hand.filter(t => t === g.current.laizi).length;
        const revealAvail = laiziCount >= 1; // 有赖子就可以亮（可选，不强制）
        const revealTwoAvail = laiziCount >= 2; // 可以一次亮出两个
        const evals = evalDiscards(huTiles(p), g.current.laizi, p.revealed.length, 0, g.current.laiziFlip).filter(e => p.hand.includes(e.tile));
        let action: 'hu' | { kong: number } | { kong3: number } | 'reveal' | 'reveal2' | { discard: number };
        if (AUTO) {
          await sleep(500);
          if (hu) action = 'hu';
          else if (kongTile !== null) action = { kong: kongTile };
          else if (flipTrio !== null) action = { kong3: flipTrio };
          else if (revealAvail && Math.random() < 0.4) action = 'reveal';
          else action = { discard: evals[0]?.tile ?? p.hand.find(x => x !== g.current.laizi) ?? p.hand[0] };
        } else {
          action = await ask<'hu' | { kong: number } | { kong3: number } | 'reveal' | 'reveal2' | { discard: number }>({
            kind: 'discard', huAvailable: !!hu, kongTile, flipTrio, revealAvail, revealTwoAvail, evals,
          });
        }
        if (action === 'hu') return 'hu';
        if (typeof action === 'object' && 'kong' in action) {
          const isAdded = p.melds.some(m => m.type === 'pong' && m.tile === action.kong);
          doKong(p, action.kong);
          kongScore(seat, isAdded ? 'added' : 'dark', action.kong);
          if (!justPonged && tailDraw(p)) hu = tryHu(); // 牌尾无牌则直接继续，正常出牌；碰后的回合不许和
          continue;
        }
        if (typeof action === 'object' && 'kong3' in action) {
          // 赖子皮三张国杠：亮 3 张、按暗杠计分、不从牌尾补牌
          const t = action.kong3;
          for (let i = 0; i < 3; i++) p.hand.splice(p.hand.indexOf(t), 1);
          p.melds.push({ type: 'kong3', tile: t });
          kongScore(seat, 'dark', t, undefined, `${p.name} 暗杠赖子皮 ${tileLabel(t)}（仅 3 张，按暗杠每家 2 分，不补牌）`);
          force();
          continue; // 不补牌，继续操作或出牌
        }
        if (action === 'reveal' || action === 'reveal2') {
          const times = action === 'reveal2' ? 2 : 1;
          for (let k = 0; k < times; k++) {
            doReveal(p);
            pushLog(`${p.name} 亮出一个赖子并从牌尾补牌`);
            if (!justPonged && tailDraw(p)) { hu = tryHu(); if (hu) break; }
            else break;
          }
          continue;
        }
        // 出牌
        const t = (action as { discard: number }).discard;
        p.hand.splice(p.hand.indexOf(t), 1);
        p.discards.push(t);
        g.current.lastDiscard = { by: seat, tile: t };
        pushLog(`你打出 ${tileLabel(t)}`);
        force();
        await sleep(350);
        return 'discard';
      }
    } else {
      await sleep(700);
      if (hu) return 'hu';
      // AI 杠
      let guard = 0;
      let wallDead = false;
      while (!wallDead && guard++ < 4) {
        const kongTile = findKong(p);
        if (kongTile === null) break;
        const isAdded = p.melds.some(m => m.type === 'pong' && m.tile === kongTile);
        doKong(p, kongTile);
        kongScore(seat, isAdded ? 'added' : 'dark', kongTile);
        await sleep(500);
        if (!tailDraw(p)) { wallDead = true; break; }
        if (tryHu()) return 'hu';
      }
      // AI 亮赖子
      guard = 0;
      while (!wallDead && guard++ < 4 && aiShouldReveal(p.hand, g.current.laizi)) {
        doReveal(p);
        pushLog(`${p.name} 亮出一个赖子并从牌尾补牌`);
        await sleep(600);
        if (!tailDraw(p)) { wallDead = true; break; }
        if (tryHu()) return 'hu';
      }
      // AI 赖子皮三张国杠（不补牌，申报后正常出牌）
      const flipTrioAI = findFlipTrio(p);
      if (flipTrioAI !== null) {
        for (let i = 0; i < 3; i++) p.hand.splice(p.hand.indexOf(flipTrioAI), 1);
        p.melds.push({ type: 'kong3', tile: flipTrioAI });
        kongScore(seat, 'dark', flipTrioAI, undefined, `${p.name} 暗杠赖子皮 ${tileLabel(flipTrioAI)}（仅 3 张，按暗杠每家 2 分，不补牌）`);
        await sleep(600);
      }
      // AI 出牌
      const ev = bestDiscard(huTiles(p), g.current.laizi, p.revealed.length, 0, g.current.laiziFlip);
      let t = ev.tile;
      if (!p.hand.includes(t)) t = p.hand.find(x => x !== g.current.laizi) ?? p.hand[0];
      p.hand.splice(p.hand.indexOf(t), 1);
      p.discards.push(t);
      g.current.lastDiscard = { by: seat, tile: t };
      pushLog(`${p.name} 打出 ${tileLabel(t)}`);
      force();
      await sleep(550);
      return 'discard';
    }
  }

  // 杠牌得分即时结算（不论本局是否和牌）
  function kongScore(seat: number, kind: 'dark' | 'added' | 'ming', tile: number, discarder?: number, label?: string) {
    const p = g.current.players[seat];
    if (kind === 'ming') {
      const d = g.current.players[discarder!];
      d.score -= 2;
      p.score += 2;
      pushLog(`${p.name} 明杠 ${tileLabel(tile)}，${d.name} 给 2 分`);
    } else if (kind === 'added') {
      g.current.players.forEach((q, i) => { if (i !== seat) q.score -= 1; });
      p.score += 3;
      pushLog(`${p.name} 后杠（补杠）${tileLabel(tile)}，每家 1 分`);
    } else {
      g.current.players.forEach((q, i) => { if (i !== seat) q.score -= 2; });
      p.score += 6;
      pushLog(label ?? `${p.name} 暗杠 ${tileLabel(tile)}，每家 2 分`);
    }
    g.current.kongPts[seat] += kind === 'dark' ? 6 : kind === 'added' ? 3 : 2;
    force();
  }

  function doKong(p: PlayerState, tile: number) {
    const idx = p.melds.findIndex(m => m.type === 'pong' && m.tile === tile);
    if (idx >= 0) {
      p.melds[idx] = { type: 'kong', tile };
      p.hand.splice(p.hand.indexOf(tile), 1);
    } else {
      for (let i = 0; i < 4; i++) p.hand.splice(p.hand.indexOf(tile), 1);
      p.melds.push({ type: 'kong', tile });
    }
    force();
  }

  function doReveal(p: PlayerState) {
    p.hand.splice(p.hand.indexOf(g.current.laizi), 1);
    p.revealed.push(g.current.laizi);
    force();
  }

  async function claimPhase(discarder: number, tile: number, runId: number): Promise<{ seat: number; pong: boolean } | null> {
    for (let off = 1; off <= 3; off++) {
      if (runIdRef.current !== runId) return null;
      const seat = (discarder + off) % 4;
      const p = g.current.players[seat];
      const count = p.hand.filter(t => t === tile).length;
      if (count >= 3) {
        // 明杠：手上有 3 张，杠别人打出的第 4 张，点炮方给 2 分
        let r: boolean;
        if (seat === 0) {
          r = AUTO ? true : await ask<boolean>({ kind: 'gong', tile });
        } else {
          await sleep(400);
          r = true; // AI 有杠必杠
        }
        if (r) {
          for (let i = 0; i < 3; i++) p.hand.splice(p.hand.indexOf(tile), 1);
          p.melds.push({ type: 'kong', tile });
          kongScore(seat, 'ming', tile, discarder);
          force();
          tailDraw(p); // 杠后从牌尾补一张（无牌则继续，本局随即流局）
          return { seat, pong: false };
        }
      } else if (count >= 2) {
        if (seat === 0) {
          const r = AUTO
            ? false
            : await ask<boolean>({ kind: 'pong', tile });
          if (r) {
            p.hand.splice(p.hand.indexOf(tile), 1);
            p.hand.splice(p.hand.indexOf(tile), 1);
            p.melds.push({ type: 'pong', tile });
            pushLog(`你碰了 ${tileLabel(tile)}`);
            force();
            return { seat, pong: true };
          }
        } else {
          await sleep(400);
          if (aiShouldPong(p.hand, g.current.laizi, tile, p.revealed.length)) {
            p.hand.splice(p.hand.indexOf(tile), 1);
            p.hand.splice(p.hand.indexOf(tile), 1);
            p.melds.push({ type: 'pong', tile });
            pushLog(`${p.name} 碰了 ${tileLabel(tile)}`);
            force();
            return { seat, pong: true };
          }
        }
      }
    }
    return null;
  }

  async function playHand(runId: number) {
    const st = g.current;
    st.handNo++;
    st.kongPts = [0, 0, 0, 0];
    st.wall = buildWall();
    for (const p of st.players) { p.hand = []; p.melds = []; p.revealed = []; p.discards = []; }
    // 发牌
    for (let i = 0; i < 13; i++) for (let s = 0; s < 4; s++) st.players[s].hand.push(st.wall.shift()!);
    for (const p of st.players) p.hand.sort((a, b) => a - b);
    // 翻牌定赖子
    st.laiziFlip = st.wall.pop()!;
    st.laizi = laiziFromFlip(st.laiziFlip);
    pushLog(`第 ${st.handNo} 局开始，翻出 ${tileLabel(st.laiziFlip)}，本局赖子为 ${tileLabel(st.laizi)}`);
    force();
    await sleep(800);
    // 庄家摸牌
    if (!draw(st.players[st.dealer])) { endLiuju(); return; }

    let current = st.dealer;
    while (true) {
      if (runIdRef.current !== runId) return;
      const r = await takeTurn(current);
      if (r === 'hu') {
        const result = huResult(st.players[current], current);
        settle(result);
        pushLog(`${st.players[current].name} 自摸和牌！倍数 ×${result.mult}`);
        if (AUTO) await sleep(2500); else await ask({ kind: 'over', result });
        playHand(runId);
        return;
      }
      const last = st.lastDiscard!;

      const claimer = await claimPhase(last.by, last.tile, runId);
      if (runIdRef.current !== runId) return;
      if (claimer !== null) {
        current = claimer.seat;
        if (claimer.pong) {
          // 碰牌者直接出牌（碰后不能和，须先打一张）
          const r2 = await takeTurn(current, true);
          if (r2 === 'hu') { /* 理论上不可达 */ }
          continue;
        }
      } else {
        current = (last.by + 1) % 4;
        if (!draw(st.players[current])) { endLiuju(); return; }
      }
    }
  }

  function endLiuju() {
    settle({ winner: -1, usedWild: 0, revealedCount: 0, mult: 0, handTiles: [], isLiuju: true });
    pushLog('牌墙摸完，流局作废');
    (async () => { if (AUTO) await sleep(2000); else await ask({ kind: 'liuju' }); playHand(runIdRef.current); })();
  }

  useEffect(() => { newGame(); }, []);

  // ---------- 渲染 ----------
  const me = g.current.players[0];

  const bestEvals: DiscardEval[] = useMemo(() => {
    if (prompt?.kind !== 'discard') return [];
    return prompt.evals;
  }, [prompt]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-950 via-emerald-900 to-emerald-950 text-stone-100 flex flex-col max-w-md mx-auto">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-3 py-2 bg-emerald-950/80 backdrop-blur sticky top-0 z-20 border-b border-emerald-800">
        <div className="flex items-center gap-2">
          <span className="font-bold text-lg tracking-wide">赖子麻将</span>
          <Badge variant="secondary" className="bg-emerald-800 text-emerald-100">第 {g.current.handNo} 局</Badge>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="text-emerald-200" onClick={() => setShowTutorial(true)}><BookOpen className="w-4 h-4" /></Button>
          <Button size="sm" variant="ghost" className="text-emerald-200" onClick={newGame}><RotateCcw className="w-4 h-4" /></Button>
        </div>
      </header>

      {/* 赖子信息条 */}
      <div className="flex items-center justify-center gap-3 py-1.5 text-xs bg-emerald-900/60">
        <span>翻出</span>
        {g.current.laiziFlip >= 0 && <Tile t={g.current.laiziFlip} small laizi={g.current.laizi} />}
        <span>赖子</span>
        {g.current.laizi >= 0 && <Tile t={g.current.laizi} small laizi={g.current.laizi} />}
        <span className="text-emerald-300">剩牌 {g.current.wall.length}</span>
        <span className="text-amber-300">庄家：{g.current.players[g.current.dealer]?.name}</span>
      </div>

      {/* 牌桌区 */}
      <div className="flex-1 flex flex-col px-2 gap-1.5 overflow-hidden">
        {/* 对家 */}
        <Opponent p={g.current.players[2]} active={g.current.turn === 2} laizi={laizi} />
        {/* 上家/下家 + 中央信息 */}
        <div className="flex gap-1.5 items-stretch">
          <Opponent p={g.current.players[1]} active={g.current.turn === 1} laizi={laizi} horizontal />
          <div className="flex-1 rounded-lg bg-emerald-800/40 border border-emerald-700/50 p-1.5 flex flex-col items-center justify-center gap-1 min-h-[120px]">
            <div className="text-[10px] text-emerald-300">最近打出</div>
            {g.current.lastDiscard && (
              <Tile t={g.current.lastDiscard.tile} small laizi={laizi} />
            )}
            <div className="text-[10px] text-emerald-400 mt-1 h-8 overflow-hidden text-center">{log[0] || ''}</div>
            <div className="flex gap-2 text-[10px] text-stone-300">
              {g.current.players.map((p, i) => (
                <span key={i} className={i === g.current.turn ? 'text-amber-300 font-bold' : ''}>{p.name} {p.score}</span>
              ))}
            </div>
          </div>
          <Opponent p={g.current.players[3]} active={g.current.turn === 3} laizi={laizi} horizontal />
        </div>

        {/* 提示条 */}
        {prompt?.kind === 'discard' && showHint && bestEvals.length > 0 && (
          <div className="rounded-md bg-amber-950/70 border border-amber-700/60 px-2 py-1.5 text-xs leading-relaxed">
            <div className="flex items-center gap-1 text-amber-300 font-bold mb-0.5"><Lightbulb className="w-3.5 h-3.5" />智能提示</div>
            {bestEvals.slice(0, 2).map((e, i) => (
              <div key={i} className={i === 0 ? 'text-amber-100' : 'text-stone-400'}>
                {i === 0 ? '★ 推荐' : '　备选'}打 <b>{tileLabel(e.tile)}</b>：
                {e.tenpai
                  ? `听牌！可胡 ${e.outs} 张牌${e.outsNoWild > 0 ? `（其中 ${e.outsNoWild} 张不带赖子，2 倍）` : '（需用赖子，1 倍）'}`
                  : `还差 ${e.shanten} 步听牌`}
              </div>
            ))}
            {bestEvals[0] && (
              <div className="text-amber-200/80 mt-0.5">
                为什么：{explainEval(bestEvals[0], fullTiles(g.current.players[0]), laizi, g.current.players[0].revealed.length)}
              </div>
            )}
          </div>
        )}

        {/* 我的区域 */}
        <div className="rounded-t-xl bg-emerald-800/50 border border-emerald-700/60 p-2">
          {/* 我的副露 */}
          {(me?.melds.length > 0 || me?.revealed.length > 0) && (
            <div className="flex gap-2 mb-1.5 flex-wrap min-h-[28px]">
              {me.melds.map((m, i) => (
                <div key={i} className="flex gap-0.5">
                  {Array.from({ length: m.type === 'kong' ? 4 : 3 }).map((_, k) => <Tile key={k} t={m.tile} small laizi={laizi} />)}
                </div>
              ))}
              {me.revealed.map((_, i) => (
                <Tile key={`r${i}`} t={g.current.laizi} small laizi={laizi} dim />
              ))}
            </div>
          )}
          {/* 操作按钮 */}
          {prompt?.kind === 'discard' && (
            <div className="flex gap-2 mb-1.5">
              {prompt.huAvailable && (
                <Button size="sm" className="bg-red-600 hover:bg-red-500 font-bold" onClick={() => answer('hu')}>胡！</Button>
              )}
              {prompt.kongTile !== null && (
                <Button size="sm" className="bg-amber-600 hover:bg-amber-500" onClick={() => answer({ kong: prompt.kongTile })}>杠 {tileLabel(prompt.kongTile)}</Button>
              )}
              {prompt.flipTrio !== null && (
                <Button size="sm" className="bg-amber-700 hover:bg-amber-600" onClick={() => answer({ kong3: prompt.flipTrio })}>暗杠 {tileLabel(prompt.flipTrio)}（赖子皮 3 张）</Button>
              )}
              {prompt.revealAvail && (
                <Button size="sm" className="bg-purple-700 hover:bg-purple-600" onClick={() => answer('reveal')}>亮1个赖子</Button>
              )}
              {prompt.revealTwoAvail && (
                <Button size="sm" className="bg-purple-800 hover:bg-purple-700" onClick={() => answer('reveal2')}>亮2个赖子</Button>
              )}
              <Button size="sm" variant="outline" className="border-emerald-500 text-emerald-200" onClick={() => setShowHint(h => !h)}>
                <Lightbulb className="w-3.5 h-3.5 mr-1" />{showHint ? '隐藏提示' : '显示提示'}
              </Button>
            </div>
          )}
          {prompt?.kind === 'pong' && (
            <div className="flex gap-2 mb-1.5">
              <Button size="sm" className="bg-amber-600 hover:bg-amber-500 font-bold" onClick={() => answer(true)}>碰 {tileLabel(prompt.tile)}</Button>
              <Button size="sm" variant="outline" className="border-emerald-500 text-emerald-200" onClick={() => answer(false)}>过</Button>
            </div>
          )}
          {prompt?.kind === 'gong' && (
            <div className="flex gap-2 mb-1.5">
              <Button size="sm" className="bg-red-700 hover:bg-red-600 font-bold" onClick={() => answer(true)}>杠 {tileLabel(prompt.tile)}（点炮方给 2 分）</Button>
              <Button size="sm" variant="outline" className="border-emerald-500 text-emerald-200" onClick={() => answer(false)}>过</Button>
            </div>
          )}
          {/* 手牌：相同牌张相邻，按牌面从大到小排列；赖子只能亮出、不能打出 */}
          <div className="flex flex-wrap gap-1 justify-center">
            {me?.hand.slice().sort((a, b) => b - a).map((t, i) => (
              <Tile key={i} t={t} laizi={laizi}
                noDiscard={t === laizi}
                onClick={prompt?.kind === 'discard' && t !== laizi ? () => answer({ discard: t }) : undefined} />
            ))}
          </div>
        </div>
      </div>

      {/* 结算弹窗 */}
      <Dialog open={prompt?.kind === 'over'}>
        <DialogContent className="max-w-xs bg-emerald-950 text-stone-100 border-emerald-700">
          {prompt?.kind === 'over' && (
            <>
              <DialogHeader><DialogTitle className="text-center text-xl">
                {g.current.players[prompt.result.winner].name} 自摸和牌！
              </DialogTitle></DialogHeader>
              <div className="text-center text-sm text-stone-300 mb-2">
                {prompt.result.usedWild === 0 ? '不带赖子胡（2倍）' : '带赖子胡（1倍）'}
                {prompt.result.revealedCount > 0 && ` × 亮${prompt.result.revealedCount}个赖子`}
              </div>
              <div className="flex flex-wrap gap-1 justify-center mb-3">
                {prompt.result.handTiles.slice().sort((a, b) => a - b).map((t, i) => <Tile key={i} t={t} small laizi={laizi} />)}
              </div>
              <div className="text-center text-amber-300 text-lg font-bold mb-3">倍数 ×{prompt.result.mult}</div>
              <div className="grid grid-cols-4 gap-1 text-center text-sm mb-3">
                {g.current.players.map((p, i) => (
                  <div key={i} className={i === prompt.result.winner ? 'text-amber-300 font-bold' : 'text-stone-400'}>
                    <div>{p.name}</div><div>{p.score}</div>
                  </div>
                ))}
              </div>
              {g.current.kongPts.some(v => v > 0) && (
                <div className="text-center text-xs text-stone-400 mb-3">
                  本局杠牌得分：{g.current.players.map((p, i) => g.current.kongPts[i] > 0 ? `${p.name} +${g.current.kongPts[i]}` : null).filter(Boolean).join('，')}
                </div>
              )}
              <Button className="w-full bg-emerald-600 hover:bg-emerald-500" onClick={() => answer(null)}>下一局（赢家连庄）</Button>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 流局弹窗 */}
      <Dialog open={prompt?.kind === 'liuju'}>
        <DialogContent className="max-w-xs bg-emerald-950 text-stone-100 border-emerald-700">
          <DialogHeader><DialogTitle className="text-center">流局</DialogTitle></DialogHeader>
          <p className="text-center text-sm text-stone-300 mb-3">牌墙摸完，本局作废，庄家不变。</p>
          <Button className="w-full bg-emerald-600 hover:bg-emerald-500" onClick={() => answer(null)}>下一局</Button>
        </DialogContent>
      </Dialog>

      <Tutorial open={showTutorial} onClose={() => setShowTutorial(false)} />
    </div>
  );
}

// ---------- 对手视图 ----------
function Opponent({ p, active, laizi, horizontal }: { p: PlayerState; active: boolean; laizi: number; horizontal?: boolean }) {
  if (!p) return <div className={horizontal ? 'w-24' : 'h-16'} />;
  const river = p.discards.slice(-8);
  const body = (
    <div className={`rounded-lg border p-1.5 ${active ? 'border-amber-400 bg-emerald-800/60' : 'border-emerald-700/50 bg-emerald-900/50'} ${horizontal ? 'w-24' : ''}`}>
      <div className="flex items-center justify-between px-0.5 mb-1">
        <span className={`text-xs font-bold ${active ? 'text-amber-300' : 'text-stone-300'}`}>{p.name}{active ? ' ●' : ''}</span>
        <span className="text-[10px] text-stone-400">{p.score}分</span>
      </div>
      <div className="flex gap-0.5 flex-wrap mb-1 min-h-[18px]">
        {p.melds.map((m, i) => (
          <div key={i} className="flex gap-px">
            {Array.from({ length: m.type === 'kong' ? 4 : 3 }).map((_, k) => <Tile key={k} t={m.tile} small laizi={laizi} />)}
          </div>
        ))}
        {p.revealed.map((_, i) => <Tile key={`r${i}`} t={laizi} small laizi={laizi} dim />)}
      </div>
      <div className="flex gap-0.5 flex-wrap min-h-[18px]">
        {river.map((t, i) => <Tile key={i} t={t} small laizi={laizi} />)}
      </div>
      {!horizontal && (
        <div className="flex justify-center mt-1">
          <span className="text-[10px] text-stone-400">手牌 {p.hand.length} 张</span>
        </div>
      )}
    </div>
  );
  return body;
}

// ---------- 教学 ----------
function Tutorial({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm bg-emerald-950 text-stone-100 border-emerald-700 max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>玩法教学 · 湖北赖子麻将</DialogTitle></DialogHeader>
        <Tabs defaultValue="rules">
          <TabsList className="grid grid-cols-3 bg-emerald-900">
            <TabsTrigger value="rules">规则</TabsTrigger>
            <TabsTrigger value="score">算倍</TabsTrigger>
            <TabsTrigger value="tips">技巧</TabsTrigger>
          </TabsList>
          <TabsContent value="rules" className="text-sm leading-6 text-stone-300 mt-2 space-y-2">
            <p>· 万条筒三门 108 张，无风牌字牌，每人 13 张起手。</p>
            <p>· <b className="text-stone-100">只能碰不能吃</b>；但别人打出你需要的第 4 张时可以<b className="text-stone-100">明杠</b>（手上需已有 3 张）。没有七对、十三幺等特殊牌型，和牌必须是「4 副面子 + 1 对将」。</p>
            <p>· <b className="text-stone-100">杠牌即时给分</b>，不论本局是否和牌：明杠由点炮方给 2 分；暗杠每家给 2 分；先碰后自己摸成杠（后杠/补杠）每家给 1 分。</p>
            <p>· 摸完牌后翻一张牌定赖子（如翻 5 万则 6 万是赖子，翻 9 则循环到 1）。<b className="text-stone-100">翻出的那张牌（赖子皮）全局只剩 3 张</b>：自己摸到 3 张可申报<b className="text-stone-100">暗杠</b>——按暗杠计分（每家 2 分），但只亮 3 张、<b className="text-stone-100">不从牌尾补牌</b>，申报完正常出牌；也可以不申报，直接当普通刻子和牌。碰了赖子皮则永远没有机会回头杠。</p>
            <p>· 赖子有两种用法：<b className="text-stone-100">当原牌</b>用（不占名额），或当<b className="text-stone-100">万能牌</b>用——<b className="text-purple-300">和牌时最多只能用 1 张万能赖子</b>。</p>
            <p>· <b className="text-purple-300">赖子不能打出，只能亮出</b>。轮到自己时，只要手上有赖子就可以选择<b className="text-purple-300">亮出</b>（有 2 个及以上可一次亮 2 个）：亮出的赖子放到桌面，并从牌尾补摸 1 张（类似杠牌）。4 个赖子可以全亮。注意：亮出唯一的赖子会失去万能牌，谨慎选择。</p>
            <p>· 只能<b className="text-stone-100">自摸</b>和牌，没有点炮；可以碰后补杠、暗杠，杠上开花有效；不能抢杠。</p>
            <p>· 牌墙摸完无人和牌则<b className="text-stone-100">流局作废</b>，庄家不下庄；谁和牌谁坐庄。</p>
          </TabsContent>
          <TabsContent value="score" className="text-sm leading-6 text-stone-300 mt-2 space-y-2">
            <p>基础倍数 1，按两个因素累乘：</p>
            <p>· <b className="text-stone-100">和牌方式</b>：不带赖子（万能牌）和牌 = <b className="text-amber-300">2 倍</b>；带 1 张赖子和牌 = 1 倍。</p>
            <p>· <b className="text-stone-100">亮赖子</b>：每亮出 1 个赖子，倍数再 ×2。</p>
            <p>· <b className="text-purple-300">输家也算自己的</b>：谁亮过赖子，谁输的时候就按 ×2^亮数 加罚——亮的赖子赢了加倍、输了也加倍。</p>
            <div className="rounded bg-emerald-900/70 p-2 text-xs space-y-1">
              <p>带赖子胡，没亮过：1 倍</p>
              <p>带赖子胡 + 亮 1 个：2 倍</p>
              <p>不带赖子胡，没亮过：2 倍</p>
              <p>不带赖子胡 + 亮 1 个：4 倍</p>
              <p>不带赖子胡 + 亮 2 个：8 倍</p>
              <p className="text-stone-200 font-bold pt-1">输家罚分 = 赢家倍数 × 2^(自己亮赖子数)</p>
              <p>例：对手没亮、不带赖子自摸（4 倍），你亮过 1 个赖子 → 你输 4×2 = 8 分</p>
            </div>
            <p>赢家得各家罚分之和，各输家按自己的倍数扣。</p>
            <div className="rounded bg-emerald-900/70 p-2 text-xs space-y-1">
              <p className="text-stone-200 font-bold">杠牌计分（即时结算，流局也算）</p>
              <p>明杠（杠别人打出的牌）：点炮方给 2 分</p>
              <p>暗杠（自己摸到 4 张）：每家给 2 分，共 +6</p>
              <p>后杠/补杠（碰后又摸到）：每家给 1 分，共 +3</p>
            </div>
          </TabsContent>
          <TabsContent value="tips" className="text-sm leading-6 text-stone-300 mt-2 space-y-2">
            <p>· <b className="text-stone-100">赖子当原牌不亏</b>：能当普通牌组成面子时，尽量别浪费万能牌名额，留它当「万能钥匙」。</p>
            <p>· <b className="text-stone-100">不带赖子胡是 2 倍</b>：听牌时优先选择不依赖赖子的听口，倍数直接翻倍。</p>
            <p>· <b className="text-purple-300">亮赖子是双刃剑</b>：每亮 1 个倍数 ×2，但手牌少一张、赖子变少。手牌顺利时多亮赚倍数，牌型差时留赖子保命。</p>
            <p>· 听牌后留意：剩下的赖子如果摸到第 2 张，亮出去可以再×2，还可能杠上开花。</p>
            <p>· 多出提示会告诉你每种打法的听牌张数与倍数潜力，跟着★推荐走能快速上手。</p>
          </TabsContent>
        </Tabs>
        <Button className="w-full mt-3 bg-emerald-600 hover:bg-emerald-500" onClick={onClose}>明白了</Button>
      </DialogContent>
    </Dialog>
  );
}
