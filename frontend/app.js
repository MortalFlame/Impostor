const wsUrl = location.origin.replace(/^http/, 'ws');
let ws;
let playerId = localStorage.getItem('playerId');
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem('playerId', playerId);
}

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'joinLobby',
      name: nickname.value,
      lobbyId: lobbyId.value || undefined,
      playerId
    }));
  };

  ws.onclose = () => {
    setTimeout(connect, 2000); // auto reconnect
  };

  ws.onmessage = e => {
    const d = JSON.parse(e.data);

    if (d.type === 'lobbyAssigned') lobbyId.value = d.lobbyId;

    if (d.type === 'lobbyUpdate') {
      players.innerHTML = d.players.join('<br>');
      start.disabled = d.players.length < 3;
    }

    if (d.type === 'gameStart') {
      role.innerHTML = d.role === 'civilian'
        ? '<span class="green">Civilian</span>'
        : '<span class="red">Impostor</span>';
      word.textContent = d.word;
    }

    if (d.type === 'turnUpdate') {
      rounds.innerHTML =
        `<b>Round 1</b><br>` + d.round1.map(x => `${x.name}: ${x.word}`).join('<br>') +
        `<br><br><b>Round 2</b><br>` + d.round2.map(x => `${x.name}: ${x.word}`).join('<br>');
      turn.textContent = `Turn: ${d.currentPlayer}`;
      submit.disabled = d.currentPlayer !== nickname.value;
    }

    if (d.type === 'startVoting') {
      voting.innerHTML = d.players.map(p =>
        `<button onclick="vote('${p}')">${p}</button>`).join('');
    }

    if (d.type === 'gameEnd') {
      results.innerHTML = `<b>Game Over</b><br>` +
        d.roles.map(r => `${r.name}: ${r.role}`).join('<br>') +
        `<br><br>Votes:<br>` +
        Object.entries(d.votes).map(([k,v]) => `${k} → ${v}`).join('<br>');
    }
  };
}

join.onclick = connect;
start.onclick = () => ws.send(JSON.stringify({ type: 'startGame' }));
submit.onclick = () => ws.send(JSON.stringify({ type: 'submitWord', word: input.value }));
function vote(v) { ws.send(JSON.stringify({ type: 'vote', vote: v })); }
restart.onclick = () => ws.send(JSON.stringify({ type: 'restart' }));