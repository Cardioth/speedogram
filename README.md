# speedogram

Speed-o-Gram now runs on a Node.js server with Socket.IO so multiple players in the same Replit can play live side by side and see each other's game progress.

## Replit setup (important)

Use a **Node.js Repl** and keep these files in the project root:
- `server.js`
- `package.json`
- `.replit`
- `index.html` (or put it in `/public/index.html`)

This repo is configured so Replit runs:

```bash
npm start
```

For **Deployments / Publish**, `.replit` also defines:
- build command: `npm install`
- run command: `npm start`

The server binds to `0.0.0.0:$PORT` (Replit-friendly) and serves:
- `/` -> `index.html`
- `/health` -> health JSON

If Replit says **"App is running but there is no page to preview"**, it usually means no HTTP server was detected on `$PORT`. The updated `server.js` now explicitly binds host + port and logs where static files are served from.

## Run locally

1. `npm install`
2. `npm start`
3. Open `http://localhost:3000`

## Multiplayer behavior

- Each connected player appears in the **Live Players** panel.
- The panel updates in real time with each player's score, level, lives, and game state.
- Gameplay itself remains the same classic Speed-o-Gram loop.
