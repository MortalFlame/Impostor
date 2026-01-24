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
  perMessageDeflate: false,
  clientTracking: true
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
        console.log(`Failed to send to player ${p.name}`);
      }
    }
  });
  
  lobby.spectators.forEach(s => {
    if (s.ws?.readyState === 1) {
      try {
        s.ws.send(dataStr);
      } catch (err) {
        console.log(`Failed to send to spectator ${s.name}`);
      }
    }
  });
}

function startGame(lobby) {
  // Only count connected players for starting game
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  if (connectedPlayers.length < 3) {
    console.log(`Not enough connected players to start (${connectedPlayers.length} connected)`);
    return;
  }

  lobby.phase = 'round1';
  lobby.turn = 0;
  lobby.round1 = [];
  lobby.round2 = [];
  lobby.restartReady = [];

  lobby.spectators.forEach(s => s.vote = '');

  const { word, hint } = getRandomWord();
  lobby.word = word;
  lobby.hint = hint;

  // IMPORTANT FIX: Only assign roles to connected players
  // Shuffle connected players to randomize impostor selection
  const shuffledConnectedPlayers = [...connectedPlayers].sort(() => Math.random() - 0.5);
  const impostorIndex = crypto.randomInt(shuffledConnectedPlayers.length);
  
  // Clear all roles first
  lobby.players.forEach(p => p.role = null);
  
  // Assign roles to connected players only
  shuffledConnectedPlayers.forEach((player, i) => {
    player.role = i === impostorIndex ? 'impostor' : 'civilian';
    player.vote = '';
    player.lastActionTime = Date.now();
    try {
      player.ws.send(JSON.stringify({
        type: 'gameStart',
        role: player.role,
        word: player.role === 'civilian' ? word : hint
      }));
    } catch (err) {
      console.log(`Failed to send gameStart to ${player.name}`);
    }
  });

  // Send to spectators
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

  // Only use connected players for turn order
  const turnPlayer = shuffledConnectedPlayers[0];
  broadcast(lobby, {
    type: 'turnUpdate',
    phase: lobby.phase,
    round1: [],
    round2: [],
    currentPlayer: turnPlayer.name
  });
}

function cleanupLobby(lobby, lobbyId) {
  const now = Date.now();
  let hasChanges = false;
  
  lobby.players = lobby.players.filter(p => {
    if (p.ws?.readyState === 1) return true;
    if (p.lastDisconnectTime && now - p.lastDisconnectTime > 60000) {
      console.log(`Removing disconnected player after 60s: ${p.name}`);
      hasChanges = true;
      return false;
    }
    return true;
  });
  
  lobby.spectators = lobby.spectators.filter(s => {
    if (s.ws?.readyState === 1) return true;
    if (s.lastDisconnectTime && now - s.lastDisconnectTime > 60000) {
      console.log(`Removing disconnected spectator after 60s: ${s.name}`);
      hasChanges = true;
      return false;
    }
    return true;
  });
  
  if (lobby.players.length === 0 && lobby.spectators.length === 0) {
    console.log(`Deleting empty lobby: ${lobbyId}`);
    delete lobbies[lobbyId];
    return;
  }
  
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
      players: lobby.players.map(p => ({ 
        id: p.id, 
        name: p.name, 
        connected: p.ws?.readyState === 1 
      })),
      spectators: lobby.spectators.map(s => ({ 
        id: s.id, 
        name: s.name, 
        connected: s.ws?.readyState === 1 
      })),
      owner: lobby.owner,
      phase: lobby.phase
    });
  }
}

setInterval(() => {
  Object.keys(lobbies).forEach(lobbyId => {
    cleanupLobby(lobbies[lobbyId], lobbyId);
  });
}, 15000);

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
}, 30000);

wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`New connection from: ${clientIP}`);
  
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let lobbyId = null;
  let player = null;
  let connectionId = crypto.randomUUID();

  const connectionTimeout = setTimeout(() => {
    if (ws.readyState === ws.OPEN) {
      console.log(`Closing idle connection: ${connectionId}`);
      ws.close(1000, 'Connection timeout');
    }
  }, 45000); // Increased to 45 seconds for spectators

  ws.on('message', (raw) => {
    clearTimeout(connectionTimeout);
    
    try {
      const msg = JSON.parse(raw.toString());
      
      ws.isAlive = true;

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'disconnecting') {
        console.log(`Client ${connectionId} disconnecting gracefully`);
        return;
      }

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

        if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
          console.log(`Player ${msg.playerId} joining game in progress`);
          
          const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
          if (existingPlayer) {
            player = existingPlayer;
            player.ws = ws;
            player.lastDisconnectTime = null;
            player.connectionId = connectionId;
            
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
            return handleSpectatorJoin(ws, msg, lobbyId, connectionId);
          }
        } else {
          return handlePlayerJoin(ws, msg, lobbyId, connectionId);
        }
      }

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

      // NEW: Handle exit lobby request
      if (msg.type === 'exitLobby') {
        if (lobbyId && lobbies[lobbyId] && player) {
          const lobby = lobbies[lobbyId];
          console.log(`Player ${player.name} exiting lobby ${lobbyId}`);
          
          // Remove player from appropriate list
          if (player.isSpectator) {
            lobby.spectators = lobby.spectators.filter(s => s.id !== player.id);
          } else {
            lobby.players = lobby.players.filter(p => p.id !== player.id);
            
            // If owner leaves, assign new owner
            if (lobby.owner === player.id && lobby.players.length > 0) {
              const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
              if (newOwner) {
                lobby.owner = newOwner.id;
              } else if (lobby.players.length > 0) {
                lobby.owner = lobby.players[0].id;
              }
            }
            
            // If game is in lobby phase and this player had clicked restart, remove them
            if (lobby.phase === 'results' || lobby.phase === 'lobby') {
              lobby.restartReady = lobby.restartReady.filter(id => id !== player.id);
            }
          }
          
          // Clean up empty lobby
          if (lobby.players.length === 0 && lobby.spectators.length === 0) {
            delete lobbies[lobbyId];
          } else {
            // Broadcast updated lobby
            broadcast(lobby, { 
              type: 'lobbyUpdate', 
              players: lobby.players.map(p => ({ 
                id: p.id, 
                name: p.name, 
                connected: p.ws?.readyState === 1 
              })),
              spectators: lobby.spectators.map(s => ({ 
                id: s.id, 
                name: s.name, 
                connected: s.ws?.readyState === 1 
              })),
              owner: lobby.owner,
              phase: lobby.phase
            });
          }
          
          // Send confirmation to exiting player
          ws.send(JSON.stringify({ 
            type: 'lobbyExited', 
            message: 'Successfully exited lobby' 
          }));
          
          // Reset connection variables
          lobbyId = null;
          player = null;
        }
        return;
      }

      if (!player || !lobbyId) return;
      
      const lobby = lobbies[lobbyId];
      if (!lobby) return;

      const isSpectator = lobby.spectators.some(s => s.id === player.id);
      
      if (isSpectator) {
        if (msg.type === 'restart' && (lobby.phase === 'lobby' || lobby.phase === 'results')) {
          const spectatorIndex = lobby.spectators.findIndex(s => s.id === player.id);
          if (spectatorIndex !== -1) {
            lobby.spectators.splice(spectatorIndex, 1);
            player.isSpectator = false;
            player.role = null;
            lobby.players.push(player);
            
            // Notify the spectator they are now a player
            ws.send(JSON.stringify({
              type: 'roleChanged',
              message: 'You are now a player for the next game!'
            }));
            
            broadcast(lobby, { 
              type: 'lobbyUpdate', 
              players: lobby.players.map(p => ({ 
                id: p.id, 
                name: p.name, 
                connected: p.ws?.readyState === 1 
              })),
              spectators: lobby.spectators.map(s => ({ 
                id: s.id, 
                name: s.name, 
                connected: s.ws?.readyState === 1 
              })),
              owner: lobby.owner,
              phase: lobby.phase
            });
          }
        }
        return;
      }

      player.lastActionTime = Date.now();

      if (msg.type === 'startGame' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        startGame(lobby);
      }

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

      if (msg.type === 'restart') {
        // Only add if not already in the array
        if (!lobby.restartReady.includes(player.id)) {
          lobby.restartReady.push(player.id);
        }
        
        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        
        // Send individual restart update to each player
        lobby.players.forEach(p => {
          if (p.ws?.readyState === 1) {
            try {
              p.ws.send(JSON.stringify({
                type: 'restartUpdate',
                readyCount: lobby.restartReady.length,
                totalPlayers: connectedPlayers.length
              }));
            } catch (err) {
              console.log(`Failed to send restart update to ${p.name}`);
            }
          }
        });
        
        if (lobby.restartReady.length === connectedPlayers.length) {
          startGame(lobby);
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
      
      // If game is in progress and it's this player's turn, skip them after 20 seconds
      if ((lobby.phase === 'round1' || lobby.phase === 'round2') && 
          lobby.players[lobby.turn]?.id === player.id) {
        
        setTimeout(() => {
          if (player.ws?.readyState !== 1 && lobby.phase !== 'voting' && lobby.phase !== 'results') {
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
        }, 20000);
      }
      
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => ({ 
          id: p.id, 
          name: p.name, 
          connected: p.ws?.readyState === 1 
        })),
        spectators: lobby.spectators.map(s => ({ 
          id: s.id, 
          name: s.name, 
          connected: s.ws?.readyState === 1 
        })),
        owner: lobby.owner,
        phase: lobby.phase
      });
    }
    
    console.log(`Connection closed: ${connectionId} (code: ${code}, reason: ${reason})`);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${connectionId}:`, error.message);
  });

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
      players: lobby.players.map(p => ({ 
        id: p.id, 
        name: p.name, 
        connected: p.ws?.readyState === 1 
      })),
      spectators: lobby.spectators.map(s => ({ 
        id: s.id, 
        name: s.name, 
        connected: s.ws?.readyState === 1 
      })),
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
    
    const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
    if (existingPlayer) {
      player = existingPlayer;
      player.ws = ws;
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
    } else {
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
      players: lobby.players.map(p => ({ 
        id: p.id, 
        name: p.name, 
        connected: p.ws?.readyState === 1 
      })),
      spectators: lobby.spectators.map(s => ({ 
        id: s.id, 
        name: s.name, 
        connected: s.ws?.readyState === 1 
      })),
      owner: lobby.owner,
      phase: lobby.phase
    });

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