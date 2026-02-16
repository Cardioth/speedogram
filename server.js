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
  common: { label: "Common" },
  rare: { label: "Rare" },
  epic: { label: "Epic" }
};
const SHOP_TIERS = ["common", "rare", "epic"];
const UPGRADE_DEFS = [
  { id: "extra-second-per-solve", description: "+{value}s more time per puzzle solved (stacks permanently)", cost: 2, tierValues: { common: 0.5, rare: 1, epic: 1.5 }, effect: "perSolveTimeBonusMs", effectScale: 1000 },
  { id: "start-revealed-cell", description: "+{value} revealed starting cell(s) each round (stacks permanently)", cost: 2, tierValues: { common: 1, rare: 2, epic: 3 }, effect: "startRevealedCells", effectScale: 1 },
  { id: "plus-start-time", description: "+{value}s starting time each round (stacks permanently)", cost: 2, tierValues: { common: 2, rare: 3, epic: 4 }, effect: "startingTimeBonusMs", effectScale: 1000 },
  { id: "plus-2-next-round-points", description: "+{value} bonus point(s) next round", cost: 2, tierValues: { common: 4, rare: 6, epic: 8 }, effect: "nextRoundPointBonus", effectScale: 1 },
  { id: "solve-time-siphon", description: "Each solve drains opponent timer by {value}s (stacks permanently)", cost: 2, tierValues: { common: 0.4, rare: 0.6, epic: 0.9 }, effect: "perSolveOpponentTimeDrainMs", effectScale: 1000 },
  { id: "opp-minus-start-time", description: "Opponent -{value}s starting time each round (stacks permanently)", cost: 2, tierValues: { common: 2, rare: 3, epic: 4 }, effect: "opponentStartPenaltyMs", effectScale: 1000, target: "opponent" },
  { id: "opp-bomb-cell", description: "Plant {value} visible bomb trap(s) for opponent (next round only)", cost: 2, tierValues: { common: 1, rare: 2, epic: 3 }, effect: "incomingBombNextRoundCount", effectScale: 1, target: "opponent" },
  { id: "opp-fragile-focus", description: "Opponent mistakes cost +{value} extra life (stacks permanently)", cost: 2, tierValues: { common: 1, rare: 1, epic: 2 }, effect: "extraLifeLossOnMistake", effectScale: 1, target: "opponent" }
];

const players = new Map();
const waitingQueue = [];
const matches = new Map();
const activeSocketByLeaderboardId = new Map();
const leaderboard = new Map();
const LEADERBOARD_LIMIT = 10;
const DAILY_LEADERBOARD_TTL_MS = 24 * 60 * 60 * 1000;
const LEADERBOARD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
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
const LEADERBOARD_TIME_REDIS_KEY = "speedogram:leaderboard:updated";
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
  await pruneLeaderboardStorage();
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
      name: sanitizePlayerName(parsed.name),
      bestPoints: Math.max(0, Math.floor(scoreMap.get(id) || 0)),
      updatedAt: Number(parsed.updatedAt) || Date.now()
    });
  });
}

async function persistLeaderboardEntry(entry) {
  await runRedisCommand("ZADD", [LEADERBOARD_REDIS_KEY, entry.bestPoints, entry.id]);
  await runRedisCommand("ZADD", [LEADERBOARD_TIME_REDIS_KEY, entry.updatedAt, entry.id]);
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

async function removeLeaderboardEntries(ids) {
  if (!ids.length) return;
  await runRedisCommand("ZREM", [LEADERBOARD_REDIS_KEY, ...ids]);
  await runRedisCommand("ZREM", [LEADERBOARD_TIME_REDIS_KEY, ...ids]);
  await runRedisCommand("HDEL", [LEADERBOARD_META_REDIS_KEY, ...ids]);
}

function pruneLocalLeaderboard(now = Date.now()) {
  const cutoff = now - DAILY_LEADERBOARD_TTL_MS;
  const staleIds = [];
  leaderboard.forEach((entry, id) => {
    if ((Number(entry.updatedAt) || 0) < cutoff) {
      staleIds.push(id);
    }
  });
  staleIds.forEach((id) => leaderboard.delete(id));
}

async function pruneLeaderboardStorage(now = Date.now()) {
  const cutoff = now - DAILY_LEADERBOARD_TTL_MS;
  const staleIds = await runRedisCommand("ZRANGEBYSCORE", [LEADERBOARD_TIME_REDIS_KEY, 0, cutoff]);
  if (!staleIds.length) return;
  await removeLeaderboardEntries(staleIds);
}

function makePlayerTag(playerId) {
  return String(playerId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-4) || "0000";
}

function normalizeLeaderboardPlayerId(rawId, fallbackId) {
  const normalized = String(rawId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  if (normalized) return normalized;
  return `sock_${String(fallbackId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "anon"}`;
}

function makeAnonTag(playerId) {
  const source = String(playerId || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash * 31) + source.charCodeAt(i)) % 1000;
  }
  return String(hash).padStart(3, "0");
}

