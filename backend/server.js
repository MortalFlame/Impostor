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
    if (s.ws?.readyState === 1) {
      s.ws.send(JSON.stringify({
        type: 'gameStart',
        role: 'spectator',
        word: 'Spectator Mode - Watching'
      }));
    }
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

function cleanupLobby(lobby, lobbyId) {
  // Check if lobby is empty and can be cleaned up
  const now = Date.now();
  
  // Remove disconnected players after 30 seconds
  lobby.players = lobby.players.filter(p => {
    if (p.ws?.readyState === 1) return true;
    if (p.lastDisconnectTime && now - p.lastDisconnectTime > 30000) {
      console.log(`Removing disconnected player: ${p.name}`);
      return false;
    }
    return true;
  });
  
  // Remove disconnected spectators after 30 seconds
  lobby.spectators = lobby.spectators.filter(s => {
    if (s.ws?.readyState === 1) return true;
    if (s.lastDisconnectTime && now - s.lastDisconnectTime > 30000) {
      console.log(`Removing disconnected spectator: ${s.name}`);
      return false;
    }
    return true;
  });
  
  // If lobby is completely empty, delete it
  if (lobby.players.length === 0 && lobby.spectators.length === 0) {
    console.log(`Deleting empty lobby: ${lobbyId}`);
    delete lobbies[lobbyId];
  }
  
  // Update owner if owner disconnected
  if (lobby.players.length > 0) {
    const ownerStillConnected = lobby.players.some(p => p.id === lobby.owner && p.ws?.readyState === 1);
    if (!ownerStillConnected) {
      // Find first connected player as new owner
      const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
      if (newOwner) {
        lobby.owner = newOwner.id;
        broadcast(lobby, { 
          type: 'lobbyUpdate', 
          players: lobby.players.map(p => p.name),
          spectators: lobby.spectators.map(s => s.name),
          owner: lobby.owner,
          phase: lobby.phase
        });
      }
    }
  }
}

