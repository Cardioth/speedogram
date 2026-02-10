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

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const staticDir = fs.existsSync(publicDir) ? publicDir : rootDir;

app.use(express.static(staticDir));

app.get("/", (_req, res) => {
  const indexPath = path.join(staticDir, "index.html");
  res.sendFile(indexPath);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, players: players.size });
});

io.on("connection", (socket) => {
  players.set(socket.id, {
    id: socket.id,
    name: `Player ${players.size + 1}`,
    score: 0,
    level: 0,
    lives: 3,
    gameMode: "menu"
  });

  io.emit("players:update", Array.from(players.values()));

  socket.on("player:update", (incoming) => {
    const existing = players.get(socket.id);
    if (!existing) return;

    const updated = {
      ...existing,
      name:
        typeof incoming?.name === "string" && incoming.name.trim()
          ? incoming.name.trim().slice(0, 24)
          : existing.name,
      score: Number.isFinite(incoming?.score) ? incoming.score : existing.score,
      level: Number.isFinite(incoming?.level) ? incoming.level : existing.level,
      lives: Number.isFinite(incoming?.lives) ? incoming.lives : existing.lives,
      gameMode:
        typeof incoming?.gameMode === "string"
          ? incoming.gameMode
          : existing.gameMode
    };

    players.set(socket.id, updated);
    io.emit("players:update", Array.from(players.values()));
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    io.emit("players:update", Array.from(players.values()));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Speed-o-Gram listening at http://${HOST}:${PORT}`);
  console.log(`Serving static files from: ${staticDir}`);
});
