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

function checkGameEndConditions(lobby, lobbyId) {
  if (lobby.phase === 'lobby' || lobby.phase === 'results' || lobby.phase === 'voting') {
    return false;
  }
  
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  
  if (connectedPlayers.length < 3) {
    console.log(`Game in lobby ${lobbyId} ending: less than 3 players connected (${connectedPlayers.length})`);
    endGameEarly(lobby, 'not_enough_players');
    return true;
  }
  
  if (lobby.phase === 'round1' || lobby.phase === 'round2') {
    const impostor = lobby.players.find(p => p.role === 'impostor');
    if (impostor && impostor.ws?.readyState !== 1) {
      console.log(`Game in lobby ${lobbyId} ending: impostor left`);
      endGameEarly(lobby, 'impostor_left');
      return true;
    }
  }
  
  return false;
}

function endGameEarly(lobby, reason) {
  if (lobby.turnTimeout) {
    clearTimeout(lobby.turnTimeout);
    lobby.turnTimeout = null;
  }
  
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  const winner = (reason === 'impostor_left') ? 'Civilians' : 'Impostor';
  
  broadcast(lobby, {
    type: 'gameEndEarly',
    roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
    secretWord: lobby.word,
    hint: lobby.hint,
    winner,
    reason
  });
  
  lobby.phase = 'results';
  lobby.restartReady = [];
}

function startGame(lobby) {
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
  lobby.turnTimeout = null;

  lobby.spectators.forEach(s => s.vote = '');

  const { word, hint } = getRandomWord();
  lobby.word = word;
  lobby.hint = hint;

  const shuffledConnectedPlayers = [...connectedPlayers].sort(() => Math.random() - 0.5);
  const impostorIndex = crypto.randomInt(shuffledConnectedPlayers.length);
  
  lobby.players.forEach(p => p.role = null);
  
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

  let firstConnectedIndex = 0;
  for (let i = 0; i < lobby.players.length; i++) {
    if (lobby.players[i].ws?.readyState === 1) {
      firstConnectedIndex = i;
      break;
    }
  }
  lobby.turn = firstConnectedIndex;
  
  startTurnTimer(lobby);
  
  broadcast(lobby, {
    type: 'turnUpdate',
    phase: lobby.phase,
    round1: [],
    round2: [],
    currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
    timeRemaining: 30
  });
}

function startTurnTimer(lobby) {
  if (lobby.turnTimeout) {
    clearTimeout(lobby.turnTimeout);
    lobby.turnTimeout = null;
  }
  
  if (lobby.phase !== 'round1' && lobby.phase !== 'round2') return;
  
  const currentPlayer = lobby.players[lobby.turn];
  if (!currentPlayer) return;
  
  lobby.turnTimeout = setTimeout(() => {
    console.log(`Turn timeout for player ${currentPlayer.name}`);
    
    if (currentPlayer.ws?.readyState !== 1) {
      skipCurrentPlayer(lobby);
    } else {
      console.log(`Player ${currentPlayer.name} is connected but timed out`);
      skipCurrentPlayer(lobby);
    }
  }, 30000);
}

