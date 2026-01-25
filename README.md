# Impostor Word Game

A mobile-first, online multiplayer impostor word game.

Players take turns giving clues related to a secret word, then vote to find the impostor.

---

## Features

- Web-based, mobile-first (works on phones)
- 3–15 players per lobby
- Random lobby code generation
- 2 turn-based rounds of word clues
- Round 1 words stay visible during Round 2
- 1 impostor per game
- Voting phase with votes revealed at the end
- Restart only when all players are ready
- Civilian (green) / Impostor (red) roles
- Handles reconnects and avoids duplicate players
- Data-driven words & hints (`words.json`)

---

## Tech Stack

- Frontend: HTML, CSS, Vanilla JS
- Backend: Node.js, Express, WebSockets (`ws`)
- Hosting: GitHub + Render

---

## Project Structure

impostor-word-game/
├─ backend/
│  ├─ server.js
│  └─ words.json
├─ frontend/
│  ├─ index.html
│  ├─ app.js
│  └─ style.css (optional)
└─ README.md

---

## How to Run (Render)

1. Push this repo to GitHub  
2. Create a **New Web Service** on Render  
3. Select **Node.js**  
4. Render will auto-detect and deploy  
5. Open the Render URL and play  

No environment variables required.

---

## How to Play

1. Enter a nickname  
2. Create or join a lobby using the lobby code  
3. Start game (minimum 3 players)  
4. Take turns giving related words (2 rounds)  
5. Vote for the impostor  
6. See results and votes  
7. Restart when everyone clicks restart  

---

## Notes

- Players are identified using a unique browser ID
- Temporary disconnects are handled gracefully
- Words and hints can be easily expanded in `words.json`

---

Enjoy playing! 🎮