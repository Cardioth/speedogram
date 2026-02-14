const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createRedisClient } = require("./redisClient");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const STATIC_DIR = path.join(__dirname);
const TOTAL_LIVES = 3;
const GRID_SIZE_INTERVALS = [3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9, 9, 10, 10];
const TIME_LIMIT_INIT = 12000;
const TIME_INCREMENT = 0;
const MATCH_COUNTDOWN_MS = 3000;
const TOTAL_ROUNDS = 5;
const SHOP_TIER_CONFIG = {
  common: { multiplier: 1, label: "Common" },
  rare: { multiplier: 1.5, label: "Rare" },
  epic: { multiplier: 2, label: "Epic" }
};
const UPGRADE_DEFS = [
  { id: "extra-second-per-solve", description: "+{value}s more time per puzzle solved", tier: "common", cost: 3, baseValue: 1, effect: "perSolveTimeBonusMs", effectScale: 1000 },
  { id: "start-revealed-cell", description: "+{value} revealed starting cell(s)", tier: "common", cost: 4, baseValue: 1, effect: "startRevealedCells", effectScale: 1 },
  { id: "plus-5-start-time", description: "+{value}s starting time", tier: "rare", cost: 6, baseValue: 5, effect: "startingTimeBonusMs", effectScale: 1000 },
  { id: "plus-2-next-round-points", description: "+{value} bonus point(s) next round", tier: "rare", cost: 7, baseValue: 2, effect: "nextRoundPointBonus", effectScale: 1 },
  { id: "opp-minus-2-start-time", description: "Opponent -{value}s starting time", tier: "epic", cost: 9, baseValue: 2, effect: "incomingStartPenaltyMs", effectScale: 1000, target: "opponent" },
  { id: "opp-bomb-cell", description: "Plant bomb trap for opponent", tier: "epic", cost: 8, baseValue: 1, effect: "incomingBombNextRound", target: "opponent", booleanEffect: true }
];

const players = new Map();
const waitingQueue = [];
const matches = new Map();
const leaderboard = new Map();
const LEADERBOARD_LIMIT = 10;
function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const REDIS_URL = readEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_URL");
const REDIS_TOKEN = readEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_TOKEN", "UPSTASH_REDIS_PASSWORD");
const LEADERBOARD_REDIS_KEY = "speedogram:leaderboard";
const LEADERBOARD_META_REDIS_KEY = "speedogram:leaderboard:meta";
let redisClient = null;

async function runRedisCommand(command, args = []) {
  if (!redisClient) {
    throw new Error("Redis client is not connected.");
  }
  return redisClient.command(command, args);
}

async function connectRedis() {
  if (!REDIS_URL) {
    throw new Error("[leaderboard] Missing Redis URL. Set UPSTASH_REDIS_REST_URL (or KV_REST_API_URL/REDIS_URL).");
  }

  if (!REDIS_TOKEN) {
    throw new Error("[leaderboard] Missing Redis token. Set UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN/REDIS_TOKEN/UPSTASH_REDIS_PASSWORD).");
  }

  redisClient = createRedisClient({ url: REDIS_URL, token: REDIS_TOKEN });
  console.log(`[leaderboard] Connecting to Redis via ${REDIS_URL.replace(/\/$/, "")}`);
  await runRedisCommand("PING");
  console.log("[leaderboard] Connected to Redis.");
}

async function loadLeaderboardFromRedis() {
  const entries = await runRedisCommand("ZREVRANGE", [LEADERBOARD_REDIS_KEY, 0, LEADERBOARD_LIMIT - 1, "WITHSCORES"]);
  leaderboard.clear();
  const ids = [];
  const scoreMap = new Map();

  for (let index = 0; index < entries.length; index += 2) {
    const id = entries[index];
    const score = Number(entries[index + 1]) || 0;
    ids.push(id);
    scoreMap.set(id, score);
  }

  const metaRecords = ids.length ? await runRedisCommand("HMGET", [LEADERBOARD_META_REDIS_KEY, ...ids]) : [];

  ids.forEach((id, index) => {
    let parsed = {};
    if (metaRecords[index]) {
      try {
        parsed = JSON.parse(metaRecords[index]);
      } catch (_error) {
        parsed = {};
      }
    }
    leaderboard.set(id, {
      id,
      name: parsed.name || "Anon",
      bestPoints: Math.max(0, Math.floor(scoreMap.get(id) || 0)),
      updatedAt: Number(parsed.updatedAt) || Date.now()
    });
  });
}

