const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const players = new Map();
const waitingQueue = [];
const matches = new Map();

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const staticDir = fs.existsSync(publicDir) ? publicDir : rootDir;

app.use(express.static(staticDir));

app.get("/", (_req, res) => {
  const indexPath = path.join(staticDir, "index.html");
  res.sendFile(indexPath);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    players: players.size,
    waiting: waitingQueue.length,
    liveMatches: matches.size / 2
  });
});

function isConnectedPlayer(socketId) {
  return players.has(socketId);
}

function removeFromQueue(socketId) {
  const index = waitingQueue.indexOf(socketId);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
  }
}

function getOpponentId(socketId) {
  return matches.get(socketId);
}

function clearMatch(socketId) {
  const opponentId = getOpponentId(socketId);
  if (!opponentId) return null;

  matches.delete(socketId);
  matches.delete(opponentId);
  return opponentId;
}

function emitRoster() {
  io.emit("players:update", Array.from(players.values()));
}

function sanitizeIncomingPlayer(incoming = {}, existing) {
  return {
    ...existing,
    name:
      typeof incoming.name === "string" && incoming.name.trim()
        ? incoming.name.trim().slice(0, 24)
        : existing.name,
    score: Number.isFinite(incoming.score) ? incoming.score : existing.score,
    level: Number.isFinite(incoming.level) ? incoming.level : existing.level,
    lives: Number.isFinite(incoming.lives) ? incoming.lives : existing.lives,
    gameMode:
      typeof incoming.gameMode === "string"
        ? incoming.gameMode.slice(0, 24)
        : existing.gameMode,
    gridSize: Number.isFinite(incoming.gridSize)
      ? Math.max(1, Math.min(12, incoming.gridSize))
      : existing.gridSize,
    boardState:
      incoming.boardState && typeof incoming.boardState === "object"
        ? incoming.boardState
        : existing.boardState
  };
}

function pairPlayers(firstId, secondId) {
  matches.set(firstId, secondId);
  matches.set(secondId, firstId);

  const first = players.get(firstId);
  const second = players.get(secondId);

  io.to(firstId).emit("match:assigned", {
    opponentId: secondId,
    opponentName: second?.name || "Opponent"
  });

  io.to(secondId).emit("match:assigned", {
    opponentId: firstId,
    opponentName: first?.name || "Opponent"
  });
}

function tryMatchmake(requesterId) {
  removeFromQueue(requesterId);

  while (waitingQueue.length > 0) {
    const candidateId = waitingQueue.shift();
    if (candidateId === requesterId) continue;
    if (!isConnectedPlayer(candidateId)) continue;
    if (getOpponentId(candidateId)) continue;

    pairPlayers(requesterId, candidateId);
    return true;
  }

  waitingQueue.push(requesterId);
  io.to(requesterId).emit("match:waiting");
  return false;
}

io.on("connection", (socket) => {
  players.set(socket.id, {
    id: socket.id,
    name: `Player ${players.size + 1}`,
    score: 0,
    level: 0,
    lives: 3,
    gameMode: "menu",
    gridSize: 3,
    boardState: null
  });

  emitRoster();

  socket.on("player:update", (incoming) => {
    const existing = players.get(socket.id);
    if (!existing) return;

    const updated = sanitizeIncomingPlayer(incoming, existing);
    players.set(socket.id, updated);
    emitRoster();

    const opponentId = getOpponentId(socket.id);
    if (opponentId && isConnectedPlayer(opponentId)) {
      io.to(opponentId).emit("opponent:update", {
        id: socket.id,
        name: updated.name,
        score: updated.score,
        level: updated.level,
        lives: updated.lives,
        gameMode: updated.gameMode,
        gridSize: updated.gridSize,
        boardState: updated.boardState
      });
    }
  });

  socket.on("match:request", () => {
    if (!isConnectedPlayer(socket.id)) return;

    const existingOpponent = getOpponentId(socket.id);
    if (existingOpponent && isConnectedPlayer(existingOpponent)) {
      io.to(socket.id).emit("match:assigned", {
        opponentId: existingOpponent,
        opponentName: players.get(existingOpponent)?.name || "Opponent"
      });
      return;
    }

    clearMatch(socket.id);
    tryMatchmake(socket.id);
  });

  socket.on("match:leave", () => {
    removeFromQueue(socket.id);
    const opponentId = clearMatch(socket.id);
    if (opponentId && isConnectedPlayer(opponentId)) {
      io.to(opponentId).emit("match:ended", {
        reason: "opponent-left-queue"
      });
    }
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);

    const opponentId = clearMatch(socket.id);
    if (opponentId && isConnectedPlayer(opponentId)) {
      io.to(opponentId).emit("match:ended", {
        reason: "opponent-disconnected"
      });
    }

    players.delete(socket.id);
    emitRoster();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Speed-o-Gram listening at http://${HOST}:${PORT}`);
  console.log(`Serving static files from: ${staticDir}`);
});
