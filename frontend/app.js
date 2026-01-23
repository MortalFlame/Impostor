const wsUrl = location.origin.replace(/^http/, 'ws');
let ws;

const nickname = document.getElementById('nickname');
const lobbyId = document.getElementById('lobbyId');
const join = document.getElementById('join');
const exitBtn = document.getElementById('exit');
const start = document.getElementById('start');
const players = document.getElementById('players');

const lobbyCard = document.querySelector('.lobby-card');
const gameCard = document.querySelector('.game-card');
const roleReveal = document.getElementById('roleReveal');
const wordEl = document.getElementById('word');

let playerId = localStorage.getItem('pid') || crypto.randomUUID();
localStorage.setItem('pid', playerId);

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'join',
      name: nickname.value,
      lobbyId: lobbyId.value || null,
      playerId
    }));
  };

  ws.onmessage = e => {
    const d = JSON.parse(e.data);

    if (d.type === 'joined') lobbyId.value = d.lobbyId;

    if (d.type === 'state') {
      start.disabled = d.hostId !== playerId;
      players.innerHTML = d.players.map(p =>
        `${p.name} <span class="dot ${p.connected ? 'green':'red'}"></span>`
      ).join('<br>');
    }

    if (d.type === 'gameStart') {
      lobbyCard.classList.add('hidden');
      gameCard.classList.remove('hidden');
      roleReveal.classList.remove('hidden');
      wordEl.textContent = d.word;
    }

    if (d.type === 'exited') location.reload();
  };
}

join.onclick = connect;
exitBtn.onclick = () => ws.send(JSON.stringify({ type: 'exit' }));
start.onclick = () => ws.send(JSON.stringify({ type: 'start' }));