const wsUrl = location.origin.replace(/^http/, 'ws');
let ws;

const nickname = document.getElementById('nickname');
const lobbyId = document.getElementById('lobbyId');
const join = document.getElementById('join');
const spectate = document.getElementById('spectate');
const start = document.getElementById('start');
const players = document.getElementById('players');

const gameHeader = document.getElementById('gameHeader');
const lobbyCodeDisplay = document.getElementById('lobbyCodeDisplay');
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
let maxConnectionAttempts = 10; // Increased for spectators
let reconnectDelay = 2000;
let hasShownConnectionWarning = false;
let hasClickedRestart = false; // Track if player clicked restart

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

// Compact player list with grid layout
function updatePlayerList(playersData, spectatorsData = []) {
  let playersHtml = '';
  
  if (Array.isArray(playersData) && playersData.length > 0) {
    playersHtml += '<b>Players (' + playersData.length + '):</b>';
    playersHtml += '<div class="player-grid">';
    
    playersData.forEach(player => {
      const isConnected = player.connected !== false;
      const statusClass = isConnected ? 'player-connected' : 'player-disconnected';
      const statusSymbol = isConnected ? '●' : '○';
      
      playersHtml += `
        <div class="player-item">
          <span class="player-status-dot ${statusClass}"></span>
          <span class="player-name" title="${player.name}">${player.name}</span>
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
      
      playersHtml += `
        <div class="player-item spectator-item">
          <span class="player-status-dot ${statusClass}"></span>
          <span class="player-name" title="${spectator.name}">${spectator.name}</span>
        </div>
      `;
    });
    
    playersHtml += '</div>';
  }
  
  players.innerHTML = playersHtml;
}

function joinAsPlayer() {
  if (isReconnecting) return;
  isSpectator = false;
  joinType = 'joinLobby';
  connectionAttempts = 0;
  reconnectDelay = 2000;
  connect();
}

function joinAsSpectator() {
  if (isReconnecting) return;
  isSpectator = true;
  joinType = 'joinSpectator';
  connectionAttempts = 0;
  reconnectDelay = 2000;
  connect();
}

function connect() {
  if (isReconnecting && connectionAttempts >= maxConnectionAttempts) {
    safeLog('Max reconnection attempts reached');
    showConnectionWarning('Connection failed. Please refresh the page.');
    lobbyCard.classList.remove('hidden');
    gameCard.classList.add('hidden');
    gameHeader.classList.add('hidden');
    isReconnecting = false;
    updateConnectionStatus('disconnected', 'Connection failed');
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

        if (d.type === 'lobbyAssigned') {
          lobbyId.value = d.lobbyId;
          currentLobbyId = d.lobbyId;
          isSpectator = d.isSpectator || false;
          
          lobbyCodeDisplay.textContent = d.lobbyId;
          
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
          
          if (d.phase && d.phase !== 'lobby') {
            players.innerHTML += `<br><i style="color:#f39c12">Game in progress: ${d.phase}</i>`;
          }
          
          if (isSpectator && (d.phase === 'lobby' || d.phase === 'results')) {
            players.innerHTML += `<br><i style="color:#9b59b6">Click "Join Lobby" to play next game</i>`;
          }
        }

        if (d.type === 'gameStart') {
          lobbyCard.classList.add('hidden');
          gameCard.classList.remove('hidden');
          
          // Reset restart state
          hasClickedRestart = false;
          
          results.innerHTML = ''; 
          restart.classList.add('hidden');
          restart.style.opacity = '1';
          restart.innerText = 'Restart Game';
          restart.disabled = false;
          
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
            
            if (isSpectator) {
              submit.disabled = true;
              input.placeholder = `Spectating - ${d.currentPlayer}'s turn`;
            } else {
              const isMyTurn = d.currentPlayer === nickname.value.replace('👁️ ', '');
              submit.disabled = !isMyTurn;
              input.placeholder = isMyTurn ? 'Your word' : `Waiting for ${d.currentPlayer}...`;
            }
          }
        }

        if (d.type === 'startVoting') {
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
            Object.entries(d.votes).map(([k,v]) => `${k} → ${v}`).join('<br>');

          voting.innerHTML = '';
          
          if (!isSpectator) {
            restart.classList.remove('hidden');
            restart.innerText = 'Restart Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false; // Reset for next game
          } else {
            results.innerHTML += `<hr><div style="text-align:center; color:#9b59b6">
              <i>👁️ You are spectating. Click "Join Lobby" to play next game.</i>
            </div>`;
          }
          
          turnEl.textContent = isSpectator ? 'Spectating - Game Over' : 'Game Over - Results';
        }

        if (d.type === 'restartUpdate') {
          // Only update if this player has already clicked restart
          if (hasClickedRestart) {
            restart.innerText = `Waiting for others... (${d.readyCount}/${d.totalPlayers})`;
            restart.disabled = true;
            restart.style.opacity = '0.7';
          } else {
            // Player hasn't clicked yet, keep showing "Restart Game"
            restart.innerText = 'Restart Game';
            restart.disabled = false;
            restart.style.opacity = '1';
          }
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
      }
      
      if (event.code === 1000 || event.code === 1001) {
        updateConnectionStatus('disconnected', 'Disconnected');
        return;
      }
      
      // If we're in a game and get disconnected, try to reconnect
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
          lobbyCard.classList.remove('hidden');
          gameCard.classList.add('hidden');
          gameHeader.classList.add('hidden');
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
  if (isSpectator) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  
  // Mark that this player has clicked restart
  hasClickedRestart = true;
  ws.send(JSON.stringify({ type: 'restart' }));
  restart.innerText = 'Waiting for others...';
  restart.disabled = true;
  restart.style.opacity = '0.7';
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

// Enhanced page visibility handling for spectators
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pageHidden = true;
    hiddenTime = Date.now();
    safeLog('Page hidden - connection may be suspended');
    
    // If we're a spectator, send a ping to keep connection alive
    if (isSpectator && ws && ws.readyState === WebSocket.OPEN) {
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
    
    // If page was hidden for a while, force reconnection for spectators
    if (hiddenDuration > 3000) {
      if (ws && (ws.readyState !== WebSocket.OPEN || isSpectator)) {
        safeLog('Reconnecting after page visibility change');
        updateConnectionStatus('connecting', 'Reconnecting...');
        
        // Close existing connection if it exists
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          try {
            ws.close(1000, 'Page became visible');
          } catch (err) {
            // Ignore errors
          }
        }
        
        // Reconnect with a short delay
        setTimeout(() => {
          if (isSpectator && currentLobbyId) {
            joinAsSpectator();
          } else if (currentLobbyId) {
            joinAsPlayer();
          }
        }, 500);
      }
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      updateConnectionStatus('connected');
    }
  }
});

// Send periodic pings when page is hidden (for spectators)
setInterval(() => {
  if (pageHidden && isSpectator && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (err) {
      // Connection issue, will reconnect on visibility change
    }
  }
}, 15000); // Every 15 seconds

window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'disconnecting' }));
    } catch (err) {
      // Connection already closing
    }
  }
});

// Show lobby by default
updateConnectionStatus('disconnected');
safeLog('Game client initialized');