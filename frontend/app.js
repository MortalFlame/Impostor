const wsUrl = location.origin.replace(/^http/, 'ws');
let ws;

const nickname = document.getElementById('nickname');
const lobbyId = document.getElementById('lobbyId');
const join = document.getElementById('join');
const spectate = document.getElementById('spectate');
const start = document.getElementById('start');
const exitLobbyBtn = document.getElementById('exitLobby');
const players = document.getElementById('players');

const gameHeader = document.getElementById('gameHeader');
const lobbyCodeDisplay = document.getElementById('lobbyCodeDisplay');
const playerNameDisplay = document.getElementById('playerNameDisplay');
const connectionDot = document.getElementById('connectionDot');
const connectionText = document.getElementById('connectionText');

const lobbyCard = document.querySelector('.lobby-card');
const gameCard = document.querySelector('.game-card');
const roleReveal = document.getElementById('roleReveal');
const roleBack = roleReveal.querySelector('.role-back');
const roleText = document.getElementById('roleText');
const wordEl = document.getElementById('word');
const round1El = document.getElementById('round1');
const round2El = document.getElementById('round2');
const turnEl = document.getElementById('turn');
const turnTimerEl = document.getElementById('turnTimer');
const timerProgress = turnTimerEl.querySelector('.timer-progress');
const timerText = turnTimerEl.querySelector('.timer-text');
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
let isReconnecting = false;
let currentLobbyId = null;
let joinType = 'joinLobby';
let connectionAttempts = 0;
let maxConnectionAttempts = 15;
let reconnectDelay = 2000;
let hasShownConnectionWarning = false;
let hasClickedRestart = false;
let turnTimer = null;
let currentTurnTime = 30;
let spectatorWantsToJoin = false;
let myPlayerName = '';
let spectatorHasClickedRestart = false;

let lastPingTime = 0;
let connectionLatency = 0;
let connectionStable = true;
let connectionState = 'disconnected';

const DEBUG_MODE = false;

function safeLog(...args) {
  if (DEBUG_MODE) {
    console.log(...args);
  }
}