async function persistLeaderboardEntry(entry) {
  await runRedisCommand("ZADD", [LEADERBOARD_REDIS_KEY, entry.bestPoints, entry.id]);
  await runRedisCommand("HSET", [LEADERBOARD_META_REDIS_KEY, entry.id, JSON.stringify({ name: entry.name, updatedAt: entry.updatedAt })]);
  const total = Number(await runRedisCommand("ZCARD", [LEADERBOARD_REDIS_KEY])) || 0;
  const entriesOverLimit = total - LEADERBOARD_LIMIT;
  if (entriesOverLimit > 0) {
    const removedIds = await runRedisCommand("ZRANGE", [LEADERBOARD_REDIS_KEY, 0, entriesOverLimit - 1]);
    if (removedIds.length) {
      await runRedisCommand("HDEL", [LEADERBOARD_META_REDIS_KEY, ...removedIds]);
    }
    await runRedisCommand("ZREMRANGEBYRANK", [LEADERBOARD_REDIS_KEY, 0, entriesOverLimit - 1]);
  }
}

function makePlayerTag(playerId) {
  return String(playerId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-4) || "0000";
}

function makeAnonTag(playerId) {
  const source = String(playerId || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash * 31) + source.charCodeAt(i)) % 1000;
  }
  return String(hash).padStart(3, "0");
}

function buildDisplayName(baseName, playerId, hasChosenName) {
  if (hasChosenName && typeof baseName === "string" && baseName.trim()) {
    return baseName.trim().slice(0, 24);
  }
  return `Anon#${makeAnonTag(playerId)}`;
}

function buildPlayerName(baseName, playerId) {
  const safeBaseName = String(baseName || "Anon").trim().slice(0, 24) || "Anon";
  return `${safeBaseName}#${makePlayerTag(playerId)}`;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, leaderboardStorage: "redis", redisConnected: Boolean(redisClient) });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

app.use(express.static(STATIC_DIR, { index: false }));

function makePuzzle(gridSize) {
  const grid = [];
  const gridGuesses = [];
  const columnsTotal = [];
  const rowsTotal = [];
  const Xcounters = [];
  const Ycounters = [];

  for (let i = 0; i < gridSize; i += 1) {
    const gridX = [];
    const gridGuessesX = [];
    for (let j = 0; j < gridSize; j += 1) {
      let randomNumber = Math.floor(Math.random() * 3);
      if (randomNumber > 1) randomNumber = 1;
      gridX.push(randomNumber);
      gridGuessesX.push(0);
    }
    grid.push(gridX);
    gridGuesses.push(gridGuessesX);
  }

  for (let i = 0; i < gridSize; i += 1) {
    const column = [];
    let count = 0;
    let countTotal = 0;
    for (let j = 0; j < gridSize; j += 1) {
      if (grid[i][j] === 1) {
        count += 1;
        countTotal += 1;
      } else if (count > 0) {
        column.push(count);
        count = 0;
      }
    }
    if (count > 0) column.push(count);
    columnsTotal.push(countTotal);
    Xcounters.push(column);
  }

  for (let i = 0; i < gridSize; i += 1) {
    const row = [];
    let count = 0;
    let countTotal = 0;
    for (let j = 0; j < gridSize; j += 1) {
      if (grid[j][i] === 1) {
        count += 1;
        countTotal += 1;
        if (j === gridSize - 1) row.push(count);
      } else if (count !== 0) {
        row.push(count);
        count = 0;
      }
    }
    rowsTotal.push(countTotal);
    Ycounters.push(row);
  }

  return { grid, gridGuesses, columnsTotal, rowsTotal, Xcounters, Ycounters };
}

