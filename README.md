# speedogram

Speed-o-Gram runs on a Node.js + Socket.IO server so players can be matched live and see each other’s board in real time (side-by-side multiplayer style).

## Replit setup

Use a **Node.js Repl** and keep these files in the project root:
- `server.js`
- `package.json`
- `.replit`
- `index.html` (or `public/index.html`)

This repo is configured to run:

```bash
npm install && npm start
```

The server binds to `0.0.0.0:$PORT` for Replit preview compatibility.

## New multiplayer flow

1. Enter your name and click **Save**.
2. Click **Start** in the game canvas.
3. You are matched with the next available player in queue.
4. Once matched, your game starts and the right-side board shows a live view of your opponent’s current board, score, level, lives, and game mode.

## Endpoints

- `/` → game page
- `/health` → server health and queue/match counts

## Run locally

1. `npm install`
2. `npm start`
3. Open `http://localhost:3000` in two tabs/windows to test matchmaking.
