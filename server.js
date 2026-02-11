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
const TIME_INCREMENT = 700;
const MATCH_COUNTDOWN_MS = 3000;

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

function makePlayerState(initialMode = "play") {
  const level = 0;
  const gridSize = GRID_SIZE_INTERVALS[level];
  const puzzle = makePuzzle(gridSize);
  return {
    score: 0,
    level,
    lives: TOTAL_LIVES,
    gameMode: initialMode,
    timer: 0,
    timeLimit: TIME_LIMIT_INIT,
    gridSize,
    ...puzzle
  };
}

function toPublicState(state) {
  return {
    score: state.score,
    level: state.level,
    lives: state.lives,
    gameMode: state.gameMode,
    timer: state.timer,
    timeLimit: state.timeLimit,
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
    state.score += 1;
    state.level += 1;
    state.timeLimit += TIME_INCREMENT;
    updateGridSize(state);
    Object.assign(state, makePuzzle(state.gridSize));
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
    state.gridGuesses[x][y] = 1;
    if (button !== 2) {
      state.lives -= 1;
    }
  }

  if (state.lives <= 0) {
    state.lives = 0;
    state.gameMode = "gameOver";
    return;
  }

  checkVictory(state);
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
      states: {
        [p1Id]: makePlayerState("countdown"),
        [p2Id]: makePlayerState("countdown")
      },
      rematchVotes: new Set(),
      status: "play",
      roundStartsAt: Date.now() + MATCH_COUNTDOWN_MS
    };
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
    if (match.status !== "play") return;

    if (match.roundStartsAt && Date.now() < match.roundStartsAt) {
      emitMatchState(match);
      return;
    }

    if (match.roundStartsAt) {
      match.roundStartsAt = null;
      match.players.forEach((playerId) => {
        const state = match.states[playerId];
        if (state.gameMode === "countdown") state.gameMode = "play";
      });
    }

    match.players.forEach((playerId) => {
      const state = match.states[playerId];
      if (state.gameMode !== "play") return;
      state.timer += 100;
      if (state.timer > state.timeLimit) state.gameMode = "gameOver";
    });
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
      match.players.forEach((playerId) => {
        match.states[playerId] = makePlayerState("countdown");
      });
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
});

server.listen(PORT, () => {
  console.log(`Speed-o-Gram server listening on ${PORT}`);
});