function hashSeed(input) {
  const source = String(input || "seed");
  let hash = 1779033703;
  for (let i = 0; i < source.length; i += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return (hash >>> 0) || 1;
}

function makeSeededRandom(seedInput) {
  let state = hashSeed(seedInput);
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePuzzleWithRandom(gridSize, randomFn) {
  const grid = [];
  const gridGuesses = [];
  const columnsTotal = [];
  const rowsTotal = [];
  const Xcounters = [];
  const Ycounters = [];

  for (let i = 0; i < gridSize; i += 1) {
    const gridX = [];
    const gridGuessesX = [];
    for (let j = 0; j < gridSize; j += 1) {
      let randomNumber = Math.floor(randomFn() * 3);
      if (randomNumber > 1) randomNumber = 1;
      gridX.push(randomNumber);
      gridGuessesX.push(0);
    }
    grid.push(gridX);
    gridGuesses.push(gridGuessesX);
  }

  for (let i = 0; i < gridSize; i += 1) {
    const column = [];
    let count = 0;
    let countTotal = 0;
    for (let j = 0; j < gridSize; j += 1) {
      if (grid[i][j] === 1) {
        count += 1;
        countTotal += 1;
      } else if (count > 0) {
        column.push(count);
        count = 0;
      }
    }
    if (count > 0) column.push(count);
    columnsTotal.push(countTotal);
    Xcounters.push(column);
  }

  for (let i = 0; i < gridSize; i += 1) {
    const row = [];
    let count = 0;
    let countTotal = 0;
    for (let j = 0; j < gridSize; j += 1) {
      if (grid[j][i] === 1) {
        count += 1;
        countTotal += 1;
        if (j === gridSize - 1) row.push(count);
      } else if (count !== 0) {
        row.push(count);
        count = 0;
      }
    }
    rowsTotal.push(countTotal);
    Ycounters.push(row);
  }

  return { grid, gridGuesses, columnsTotal, rowsTotal, Xcounters, Ycounters };
}

function clonePuzzle(puzzle) {
  return {
    grid: puzzle.grid.map((column) => column.slice()),
    gridGuesses: puzzle.gridGuesses.map((column) => column.slice()),
    columnsTotal: puzzle.columnsTotal.slice(),
    rowsTotal: puzzle.rowsTotal.slice(),
    Xcounters: puzzle.Xcounters.map((counts) => counts.slice()),
    Ycounters: puzzle.Ycounters.map((counts) => counts.slice())
  };
}

function getRoundPuzzle(match, round, level, gridSize) {
  if (!match.roundPuzzleCache) {
    match.roundPuzzleCache = new Map();
  }
  const key = `${round}:${level}:${gridSize}`;
  if (!match.roundPuzzleCache.has(key)) {
    const seededRandom = makeSeededRandom(`${match.id}:${key}`);
    match.roundPuzzleCache.set(key, makePuzzleWithRandom(gridSize, seededRandom));
  }
  return clonePuzzle(match.roundPuzzleCache.get(key));
}

function formatUpgradeLabel(upgradeDef, appliedValue, tierConfig) {
  const multiplierText = `${tierConfig.multiplier}x`;
  const effectText = upgradeDef.description.replace("{value}", String(appliedValue));
  return `[${tierConfig.label} ${multiplierText}] ${effectText} (${upgradeDef.cost} pts)`;
}

function toUpgradeOffer(upgradeDef) {
  const tierConfig = SHOP_TIER_CONFIG[upgradeDef.tier] || SHOP_TIER_CONFIG.common;
  const rawValue = upgradeDef.booleanEffect ? 1 : (upgradeDef.baseValue || 0) * tierConfig.multiplier;
  const appliedValue = upgradeDef.booleanEffect ? 1 : Math.max(1, Math.round(rawValue));
  return {
    id: upgradeDef.id,
    tier: upgradeDef.tier,
    multiplier: tierConfig.multiplier,
    cost: upgradeDef.cost,
    appliedValue,
    label: formatUpgradeLabel(upgradeDef, appliedValue, tierConfig)
  };
}

function chooseRandomUpgrades(count = 3) {
  const pool = [...UPGRADE_DEFS];
  const selected = [];
  while (selected.length < count && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    selected.push(toUpgradeOffer(pool.splice(idx, 1)[0]));
  }
  return selected;
}

function revealInitialCells(state) {
  const revealCount = Math.max(0, state.startRevealedCells || 0);
  const candidates = [];
  for (let x = 0; x < state.gridSize; x += 1) {
    for (let y = 0; y < state.gridSize; y += 1) {
      if (state.grid[x][y] === 1) {
        candidates.push({ x, y });
      }
    }
  }
  for (let i = 0; i < revealCount && candidates.length; i += 1) {
    const idx = Math.floor(Math.random() * candidates.length);
    const cell = candidates.splice(idx, 1)[0];
    state.gridGuesses[cell.x][cell.y] = 1;
  }
}

function configureRoundState(match, state) {
  const roundBonus = state.nextRoundPointBonus || 0;
  const incomingPenalty = state.incomingStartPenaltyMs || 0;

  state.roundPointsBonus = roundBonus;
  state.nextRoundPointBonus = 0;
  state.incomingStartPenaltyMs = 0;

  state.lives = TOTAL_LIVES;
  state.timer = 0;
  state.level = 0;
  updateGridSize(state);

  const baseTime = TIME_LIMIT_INIT + (state.startingTimeBonusMs || 0) - incomingPenalty;
  state.timeLimit = Math.max(3000, baseTime);

  state.puzzleId = (state.puzzleId || 0) + 1;
  Object.assign(state, getRoundPuzzle(match, state.round, state.level, state.gridSize));
  state.bombCell = null;
  state.bombActive = Boolean(state.incomingBombNextRound);
  state.incomingBombNextRound = false;

  if (state.bombActive) {
    const bombCells = [];
    for (let x = 0; x < state.gridSize; x += 1) {
      for (let y = 0; y < state.gridSize; y += 1) {
        if (state.grid[x][y] === 0) {
          bombCells.push({ x, y });
        }
      }
    }
    if (bombCells.length) {
      state.bombCell = bombCells[Math.floor(Math.random() * bombCells.length)];
    } else {
      state.bombActive = false;
    }
  }

  revealInitialCells(state);
}

function makePlayerState(initialMode = "play") {
  const level = 0;
  const gridSize = GRID_SIZE_INTERVALS[level];
  const puzzle = makePuzzle(gridSize);
  return {
    score: 0,
    points: 0,
    level,
    lives: TOTAL_LIVES,
    gameMode: initialMode,
    timer: 0,
    timeLimit: TIME_LIMIT_INIT,
    puzzleId: 1,
    gridSize,
    round: 1,
    perSolveTimeBonusMs: 0,
    startingTimeBonusMs: 0,
    nextRoundPointBonus: 0,
    roundPointsBonus: 0,
    incomingStartPenaltyMs: 0,
    incomingBombNextRound: false,
    startRevealedCells: 0,
    bombActive: false,
    bombCell: null,
    shopOptions: [],
    hasPurchasedThisShop: false,
    winnerText: "",
    ...puzzle
  };
}

function toPublicState(state) {
  return {
    score: state.points,
    points: state.points,
    level: state.level,
    lives: state.lives,
    gameMode: state.gameMode,
    timer: state.timer,
    timeLimit: state.timeLimit,
    round: state.round,
    puzzleId: state.puzzleId,
    shopOptions: state.shopOptions,
    hasPurchasedThisShop: state.hasPurchasedThisShop,
    winnerText: state.winnerText,
    gridSize: state.gridSize,
    grid: state.grid,
    gridGuesses: state.gridGuesses,
    Xcounters: state.Xcounters,
    Ycounters: state.Ycounters
  };
}

function buildPlayerList() {
  return Array.from(players.values()).map((player) => ({
    id: player.id,
    name: player.displayName,
    score: player.lastScore || 0,
    points: player.lastScore || 0,
    level: player.lastLevel || 0,
    lives: player.lastLives ?? TOTAL_LIVES,
    gameMode: player.status
  }));
}

function emitPlayers() {
  io.emit("players:update", buildPlayerList());
}

function updateLeaderboardEntry(playerId, displayName, points) {
  if (typeof playerId !== "string" || !playerId.trim()) return;
  if (typeof displayName !== "string" || !displayName.trim()) return;
  const safePoints = Number.isFinite(points) ? Math.max(0, Math.floor(points)) : 0;
  if (safePoints <= 0) return;
  const existing = leaderboard.get(playerId);
  if (!existing || safePoints > existing.bestPoints) {
    const entry = {
      id: playerId,
      name: displayName,
      bestPoints: safePoints,
      updatedAt: Date.now()
    };
    leaderboard.set(playerId, entry);
    persistLeaderboardEntry(entry).catch((error) => {
      console.error("[leaderboard] Failed to persist leaderboard entry:", error.message);
    });
  }
}

function buildLeaderboard() {
  return Array.from(leaderboard.values())
    .sort((a, b) => {
      if (b.bestPoints !== a.bestPoints) return b.bestPoints - a.bestPoints;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, LEADERBOARD_LIMIT)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      bestPoints: entry.bestPoints
    }));
}