function sanitizePlayerName(rawName, fallback = "Anon") {
  const compacted = String(rawName || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 24);

  return compacted || fallback;
}

function buildDisplayName(baseName, playerId, hasChosenName) {
  if (hasChosenName && typeof baseName === "string" && baseName.trim()) {
    return sanitizePlayerName(baseName);
  }
  return `Anon#${makeAnonTag(playerId)}`;
}

function buildPlayerName(baseName, playerId) {
  const safeBaseName = sanitizePlayerName(baseName);
  return `${safeBaseName}#${makePlayerTag(playerId)}`;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, leaderboardStorage: "redis", redisConnected: Boolean(redisClient) });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

app.use(express.static(STATIC_DIR, { index: false }));

function makeLinePatterns(length, clues) {
  const normalizedClues = Array.isArray(clues) ? clues.filter((value) => value > 0) : [];
  if (!normalizedClues.length) {
    return [Array(length).fill(0)];
  }

  const patterns = [];

  function placeRun(clueIndex, startPos, line) {
    if (clueIndex === normalizedClues.length) {
      for (let i = startPos; i < length; i += 1) line[i] = 0;
      patterns.push(line.slice());
      return;
    }

    const runLength = normalizedClues[clueIndex];
    const remainingRuns = normalizedClues.slice(clueIndex + 1);
    const remainingRunCells = remainingRuns.reduce((sum, value) => sum + value, 0);
    const remainingSeparators = remainingRuns.length;
    const maxStart = length - (runLength + remainingRunCells + remainingSeparators);

    for (let runStart = startPos; runStart <= maxStart; runStart += 1) {
      for (let i = startPos; i < runStart; i += 1) line[i] = 0;
      for (let i = runStart; i < runStart + runLength; i += 1) line[i] = 1;

      const nextPos = runStart + runLength;
      if (clueIndex < normalizedClues.length - 1) {
        line[nextPos] = 0;
        placeRun(clueIndex + 1, nextPos + 1, line);
      } else {
        placeRun(clueIndex + 1, nextPos, line);
      }
    }
  }

  placeRun(0, 0, Array(length).fill(0));
  return patterns;
}

function countPuzzleSolutions(gridSize, Xcounters, Ycounters, maxSolutions = 2) {
  const rowPatterns = Ycounters.map((rowClues) => makeLinePatterns(gridSize, rowClues));
  const columnCandidates = Xcounters.map((columnClues) => makeLinePatterns(gridSize, columnClues));
  let solutions = 0;

  function searchRow(rowIndex, candidates) {
    if (solutions >= maxSolutions) return;

    if (rowIndex === gridSize) {
      solutions += 1;
      return;
    }

    for (const rowPattern of rowPatterns[rowIndex]) {
      const nextCandidates = [];
      let valid = true;

      for (let column = 0; column < gridSize; column += 1) {
        const filtered = candidates[column].filter((pattern) => pattern[rowIndex] === rowPattern[column]);
        if (!filtered.length) {
          valid = false;
          break;
        }
        nextCandidates.push(filtered);
      }

      if (valid) {
        searchRow(rowIndex + 1, nextCandidates);
      }

      if (solutions >= maxSolutions) return;
    }
  }

  searchRow(0, columnCandidates);
  return solutions;
}

