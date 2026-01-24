const wsUrl = location.origin.replace(/^http/, 'ws');
let ws;

const nickname = document.getElementById('nickname');
const lobbyId = document.getElementById('lobbyId');
const join = document.getElementById('join');
const spectate = document.getElementById('spectate'); // Added
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

let isSpectator = false;
let canJoinNextGame = false;

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function joinAsPlayer() {
  isSpectator = false;
  connect('joinLobby');
}

function joinAsSpectator() {
  isSpectator = true;
  connect('joinSpectator');
}

function connect(joinType = 'joinLobby') {
  if (!nickname.value.trim()) {
    alert('Please enter a nickname');
    return;
  }
  
  if (joinType === 'joinSpectator' && !lobbyId.value.trim()) {
    alert('Please enter a lobby code to spectate');
    return;
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (joinType === 'joinSpectator') {
      ws.send(JSON.stringify({
        type: 'joinSpectator',
        name: nickname.value,
        lobbyId: lobbyId.value,
        playerId
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'joinLobby',
        name: nickname.value,
        lobbyId: lobbyId.value || undefined,
        playerId
      }));
    }
  };

  ws.onmessage = e => {
    const d = JSON.parse(e.data);

    if (d.type === 'error') {
      alert(d.message);
      return;
    }

    if (d.type === 'lobbyAssigned') {
      lobbyId.value = d.lobbyId;
      isSpectator = d.isSpectator || false;
      
      if (isSpectator) {
        nickname.value = `👁️ ${nickname.value}`;
        nickname.disabled = true;
      }
    }

    if (d.type === 'lobbyUpdate') {
      let playersHtml = '<b>Players:</b><br>' + d.players.join('<br>');
      if (d.spectators && d.spectators.length > 0) {
        playersHtml += '<br><br><b>Spectators:</b><br>' + d.spectators.join('<br>');
      }
      players.innerHTML = playersHtml;
      
      // Disable start button for non-owners and spectators
      start.disabled = isSpectator || d.players.length < 3 || d.owner !== playerId;
      
      // Hide spectate button if already spectating
      spectate.style.display = isSpectator ? 'none' : 'block';
      
      // Show game phase info
      if (d.phase && d.phase !== 'lobby') {
        players.innerHTML += `<br><br><i>Game in progress: ${d.phase}</i>`;
      }
    }

    if (d.type === 'gameStart') {
      lobbyCard.classList.add('hidden');
      gameCard.classList.remove('hidden');
      
      results.innerHTML = ''; 
      restart.classList.add('hidden');
      restart.style.opacity = '1';
      restart.innerText = 'Restart Game';
      
      input.value = '';
      submit.disabled = isSpectator || d.role === 'spectator';
      
      if (isSpectator || d.role === 'spectator') {
        input.placeholder = 'Spectator Mode - Watching Only';
        input.disabled = true;
        submit.disabled = true;
      } else {
        input.placeholder = 'Your word';
        input.disabled = false;
      }

      roleReveal.classList.remove('hidden');
      
      if (d.role === 'spectator') {
        roleBack.className = 'role-back spectator';
        roleText.innerHTML = '<span style="color:#9b59b6">👁️ Spectator</span>';
        wordEl.textContent = 'Watching Game';
      } else if (d.role === 'civilian') {
        roleBack.className = `role-back ${d.role}`;
        roleText.innerHTML = '<span style="color:#2ecc71">Civilian</span>';
        wordEl.textContent = capitalize(d.word);
      } else if (d.role === 'impostor') {
        roleBack.className = `role-back ${d.role}`;
        roleText.innerHTML = '<span style="color:#e74c3c">Impostor</span>';
        wordEl.textContent = capitalize(d.word);
      }
    }

    if (d.type === 'turnUpdate') {
      round1El.innerHTML = d.round1.map(r => `${r.name}: ${capitalize(r.word)}`).join('<br>');
      round2El.innerHTML = d.round2.map(r => `${r.name}: ${capitalize(r.word)}`).join('<br>');
      
      if (d.currentPlayer === 'Voting Phase') {
        turnEl.textContent = isSpectator ? 'Spectating - Voting Starting...' : 'Round Complete - Voting Starting...';
        submit.disabled = true;
        input.value = '';
        input.placeholder = isSpectator ? 'Spectating voting...' : 'Get ready to vote...';
      } else {
        turnEl.textContent = isSpectator ? `Spectating - Turn: ${d.currentPlayer}` : `Turn: ${d.currentPlayer}`;
        submit.disabled = isSpectator || d.currentPlayer !== nickname.value.replace('👁️ ', '');
        
        if (isSpectator) {
          input.placeholder = `Spectating - ${d.currentPlayer}'s turn`;
        } else {
          input.placeholder = d.currentPlayer === nickname.value ? 'Your word' : `Waiting for ${d.currentPlayer}...`;
        }
      }
    }

    if (d.type === 'startVoting') {
      turnEl.textContent = isSpectator ? 'Spectating - Vote for the Impostor!' : 'Vote for the Impostor!';
      input.value = '';
      input.placeholder = isSpectator ? 'Spectating votes...' : 'Voting in progress...';
      submit.disabled = true;
      
      if (isSpectator || d.isSpectator) {
        // Spectators see results but can't vote
        voting.innerHTML = '<h3>Spectating Votes</h3>' +
          d.players.map(p => `<div class="spectator-vote-btn">${p}</div>`).join('');
      } else {
        // Players can vote
        voting.innerHTML = '<h3>Vote</h3>' +
          d.players
            .filter(p => p !== nickname.value.replace('👁️ ', ''))
            .map(p => `<button class="vote-btn" onclick="vote('${p}', this)">${p}</button>`)
            .join('');
      }
    }

    if (d.type === 'gameEnd') {
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
      
      if (!isSpectator) {
        restart.classList.remove('hidden');
      } else {
        // Spectators see message about joining next game
        results.innerHTML += `<hr><div style="text-align:center; color:#9b59b6">
          <i>👁️ You are spectating. Rejoin lobby to play next game.</i>
        </div>`;
      }
      
      turnEl.textContent = isSpectator ? 'Spectating - Game Over' : 'Game Over - Results';
    }

    if (d.type === 'restartUpdate') {
      restart.innerText = `Waiting for others... (${d.readyCount}/${d.totalPlayers})`;
    }
  };

  ws.onclose = () => setTimeout(() => {
    if (!isSpectator) {
      joinAsPlayer();
    } else {
      joinAsSpectator();
    }
  }, 2000);
}

join.onclick = joinAsPlayer;
spectate.onclick = joinAsSpectator;

start.onclick = () => ws.send(JSON.stringify({ type: 'startGame' }));

submit.onclick = () => {
  if (!input.value.trim() || isSpectator) return;
  ws.send(JSON.stringify({ type: 'submitWord', word: input.value.trim() }));
  input.value = '';
};

restart.onclick = () => {
  if (isSpectator) return;
  ws.send(JSON.stringify({ type: 'restart' }));
  restart.style.opacity = '0.5';
  restart.innerText = 'Waiting for others...';
};

window.vote = (v, btnElement) => {
  if (isSpectator) return;
  ws.send(JSON.stringify({ type: 'vote', vote: v }));
  
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

// Add Enter key support
nickname.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinAsPlayer();
});

lobbyId.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinAsPlayer();
});

input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !isSpectator) submit.click();
});