function emitLeaderboard() {
  io.emit("leaderboard:update", buildLeaderboard());
}

function removeFromQueue(socketId) {
  const idx = waitingQueue.indexOf(socketId);
  if (idx >= 0) waitingQueue.splice(idx, 1);
}

function finishMatch(matchId, reason = "finished") {
  const match = matches.get(matchId);
  if (!match) return;
  match.status = reason;
  match.players.forEach((playerId) => {
    const player = players.get(playerId);
    if (player) {
      player.matchId = null;
      player.status = "menu";
    }
  });
  matches.delete(matchId);
  emitPlayers();
  emitLeaderboard();
}

function emitMatchState(match) {
  const [p1Id, p2Id] = match.players;
  const p1 = players.get(p1Id);
  const p2 = players.get(p2Id);
  if (!p1 || !p2) {
    finishMatch(match.id, "player-left");
    return;
  }

  const countdownRemaining = match.roundStartsAt ? Math.max(0, Math.ceil((match.roundStartsAt - Date.now()) / 1000)) : 0;

  p1.lastScore = match.states[p1Id].score;
  p1.lastLevel = match.states[p1Id].level;
  p1.lastLives = match.states[p1Id].lives;
  p2.lastScore = match.states[p2Id].score;
  p2.lastLevel = match.states[p2Id].level;
  p2.lastLives = match.states[p2Id].lives;

  updateLeaderboardEntry(p1.id, p1.displayName, match.states[p1Id].points);
  updateLeaderboardEntry(p2.id, p2.displayName, match.states[p2Id].points);

  io.to(p1Id).emit("match:update", {
    matchId: match.id,
    player: { id: p1.id, name: p1.displayName, ...match.states[p1Id], countdownRemaining },
    opponent: { id: p2.id, name: p2.displayName, ...toPublicState(match.states[p2Id]), countdownRemaining },
    playerRematchRequested: match.rematchVotes?.has(p1Id) || false,
    opponentRematchRequested: match.rematchVotes?.has(p2Id) || false
  });
  io.to(p2Id).emit("match:update", {
    matchId: match.id,
    player: { id: p2.id, name: p2.displayName, ...match.states[p2Id], countdownRemaining },
    opponent: { id: p1.id, name: p1.displayName, ...toPublicState(match.states[p1Id]), countdownRemaining },
    playerRematchRequested: match.rematchVotes?.has(p2Id) || false,
    opponentRematchRequested: match.rematchVotes?.has(p1Id) || false
  });
  emitPlayers();
  emitLeaderboard();
}

