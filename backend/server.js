const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static('../frontend'));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log('Server running on', PORT));
const wss = new WebSocketServer({ server });

const words = JSON.parse(fs.readFileSync(__dirname + '/words.json', 'utf8'));

const TURN_TIMEOUT = 30000;
const RECONNECT_TIMEOUT = 30000;

const PHASES = {
  LOBBY: 'lobby',
  ROUND1: 'round1',
  ROUND2: 'round2',
  VOTING: 'voting',
  RESULTS: 'results'
};

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
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(data));
    }
  });
}

function getState(lobby) {
  return {
    type: 'state',
    phase: lobby.phase,
    players: lobby.players.map(p => ({
      name: p.name,
      connected: p.connected,
      spectator: p.spectator
    })),
    round1: lobby.round1,
    round2: lobby.round2,
    currentPlayer: lobby.players[lobby.turn]?.name || null
  };
}

function startGame(lobby) {
  lobby.phase = PHASES.ROUND1;
  lobby.turn = 0;
  lobby.round1 = [];
  lobby.round2 = [];
  lobby.turnStartedAt = Date.now();

  const { word, hint } = getRandomWord();
  lobby.word = word;
  lobby.hint = hint;

  const active = lobby.players.filter(p => !p.spectator);
  const impostorIndex = crypto.randomInt(active.length);

  active.forEach((p, i) => {
    p.role = i === impostorIndex ? 'impostor' : 'civilian';
    p.vote = null;
    p.ws?.send(JSON.stringify({
      type: 'gameStart',
      role: p.role,
      word: p.role === 'civilian' ? word : hint
    }));
  });

  broadcast(lobby, getState(lobby));
}

/* ================= WEBSOCKET ================= */

wss.on('connection', ws => {
  let lobby, player;

  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    /* JOIN */
    if (msg.type === 'join') {
      const id = msg.lobbyId || crypto.randomInt(1000, 9999).toString();
      lobby = lobbies[id] ||= {
        id,
        hostId: msg.playerId,
        players: [],
        phase: PHASES.LOBBY
      };

      player = lobby.players.find(p => p.id === msg.playerId);
      if (!player) {
        player = {
          id: msg.playerId,
          name: msg.name,
          ws,
          connected: true,
          spectator: lobby.phase !== PHASES.LOBBY
        };
        lobby.players.push(player);
      } else {
        player.ws = ws;
        player.connected = true;
      }

      ws.send(JSON.stringify({ type: 'joined', lobbyId: id, host: lobby.hostId }));
      broadcast(lobby, getState(lobby));
    }

    if (!player || !lobby) return;
    player.lastActionAt = Date.now();

    /* START GAME */
    if (msg.type === 'start' && lobby.phase === PHASES.LOBBY) {
      if (player.id !== lobby.hostId) return;
      startGame(lobby);
    }

    /* WORD */
    if (msg.type === 'word' && lobby.players[lobby.turn]?.id === player.id) {
      (lobby.phase === PHASES.ROUND1 ? lobby.round1 : lobby.round2)
        .push({ name: player.name, word: msg.word });

      lobby.turn++;
      lobby.turnStartedAt = Date.now();

      if (lobby.turn >= lobby.players.filter(p => !p.spectator).length) {
        lobby.turn = 0;
        lobby.phase =
          lobby.phase === PHASES.ROUND1 ? PHASES.ROUND2 : PHASES.VOTING;
      }

      broadcast(lobby, getState(lobby));
    }

    /* VOTE */
    if (msg.type === 'vote') {
      player.vote = msg.vote;
      if (lobby.players.every(p => p.vote || p.spectator)) {
        broadcast(lobby, {
          type: 'results',
          word: lobby.word,
          hint: lobby.hint,
          roles: lobby.players.map(p => ({ name: p.name, role: p.role })),
          votes: Object.fromEntries(lobby.players.map(p => [p.name, p.vote]))
        });
        lobby.phase = PHASES.RESULTS;
      }
    }

    /* EXIT */
    if (msg.type === 'exit') {
      lobby.players = lobby.players.filter(p => p.id !== player.id);
      if (lobby.hostId === player.id && lobby.players[0]) {
        lobby.hostId = lobby.players[0].id;
      }
      broadcast(lobby, getState(lobby));
    }
  });

  ws.on('close', () => {
    if (!player) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
  });
});

/* ================= AFK HANDLER ================= */

setInterval(() => {
  Object.values(lobbies).forEach(lobby => {
    if (![PHASES.ROUND1, PHASES.ROUND2, PHASES.VOTING].includes(lobby.phase)) return;
    if (Date.now() - lobby.turnStartedAt < TURN_TIMEOUT) return;

    const p = lobby.players[lobby.turn];
    if (!p) return;

    if (lobby.phase === PHASES.VOTING) {
      p.vote = null;
    } else {
      (lobby.phase === PHASES.ROUND1 ? lobby.round1 : lobby.round2)
        .push({ name: p.name, word: '...' });
    }

    lobby.turn++;
    lobby.turnStartedAt = Date.now();
    broadcast(lobby, getState(lobby));
  });
}, 1000);

/* ================= CLEANUP ================= */

setInterval(() => {
  const now = Date.now();
  Object.values(lobbies).forEach(lobby => {
    lobby.players = lobby.players.filter(p =>
      p.connected || now - p.disconnectedAt < RECONNECT_TIMEOUT
    );
  });
}, 5000);