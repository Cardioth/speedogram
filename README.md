# speedogram

Speed-o-Gram now runs on a Node.js server with Socket.IO so multiple players in the same Replit can play live side by side and see each other's game progress.

## Run on Replit / Node.js

1. Import this repo into Replit.
2. Run `npm install`.
3. Start with `npm start` (or click **Run**; `.replit` is configured for this).
4. Open multiple browser tabs/windows to simulate multiple players.

## Multiplayer behavior

- Each connected player appears in the **Live Players** panel.
- The panel updates in real time with each player's score, level, lives, and game state.
- Gameplay itself remains the same classic Speed-o-Gram loop.
