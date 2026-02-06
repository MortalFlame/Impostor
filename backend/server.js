const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
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
const SERVER_ID = crypto.randomUUID();

// Grace period constants
const LOBBY_GRACE_PERIOD = 60000; // 60 seconds for lobby
const GAME_GRACE_PERIOD = 30000;   // 30 seconds for in-game disconnections
const RESULTS_GRACE_PERIOD = 30000; // 30 seconds for results phase

// Connection rate limiting
const connectionRateLimit = new Map(); // ip -> {count, resetTime}

// Health endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    uptime: process.uptime(),
    lobbies: Object.keys(lobbies).length,
    players: Object.values(lobbies).reduce((sum, lobby) => 
      sum + lobby.players.filter(p => p.ws?.readyState === 1).length, 0
    )
  });
});

// Rate limiting middleware for WebSocket connections
function checkRateLimit(ip) {
  const now = Date.now();
  const limitInfo = connectionRateLimit.get(ip) || { count: 0, resetTime: now + 60000 };
  
  if (now > limitInfo.resetTime) {
    limitInfo.count = 0;
    limitInfo.resetTime = now + 60000;
  }
  
  limitInfo.count++;
  connectionRateLimit.set(ip, limitInfo);
  
  return limitInfo.count <= 100; // Allow 100 connections per minute per IP
}

// Function to broadcast lobby list to all clients
function broadcastLobbyList() {
  const lobbyList = Object.entries(lobbies).map(([id, lobby]) => ({
    id,
    host: lobby.hostName || 'Unknown',
    playerCount: lobby.players.filter(p => p.ws?.readyState === 1).length,
    spectatorCount: lobby.spectators.filter(s => s.ws?.readyState === 1).length,
    maxPlayers: 15,
    phase: lobby.phase,
    createdAt: lobby.createdAt,
    impostorGuessOption: lobby.impostorGuessOption || false,
    twoImpostorsOption: lobby.twoImpostorsOption || false
  }));

  // Send to ALL clients so returning players see updated list
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(JSON.stringify({
          type: 'lobbyList',
          lobbies: lobbyList
        }));
      } catch (err) {
        // Ignore send errors
      }
    }
  });
}

// Helper function to remove a player from any lobby they might be in
function removePlayerFromAllLobbies(playerId, reason = 'Joined another lobby') {
  let removedFrom = [];
  
  Object.keys(lobbies).forEach(lobbyId => {
    const lobby = lobbies[lobbyId];
    let wasRemoved = false;
    
    // Check in players
    const playerIndex = lobby.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) {
      const player = lobby.players[playerIndex];
      
      // Mark as removed (no grace period for manual exit)
      player.removed = true;
      player.lastDisconnectTime = null;
      player.graceExpiresAt = null;
      
      // Notify the player if connected
      if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        try {
          player.ws.send(JSON.stringify({ 
            type: 'lobbyClosed', 
            message: reason 
          }));
        } catch (err) {
          // Ignore send errors
        }
      }
      
      lobby.players.splice(playerIndex, 1);
      wasRemoved = true;
      
      // Remove from restartReady if present
      const restartReadyIndex = lobby.restartReady.indexOf(playerId);
      if (restartReadyIndex !== -1) {
        lobby.restartReady.splice(restartReadyIndex, 1);
      }
      
      // If the player was the owner, assign a new owner
      if (lobby.owner === playerId) {
        const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
        if (newOwner) {
          lobby.owner = newOwner.id;
          const hostPlayer = lobby.players.find(p => p.id === lobby.owner);
          if (hostPlayer) {
            lobby.hostName = hostPlayer.name;
          }
        } else if (lobby.players.length > 0) {
          lobby.owner = lobby.players[0].id;
          const hostPlayer = lobby.players.find(p => p.id === lobby.owner);
          if (hostPlayer) {
            lobby.hostName = hostPlayer.name;
          }
        }
      }
    }
    
    // Check in spectators
    const spectatorIndex = lobby.spectators.findIndex(s => s.id === playerId);
    if (spectatorIndex !== -1) {
      const spectator = lobby.spectators[spectatorIndex];
      
      // Mark as removed
      spectator.removed = true;
      spectator.lastDisconnectTime = null;
      spectator.graceExpiresAt = null;
      
      // Notify the spectator if connected
      if (spectator.ws && spectator.ws.readyState === WebSocket.OPEN) {
        try {
          spectator.ws.send(JSON.stringify({ 
            type: 'lobbyClosed', 
            message: reason 
          }));
        } catch (err) {
          // Ignore send errors
        }
      }
      
      lobby.spectators.splice(spectatorIndex, 1);
      
      // Remove from spectatorsWantingToJoin if present
      const wantingIndex = lobby.spectatorsWantingToJoin.indexOf(playerId);
      if (wantingIndex !== -1) {
        lobby.spectatorsWantingToJoin.splice(wantingIndex, 1);
      }
      
      wasRemoved = true;
    }
    
    // Clean up empty lobbies
    if (wasRemoved) {
      removedFrom.push(lobbyId);
      
      // Only send restart updates if game is in results phase
      if ((lobby.restartReady.length > 0 || lobby.spectatorsWantingToJoin.length > 0) && 
          (lobby.phase === 'results' || lobby.phase === 'lobby')) {
        sendRestartUpdates(lobby);
      }
      
      // Delete empty lobbies immediately ONLY during waiting phase (lobby phase)
      if (lobby.players.length === 0 && lobby.spectators.length === 0) {
        if (lobby.phase === 'lobby') {
          console.log(`Deleting empty lobby in waiting phase: ${lobbyId}`);
          
          if (lobby.turnTimeout?.timer) {
            clearTimeout(lobby.turnTimeout.timer);
          }
          
          if (lobby.impostorGuessTimeout?.timer) {
            clearTimeout(lobby.impostorGuessTimeout.timer);
          }
          
          delete lobbies[lobbyId];
        } else {
          // Game is in progress - don't delete immediately, let cleanup handle it
          console.log(`Lobby ${lobbyId} is empty but game is in progress (phase: ${lobby.phase}). Keeping for grace period.`);
        }
      } else {
        // Broadcast updated lobby state
        broadcast(lobby, { 
          type: 'lobbyUpdate', 
          players: lobby.players.map(p => ({ 
            id: p.id, 
            name: p.name, 
            connected: p.ws?.readyState === 1,
            role: p.role || null
          })),
          spectators: lobby.spectators.map(s => ({ 
            id: s.id, 
            name: s.name, 
            connected: s.ws?.readyState === 1 
          })),
          owner: lobby.owner,
          phase: lobby.phase,
          impostorGuessOption: lobby.impostorGuessOption || false,
          twoImpostorsOption: lobby.twoImpostorsOption || false
        });
      }
    }
  });
  
  if (removedFrom.length > 0) {
    console.log(`Player ${playerId} removed from lobbies: ${removedFrom.join(', ')}`);
    broadcastLobbyList();
  }
  
  return removedFrom.length > 0;
}

// Function to check if a name is already taken in a lobby (case-insensitive)
function isNameTakenInLobby(lobby, nameToCheck, excludePlayerId = null) {
  const allNames = [
    ...lobby.players.map(p => ({ name: p.name, id: p.id })),
    ...lobby.spectators.map(s => ({ name: s.name, id: s.id }))
  ];
  
  return allNames.some(p => 
    p.name.toLowerCase() === nameToCheck.toLowerCase() && 
    p.id !== excludePlayerId
  );
}

// Enhanced input sanitization
function sanitizeInput(input, maxLength = 50) {
  if (typeof input !== 'string') return '';
  
  // Remove any HTML/script tags and limit length
  return input
    .replace(/<[^>]*>?/gm, '')
    .replace(/[<>]/g, '')
    .substring(0, maxLength)
    .trim();
}

// SIMPLE: True random word selection with no repeats until all used
function getRandomWord(lobby) {
  if (!lobby.availableWords || lobby.availableWords.length === 0) {
    lobby.availableWords = [...words];
    lobby.usedWords = [];
    
    // Shuffle the words
    for (let i = lobby.availableWords.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [lobby.availableWords[i], lobby.availableWords[j]] = [lobby.availableWords[j], lobby.availableWords[i]];
    }
    
    console.log(`Initialized word pool for lobby: ${lobby.availableWords.length} words`);
  }
  
  const randomIndex = crypto.randomInt(lobby.availableWords.length);
  const selectedWord = lobby.availableWords[randomIndex];
  
  lobby.availableWords.splice(randomIndex, 1);
  lobby.usedWords.push(selectedWord);
  
  // Limit usedWords array to prevent memory issues (keep last 100)
  if (lobby.usedWords.length > 100) {
    lobby.usedWords = lobby.usedWords.slice(-100);
  }
  
  console.log(`Selected word: "${selectedWord.word}", ${lobby.availableWords.length} remaining, ${lobby.usedWords.length} used`);
  
  return selectedWord;
}

function makeNameUnique(baseName, existingNames, id) {
  const lowerNames = existingNames.map(n => n.toLowerCase());
  const baseLower = baseName.toLowerCase();
  
  if (!lowerNames.includes(baseLower)) {
    return baseName;
  }
  
  let suffix = 1;
  let newName = `${baseName} (${suffix})`;
  
  while (lowerNames.includes(newName.toLowerCase())) {
    suffix++;
    newName = `${baseName} (${suffix})`;
  }
  
  console.log(`Duplicate name detected: ${baseName} -> ${newName} for player ${id}`);
  return newName;
}