// Periodic cleanup every 10 seconds
setInterval(() => {
  Object.keys(lobbies).forEach(lobbyId => {
    cleanupLobby(lobbies[lobbyId], lobbyId);
  });
}, 10000);

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

      // IMPORTANT: If game is in progress, force join as spectator
      if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
        // Send message to client to switch to spectator mode
        ws.send(JSON.stringify({
          type: 'forceSpectator',
          message: 'Game in progress. Joining as spectator.'
        }));
        
        // Force them to join as spectator instead
        msg.type = 'joinSpectator';
        // Fall through to spectator handling
      }
    }

    // --- JOIN AS SPECTATOR (or forced spectator) ---
    if (msg.type === 'joinSpectator') {
      if (!msg.lobbyId && !lobbyId) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Lobby code required for spectating' 
        }));
        return;
      }
      
      const targetLobbyId = msg.lobbyId || lobbyId;
      if (!targetLobbyId || !lobbies[targetLobbyId]) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Lobby not found' 
        }));
        return;
      }
      
      const lobby = lobbies[targetLobbyId];
      lobbyId = targetLobbyId;
      
      // Check if already a player in this game
      const existingPlayerIndex = lobby.players.findIndex(p => p.id === msg.playerId);
      if (existingPlayerIndex !== -1) {
        // Reconnecting player
        const existingPlayer = lobby.players[existingPlayerIndex];
        existingPlayer.ws = ws;
        existingPlayer.lastDisconnectTime = null; // Clear disconnect time
        existingPlayer.reconnectionAttempts = (existingPlayer.reconnectionAttempts || 0) + 1;
        player = existingPlayer;
        
        // If game is in progress, send current state
        if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'gameStart',
              role: existingPlayer.role || 'spectator',
              word: existingPlayer.role === 'civilian' ? lobby.word : 
                    existingPlayer.role === 'impostor' ? lobby.hint : 
                    'Reconnected - Waiting'
            }));
            
            if (lobby.phase === 'round1' || lobby.phase === 'round2') {
              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'turnUpdate',
                  phase: lobby.phase,
                  round1: lobby.round1,
                  round2: lobby.round2,
                  currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
                  isSpectator: false
                }));
              }, 200);
            } else if (lobby.phase === 'voting') {
              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'startVoting',
                  players: lobby.players.map(p => p.name),
                  isSpectator: false
                }));
              }, 200);
            }
          }, 100);
        }
      } else {
        // Check if already a spectator
        let existingSpectatorIndex = lobby.spectators.findIndex(s => s.id === msg.playerId);
        if (existingSpectatorIndex !== -1) {
          // Reconnecting spectator
          const existingSpectator = lobby.spectators[existingSpectatorIndex];
          existingSpectator.ws = ws;
          existingSpectator.lastDisconnectTime = null;
          existingSpectator.reconnectionAttempts = (existingSpectator.reconnectionAttempts || 0) + 1;
          player = existingSpectator;
        } else {
          // New spectator
          player = { 
            id: msg.playerId, 
            name: msg.name || `Spectator-${Math.floor(Math.random() * 1000)}`, 
            ws, 
            isSpectator: true,
            reconnectionAttempts: 1
          };
          lobby.spectators.push(player);
        }
      }

      ws.send(JSON.stringify({ 
        type: 'lobbyAssigned', 
        lobbyId: lobbyId,
        isSpectator: player.isSpectator || false
      }));
      
      // Broadcast updated lobby state
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => p.name),
        spectators: lobby.spectators.map(s => s.name),
        owner: lobby.owner,
        phase: lobby.phase
      });

      // If game is in progress, send current game state
      if (lobby.phase !== 'lobby' && lobby.phase !== 'results' && !player.role) {
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
                currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
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

    // --- ORIGINAL JOIN LOBBY CONTINUES (only for non-in-progress games) ---
    if (msg.type === 'joinLobby' && (!lobbyId || lobbies[lobbyId]?.phase === 'lobby' || lobbies[lobbyId]?.phase === 'results')) {
      lobbyId = msg.lobbyId || Math.floor(1000 + Math.random() * 9000).toString();
      
      if (!lobbies[lobbyId]) {
        lobbies[lobbyId] = { 
          players: [], 
          spectators: [],
          phase: 'lobby', 
          owner: msg.playerId
        }; 
      }
      const lobby = lobbies[lobbyId];

      // Check if player already exists
      let existingPlayerIndex = lobby.players.findIndex(p => p.id === msg.playerId);
      if (existingPlayerIndex !== -1) {
        // Reconnecting player
        player = lobby.players[existingPlayerIndex];
        player.ws = ws;
        player.name = msg.name;
        player.lastDisconnectTime = null;
        player.reconnectionAttempts = (player.reconnectionAttempts || 0) + 1;
      } else {
        // New player
        player = { id: msg.playerId, name: msg.name, ws, reconnectionAttempts: 1 };
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
      
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => p.name),
        spectators: lobby.spectators.map(s => s.name),
        owner: lobby.owner,
        phase: lobby.phase
      });
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
        // Remove from spectators and add to players when game is in lobby/results
        if (lobby.phase === 'lobby' || lobby.phase === 'results') {
          const spectatorIndex = lobby.spectators.findIndex(s => s.id === player.id);
          if (spectatorIndex !== -1) {
            lobby.spectators.splice(spectatorIndex, 1);
            player.isSpectator = false;
            lobby.players.push(player);
            
            broadcast(lobby, { 
              type: 'lobbyUpdate', 
              players: lobby.players.map(p => p.name),
              spectators: lobby.spectators.map(s => s.name),
              owner: lobby.owner,
              phase: lobby.phase
            });
          }
        }
        return;
      }
      // Ignore all other game actions from spectators
      return;
    }

    // --- GAME ACTIONS (Players only) ---

    // --- START GAME ---
    if (msg.type === 'startGame' && lobby.phase === 'lobby') {
      if (lobby.owner !== player.id) {
        return;
      }
      startGame(lobby);
    }

    // --- SUBMIT WORD ---
    if (msg.type === 'submitWord') {
      // Validate it's the player's turn and they're connected
      if (!lobby.players[lobby.turn] || lobby.players[lobby.turn].id !== player.id) {
        return;
      }

      // Validate player is still connected
      if (player.ws?.readyState !== 1) {
        return;
      }

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

      // Skip disconnected players in turn order
      let nextPlayerIndex = lobby.turn;
      let attempts = 0;
      while (attempts < lobby.players.length) {
        const nextPlayer = lobby.players[nextPlayerIndex];
        if (nextPlayer.ws?.readyState === 1) {
          lobby.turn = nextPlayerIndex;
          break;
        }
        nextPlayerIndex = (nextPlayerIndex + 1) % lobby.players.length;
        attempts++;
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

      // Check if all connected players have voted
      const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
      if (connectedPlayers.every(p => p.vote)) {
        const voteCounts = {};
        connectedPlayers.forEach(p => {
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
          votes: Object.fromEntries(connectedPlayers.map(p => [p.name, p.vote])),
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
      
      // Check if all connected players (not spectators) are ready
      const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
      if (lobby.restartReady.length === connectedPlayers.length) {
        startGame(lobby);
      } else {
        // Broadcast who's ready
        broadcast(lobby, {
          type: 'restartUpdate',
          readyCount: lobby.restartReady.length,
          totalPlayers: connectedPlayers.length
        });
      }
    }
  });

  // Handle disconnection
  ws.onclose = () => {
    if (lobbyId && lobbies[lobbyId] && player) {
      const lobby = lobbies[lobbyId];
      
      // Mark disconnect time
      player.lastDisconnectTime = Date.now();
      
      // If game is in progress and it's this player's turn, skip them after 10 seconds
      if (lobby.phase === 'round1' || lobby.phase === 'round2') {
        const currentPlayerIndex = lobby.players.findIndex(p => p.id === lobby.players[lobby.turn]?.id);
        if (currentPlayerIndex !== -1 && lobby.players[currentPlayerIndex].id === player.id) {
          // Player who disconnected is currently the active player
          setTimeout(() => {
            // Check if player is still disconnected
            if (player.ws?.readyState !== 1 && lobby.phase !== 'voting' && lobby.phase !== 'results') {
              // Skip to next connected player
              lobby.turn = (lobby.turn + 1) % lobby.players.length;
              let attempts = 0;
              while (attempts < lobby.players.length) {
                const nextPlayer = lobby.players[lobby.turn];
                if (nextPlayer.ws?.readyState === 1) {
                  break;
                }
                lobby.turn = (lobby.turn + 1) % lobby.players.length;
                attempts++;
              }
              
              // Update all clients
              broadcast(lobby, {
                type: 'turnUpdate',
                phase: lobby.phase,
                round1: lobby.round1,
                round2: lobby.round2,
                currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown'
              });
            }
          }, 10000); // Wait 10 seconds before skipping
        }
      }
      
      // Update lobby state immediately
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => p.name),
        spectators: lobby.spectators.map(s => s.name),
        owner: lobby.owner,
        phase: lobby.phase
      });
    }
  };
});