function updateGridSize(state) {
  state.gridSize = GRID_SIZE_INTERVALS[state.level] || GRID_SIZE_INTERVALS[GRID_SIZE_INTERVALS.length - 1];
}

function checkVictory(match, state) {
  const totalGridSize = state.gridSize * state.gridSize;
  let totalGuesses = 0;
  for (let i = 0; i < state.gridSize; i += 1) {
    for (let j = 0; j < state.gridSize; j += 1) {
      if (state.gridGuesses[i][j] === 1) {
        totalGuesses += 1;
      }
    }
  }
  if (totalGuesses === totalGridSize) {
    const puzzlePoints = Math.max(1, state.gridSize - 2);
    state.points += puzzlePoints + (state.roundPointsBonus || 0);
    state.score = state.points;
    state.roundPointsBonus = 0;
    state.level += 1;
    state.timeLimit += TIME_INCREMENT + (state.perSolveTimeBonusMs || 0);
    updateGridSize(state);
    state.puzzleId = (state.puzzleId || 0) + 1;
    Object.assign(state, getRoundPuzzle(match, state.round, state.level, state.gridSize));
    revealInitialCells(state);
  }
}

function applyAction(match, state, x, y, button) {
  if (state.gameMode !== "play") return;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  if (x < 0 || y < 0 || x >= state.gridSize || y >= state.gridSize) return;

  if (state.grid[x][y] === 1 && state.gridGuesses[x][y] !== 1) {
    state.gridGuesses[x][y] = 1;
    if (button !== 0) {
      state.lives -= 1;
    } else {
      let columnGuesses = 0;
      let rowGuesses = 0;
      for (let k = 0; k < state.gridSize; k += 1) {
        if (state.grid[x][k] === 1 && state.gridGuesses[x][k] === 1) columnGuesses += 1;
        if (state.grid[k][y] === 1 && state.gridGuesses[k][y] === 1) rowGuesses += 1;
      }
      if (columnGuesses === state.columnsTotal[x]) {
        for (let l = 0; l < state.gridSize; l += 1) state.gridGuesses[x][l] = 1;
      }
      if (rowGuesses === state.rowsTotal[y]) {
        for (let m = 0; m < state.gridSize; m += 1) state.gridGuesses[m][y] = 1;
      }
    }
  }

  if (state.grid[x][y] === 0 && state.gridGuesses[x][y] !== 1) {
    if (state.bombActive && state.bombCell && state.bombCell.x === x && state.bombCell.y === y) {
      state.lives -= 2;
      state.bombActive = false;
    }
    state.gridGuesses[x][y] = 1;
    if (button !== 2) {
      state.lives -= 1;
    }
  }

  if (state.lives <= 0) {
    state.lives = 0;
    state.points = 0;
    state.score = 0;
    state.roundPointsBonus = 0;
    state.gameMode = "roundOver";
    return;
  }

  checkVictory(match, state);
}