function replaceSocket(player, newWs) {
  if (player.ws && player.ws !== newWs && player.ws.readyState === 1) {
    try {
      player.ws.onmessage = null;
      player.ws.onclose = null;
      player.ws.onerror = null;
      player.ws.close(4001, 'Replaced by new connection');
    } catch (err) {
      // Ignore close errors
    }
  }
  player.ws = newWs;
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

// Get players who are still in the game (not removed and grace not expired)
function getPlayersInGame(lobby) {
  const now = Date.now();
  const result = lobby.players.filter(p => {
    // Must have a role (is playing)
    if (!p.role) {
      console.log(`  ${p.name}: No role, excluded`);
      return false;
    }
    
    // If explicitly removed, not in game
    if (p.removed) {
      console.log(`  ${p.name}: Removed, excluded`);
      return false;
    }
    
    // If connected, definitely in game
    if (p.ws?.readyState === 1) {
      console.log(`  ${p.name}: Connected, included`);
      return true;
    }
    
    // If disconnected but within grace period, still in game
    if (p.lastDisconnectTime && (now - p.lastDisconnectTime <= GAME_GRACE_PERIOD)) {
      const timeDisconnected = Math.ceil((now - p.lastDisconnectTime) / 1000);
      console.log(`  ${p.name}: Disconnected for ${timeDisconnected}s (grace ${GAME_GRACE_PERIOD/1000}s), included`);
      return true;
    }
    
    // Grace expired or no disconnect time recorded
    console.log(`  ${p.name}: Grace expired or no disconnect time, excluded`);
    return false;
  });
  
  console.log(`getPlayersInGame: ${result.length}/${lobby.players.length} total players`);
  return result;
}

function checkGameEndConditions(lobby, lobbyId) {
  // Don't check during lobby, results, or impostor guess phases
  if (lobby.phase === 'lobby' || lobby.phase === 'results' || lobby.phase === 'impostorGuess') {
    return false;
  }
  
  const playersInGame = getPlayersInGame(lobby);
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  
  // Check if impostor left AND we don't have an impostor
  const impostors = lobby.players.filter(p => p.role === 'impostor');
  const connectedImpostors = impostors.filter(p => p.ws?.readyState === 1);
  
  // Check if we have at least one impostor connected (required for game to continue)
  if (connectedImpostors.length === 0) {
    const now = Date.now();
    
    const disconnectedImpostors = impostors.filter(p => p.ws?.readyState !== 1 && !p.lastDisconnectTime);
    if (disconnectedImpostors.length > 0) {
      disconnectedImpostors.forEach(impostor => {
        impostor.lastDisconnectTime = now;
      });
      console.log(`Impostor(s) disconnected in lobby ${lobbyId}, starting ${GAME_GRACE_PERIOD/1000}s grace period`);
      return false;
    }
    
    const longDisconnectedImpostors = impostors.filter(p => 
      p.ws?.readyState !== 1 && p.lastDisconnectTime && (now - p.lastDisconnectTime > GAME_GRACE_PERIOD)
    );
    
    if (longDisconnectedImpostors.length > 0) {
      console.log(`Game in lobby ${lobbyId} ending: no impostors connected for >${GAME_GRACE_PERIOD/1000}s`);
      endGameEarly(lobby, 'impostor_left');
      return true;
    }
    
    const earliestDisconnectTime = Math.min(...impostors
      .filter(p => p.lastDisconnectTime)
      .map(p => p.lastDisconnectTime));
    const secondsRemaining = Math.ceil((GAME_GRACE_PERIOD - (now - earliestDisconnectTime)) / 1000);
    console.log(`Impostor(s) disconnected for ${GAME_GRACE_PERIOD/1000 - secondsRemaining}s, ${secondsRemaining}s remaining`);
    return false;
  } else {
    impostors.forEach(p => p.lastDisconnectTime = null);
  }
  
  // Check if we have less than 3 connected players OR less than 3 players with an impostor
  if (connectedPlayers.length < 3) {
    const now = Date.now();
    
    if (!lobby.lastTimeBelowThreePlayers) {
      lobby.lastTimeBelowThreePlayers = now;
      console.log(`Game in lobby ${lobbyId} now has ${connectedPlayers.length} players, starting ${GAME_GRACE_PERIOD/1000}s grace period`);
      return false;
    }
    
    if (now - lobby.lastTimeBelowThreePlayers > GAME_GRACE_PERIOD) {
      console.log(`Game in lobby ${lobbyId} ending: less than 3 players for ${GAME_GRACE_PERIOD/1000}+ seconds (${connectedPlayers.length})`);
      endGameEarly(lobby, 'not_enough_players');
      return true;
    }
    
    const secondsRemaining = Math.ceil((GAME_GRACE_PERIOD - (now - lobby.lastTimeBelowThreePlayers)) / 1000);
    console.log(`Game in lobby ${lobbyId} has ${connectedPlayers.length} players, ${secondsRemaining}s remaining`);
    return false;
  } else {
    lobby.lastTimeBelowThreePlayers = null;
  }
  
  // If we have at least 3 connected players and at least one impostor is present, game can continue
  if (connectedPlayers.length >= 3 && connectedImpostors.length > 0) {
    return false; // Game can continue
  }
  
  return false;
}

function endGameEarly(lobby, reason) {
  if (lobby.turnTimeout?.timer) {
    clearTimeout(lobby.turnTimeout.timer);
    lobby.turnTimeout = null;
  }
  
  if (lobby.impostorGuessTimeout?.timer) {
    clearTimeout(lobby.impostorGuessTimeout.timer);
    lobby.impostorGuessTimeout = null;
  }
  
  const winner = 'Game Ended Early';
  
  broadcast(lobby, {
    type: 'gameEndEarly',
    roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
    secretWord: lobby.word,
    hint: lobby.hint,
    winner,
    reason
  });
  
  // Send individual messages to spectators with their join state
  lobby.spectators.forEach(s => {
    if (s.ws?.readyState === 1) {
      try {
        s.ws.send(JSON.stringify({
          type: 'gameEndEarly',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          secretWord: lobby.word,
          hint: lobby.hint,
          winner,
          reason,
          isSpectator: true,
          wantsToJoinNextGame: s.wantsToJoinNextGame || false
        }));
      } catch (err) {
        console.log(`Failed to send gameEndEarly to spectator ${s.name}`);
      }
    }
  });
  
  lobby.phase = 'results';
  lobby.lastTimeBelowThreePlayers = null;
  lobby.ejectedPlayers = null;
  lobby.impostorGuesses = null;
  
  // Send restart updates so spectators see their current join state
  sendRestartUpdates(lobby);
  broadcastLobbyList();
}

function startGame(lobby) {
  lobby.players.forEach(p => {
    p.role = null;
    p.vote = [];
    p.lastDisconnectTime = null;
    p.removed = false;
    p.graceExpiresAt = null;
    p.submittedWord = false;
  });
  
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  if (connectedPlayers.length < 3) {
    console.log(`Not enough connected players to start (${connectedPlayers.length} connected)`);
    return;
  }

  lobby.phase = 'round1';
  lobby.turn = 0;
  lobby.round1 = [];
  lobby.round2 = [];
  
  // Clear restartReady completely when starting a new game
  lobby.restartReady = [];
  
  lobby.turnTimeout = null;
  lobby.impostorGuessTimeout = null;
  lobby.lastTimeBelowThreePlayers = null;
  lobby.ejectedPlayers = null;
  lobby.impostorGuesses = null;
  
  const { word, hint } = getRandomWord(lobby);
  lobby.word = word;
  lobby.hint = hint;

  const shuffledConnectedPlayers = [...connectedPlayers].sort(() => Math.random() - 0.5);
  
  // Reset votes for all players
  lobby.players.forEach(p => {
    p.vote = [];
    p.lastDisconnectTime = null;
    p.removed = false;
    p.submittedWord = false;
  });
  
  // Assign roles - only assign to players who don't already have roles
  // This preserves roles for reconnecting players
  const playersWithoutRoles = lobby.players.filter(p => !p.role && p.ws?.readyState === 1);
  
  if (lobby.twoImpostorsOption && connectedPlayers.length >= 4) {
    // Assign 2 impostors
    const impostorIndices = new Set();
    while (impostorIndices.size < 2) {
      impostorIndices.add(Math.floor(Math.random() * connectedPlayers.length));
    }
    
    connectedPlayers.forEach((player, i) => {
      player.role = impostorIndices.has(i) ? 'impostor' : 'civilian';
    });
  } else {
    // Assign 1 impostor
    const impostorIndex = Math.floor(Math.random() * connectedPlayers.length);
    connectedPlayers.forEach((player, i) => {
      player.role = i === impostorIndex ? 'impostor' : 'civilian';
    });
  }
  
  // Send game start to all players
  lobby.players.forEach(player => {
    if (player.ws?.readyState === 1) {
      try {
        const wordToSend = player.role === 'civilian' ? word : 
                          player.role === 'impostor' ? hint : 
                          word;
        
        player.ws.send(JSON.stringify({
          type: 'gameStart',
          role: player.role,
          word: wordToSend,
          playerName: player.name
        }));
      } catch (err) {
        console.log(`Failed to send gameStart to ${player.name}`);
      }
    }
  });

  // Send game state to spectators
  lobby.spectators.forEach(s => {
    if (s.ws?.readyState === 1) {
      try {
        s.ws.send(JSON.stringify({
          type: 'gameStart',
          role: 'spectator',
          word: word,
          hint: hint,
          isSpectator: true,
          playerName: s.name,
          wantsToJoinNextGame: s.wantsToJoinNextGame || false
        }));
        
        // Also send restart update to preserve join state display
        if (s.wantsToJoinNextGame) {
          setTimeout(() => {
            try {
              const playersInGame = getPlayersInGame(lobby);
              const readyConnectedPlayers = lobby.restartReady.filter(id => 
                lobby.players.some(p => p.id === id && p.ws?.readyState === 1)
              );
              
              s.ws.send(JSON.stringify({
                type: 'restartUpdate',
                readyCount: readyConnectedPlayers.length,
                totalPlayers: playersInGame.length,
                spectatorsWantingToJoin: lobby.spectatorsWantingToJoin.length,
                isSpectator: true,
                wantsToJoin: true,
                status: 'joining'
              }));
            } catch (err) {
              console.log(`Failed to send restart update to spectator ${s.name} during game start`);
            }
          }, 300);
        }
      } catch (err) {
        console.log(`Failed to send gameStart to spectator ${s.name}`);
      }
    }
  });

  // Find first connected player for turn
  let firstConnectedIndex = 0;
  for (let i = 0; i < lobby.players.length; i++) {
    if (lobby.players[i].ws?.readyState === 1) {
      firstConnectedIndex = i;
      break;
    }
  }
  lobby.turn = firstConnectedIndex;
  
  startTurnTimer(lobby);
  
  broadcastLobbyList();
}

// Store turnEndsAt once per turn
function setTurnEndTime(lobby) {
  lobby.turnEndsAt = Date.now() + 30000;
}

function startTurnTimer(lobby) {
  if (lobby.turnTimeout?.timer) {
    clearTimeout(lobby.turnTimeout.timer);
    lobby.turnTimeout = null;
  }
  
  if (lobby.phase !== 'round1' && lobby.phase !== 'round2') return;
  
  const currentPlayer = lobby.players[lobby.turn];
  if (!currentPlayer) return;
  
  const turnStartTime = Date.now();
  lobby.turnEndsAt = turnStartTime + 30000;
  
  lobby.turnTimeout = {
    playerId: currentPlayer.id,
    timer: setTimeout(() => {
      console.log(`Turn timeout for player ${currentPlayer.name}`);
      
      // Check if it's still this player's turn (they might have submitted)
      if (lobby.players[lobby.turn]?.id === currentPlayer.id) {
        skipCurrentPlayer(lobby, true);
      }
    }, 30000)
  };
  
  broadcast(lobby, {
    type: 'turnUpdate',
    phase: lobby.phase,
    round1: lobby.round1,
    round2: lobby.round2,
    currentPlayer: currentPlayer.name,
    turnEndsAt: lobby.turnEndsAt
  });
}

function skipCurrentPlayer(lobby, isTimeout = false) {
  console.log(`Skipping player ${lobby.players[lobby.turn]?.name}, timeout: ${isTimeout}`);
  
  const currentPlayer = lobby.players[lobby.turn];
  
  if (isTimeout && currentPlayer) {
    const entry = { name: currentPlayer.name, word: '' };
    
    if (lobby.phase === 'round1') {
      lobby.round1.push(entry);
    } else if (lobby.phase === 'round2') {
      lobby.round2.push(entry);
    }
    
    broadcast(lobby, {
      type: 'turnUpdate',
      phase: lobby.phase,
      round1: lobby.round1,
      round2: lobby.round2,
      currentPlayer: currentPlayer.name,
      timeoutOccurred: true,
      turnEndsAt: lobby.turnEndsAt
    });
  }
  
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
    // Check if we should end the game early
    const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
    if (connectedPlayers.length === 0) {
      console.log('All players disconnected during turn, ending game early');
      endGameEarly(lobby, 'all_players_disconnected');
    }
    return;
  }
  
  // FIX: Use players who are still in the game (not removed and grace not expired)
  const playersInGame = getPlayersInGame(lobby);
  
  if (lobby.phase === 'round1') {
    if (lobby.round1.length >= playersInGame.length) {
      lobby.phase = 'round2';
      lobby.turn = 0;
      for (let i = 0; i < lobby.players.length; i++) {
        if (lobby.players[i]?.ws?.readyState === 1) {
          lobby.turn = i;
          break;
        }
      }
      
      broadcast(lobby, {
        type: 'turnUpdate',
        phase: 'round1',
        round1: lobby.round1,
        round2: lobby.round2,
        currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
        turnEndsAt: lobby.turnEndsAt
      });
      
      startTurnTimer(lobby);
      return;
    }
  } else if (lobby.phase === 'round2') {
    if (lobby.round2.length >= playersInGame.length) {
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
          players: lobby.players.map(p => p.name),
          twoImpostorsMode: lobby.twoImpostorsOption || false
        });
      }, 500);
      return;
    }
  }
  
  startTurnTimer(lobby);
}

