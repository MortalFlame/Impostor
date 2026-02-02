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
    impostorGuessOption: lobby.impostorGuessOption || false // Add to lobby list
  })).filter(lobby => lobby.phase === 'lobby'); // Only show lobbies in lobby phase

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
      
      // If the player was the owner, assign a new owner
      if (lobby.owner === playerId) {
        const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
        if (newOwner) {
          lobby.owner = newOwner.id;
          // Update host name when owner changes
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
      wasRemoved = true;
    }
    
    // Clean up empty lobbies
    if (wasRemoved) {
      removedFrom.push(lobbyId);
      
      if (lobby.players.length === 0 && lobby.spectators.length === 0) {
        console.log(`Deleting empty lobby: ${lobbyId}`);
        
        if (lobby.turnTimeout?.timer) {
          clearTimeout(lobby.turnTimeout.timer);
        }
        
        if (lobby.impostorGuessTimeout?.timer) {
          clearTimeout(lobby.impostorGuessTimeout.timer);
        }
        
        delete lobbies[lobbyId];
      } else {
        // Broadcast updated lobby state
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
          phase: lobby.phase,
          impostorGuessOption: lobby.impostorGuessOption || false
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

// SIMPLE: True random word selection with no repeats until all used
function getRandomWord(lobby) {
  if (!lobby.availableWords || lobby.availableWords.length === 0) {
    // Start with a fresh copy of all words
    lobby.availableWords = [...words];
    lobby.usedWords = [];
    
    // Initial shuffle using Fisher-Yates algorithm
    for (let i = lobby.availableWords.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [lobby.availableWords[i], lobby.availableWords[j]] = [lobby.availableWords[j], lobby.availableWords[i]];
    }
    
    console.log(`Initialized word pool for lobby: ${lobby.availableWords.length} words`);
  }
  
  // Pick a random word from available words
  const randomIndex = crypto.randomInt(lobby.availableWords.length);
  const selectedWord = lobby.availableWords[randomIndex];
  
  // Remove from available and add to used
  lobby.availableWords.splice(randomIndex, 1);
  lobby.usedWords.push(selectedWord);
  
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

function checkGameEndConditions(lobby, lobbyId) {
  // Don't check if game is already ending or in lobby/results
  if (lobby.phase === 'lobby' || lobby.phase === 'results' || lobby.phase === 'impostorGuess') {
    return false;
  }
  
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  
  // Check for impostor disconnect with 30-second grace period
  const impostor = lobby.players.find(p => p.role === 'impostor');
  if (impostor) {
    if (impostor.ws?.readyState !== 1) {
      const now = Date.now();
      
      // If we just noticed the impostor is disconnected, record the time
      if (!impostor.lastDisconnectTime) {
        impostor.lastDisconnectTime = now;
        console.log(`Impostor ${impostor.name} disconnected in lobby ${lobbyId}, starting 30s grace period`);
        return false;
      }
      
      // Check if impostor has been disconnected for more than 30 seconds
      if (now - impostor.lastDisconnectTime > 30000) {
        console.log(`Game in lobby ${lobbyId} ending: impostor left for >30s`);
        endGameEarly(lobby, 'impostor_left');
        return true;
      }
      
      // Still within grace period
      const secondsRemaining = Math.ceil((30000 - (now - impostor.lastDisconnectTime)) / 1000);
      console.log(`Impostor ${impostor.name} disconnected for ${30 - secondsRemaining}s, ${secondsRemaining}s remaining`);
      return false;
    } else {
      // Impostor is connected, reset disconnect time
      impostor.lastDisconnectTime = null;
    }
  }
  
  // Check for low player count with 30-second grace period
  if (connectedPlayers.length < 3) {
    const now = Date.now();
    
    // If we just dropped below 3, record the time
    if (!lobby.lastTimeBelowThreePlayers) {
      lobby.lastTimeBelowThreePlayers = now;
      console.log(`Game in lobby ${lobbyId} now has ${connectedPlayers.length} players, starting 30s grace period`);
      return false;
    }
    
    // Check if we've been below 3 players for more than 30 seconds
    if (now - lobby.lastTimeBelowThreePlayers > 30000) {
      console.log(`Game in lobby ${lobbyId} ending: less than 3 players for 30+ seconds (${connectedPlayers.length})`);
      endGameEarly(lobby, 'not_enough_players');
      return true;
    }
    
    // Still within grace period
    const secondsRemaining = Math.ceil((30000 - (now - lobby.lastTimeBelowThreePlayers)) / 1000);
    console.log(`Game in lobby ${lobbyId} has ${connectedPlayers.length} players, ${secondsRemaining}s remaining`);
    return false;
  } else {
    // We have 3+ players, reset the timer
    lobby.lastTimeBelowThreePlayers = null;
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
  
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  // FIXED: Changed winner to 'Game Ended Early' instead of 'Impostor' or 'Civilians'
  const winner = 'Game Ended Early';
  
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
  lobby.spectatorsWantingToJoin = [];
  lobby.lastTimeBelowThreePlayers = null; // Reset grace period timer
  
  // FIX: Broadcast lobby list when game ends early (lobby becomes visible again)
  broadcastLobbyList();
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
  lobby.spectatorsWantingToJoin = [];
  lobby.turnTimeout = null;
  lobby.impostorGuessTimeout = null;
  lobby.lastTimeBelowThreePlayers = null; // Reset grace period timer

  lobby.spectators.forEach(s => s.vote = '');

  const { word, hint } = getRandomWord(lobby);
  lobby.word = word;
  lobby.hint = hint;

  const shuffledConnectedPlayers = [...connectedPlayers].sort(() => Math.random() - 0.5);
  const impostorIndex = crypto.randomInt(shuffledConnectedPlayers.length);
  
  lobby.players.forEach(p => p.role = null);
  
  shuffledConnectedPlayers.forEach((player, i) => {
    player.role = i === impostorIndex ? 'impostor' : 'civilian';
    player.vote = '';
    player.lastActionTime = Date.now();
    player.lastDisconnectTime = null; // Reset disconnect time for new game
    try {
      player.ws.send(JSON.stringify({
        type: 'gameStart',
        role: player.role,
        word: player.role === 'civilian' ? word : hint,
        playerName: player.name
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
          word: word,
          hint: hint,
          isSpectator: true,
          playerName: s.name
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
  
  // FIX: Broadcast lobby list when game starts (lobby phase changes)
  broadcastLobbyList();
}

// Store turnEndsAt once per turn
function setTurnEndTime(lobby) {
  lobby.turnEndsAt = Date.now() + 30000; // Store once per turn
}

function startTurnTimer(lobby) {
  if (lobby.turnTimeout?.timer) {
    clearTimeout(lobby.turnTimeout.timer);
    lobby.turnTimeout = null;
  }
  
  if (lobby.phase !== 'round1' && lobby.phase !== 'round2') return;
  
  const currentPlayer = lobby.players[lobby.turn];
  if (!currentPlayer) return;
  
  // Store the absolute turn end time
  setTurnEndTime(lobby);
  
  lobby.turnTimeout = {
    playerId: currentPlayer.id,
    timer: setTimeout(() => {
      console.log(`Turn timeout for player ${currentPlayer.name}`);
      
      if (lobby.players[lobby.turn]?.id === currentPlayer.id) {
        // FIXED: Even if player is disconnected, we still process the timeout
        // This allows the 30-second grace period to count down
        skipCurrentPlayer(lobby, true);
      }
    }, 30000)
  };
  
  // UPDATED: Use stored turnEndsAt, not recalculated
  broadcast(lobby, {
    type: 'turnUpdate',
    phase: lobby.phase,
    round1: lobby.round1,
    round2: lobby.round2,
    currentPlayer: currentPlayer.name,
    turnEndsAt: lobby.turnEndsAt  // Use stored absolute time
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
      turnEndsAt: lobby.turnEndsAt  // Use existing turnEndsAt
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
    return;
  }
  
  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
  
  if (lobby.phase === 'round1') {
    if (lobby.round1.length >= connectedPlayers.length) {
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
    if (lobby.round2.length >= connectedPlayers.length) {
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
      
      // Time's up, impostor loses
      const impostor = lobby.players.find(p => p.role === 'impostor');
      if (impostor) {
        broadcast(lobby, {
          type: 'gameEnd',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          secretWord: lobby.word,
          hint: lobby.hint,
          winner: 'Civilians',
          reason: 'impostorFailedToGuess'
        });
      }
      
      lobby.phase = 'results';
      lobby.restartReady = [];
      lobby.spectatorsWantingToJoin = [];
      lobby.lastTimeBelowThreePlayers = null;
      lobby.turnEndsAt = null;
      lobby.impostorGuessTimeout = null;
      
      broadcastLobbyList();
    }, 30000)
  };
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
  
  // Check game end conditions during cleanup (every 15 seconds)
  if (lobby.phase !== 'lobby' && lobby.phase !== 'results' && lobby.phase !== 'impostorGuess') {
    checkGameEndConditions(lobby, lobbyId);
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
      phase: lobby.phase,
      impostorGuessOption: lobby.impostorGuessOption || false
    });
    
    // FIX: Broadcast lobby list when players leave during cleanup
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

  // Send server ID for restart detection
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
  
  // Mark client as not in a lobby initially
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
        // Send current lobby list to this client
        const lobbyList = Object.entries(lobbies).map(([id, lobby]) => ({
          id,
          host: lobby.hostName || 'Unknown',
          playerCount: lobby.players.filter(p => p.ws?.readyState === 1).length,
          spectatorCount: lobby.spectators.filter(s => s.ws?.readyState === 1).length,
          maxPlayers: 15,
          phase: lobby.phase,
          createdAt: lobby.createdAt,
          impostorGuessOption: lobby.impostorGuessOption || false
        })).filter(lobby => lobby.phase === 'lobby');
        
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

      // Epoch check for all messages after player is established
      if (player && ws.connectionEpoch !== player.connectionEpoch) {
        console.log(`Ignoring message from stale socket for player ${player.name}`);
        return;
      }

      if (msg.type === 'joinLobby') {
        lobbyId = msg.lobbyId || Math.floor(1000 + Math.random() * 9000).toString();
        
        // Remove player from any other lobbies they might be in
        removePlayerFromAllLobbies(msg.playerId, 'Joined another lobby');
        
        // If creating a new lobby (no lobbyId provided), check for existing lobby by same host
        if (!msg.lobbyId) {
          // Already handled by removePlayerFromAllLobbies
          console.log(`Player ${msg.playerId} creating new lobby ${lobbyId}`);
        }
        
        if (!lobbies[lobbyId]) {
          lobbies[lobbyId] = { 
            players: [], 
            spectators: [],
            phase: 'lobby', 
            owner: msg.playerId,
            hostName: null, // Will be set when host joins
            createdAt: Date.now(),
            turnTimeout: null,
            impostorGuessTimeout: null,
            turnEndsAt: null,
            impostorGuessEndsAt: null,
            restartReady: [],
            spectatorsWantingToJoin: [],
            lastTimeBelowThreePlayers: null,
            availableWords: null,
            usedWords: [],
            impostorGuessOption: false // Default to false
          }; 
          console.log(`Created new lobby: ${lobbyId} for player ${msg.playerId}`);
          
          // FIX: Broadcast lobby list when a lobby is created
          broadcastLobbyList();
        }
        
        const lobby = lobbies[lobbyId];

        // Allow joining during results phase
        if (lobby.phase !== 'lobby' && lobby.phase !== 'results') {
          console.log(`Player ${msg.playerId} joining game in progress`);
          
          const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
          if (existingPlayer) {
            player = existingPlayer;
            replaceSocket(player, ws);
            player.lastDisconnectTime = null;
            player.connectionId = connectionId;
            player.reconnectionAttempts = (player.reconnectionAttempts || 0) + 1;
            player.connectionEpoch = (player.connectionEpoch || 0) + 1;
            ws.connectionEpoch = player.connectionEpoch;
            
            setTimeout(() => {
              try {
                ws.send(JSON.stringify({
                  type: 'gameStart',
                  role: player.role,
                  word: player.role === 'civilian' ? lobby.word : lobby.hint,
                  playerName: player.name
                }));
                
                if (lobby.phase === 'round1' || lobby.phase === 'round2') {
                  const currentPlayer = lobby.players[lobby.turn];
                  if (currentPlayer) {
                    ws.send(JSON.stringify({
                      type: 'turnUpdate',
                      phase: lobby.phase,
                      round1: lobby.round1,
                      round2: lobby.round2,
                      currentPlayer: currentPlayer.name,
                      turnEndsAt: lobby.turnEndsAt
                    }));
                    
                    if (currentPlayer.id === player.id) {
                      startTurnTimer(lobby);
                    }
                  }
                } else if (lobby.phase === 'voting') {
                  ws.send(JSON.stringify({
                    type: 'startVoting',
                    players: lobby.players.map(p => p.name)
                  }));
                } else if (lobby.phase === 'impostorGuess') {
                  // If rejoining during impostor guess phase
                  const impostor = lobby.players.find(p => p.role === 'impostor');
                  if (player.id === impostor?.id) {
                    ws.send(JSON.stringify({
                      type: 'impostorGuessPhase',
                      isImpostor: true,
                      guessEndsAt: lobby.impostorGuessEndsAt
                    }));
                  } else {
                    ws.send(JSON.stringify({
                      type: 'impostorGuessPhase',
                      isImpostor: false,
                      guessEndsAt: lobby.impostorGuessEndsAt
                    }));
                  }
                } else if (lobby.phase === 'results') {
                  const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
                  const winner = connectedPlayers.length >= 3 ? 'Game Ended' : 'Game Ended Early';
                  
                  ws.send(JSON.stringify({
                    type: 'gameEnd',
                    roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
                    secretWord: lobby.word,
                    hint: lobby.hint,
                    winner
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
        
        // Remove player from any other lobbies they might be in
        removePlayerFromAllLobbies(msg.playerId, 'Joined as spectator in another lobby');
        
        return handleSpectatorJoin(ws, msg, msg.lobbyId, connectionId);
      }

      if (msg.type === 'exitLobby') {
        if (lobbyId && lobbies[lobbyId] && player) {
          const lobby = lobbies[lobbyId];
          console.log(`Player ${player.name} exiting lobby ${lobbyId}`);
          
          const wasGameInProgress = (lobby.phase !== 'lobby' && lobby.phase !== 'results');
          
          if (player.isSpectator) {
            lobby.spectators = lobby.spectators.filter(s => s.id !== player.id);
            lobby.spectatorsWantingToJoin = lobby.spectatorsWantingToJoin.filter(id => id !== player.id);
          } else {
            lobby.players = lobby.players.filter(p => p.id !== player.id);
            lobby.restartReady = lobby.restartReady.filter(id => id !== player.id);
            
            if (lobby.owner === player.id && lobby.players.length > 0) {
              const newOwner = lobby.players.find(p => p.ws?.readyState === 1);
              if (newOwner) {
                lobby.owner = newOwner.id;
                // Update host name when owner changes
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
          
          if (lobby.players.length === 0 && lobby.spectators.length === 0) {
            delete lobbies[lobbyId];
          } else {
            if (wasGameInProgress) {
              checkGameEndConditions(lobby, lobbyId);
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
              phase: lobby.phase,
              impostorGuessOption: lobby.impostorGuessOption || false
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
          
          // FIX: Broadcast updated lobby list when player exits
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
          if (!player.wantsToJoinNextGame) {
            player.wantsToJoinNextGame = true;
            if (!lobby.spectatorsWantingToJoin.includes(player.id)) {
              lobby.spectatorsWantingToJoin.push(player.id);
            }
            
            sendRestartUpdates(lobby);
          }
        }
        return;
      }

      player.lastActionTime = Date.now();

      if (msg.type === 'toggleImpostorGuess' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        
        lobby.impostorGuessOption = msg.enabled;
        
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
          phase: lobby.phase,
          impostorGuessOption: lobby.impostorGuessOption
        });
        
        // Update lobby list with new setting
        broadcastLobbyList();
      }

      if (msg.type === 'startGame' && lobby.phase === 'lobby') {
        if (lobby.owner !== player.id) return;
        startGame(lobby);
        // Update lobby list since this lobby is no longer in lobby phase
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

        // SANITIZE INPUT: Remove HTML tags and limit length
        const sanitizedWord = String(msg.word)
          .replace(/[<>]/g, '') // Remove < and >
          .substring(0, 50)     // Limit to 50 characters
          .trim();

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

        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        
        if (lobby.phase === 'round1' && lobby.round1.length >= connectedPlayers.length) {
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
        } else if (lobby.phase === 'round2' && lobby.round2.length >= connectedPlayers.length) {
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
          
          // Check if impostor guess option is enabled and impostor was voted out
          if (ejected === impostor?.name && lobby.impostorGuessOption) {
            // Start impostor guess phase
            lobby.phase = 'impostorGuess';
            
            broadcast(lobby, {
              type: 'impostorGuessPhase',
              ejected: ejected,
              isImpostor: false,
              guessEndsAt: Date.now() + 30000
            });
            
            // Send special message to impostor
            if (impostor.ws?.readyState === 1) {
              impostor.ws.send(JSON.stringify({
                type: 'impostorGuessPhase',
                ejected: ejected,
                isImpostor: true,
                guessEndsAt: Date.now() + 30000
              }));
            }
            
            // Start the 30-second timer for impostor guess
            startImpostorGuessTimer(lobby);
            
            return;
          }
          
          // Regular game end (no impostor guess option or civilian voted out)
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
          lobby.restartReady = [];
          lobby.spectatorsWantingToJoin = [];
          lobby.lastTimeBelowThreePlayers = null;
          lobby.turnEndsAt = null;
          
          if (lobby.turnTimeout?.timer) {
            clearTimeout(lobby.turnTimeout.timer);
            lobby.turnTimeout = null;
          }
          
          // Update lobby list since this lobby is now in results phase
          broadcastLobbyList();
        }
      }

      if (msg.type === 'impostorGuess') {
        // Only accept guesses during impostor guess phase and only from impostor
        if (lobby.phase !== 'impostorGuess') return;
        
        const impostor = lobby.players.find(p => p.role === 'impostor');
        if (!impostor || player.id !== impostor.id) return;
        
        // Clear the guess timer
        if (lobby.impostorGuessTimeout?.timer) {
          clearTimeout(lobby.impostorGuessTimeout.timer);
          lobby.impostorGuessTimeout = null;
        }
        
        const guess = String(msg.guess || '').trim().toLowerCase();
        const correct = guess === lobby.word.toLowerCase();
        
        const winner = correct ? 'Impostor' : 'Civilians';
        
        broadcast(lobby, {
          type: 'gameEnd',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          votes: Object.fromEntries(lobby.players.filter(p => p.vote).map(p => [p.name, p.vote])),
          secretWord: lobby.word,
          hint: lobby.hint,
          winner,
          impostorGuess: guess,
          impostorGuessCorrect: correct
        });
        
        lobby.phase = 'results';
        lobby.restartReady = [];
        lobby.spectatorsWantingToJoin = [];
        lobby.lastTimeBelowThreePlayers = null;
        lobby.turnEndsAt = null;
        
        broadcastLobbyList();
      }

      if (msg.type === 'restart') {
        if (!isSpectator && player.role && !lobby.restartReady.includes(player.id)) {
          lobby.restartReady.push(player.id);
        }
        
        sendRestartUpdates(lobby);
        
        const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
        const playersInGame = connectedPlayers.filter(p => p.role);
        
        if (playersInGame.length > 0 && lobby.restartReady.length === playersInGame.length) {
          const spectatorsToJoin = lobby.spectators.filter(s => 
            s.ws?.readyState === 1 && s.wantsToJoinNextGame
          );
          
          spectatorsToJoin.forEach(spectator => {
            const spectatorIndex = lobby.spectators.findIndex(s => s.id === spectator.id);
            if (spectatorIndex !== -1) {
              lobby.spectators.splice(spectatorIndex, 1);
              spectator.isSpectator = false;
              spectator.wantsToJoinNextGame = false;
              spectator.role = null;
              lobby.players.push(spectator);
              
              try {
                spectator.ws.send(JSON.stringify({
                  type: 'roleChanged',
                  message: 'You are now a player for the next game!',
                  isSpectator: false
                }));
              } catch (err) {
                console.log(`Failed to send role change to ${spectator.name}`);
              }
            }
          });
          
          lobby.spectatorsWantingToJoin = [];
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
      
      // Check if this is a stale socket
      if (ws.connectionEpoch !== player.connectionEpoch) {
        console.log(`Ignoring close from stale socket for player ${player.name}`);
        return;
      }
      
      player.lastDisconnectTime = Date.now();
      
      const wasGameInProgress = (lobby.phase !== 'lobby' && lobby.phase !== 'results' && lobby.phase !== 'impostorGuess');
      
      // FIXED: Check game end conditions immediately on disconnect
      if (wasGameInProgress) {
        checkGameEndConditions(lobby, lobbyId);
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
        phase: lobby.phase,
        impostorGuessOption: lobby.impostorGuessOption || false
      });
      
      // FIX: Broadcast lobby list when player disconnects
      broadcastLobbyList();
    }
    
    // ✅ Ensure lobby list is rebroadcast when a connection closes
    broadcastLobbyList();
    
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
      replaceSocket(player, ws);
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
      player.reconnectionAttempts = (player.reconnectionAttempts || 0) + 1;
      player.connectionEpoch = (player.connectionEpoch || 0) + 1;
      ws.connectionEpoch = player.connectionEpoch;
    } else {
      // Check if name is already taken in this lobby
      const allNames = [...lobby.players, ...lobby.spectators].map(p => p.name);
      // SANITIZE: Remove HTML tags and limit length
      let uniqueName = String(msg.name)
        .replace(/[<>]/g, '') // Remove < and >
        .substring(0, 20)     // Limit to 20 characters
        .trim();
      
      // If name is taken, make it unique
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
        connectionEpoch: 1
      };
      ws.connectionEpoch = 1;
      lobby.players.push(player);
      
      if (!lobby.owner) {
        lobby.owner = msg.playerId;
      }
      
      // FIX #3: Set the host name correctly
      if (lobby.owner === msg.playerId && !lobby.hostName) {
        lobby.hostName = uniqueName;
      }
    }

    // FIX #4: Mark client as in a lobby
    ws.inLobby = true;

    if (lobby.phase === 'results') {
      setTimeout(() => {
        try {
          const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
          const winner = connectedPlayers.length >= 3 ? 'Game Ended' : 'Game Ended Early';
          
          ws.send(JSON.stringify({
            type: 'gameEnd',
            roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
            secretWord: lobby.word,
            hint: lobby.hint,
            winner
          }));
        } catch (err) {
          console.log(`Error sending game state to new player ${player.name}`);
        }
      }, 100);
    } else if (lobby.phase === 'impostorGuess') {
      setTimeout(() => {
        try {
          const impostor = lobby.players.find(p => p.role === 'impostor');
          if (player.id === impostor?.id) {
            ws.send(JSON.stringify({
              type: 'impostorGuessPhase',
              isImpostor: true,
              guessEndsAt: lobby.impostorGuessEndsAt
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'impostorGuessPhase',
              isImpostor: false,
              guessEndsAt: lobby.impostorGuessEndsAt
            }));
          }
        } catch (err) {
          console.log(`Error sending impostor guess phase to ${player.name}`);
        }
      }, 100);
    }

    ws.send(JSON.stringify({ 
      type: 'lobbyAssigned', 
      lobbyId,
      isSpectator: false,
      playerName: player.name,
      yourName: player.name,
      isOwner: lobby.owner === player.id,
      impostorGuessOption: lobby.impostorGuessOption || false
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
      phase: lobby.phase,
      impostorGuessOption: lobby.impostorGuessOption || false
    });
    
    // FIX: Broadcast updated lobby list to all clients
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
    
    const existingPlayer = lobby.players.find(p => p.id === msg.playerId);
    if (existingPlayer) {
      player = existingPlayer;
      replaceSocket(player, ws);
      player.lastDisconnectTime = null;
      player.connectionId = connectionId;
      player.connectionEpoch = (player.connectionEpoch || 0) + 1;
      ws.connectionEpoch = player.connectionEpoch;
    } else {
      let existingSpectator = lobby.spectators.find(s => s.id === msg.playerId);
      if (existingSpectator) {
        player = existingSpectator;
        replaceSocket(player, ws);
        player.lastDisconnectTime = null;
        player.connectionId = connectionId;
        player.connectionEpoch = (player.connectionEpoch || 0) + 1;
        ws.connectionEpoch = player.connectionEpoch;
      } else {
        const allNames = [...lobby.players, ...lobby.spectators].map(p => p.name);
        const baseName = msg.name || `Spectator-${Math.floor(Math.random() * 1000)}`;
        let uniqueName = baseName.trim();
        
        // Check if name is already taken in this lobby
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
          connectionEpoch: 1
        };
        ws.connectionEpoch = 1;
        lobby.spectators.push(player);
      }
    }

    // FIX #4: Mark client as in a lobby
    ws.inLobby = true;

    if (lobby.phase === 'results') {
      setTimeout(() => {
        try {
          const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
          const winner = connectedPlayers.length >= 3 ? 'Game Ended' : 'Game Ended Early';
          
          ws.send(JSON.stringify({
            type: 'gameEnd',
            roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
            secretWord: lobby.word,
            hint: lobby.hint,
            winner
          }));
        } catch (err) {
          console.log(`Error sending game state to new spectator ${player.name}`);
        }
      }, 100);
    } else if (lobby.phase === 'impostorGuess') {
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({
            type: 'impostorGuessPhase',
            isImpostor: false,
            guessEndsAt: lobby.impostorGuessEndsAt
          }));
        } catch (err) {
          console.log(`Error sending impostor guess phase to spectator ${player.name}`);
        }
      }, 100);
    }

    ws.send(JSON.stringify({ 
      type: 'lobbyAssigned', 
      lobbyId: lobbyId,
      isSpectator: player.isSpectator || false,
      playerName: player.name,
      yourName: player.name,
      isOwner: false,
      impostorGuessOption: lobby.impostorGuessOption || false
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
      phase: lobby.phase,
      impostorGuessOption: lobby.impostorGuessOption || false
    });

    if (lobby.phase !== 'lobby' && lobby.phase !== 'results' && lobby.phase !== 'impostorGuess') {
      setTimeout(() => {
        try {
          const roleToSend = player.role || 'spectator';
          const wordToSend = player.role === 'civilian' ? lobby.word : 
                            player.role === 'impostor' ? lobby.hint : 
                            lobby.word;
          
          ws.send(JSON.stringify({
            type: 'gameStart',
            role: roleToSend,
            word: wordToSend,
            hint: roleToSend === 'spectator' ? lobby.hint : undefined,
            isSpectator: roleToSend === 'spectator',
            playerName: player.name
          }));
          
          if (lobby.phase === 'round1' || lobby.phase === 'round2') {
            const currentPlayer = lobby.players[lobby.turn];
            if (currentPlayer) {
              ws.send(JSON.stringify({
                type: 'turnUpdate',
                phase: lobby.phase,
                round1: lobby.round1,
                round2: lobby.round2,
                currentPlayer: currentPlayer.name,
                turnEndsAt: lobby.turnEndsAt,
                isSpectator: roleToSend === 'spectator'
              }));
            }
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
    
    // FIX: Broadcast updated lobby list to all clients
    broadcastLobbyList();
  }

  function sendRestartUpdates(lobby) {
    const connectedPlayers = lobby.players.filter(p => p.ws?.readyState === 1);
    const playersInGame = connectedPlayers.filter(p => p.role);
    
    lobby.players.forEach(p => {
      if (p.ws?.readyState === 1) {
        try {
          p.ws.send(JSON.stringify({
            type: 'restartUpdate',
            readyCount: lobby.restartReady.length,
            totalPlayers: playersInGame.length,
            spectatorsWantingToJoin: lobby.spectatorsWantingToJoin.length,
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
            readyCount: lobby.restartReady.length,
            totalPlayers: playersInGame.length,
            spectatorsWantingToJoin: lobby.spectatorsWantingToJoin.length,
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
  
  // Send initial lobby list to client
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
        impostorGuessOption: lobby.impostorGuessOption || false
      })).filter(lobby => lobby.phase === 'lobby');
      
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