function hasAffordableUpgrade(state) {
  return (state.shopOptions || []).some((option) => state.points >= (option.cost || 0));
}

function enterShop(match) {
  match.status = "shop";
  match.players.forEach((playerId) => {
    const state = match.states[playerId];
    state.gameMode = "shop";
    state.shopOptions = chooseRandomUpgrades(3);
    state.hasPurchasedThisShop = !hasAffordableUpgrade(state);
  });
}

function startNextRound(match) {
  match.round += 1;
  if (match.round > TOTAL_ROUNDS) {
    const [p1Id, p2Id] = match.players;
    const p1Points = match.states[p1Id].points;
    const p2Points = match.states[p2Id].points;
    const resultText = p1Points === p2Points ? "It's a draw!" : (p1Points > p2Points ? "You win!" : "You lose.");
    const resultTextOpponent = p1Points === p2Points ? "It's a draw!" : (p2Points > p1Points ? "You win!" : "You lose.");
    match.states[p1Id].winnerText = `${resultText} Final points ${p1Points}-${p2Points}`;
    match.states[p2Id].winnerText = `${resultTextOpponent} Final points ${p2Points}-${p1Points}`;
    match.players.forEach((playerId) => {
      match.states[playerId].gameMode = "gameOver";
    });
    match.status = "gameOver";
    return;
  }

  match.status = "countdown";
  match.roundStartsAt = Date.now() + MATCH_COUNTDOWN_MS;
  match.players.forEach((playerId) => {
    const state = match.states[playerId];
    state.round = match.round;
    state.gameMode = "countdown";
    state.shopOptions = [];
    state.hasPurchasedThisShop = false;
    configureRoundState(match, state);
  });
}

