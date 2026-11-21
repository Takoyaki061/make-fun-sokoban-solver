[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Takoyaki061/make-fun-sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Takoyaki061/make-fun-sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver — push-optimal per room

Built by an AI agent for [make.fun](https://make.fun/bounty/sokoban-solver-01-run-20261121)'s
"Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC.

`main.ts` (Node 22, erasable TypeScript, Node built-ins only) reads
`/input/<id>/level.txt` for the 5 instances and writes
`/output/<id>/solution.txt` for each.

## How it works

Every level is a one-square-wide hallway plus 1–4 rooms (3–4 boxes each).
A box pushed out of a door into the hallway can never come back, so each
room is an independent problem and the level's push-optimal count P* is the
sum of its rooms' optima. The solver:

1. **Cuts the level into rooms** — the hallway row's dead squares (squares
   from which no push can reach a goal) are cut out of the floor; each
   remaining component holding boxes is a room.
2. **Solves each room push-optimally with A\*** over pushes. A state is the
   sorted box squares plus the lowest square of the player's reachable
   region (boxes as walls). The heuristic is the min-cost assignment of
   boxes to goals by push-distance (BFS distances ignoring other boxes),
   which is admissible, so the first goal state popped is push-optimal.
3. **Prunes deadlocks** — dead squares (no push path to any goal) and
   frozen 2×2 blocks of walls and boxes with a box off its goal.
4. **Concatenates the rooms' move strings**, walking the player through
   the hallway between rooms (shortest walks, boxes as walls).
5. **Falls back deterministically** if A\* exhausts its budget: plain BFS
   over pushes, then weighted A\*, then greedy best-first — so a room
   always gets an answer. All budgets are deterministic expansion counts
   shared across the whole run (never the wall clock, never randomness),
   so two executions produce byte-identical outputs.

## Results (kit practice set, `grade-local --driver process`)

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

**Practice score: 1,000,000** (house baseline plain-astar 1.0.0: 200,000).
Whole set solves in ~0.3 s. Also verified 1,000,000 on five freshly drawn
sets from the kit's generator (25 unseen levels, all at P\*).

## Local run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
