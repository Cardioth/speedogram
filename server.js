const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TOTAL_LIVES = 3;
const GRID_SIZE_INTERVALS = [3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9, 9, 10, 10];
const TIME_LIMIT_INIT = 12000;
const TIME_INCREMENT = 0;
const MATCH_COUNTDOWN_MS = 3000;
const TOTAL_ROUNDS = 6;
const UPGRADE_DEFS = [
  { id: "extra-second-per-solve", label: "+1 second more time per puzzle solved" },
  { id: "start-revealed-cell", label: "+one cell starts already revealed" },
  { id: "plus-5-start-time", label: "+5 seconds starting time" },
  { id: "plus-2-next-round-points", label: "+2 points for next round" },
  { id: "opp-minus-2-start-time", label: "+opponent gets 2 seconds less starting time" },
  { id: "opp-bomb-cell", label: "+Bomb cell for opponent" }
];

const players = new Map();
const waitingQueue = [];
const matches = new Map();

app.use(express.static(path.join(__dirname)));

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

function chooseRandomUpgrades(count = 3) {
  const pool = [...UPGRADE_DEFS];
  const selected = [];
  while (selected.length < count && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    selected.push(pool.splice(idx, 1)[0]);
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

function configureRoundState(state) {
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
  Object.assign(state, makePuzzle(state.gridSize));
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
    name: player.name,
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

  io.to(p1Id).emit("match:update", {
    matchId: match.id,
    player: { id: p1.id, name: p1.name, ...match.states[p1Id], countdownRemaining },
    opponent: { id: p2.id, name: p2.name, ...toPublicState(match.states[p2Id]), countdownRemaining },
    playerRematchRequested: match.rematchVotes?.has(p1Id) || false,
    opponentRematchRequested: match.rematchVotes?.has(p2Id) || false
  });
  io.to(p2Id).emit("match:update", {
    matchId: match.id,
    player: { id: p2.id, name: p2.name, ...match.states[p2Id], countdownRemaining },
    opponent: { id: p1.id, name: p1.name, ...toPublicState(match.states[p1Id]), countdownRemaining },
    playerRematchRequested: match.rematchVotes?.has(p2Id) || false,
    opponentRematchRequested: match.rematchVotes?.has(p1Id) || false
  });
  emitPlayers();
}

function updateGridSize(state) {
  state.gridSize = GRID_SIZE_INTERVALS[state.level] || GRID_SIZE_INTERVALS[GRID_SIZE_INTERVALS.length - 1];
}

function checkVictory(state) {
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
    state.points += 1 + (state.roundPointsBonus || 0);
    state.score = state.points;
    state.roundPointsBonus = 0;
    state.level += 1;
    state.timeLimit += TIME_INCREMENT + (state.perSolveTimeBonusMs || 0);
    updateGridSize(state);
    state.puzzleId = (state.puzzleId || 0) + 1;
    Object.assign(state, makePuzzle(state.gridSize));
    revealInitialCells(state);
  }
}

function applyAction(state, x, y, button) {
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

  checkVictory(state);
}

function enterShop(match) {
  match.status = "shop";
  match.players.forEach((playerId) => {
    const state = match.states[playerId];
    state.gameMode = "shop";
    state.shopOptions = chooseRandomUpgrades(3);
    state.hasPurchasedThisShop = false;
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
    configureRoundState(state);
  });
}

function applyUpgrade(match, buyerId, upgradeId) {
  const state = match.states[buyerId];
  if (!state || state.hasPurchasedThisShop || state.gameMode !== "shop") return;
  const option = (state.shopOptions || []).find((entry) => entry.id === upgradeId);
  if (!option) return;

  const opponentId = match.players.find((id) => id !== buyerId);
  const opponentState = match.states[opponentId];

  switch (upgradeId) {
    case "extra-second-per-solve":
      state.perSolveTimeBonusMs += 1000;
      break;
    case "start-revealed-cell":
      state.startRevealedCells += 1;
      break;
    case "plus-5-start-time":
      state.startingTimeBonusMs += 5000;
      break;
    case "plus-2-next-round-points":
      state.nextRoundPointBonus += 2;
      break;
    case "opp-minus-2-start-time":
      if (opponentState) opponentState.incomingStartPenaltyMs += 2000;
      break;
    case "opp-bomb-cell":
      if (opponentState) opponentState.incomingBombNextRound = true;
      break;
    default:
      return;
  }

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
      roundStartsAt: Date.now() + MATCH_COUNTDOWN_MS
    };
    configureRoundState(match.states[p1Id]);
    configureRoundState(match.states[p2Id]);
    matches.set(matchId, match);
    p1.matchId = matchId;
    p2.matchId = matchId;
    p1.status = "play";
    p2.status = "play";

    io.to(p1Id).emit("match:ready", { opponentName: p2.name });
    io.to(p2Id).emit("match:ready", { opponentName: p1.name });
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
    name: `Player ${players.size + 1}`,
    status: "menu",
    matchId: null,
    lastScore: 0,
    lastLevel: 0,
    lastLives: TOTAL_LIVES
  });

  emitPlayers();

  socket.on("player:set-name", (incoming) => {
    const player = players.get(socket.id);
    if (!player) return;
    if (typeof incoming?.name === "string" && incoming.name.trim()) {
      player.name = incoming.name.trim().slice(0, 24);
    }
    emitPlayers();
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
    applyAction(state, incoming?.x, incoming?.y, incoming?.button);
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
      match.players.forEach((playerId) => {
        match.states[playerId] = makePlayerState("countdown");
        configureRoundState(match.states[playerId]);
      });
      match.status = "countdown";
      match.roundStartsAt = Date.now() + MATCH_COUNTDOWN_MS;
      match.rematchVotes.clear();
    }

    emitMatchState(match);
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
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

server.listen(PORT, () => {
  console.log(`Speed-o-Gram server listening on ${PORT}`);
});
