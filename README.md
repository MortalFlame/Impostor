# # Impostor Word Game

Mobile-first multiplayer word game. Give clues, find the impostor.

---

## Features

- 3–15 players per lobby  
- **2 Impostors Mode** (optional, requires 5+ players)  
- **Guess Word Mode** – ejected impostor gets 30s to guess the secret word  
- Two rounds of word clues, voting, and full results  
- Game options toggles in **lobby AND results screen** – settings carry over  
- Lobby list – browse available games, one‑click join  
- Spectators can join and opt into next game  
- Grace periods for disconnections (lobby / game / results)  
- Auto‑restart when all conditions met (ready players + spectators wanting to join)  
- Fully responsive – works on phones, tablets, desktops  

---

## Tech Stack

- **Frontend:** HTML, CSS, Vanilla JS  
- **Backend:** Node.js, Express, WebSockets (`ws`)  
- **Hosting:** Render  

---

## Project Structure


## Project Structure

impostor-word-game/
├─ backend/
│  ├─ server.js
│  └─ words.json
├─ frontend/
│  ├─ index.html
│  ├─ app.js
│  └─ style.css
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


---

## Deploy to Render

1. Push this repo to GitHub  
2. Create a **New Web Service** on Render  
3. Select **Node.js**  
4. Set build command:  
   `cd backend && npm install`  
5. Set start command:  
   `node backend/server.js`  
6. Deploy – no environment variables needed  

---

## How to Play

1. Enter a nickname  
2. Create a lobby or join an existing one from the list  
3. **Host** can toggle game modes (2 Impostors / Guess Word) – changes apply immediately and persist for next game  
4. Start game (minimum 3 players; 5+ for 2‑impostor mode)  
5. **Round 1 & 2:** submit a word related to the secret word (30‑second turn timer)  
6. **Vote** for the impostor(s) – 2‑impostor mode requires 2 votes  
7. If **Guess Word** is on, ejected impostor(s) get 30 seconds to guess the secret word  
8. Results screen shows roles, votes, and winner  
9. Press **Restart** to play again – all ready players + spectators who clicked "Join Next Game" will be included  

**Spectators:** click **"Join Next Game"** during the results screen to automatically join the next round as a player.

---

Enjoy! 🎮