function startImpostorGuessTimer(lobby) {
  if (lobby.impostorGuessTimeout?.timer) {
    clearTimeout(lobby.impostorGuessTimeout.timer);
    lobby.impostorGuessTimeout = null;
  }
  
  lobby.impostorGuessEndsAt = Date.now() + 30000;
  
  lobby.impostorGuessTimeout = {
    timer: setTimeout(() => {
      console.log(`Impostor guess timeout in lobby`);
      
      const impostors = lobby.players.filter(p => p.role === 'impostor');
      const ejectedImpostors = lobby.ejectedPlayers ? 
        impostors.filter(p => lobby.ejectedPlayers.includes(p.name)) : [];
      
      // Check if any guesses were made
      let anyCorrect = false;
      if (lobby.impostorGuesses) {
        for (const guessData of Object.values(lobby.impostorGuesses)) {
          if (guessData.guess === lobby.word.toLowerCase()) {
            anyCorrect = true;
            break;
          }
        }
      }
      
      let winner;
      if (anyCorrect) {
        winner = 'Impostors';
      } else {
        const remainingImpostors = impostors.filter(p => 
          !ejectedImpostors.some(e => e.id === p.id)
        );
        winner = (lobby.twoImpostorsOption && remainingImpostors.length > 0) ? 'Draw' : 'Civilians';
      }
      
      broadcast(lobby, {
        type: 'gameEnd',
        roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
        votes: Object.fromEntries(lobby.players.filter(p => p.vote).map(p => [p.name, p.vote])),
        secretWord: lobby.word,
        hint: lobby.hint,
        winner,
        reason: 'impostorGuessTimeout',
        impostorGuesses: lobby.impostorGuesses || {},
        twoImpostorsMode: lobby.twoImpostorsOption || false
      });
      
      // Send individual messages to spectators with their join state
      lobby.spectators.forEach(s => {
        if (s.ws?.readyState === 1) {
          try {
            s.ws.send(JSON.stringify({
              type: 'gameEnd',
              roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
              votes: Object.fromEntries(lobby.players.filter(p => p.vote).map(p => [p.name, p.vote])),
              secretWord: lobby.word,
              hint: lobby.hint,
              winner,
              reason: 'impostorGuessTimeout',
              impostorGuesses: lobby.impostorGuesses || {},
              twoImpostorsMode: lobby.twoImpostorsOption || false,
              isSpectator: true,
              wantsToJoinNextGame: s.wantsToJoinNextGame || false
            }));
          } catch (err) {
            console.log(`Failed to send gameEnd (timeout) to spectator ${s.name}`);
          }
        }
      });
      
      lobby.phase = 'results';
      lobby.lastTimeBelowThreePlayers = null;
      lobby.turnEndsAt = null;
      lobby.impostorGuessTimeout = null;
      lobby.impostorGuesses = null;
      lobby.ejectedPlayers = null;
      
      // Send restart updates so spectators see their current join state
      sendRestartUpdates(lobby);
      broadcastLobbyList();
    }, 30000)
  };
}

function cleanupLobby(lobby, lobbyId) {
  const now = Date.now();
  let hasChanges = false;
  let restartStateChanged = false;
  
  // Determine grace period based on phase
  let playerGracePeriod, spectatorGracePeriod;
  if (lobby.phase === 'lobby') {
    playerGracePeriod = LOBBY_GRACE_PERIOD;
    spectatorGracePeriod = LOBBY_GRACE_PERIOD;
  } else if (lobby.phase === 'results') {
    playerGracePeriod = RESULTS_GRACE_PERIOD;
    spectatorGracePeriod = RESULTS_GRACE_PERIOD;
  } else {
    playerGracePeriod = GAME_GRACE_PERIOD;
    spectatorGracePeriod = GAME_GRACE_PERIOD;
  }
  
  // Clean up players
  lobby.players = lobby.players.filter(p => {
    // If connected, keep
    if (p.ws?.readyState === 1) return true;
    
    // If manually removed, remove immediately
    if (p.removed) {
      console.log(`Removing manually removed player: ${p.name}`);
      hasChanges = true;
      
      const restartIndex = lobby.restartReady.indexOf(p.id);
      if (restartIndex !== -1) {
        lobby.restartReady.splice(restartIndex, 1);
        restartStateChanged = true;
      }
      return false;
    }
    
    // Check grace period
    if (p.lastDisconnectTime && now - p.lastDisconnectTime > playerGracePeriod) {
      console.log(`Removing disconnected player after ${playerGracePeriod/1000}s: ${p.name}`);
      hasChanges = true;
      p.removed = true;
      
      const restartIndex = lobby.restartReady.indexOf(p.id);
      if (restartIndex !== -1) {
        lobby.restartReady.splice(restartIndex, 1);
        restartStateChanged = true;
      }
      return false;
    }
    return true;
  });
  
  // Clean up spectators
  lobby.spectators = lobby.spectators.filter(s => {
    // If connected, keep
    if (s.ws?.readyState === 1) return true;
    
    // If manually removed, remove immediately
    if (s.removed) {
      console.log(`Removing manually removed spectator: ${s.name}`);
      hasChanges = true;
      
      const wantingIndex = lobby.spectatorsWantingToJoin.indexOf(s.id);
      if (wantingIndex !== -1) {
        lobby.spectatorsWantingToJoin.splice(wantingIndex, 1);
        restartStateChanged = true;
      }
      return false;
    }
    
    // Check grace period
    if (s.lastDisconnectTime && now - s.lastDisconnectTime > spectatorGracePeriod) {
      console.log(`Removing disconnected spectator after ${spectatorGracePeriod/1000}s: ${s.name}`);
      hasChanges = true;
      s.removed = true;
      
      const wantingIndex = lobby.spectatorsWantingToJoin.indexOf(s.id);
      if (wantingIndex !== -1) {
        lobby.spectatorsWantingToJoin.splice(wantingIndex, 1);
        restartStateChanged = true;
      }
      return false;
    }
    return true;
  });
  
  // DELETE EMPTY LOBBIES with grace period logic
  if (lobby.players.length === 0 && lobby.spectators.length === 0) {
    if (lobby.phase === 'lobby') {
      // Immediate deletion for empty lobbies in waiting phase
      console.log(`Deleting empty lobby in waiting phase: ${lobbyId}`);
      if (lobby.turnTimeout?.timer) {
        clearTimeout(lobby.turnTimeout.timer);
      }
      if (lobby.impostorGuessTimeout?.timer) {
        clearTimeout(lobby.impostorGuessTimeout.timer);
      }
      delete lobbies[lobbyId];
      broadcastLobbyList();
      return;
    } else {
      // Game is in progress - keep the lobby for potential reconnection
      console.log(`Lobby ${lobbyId} is empty but game is in progress (phase: ${lobby.phase}). Keeping lobby.`);
      
      // Check if we should start a grace period
      if (!lobby.emptyLobbyGracePeriodStart) {
        lobby.emptyLobbyGracePeriodStart = now;
        console.log(`Starting ${LOBBY_GRACE_PERIOD/1000}s grace period for empty lobby ${lobbyId}`);
      } else if (now - lobby.emptyLobbyGracePeriodStart > LOBBY_GRACE_PERIOD) {
        // Grace period expired - delete the lobby
        console.log(`Grace period expired for empty lobby ${lobbyId}, deleting`);
        if (lobby.turnTimeout?.timer) {
          clearTimeout(lobby.turnTimeout.timer);
        }
        if (lobby.impostorGuessTimeout?.timer) {
          clearTimeout(lobby.impostorGuessTimeout.timer);
        }
        delete lobbies[lobbyId];
        broadcastLobbyList();
        return;
      }
      // Continue with cleanup but don't delete yet
    }
  } else {
    // Lobby is not empty, reset grace period
    lobby.emptyLobbyGracePeriodStart = null;
  }
  
  // Only check game end conditions during active game phases
  if (lobby.phase !== 'lobby' && lobby.phase !== 'results' && lobby.phase !== 'impostorGuess') {
    checkGameEndConditions(lobby, lobbyId);
  }
  
  // Only send restart updates during results or lobby phase
  if (restartStateChanged && (lobby.phase === 'results' || lobby.phase === 'lobby')) {
    sendRestartUpdates(lobby);
  }
  
  if (hasChanges) {
    broadcast(lobby, { 
      type: 'lobbyUpdate', 
      players: lobby.players.map(p => ({ 
        id: p.id, 
        name: p.name, 
        connected: p.ws?.readyState === 1,
        role: p.role || null
      })),
      spectators: lobby.spectators.map(s => ({ 
        id: s.id, 
        name: s.name, 
        connected: s.ws?.readyState === 1 
      })),
      owner: lobby.owner,
      phase: lobby.phase,
      impostorGuessOption: lobby.impostorGuessOption || false,
      twoImpostorsOption: lobby.twoImpostorsOption || false
    });
    
    broadcastLobbyList();
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
      try {
        ws.terminate();
      } catch (err) {
        // Ignore terminate errors
      }
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (err) {
      // Connection already closed
    }
  });
}, 30000);