function applyUpgrade(match, buyerId, upgradeId) {
  const state = match.states[buyerId];
  if (!state || state.hasPurchasedThisShop || state.gameMode !== "shop") return;
  const option = (state.shopOptions || []).find((entry) => entry.id === upgradeId);
  if (!option) return;
  if (state.points < option.cost) return;

  const definition = UPGRADE_DEFS.find((entry) => entry.id === upgradeId);
  if (!definition) return;

  const opponentId = match.players.find((id) => id !== buyerId);
  const opponentState = match.states[opponentId];
  const targetState = definition.target === "opponent" ? opponentState : state;
  if (!targetState) return;

  if (definition.booleanEffect) {
    targetState[definition.effect] = true;
  } else {
    const scaledAmount = option.appliedValue * (definition.effectScale || 1);
    targetState[definition.effect] += scaledAmount;
  }

  state.points -= option.cost;
  state.score = state.points;
  state.hasPurchasedThisShop = true;
}


function maybeStartMatchmaking() {
  while (waitingQueue.length >= 2) {
    const p1Id = waitingQueue.shift();
    const p2Id = waitingQueue.shift();
    const p1 = players.get(p1Id);
    const p2 = players.get(p2Id);
    if (!p1 || !p2 || p1.matchId || p2.matchId) continue;

    const matchId = `${p1Id}:${p2Id}:${Date.now()}`;
    const match = {
      id: matchId,
      players: [p1Id, p2Id],
      round: 1,
      states: {
        [p1Id]: makePlayerState("countdown"),
        [p2Id]: makePlayerState("countdown")
      },
      rematchVotes: new Set(),
      status: "countdown",
      roundStartsAt: Date.now() + MATCH_COUNTDOWN_MS,
      roundPuzzleCache: new Map()
    };
    configureRoundState(match, match.states[p1Id]);
    configureRoundState(match, match.states[p2Id]);
    matches.set(matchId, match);
    p1.matchId = matchId;
    p2.matchId = matchId;
    p1.status = "play";
    p2.status = "play";

    io.to(p1Id).emit("match:ready", { opponentName: p2.displayName });
    io.to(p2Id).emit("match:ready", { opponentName: p1.displayName });
    emitMatchState(match);
  }
}

setInterval(() => {
  matches.forEach((match) => {
    if (match.status === "countdown" && match.roundStartsAt && Date.now() < match.roundStartsAt) {
      emitMatchState(match);
      return;
    }

    if (match.status === "countdown" && match.roundStartsAt) {
      match.roundStartsAt = null;
      match.status = "play";
      match.players.forEach((playerId) => {
        const state = match.states[playerId];
        if (state.gameMode === "countdown") state.gameMode = "play";
      });
    }

    if (match.status === "play") {
      let finishedPlayers = 0;
      match.players.forEach((playerId) => {
        const state = match.states[playerId];
        if (state.gameMode !== "play") {
          if (state.gameMode === "roundOver") finishedPlayers += 1;
          return;
        }
        state.timer += 100;
        if (state.timer > state.timeLimit) {
          state.gameMode = "roundOver";
          finishedPlayers += 1;
        }
      });
      if (finishedPlayers === match.players.length) {
        if (match.round >= TOTAL_ROUNDS) {
          startNextRound(match);
        } else {
          enterShop(match);
        }
      }
    } else if (match.status === "shop") {
      const allBought = match.players.every((playerId) => match.states[playerId].hasPurchasedThisShop);
      if (allBought) {
        startNextRound(match);
      }
    }

    emitMatchState(match);
  });
}, 100);