function safeError(...args) {
  if (DEBUG_MODE) {
    console.error(...args);
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function updateConnectionStatus(state, message = '') {
  connectionState = state;
  
  connectionDot.className = 'status-dot ' + state;
  
  const statusMessages = {
    'disconnected': 'Disconnected',
    'connecting': 'Connecting...',
    'connected': 'Connected'
  };
  
  connectionText.textContent = message || statusMessages[state] || 'Unknown';
  
  if (state === 'disconnected') {
    lobbyCodeDisplay.style.color = '#e74c3c';
    lobbyCodeDisplay.style.borderColor = '#e74c3c';
  } else if (state === 'connected') {
    lobbyCodeDisplay.style.color = '#2ecc71';
    lobbyCodeDisplay.style.borderColor = '#2ecc71';
  } else {
    lobbyCodeDisplay.style.color = '#f39c12';
    lobbyCodeDisplay.style.borderColor = '#f39c12';
  }
}

function showConnectionWarning(message) {
  if (hasShownConnectionWarning) return;
  
  const warning = document.createElement('div');
  warning.style.cssText = `
    position: fixed;
    top: 50px;
    left: 50%;
    transform: translateX(-50%);
    background: #e74c3c;
    color: white;
    padding: 10px 20px;
    border-radius: 5px;
    z-index: 1000;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    animation: fadeIn 0.3s;
  `;
  warning.textContent = message;
  document.body.appendChild(warning);
  
  hasShownConnectionWarning = true;
  setTimeout(() => {
    if (warning.parentNode) {
      warning.style.opacity = '0';
      warning.style.transition = 'opacity 0.5s';
      setTimeout(() => {
        if (warning.parentNode) {
          warning.parentNode.removeChild(warning);
        }
      }, 500);
    }
  }, 5000);
}

function updateTimerColor(timeLeft) {
  timerProgress.classList.remove('green', 'yellow', 'orange', 'red');
  
  if (timeLeft > 20) {
    timerProgress.classList.add('green');
  } else if (timeLeft > 15) {
    timerProgress.classList.add('yellow');
  } else if (timeLeft > 5) {
    timerProgress.classList.add('orange');
  } else {
    timerProgress.classList.add('red');
  }
}

function startTurnTimer(seconds) {
  if (turnTimer) clearInterval(turnTimer);
  
  let timeLeft = seconds;
  currentTurnTime = seconds;
  
  turnTimerEl.classList.remove('hidden');
  
  const circumference = 2 * Math.PI * 18;
  
  updateTimerDisplay(timeLeft, circumference);
  
  turnTimer = setInterval(() => {
    timeLeft--;
    
    if (timeLeft <= 0) {
      clearInterval(turnTimer);
      turnTimer = null;
      turnTimerEl.classList.add('hidden');
      if (!isSpectator && submit.disabled === false) {
        turnEl.textContent = 'Time expired! Waiting for next player...';
      }
    } else {
      updateTimerDisplay(timeLeft, circumference);
    }
  }, 1000);
}

function updateTimerDisplay(timeLeft, circumference) {
  timerText.textContent = '';
  
  updateTimerColor(timeLeft);
  
  const progress = (timeLeft / currentTurnTime) * 100;
  
  const offset = circumference - (progress / 100) * circumference;
  timerProgress.style.strokeDashoffset = offset;
  
  timerProgress.style.display = 'none';
  timerProgress.offsetHeight;
  timerProgress.style.display = '';
}

function stopTurnTimer() {
  if (turnTimer) {
    clearInterval(turnTimer);
    turnTimer = null;
  }
  turnTimerEl.classList.add('hidden');
}

function updatePlayerList(playersData, spectatorsData = []) {
  let playersHtml = '';
  
  if (Array.isArray(playersData) && playersData.length > 0) {
    playersHtml += '<b>Players (' + playersData.length + '):</b>';
    playersHtml += '<div class="player-grid">';
    
    playersData.forEach(player => {
      const isConnected = player.connected !== false;
      const statusClass = isConnected ? 'player-connected' : 'player-disconnected';
      const isMe = player.name === myPlayerName;
      const nameDisplay = isMe ? `<strong>${player.name}</strong>` : player.name;
      
      playersHtml += `
        <div class="player-item">
          <span class="player-status-dot ${statusClass}"></span>
          <span class="player-name" title="${player.name}">${nameDisplay}</span>
        </div>
      `;
    });
    
    playersHtml += '</div>';
  } else {
    playersHtml += '<b>Players (0):</b><br>No players yet';
  }
  
  if (spectatorsData && spectatorsData.length > 0) {
    playersHtml += '<br><b>Spectators (' + spectatorsData.length + '):</b>';
    playersHtml += '<div class="player-grid">';
    
    spectatorsData.forEach(spectator => {
      const isConnected = spectator.connected !== false;
      const statusClass = isConnected ? 'player-connected' : 'player-disconnected';
      const isMe = spectator.name === myPlayerName;
      const nameDisplay = isMe ? `<strong>${spectator.name}</strong>` : spectator.name;
      
      playersHtml += `
        <div class="player-item spectator-item">
          <span class="player-status-dot ${statusClass}"></span>
          <span class="player-name" title="${spectator.name}">${nameDisplay}</span>
        </div>
      `;
    });
    
    playersHtml += '</div>';
  }
  
  players.innerHTML = playersHtml;
}

function exitLobby() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'exitLobby' }));
    } catch (err) {
      // Ignore send errors
    }
    
    try {
      ws.close(1000, 'User exited lobby');
    } catch (err) {
      // Ignore close errors
    }
  }
  
  lobbyCard.classList.remove('hidden');
  gameCard.classList.add('hidden');
  gameHeader.classList.add('hidden');
  
  nickname.value = nickname.value.replace('👁️ ', '');
  nickname.disabled = false;
  lobbyId.value = '';
  players.innerHTML = '';
  
  isSpectator = false;
  currentLobbyId = null;
  isReconnecting = false;
  connectionAttempts = 0;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  myPlayerName = '';
  updateConnectionStatus('disconnected');
  
  stopTurnTimer();
  
  if (window.pingInterval) {
    clearInterval(window.pingInterval);
    window.pingInterval = null;
  }
  
  safeLog('Exited lobby');
}

