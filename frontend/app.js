const wsUrl = location.origin.replace(/^http/, 'ws');
let ws;

const nickname = document.getElementById('nickname');
const lobbyId = document.getElementById('lobbyId');
const join = document.getElementById('join');
const start = document.getElementById('start');
const players = document.getElementById('players');

const lobbyCard = document.querySelector('.lobby-card');
const gameCard = document.querySelector('.game-card');

const roleReveal = document.getElementById('roleReveal');
const roleBack = roleReveal.querySelector('.role-back');
const roleText = document.getElementById('roleText');
const wordEl = document.getElementById('word');

const round1El = document.getElementById('round1');
const round2El = document.getElementById('round2');
const turnEl = document.getElementById('turn');

const input = document.getElementById('input');
const submit = document.getElementById('submit');

const voting = document.getElementById('voting');
const results = document.getElementById('results');
const restart = document.getElementById('restart');

let playerId = localStorage.getItem('playerId');
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem('playerId', playerId);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
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

  ws.onmessage = e => {
    const d = JSON.parse(e.data);

    if (d.type === 'lobbyAssigned') lobbyId.value = d.lobbyId;

    if (d.type === 'lobbyUpdate') {
      players.innerHTML = d.players.join('<br>');
      // Disable start button for non-owners
      start.disabled = d.players.length < 3 || d.owner !== playerId;
    }

    if (d.type === 'gameStart') {
      lobbyCard.classList.add('hidden');
      gameCard.classList.remove('hidden');
      
      // Reset UI for new game
      results.innerHTML = ''; 
      restart.classList.add('hidden');
      restart.style.opacity = '1';
      restart.innerText = 'Restart Game';
      
      // Reset input and submit
      input.value = '';
      input.placeholder = 'Your word';
      submit.disabled = false;

      roleReveal.classList.remove('hidden');
      roleBack.className = `role-back ${d.role}`;

      roleText.innerHTML = d.role === 'civilian'
        ? '<span style="color:#2ecc71">Civilian</span>'
        : '<span style="color:#e74c3c">Impostor</span>';

      wordEl.textContent = capitalize(d.word);
    }

    if (d.type === 'turnUpdate') {
      // Update round displays
      round1El.innerHTML = d.round1.map(r => `${r.name}: ${capitalize(r.word)}`).join('<br>');
      round2El.innerHTML = d.round2.map(r => `${r.name}: ${capitalize(r.word)}`).join('<br>');
      
      // Handle end of round 2 transition
      if (d.currentPlayer === 'Voting Phase') {
        turnEl.textContent = 'Round Complete - Voting Starting...';
        submit.disabled = true;
        input.placeholder = 'Get ready to vote...';
        input.value = '';
      } else {
        turnEl.textContent = `Turn: ${d.currentPlayer}`;
        submit.disabled = d.currentPlayer !== nickname.value;
        input.placeholder = d.currentPlayer === nickname.value 
          ? 'Your word' 
          : `Waiting for ${d.currentPlayer}...`;
      }
    }

    if (d.type === 'startVoting') {
      // Clear the turn display when voting starts
      turnEl.textContent = 'Vote for the Impostor!';
      input.value = '';
      input.placeholder = 'Voting in progress...';
      submit.disabled = true;
      
      voting.innerHTML = '<h3>Vote</h3>' +
        d.players
          .filter(p => p !== nickname.value)
          .map(p => `<button class="vote-btn" onclick="vote('${p}', this)">${p}</button>`)
          .join('');
    }

    if (d.type === 'gameEnd') {
      // Show winner and restart button
      const winnerColor = d.winner === 'Civilians' ? '#2ecc71' : '#e74c3c';
      
      results.innerHTML =
        `<h2 style="color:${winnerColor}; text-align:center">${d.winner} Won!</h2>` +
        `<div><b>Word:</b> ${capitalize(d.secretWord)}</div>` +
        `<div><b>Hint:</b> ${capitalize(d.hint)}</div><hr>` +
        d.roles.map(r =>
          `<div style="color:${r.role==='civilian'?'#2ecc71':'#e74c3c'}">
             ${r.name}: ${r.role.charAt(0).toUpperCase() + r.role.slice(1)}
           </div>`).join('') +
        '<hr><b>Votes</b><br>' +
        Object.entries(d.votes).map(([k,v]) => `${k} \u2192 ${v}`).join('<br>');

      voting.innerHTML = '';
      restart.classList.remove('hidden');
      turnEl.textContent = 'Game Over - Results';
    }
  };

  ws.onclose = () => setTimeout(connect, 2000);
}

join.onclick = connect;

start.onclick = () => ws.send(JSON.stringify({ type: 'startGame' }));

submit.onclick = () => {
  if (!input.value.trim()) return;
  ws.send(JSON.stringify({ type: 'submitWord', word: input.value.trim() }));
  input.value = '';
};

restart.onclick = () => {
  ws.send(JSON.stringify({ type: 'restart' }));
  // Visual feedback
  restart.style.opacity = '0.5';
  restart.innerText = 'Waiting for others...';
};

window.vote = (v, btnElement) => {
  ws.send(JSON.stringify({ type: 'vote', vote: v }));
  
  // Visual feedback (grey out others)
  const buttons = document.querySelectorAll('.vote-btn');
  buttons.forEach(b => {
    if (b === btnElement) {
      b.style.background = '#fff';
      b.style.color = '#000';
      b.style.fontWeight = 'bold';
    } else {
      b.style.opacity = '0.3';
      b.style.pointerEvents = 'none';
    }
  });
};