# speedogram

Speed-o-Gram runs on a Node.js server with Socket.IO so players can play live side by side and see each other's game progress.

The server binds to `0.0.0.0:$PORT` (Railway-friendly) and serves:
- `/` -> `index.html`
- `/health` -> health JSON

## Run locally

1. `npm install`
2. (Optional, for persistent leaderboard) set Upstash REST secrets:
   `export UPSTASH_REDIS_REST_URL="https://<region>-<id>.upstash.io"`
   `export UPSTASH_REDIS_REST_TOKEN="<token>"`
3. `npm start`
4. Open `http://localhost:3000`

## Persistent leaderboard with free Redis (Upstash)

The leaderboard now supports Redis persistence via Upstash REST (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`). Without them, the app falls back to in-memory scores.

To set up a free Redis instance:

1. Create a free account at [Upstash](https://upstash.com/).
2. Create a new **Redis** database (free tier).
3. Open the database details and copy the **REST URL** and **REST Token**.
4. Set it in your runtime environment:
   - Local shell:
     - `export UPSTASH_REDIS_REST_URL="<your-upstash-rest-url>"`
     - `export UPSTASH_REDIS_REST_TOKEN="<your-upstash-rest-token>"`
   - Railway Variables: add both variables with the same values.
5. Restart the app.

### Railway: where to put the secrets

In Railway:
1. Open your project.
2. Go to your service.
3. Open **Variables**.
4. Add these keys:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
5. Save; Railway redeploys automatically.

Do **not** commit these values into `server.js` or `README.md`.

When connected, the server logs `[leaderboard] Connected to Redis.` and the top leaderboard entries survive restarts.

## Multiplayer behavior

- Each connected player appears in the **Live Players** panel.
- The panel updates in real time with each player's score, level, lives, and game state.
- Gameplay itself remains the same classic Speed-o-Gram loop.
