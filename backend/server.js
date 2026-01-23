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
ws.on('close', () => {
  if (!player) return;
  player.connected = false;

  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  // broadcast player status
  broadcast(lobby, {
    type: 'playerStatus',
    players: lobby.players.map(p => ({
      name: p.name,
      connected: p.connected
    }))
  });

  // auto-advance turn if current player disconnected
  if (lobby.players[lobby.turn]?.id === player.id) {
    do {
      lobby.turn++;
      if (lobby.turn >= lobby.players.length) lobby.turn = 0;
      if (lobby.players.every(p => !p.connected)) break;
    } while (!lobby.players[lobby.turn].connected);

    broadcast(lobby, {
      type: 'turnUpdate',
      phase: lobby.phase,
      round1: lobby.round1,
      round2: lobby.round2,
      currentPlayer: lobby.players[lobby.turn]?.name
    });
  }

  // host migration if host disconnected
  if (player.id === lobby.hostId) {
    const nextHost = lobby.players.find(p => p.connected);
    if (nextHost) lobby.hostId = nextHost.id;
  }
});
  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    if (msg.type === 'joinLobby') {
  // assign lobby ID (generate if empty)
lobbyId = msg.lobbyId && msg.lobbyId.trim() ? msg.lobbyId : Math.floor(1000 + Math.random() * 9000).toString();
if (!lobbies[lobbyId]) lobbies[lobbyId] = { players: [], phase: 'lobby', hostId: null };
const lobby = lobbies[lobbyId];

  player = lobby.players.find(p => p.id === msg.playerId);
  if (!player) {
    // new player
    player = {
      id: msg.playerId,
      name: msg.name,
      ws,
      connected: true
    };
    // mid-game joiners become spectators
    if (lobby.phase !== 'lobby') player.spectator = true;

    lobby.players.push(player);

    // assign host if none exists
    if (!lobby.hostId) lobby.hostId = player.id;

  } else {
    // reconnect
    player.ws = ws;
    player.connected = true;
    delete player.spectator; // reconnecting player is no longer spectator
  }

  // BROADCAST CONNECTION STATUS
  broadcast(lobby, {
    type: 'playerStatus',
    players: lobby.players.map(p => ({
      name: p.name,
      connected: p.connected
    }))
  });

  // BROADCAST LOBBY UPDATE (with host info)
  broadcast(lobby, { 
    type: 'lobbyUpdate', 
    players: lobby.players.map(p => p.name),
    isHost: player.id === lobby.hostId
  });

  ws.send(JSON.stringify({ type: 'lobbyAssigned', lobbyId }));

  // If player joined as spectator
  if (player.spectator) {
    ws.send(JSON.stringify({
      type: 'spectator',
      phase: lobby.phase,
      round1: lobby.round1,
      round2: lobby.round2
    }));
  }
  return;
}

    if (!player) return;
    const lobby = lobbies[lobbyId];

    if (msg.type === 'startGame') {
  if (player.id !== lobby.hostId) return; // only host can start
  if (lobby.phase !== 'lobby') return; // can't restart mid-game
  startGame(lobby);
}

if (msg.type === 'submitWord') {
  if (lobby.players[lobby.turn].id !== player.id) return;

  const entry = { name: player.name, word: msg.word };
  lobby.phase === 'round1' ? lobby.round1.push(entry) : lobby.round2.push(entry);

  // NEW turn advance: skip disconnected players
  do {
    lobby.turn++;
    if (lobby.turn >= lobby.players.length) lobby.turn = 0;

    // If all players disconnected, break
    if (lobby.players.every(p => !p.connected)) break;

  } while (!lobby.players[lobby.turn].connected);

  if (lobby.phase === 'round1') lobby.phase = 'round2';
  else lobby.phase = 'voting';

  if (lobby.phase === 'voting') {
    broadcast(lobby, {
      type: 'startVoting',
      players: lobby.players.map(p => p.name)
    });
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

    if (msg.type === 'vote') {
      if (msg.vote === player.name) return;
      player.vote = msg.vote;

      if (lobby.players.every(p => p.vote)) {
        broadcast(lobby, {
          type: 'gameEnd',
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          votes: Object.fromEntries(lobby.players.map(p => [p.name, p.vote])),
          secretWord: lobby.word,
          hint: lobby.hint
        });
        lobby.phase = 'results';
      }
    }

    if (msg.type === 'restart') {
      lobby.restartReady.push(player.id);
      if (lobby.restartReady.length === lobby.players.length) {
        startGame(lobby);
      }
    }
  });
});