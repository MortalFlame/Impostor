const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.static('frontend'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log('Server running'));
const wss = new WebSocketServer({ server });

// Ensure you have a words.json file in the same directory
const words = JSON.parse(fs.readFileSync(__dirname + '/words.json', 'utf8'));

let lobbies = {};
let usedIndexes = [];

function getRandomWord() {
  if (usedIndexes.length === words.length) usedIndexes = [];
  let i;
  do { i = crypto.randomInt(words.length); } while (usedIndexes.includes(i));
  usedIndexes.push(i);
  return words[i];
}

function broadcast(lobby, data) {
  lobby.players.forEach(p => {
    if (p.ws?.readyState === 1) {
      p.ws.send(JSON.stringify(data));
    }
  });
}

function startGame(lobby) {
  if (lobby.players.length < 3) return;

  lobby.phase = 'round1';
  lobby.turn = 0;
  lobby.round1 = [];
  lobby.round2 = [];
  lobby.restartReady = [];

  const impostorIndex = crypto.randomInt(lobby.players.length);
  const { word, hint } = getRandomWord();

  lobby.word = word;
  lobby.hint = hint;

  lobby.players.forEach((p, i) => {
    p.role = i === impostorIndex ? 'impostor' : 'civilian';
    p.vote = '';
    p.ws.send(JSON.stringify({
      type: 'gameStart',
      role: p.role,
      word: p.role === 'civilian' ? word : hint
    }));
  });

  broadcast(lobby, {
    type: 'turnUpdate',
    phase: lobby.phase,
    round1: [],
    round2: [],
    currentPlayer: lobby.players[0].name
  });
}

wss.on('connection', ws => {
  let lobbyId, player;

  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    // --- JOIN LOBBY ---
    if (msg.type === 'joinLobby') {
      lobbyId = msg.lobbyId || Math.floor(1000 + Math.random() * 9000).toString();
      
      // Create lobby if it doesn't exist and Assign Owner
      if (!lobbies[lobbyId]) {
        lobbies[lobbyId] = { 
            players: [], 
            phase: 'lobby', 
            owner: msg.playerId // <--- 1. Set the owner here
        }; 
      }
      const lobby = lobbies[lobbyId];

      player = lobby.players.find(p => p.id === msg.playerId);
      if (!player) {
        player = { id: msg.playerId, name: msg.name, ws };
        lobby.players.push(player);
      } else {
        player.ws = ws;
      }

      ws.send(JSON.stringify({ type: 'lobbyAssigned', lobbyId }));
      
      // <--- 2. Send owner info so frontend can enable the button
      broadcast(lobby, { 
          type: 'lobbyUpdate', 
          players: lobby.players.map(p => p.name),
          owner: lobby.owner 
      }); 
      return;
    }

    if (!player) return;
    const lobby = lobbies[lobbyId];

    // --- START GAME ---
    if (msg.type === 'startGame' && lobby.phase === 'lobby') {
      // <--- 3. Verify that the requestor is the owner
      if (lobby.owner !== player.id) {
         return; // Ignore start request from non-owners
      }
      startGame(lobby);
    }

    // --- SUBMIT WORD ---
if (msg.type === 'submitWord') {
  if (lobby.players[lobby.turn].id !== player.id) return;

  const entry = { name: player.name, word: msg.word };
  lobby.phase === 'round1' ? lobby.round1.push(entry) : lobby.round2.push(entry);

  lobby.turn++;

  if (lobby.turn >= lobby.players.length) {
    lobby.turn = 0;
    
    if (lobby.phase === 'round1') {
      lobby.phase = 'round2';
      // Send final Round 1 state with all words
      broadcast(lobby, {
        type: 'turnUpdate',
        phase: 'round1', // Still round1 phase for this update
        round1: lobby.round1,
        round2: lobby.round2,
        currentPlayer: lobby.players[0].name
      });
    } 
    else if (lobby.phase === 'round2') {
      lobby.phase = 'voting';
      // CRITICAL: Send final Round 2 state BEFORE voting
      broadcast(lobby, {
        type: 'turnUpdate',
        phase: 'round2', // Still round2 phase for this update
        round1: lobby.round1,
        round2: lobby.round2, // This now includes Player 3's word
        currentPlayer: 'Voting Phase'
      });
      
      // Then start voting
      setTimeout(() => {
        broadcast(lobby, {
          type: 'startVoting',
          players: lobby.players.map(p => p.name)
        });
      }, 500); // Small delay so players see the final words
    }
    return;
  }

  // Normal turn update (not end of round)
  broadcast(lobby, {
    type: 'turnUpdate',
    phase: lobby.phase,
    round1: lobby.round1,
    round2: lobby.round2,
    currentPlayer: lobby.players[lobby.turn].name
  });
}

    // --- VOTE ---
        // ... (previous code remains unchanged)

    // --- VOTE ---
    if (msg.type === 'vote') {
      if (msg.vote === player.name) return;
      player.vote = msg.vote;

      if (lobby.players.every(p => p.vote)) {
        // Calculate Winner
        const voteCounts = {};
        lobby.players.forEach(p => {
          voteCounts[p.vote] = (voteCounts[p.vote] || 0) + 1;
        });

        let ejected = null;
        let maxVotes = 0;

        // Find player with most votes (if tie, ejected remains null/tie)
        Object.entries(voteCounts).forEach(([name, count]) => {
          if (count > maxVotes) {
            maxVotes = count;
            ejected = name;
          } else if (count === maxVotes) {
            ejected = null; // Tie implies no majority ejection
          }
        });

        const impostor = lobby.players.find(p => p.role === 'impostor');
        const winner = (ejected === impostor.name) ? 'Civilians' : 'Impostor';

        broadcast(lobby, {
          type: 'gameEnd',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          votes: Object.fromEntries(lobby.players.map(p => [p.name, p.vote])),
          secretWord: lobby.word,
          hint: lobby.hint,
          winner // <--- Send winner
        });
        lobby.phase = 'results';
      }
    }

    // ... (rest of file remains unchanged)


    // --- RESTART ---
    if (msg.type === 'restart') {
      lobby.restartReady.push(player.id);
      if (lobby.restartReady.length === lobby.players.length) {
        startGame(lobby);
      }
    }
  });
});