// Clean up connection rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, info] of connectionRateLimit.entries()) {
    if (now > info.resetTime) {
      connectionRateLimit.delete(ip);
    }
  }
}, 60000);

wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`New connection from: ${clientIP}`);
  
  // Rate limiting check
  if (!checkRateLimit(clientIP.split(',')[0].trim())) {
    console.log(`Rate limit exceeded for IP: ${clientIP}`);
    ws.close(1008, 'Rate limit exceeded');
    return;
  }
  
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  try {
    ws.send(JSON.stringify({ 
      type: 'serverHello', 
      serverId: SERVER_ID 
    }));
  } catch (err) {
    console.log('Failed to send serverHello');
  }

  let lobbyId = null;
  let player = null;
  let connectionId = crypto.randomUUID();
  
  ws.inLobby = false;

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
      
      // Basic message validation
      if (!msg || typeof msg !== 'object' || !msg.type) {
        console.log('Invalid message format received');
        return;
      }
      
      ws.isAlive = true;

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'disconnecting') {
        console.log(`Client ${connectionId} disconnecting gracefully`);
        return;
      }

      if (msg.type === 'getLobbyList') {
        const lobbyList = Object.entries(lobbies).map(([id, lobby]) => ({
          id,
          host: lobby.hostName || 'Unknown',
          playerCount: lobby.players.filter(p => p.ws?.readyState === 1).length,
          spectatorCount: lobby.spectators.filter(s => s.ws?.readyState === 1).length,
          maxPlayers: 15,
          phase: lobby.phase,
          createdAt: lobby.createdAt,
          impostorGuessOption: lobby.impostorGuessOption || false,
          twoImpostorsOption: lobby.twoImpostorsOption || false
        }));
        
        try {
          ws.send(JSON.stringify({
            type: 'lobbyList',
            lobbies: lobbyList
          }));
        } catch (err) {
          console.log('Failed to send lobby list');
        }
        return;
      }

      if (player && ws.connectionEpoch !== player.connectionEpoch) {
        console.log(`Ignoring message from stale socket for player ${player.name}`);
        return;
      }

      if (msg.type === 'joinLobby') {
        if (!msg.playerId || typeof msg.playerId !== 'string') {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Invalid player ID' 
          }));
          return;
        }
        
        lobbyId = msg.lobbyId || Math.floor(1000 + Math.random() * 9000).toString();
        
        // Check if player is trying to rejoin a lobby they're already in
        let existingLobbyForPlayer = null;
        let existingPlayerInLobby = null;
        
        Object.keys(lobbies).forEach(id => {
          const lobby = lobbies[id];
          const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
          if (existingPlayer) {
            existingLobbyForPlayer = id;
            existingPlayerInLobby = existingPlayer;
          }
        });
        
        // If player is already in another lobby, remove them from it
        if (existingLobbyForPlayer && existingLobbyForPlayer !== lobbyId) {
          console.log(`Player ${msg.playerId} is already in lobby ${existingLobbyForPlayer}, removing them`);
          removePlayerFromAllLobbies(msg.playerId, 'Joined another lobby');
        }
        
        // If creating a new lobby (no lobbyId provided), check for existing lobby by same host
        if (!msg.lobbyId) {
          console.log(`Player ${msg.playerId} creating new lobby ${lobbyId}`);
        }
        
        if (!lobbies[lobbyId]) {
          lobbies[lobbyId] = { 
            players: [], 
            spectators: [],
            phase: 'lobby', 
            owner: msg.playerId,
            hostName: null,
            createdAt: Date.now(),
            turnTimeout: null,
            impostorGuessTimeout: null,
            turnEndsAt: null,
            impostorGuessEndsAt: null,
            restartReady: [],
            spectatorsWantingToJoin: [],
            lastTimeBelowThreePlayers: null,
            emptyLobbyGracePeriodStart: null,
            availableWords: null,
            usedWords: [],
            impostorGuessOption: false,
            twoImpostorsOption: false,
            ejectedPlayers: null,
            impostorGuesses: null
          }; 
          console.log(`Created new lobby: ${lobbyId} for player ${msg.playerId}`);
          
          broadcastLobbyList();
        }
        
        const lobby = lobbies[lobbyId];

        // Check if player already exists in this lobby
        const existingPlayerInThisLobby = lobby.players.find(p => p.id === msg.playerId);
        const existingSpectatorInThisLobby = lobby.spectators.find(s => s.id === msg.playerId);
        
        // If player exists as a spectator, reconnect them as spectator
        if (existingSpectatorInThisLobby) {
          console.log(`Player ${msg.playerId} reconnecting as spectator to lobby ${lobbyId}`);
          return handleSpectatorJoin(ws, msg, lobbyId, connectionId);
        }
        
        // If player exists as a player, reconnect them as player
        if (existingPlayerInThisLobby) {
          console.log(`Player ${msg.playerId} reconnecting as player to lobby ${lobbyId}`);
          return handlePlayerJoin(ws, msg, lobbyId, connectionId);
        }
        
        // New player joining
        // Allow joining during lobby or results phase
        if (lobby.phase === 'lobby' || lobby.phase === 'results') {
          console.log(`New player ${msg.playerId} joining lobby ${lobbyId} (phase: ${lobby.phase})`);
          return handlePlayerJoin(ws, msg, lobbyId, connectionId);
        } else {
          // Game is active - join as spectator
          console.log(`New player ${msg.playerId} joining active game in lobby ${lobbyId} as spectator (phase: ${lobby.phase})`);
          return handleSpectatorJoin(ws, msg, lobbyId, connectionId);
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
        
        removePlayerFromAllLobbies(msg.playerId, 'Joined as spectator in another lobby');
        
        return handleSpectatorJoin(ws, msg, msg.lobbyId, connectionId);
      }

      if (msg.type === 'exitLobby') {
        if (lobbyId && lobbies[lobbyId] && player) {
          const lobby = lobbies[lobbyId];
          console.log(`Player ${player.name} exiting lobby ${lobbyId}`);
          
          const wasGameInProgress = (lobby.phase !== 'lobby' && lobby.phase !== 'results');
          
          // Check if exiting player is an impostor or if this will cause <3 players
          let shouldEndGameImmediately = false;
          let endGameReason = '';
          
          if (wasGameInProgress && !player.isSpectator) {
            const connectedPlayersBeforeExit = lobby.players.filter(p => p.ws?.readyState === 1).length;
            const connectedPlayersAfterExit = connectedPlayersBeforeExit - 1;
            
            // If player is impostor, end game immediately (no grace period for manual exit)
            if (player.role === 'impostor') {
              shouldEndGameImmediately = true;
              endGameReason = 'impostor_left';
            }
            // If after exit fewer than 3 players remain, end game immediately
            else if (connectedPlayersAfterExit < 3) {
              shouldEndGameImmediately = true;
              endGameReason = 'not_enough_players';
            }
          }
          
          if (player.isSpectator) {
            // Mark spectator as removed (manual exit, no grace)
            player.removed = true;
            lobby.spectators = lobby.spectators.filter(s => s.id !== player.id);
            lobby.spectatorsWantingToJoin = lobby.spectatorsWantingToJoin.filter(id => id !== player.id);
          } else {
            // Mark player as removed (manual exit, no grace)
            player.removed = true;
            lobby.players = lobby.players.filter(p => p.id !== player.id);
            lobby.restartReady = lobby.restartReady.filter(id => id !== player.id);
            
            if (lobby.owner === player.id && lobby.players.length > 0) {
              const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
              if (newOwner) {
                lobby.owner = newOwner.id;
                const hostPlayer = lobby.players.find(p => p.id === lobby.owner);
                if (hostPlayer) {
                  lobby.hostName = hostPlayer.name;
                }
              } else if (lobby.players.length > 0) {
                lobby.owner = lobby.players[0].id;
                const hostPlayer = lobby.players.find(p => p.id === lobby.owner);
                if (hostPlayer) {
                  lobby.hostName = hostPlayer.name;
                }
              }
            }
          }
          
          // End game immediately if conditions are met (no grace period for manual exit)
          if (shouldEndGameImmediately && lobby.phase !== 'results' && lobby.phase !== 'lobby') {
            console.log(`Game ending immediately due to player exit: ${endGameReason}`);
            endGameEarly(lobby, endGameReason);
          } else if (wasGameInProgress && !shouldEndGameImmediately) {
            // Check game conditions but with immediate check (no grace period for manual exit)
            const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
            const connectedImpostors = connectedPlayers.filter(p => p.role === 'impostor');
            
            // Immediate check: if less than 3 players or no impostor, end game immediately
            if (connectedPlayers.length < 3 || connectedImpostors.length === 0) {
              console.log(`Game ending immediately after manual exit: ${connectedPlayers.length} players, ${connectedImpostors.length} impostors`);
              endGameEarly(lobby, connectedPlayers.length < 3 ? 'not_enough_players' : 'impostor_left');
            }
          }
          
          // Only send restart updates during results phase
          if ((lobby.restartReady.length > 0 || lobby.spectatorsWantingToJoin.length > 0) && 
              (lobby.phase === 'results' || lobby.phase === 'lobby')) {
            sendRestartUpdates(lobby);
          }
          
          // Check if lobby is now empty and delete it (only if in lobby phase)
          if (lobby.players.length === 0 && lobby.spectators.length === 0) {
            if (lobby.phase === 'lobby') {
              console.log(`Deleting empty lobby: ${lobbyId}`);
              if (lobby.turnTimeout?.timer) {
                clearTimeout(lobby.turnTimeout.timer);
              }
              if (lobby.impostorGuessTimeout?.timer) {
                clearTimeout(lobby.impostorGuessTimeout.timer);
              }
              delete lobbies[lobbyId];
            } else {
              console.log(`Lobby ${lobbyId} is empty but game is in progress (phase: ${lobby.phase}). Keeping for grace period.`);
            }
          } else if (!shouldEndGameImmediately && wasGameInProgress) {
            // Check game end conditions (this will apply grace period for disconnections, not manual exits)
            checkGameEndConditions(lobby, lobbyId);
            
            broadcast(lobby, { 
              type: 'lobbyUpdate', 
              players: lobby.players.map(p => ({ 
                id: p.id, 
                name: p.name, 
                connected: p.ws?.readyState === 1,
                role: p.role || null
              })),
              spectators: lobby.spectators.map(s => ({ 
                id: s.id, 
                name: s.name, 
                connected: s.ws?.readyState === 1 
              })),
              owner: lobby.owner,
              phase: lobby.phase,
              impostorGuessOption: lobby.impostorGuessOption || false,
              twoImpostorsOption: lobby.twoImpostorsOption || false
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
          
          broadcastLobbyList();
        }
        return;
      }

      if (!player || !lobbyId) return;
      
      const lobby = lobbies[lobbyId];
      if (!lobby) return;

      const isSpectator = lobby.spectators.some(s => s.id === player.id);
      
      if (isSpectator) {
        if (msg.type === 'restart') {
          // Only allow restart in results phase
          if (lobby.phase !== 'results' && lobby.phase !== 'lobby') return;
          
          // Toggle wantsToJoinNextGame
          player.wantsToJoinNextGame = !player.wantsToJoinNextGame;
          
          console.log(`SPECTATOR RESTART: ${player.name} toggled to ${player.wantsToJoinNextGame}`);
          
          if (player.wantsToJoinNextGame) {
            if (!lobby.spectatorsWantingToJoin.includes(player.id)) {
              lobby.spectatorsWantingToJoin.push(player.id);
            }
          } else {
            const index = lobby.spectatorsWantingToJoin.indexOf(player.id);
            if (index !== -1) {
              lobby.spectatorsWantingToJoin.splice(index, 1);
            }
          }
          
          console.log(`  spectatorsWantingToJoin array:`, lobby.spectatorsWantingToJoin);
          
          sendRestartUpdates(lobby);
        }
        return;
      }

      player.lastActionTime = Date.now();

      if (msg.type === 'toggleTwoImpostors' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        
        lobby.twoImpostorsOption = msg.enabled;
        
        broadcast(lobby, { 
          type: 'lobbyUpdate', 
          players: lobby.players.map(p => ({ 
            id: p.id, 
            name: p.name, 
            connected: p.ws?.readyState === 1,
            role: p.role || null
          })),
          spectators: lobby.spectators.map(s => ({ 
            id: s.id, 
            name: s.name, 
            connected: s.ws?.readyState === 1 
          })),
          owner: lobby.owner,
          phase: lobby.phase,
          impostorGuessOption: lobby.impostorGuessOption || false,
          twoImpostorsOption: lobby.twoImpostorsOption || false
        });
        
        broadcastLobbyList();
      }

      if (msg.type === 'toggleImpostorGuess' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        
        lobby.impostorGuessOption = msg.enabled;
        
        broadcast(lobby, { 
          type: 'lobbyUpdate', 
          players: lobby.players.map(p => ({ 
            id: p.id, 
            name: p.name, 
            connected: p.ws?.readyState === 1,
            role: p.role || null
          })),
          spectators: lobby.spectators.map(s => ({ 
            id: s.id, 
            name: s.name, 
            connected: s.ws?.readyState === 1 
          })),
          owner: lobby.owner,
          phase: lobby.phase,
          impostorGuessOption: lobby.impostorGuessOption || false,
          twoImpostorsOption: lobby.twoImpostorsOption || false
        });
        
        broadcastLobbyList();
      }

      if (msg.type === 'startGame' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        startGame(lobby);
        broadcastLobbyList();
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

        const sanitizedWord = sanitizeInput(msg.word, 50);

        if (!sanitizedWord) {
          console.log(`Player ${player.name} submitted empty/only HTML`);
          return;
        }

        const entry = { name: player.name, word: sanitizedWord };
        if (lobby.phase === 'round1') {
          lobby.round1.push(entry);
        } else if (lobby.phase === 'round2') {
          lobby.round2.push(entry);
        }

        if (lobby.turnTimeout?.timer) {
          clearTimeout(lobby.turnTimeout.timer);
          lobby.turnTimeout = null;
        }

        // FIX: Use players who are still in the game (not removed and grace not expired)
        const playersInGame = getPlayersInGame(lobby);
        
        console.log(`submitWord: ${player.name} submitted "${sanitizedWord}"`);
        console.log(`  Phase: ${lobby.phase}`);
        console.log(`  Submissions: ${lobby.phase === 'round1' ? lobby.round1.length : lobby.round2.length}`);
        console.log(`  Players in game: ${playersInGame.length}`);
        console.log(`  Checking: ${lobby.phase === 'round1' ? lobby.round1.length : lobby.round2.length} >= ${playersInGame.length}`);
        
        if (lobby.phase === 'round1' && lobby.round1.length >= playersInGame.length) {
          console.log(`✓ Advancing to round2`);
          lobby.phase = 'round2';
          lobby.turn = 0;
          for (let i = 0; i < lobby.players.length; i++) {
            if (lobby.players[i]?.ws?.readyState === 1) {
              lobby.turn = i;
              break;
            }
          }
          
          broadcast(lobby, {
            type: 'turnUpdate',
            phase: 'round1',
            round1: lobby.round1,
            round2: lobby.round2,
            currentPlayer: lobby.players[lobby.turn]?.name || 'Unknown',
            turnEndsAt: lobby.turnEndsAt
          });
          
          startTurnTimer(lobby);
          return;
        } else if (lobby.phase === 'round2' && lobby.round2.length >= playersInGame.length) {
          console.log(`✓ All players submitted for round2, advancing to voting`);
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
              players: lobby.players.map(p => p.name),
              twoImpostorsMode: lobby.twoImpostorsOption || false
            });
          }, 500);
          return;
        }

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
      }

      if (msg.type === 'vote') {
        // Handle both single vote and array of votes
        if (lobby.twoImpostorsOption) {
          // Expecting an array of votes in 2-impostor mode
          if (!Array.isArray(msg.vote)) {
            console.log(`Invalid vote format in 2-impostor mode: ${msg.vote}`);
            return;
          }
          
          // Validate votes - must be 2 different players
          const validVotes = msg.vote.filter(v => 
            v && v !== player.name && lobby.players.some(p => p.name === v)
          );
          
          if (validVotes.length !== 2) {
            console.log(`Invalid votes in 2-impostor mode: ${msg.vote}`);
            return;
          }
          
          // Check for duplicate votes
          const uniqueVotes = [...new Set(validVotes)];
          if (uniqueVotes.length !== 2) {
            console.log(`Duplicate votes in 2-impostors mode: ${msg.vote}`);
            return;
          }
          
          player.vote = validVotes;
        } else {
          // Original 1-impostor mode - single vote
          player.vote = [msg.vote];
        }

        // Use players who are still in the game (not removed and grace not expired)
        const playersInGame = getPlayersInGame(lobby);
        
        // Check if all players in game have voted
        if (playersInGame.every(p => p.vote && p.vote.length > 0)) {
          const voteCounts = {};
          playersInGame.forEach(p => {
            p.vote.forEach(v => {
              voteCounts[v] = (voteCounts[v] || 0) + 1;
            });
          });

          let ejectedPlayers = [];
          
          if (lobby.twoImpostorsOption) {
            // In 2-impostor mode, eject 2 players with most votes
            // Handle ties: if tie for second place, both get ejected (could be 3+)
            const sortedVotes = Object.entries(voteCounts)
              .sort((a, b) => {
                if (b[1] !== a[1]) return b[1] - a[1];
                return a[0].localeCompare(b[0]);
              });
            
            // Get top voted players, handling ties
            if (sortedVotes.length >= 2) {
              const topVoteCount = sortedVotes[0][1];
              const secondVoteCount = sortedVotes[1][1];
              
              // Add all players with top vote count
              ejectedPlayers = sortedVotes.filter(([_, count]) => count === topVoteCount).map(([name]) => name);
              
              // If we need more players to reach 2, add players with second highest count
              if (ejectedPlayers.length < 2) {
                const secondPlacePlayers = sortedVotes
                  .filter(([_, count]) => count === secondVoteCount)
                  .map(([name]) => name);
                ejectedPlayers = [...ejectedPlayers, ...secondPlacePlayers.slice(0, 2 - ejectedPlayers.length)];
              }
              
              // Limit to 2 players max
              ejectedPlayers = ejectedPlayers.slice(0, 2);
            } else if (sortedVotes.length === 1) {
              ejectedPlayers = [sortedVotes[0][0]];
            }
          } else {
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

            if (!isTie && ejected) {
              ejectedPlayers = [ejected];
            }
          }

          if (ejectedPlayers.length > 0) {
            const impostors = lobby.players.filter(p => p.role === 'impostor');
            const ejectedImpostors = impostors.filter(p => ejectedPlayers.includes(p.name));
            const ejectedImpostorCount = ejectedImpostors.length;
            
            if (lobby.impostorGuessOption && ejectedImpostorCount > 0) {
              lobby.phase = 'impostorGuess';
              lobby.ejectedPlayers = ejectedPlayers;
              
              // Send message to civilians and spectators
              broadcast(lobby, {
                type: 'impostorGuessPhase',
                ejected: ejectedPlayers,
                isImpostor: false,
                guessEndsAt: Date.now() + 30000
              });
              
              // Send individual messages to each ejected impostor
              ejectedImpostors.forEach(impostor => {
                if (impostor.ws?.readyState === 1) {
                  impostor.ws.send(JSON.stringify({
                    type: 'impostorGuessPhase',
                    ejected: ejectedPlayers,
                    isImpostor: true,
                    guessEndsAt: Date.now() + 30000
                  }));
                }
              });
              
              startImpostorGuessTimer(lobby);
              
              return;
            }
            
            let winner;
            if (lobby.twoImpostorsOption) {
              if (ejectedImpostorCount === 2) {
                winner = 'Civilians';
              } else if (ejectedImpostorCount === 0) {
                winner = 'Impostors';
              } else if (ejectedImpostorCount === 1) {
                winner = 'Draw';
              }
            } else {
              const impostor = lobby.players.find(p => p.role === 'impostor');
              winner = (ejectedPlayers[0] === impostor?.name) ? 'Civilians' : 'Impostor';
            }
            
            broadcast(lobby, {
              type: 'gameEnd',
              roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
              votes: Object.fromEntries(playersInGame.map(p => [p.name, p.vote])),
              ejected: ejectedPlayers,
              secretWord: lobby.word,
              hint: lobby.hint,
              winner,
              twoImpostorsMode: lobby.twoImpostorsOption || false
            });
            
            // Send individual messages to spectators with their join state
            lobby.spectators.forEach(s => {
              if (s.ws?.readyState === 1) {
                try {
                  s.ws.send(JSON.stringify({
                    type: 'gameEnd',
                    roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
                    votes: Object.fromEntries(playersInGame.map(p => [p.name, p.vote])),
                    ejected: ejectedPlayers,
                    secretWord: lobby.word,
                    hint: lobby.hint,
                    winner,
                    twoImpostorsMode: lobby.twoImpostorsOption || false,
                    isSpectator: true,
                    wantsToJoinNextGame: s.wantsToJoinNextGame || false
                  }));
                } catch (err) {
                  console.log(`Failed to send gameEnd to spectator ${s.name}`);
                }
              }
            });
            
            lobby.phase = 'results';
            lobby.lastTimeBelowThreePlayers = null;
            lobby.turnEndsAt = null;
            lobby.ejectedPlayers = null;
            lobby.impostorGuesses = null;
            
            if (lobby.turnTimeout?.timer) {
              clearTimeout(lobby.turnTimeout.timer);
              lobby.turnTimeout = null;
            }
            
            // Send restart updates so spectators see their current join state
            sendRestartUpdates(lobby);
            broadcastLobbyList();
          } else {
            // No one ejected (tie)
            console.log(`Voting resulted in a tie in lobby ${lobbyId}`);
            // In case of tie, end the game
            const impostors = lobby.players.filter(p => p.role === 'impostor');
            const winner = lobby.twoImpostorsOption ? 'Impostors' : 'Impostor';
            
            broadcast(lobby, {
              type: 'gameEnd',
              roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
              votes: Object.fromEntries(playersInGame.map(p => [p.name, p.vote])),
              secretWord: lobby.word,
              hint: lobby.hint,
              winner,
              twoImpostorsMode: lobby.twoImpostorsOption || false
            });
            
            lobby.phase = 'results';
            lobby.lastTimeBelowThreePlayers = null;
            lobby.turnEndsAt = null;
            lobby.ejectedPlayers = null;
            lobby.impostorGuesses = null;
            
            if (lobby.turnTimeout?.timer) {
              clearTimeout(lobby.turnTimeout.timer);
              lobby.turnTimeout = null;
            }
            
            // Send restart updates so spectators see their current join state
            sendRestartUpdates(lobby);
            broadcastLobbyList();
          }
        }
      }

      if (msg.type === 'impostorGuess') {
        if (lobby.phase !== 'impostorGuess') return;
        
        // Track which impostors have guessed
        if (!lobby.impostorGuesses) {
          lobby.impostorGuesses = {};
        }
        
        // Record this impostor's guess
        lobby.impostorGuesses[player.id] = {
          guess: sanitizeInput(msg.guess || '', 50).toLowerCase(),
          name: player.name
        };
        
        // Check if all ejected impostors have guessed
        const impostors = lobby.players.filter(p => p.role === 'impostor');
        const ejectedImpostors = lobby.ejectedPlayers ? 
          impostors.filter(p => lobby.ejectedPlayers.includes(p.name)) : [];
        
        const allGuessed = ejectedImpostors.length > 0 && 
                          ejectedImpostors.every(impostor => lobby.impostorGuesses[impostor.id]);
        
        if (allGuessed || (lobby.impostorGuesses && Object.keys(lobby.impostorGuesses).length >= ejectedImpostors.length)) {
          if (lobby.impostorGuessTimeout?.timer) {
            clearTimeout(lobby.impostorGuessTimeout.timer);
            lobby.impostorGuessTimeout = null;
          }
          
          // Calculate if any impostor guessed correctly
          let anyCorrect = false;
          for (const guessData of Object.values(lobby.impostorGuesses)) {
            if (guessData.guess === lobby.word.toLowerCase()) {
              anyCorrect = true;
              break;
            }
          }
          
          let winner;
          if (anyCorrect) {
            winner = 'Impostors';
          } else {
            // In two-impostor mode, if only one impostor was ejected and guessed wrong
            // but the other impostor is still in the game, it's a draw
            const remainingImpostors = impostors.filter(p => 
              !ejectedImpostors.some(e => e.id === p.id)
            );
            winner = (lobby.twoImpostorsOption && remainingImpostors.length > 0) ? 'Draw' : 'Civilians';
          }
          
          broadcast(lobby, {
            type: 'gameEnd',
            roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
            votes: Object.fromEntries(lobby.players.filter(p => p.vote).map(p => [p.name, p.vote])),
            secretWord: lobby.word,
            hint: lobby.hint,
            winner,
            impostorGuesses: lobby.impostorGuesses,
            twoImpostorsMode: lobby.twoImpostorsOption || false
          });
          
          // Send individual messages to spectators with their join state
          lobby.spectators.forEach(s => {
            if (s.ws?.readyState === 1) {
              try {
                s.ws.send(JSON.stringify({
                  type: 'gameEnd',
                  roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
                  votes: Object.fromEntries(lobby.players.filter(p => p.vote).map(p => [p.name, p.vote])),
                  secretWord: lobby.word,
                  hint: lobby.hint,
                  winner,
                  impostorGuesses: lobby.impostorGuesses,
                  twoImpostorsMode: lobby.twoImpostorsOption || false,
                  isSpectator: true,
                  wantsToJoinNextGame: s.wantsToJoinNextGame || false
                }));
              } catch (err) {
                console.log(`Failed to send gameEnd to spectator ${s.name}`);
              }
            }
          });
          
          lobby.phase = 'results';
          lobby.lastTimeBelowThreePlayers = null;
          lobby.turnEndsAt = null;
          lobby.impostorGuesses = null;
          lobby.ejectedPlayers = null;
          
          // Send restart updates so spectators see their current join state
          sendRestartUpdates(lobby);
          broadcastLobbyList();
        }
      }

      if (msg.type === 'restart') {
        // Only allow restart in results phase
        if (lobby.phase !== 'results' && lobby.phase !== 'lobby') {
          console.log(`Ignoring restart message during phase: ${lobby.phase}`);
          return;
        }
        
        if (!isSpectator && player.role && !lobby.restartReady.includes(player.id)) {
          lobby.restartReady.push(player.id);
        } else if (!isSpectator && player.role && lobby.restartReady.includes(player.id)) {
          // Toggle restart ready
          const index = lobby.restartReady.indexOf(player.id);
          if (index !== -1) {
            lobby.restartReady.splice(index, 1);
          }
        }
        
        sendRestartUpdates(lobby);
        
        const playersInGame = getPlayersInGame(lobby);
        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        const connectedSpectators = lobby.spectators.filter(s => s.ws?.readyState === 1);
        
        // Get players who were in the previous game (have roles)
        const playersWithRoles = lobby.players.filter(p => p.role);
        
        // Get connected players who were in the previous game and have pressed restart
        const readyConnectedPlayers = lobby.restartReady.filter(id => 
          connectedPlayers.some(p => p.id === id && p.role)
        );
        
        // Get spectators who want to join
        const spectatorsWantingToJoin = lobby.spectatorsWantingToJoin.filter(id =>
          connectedSpectators.some(s => s.id === id)
        );
        
        console.log(`Restart check for lobby ${lobbyId}: ${playersWithRoles.length} players with roles, ${readyConnectedPlayers.length} ready, ${connectedPlayers.length} total connected players, ${spectatorsWantingToJoin.length} spectators wanting to join`);
        
        // FIXED RESTART LOGIC: 
        // 1. All previous game players must be ready OR disconnected and removed
        // 2. Then we need at least 3 total participants (ready players + spectators wanting to join)
        
        // First, check if all previous game players are accounted for
        const disconnectedPlayersRemaining = playersWithRoles.filter(p => 
          p.ws?.readyState !== 1 && !p.removed && p.lastDisconnectTime && 
          (Date.now() - p.lastDisconnectTime <= RESULTS_GRACE_PERIOD)
        );
        
        // If there are still disconnected players within grace period, wait
        if (disconnectedPlayersRemaining.length > 0) {
          console.log(`Waiting for ${disconnectedPlayersRemaining.length} disconnected players to reconnect`);
          return;
        }
        
        // Now check if all connected players from previous game are ready
        const connectedPlayersFromPreviousGame = playersWithRoles.filter(p => p.ws?.readyState === 1);
        const allConnectedPlayersReady = connectedPlayersFromPreviousGame.every(p => 
          lobby.restartReady.includes(p.id)
        );
        
        if (!allConnectedPlayersReady) {
          console.log(`Not all connected players from previous game are ready`);
          return;
        }
        
        // Now check if we have enough participants (at least 3)
        const totalParticipants = readyConnectedPlayers.length + spectatorsWantingToJoin.length;
        
        if (totalParticipants >= 3) {
          console.log(`Restart condition met for lobby ${lobbyId}: All previous players ready + ${totalParticipants} total participants`);
          
          // Convert spectators who want to join into players
          const spectatorsToJoin = lobby.spectators.filter(s => 
            s.ws?.readyState === 1 && s.wantsToJoinNextGame
          );
          
          console.log(`Spectators wanting to join: ${spectatorsToJoin.length}`);
          
          spectatorsToJoin.forEach(spectator => {
            const spectatorIndex = lobby.spectators.findIndex(s => s.id === spectator.id);
            if (spectatorIndex !== -1) {
              lobby.spectators.splice(spectatorIndex, 1);
              spectator.isSpectator = false;
              spectator.wantsToJoinNextGame = false; // Reset only for spectators who are joining
              spectator.role = null;
              spectator.vote = [];
              spectator.removed = false;
              spectator.lastDisconnectTime = null;
              lobby.players.push(spectator);
              
              // FIX: Clean the name by removing eye icon and "Spectator-" prefix
              let cleanName = spectator.name;
              cleanName = cleanName.replace('👁️ ', ''); // Remove eye icon
              
              // Check if it's a generated spectator name
              if (/^Spectator-\d+$/.test(cleanName)) {
                // Generate a proper player name
                const playerNumber = Math.floor(Math.random() * 1000);
                cleanName = `Player-${playerNumber}`;
              }
              
              spectator.name = cleanName; // Update the actual player object
              
              try {
                spectator.ws.send(JSON.stringify({
                  type: 'roleChanged',
                  message: 'You are now a player for the next game!',
                  isSpectator: false,
                  // Send the clean name back
                  playerName: cleanName
                }));
              } catch (err) {
                console.log(`Failed to send role change to ${spectator.name}`);
              }
            }
          });
          
          lobby.spectatorsWantingToJoin = [];
          lobby.restartReady = []; // Clear restart ready for new game
          startGame(lobby);
        } else {
          console.log(`Not enough participants to restart: ${totalParticipants}/3`);
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
    
    // Clean up WebSocket object properties to prevent memory leaks
    delete ws.inLobby;
    delete ws.isAlive;
    delete ws.connectionEpoch;
    
    if (lobbyId && lobbies[lobbyId] && player) {
      const lobby = lobbies[lobbyId];
      
      // FIX: Proper connection epoch check
      if (player.connectionEpoch && ws.connectionEpoch !== player.connectionEpoch) {
        console.log(`Ignoring close from stale socket for player ${player.name} (epoch mismatch)`);
        return;
      }
      
      // Only mark as disconnected if not manually removed
      if (!player.removed) {
        player.lastDisconnectTime = Date.now();
        console.log(`DISCONNECT: ${player.name} disconnected at ${player.lastDisconnectTime}, phase: ${lobby.phase}`); // ← ADD THIS
      }
      
      const wasGameInProgress = (lobby.phase !== 'lobby' && lobby.phase !== 'results' && lobby.phase !== 'impostorGuess');
      
      if (wasGameInProgress) {
        checkGameEndConditions(lobby, lobbyId);
      }
      
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => ({ 
          id: p.id, 
          name: p.name, 
          connected: p.ws?.readyState === 1,
          role: p.role || null
        })),
        spectators: lobby.spectators.map(s => ({ 
          id: s.id, 
          name: s.name, 
          connected: s.ws?.readyState === 1 
        })),
        owner: lobby.owner,
        phase: lobby.phase,
        impostorGuessOption: lobby.impostorGuessOption || false,
        twoImpostorsOption: lobby.twoImpostorsOption || false
      });
      
      broadcastLobbyList();
    }
    
    console.log(`Connection closed: ${connectionId} (code: ${code}, reason: ${reason})`);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${connectionId}:`, error.message);
    // Clean up on error
    clearTimeout(connectionTimeout);
  });

  function handlePlayerJoin(ws, msg, targetLobbyId, connectionId) {
    const lobby = lobbies[targetLobbyId];
    lobbyId = targetLobbyId;
    
    let existingPlayer = lobby.players.find(p => p.id === msg.playerId);
    if (existingPlayer) {
      // Player is reconnecting - keep their existing game state
      player = existingPlayer;
      replaceSocket(player, ws);
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
      player.reconnectionAttempts = (player.reconnectionAttempts || 0) + 1;
      player.connectionEpoch = (player.connectionEpoch || 0) + 1;
      ws.connectionEpoch = player.connectionEpoch;
      
      console.log(`Player ${player.name} reconnected to lobby ${targetLobbyId}, phase: ${lobby.phase}, role: ${player.role || 'none'}`);
      
      // IMPORTANT: Do NOT send restart updates when reconnecting during active game
      // This prevents triggering the restart condition check
      
      // Send the current game state to the reconnecting player
      if (lobby.phase !== 'lobby') {
        setTimeout(() => {
          sendCurrentGameStateToPlayer(lobby, player);
        }, 100);
      }
    } else {
      // New player joining
      const allNames = [...lobby.players, ...lobby.spectators].map(p => p.name);
      let uniqueName = sanitizeInput(msg.name || 'Player', 20);
      
      if (isNameTakenInLobby(lobby, uniqueName)) {
        uniqueName = makeNameUnique(uniqueName, allNames, msg.playerId);
        console.log(`Name "${msg.name}" was taken in lobby ${targetLobbyId}, changed to "${uniqueName}"`);
      }
      
      player = { 
        id: msg.playerId, 
        name: uniqueName, 
        ws, 
        connectionId,
        lastActionTime: Date.now(),
        reconnectionAttempts: 0,
        connectionEpoch: 1,
        role: null,
        vote: [],
        removed: false,
        graceExpiresAt: null,
        lastDisconnectTime: null,
        submittedWord: false
      };
      ws.connectionEpoch = 1;
      lobby.players.push(player);
      
      if (!lobby.owner) {
        lobby.owner = msg.playerId;
      }
      
      if (lobby.owner === msg.playerId && !lobby.hostName) {
        lobby.hostName = uniqueName;
      }
    }

    ws.inLobby = true;

    // Send lobby assignment
    ws.send(JSON.stringify({ 
      type: 'lobbyAssigned', 
      lobbyId,
      isSpectator: false,
      playerName: player.name,
      yourName: player.name,
      isOwner: lobby.owner === player.id,
      impostorGuessOption: lobby.impostorGuessOption || false,
      twoImpostorsOption: lobby.twoImpostorsOption || false
    }));
    
    broadcast(lobby, { 
      type: 'lobbyUpdate', 
      players: lobby.players.map(p => ({ 
        id: p.id, 
        name: p.name, 
        connected: p.ws?.readyState === 1,
        role: p.role || null
      })),
      spectators: lobby.spectators.map(s => ({ 
        id: s.id, 
        name: s.name, 
        connected: s.ws?.readyState === 1 
      })),
      owner: lobby.owner,
      phase: lobby.phase,
      impostorGuessOption: lobby.impostorGuessOption || false,
      twoImpostorsOption: lobby.twoImpostorsOption || false
    });
    
    broadcastLobbyList();
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
    
    // Check if this is a reconnection of an existing player
    const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
    if (existingPlayer) {
      // Player exists - reconnect them as player, not spectator
      console.log(`Player ${existingPlayer.name} reconnecting as player (not spectator) to lobby ${targetLobbyId}`);
      player = existingPlayer;
      replaceSocket(player, ws);
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
      player.connectionEpoch = (player.connectionEpoch || 0) + 1;
      ws.connectionEpoch = player.connectionEpoch;
      
      // Send current game state
      if (lobby.phase !== 'lobby') {
        setTimeout(() => {
          sendCurrentGameStateToPlayer(lobby, player);
        }, 100);
      }
      
      ws.inLobby = true;
      
      ws.send(JSON.stringify({ 
        type: 'lobbyAssigned', 
        lobbyId: lobbyId,
        isSpectator: false,
        playerName: player.name,
        yourName: player.name,
        isOwner: lobby.owner === player.id,
        impostorGuessOption: lobby.impostorGuessOption || false,
        twoImpostorsOption: lobby.twoImpostorsOption || false
      }));
      
      broadcast(lobby, { 
        type: 'lobbyUpdate', 
        players: lobby.players.map(p => ({ 
          id: p.id, 
          name: p.name, 
          connected: p.ws?.readyState === 1,
          role: p.role || null
        })),
        spectators: lobby.spectators.map(s => ({ 
          id: s.id, 
          name: s.name, 
          connected: s.ws?.readyState === 1 
        })),
        owner: lobby.owner,
        phase: lobby.phase,
        impostorGuessOption: lobby.impostorGuessOption || false,
        twoImpostorsOption: lobby.twoImpostorsOption || false
      });
      
      broadcastLobbyList();
      return;
    }
    
    // Check for existing spectator
    let existingSpectator = lobby.spectators.find(s => s.id === msg.playerId);
    if (existingSpectator) {
      player = existingSpectator;
      replaceSocket(player, ws);
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
      player.connectionEpoch = (player.connectionEpoch || 0) + 1;
      ws.connectionEpoch = player.connectionEpoch;
      
      // Restore spectator intent from the server's source of truth
      const wasWantingToJoin = lobby.spectatorsWantingToJoin.includes(player.id);
      player.wantsToJoinNextGame = wasWantingToJoin;

      // Sync array and flag
      if (player.wantsToJoinNextGame &&
          !lobby.spectatorsWantingToJoin.includes(player.id)) {
        lobby.spectatorsWantingToJoin.push(player.id);
      } else if (!player.wantsToJoinNextGame &&
                 lobby.spectatorsWantingToJoin.includes(player.id)) {
        const index = lobby.spectatorsWantingToJoin.indexOf(player.id);
        if (index !== -1) lobby.spectatorsWantingToJoin.splice(index, 1);
      }
      
      console.log(`SPECTATOR RECONNECT: ${player.name}`);
      console.log(`  spectatorsWantingToJoin array:`, lobby.spectatorsWantingToJoin);
      console.log(`  wasWantingToJoin: ${wasWantingToJoin}`);
      console.log(`  player.wantsToJoinNextGame: ${player.wantsToJoinNextGame}`);
      console.log(`  lobby.phase: ${lobby.phase}`);
    } else {
      // New spectator
      const allNames = [...lobby.players, ...lobby.spectators].map(p => p.name);
      const baseName = sanitizeInput(msg.name || `Spectator-${Math.floor(Math.random() * 1000)}`, 20);
      let uniqueName = baseName.trim();
      
      if (isNameTakenInLobby(lobby, uniqueName)) {
        uniqueName = makeNameUnique(uniqueName, allNames, msg.playerId);
        console.log(`Spectator name "${baseName}" was taken in lobby ${targetLobbyId}, changed to "${uniqueName}"`);
      } else {
        uniqueName = makeNameUnique(uniqueName, allNames, msg.playerId);
      }
      
      player = { 
        id: msg.playerId, 
        name: uniqueName, 
        ws, 
        isSpectator: true,
        connectionId,
        lastActionTime: Date.now(),
        wantsToJoinNextGame: false,
        connectionEpoch: 1,
        removed: false,
        lastDisconnectTime: null
      };
      ws.connectionEpoch = 1;
      lobby.spectators.push(player);
    }

    ws.inLobby = true;

    // Send current game state to spectator
    if (lobby.phase !== 'lobby') {
      setTimeout(() => {
        sendCurrentGameStateToSpectator(lobby, player);
      }, 100);
    }

    // FIX: Send restart state update IMMEDIATELY after reconnection if in results phase
    if (lobby.phase === 'results' && existingSpectator) {
      setTimeout(() => {
        if (player.ws?.readyState === 1) {
          try {
            const playersInGame = getPlayersInGame(lobby);
            const readyConnectedPlayers = lobby.restartReady.filter(id =>
              lobby.players.some(p => p.id === id && p.ws?.readyState === 1)
            );

            player.ws.send(JSON.stringify({
              type: 'restartUpdate',
              readyCount: readyConnectedPlayers.length,
              totalPlayers: playersInGame.length,
              spectatorsWantingToJoin: lobby.spectatorsWantingToJoin.length,
              isSpectator: true,
              wantsToJoin: player.wantsToJoinNextGame || false,
              status: player.wantsToJoinNextGame ? 'joining' : 'waiting'
            }));
          } catch (err) {
            console.log(`Failed to send restart update to reconnected spectator ${player.name}`);
          }
        }
      }, 200); // Increased delay to ensure lobby assignment is processed first
    }

    ws.send(JSON.stringify({
      type: 'lobbyAssigned',
      lobbyId: lobbyId,
      isSpectator: true,
      playerName: player.name,
      yourName: player.name,
      isOwner: false,
      impostorGuessOption: lobby.impostorGuessOption || false,
      twoImpostorsOption: lobby.twoImpostorsOption || false,
      wantsToJoinNextGame: player.wantsToJoinNextGame || false
    }));
    
    broadcast(lobby, { 
      type: 'lobbyUpdate', 
      players: lobby.players.map(p => ({ 
        id: p.id, 
        name: p.name, 
        connected: p.ws?.readyState === 1,
        role: p.role || null
      })),
      spectators: lobby.spectators.map(s => ({ 
        id: s.id, 
        name: s.name, 
        connected: s.ws?.readyState === 1 
      })),
      owner: lobby.owner,
      phase: lobby.phase,
      impostorGuessOption: lobby.impostorGuessOption || false,
      twoImpostorsOption: lobby.twoImpostorsOption || false
    });
    
    broadcastLobbyList();
  }

  function sendCurrentGameStateToPlayer(lobby, player) {
    try {
      if (lobby.phase === 'results' || lobby.phase === 'impostorGuess') {
        // Send game end state
        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        const winner = connectedPlayers.length >= 3 ? 'Game Ended' : 'Game Ended Early';
        
        player.ws.send(JSON.stringify({
          type: 'gameEnd',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          secretWord: lobby.word,
          hint: lobby.hint,
          winner
        }));
      } else if (lobby.phase === 'impostorGuess') {
        const impostors = lobby.players.filter(p => p.role === 'impostor');
        if (player.role === 'impostor') {
          player.ws.send(JSON.stringify({
            type: 'impostorGuessPhase',
            isImpostor: true,
            guessEndsAt: lobby.impostorGuessEndsAt
          }));
        } else {
          player.ws.send(JSON.stringify({
            type: 'impostorGuessPhase',
            isImpostor: false,
            guessEndsAt: lobby.impostorGuessEndsAt
          }));
        }
      } else {
        // Send current game state
        const roleToSend = player.role || 'spectator';
        const wordToSend = player.role === 'civilian' ? lobby.word : 
                          player.role === 'impostor' ? lobby.hint : 
                          lobby.word;
        
        player.ws.send(JSON.stringify({
          type: 'gameStart',
          role: roleToSend,
          word: wordToSend,
          hint: roleToSend === 'spectator' ? lobby.hint : undefined,
          isSpectator: false,
          playerName: player.name
        }));
        
        if (lobby.phase === 'round1' || lobby.phase === 'round2') {
          const currentPlayer = lobby.players[lobby.turn];
          if (currentPlayer) {
            player.ws.send(JSON.stringify({
              type: 'turnUpdate',
              phase: lobby.phase,
              round1: lobby.round1,
              round2: lobby.round2,
              currentPlayer: currentPlayer.name,
              turnEndsAt: lobby.turnEndsAt,
              isSpectator: false
            }));
          }
        } else if (lobby.phase === 'voting') {
          player.ws.send(JSON.stringify({
            type: 'startVoting',
            players: lobby.players.map(p => p.name),
            twoImpostorsMode: lobby.twoImpostorsOption || false,
            isSpectator: false
          }));
        }
      }
    } catch (err) {
      console.log(`Error sending game state to reconnecting player ${player.name}:`, err.message);
    }
  }

  function sendCurrentGameStateToSpectator(lobby, spectator) {
    try {
      if (lobby.phase === 'results' || lobby.phase === 'impostorGuess') {
        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        const winner = connectedPlayers.length >= 3 ? 'Game Ended' : 'Game Ended Early';
        
        spectator.ws.send(JSON.stringify({
          type: 'gameEnd',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          secretWord: lobby.word,
          hint: lobby.hint,
          winner,
          isSpectator: true,
          wantsToJoinNextGame: spectator.wantsToJoinNextGame || false  // ← ADD THIS
        }));
      } else if (lobby.phase === 'impostorGuess') {
        spectator.ws.send(JSON.stringify({
          type: 'impostorGuessPhase',
          isImpostor: false,
          guessEndsAt: lobby.impostorGuessEndsAt
        }));
      } else {
        spectator.ws.send(JSON.stringify({
          type: 'gameStart',
          role: 'spectator',
          word: lobby.word,
          hint: lobby.hint,
          isSpectator: true,
          playerName: spectator.name
        }));
        
        if (lobby.phase === 'round1' || lobby.phase === 'round2') {
          const currentPlayer = lobby.players[lobby.turn];
          if (currentPlayer) {
            spectator.ws.send(JSON.stringify({
              type: 'turnUpdate',
              phase: lobby.phase,
              round1: lobby.round1,
              round2: lobby.round2,
              currentPlayer: currentPlayer.name,
              turnEndsAt: lobby.turnEndsAt,
              isSpectator: true
            }));
          }
        } else if (lobby.phase === 'voting') {
          spectator.ws.send(JSON.stringify({
            type: 'startVoting',
            players: lobby.players.map(p => p.name),
            twoImpostorsMode: lobby.twoImpostorsOption || false,
            isSpectator: true
          }));
        }
      }
    } catch (err) {
      console.log(`Error sending game state to spectator ${spectator.name}:`, err.message);
    }
  }

  function sendRestartUpdates(lobby) {
    // IMPORTANT: Only send restart updates during results or lobby phase
    if (lobby.phase !== 'results' && lobby.phase !== 'lobby') {
      console.log(`Not sending restart updates during phase: ${lobby.phase}`);
      return;
    }
    
    const playersInGame = getPlayersInGame(lobby);
    
    // Filter restartReady to only include connected players
    const readyConnectedPlayers = lobby.restartReady.filter(id => 
      lobby.players.some(p => p.id === id && p.ws?.readyState === 1)
    );
    
    // Calculate total ready participants (players only - spectators don't count for restart)
    const connectedSpectators = lobby.spectators.filter(s => s.ws?.readyState === 1);
    const spectatorsWantingToJoin = lobby.spectatorsWantingToJoin.filter(id =>
      connectedSpectators.some(s => s.id === id)
    );
    
    // FIX: Spectators don't count towards restart condition, only for total participants
    const totalReadyParticipants = readyConnectedPlayers.length; // Only players
    
    lobby.players.forEach(p => {
      if (p.ws?.readyState === 1) {
        try {
          p.ws.send(JSON.stringify({
            type: 'restartUpdate',
            readyCount: totalReadyParticipants, // Send only player ready count
            totalPlayers: playersInGame.length,
            spectatorsWantingToJoin: spectatorsWantingToJoin.length,
            isSpectator: false,
            playerRole: p.role
          }));
        } catch (err) {
          console.log(`Failed to send restart update to ${p.name}`);
        }
      }
    });
    
    lobby.spectators.forEach(s => {
      if (s.ws?.readyState === 1) {
        try {
          s.ws.send(JSON.stringify({
            type: 'restartUpdate',
            readyCount: totalReadyParticipants, // Send only player ready count
            totalPlayers: playersInGame.length,
            spectatorsWantingToJoin: spectatorsWantingToJoin.length,
            isSpectator: true,
            wantsToJoin: s.wantsToJoinNextGame || false,
            status: s.wantsToJoinNextGame ? 'joining' : 'waiting'
          }));
        } catch (err) {
          console.log(`Failed to send restart update to spectator ${s.name}`);
        }
      }
    });
  }
  
  setTimeout(() => {
    if (ws.readyState === 1) {
      const lobbyList = Object.entries(lobbies).map(([id, lobby]) => ({
        id,
        host: lobby.hostName || 'Unknown',
        playerCount: lobby.players.filter(p => p.ws?.readyState === 1).length,
        spectatorCount: lobby.spectators.filter(s => s.ws?.readyState === 1).length,
        maxPlayers: 15,
        phase: lobby.phase,
        createdAt: lobby.createdAt,
        impostorGuessOption: lobby.impostorGuessOption || false,
        twoImpostorsOption: lobby.twoImpostorsOption || false
      }));
      
      try {
        ws.send(JSON.stringify({
          type: 'lobbyList',
          lobbies: lobbyList
        }));
      } catch (err) {
        console.log('Failed to send initial lobby list');
      }
    }
  }, 100);
});