function buildPuzzleFromGrid(grid, gridSize) {
  const gridGuesses = [];
  const columnsTotal = [];
  const rowsTotal = [];
  const Xcounters = [];
  const Ycounters = [];

  for (let i = 0; i < gridSize; i += 1) gridGuesses.push(Array(gridSize).fill(0));

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

function makeRandomGrid(gridSize, randomFn) {
  const grid = [];
  for (let i = 0; i < gridSize; i += 1) {
    const column = [];
    for (let j = 0; j < gridSize; j += 1) {
      let randomNumber = Math.floor(randomFn() * 3);
      if (randomNumber > 1) randomNumber = 1;
      column.push(randomNumber);
    }
    grid.push(column);
  }
  return grid;
}

function makeFilledGrid(gridSize, value) {
  return Array.from({ length: gridSize }, () => Array(gridSize).fill(value));
}

function makeUniquePuzzleFromRandom(gridSize, randomFn) {
  const MAX_UNIQUE_PUZZLE_ATTEMPTS = 10000;
  for (let attempt = 0; attempt < MAX_UNIQUE_PUZZLE_ATTEMPTS; attempt += 1) {
    const puzzle = buildPuzzleFromGrid(makeRandomGrid(gridSize, randomFn), gridSize);
    if (countPuzzleSolutions(gridSize, puzzle.Xcounters, puzzle.Ycounters, 2) === 1) {
      return puzzle;
    }
  }

  console.warn(`[puzzle] Failed to find a unique ${gridSize}x${gridSize} puzzle after ${MAX_UNIQUE_PUZZLE_ATTEMPTS} attempts. Falling back to a deterministic puzzle.`);
  return buildPuzzleFromGrid(makeFilledGrid(gridSize, 1), gridSize);
}

function makePuzzle(gridSize) {
  return makeUniquePuzzleFromRandom(gridSize, Math.random);
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
  return makeUniquePuzzleFromRandom(gridSize, randomFn);
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
  const effectText = upgradeDef.description.replace("{value}", String(appliedValue));
  return `${tierConfig.label} • ${effectText} (${upgradeDef.cost} pts)`;
}

function toUpgradeOffer(upgradeDef, tier = "common") {
  const tierConfig = SHOP_TIER_CONFIG[tier] || SHOP_TIER_CONFIG.common;
  const tierValues = upgradeDef.tierValues || {};
  const appliedValue = Number.isFinite(tierValues[tier]) ? tierValues[tier] : (Number.isFinite(tierValues.common) ? tierValues.common : 0);
  const effectText = upgradeDef.description.replace("{value}", String(appliedValue));
  return {
    id: upgradeDef.id,
    tier,
    cost: upgradeDef.cost,
    appliedValue,
    tierLabel: tierConfig.label,
    effectText,
    label: formatUpgradeLabel(upgradeDef, appliedValue, tierConfig)
  };
}

function chooseRandomUpgrades(count = 3) {
  const pool = [...UPGRADE_DEFS];
  const selected = [];
  while (selected.length < count && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    const randomTier = SHOP_TIERS[Math.floor(Math.random() * SHOP_TIERS.length)];
    selected.push(toUpgradeOffer(pool.splice(idx, 1)[0], randomTier));
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
  const incomingPenalty = state.opponentStartPenaltyMs || 0;

  state.roundPointsBonus = roundBonus;
  state.nextRoundPointBonus = 0;
  state.extraLifeLossOnMistake = Math.max(0, Math.floor(state.extraLifeLossOnMistake || 0));

  state.lives = TOTAL_LIVES;
  state.timer = 0;
  state.level = 0;
  updateGridSize(state);

  const baseTime = TIME_LIMIT_INIT + (state.startingTimeBonusMs || 0) - incomingPenalty;
  state.timeLimit = Math.max(3000, baseTime);

  state.puzzleId = (state.puzzleId || 0) + 1;
  Object.assign(state, getRoundPuzzle(match, state.round, state.level, state.gridSize));
  state.bombCells = [];
  const incomingBombCount = Math.max(0, Math.floor(state.incomingBombNextRoundCount || 0));
  state.bombActive = incomingBombCount > 0;
  state.incomingBombNextRoundCount = 0;

  if (state.bombActive) {
    const availableBombCells = [];
    for (let x = 0; x < state.gridSize; x += 1) {
      for (let y = 0; y < state.gridSize; y += 1) {
        if (state.grid[x][y] === 0) {
          availableBombCells.push({ x, y });
        }
      }
    }
    if (availableBombCells.length) {
      const spawnCount = Math.min(incomingBombCount, availableBombCells.length);
      for (let i = 0; i < spawnCount; i += 1) {
        const idx = Math.floor(Math.random() * availableBombCells.length);
        state.bombCells.push(availableBombCells.splice(idx, 1)[0]);
      }
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
    shopPoints: 0,
    level,
    lives: TOTAL_LIVES,
    gameMode: initialMode,
    timer: 0,
    timeLimit: TIME_LIMIT_INIT,
    puzzleId: 1,
    gridSize,
    round: 1,
    perSolveTimeBonusMs: 0,
    perSolveOpponentTimeDrainMs: 0,
    startingTimeBonusMs: 0,
    nextRoundPointBonus: 0,
    roundPointsBonus: 0,
    opponentStartPenaltyMs: 0,
    extraLifeLossOnMistake: 0,
    incomingBombNextRoundCount: 0,
    startRevealedCells: 0,
    bombActive: false,
    bombCells: [],
    shopOptions: [],
    hasPurchasedThisShop: false,
    winnerText: "",
    ...puzzle
  };
}

function toPublicState(state) {
  return {
    score: state.score,
    shopPoints: state.shopPoints,
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
    Ycounters: state.Ycounters,
    perSolveTimeBonusMs: state.perSolveTimeBonusMs,
    perSolveOpponentTimeDrainMs: state.perSolveOpponentTimeDrainMs,
    startingTimeBonusMs: state.startingTimeBonusMs,
    startRevealedCells: state.startRevealedCells,
    extraLifeLossOnMistake: state.extraLifeLossOnMistake,
    bombActive: state.bombActive,
    bombCells: state.bombCells
  };
}

function buildPlayerList() {
  const uniquePlayers = new Map();

  Array.from(players.values()).forEach((player) => {
    const existing = uniquePlayers.get(player.leaderboardId);
    if (!existing) {
      uniquePlayers.set(player.leaderboardId, player);
      return;
    }

    const existingPriority = Number(Boolean(existing.matchId));
    const playerPriority = Number(Boolean(player.matchId));

    if (playerPriority > existingPriority || ((player.connectedAt || 0) > (existing.connectedAt || 0))) {
      uniquePlayers.set(player.leaderboardId, player);
    }
  });

  return Array.from(uniquePlayers.values()).map((player) => ({
    id: player.id,
    name: player.displayName,
    score: player.lastScore || 0,
    shopPoints: player.lastShopPoints || 0,
    level: player.lastLevel || 0,
    lives: player.lastLives ?? TOTAL_LIVES,
    gameMode: player.status
  }));
}

function emitPlayers() {
  io.emit("players:update", buildPlayerList());
}

function updateLeaderboardEntry(playerId, displayName, score) {
  if (typeof playerId !== "string" || !playerId.trim()) return;
  const safeDisplayName = sanitizePlayerName(displayName, "");
  if (!safeDisplayName) return;
  const safePoints = Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0;
  if (safePoints <= 0) return;
  const existing = leaderboard.get(playerId);
  if (!existing || safePoints > existing.bestPoints) {
    const entry = {
      id: playerId,
      name: safeDisplayName,
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
  pruneLocalLeaderboard();
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
  p1.lastShopPoints = match.states[p1Id].shopPoints;
  p1.lastLevel = match.states[p1Id].level;
  p1.lastLives = match.states[p1Id].lives;
  p2.lastScore = match.states[p2Id].score;
  p2.lastShopPoints = match.states[p2Id].shopPoints;
  p2.lastLevel = match.states[p2Id].level;
  p2.lastLives = match.states[p2Id].lives;

  updateLeaderboardEntry(p1.leaderboardId, p1.displayName, match.states[p1Id].score);
  updateLeaderboardEntry(p2.leaderboardId, p2.displayName, match.states[p2Id].score);

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
  let totalFilledCells = 0;
  let discoveredFilledCells = 0;
  for (let i = 0; i < state.gridSize; i += 1) {
    for (let j = 0; j < state.gridSize; j += 1) {
      if (state.grid[i][j] === 1) {
        totalFilledCells += 1;
        if (state.gridGuesses[i][j] === 1) {
          discoveredFilledCells += 1;
        }
      }
    }
  }
  if (discoveredFilledCells === totalFilledCells) {
    const puzzlePoints = Math.max(1, state.gridSize - 2);
    const earnedPoints = puzzlePoints + (state.roundPointsBonus || 0);
    state.score += earnedPoints;
    state.shopPoints += earnedPoints;
    state.roundPointsBonus = 0;
    state.level += 1;
    state.timeLimit += TIME_INCREMENT + (state.perSolveTimeBonusMs || 0);

    const opponentId = match.players.find((playerId) => match.states[playerId] !== state);
    const opponentState = opponentId ? match.states[opponentId] : null;
    const siphonMs = Math.max(0, Math.floor(state.perSolveOpponentTimeDrainMs || 0));
    if (opponentState && opponentState.gameMode === "play" && siphonMs > 0) {
      opponentState.timer = Math.min(opponentState.timeLimit + 1, opponentState.timer + siphonMs);
      if (opponentState.timer > opponentState.timeLimit) {
        opponentState.gameMode = "roundOver";
      }
    }

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
      state.lives -= (1 + (state.extraLifeLossOnMistake || 0));
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
    const triggeredBomb = state.bombActive && state.bombCells.some((cell) => cell.x === x && cell.y === y);
    if (triggeredBomb) {
      state.lives = 0;
      state.bombActive = false;
      state.bombCells = [];
    }
    state.gridGuesses[x][y] = 1;
    if (!triggeredBomb && button !== 2) {
      state.lives -= (1 + (state.extraLifeLossOnMistake || 0));
    }
  }

  if (state.lives <= 0) {
    state.lives = 0;
    state.shopPoints = 0;
    state.roundPointsBonus = 0;
    state.gameMode = "roundOver";
    return;
  }

  checkVictory(match, state);
}

function hasAffordableUpgrade(state) {
  return (state.shopOptions || []).some((option) => state.shopPoints >= (option.cost || 0));
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
    const p1Score = match.states[p1Id].score;
    const p2Score = match.states[p2Id].score;
    const resultText = p1Score === p2Score ? "It's a draw!" : (p1Score > p2Score ? "You win!" : "You lose.");
    const resultTextOpponent = p1Score === p2Score ? "It's a draw!" : (p2Score > p1Score ? "You win!" : "You lose.");
    match.states[p1Id].winnerText = `${resultText} Final score ${p1Score}-${p2Score}`;
    match.states[p2Id].winnerText = `${resultTextOpponent} Final score ${p2Score}-${p1Score}`;
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
  if (state.shopPoints < option.cost) return;

  const definition = UPGRADE_DEFS.find((entry) => entry.id === upgradeId);
  if (!definition) return;

  const opponentId = match.players.find((id) => id !== buyerId);
  const opponentState = match.states[opponentId];
  const targetState = definition.target === "opponent" ? opponentState : state;
  if (!targetState) return;

  const scaledAmount = option.appliedValue * (definition.effectScale || 1);
  if (!Number.isFinite(targetState[definition.effect])) {
    targetState[definition.effect] = 0;
  }
  targetState[definition.effect] += scaledAmount;

  state.shopPoints -= option.cost;
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

setInterval(() => {
  pruneLocalLeaderboard();
  pruneLeaderboardStorage().catch((error) => {
    console.error("[leaderboard] Failed to prune stale entries:", error.message);
  });
}, LEADERBOARD_CLEANUP_INTERVAL_MS);

io.on("connection", (socket) => {
  const claimedId = socket.handshake?.auth?.playerId || socket.handshake?.query?.playerId;
  const leaderboardPlayerId = normalizeLeaderboardPlayerId(claimedId, socket.id);
  const activeSocketId = activeSocketByLeaderboardId.get(leaderboardPlayerId);

  if (activeSocketId && activeSocketId !== socket.id) {
    const activeSocket = io.sockets.sockets.get(activeSocketId);
    if (activeSocket?.connected) {
      activeSocket.emit("session:replaced", { message: "Another game window took over this account." });
      activeSocket.disconnect(true);
    }
  }

  activeSocketByLeaderboardId.set(leaderboardPlayerId, socket.id);

  players.set(socket.id, {
    id: socket.id,
    leaderboardId: leaderboardPlayerId,
    hasChosenName: false,
    baseName: "",
    name: buildPlayerName("Anon", leaderboardPlayerId),
    displayName: buildDisplayName("", leaderboardPlayerId, false),
    status: "menu",
    matchId: null,
    lastScore: 0,
    lastShopPoints: 0,
    lastLevel: 0,
    lastLives: TOTAL_LIVES,
    connectedAt: Date.now()
  });

  emitPlayers();
  emitLeaderboard();

  socket.on("player:set-name", (incoming) => {
    const player = players.get(socket.id);
    if (!player) return;

    if (typeof incoming?.name === "string" && incoming.name.trim()) {
      player.baseName = sanitizePlayerName(incoming.name, "");
      player.hasChosenName = true;
    }
    player.name = buildPlayerName(player.baseName, player.leaderboardId);
    player.displayName = buildDisplayName(player.baseName, player.leaderboardId, player.hasChosenName);

    updateLeaderboardEntry(player.leaderboardId, player.displayName, player.lastScore || 0);
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
      updateLeaderboardEntry(player.leaderboardId, player.displayName, player.lastScore || 0);
      if (activeSocketByLeaderboardId.get(player.leaderboardId) === socket.id) {
        activeSocketByLeaderboardId.delete(player.leaderboardId);
      }
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
  pruneLocalLeaderboard();

  server.listen(PORT, HOST, () => {
    console.log(`Speed-o-Gram server listening on http://${HOST}:${PORT}`);
    console.log(`Serving static files from ${STATIC_DIR}`);
  });
}

startServer().catch((error) => {
  console.error("[startup] Failed to start server:", error.message);
  process.exit(1);
});
