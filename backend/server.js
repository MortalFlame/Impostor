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
  
  // Also broadcast to spectators
  lobby.spectators.forEach(s => {
    if (s.ws?.readyState === 1) {
      s.ws.send(JSON.stringify(data));
    }
  });
}

function broadcastToPlayersOnly(lobby, data) {
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

  // Clear spectator votes
  lobby.spectators.forEach(s => s.vote = '');

  const impostorIndex = crypto.randomInt(lobby.players.length);
  const { word, hint } = getRandomWord();

  lobby.word = word;
  lobby.hint = hint;

  // Send game start to players
  lobby.players.forEach((p, i) => {
    p.role = i === impostorIndex ? 'impostor' : 'civilian';
    p.vote = '';
    p.ws.send(JSON.stringify({
      type: 'gameStart',
      role: p.role,
      word: p.role === 'civilian' ? word : hint
    }));
  });

  // Send game start to spectators
  lobby.spectators.forEach(s => {
    s.ws.send(JSON.stringify({
      type: 'gameStart',
      role: 'spectator',
      word: 'Spectator Mode - Watching'
    }));
  });

  // Send initial turn update to all
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

    // --- JOIN LOBBY AS PLAYER ---
    if (msg.type === 'joinLobby') {
      lobbyId = msg.lobbyId || Math.floor(1000 + Math.random() * 9000).toString();
      
      // Create lobby if it doesn't exist
      if (!lobbies[lobbyId]) {
        lobbies[lobbyId] = { 
          players: [], 
          spectators: [],
          phase: 'lobby', 
          owner: msg.playerId
        }; 
      }
      const lobby = lobbies[lobbyId];

      // Check if player already exists in lobby
      let existingPlayer = lobby.players.find(p => p.id === msg.playerId);
      let existingSpectator = lobby.spectators.find(s => s.id === msg.playerId);
      
      if (existingPlayer) {
        // Reconnecting player
        player = existingPlayer;
        player.ws = ws;
        player.name = msg.name;
      } else if (existingSpectator) {
        // Spectator wants to become player (convert from spectator to player)
        lobby.spectators = lobby.spectators.filter(s => s.id !== msg.playerId);
        player = { id: msg.playerId, name: msg.name, ws };
        lobby.players.push(player);
      } else {
        // New player
        player = { id: msg.playerId, name: msg.name, ws };
        lobby.players.push(player);
        
        // First player becomes owner if no owner exists
        if (!lobby.owner) {
          lobby.owner = msg.playerId;
        }
      }

      ws.send(JSON.stringify({ 
        type: 'lobbyAssigned', 
        lobbyId,
        isSpectator: false
      }));
      
      // Broadcast updated lobby state
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => p.name),
        spectators: lobby.spectators.map(s => s.name),
        owner: lobby.owner,
        phase: lobby.phase
      });

      // If game is in progress, send current game state to the joining player
      if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
        const spectatorData = {
          type: 'gameStart',
          role: 'spectator',
          word: 'Spectator Mode - Watching'
        };
        
        // Send appropriate game state
        if (lobby.phase === 'round1' || lobby.phase === 'round2') {
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'turnUpdate',
              phase: lobby.phase,
              round1: lobby.round1,
              round2: lobby.round2,
              currentPlayer: lobby.players[lobby.turn].name,
              isSpectator: true
            }));
          }, 100);
        } else if (lobby.phase === 'voting') {
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'startVoting',
              players: lobby.players.map(p => p.name),
              isSpectator: true
            }));
          }, 100);
        }
      }
      return;
    }

    // --- JOIN AS SPECTATOR ---
    if (msg.type === 'joinSpectator') {
      lobbyId = msg.lobbyId;
      
      if (!lobbyId || !lobbies[lobbyId]) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Lobby not found' 
        }));
        return;
      }
      
      const lobby = lobbies[lobbyId];
      
      // Check if already a player
      const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
      if (existingPlayer) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Already a player in this lobby' 
        }));
        return;
      }
      
      // Check if already a spectator
      let existingSpectator = lobby.spectators.find(s => s.id === msg.playerId);
      if (existingSpectator) {
        // Reconnecting spectator
        existingSpectator.ws = ws;
        existingSpectator.name = msg.name;
        player = existingSpectator;
      } else {
        // New spectator
        player = { 
          id: msg.playerId, 
          name: `👁️ ${msg.name || 'Spectator'}`, 
          ws, 
          isSpectator: true 
        };
        lobby.spectators.push(player);
      }

      ws.send(JSON.stringify({ 
        type: 'lobbyAssigned', 
        lobbyId,
        isSpectator: true
      }));
      
      // Broadcast updated lobby state
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => p.name),
        spectators: lobby.spectators.map(s => s.name),
        owner: lobby.owner,
        phase: lobby.phase
      });

      // Send current game state if game is in progress
      if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'gameStart',
            role: 'spectator',
            word: 'Spectator Mode - Watching'
          }));
          
          if (lobby.phase === 'round1' || lobby.phase === 'round2') {
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'turnUpdate',
                phase: lobby.phase,
                round1: lobby.round1,
                round2: lobby.round2,
                currentPlayer: lobby.players[lobby.turn].name,
                isSpectator: true
              }));
            }, 200);
          } else if (lobby.phase === 'voting') {
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'startVoting',
                players: lobby.players.map(p => p.name),
                isSpectator: true
              }));
            }, 200);
          }
        }, 100);
      }
      return;
    }

    if (!player) return;
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    // Check if this is a spectator (no game actions allowed)
    const isSpectator = lobby.spectators.some(s => s.id === player.id);
    
    if (isSpectator) {
      // Spectators can only restart (to join next game) and see updates
      if (msg.type === 'restart') {
        // Spectator wants to join next game as player
        // This will be handled in the joinLobby when they restart
        return;
      }
      // Ignore all other game actions from spectators
      return;
    }

    // --- START GAME ---
    if (msg.type === 'startGame' && lobby.phase === 'lobby') {
      if (lobby.owner !== player.id) {
        return;
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
          broadcast(lobby, {
            type: 'turnUpdate',
            phase: 'round1',
            round1: lobby.round1,
            round2: lobby.round2,
            currentPlayer: lobby.players[0].name
          });
        } 
        else if (lobby.phase === 'round2') {
          lobby.phase = 'voting';
          broadcast(lobby, {
            type: 'turnUpdate',
            phase: 'round2',
            round1: lobby.round1,
            round2: lobby.round2,
            currentPlayer: 'Voting Phase'
          });
          
          setTimeout(() => {
            broadcast(lobby, {
              type: 'startVoting',
              players: lobby.players.map(p => p.name)
            });
          }, 500);
        }
        return;
      }

      broadcast(lobby, {
        type: 'turnUpdate',
        phase: lobby.phase,
        round1: lobby.round1,
        round2: lobby.round2,
        currentPlayer: lobby.players[lobby.turn].name
      });
    }

    // --- VOTE ---
    if (msg.type === 'vote') {
      if (msg.vote === player.name) return;
      player.vote = msg.vote;

      if (lobby.players.every(p => p.vote)) {
        const voteCounts = {};
        lobby.players.forEach(p => {
          voteCounts[p.vote] = (voteCounts[p.vote] || 0) + 1;
        });

        let ejected = null;
        let maxVotes = 0;
        let isTie = false;

        Object.entries(voteCounts).forEach(([name, count]) => {
          if (count > maxVotes) {
            maxVotes = count;
            ejected = name;
            isTie = false;
          } else if (count === maxVotes && name !== ejected) {
            isTie = true;
          }
        });

        if (isTie) {
          ejected = null;
        }

        const impostor = lobby.players.find(p => p.role === 'impostor');
        const winner = (ejected === impostor?.name) ? 'Civilians' : 'Impostor';

        broadcast(lobby, {
          type: 'gameEnd',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          votes: Object.fromEntries(lobby.players.map(p => [p.name, p.vote])),
          secretWord: lobby.word,
          hint: lobby.hint,
          winner
        });
        lobby.phase = 'results';
      }
    }

    // --- RESTART ---
    if (msg.type === 'restart') {
      lobby.restartReady.push(player.id);
      
      // Check if all players (not spectators) are ready
      if (lobby.restartReady.length === lobby.players.length) {
        startGame(lobby);
      } else {
        // Broadcast who's ready
        broadcast(lobby, {
          type: 'restartUpdate',
          readyCount: lobby.restartReady.length,
          totalPlayers: lobby.players.length
        });
      }
    }
  });

  // Handle disconnection
  ws.onclose = () => {
    if (lobbyId && lobbies[lobbyId]) {
      const lobby = lobbies[lobbyId];
      
      // Remove from players
      const playerIndex = lobby.players.findIndex(p => p.id === player?.id);
      if (playerIndex !== -1) {
        lobby.players.splice(playerIndex, 1);
        
        // If no players left, delete lobby
        if (lobby.players.length === 0 && lobby.spectators.length === 0) {
          delete lobbies[lobbyId];
          return;
        }
        
        // Update owner if owner left
        if (lobby.owner === player?.id && lobby.players.length > 0) {
          lobby.owner = lobby.players[0].id;
        }
      }
      
      // Remove from spectators
      const spectatorIndex = lobby.spectators.findIndex(s => s.id === player?.id);
      if (spectatorIndex !== -1) {
        lobby.spectators.splice(spectatorIndex, 1);
      }
      
      // Update remaining clients
      if (lobby.players.length > 0 || lobby.spectators.length > 0) {
        broadcast(lobby, { 
          type: 'lobbyUpdate', 
          players: lobby.players.map(p => p.name),
          spectators: lobby.spectators.map(s => s.name),
          owner: lobby.owner,
          phase: lobby.phase
        });
      }
    }
  };
});