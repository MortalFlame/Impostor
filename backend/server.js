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
const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: false // Better for mobile
});

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
  const dataStr = JSON.stringify(data);
  
  lobby.players.forEach(p => {
    if (p.ws?.readyState === 1) {
      try {
        p.ws.send(dataStr);
      } catch (err) {
        console.log(`Failed to send to player ${p.name}:`, err.message);
      }
    }
  });
  
  lobby.spectators.forEach(s => {
    if (s.ws?.readyState === 1) {
      try {
        s.ws.send(dataStr);
      } catch (err) {
        console.log(`Failed to send to spectator ${s.name}:`, err.message);
      }
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
    p.lastActionTime = Date.now();
    try {
      p.ws.send(JSON.stringify({
        type: 'gameStart',
        role: p.role,
        word: p.role === 'civilian' ? word : hint
      }));
    } catch (err) {
      console.log(`Failed to send gameStart to ${p.name}`);
    }
  });

  // Send game start to spectators
  lobby.spectators.forEach(s => {
    if (s.ws?.readyState === 1) {
      try {
        s.ws.send(JSON.stringify({
          type: 'gameStart',
          role: 'spectator',
          word: 'Spectator Mode - Watching'
        }));
      } catch (err) {
        console.log(`Failed to send gameStart to spectator ${s.name}`);
      }
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
  const now = Date.now();
  let hasChanges = false;
  
  // Remove disconnected players after 60 seconds (increased from 30)
  lobby.players = lobby.players.filter(p => {
    if (p.ws?.readyState === 1) return true;
    if (p.lastDisconnectTime && now - p.lastDisconnectTime > 60000) {
      console.log(`Removing disconnected player after 60s: ${p.name}`);
      hasChanges = true;
      return false;
    }
    return true;
  });
  
  // Remove disconnected spectators after 60 seconds
  lobby.spectators = lobby.spectators.filter(s => {
    if (s.ws?.readyState === 1) return true;
    if (s.lastDisconnectTime && now - s.lastDisconnectTime > 60000) {
      console.log(`Removing disconnected spectator after 60s: ${s.name}`);
      hasChanges = true;
      return false;
    }
    return true;
  });
  
  // If lobby is completely empty, delete it
  if (lobby.players.length === 0 && lobby.spectators.length === 0) {
    console.log(`Deleting empty lobby: ${lobbyId}`);
    delete lobbies[lobbyId];
    return;
  }
  
  // Update owner if owner disconnected
  if (lobby.players.length > 0 && lobby.owner) {
    const ownerStillConnected = lobby.players.some(p => 
      p.id === lobby.owner && p.ws?.readyState === 1
    );
    if (!ownerStillConnected) {
      const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
      if (newOwner) {
        lobby.owner = newOwner.id;
        hasChanges = true;
      }
    }
  }
  
  if (hasChanges) {
    broadcast(lobby, { 
      type: 'lobbyUpdate', 
      players: lobby.players.map(p => p.name),
      spectators: lobby.spectators.map(s => s.name),
      owner: lobby.owner,
      phase: lobby.phase
    });
  }
}

// Periodic cleanup every 15 seconds (increased from 10)
setInterval(() => {
  Object.keys(lobbies).forEach(lobbyId => {
    cleanupLobby(lobbies[lobbyId], lobbyId);
  });
}, 15000);

// Heartbeat/ping interval to keep connections alive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (err) {
      // Connection already closed
    }
  });
}, 30000); // Ping every 30 seconds