function resetToLobbyScreen() {
  lobbyCard.classList.remove('hidden');
  gameCard.classList.add('hidden');
  gameHeader.classList.add('hidden');
  
  nickname.value = nickname.value.replace('👁️ ', '');
  nickname.disabled = false;
  lobbyId.value = '';
  players.innerHTML = '';
  
  isSpectator = false;
  currentLobbyId = null;
  isReconnecting = false;
  connectionAttempts = 0;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  myPlayerName = '';
  updateConnectionStatus('disconnected');
  
  stopTurnTimer();
  
  if (window.pingInterval) {
    clearInterval(window.pingInterval);
    window.pingInterval = null;
  }
}

function joinAsPlayer() {
  if (isReconnecting) return;
  isSpectator = false;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  joinType = 'joinLobby';
  connectionAttempts = 0;
  reconnectDelay = 2000;
  connect();
}

function joinAsSpectator() {
  if (isReconnecting) return;
  isSpectator = true;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  joinType = 'joinSpectator';
  connectionAttempts = 0;
  reconnectDelay = 2000;
  connect();
}

function connect() {
  if (isReconnecting && connectionAttempts >= maxConnectionAttempts) {
    safeLog('Max reconnection attempts reached');
    showConnectionWarning('Connection failed. Please refresh the page.');
    resetToLobbyScreen();
    return;
  }

  if (!nickname.value.trim()) {
    alert('Please enter a nickname');
    return;
  }
  
  if (joinType === 'joinSpectator' && !lobbyId.value.trim()) {
    alert('Please enter a lobby code to spectate');
    return;
  }

  try {
    updateConnectionStatus('connecting', 'Connecting to server...');
    
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close(1000, 'Reconnecting');
      } catch (err) {
        // Ignore
      }
    }
    
    ws = new WebSocket(wsUrl);
    connectionAttempts++;
    
    ws.onopen = () => {
      safeLog('Game connection established');
      connectionAttempts = 0;
      reconnectDelay = 2000;
      isReconnecting = false;
      hasShownConnectionWarning = false;
      updateConnectionStatus('connected');
      
      gameHeader.classList.remove('hidden');
      
      if (window.pingInterval) clearInterval(window.pingInterval);
      window.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          lastPingTime = Date.now();
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
          } catch (err) {
            safeError('Failed to send ping');
          }
        }
      }, 25000);
      
      if (joinType === 'joinSpectator') {
        ws.send(JSON.stringify({
          type: 'joinSpectator',
          name: nickname.value.trim(),
          lobbyId: lobbyId.value.trim(),
          playerId
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'joinLobby',
          name: nickname.value.trim(),
          lobbyId: lobbyId.value || undefined,
          playerId
        }));
      }
    };

    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        safeLog('Game update received:', d.type);

        if (d.type === 'pong') {
          connectionLatency = Date.now() - lastPingTime;
          connectionStable = connectionLatency < 1000;
          if (!connectionStable) {
            updateConnectionStatus('connected', 'Poor connection');
          } else {
            updateConnectionStatus('connected');
          }
          return;
        }

        if (d.type === 'error') {
          if (!isReconnecting) {
            alert(d.message);
          }
          return;
        }

        if (d.type === 'lobbyExited') {
          safeLog('Successfully exited lobby:', d.message);
          resetToLobbyScreen();
          return;
        }

        if (d.type === 'lobbyAssigned') {
          lobbyId.value = d.lobbyId;
          currentLobbyId = d.lobbyId;
          isSpectator = d.isSpectator || false;
          myPlayerName = d.yourName || d.playerName || nickname.value.trim();
          
          lobbyCodeDisplay.textContent = d.lobbyId;
          
          if (document.getElementById('playerNameDisplay')) {
            document.getElementById('playerNameDisplay').textContent = myPlayerName;
          }
          
          if (isSpectator) {
            nickname.value = nickname.value.startsWith('👁️ ') ? nickname.value : `👁️ ${nickname.value.trim()}`;
            nickname.disabled = true;
          }
        }

        if (d.type === 'lobbyUpdate') {
          updatePlayerList(d.players, d.spectators);
          
          const isOwner = d.owner === playerId;
          start.disabled = isSpectator || d.players.length < 3 || !isOwner;
          
          spectate.style.display = isSpectator ? 'none' : 'block';
          join.style.display = isSpectator ? 'none' : 'block';
          
          exitLobbyBtn.style.display = 'block';
          
          if (d.phase && d.phase !== 'lobby') {
            players.innerHTML += `<br><i style="color:#f39c12">Game in progress: ${d.phase}</i>`;
          }
          
          if (isSpectator && (d.phase === 'lobby' || d.phase === 'results')) {
            players.innerHTML += `<br><i style="color:#9b59b6">Click "Join Next Game" to play next round</i>`;
          }
        }

        if (d.type === 'gameStart') {
          lobbyCard.classList.add('hidden');
          gameCard.classList.remove('hidden');
          
          exitLobbyBtn.style.display = 'none';
          
          hasClickedRestart = false;
          spectatorHasClickedRestart = false;
          spectatorWantsToJoin = false;
          
          if (d.playerName) {
            myPlayerName = d.playerName;
            if (document.getElementById('playerNameDisplay')) {
              document.getElementById('playerNameDisplay').textContent = myPlayerName;
            }
          }
          
          results.innerHTML = ''; 
          restart.classList.add('hidden');
          restart.style.opacity = '1';
          
          if (isSpectator || d.role === 'spectator') {
            restart.innerText = 'Join Next Game';
            restart.classList.remove('hidden');
            restart.disabled = false;
            restart.style.opacity = '1';
          } else {
            restart.innerText = 'Restart Game';
            restart.classList.add('hidden');
          }
          
          input.value = '';
          
          if (isSpectator || d.role === 'spectator') {
            input.placeholder = 'Spectator Mode - Watching Only';
            input.disabled = true;
            submit.disabled = true;
          } else {
            input.placeholder = 'Your word';
            input.disabled = false;
            submit.disabled = false;
          }

          roleReveal.classList.remove('hidden');
          
          if (d.role === 'spectator') {
            roleBack.className = 'role-back spectator';
            roleText.innerHTML = '<span style="color:#9b59b6">👁️ Spectator</span>';
            wordEl.innerHTML = `<div style="margin-bottom: 5px;"><strong>Word:</strong> ${capitalize(d.word)}</div>`;
            if (d.hint) {
              wordEl.innerHTML += `<div><strong>Hint:</strong> ${capitalize(d.hint)}</div>`;
            }
          } else if (d.role === 'civilian') {
            roleBack.className = `role-back ${d.role}`;
            roleText.innerHTML = '<span style="color:#2ecc71">Civilian</span>';
            wordEl.textContent = `Word: ${capitalize(d.word)}`;
          } else if (d.role === 'impostor') {
            roleBack.className = `role-back ${d.role}`;
            roleText.innerHTML = '<span style="color:#e74c3c">Impostor</span>';
            wordEl.textContent = `Hint: ${capitalize(d.word)}`;
          }
        }

        if (d.type === 'turnUpdate') {
          const formatWord = (entry) => {
            if (entry.word === '' || entry.word === null || entry.word === undefined) {
              return `${entry.name}: (skipped)`;
            }
            return `${entry.name}: ${capitalize(entry.word)}`;
          };
          
          round1El.innerHTML = d.round1.map(formatWord).join('<br>');
          round2El.innerHTML = d.round2.map(formatWord).join('<br>');
          
          stopTurnTimer();
          
          if (d.currentPlayer === 'Voting Phase') {
            turnEl.textContent = isSpectator ? 'Spectating - Voting Starting...' : 'Round Complete - Voting Starting...';
            submit.disabled = true;
            input.value = '';
            input.placeholder = isSpectator ? 'Spectating voting...' : 'Get ready to vote...';
          } else {
            const isMyTurn = d.currentPlayer === myPlayerName;
            
            if (isSpectator) {
              turnEl.textContent = `Spectating - Turn: ${d.currentPlayer}`;
              submit.disabled = true;
              input.placeholder = `Spectating - ${d.currentPlayer}'s turn`;
            } else {
              turnEl.textContent = isMyTurn ? `Your Turn: ${d.currentPlayer}` : `Turn: ${d.currentPlayer}`;
              submit.disabled = !isMyTurn;
              input.placeholder = isMyTurn ? 'Your word (30s)' : `Waiting for ${d.currentPlayer}...`;
              
              if (isMyTurn && d.timeRemaining) {
                startTurnTimer(d.timeRemaining);
              }
            }
          }
        }

        if (d.type === 'startVoting') {
          stopTurnTimer();
          
          turnEl.textContent = isSpectator ? 'Spectating - Vote for the Impostor!' : 'Vote for the Impostor!';
          input.value = '';
          input.placeholder = isSpectator ? 'Spectating votes...' : 'Voting in progress...';
          submit.disabled = true;
          
          if (isSpectator || d.isSpectator) {
            voting.innerHTML = '<h3>Spectating Votes</h3>' +
              d.players.map(p => `<div class="spectator-vote-btn">${p}</div>`).join('');
          } else {
            voting.innerHTML = '<h3>Vote</h3>' +
              d.players
                .filter(p => p !== myPlayerName)
                .map(p => `<button class="vote-btn" onclick="vote('${p}', this)">${p}</button>`)
                .join('');
          }
        }

        if (d.type === 'gameEndEarly') {
          stopTurnTimer();
          
          const winnerColor = d.winner === 'Civilians' ? '#2ecc71' : '#e74c3c';
          let reasonText = '';
          
          if (d.reason === 'not_enough_players') {
            reasonText = `<div style="color:#f39c12; text-align:center; margin-bottom:10px;">
              <i>Game ended: Not enough players (minimum 3 required)</i>
            </div>`;
          } else if (d.reason === 'impostor_left') {
            reasonText = `<div style="color:#f39c12; text-align:center; margin-bottom:10px;">
              <i>Game ended: Impostor left the game</i>
            </div>`;
          }
          
          // Check if we have a role (were in the game)
          const myRoleInfo = d.roles.find(r => r.name === myPlayerName);
          
          let rolesHtml = '<div class="results-grid">';
          d.roles.forEach(r => {
            const roleColor = r.role === 'civilian' ? '#2ecc71' : '#e74c3c';
            const roleName = r.role.charAt(0).toUpperCase() + r.role.slice(1);
            rolesHtml += `
              <div class="role-results-item" style="color:${roleColor}">
                <span class="player-name">${r.name}</span>
                <span class="player-role">${roleName}</span>
              </div>
            `;
          });
          rolesHtml += '</div>';
          
          results.innerHTML =
            `<h2 style="color:${winnerColor}; text-align:center">${d.winner} Won!</h2>` +
            reasonText +
            `<div><b>Word:</b> ${capitalize(d.secretWord)}</div>` +
            `<div><b>Hint:</b> ${capitalize(d.hint)}</div><hr>` +
            '<b>Roles</b><br>' + rolesHtml;

          voting.innerHTML = '';
          
          exitLobbyBtn.style.display = 'block';
          
          // NEW: Handle restart button state based on spectator status and role
          if (isSpectator) {
            restart.classList.remove('hidden');
            if (spectatorWantsToJoin) {
              // Spectator has already clicked to join next game
              restart.innerText = 'Joining next game...';
              restart.disabled = true;
              restart.style.opacity = '0.7';
            } else {
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
            }
            spectatorHasClickedRestart = false;
          } else if (myRoleInfo) {
            // Player was in the game
            restart.classList.remove('hidden');
            restart.innerText = 'Restart Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          } else {
            // New player (joined during results)
            restart.classList.remove('hidden');
            restart.innerText = 'Join Next Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          }
          
          turnEl.textContent = 'Game Ended Early';
        }

        if (d.type === 'gameEnd') {
          stopTurnTimer();
          
          const winnerColor = d.winner === 'Civilians' ? '#2ecc71' : '#e74c3c';
          
          // Check if we have a role (were in the game)
          const myRoleInfo = d.roles.find(r => r.name === myPlayerName);
          
          let rolesHtml = '<div class="results-grid">';
          d.roles.forEach(r => {
            const roleColor = r.role === 'civilian' ? '#2ecc71' : '#e74c3c';
            const roleName = r.role.charAt(0).toUpperCase() + r.role.slice(1);
            rolesHtml += `
              <div class="role-results-item" style="color:${roleColor}">
                <span class="player-name">${r.name}</span>
                <span class="player-role">${roleName}</span>
              </div>
            `;
          });
          rolesHtml += '</div>';
          
          let votesHtml = '<div class="results-grid">';
          if (d.votes) {
            Object.entries(d.votes).forEach(([voter, votedFor]) => {
              const voterRole = d.roles.find(r => r.name === voter)?.role;
              const votedForRole = d.roles.find(r => r.name === votedFor)?.role;
              
              const voterColor = voterRole === 'civilian' ? '#2ecc71' : '#e74c3c';
              const votedForColor = votedForRole === 'civilian' ? '#2ecc71' : '#e74c3c';
              
              votesHtml += `
                <div class="vote-results-item">
                  <span class="vote-voter" style="color:${voterColor}">${voter}</span>
                  <div class="vote-arrow">→</div>
                  <span class="vote-voted" style="color:${votedForColor}">${votedFor}</span>
                </div>
              `;
            });
          }
          votesHtml += '</div>';
          
          results.innerHTML =
            `<h2 style="color:${winnerColor}; text-align:center">${d.winner} Won!</h2>` +
            `<div><b>Word:</b> ${capitalize(d.secretWord)}</div>` +
            `<div><b>Hint:</b> ${capitalize(d.hint)}</div><hr>` +
            '<b>Roles</b><br>' + rolesHtml +
            (d.votes ? '<hr><b>Votes</b><br>' + votesHtml : '') +
            '<br><br>';

          voting.innerHTML = '';
          
          exitLobbyBtn.style.display = 'block';
          
          // NEW: Handle restart button state based on spectator status and role
          if (isSpectator) {
            restart.classList.remove('hidden');
            if (spectatorWantsToJoin) {
              // Spectator has already clicked to join next game
              restart.innerText = 'Joining next game...';
              restart.disabled = true;
              restart.style.opacity = '0.7';
            } else {
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
            }
            spectatorHasClickedRestart = false;
          } else if (myRoleInfo) {
            // Player was in the game
            restart.classList.remove('hidden');
            restart.innerText = 'Restart Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          } else {
            // New player (joined during results)
            restart.classList.remove('hidden');
            restart.innerText = 'Join Next Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          }
          
          turnEl.textContent = isSpectator ? 'Spectating - Game Over' : 'Game Over - Results';
        }

        if (d.type === 'restartUpdate') {
          if (d.isSpectator) {
            if (d.wantsToJoin || d.status === 'joining') {
              if (spectatorHasClickedRestart) {
                restart.innerText = `Joining next game... (${d.readyCount}/${d.totalPlayers} players ready)`;
                restart.disabled = true;
                restart.style.opacity = '0.7';
              } else {
                restart.innerText = 'Join Next Game';
                restart.disabled = false;
                restart.style.opacity = '1';
              }
            } else {
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
            }
          } else {
            // Check if player has a role (was in the game)
            if (d.playerRole) {
              // Player was in the game
              if (hasClickedRestart) {
                restart.innerText = `Waiting for others... (${d.readyCount}/${d.totalPlayers})`;
                restart.disabled = true;
                restart.style.opacity = '0.7';
              } else {
                restart.innerText = 'Restart Game';
                restart.disabled = false;
                restart.style.opacity = '1';
              }
            } else {
              // New player (joined during results)
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
            }
          }
        }

        if (d.type === 'roleChanged') {
          isSpectator = false;
          spectatorWantsToJoin = false;
          spectatorHasClickedRestart = false;
          nickname.value = nickname.value.replace('👁️ ', '');
          nickname.disabled = false;
          
          if (document.getElementById('playerNameDisplay')) {
            document.getElementById('playerNameDisplay').textContent = myPlayerName;
          }
          
          restart.innerText = 'Restart Game';
          restart.disabled = false;
          restart.style.opacity = '1';
        }

      } catch (error) {
        safeError('Error processing message:', error);
      }
    };

    ws.onerror = (error) => {
      safeError('Connection error');
      updateConnectionStatus('disconnected', 'Connection error');
    };

    ws.onclose = (event) => {
      safeLog(`Connection closed (code: ${event.code}, reason: ${event.reason})`);
      
      if (window.pingInterval) {
        clearInterval(window.pingInterval);
        window.pingInterval = null;
      }
      
      stopTurnTimer();
      
      if (event.code === 1000 || event.code === 1001) {
        updateConnectionStatus('disconnected', 'Disconnected');
        return;
      }
      
      if (gameCard && !gameCard.classList.contains('hidden')) {
        showConnectionWarning('Connection lost. Reconnecting...');
        updateConnectionStatus('connecting', 'Reconnecting...');
      } else {
        updateConnectionStatus('disconnected', 'Connection lost');
      }
      
      isReconnecting = true;
      setTimeout(() => {
        if (isSpectator && currentLobbyId) {
          joinAsSpectator();
        } else if (currentLobbyId) {
          joinAsPlayer();
        } else {
          resetToLobbyScreen();
        }
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      }, reconnectDelay);
    };
  } catch (error) {
    safeError('Failed to create WebSocket:', error);
    updateConnectionStatus('disconnected', 'Failed to connect');
    setTimeout(() => connect(), reconnectDelay);
  }
}

