// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
// Push-optimal per room: every level is a hallway plus 1-4 rooms (3-4 boxes
// each); a box pushed out of a door into the hallway can never come back, so
// each room is solved on its own and the move strings are concatenated, the
// player walking through the hallway between rooms.
//
// Per room: A* over pushes. A state is the sorted box squares plus the
// lowest square of the player's reachable region (boxes as walls). The
// heuristic is the min-cost assignment of boxes to goals by push-distance
// (BFS distances ignoring other boxes), which is admissible, so the first
// goal state popped is push-optimal. Deadlock pruning: dead squares (no push
// path to any goal ignoring other boxes) and frozen 2x2 blocks of walls and
// boxes with a box off its goal. Fallbacks, in order, if A* exhausts its
// deterministic expansion budget: plain BFS over pushes, weighted A*, greedy
// best-first. Everything is budgeted by deterministic expansion counts, never
// by the wall clock and never by randomness, so two runs are byte-identical.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [dx, dy, walk letter]. Pushes use the same directions.
const DIRS: readonly (readonly [number, number, string])[] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

// Deterministic work budgets (expansion counts, never the clock).
const ASTAR_CAP = 150_000;
const BFS_CAP = 250_000;
const FALLBACK_CAP = 200_000;
const GREEDY_CAP = 50_000;
// Shared across the whole run: the optimal stages (A*, BFS, weighted) may
// spend at most this many expansions in total, so a pathological room can
// never push the 5-level run past the 60s wall; past it, rooms go straight
// to greedy, which itself stops at the hard cap. Practice uses ~300.
const OPTIMAL_BUDGET = 1_000_000;
const HARD_BUDGET = 1_500_000;
let spentExpansions = 0;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Squares from which a box alone can be pushed onto some goal: reverse push
 * BFS from the goals. A box at y can be pushed to x = y + d when y - d (the
 * player's square) and y are both floor.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Push distances to one goal: dist[c] is the fewest pushes moving a box from
 * c onto the goal, ignoring other boxes (-1 when unreachable).
 */
function pushDistTo(w: number, wall: Uint8Array, goal: number): Int32Array {
  const size = wall.length;
  const dist = new Int32Array(size).fill(-1);
  const queue: number[] = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && dist[y] < 0) {
        dist[y] = dist[x]! + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor; each part left holding a
 * box is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const c = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = c + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Binary heap of state ids, ordered by (f asc, g desc, id asc). Deterministic. */
class Heap {
  private a: number[] = [];
  private readonly f: Int32Array;
  private readonly g: Int32Array;
  constructor(f: Int32Array, g: Int32Array) {
    this.f = f;
    this.g = g;
  }
  get size(): number {
    return this.a.length;
  }
  private less(x: number, y: number): boolean {
    if (this.f[x] !== this.f[y]) return this.f[x]! < this.f[y]!;
    if (this.g[x] !== this.g[y]) return this.g[x]! > this.g[y]!;
    return x < y;
  }
  push(id: number): void {
    const a = this.a;
    a.push(id);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && this.less(a[c + 1]!, a[c]!)) c++;
        if (!this.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
}

interface RoomSolution {
  pushes: number;
  moves: string;
  expansions: number;
}

/**
 * Solve one room's sub-level (its goals, its boxes, other rooms' boxes as
 * walls) with push A*. `weight` scales the heuristic: 1 is optimal A*, 0 is
 * plain BFS, >1 weighted, 100 near-greedy. `budget` is the shared-expansion
 * ceiling this call may spend up to. Returns null past `cap` or `budget`.
 */
function solveRoomPush(
  sub: Level,
  weight: number,
  cap: number,
  budget: number,
): RoomSolution | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = sub;
  const n = startBoxes.length;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (startBoxes.some((b) => !live[b])) return null;
  const isSolved = (bs: Uint16Array, off: number): boolean => {
    for (let i = 0; i < n; i++) if (!goal[bs[off + i]!]) return false;
    return true;
  };
  if (isSolved(Uint16Array.from(startBoxes), 0)) {
    return { pushes: 0, moves: '', expansions: 0 };
  }

  // Push-distance tables, one per goal, for the assignment heuristic.
  const dists = goals.map((g) => pushDistTo(w, wall, g));
  // All bijections boxes -> goals, as permutations of goal indices.
  const perms: number[][] = [];
  {
    const idx = goals.map((_, i) => i);
    const gen = (k: number): void => {
      if (k === idx.length) {
        perms.push(idx.slice());
        return;
      }
      for (let i = k; i < idx.length; i++) {
        [idx[k], idx[i]] = [idx[i]!, idx[k]!];
        gen(k + 1);
        [idx[k], idx[i]] = [idx[i]!, idx[k]!];
      }
    };
    gen(0);
  }
  const heuristic = (bs: Uint16Array, off: number): number => {
    let best = Infinity;
    for (const p of perms) {
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const d = dists[p[i]!]![bs[off + i]!]!;
        if (d < 0) {
          cost = Infinity;
          break;
        }
        cost += d;
      }
      if (cost < best) best = cost;
    }
    return best;
  };

  const useH = weight > 0;
  const capStates = cap + 1;
  const boxesFlat = new Uint16Array(capStates * n);
  const lowArr = new Uint16Array(capStates);
  const gArr = new Int32Array(capStates);
  const fArr = new Int32Array(capStates);
  const parent = new Int32Array(capStates).fill(-1);
  const pushFrom = new Uint16Array(capStates);
  const pushDir = new Uint8Array(capStates);
  const bestG = new Map<number, number>();
  const idByKey = new Map<number, number>();
  const keyOf = (bs: ArrayLike<number>, low: number): number => {
    let k = low;
    for (let i = 0; i < n; i++) k = k * size + bs[i]!;
    return k;
  };

  // Two flood-fill mark arrays: `seen` holds the state being expanded (push
  // feasibility reads it), `mark` holds successor regions (their keys). They
  // must stay separate: a successor's fill must not erase the expansion's.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let seenStamp = 0;
  let markStamp = 0;
  const reach = (arr: Int32Array, stamp: number, occupied: Uint8Array, from: number): number => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    arr[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= size) continue;
        if (!wall[q] && !occupied[q] && arr[q] !== stamp) {
          arr[q] = stamp;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };

  const occupied = new Uint8Array(size);
  for (const b of startBoxes) occupied[b] = 1;
  const startLow = reach(mark, ++markStamp, occupied, startPlayer);
  for (const b of startBoxes) occupied[b] = 0;

  let count = 0;
  // Stores a state; returns its id, or -1 when its heuristic is infinite
  // (dead in combination: no bijection of boxes to reachable goals).
  const store = (bs: ArrayLike<number>, low: number, g: number, par: number, from: number, dir: number): number => {
    const id = count;
    for (let i = 0; i < n; i++) boxesFlat[id * n + i] = bs[i]!;
    const h = useH ? heuristic(boxesFlat, id * n) : 0;
    if (h === Infinity) return -1;
    count++;
    lowArr[id] = low;
    gArr[id] = g;
    parent[id] = par;
    pushFrom[id] = from;
    pushDir[id] = dir;
    fArr[id] = g + Math.round(weight * h);
    const key = keyOf(bs, low);
    bestG.set(key, g);
    idByKey.set(key, id);
    return id;
  };
  const startId = store(startBoxes, startLow, 0, -1, 0, 0);
  if (startId < 0) return null;
  const heap = new Heap(fArr, gArr);
  heap.push(startId);

  const sorted = new Array<number>(n);
  let expansions = 0;
  let found = -1;
  while (heap.size > 0) {
    const id = heap.pop();
    const off = id * n;
    if (gArr[id]! > bestG.get(keyOf(boxesFlat.subarray(off, off + n), lowArr[id]!))!) continue; // stale
    if (isSolved(boxesFlat, off)) {
      found = id;
      break;
    }
    expansions++;
    spentExpansions++;
    if (expansions > cap || spentExpansions > budget) return null;
    for (let i = 0; i < n; i++) occupied[boxesFlat[off + i]!] = 1;
    // Flood the player's region for this state (from its lowest square,
    // which lies in the region, so the fill reproduces it exactly).
    const regionStamp = ++seenStamp;
    reach(seen, regionStamp, occupied, lowArr[id]!);
    for (let bi = 0; bi < n; bi++) {
      const b = boxesFlat[off + bi]!;
      for (let dir = 0; dir < 4; dir++) {
        const [dx, dy] = DIRS[dir]!;
        const d = dy * w + dx;
        const t = b + d;
        const behind = b - d;
        if (t < 0 || t >= size || behind < 0 || behind >= size) continue;
        if (seen[behind] !== regionStamp || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        // Frozen 2x2 check on the pushed box's new square.
        let frozen = false;
        for (const a of [t, t - 1, t - w, t - w - 1]) {
          const bb = a + 1;
          const c = a + w;
          const dd = c + 1;
          if (a < 0 || bb < 0 || c < 0 || dd < 0 || a >= size || bb >= size || c >= size || dd >= size) continue;
          if (!(wall[a] || occupied[a]) || !(wall[bb] || occupied[bb]) || !(wall[c] || occupied[c]) || !(wall[dd] || occupied[dd])) continue;
          if ((occupied[a] && !goal[a]) || (occupied[bb] && !goal[bb]) || (occupied[c] && !goal[c]) || (occupied[dd] && !goal[dd])) {
            frozen = true;
            break;
          }
        }
        if (frozen) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        for (let i = 0; i < n; i++) sorted[i] = boxesFlat[off + i]!;
        sorted[bi] = t;
        sorted.sort((x, y) => x - y);
        const newLow = reach(mark, ++markStamp, occupied, b);
        const key = keyOf(sorted, newLow);
        const g2 = gArr[id]! + 1;
        const prev = bestG.get(key);
        if (prev === undefined || g2 < prev) {
          if (prev === undefined) {
            if (count >= capStates) {
              for (let i = 0; i < n; i++) occupied[sorted[i]!] = 0;
              return null;
            }
            const nid = store(sorted, newLow, g2, id, b, dir);
            if (nid >= 0) heap.push(nid);
          } else {
            // Re-open with a better g: rewrite this state's record.
            const existing = idByKey.get(key)!;
            for (let i = 0; i < n; i++) boxesFlat[existing * n + i] = sorted[i]!;
            lowArr[existing] = newLow;
            gArr[existing] = g2;
            parent[existing] = id;
            pushFrom[existing] = b;
            pushDir[existing] = dir;
            const h = useH ? heuristic(boxesFlat, existing * n) : 0;
            fArr[existing] = g2 + Math.round(weight * h);
            bestG.set(key, g2);
            heap.push(existing);
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (let i = 0; i < n; i++) occupied[boxesFlat[off + i]!] = 0;
  }
  if (found < 0) return null;

  // Reconstruct the push path, then the walk + push moves.
  const path: { from: number; dir: number }[] = [];
  for (let s = found; s > 0; s = parent[s]!) {
    path.push({ from: pushFrom[s]!, dir: pushDir[s]! });
  }
  path.reverse();
  let moves = '';
  let player = startPlayer;
  const boxesNow = startBoxes.slice();
  for (const step of path) {
    const [dx, dy, letter] = DIRS[step.dir]!;
    const d = dy * w + dx;
    const to = step.from + d;
    for (const b of boxesNow) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, step.from - d);
    for (const b of boxesNow) occupied[b] = 0;
    moves += letter;
    player = step.from;
    const at = boxesNow.indexOf(step.from);
    boxesNow[at] = to;
    boxesNow.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves, expansions };
}

/** Shortest walk from `from` to `to` around walls and boxes (DIRS order on ties). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Solve one room with the fallback chain: A* (optimal), BFS, weighted, then
 * greedy. The first three stages share the optimal budget; once it is spent
 * (a pathological room on a slow draw), later rooms go straight to greedy,
 * which dives for any solution under the hard budget. Any solution beats
 * none: a room solved one push over P* still earns ~500 of its 1000 points.
 */
function solveRoom(sub: Level): RoomSolution | null {
  const stages: [number, number, number][] = [
    [1, ASTAR_CAP, OPTIMAL_BUDGET],
    [0, BFS_CAP, OPTIMAL_BUDGET],
    [3, FALLBACK_CAP, OPTIMAL_BUDGET],
    [100, GREEDY_CAP, HARD_BUDGET],
  ];
  for (const [weight, cap, budget] of stages) {
    if (spentExpansions >= budget) continue;
    const sol = solveRoomPush(sub, weight, cap, budget);
    if (sol !== null) return sol;
  }
  return null;
}

/** Solve a whole level (no room structure) with the same chain. */
function solveWhole(level: Level): string {
  const sol =
    solveRoomPush(level, 1, ASTAR_CAP, OPTIMAL_BUDGET) ??
    solveRoomPush(level, 0, BFS_CAP, OPTIMAL_BUDGET) ??
    solveRoomPush(level, 100, GREEDY_CAP, HARD_BUDGET);
  return sol ? sol.moves : '';
}

/** Solve one level's text into its move string. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) return solveWhole(level);
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub);
    if (solved === null) return moves; // partial: the level scores 0 anyway
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