function skipCurrentPlayer(lobby) {
  console.log(`Skipping player ${lobby.players[lobby.turn]?.name}`);
  
  let nextIndex = (lobby.turn + 1) % lobby.players.length;
  let attempts = 0;
  
  while (attempts < lobby.players.length) {
    if (lobby.players[nextIndex]?.ws?.readyState === 1) {
      lobby.turn = nextIndex;
      break;
    }
    nextIndex = (nextIndex + 1) % lobby.players.length;
    attempts++;
  }
  
  if (attempts >= lobby.players.length) {
    console.log('No connected players found to take turn');
    return;
  }
  
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  
  // FIX: Check if all connected players have submitted for the current round
  if (lobby.phase === 'round1') {
    if (lobby.round1.length >= connectedPlayers.length) {
      // All connected players have submitted for round 1, move to round 2
      lobby.phase = 'round2';
      lobby.turn = 0;
      // Find first connected player for round 2
      for (let i = 0; i < lobby.players.length; i++) {
        if (lobby.players[i]?.ws?.readyState === 1) {
          lobby.turn = i;
          break;
        }
      }
      
      broadcast(lobby, {
        type: 'turnUpdate',
        phase: 'round1', // This tells clients round 1 is complete
        round1: lobby.round1,
        round2: lobby.round2,
        currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
        timeRemaining: 30
      });
      
      startTurnTimer(lobby);
      return;
    }
  } else if (lobby.phase === 'round2') {
    if (lobby.round2.length >= connectedPlayers.length) {
      // All connected players have submitted for round 2, move to voting
      lobby.phase = 'voting';
      if (lobby.turnTimeout) {
        clearTimeout(lobby.turnTimeout);
        lobby.turnTimeout = null;
      }
      
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
      return;
    }
  }
  
  startTurnTimer(lobby);
  
  broadcast(lobby, {
    type: 'turnUpdate',
    phase: lobby.phase,
    round1: lobby.round1,
    round2: lobby.round2,
    currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
    timeRemaining: 30
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
  
  if (hasChanges) {
    checkGameEndConditions(lobby, lobbyId);
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
  }, 45000);

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
            createdAt: Date.now(),
            turnTimeout: null
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
            player.reconnectionAttempts = (player.reconnectionAttempts || 0) + 1;
            
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
                  
                  if (lobby.players[lobby.turn]?.id === player.id) {
                    startTurnTimer(lobby);
                  }
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

      if (msg.type === 'exitLobby') {
        if (lobbyId && lobbies[lobbyId] && player) {
          const lobby = lobbies[lobbyId];
          console.log(`Player ${player.name} exiting lobby ${lobbyId}`);
          
          const wasGameInProgress = (lobby.phase !== 'lobby' && lobby.phase !== 'results');
          const playerWasImpostor = player.role === 'impostor';
          
          if (player.isSpectator) {
            lobby.spectators = lobby.spectators.filter(s => s.id !== player.id);
          } else {
            lobby.players = lobby.players.filter(p => p.id !== player.id);
            
            if (lobby.owner === player.id && lobby.players.length > 0) {
              const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
              if (newOwner) {
                lobby.owner = newOwner.id;
              } else if (lobby.players.length > 0) {
                lobby.owner = lobby.players[0].id;
              }
            }
            
            if (lobby.phase === 'results' || lobby.phase === 'lobby') {
              lobby.restartReady = lobby.restartReady.filter(id => id !== player.id);
            }
          }
          
          if (lobby.players.length === 0 && lobby.spectators.length === 0) {
            delete lobbies[lobbyId];
          } else {
            if (wasGameInProgress) {
              if (playerWasImpostor) {
                checkGameEndConditions(lobby, lobbyId);
              } else {
                const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
                if (connectedPlayers.length < 3) {
                  checkGameEndConditions(lobby, lobbyId);
                }
              }
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
          
          try {
            ws.send(JSON.stringify({ 
              type: 'lobbyExited', 
              message: 'Successfully exited lobby' 
            }));
          } catch (sendError) {
            // Ignore
          }
          
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
            
            try {
              ws.send(JSON.stringify({
                type: 'roleChanged',
                message: 'You are now a player for the next game!'
              }));
            } catch (sendError) {
              // Ignore
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
        }
        return;
      }

      player.lastActionTime = Date.now();

      if (msg.type === 'startGame' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        startGame(lobby);
      }

      if (msg.type === 'submitWord') {
        const currentPlayer = lobby.players[lobby.turn];
        if (!currentPlayer || currentPlayer.id !== player.id) {
          console.log(`Not ${player.name}'s turn (it's ${currentPlayer?.name}'s turn)`);
          return;
        }

        if (player.ws?.readyState !== 1) {
          console.log(`Player ${player.name} not connected`);
          return;
        }

        const entry = { name: player.name, word: msg.word };
        if (lobby.phase === 'round1') {
          lobby.round1.push(entry);
        } else if (lobby.phase === 'round2') {
          lobby.round2.push(entry);
        }

        if (lobby.turnTimeout) {
          clearTimeout(lobby.turnTimeout);
          lobby.turnTimeout = null;
        }

        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        
        // Check if current round is complete
        if (lobby.phase === 'round1' && lobby.round1.length >= connectedPlayers.length) {
          // Round 1 complete, move to round 2
          lobby.phase = 'round2';
          lobby.turn = 0;
          // Find first connected player for round 2
          for (let i = 0; i < lobby.players.length; i++) {
            if (lobby.players[i]?.ws?.readyState === 1) {
              lobby.turn = i;
              break;
            }
          }
          
          broadcast(lobby, {
            type: 'turnUpdate',
            phase: 'round1', // This tells clients round 1 is complete
            round1: lobby.round1,
            round2: lobby.round2,
            currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
            timeRemaining: 30
          });
          
          startTurnTimer(lobby);
          return;
        } else if (lobby.phase === 'round2' && lobby.round2.length >= connectedPlayers.length) {
          // Round 2 complete, move to voting
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
          return;
        }

        // If round not complete, find next connected player
        let nextIndex = (lobby.turn + 1) % lobby.players.length;
        let attempts = 0;
        
        while (attempts < lobby.players.length) {
          if (lobby.players[nextIndex]?.ws?.readyState === 1) {
            lobby.turn = nextIndex;
            break;
          }
          nextIndex = (nextIndex + 1) % lobby.players.length;
          attempts++;
        }
        
        startTurnTimer(lobby);

        broadcast(lobby, {
          type: 'turnUpdate',
          phase: lobby.phase,
          round1: lobby.round1,
          round2: lobby.round2,
          currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
          timeRemaining: 30
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
          
          if (lobby.turnTimeout) {
            clearTimeout(lobby.turnTimeout);
            lobby.turnTimeout = null;
          }
        }
      }

      if (msg.type === 'restart') {
        if (!lobby.restartReady.includes(player.id)) {
          lobby.restartReady.push(player.id);
        }
        
        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        
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
        
        const spectatorsWantingToJoin = lobby.spectators.filter(s => 
          s.ws?.readyState === 1 && s.wantsToJoinNextGame
        );
        
        if (lobby.restartReady.length === connectedPlayers.length) {
          spectatorsWantingToJoin.forEach(spectator => {
            const spectatorIndex = lobby.spectators.findIndex(s => s.id === spectator.id);
            if (spectatorIndex !== -1) {
              lobby.spectators.splice(spectatorIndex, 1);
              spectator.isSpectator = false;
              spectator.wantsToJoinNextGame = false;
              lobby.players.push(spectator);
              
              try {
                spectator.ws.send(JSON.stringify({
                  type: 'roleChanged',
                  message: 'You are now a player for the next game!'
                }));
              } catch (err) {
                console.log(`Failed to send role change to ${spectator.name}`);
              }
            }
          });
          
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
      
      const wasGameInProgress = (lobby.phase !== 'lobby' && lobby.phase !== 'results');
      const playerWasImpostor = player.role === 'impostor';
      
      if ((lobby.phase === 'round1' || lobby.phase === 'round2') && 
          lobby.players[lobby.turn]?.id === player.id) {
        
        setTimeout(() => {
          if (player.ws?.readyState !== 1 && lobby.phase !== 'voting' && lobby.phase !== 'results') {
            console.log(`Player ${player.name} disconnected during turn, skipping...`);
            skipCurrentPlayer(lobby);
          }
        }, 30000);
      }
      
      if (wasGameInProgress) {
        if (playerWasImpostor) {
          checkGameEndConditions(lobby, lobbyId);
        } else {
          const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
          if (connectedPlayers.length < 3) {
            checkGameEndConditions(lobby, lobbyId);
          }
        }
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
      player.reconnectionAttempts = (player.reconnectionAttempts || 0) + 1;
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
      try {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Lobby not found' 
        }));
      } catch (sendError) {
        // Ignore
      }
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
          lastActionTime: Date.now(),
          wantsToJoinNextGame: false
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