join.onclick = joinAsPlayer;
spectate.onclick = joinAsSpectator;
exitLobbyBtn.onclick = exitLobby;

start.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  ws.send(JSON.stringify({ type: 'startGame' }));
};

submit.onclick = () => {
  if (!input.value.trim() || isSpectator) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  ws.send(JSON.stringify({ type: 'submitWord', word: input.value.trim() }));
  input.value = '';
};

restart.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  
  if (isSpectator) {
    if (restart.innerText === 'Join Next Game') {
      spectatorWantsToJoin = true;
      spectatorHasClickedRestart = true;
      ws.send(JSON.stringify({ type: 'restart' }));
      restart.innerText = 'Joining next game...';
      restart.disabled = true;
      restart.style.opacity = '0.7';
    }
  } else {
    // Check if we should show "Join Next Game" (for new players) or "Restart Game" (for players in game)
    if (restart.innerText === 'Join Next Game') {
      // New player joining during results
      hasClickedRestart = true;
      ws.send(JSON.stringify({ type: 'restart' }));
      restart.innerText = 'Joining next game...';
      restart.disabled = true;
      restart.style.opacity = '0.7';
    } else if (restart.innerText === 'Restart Game') {
      // Player was in the game
      hasClickedRestart = true;
      ws.send(JSON.stringify({ type: 'restart' }));
      restart.innerText = 'Waiting for others...';
      restart.disabled = true;
      restart.style.opacity = '0.7';
    }
  }
};

