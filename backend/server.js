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

  ws.on('message', raw => {
    const msg = JSON.parse(raw);

    if (msg.type === 'joinLobby') {
      lobbyId = msg.lobbyId || Math.floor(1000 + Math.random() * 9000).toString();
      if (!lobbies[lobbyId]) lobbies[lobbyId] = { players: [], phase: 'lobby' };
      const lobby = lobbies[lobbyId];

      player = lobby.players.find(p => p.id === msg.playerId);
      if (!player) {
        player = { id: msg.playerId, name: msg.name, ws };
        lobby.players.push(player);
      } else {
        player.ws = ws;
      }

      ws.send(JSON.stringify({ type: 'lobbyAssigned', lobbyId }));
      broadcast(lobby, { type: 'lobbyUpdate', players: lobby.players.map(p => p.name) });
      return;
    }

    if (!player) return;
    const lobby = lobbies[lobbyId];

    if (msg.type === 'startGame' && lobby.phase === 'lobby') {
      startGame(lobby);
    }

    if (msg.type === 'submitWord') {
      if (lobby.players[lobby.turn].id !== player.id) return;

      const entry = { name: player.name, word: msg.word };
      lobby.phase === 'round1' ? lobby.round1.push(entry) : lobby.round2.push(entry);

      lobby.turn++;

      if (lobby.turn >= lobby.players.length) {
        lobby.turn = 0;
        if (lobby.phase === 'round1') lobby.phase = 'round2';
        else lobby.phase = 'voting';
      }

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