wss.on('connection', (ws, req) => {
  // Get client IP for logging (optional)
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`New connection from: ${clientIP}`);
  
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let lobbyId = null;
  let player = null;
  let connectionId = crypto.randomUUID(); // Track this specific connection

  // Set a timeout for connection - if no messages in 30 seconds, close
  const connectionTimeout = setTimeout(() => {
    if (ws.readyState === ws.OPEN) {
      console.log(`Closing idle connection: ${connectionId}`);
      ws.close(1000, 'Connection timeout');
    }
  }, 30000);

  ws.on('message', (raw) => {
    clearTimeout(connectionTimeout); // Reset timeout on activity
    
    try {
      const msg = JSON.parse(raw.toString());
      
      // Reset connection alive flag
      ws.isAlive = true;

      // Handle ping from client (optional)
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // --- DISCONNECTING MESSAGE ---
      if (msg.type === 'disconnecting') {
        console.log(`Client ${connectionId} disconnecting gracefully`);
        return;
      }

      // --- JOIN LOBBY AS PLAYER ---
      if (msg.type === 'joinLobby') {
        lobbyId = msg.lobbyId || Math.floor(1000 + Math.random() * 9000).toString();
        
        if (!lobbies[lobbyId]) {
          lobbies[lobbyId] = { 
            players: [], 
            spectators: [],
            phase: 'lobby', 
            owner: msg.playerId,
            createdAt: Date.now()
          }; 
          console.log(`Created new lobby: ${lobbyId}`);
        }
        
        const lobby = lobbies[lobbyId];

        // If game is in progress, join as spectator automatically
        if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
          console.log(`Player ${msg.playerId} joining game in progress as spectator`);
          
          // Check if they were already a player in this game
          const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
          if (existingPlayer) {
            // Reconnecting player - let them resume their role
            player = existingPlayer;
            player.ws = ws;
            player.lastDisconnectTime = null;
            player.connectionId = connectionId;
            
            // Send current game state
            setTimeout(() => {
              try {
                ws.send(JSON.stringify({
                  type: 'gameStart',
                  role: player.role,
                  word: player.role === 'civilian' ? lobby.word : lobby.hint
                }));
                
                if (lobby.phase === 'round1' || lobby.phase === 'round2') {
                  ws.send(JSON.stringify({
                    type: 'turnUpdate',
                    phase: lobby.phase,
                    round1: lobby.round1,
                    round2: lobby.round2,
                    currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown'
                  }));
                } else if (lobby.phase === 'voting') {
                  ws.send(JSON.stringify({
                    type: 'startVoting',
                    players: lobby.players.map(p => p.name)
                  }));
                }
              } catch (err) {
                console.log(`Error sending game state to reconnecting player ${player.name}`);
              }
            }, 100);
          } else {
            // New spectator
            return handleSpectatorJoin(ws, msg, lobbyId, connectionId);
          }
        } else {
          // Game not in progress - join as normal player
          return handlePlayerJoin(ws, msg, lobbyId, connectionId);
        }
      }

      // --- JOIN AS SPECTATOR ---
      if (msg.type === 'joinSpectator') {
        if (!msg.lobbyId) {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Lobby code required for spectating' 
          }));
          return;
        }
        
        return handleSpectatorJoin(ws, msg, msg.lobbyId, connectionId);
      }

      if (!player || !lobbyId) return;
      
      const lobby = lobbies[lobbyId];
      if (!lobby) return;

      // Check if this is a spectator
      const isSpectator = lobby.spectators.some(s => s.id === player.id);
      
      if (isSpectator) {
        // Spectators can only restart (convert to player for next game)
        if (msg.type === 'restart' && (lobby.phase === 'lobby' || lobby.phase === 'results')) {
          const spectatorIndex = lobby.spectators.findIndex(s => s.id === player.id);
          if (spectatorIndex !== -1) {
            lobby.spectators.splice(spectatorIndex, 1);
            player.isSpectator = false;
            player.role = null;
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

      // --- GAME ACTIONS (Players only) ---

      // Update last action time
      player.lastActionTime = Date.now();

      // --- START GAME ---
      if (msg.type === 'startGame' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        startGame(lobby);
      }

      // --- SUBMIT WORD ---
      if (msg.type === 'submitWord') {
        if (!lobby.players[lobby.turn] || lobby.players[lobby.turn].id !== player.id) {
          return;
        }

        if (player.ws?.readyState !== 1) return;

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

        // Skip to next connected player
        let attempts = 0;
        while (attempts < lobby.players.length) {
          if (lobby.players[lobby.turn]?.ws?.readyState === 1) break;
          lobby.turn = (lobby.turn + 1) % lobby.players.length;
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

          if (isTie) ejected = null;

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
        
        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        if (lobby.restartReady.length === connectedPlayers.length) {
          startGame(lobby);
        } else {
          broadcast(lobby, {
            type: 'restartUpdate',
            readyCount: lobby.restartReady.length,
            totalPlayers: connectedPlayers.length
          });
        }
      }

    } catch (error) {
      console.error('Error processing message:', error.message);
      try {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Server error processing your request' 
        }));
      } catch (sendError) {
        // Connection already closed
      }
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    
    if (lobbyId && lobbies[lobbyId] && player) {
      const lobby = lobbies[lobbyId];
      
      player.lastDisconnectTime = Date.now();
      
      // If game is in progress and it's this player's turn, skip them after 20 seconds (increased from 10)
      if ((lobby.phase === 'round1' || lobby.phase === 'round2') && 
          lobby.players[lobby.turn]?.id === player.id) {
        
        setTimeout(() => {
          if (player.ws?.readyState !== 1 && lobby.phase !== 'voting' && lobby.phase !== 'results') {
            // Skip to next connected player
            let attempts = 0;
            while (attempts < lobby.players.length) {
              lobby.turn = (lobby.turn + 1) % lobby.players.length;
              if (lobby.players[lobby.turn]?.ws?.readyState === 1) break;
              attempts++;
            }
            
            broadcast(lobby, {
              type: 'turnUpdate',
              phase: lobby.phase,
              round1: lobby.round1,
              round2: lobby.round2,
              currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown'
            });
          }
        }, 20000); // Increased to 20 seconds
      }
      
      // Update lobby state
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => p.name),
        spectators: lobby.spectators.map(s => s.name),
        owner: lobby.owner,
        phase: lobby.phase
      });
    }
    
    console.log(`Connection closed: ${connectionId} (code: ${code}, reason: ${reason})`);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${connectionId}:`, error.message);
  });

  // Helper functions
  function handlePlayerJoin(ws, msg, targetLobbyId, connectionId) {
    const lobby = lobbies[targetLobbyId];
    lobbyId = targetLobbyId;
    
    let existingPlayer = lobby.players.find(p => p.id === msg.playerId);
    if (existingPlayer) {
      player = existingPlayer;
      player.ws = ws;
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
    } else {
      player = { 
        id: msg.playerId, 
        name: msg.name, 
        ws, 
        connectionId,
        lastActionTime: Date.now(),
        reconnectionAttempts: 0
      };
      lobby.players.push(player);
      
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
  }

  function handleSpectatorJoin(ws, msg, targetLobbyId, connectionId) {
    if (!lobbies[targetLobbyId]) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Lobby not found' 
      }));
      return;
    }
    
    const lobby = lobbies[targetLobbyId];
    lobbyId = targetLobbyId;
    
    // Check if already a player
    const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
    if (existingPlayer) {
      // Player reconnecting - let them resume
      player = existingPlayer;
      player.ws = ws;
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
    } else {
      // Check if already a spectator
      let existingSpectator = lobby.spectators.find(s => s.id === msg.playerId);
      if (existingSpectator) {
        player = existingSpectator;
        player.ws = ws;
        player.lastDisconnectTime = null;
        player.connectionId = connectionId;
      } else {
        player = { 
          id: msg.playerId, 
          name: msg.name || `Spectator-${Math.floor(Math.random() * 1000)}`, 
          ws, 
          isSpectator: true,
          connectionId,
          lastActionTime: Date.now()
        };
        lobby.spectators.push(player);
      }
    }

    ws.send(JSON.stringify({ 
      type: 'lobbyAssigned', 
      lobbyId: lobbyId,
      isSpectator: player.isSpectator || false
    }));
    
    broadcast(lobby, { 
      type: 'lobbyUpdate', 
      players: lobby.players.map(p => p.name),
      spectators: lobby.spectators.map(s => s.name),
      owner: lobby.owner,
      phase: lobby.phase
    });

    // Send current game state if in progress
    if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
      setTimeout(() => {
        try {
          const roleToSend = player.role || 'spectator';
          const wordToSend = player.role === 'civilian' ? lobby.word : 
                            player.role === 'impostor' ? lobby.hint : 
                            'Spectator Mode - Watching';
          
          ws.send(JSON.stringify({
            type: 'gameStart',
            role: roleToSend,
            word: wordToSend
          }));
          
          if (lobby.phase === 'round1' || lobby.phase === 'round2') {
            ws.send(JSON.stringify({
              type: 'turnUpdate',
              phase: lobby.phase,
              round1: lobby.round1,
              round2: lobby.round2,
              currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
              isSpectator: roleToSend === 'spectator'
            }));
          } else if (lobby.phase === 'voting') {
            ws.send(JSON.stringify({
              type: 'startVoting',
              players: lobby.players.map(p => p.name),
              isSpectator: roleToSend === 'spectator'
            }));
          }
        } catch (err) {
          console.log(`Error sending game state to ${player.name}`);
        }
      }, 100);
    }
  }
});