io.on("connection", (socket) => {
  players.set(socket.id, {
    id: socket.id,
    hasChosenName: false,
    baseName: "",
    name: buildPlayerName("Anon", socket.id),
    displayName: buildDisplayName("", socket.id, false),
    status: "menu",
    matchId: null,
    lastScore: 0,
    lastLevel: 0,
    lastLives: TOTAL_LIVES
  });

  emitPlayers();
  emitLeaderboard();

  socket.on("player:set-name", (incoming) => {
    const player = players.get(socket.id);
    if (!player) return;

    if (typeof incoming?.name === "string" && incoming.name.trim()) {
      player.baseName = incoming.name.trim().slice(0, 24);
      player.hasChosenName = true;
    }
    player.name = buildPlayerName(player.baseName, player.id);
    player.displayName = buildDisplayName(player.baseName, player.id, player.hasChosenName);

    updateLeaderboardEntry(player.id, player.displayName, player.lastScore || 0);
    emitPlayers();
    emitLeaderboard();
  });

  socket.on("matchmaking:join", () => {
    const player = players.get(socket.id);
    if (!player) return;
    if (player.matchId) return;
    removeFromQueue(socket.id);
    waitingQueue.push(socket.id);
    player.status = "waiting";
    emitPlayers();
    maybeStartMatchmaking();
  });

  socket.on("matchmaking:leave", () => {
    const player = players.get(socket.id);
    if (!player) return;
    removeFromQueue(socket.id);
    if (!player.matchId) player.status = "menu";
    emitPlayers();
  });

  socket.on("game:action", (incoming) => {
    const player = players.get(socket.id);
    if (!player?.matchId) return;
    const match = matches.get(player.matchId);
    if (!match || match.status !== "play") return;
    const state = match.states[socket.id];
    applyAction(match, state, incoming?.x, incoming?.y, incoming?.button);
    emitMatchState(match);
  });

  socket.on("game:restart", () => {
    const player = players.get(socket.id);
    if (!player?.matchId) return;
    const match = matches.get(player.matchId);
    if (!match) return;

    const state = match.states[socket.id];
    if (!state || state.gameMode !== "gameOver") return;

    match.rematchVotes.add(socket.id);

    if (match.players.every((playerId) => match.rematchVotes.has(playerId))) {
      match.round = 1;
      match.roundPuzzleCache = new Map();
      match.players.forEach((playerId) => {
        match.states[playerId] = makePlayerState("countdown");
        configureRoundState(match, match.states[playerId]);
      });
      match.status = "countdown";
      match.roundStartsAt = Date.now() + MATCH_COUNTDOWN_MS;
      match.rematchVotes.clear();
    }

    emitMatchState(match);
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    if (player) {
      updateLeaderboardEntry(player.id, player.displayName, player.lastScore || 0);
    }
    removeFromQueue(socket.id);

    if (player?.matchId) {
      const match = matches.get(player.matchId);
      if (match) {
        match.players.forEach((playerId) => {
          if (playerId !== socket.id) {
            io.to(playerId).emit("match:ended", { reason: "Opponent disconnected" });
          }
        });
        finishMatch(player.matchId, "player-left");
      }
    }

    players.delete(socket.id);
    emitPlayers();
    emitLeaderboard();
  });

  socket.on("shop:buy", (incoming) => {
    const player = players.get(socket.id);
    if (!player?.matchId) return;
    const match = matches.get(player.matchId);
    if (!match || match.status !== "shop") return;
    applyUpgrade(match, socket.id, incoming?.upgradeId);
    emitMatchState(match);
  });
});

async function startServer() {
  await connectRedis();
  await loadLeaderboardFromRedis();

  server.listen(PORT, HOST, () => {
    console.log(`Speed-o-Gram server listening on http://${HOST}:${PORT}`);
    console.log(`Serving static files from ${STATIC_DIR}`);
  });
}

startServer().catch((error) => {
  console.error("[startup] Failed to start server:", error.message);
  process.exit(1);
});
