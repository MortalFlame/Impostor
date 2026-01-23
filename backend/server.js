const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () =>
  console.log(`Server running on ${PORT}`)
);

const wss = new WebSocketServer({ server });

const words = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8')
);

const PHASES = {
  LOBBY: 'lobby',
  ROUND1: 'round1',
  ROUND2: 'round2',
  VOTING: 'voting',
  RESULTS: 'results'
};

let lobbies = {};

function broadcast(lobby, data) {
  lobby.players.forEach(p => {
    if (p.ws?.readyState === 1) {
      p.ws.send(JSON.stringify(data));
    }
  });
}

function randomWord() {
  return words[crypto.randomInt(words.length)];
}

function createLobby(host) {
  const id = Math.floor(1000 + Math.random() * 9000).toString();
  lobbies[id] = {
    id,
    hostId: host.id,
    phase: PHASES.LOBBY,
    players: [],
    spectators: [],
    turn: 0,
    round1: [],
    round2: [],
    word: '',
    hint: ''
  };
  return lobbies[id];
}

function startGame(lobby) {
  lobby.phase = PHASES.ROUND1;
  lobby.turn = 0;
  lobby.round1 = [];
  lobby.round2 = [];

  const { word, hint } = randomWord();
  lobby.word = word;
  lobby.hint = hint;

  const impostorIndex = crypto.randomInt(lobby.players.length);

  lobby.players.forEach((p, i) => {
    p.role = i === impostorIndex ? 'impostor' : 'civilian';
    p.vote = null;
    p.ws.send(JSON.stringify({
      type: 'gameStart',
      word: p.role === 'civilian' ? word : hint
    }));
  });

  broadcast(lobby, statePayload(lobby));
}

function statePayload(lobby) {
  return {
    type: 'state',
    phase: lobby.phase,
    hostId: lobby.hostId,
    players: lobby.players.map(p => ({
      name: p.name,
      connected: p.connected
    })),
    round1: lobby.round1,
    round2: lobby.round2,
    currentPlayer: lobby.players[lobby.turn]?.name
  };
}

function migrateHost(lobby) {
  const next = lobby.players.find(p => p.connected);
  if (next) lobby.hostId = next.id;
}

wss.on('connection', ws => {
  let player, lobby;

  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    if (msg.type === 'join') {
      player = {
        id: msg.playerId,
        name: msg.name,
        ws,
        connected: true
      };

      lobby = msg.lobbyId && lobbies[msg.lobbyId]
        ? lobbies[msg.lobbyId]
        : createLobby(player);

      const existing = lobby.players.find(p => p.id === player.id);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        ws.send(JSON.stringify(statePayload(lobby)));
        return;
      }

      if (lobby.phase !== PHASES.LOBBY) {
        lobby.spectators.push(player);
        ws.send(JSON.stringify({ type: 'spectator' }));
        return;
      }

      lobby.players.push(player);

      ws.send(JSON.stringify({ type: 'joined', lobbyId: lobby.id }));
      broadcast(lobby, statePayload(lobby));
    }

    if (!player || !lobby) return;

    if (msg.type === 'exit') {
      lobby.players = lobby.players.filter(p => p.id !== player.id);
      if (player.id === lobby.hostId) migrateHost(lobby);
      ws.send(JSON.stringify({ type: 'exited' }));
      broadcast(lobby, statePayload(lobby));
    }

    if (msg.type === 'start' && player.id === lobby.hostId) {
      if (lobby.players.length >= 3) startGame(lobby);
    }

    if (msg.type === 'word') {
      if (lobby.players[lobby.turn]?.id !== player.id) return;

      const entry = { name: player.name, word: msg.word };
      (lobby.phase === PHASES.ROUND1 ? lobby.round1 : lobby.round2).push(entry);

      lobby.turn++;
      if (lobby.turn >= lobby.players.length) {
        lobby.turn = 0;
        lobby.phase =
          lobby.phase === PHASES.ROUND1
            ? PHASES.ROUND2
            : PHASES.VOTING;
      }

      broadcast(lobby, statePayload(lobby));
    }

    if (msg.type === 'vote') {
      player.vote = msg.vote;
      if (lobby.players.every(p => p.vote)) {
        lobby.phase = PHASES.RESULTS;
        broadcast(lobby, {
          type: 'results',
          word: lobby.word,
          hint: lobby.hint,
          players: lobby.players
        });
      }
    }

    if (msg.type === 'restart') {
      lobby.players.push(...lobby.spectators);
      lobby.spectators = [];
      startGame(lobby);
    }
  });

  ws.on('close', () => {
    if (player) {
      player.connected = false;
      if (player.id === lobby.hostId) migrateHost(lobby);
      broadcast(lobby, statePayload(lobby));
    }
  });
});