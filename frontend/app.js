const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
const $ = id => document.getElementById(id);

const playerId = crypto.randomUUID();
let myName = '';

$('joinBtn').onclick = () => {
  myName = $('name').value;
  ws.send(JSON.stringify({
    type: 'joinLobby',
    name: myName,
    lobbyId: $('lobby').value,
    playerId
  }));
};

$('startBtn').onclick = () => ws.send(JSON.stringify({ type: 'startGame' }));

$('submitBtn').onclick = () => {
  ws.send(JSON.stringify({ type: 'submitWord', word: $('wordInput').value }));
  $('wordInput').value = '';
};

$('restartBtn').onclick = () => ws.send(JSON.stringify({ type: 'restart' }));

ws.onmessage = e => {
  const d = JSON.parse(e.data);

  if (d.type === 'lobbyAssigned') $('lobby').value = d.lobbyId;

  if (d.type === 'lobbyUpdate') {
    $('players').innerHTML = d.players.map(p => `<div>${p}</div>`).join('');
  }

  if (d.type === 'gameStart') {
    $('lobbyScreen').classList.add('hidden');
    $('gameScreen').classList.remove('hidden');

    $('role').innerText = d.role.toUpperCase();
    $('role').className = d.role;
    $('secret').innerText = d.word;
  }

  if (d.type === 'turnUpdate') {
    $('turn').innerText = `Turn: ${d.currentPlayer}`;
    $('round1').innerHTML = d.round1.map(r => `<div>${r.name}: ${r.word}</div>`).join('');
    $('round2').innerHTML = d.round2.map(r => `<div>${r.name}: ${r.word}</div>`).join('');
  }

  if (d.type === 'startVoting') {
    $('voting').innerHTML = d.players
      .filter(p => p !== myName)
      .map(p => `<button onclick="vote('${p}')">${p}</button>`)
      .join('');
  }

  if (d.type === 'gameEnd') {
    $('results').innerHTML = `
      <h2>Game Over</h2>
      <div>Word: ${d.secretWord}</div>
      <div>Hint: ${d.hint}</div>
      <div>${Object.entries(d.votes).map(v => `${v[0]} → ${v[1]}`).join('<br>')}</div>
    `;
    $('voting').innerHTML = '';
  }
};

window.vote = name => {
  ws.send(JSON.stringify({ type: 'vote', vote: name }));
};