window.vote = (v, btnElement) => {
  if (isSpectator) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
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

nickname.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinAsPlayer();
});

lobbyId.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinAsPlayer();
});

input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !isSpectator) submit.click();
});

let hiddenTime = null;
let pageHidden = false;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pageHidden = true;
    hiddenTime = Date.now();
    safeLog('Page hidden - connection may be suspended');
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (err) {
        // Connection might be closing
      }
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      updateConnectionStatus('connecting', 'Page inactive...');
    }
  } else {
    pageHidden = false;
    const hiddenDuration = hiddenTime ? Date.now() - hiddenTime : 0;
    safeLog(`Page visible after ${hiddenDuration}ms`);
    
    if (hiddenDuration > 5000) {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        safeLog('Reconnecting after page visibility change');
        updateConnectionStatus('connecting', 'Reconnecting...');
        
        setTimeout(() => {
          if (isSpectator && currentLobbyId) {
            joinAsSpectator();
          } else if (currentLobbyId) {
            joinAsPlayer();
          }
        }, 500);
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          lastPingTime = Date.now();
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (err) {
          setTimeout(() => {
            if (isSpectator && currentLobbyId) {
              joinAsSpectator();
            } else if (currentLobbyId) {
              joinAsPlayer();
            }
          }, 500);
        }
      }
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      updateConnectionStatus('connected');
    }
  }
});

setInterval(() => {
  if (pageHidden && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (err) {
      // Connection issue
    }
  }
}, 15000);

window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'disconnecting' }));
    } catch (err) {
      // Connection already closing
    }
  }
});

updateConnectionStatus('disconnected');
safeLog('Game client initialized');