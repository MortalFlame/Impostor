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

function updateJoinButtonText() {
  const lobbyInput = document.getElementById('lobbyId');
  const joinButton = document.getElementById('join');
  
  if (lobbyInput && joinButton) {
    if (lobbyInput.value.trim() === '') {
      joinButton.textContent = 'Create Lobby';
    } else {
      joinButton.textContent = 'Join Lobby';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const lobbyInput = document.getElementById('lobbyId');
  if (lobbyInput) {
    lobbyInput.addEventListener('input', updateJoinButtonText);
    lobbyInput.addEventListener('change', updateJoinButtonText);
    lobbyInput.addEventListener('keyup', updateJoinButtonText);
    
    setTimeout(updateJoinButtonText, 100);
  }
});

let playerId = localStorage.getItem('playerId');
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem('playerId', playerId);
}

let isSpectator = false;
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

let timerAnimationFrame = null;
let currentTurnEndsAt = null;
let isMyTurn = false;

let reconnectTimer = null;
let connectTimeout = null;
let visibilityReconnectTimer = null;

let lastServerId = localStorage.getItem('lastServerId');

let lobbyListRefreshInterval = null;

let impostorGuessTimer = null;
let impostorGuessEndsAt = null;
let isImpostor = false;
let isEjectedImpostor = false;
let isOwner = false;
let impostorGuessOption = false;
let twoImpostorsOption = false;
let twoImpostorsMode = false;

let selectedVotes = [];
let hasSubmittedVotes = false;

const DEBUG_MODE = true;

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

function forceImmediateReconnect() {
  safeLog('Forcing immediate reconnect...');
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
  
  if (ws) {
    try {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    } catch (err) {
    }
    ws = null;
  }
  
  reconnectDelay = 0;
  connectionAttempts = 0;
  
  if (isSpectator && currentLobbyId) {
    joinAsSpectator();
  } else if (currentLobbyId) {
    joinAsPlayer(true);
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

function getRemainingTimeMs() {
  if (!currentTurnEndsAt) return 0;
  const now = Date.now();
  return Math.max(0, currentTurnEndsAt - now);
}

function updateTimerColor(timeLeftSeconds) {
  timerProgress.classList.remove('green', 'yellow', 'orange', 'red');
  
  if (timeLeftSeconds > 20) {
    timerProgress.classList.add('green');
  } else if (timeLeftSeconds > 15) {
    timerProgress.classList.add('yellow');
  } else if (timeLeftSeconds > 5) {
    timerProgress.classList.add('orange');
  } else {
    timerProgress.classList.add('red');
  }
}

function startTurnTimerAnimation(turnEndsAt) {
  stopTurnTimerAnimation();
  
  currentTurnEndsAt = turnEndsAt;
  
  if (!isMyTurn || isSpectator) {
    turnTimerEl.classList.add('hidden');
    return;
  }
  
  turnTimerEl.classList.remove('hidden');
  
  function animateTimer() {
    const remainingMs = getRemainingTimeMs();
    const timeLeftSeconds = Math.ceil(remainingMs / 1000);
    
    if (remainingMs <= 0) {
      stopTurnTimerAnimation();
      turnTimerEl.classList.add('hidden');
      turnEl.textContent = 'Time expired! Waiting for next player...';
      return;
    }
    
    const circumference = 2 * Math.PI * 18;
    const totalDuration = 30000;
    const progress = (remainingMs / totalDuration) * 100;
    const offset = circumference - (progress / 100) * circumference;
    
    updateTimerColor(timeLeftSeconds);
    timerProgress.style.strokeDashoffset = offset;
    
    timerText.textContent = timeLeftSeconds;
    
    timerAnimationFrame = requestAnimationFrame(animateTimer);
  }
  
  timerAnimationFrame = requestAnimationFrame(animateTimer);
}

function stopTurnTimerAnimation() {
  if (timerAnimationFrame) {
    cancelAnimationFrame(timerAnimationFrame);
    timerAnimationFrame = null;
  }
  currentTurnEndsAt = null;
  timerProgress.style.strokeDashoffset = 0;
  timerText.textContent = '30';
  turnTimerEl.classList.add('hidden');
  isMyTurn = false;
}

function startImpostorGuessTimerAnimation(guessEndsAt) {
  stopImpostorGuessTimerAnimation();
  
  impostorGuessEndsAt = guessEndsAt;
  
  if (!isImpostor) {
    turnTimerEl.classList.add('hidden');
    return;
  }
  
  turnTimerEl.classList.remove('hidden');
  
  function animateImpostorGuessTimer() {
    const remainingMs = Math.max(0, impostorGuessEndsAt - Date.now());
    const timeLeftSeconds = Math.ceil(remainingMs / 1000);
    
    if (remainingMs <= 0) {
      stopImpostorGuessTimerAnimation();
      turnTimerEl.classList.add('hidden');
      turnEl.textContent = 'Time expired! Impostor failed to guess.';
      return;
    }
    
    const circumference = 2 * Math.PI * 18;
    const totalDuration = 30000;
    const progress = (remainingMs / totalDuration) * 100;
    const offset = circumference - (progress / 100) * circumference;
    
    updateTimerColor(timeLeftSeconds);
    timerProgress.style.strokeDashoffset = offset;
    
    timerText.textContent = timeLeftSeconds;
    
    impostorGuessTimer = requestAnimationFrame(animateImpostorGuessTimer);
  }
  
  impostorGuessTimer = requestAnimationFrame(animateImpostorGuessTimer);
}

function stopImpostorGuessTimerAnimation() {
  if (impostorGuessTimer) {
    cancelAnimationFrame(impostorGuessTimer);
    impostorGuessTimer = null;
  }
  impostorGuessEndsAt = null;
  timerProgress.style.strokeDashoffset = 0;
  timerText.textContent = '30';
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
      const roleBadge = player.role ? `<span class="role-badge role-${player.role}">${player.role.charAt(0).toUpperCase()}</span>` : '';
      
      playersHtml += `
        <div class="player-item">
          <span class="player-status-dot ${statusClass}"></span>
          <span class="player-name" title="${player.name}">${nameDisplay}</span>
          ${roleBadge}
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

function updateLobbyList(lobbies) {
  const lobbyListContainer = document.getElementById('lobbyListContainer');
  if (!lobbyListContainer) return;
  
  if (lobbyCard && !lobbyCard.classList.contains('hidden')) {
    lobbyListContainer.style.display = 'block';
  }
  
  lobbies.sort((a, b) => b.createdAt - a.createdAt);
  
  if (lobbies.length === 0) {
    lobbyListContainer.innerHTML = `
      <div class="lobby-list-header">
        <h3>Available Lobbies</h3>
        <button id="refreshLobbies" class="refresh-btn">↻</button>
      </div>
      <div class="no-lobbies">No lobbies available. Create one!</div>
    `;
  } else {
    let lobbiesHtml = `
      <div class="lobby-list-header">
        <h3>Available Lobbies (${lobbies.length})</h3>
        <button id="refreshLobbies" class="refresh-btn">↻</button>
      </div>
      <div class="lobby-list">
    `;
    
    lobbies.forEach(lobby => {
      const totalPlayers = lobby.playerCount + lobby.spectatorCount;
      const playerStatus = `${lobby.playerCount}`;
      const impostorGuessBadge = lobby.impostorGuessOption ? 
        '<span class="impostor-guess-badge" title="Impostor gets last chance to guess">🔍</span>' : '';
      const twoImpostorsBadge = lobby.twoImpostorsOption ?
        '<span class="two-impostors-badge" title="2 Impostors Mode">👥</span>' : '';
      
      let phaseIndicator = '';
      if (lobby.phase === 'lobby') {
        phaseIndicator = '<span class="phase-indicator lobby-phase">Waiting</span>';
      } else if (lobby.phase === 'results') {
        phaseIndicator = '<span class="phase-indicator results-phase">Results</span>';
      } else {
        phaseIndicator = '<span class="phase-indicator in-game-phase">In Game</span>';
      }
      
      lobbiesHtml += `
        <div class="lobby-item" data-lobby-id="${lobby.id}">
          <div class="lobby-info">
            <div class="lobby-code">${lobby.id} ${impostorGuessBadge} ${twoImpostorsBadge}</div>
            <div class="lobby-host">
              <span class="host-name" title="${lobby.host}">${lobby.host}</span>
            </div>
            <div class="lobby-stats">
              <span class="player-count">P: ${playerStatus}</span>
              ${phaseIndicator}
            </div>
          </div>
          <button class="join-lobby-btn" data-lobby-id="${lobby.id}">
            Join
          </button>
        </div>
      `;
    });
    
    lobbiesHtml += '</div>';
    lobbyListContainer.innerHTML = lobbiesHtml;
    
    document.querySelectorAll('.join-lobby-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const lobbyIdToJoin = e.target.getAttribute('data-lobby-id');
        if (lobbyIdToJoin) {
          document.getElementById('lobbyId').value = lobbyIdToJoin;
          joinAsPlayer(false);
        }
      });
    });
    
    const refreshBtn = document.getElementById('refreshLobbies');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshLobbyList();
      });
    }
  }
}

function refreshLobbyList() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'getLobbyList' }));
  }
}

function startLobbyListAutoRefresh() {
  if (lobbyListRefreshInterval) {
    clearInterval(lobbyListRefreshInterval);
    lobbyListRefreshInterval = null;
  }
  
  lobbyListRefreshInterval = setInterval(() => {
    if (lobbyCard && !lobbyCard.classList.contains('hidden') && 
        ws && ws.readyState === WebSocket.OPEN) {
      refreshLobbyList();
    }
  }, 5000);
}

function stopLobbyListAutoRefresh() {
  if (lobbyListRefreshInterval) {
    clearInterval(lobbyListRefreshInterval);
    lobbyListRefreshInterval = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentTurnEndsAt && isMyTurn) {
    startTurnTimerAnimation(currentTurnEndsAt);
  } else if (document.hidden && timerAnimationFrame) {
    cancelAnimationFrame(timerAnimationFrame);
    timerAnimationFrame = null;
  }
  
  if (!document.hidden && impostorGuessEndsAt && isImpostor) {
    startImpostorGuessTimerAnimation(impostorGuessEndsAt);
  } else if (document.hidden && impostorGuessTimer) {
    cancelAnimationFrame(impostorGuessTimer);
    impostorGuessTimer = null;
  }
  
  if (!document.hidden) {
    safeLog('Page became visible - checking connection status');
    
    if (currentLobbyId && (!ws || ws.readyState !== WebSocket.OPEN)) {
      safeLog('In game but not connected - forcing immediate reconnect');
      updateConnectionStatus('connecting', 'Reconnecting after page visibility...');
      
      setTimeout(() => {
        forceImmediateReconnect();
      }, 100);
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      lastPingTime = Date.now();
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (err) {
        safeLog('Failed to send ping after visibility change, will reconnect');
        setTimeout(() => {
          forceImmediateReconnect();
        }, 100);
      }
    }
  }
});

function forceReconnect() {
  safeLog('Forcing reconnect...');
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
  
  if (ws) {
    try {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    } catch (err) {
    }
    ws = null;
  }
  
  reconnectDelay = 2000;
  scheduleReconnect(true);
}

function exitLobby() {
  stopLobbyListAutoRefresh();
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
  
  if (visibilityReconnectTimer) {
    clearTimeout(visibilityReconnectTimer);
    visibilityReconnectTimer = null;
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'exitLobby' }));
    } catch (err) {
    }
    
    try {
      ws.close(1000, 'User exited lobby');
    } catch (err) {
    }
  }
  
  isSpectator = false;
  currentLobbyId = null;
  connectionAttempts = 0;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  hasClickedRestart = false;
  myPlayerName = '';
  joinType = 'browseLobbies';
  isOwner = false;
  impostorGuessOption = false;
  twoImpostorsOption = false;
  twoImpostorsMode = false;
  isEjectedImpostor = false;
  isImpostor = false;
  
  lobbyCard.classList.remove('hidden');
  gameCard.classList.add('hidden');
  gameHeader.classList.add('hidden');
  
  nickname.value = nickname.value.replace('👁️ ', '');
  nickname.disabled = false;
  lobbyId.value = '';
  players.innerHTML = '';
  
  updateConnectionStatus('disconnected');
  
  stopTurnTimerAnimation();
  stopImpostorGuessTimerAnimation();
  
  if (window.pingInterval) {
    clearInterval(window.pingInterval);
    window.pingInterval = null;
  }
  
  safeLog('Exited lobby');
  
  const lobbyListContainer = document.getElementById('lobbyListContainer');
  if (lobbyListContainer) {
    lobbyListContainer.style.display = 'block';
  }
  
  setTimeout(() => {
    refreshLobbyList();
  }, 500);
  
  startLobbyListAutoRefresh();
  
  setTimeout(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      joinType = 'browseLobbies';
      connect();
    }
  }, 300);
  
  updateJoinButtonText();
}

function resetToLobbyScreen() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
  
  if (visibilityReconnectTimer) {
    clearTimeout(visibilityReconnectTimer);
    visibilityReconnectTimer = null;
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
  connectionAttempts = 0;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  myPlayerName = '';
  joinType = 'browseLobbies';
  isOwner = false;
  impostorGuessOption = false;
  twoImpostorsOption = false;
  twoImpostorsMode = false;
  isEjectedImpostor = false;
  updateConnectionStatus('disconnected');
  
  stopTurnTimerAnimation();
  stopImpostorGuessTimerAnimation();
  
  if (window.pingInterval) {
    clearInterval(window.pingInterval);
    window.pingInterval = null;
  }
  
  const lobbyListContainer = document.getElementById('lobbyListContainer');
  if (lobbyListContainer) {
    lobbyListContainer.style.display = 'block';
  }
  
  setTimeout(() => {
    refreshLobbyList();
  }, 500);
  
  startLobbyListAutoRefresh();
  
  setTimeout(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      joinType = 'browseLobbies';
      connect();
    }
  }, 100);
  updateJoinButtonText();
}

function joinAsPlayer(isReconnect = false) {
  if (!isReconnect && !nickname.value.trim()) {
    alert('Please enter a nickname');
    return;
  }
  
  isSpectator = false;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  joinType = 'joinLobby';
  connectionAttempts = 0;
  reconnectDelay = 2000;
  
  stopLobbyListAutoRefresh();
  
  connect();
}

function joinAsSpectator() {
  isSpectator = true;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  joinType = 'joinSpectator';
  connectionAttempts = 0;
  reconnectDelay = 2000;
  
  stopLobbyListAutoRefresh();
  
  connect();
}

function scheduleReconnect(immediate = false) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  const delay = immediate ? 0 : reconnectDelay;
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    
    if (isSpectator && currentLobbyId) {
      joinAsSpectator();
    } else if (currentLobbyId) {
      joinAsPlayer(true);
    } else {
      resetToLobbyScreen();
    }
    
    reconnectDelay = Math.min(
      30000,
      reconnectDelay * 1.5 + Math.random() * 1000
    );
  }, delay);
}

function connect() {
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (connectionAttempts >= maxConnectionAttempts) {
    safeLog('Max connection attempts reached');
    showConnectionWarning('Connection failed. Please refresh the page.');
    resetToLobbyScreen();
    return;
  }

  if (!nickname.value.trim() && (joinType === 'joinLobby' || joinType === 'joinSpectator')) {
    alert('Please enter a nickname');
    return;
  }
  
  if (joinType === 'joinSpectator' && !lobbyId.value.trim()) {
    alert('Please enter a lobby code to spectate');
    return;
  }

  try {
    updateConnectionStatus('connecting', 'Connecting to server...');
    
    if (ws) {
      try {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      } catch (err) {
      }
      ws = null;
    }
    
    ws = new WebSocket(wsUrl);
    connectionAttempts++;
    
    connectTimeout = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        safeLog('WebSocket stuck in CONNECTING, forcing close');
        try {
          ws.close();
        } catch (err) {
        }
      }
    }, 5000);
    
    ws.onopen = () => {
      safeLog('Game connection established');
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      
      connectionAttempts = 0;
      reconnectDelay = 2000;
      hasShownConnectionWarning = false;
      updateConnectionStatus('connected');
      
      if (joinType !== 'browseLobbies') {
        gameHeader.classList.remove('hidden');
      }
      
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
      
      setTimeout(() => {
        if (joinType === 'browseLobbies') {
          try {
            ws.send(JSON.stringify({ type: 'getLobbyList' }));
          } catch (err) {
            safeError('Failed to send getLobbyList');
          }
        } else if (joinType === 'joinSpectator') {
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
      }, 200);
    };

    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        safeLog('Game update received:', d.type);

        if (d.type === 'serverHello') {
          if (lastServerId && lastServerId !== d.serverId) {
            showConnectionWarning('Server was restarted. Reconnecting...');
            lastServerId = d.serverId;
            localStorage.setItem('lastServerId', d.serverId);
            setTimeout(() => {
              forceReconnect();
            }, 1000);
            return;
          }
          lastServerId = d.serverId;
          localStorage.setItem('lastServerId', d.serverId);
          return;
        }

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
          alert(d.message);
          return;
        }

        if (d.type === 'lobbyExited') {
          safeLog('Successfully exited lobby:', d.message);
          resetToLobbyScreen();
          return;
        }
        
        if (d.type === 'lobbyClosed') {
          safeLog('Lobby closed by host:', d.message);
          showConnectionWarning(d.message || 'Lobby was closed by the host');
          resetToLobbyScreen();
          return;
        }

        if (d.type === 'lobbyList') {
          updateLobbyList(d.lobbies || []);
          
          const lobbyListContainer = document.getElementById('lobbyListContainer');
          if (lobbyListContainer) {
            lobbyListContainer.style.display = 'block';
          }
          
          return;
        }

        if (d.type === 'lobbyAssigned') {
          lobbyId.value = d.lobbyId;
          currentLobbyId = d.lobbyId;
          isSpectator = d.isSpectator || false;
          myPlayerName = d.yourName || d.playerName || nickname.value.trim();
          isOwner = d.isOwner || false;
          impostorGuessOption = d.impostorGuessOption || false;
          twoImpostorsOption = d.twoImpostorsOption || false;
          
          // FIX: Properly restore spectator join state from server
          if (d.isSpectator && d.wantsToJoinNextGame !== undefined) {
            spectatorWantsToJoin = d.wantsToJoinNextGame;
            spectatorHasClickedRestart = d.wantsToJoinNextGame;
          }
          
          lobbyCodeDisplay.textContent = d.lobbyId;
          
          if (document.getElementById('playerNameDisplay')) {
            document.getElementById('playerNameDisplay').textContent = myPlayerName;
          }
          
          if (isSpectator) {
            nickname.value = nickname.value.startsWith('👁️ ') ? nickname.value : `👁️ ${nickname.value.trim()}`;
            nickname.disabled = true;
          }
          
          exitLobbyBtn.style.display = 'block';
          
          const lobbyListContainer = document.getElementById('lobbyListContainer');
          if (lobbyListContainer) {
            lobbyListContainer.style.display = 'none';
          }
          
          updateImpostorGuessToggle();
          updateTwoImpostorsToggle();
          
          stopLobbyListAutoRefresh();
        }

        if (d.type === 'lobbyUpdate') {
          updatePlayerList(d.players, d.spectators);
          
          const isOwnerCheck = d.owner === playerId;
          isOwner = isOwnerCheck;
          impostorGuessOption = d.impostorGuessOption || false;
          twoImpostorsOption = d.twoImpostorsOption || false;
          
          start.disabled = isSpectator || d.players.length < 3 || !isOwnerCheck;
          
          spectate.style.display = isSpectator ? 'none' : 'block';
          join.style.display = isSpectator ? 'none' : 'block';
          
          exitLobbyBtn.style.display = 'block';
          
          updateImpostorGuessToggle();
          updateTwoImpostorsToggle();
          
          if (d.phase && d.phase !== 'lobby') {
            players.innerHTML += `<br><i style="color:#f39c12">Game in progress: ${d.phase}</i>`;
          }
          
          if (isSpectator && (d.phase === 'lobby' || d.phase === 'results')) {
            players.innerHTML += `<br><i style="color:#9b59b6">Click "Join Next Game" to play next round</i>`;
          }
          
          if (d.phase === 'results' && !isSpectator) {
            const myPlayerInfo = d.players.find(p => p.name === myPlayerName);
            if (!myPlayerInfo || !myPlayerInfo.role) {
              players.innerHTML += `<br><i style="color:#f39c12">Joining next game...</i>`;
            }
          }
        }

        if (d.type === 'gameStart') {
          lobbyCard.classList.add('hidden');
          gameCard.classList.remove('hidden');
          
          exitLobbyBtn.style.display = 'block';
          
          hasClickedRestart = false;
          
          if (d.playerName) {
            myPlayerName = d.playerName;
            if (document.getElementById('playerNameDisplay')) {
              document.getElementById('playerNameDisplay').textContent = myPlayerName;
            }
          }
          
          if (!isSpectator && d.role !== 'spectator') {
            nickname.value = nickname.value.replace('👁️ ', '');
            nickname.disabled = false;
          }
          
          results.innerHTML = ''; 
          restart.classList.add('hidden');
          restart.style.opacity = '1';
          
          if (isSpectator || d.role === 'spectator') {
            if (spectatorWantsToJoin || spectatorHasClickedRestart) {
              restart.innerText = 'Joining next game...';
              restart.disabled = true;
              restart.style.opacity = '0.7';
            } else {
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
            }
            restart.classList.remove('hidden');
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
            isImpostor = false;
          } else if (d.role === 'civilian') {
            roleBack.className = `role-back ${d.role}`;
            roleText.innerHTML = '<span style="color:#2ecc71">Civilian</span>';
            wordEl.textContent = `Word: ${capitalize(d.word)}`;
            isImpostor = false;
          } else if (d.role === 'impostor') {
            roleBack.className = `role-back ${d.role}`;
            roleText.innerHTML = '<span style="color:#e74c3c">Impostor</span>';
            wordEl.textContent = `Hint: ${capitalize(d.word)}`;
            isImpostor = true;
          }
        }

        if (d.type === 'turnUpdate') {
          isEjectedImpostor = false;
          
          const formatWord = (entry) => {
            if (entry.word === '' || entry.word === null || entry.word === undefined) {
              return `${entry.name}: (skipped)`;
            }
            return `${entry.name}: ${capitalize(entry.word)}`;
          };
          
          round1El.innerHTML = d.round1.map(formatWord).join('<br>');
          round2El.innerHTML = d.round2.map(formatWord).join('<br>');
          
          stopTurnTimerAnimation();
          stopImpostorGuessTimerAnimation();
          
          if (d.currentPlayer === 'Voting Phase') {
            turnEl.textContent = isSpectator ? 'Spectating - Voting Starting...' : 'Round Complete - Voting Starting...';
            submit.disabled = true;
            input.value = '';
            input.placeholder = isSpectator ? 'Spectating votes...' : 'Get ready to vote...';
            isMyTurn = false;
            currentTurnEndsAt = null;
          } else {
            isMyTurn = d.currentPlayer === myPlayerName;
            
            if (isSpectator) {
              turnEl.textContent = `Spectating - Turn: ${d.currentPlayer}`;
              submit.disabled = true;
              input.placeholder = `Spectating - ${d.currentPlayer}'s turn`;
              currentTurnEndsAt = null;
            } else {
              turnEl.textContent = isMyTurn ? `Your Turn: ${d.currentPlayer}` : `Turn: ${d.currentPlayer}`;
              submit.disabled = !isMyTurn;
              input.placeholder = isMyTurn ? 'Your word (30s)' : `Waiting for ${d.currentPlayer}...`;
              
              if (d.turnEndsAt) {
                currentTurnEndsAt = d.turnEndsAt;
                if (isMyTurn) {
                  startTurnTimerAnimation(currentTurnEndsAt);
                }
              }
            }
          }
        }

        if (d.type === 'startVoting') {
          stopTurnTimerAnimation();
          stopImpostorGuessTimerAnimation();
          isEjectedImpostor = false;
          
          twoImpostorsMode = d.twoImpostorsMode || false;
          
          selectedVotes = [];
          hasSubmittedVotes = false;

          console.log(`========== VOTING PHASE ==========`);
  console.log(`isSpectator: ${isSpectator}`);
  console.log(`spectatorWantsToJoin: ${spectatorWantsToJoin}`);
  console.log(`spectatorHasClickedRestart: ${spectatorHasClickedRestart}`);
  console.log(`==================================`);
          
          if (twoImpostorsMode) {
            turnEl.textContent = isSpectator ? 'Spectating - Vote for 2 Impostors!' : 'Vote for 2 Impostors! (Select 2 players)';
          } else {
            turnEl.textContent = isSpectator ? 'Spectating - Vote for the Impostor!' : 'Vote for the Impostor!';
          }
          
          input.value = '';
          input.placeholder = isSpectator ? 'Spectating votes...' : 'Voting in progress...';
          submit.disabled = true;
          isMyTurn = false;
          currentTurnEndsAt = null;
          
          if (isSpectator || d.isSpectator) {
            voting.innerHTML = '<h3>Spectating Votes</h3>' +
              d.players.map(p => `<div class="spectator-vote-btn">${p}</div>`).join('');
          } else {
            let votingHeader = '<h3>Vote</h3>';
            if (twoImpostorsMode) {
              votingHeader += '<p style="color:#f39c12; font-size: 12px; margin-top: -5px; margin-bottom: 10px;">Select 2 players you think are impostors</p>';
              votingHeader += '<div id="voteCountDisplay" style="color:#f39c12; font-weight:bold; margin-bottom: 10px;">Selected: 0/2</div>';
            }
            
            voting.innerHTML = votingHeader +
              d.players
                .filter(p => p !== myPlayerName)
                .map(p => `<button class="vote-btn" onclick="vote('${p}', this)">${p}</button>`)
                .join('');
            
            if (twoImpostorsMode) {
              voting.innerHTML += `
                <button id="submitVotesBtn" class="button-base" style="margin-top: 10px; background: linear-gradient(135deg, #27ae60, #2ecc71);" onclick="submitVotes()">
                  Submit Votes
                </button>
                <button id="clearVotesBtn" class="button-base" style="margin-top: 5px; background: linear-gradient(135deg, #e74c3c, #c0392b);" onclick="clearVotes()">
                  Clear Selection
                </button>
              `;
            }
          }
        }

        if (d.type === 'impostorGuessPhase') {
          stopTurnTimerAnimation();
          stopImpostorGuessTimerAnimation();
          
          isMyTurn = false;
          currentTurnEndsAt = null;
          isEjectedImpostor = false;
          
          const ejectedNames = Array.isArray(d.ejected) ? d.ejected : [d.ejected];
          const ejectedText = ejectedNames.join(' and ');
          
          if (d.isImpostor) {
            const playerIsEjected = ejectedNames.some(name => name === myPlayerName);
            
            if (playerIsEjected) {
              isEjectedImpostor = true;
              turnEl.textContent = 'You were voted out! Guess the word to win!';
              input.placeholder = 'Guess the word (30s)...';
              input.disabled = false;
              submit.disabled = false;
              submit.textContent = 'Submit Guess';
              submit.onclick = submitImpostorGuess;
              
              if (d.guessEndsAt) {
                startImpostorGuessTimerAnimation(d.guessEndsAt);
              }
              
              const isMultiple = ejectedNames.length > 1;
              voting.innerHTML = '<h3>Last Chance to Win!</h3>' +
                `<p>${isMultiple ? 'You and the other ejected impostor have' : 'You have'} 30 seconds to guess the secret word.</p>` +
                '<p>If any ejected impostor guesses correctly, the impostors win!</p>';
            } else {
              turnEl.textContent = 'Your teammate was voted out! They are guessing...';
              input.placeholder = 'Waiting for teammate to guess...';
              input.disabled = true;
              submit.disabled = true;
              
              voting.innerHTML = '<h3>Teammate is Guessing</h3>' +
                `<p>Your teammate (${ejectedText}) has 30 seconds to guess the secret word.</p>` +
                '<p>If they guess correctly, the impostors win!</p>';
            }
          } else {
            const isMultiple = ejectedNames.length > 1;
            
            if (isMultiple) {
              turnEl.textContent = 'Impostors were voted out! They have 30 seconds to guess the word...';
              voting.innerHTML = '<h3>Impostors are Guessing</h3>' +
                `<p>The impostors (${ejectedText}) have 30 seconds to guess the secret word.</p>` +
                '<p>If any of them guesses correctly, the impostors win!</p>';
            } else {
              turnEl.textContent = 'Impostor was voted out! They have 30 seconds to guess the word...';
              voting.innerHTML = '<h3>Impostor is Guessing</h3>' +
                `<p>The impostor (${ejectedText}) has 30 seconds to guess the secret word.</p>` +
                '<p>If they guess correctly, the impostors win!</p>';
            }
            
            input.placeholder = 'Waiting for impostor(s) to guess...';
            input.disabled = true;
            submit.disabled = true;
          }
          
          results.innerHTML = '';
        }

        if (d.type === 'gameEndEarly') {
          stopTurnTimerAnimation();
          stopImpostorGuessTimerAnimation();
          isMyTurn = false;
          currentTurnEndsAt = null;
          isImpostor = false;
          isEjectedImpostor = false;

          // FIX: Preserve spectator join state from server
  if (d.isSpectator && d.wantsToJoinNextGame !== undefined) {
    spectatorWantsToJoin = d.wantsToJoinNextGame;
    if (d.wantsToJoinNextGame) {
      spectatorHasClickedRestart = true;
    }
    
    console.log(`GAME END EARLY: Spectator ${myPlayerName} wantsToJoinNextGame=${d.wantsToJoinNextGame}`);
  }
          
          const winnerColor = '#f39c12';
          let reasonText = '';
          
          if (d.isSpectator && d.wantsToJoinNextGame !== undefined) {
            spectatorWantsToJoin = d.wantsToJoinNextGame;
            if (d.wantsToJoinNextGame) {
              spectatorHasClickedRestart = true;
            }
          }
          
          if (d.reason === 'not_enough_players') {
            reasonText = `<div style="color:#f39c12; text-align:center; margin-bottom:10px;">
              <i>Game ended: Not enough players (minimum 3 required)</i>
            </div>`;
          } else if (d.reason === 'impostor_left') {
            reasonText = `<div style="color:#f39c12; text-align:center; margin-bottom:10px;">
              <i>Game ended: Impostor left the game</i>
            </div>`;
          }
          
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
            `<h2 style="color:${winnerColor}; text-align:center">Game Ended Early</h2>` +
            reasonText +
            `<div class="word-hint-container">
              <div><b>Word:</b> ${capitalize(d.secretWord)}</div>
              <span class="word-hint-separator">|</span>
              <div><b>Hint:</b> ${capitalize(d.hint)}</div>
            </div>` +
            '<hr>' +
            '<b>Roles</b><br>' + rolesHtml;

          voting.innerHTML = '';
          
          exitLobbyBtn.style.display = 'block';
          
          if (isSpectator) {
            restart.classList.remove('hidden');
            if (spectatorWantsToJoin || spectatorHasClickedRestart) {
              restart.innerText = 'Joining next game...';
              restart.disabled = true;
              restart.style.opacity = '0.7';

              const playersInGame = d.roles ? d.roles.length : 0;
      restart.innerText = `Joining next game... (0/${playersInGame} players ready)`;
            } else {
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
            }
          } else if (myRoleInfo) {
            restart.classList.remove('hidden');
            restart.innerText = 'Restart Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          } else {
            restart.classList.remove('hidden');
            restart.innerText = 'Join Next Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          }
          
          turnEl.textContent = 'Game Ended Early';
        }

        if (d.type === 'gameEnd') {
          stopTurnTimerAnimation();
          stopImpostorGuessTimerAnimation();
          isMyTurn = false;
          currentTurnEndsAt = null;
          isImpostor = false;
          isEjectedImpostor = false;

          // FIX: Preserve spectator join state from server
  if (d.isSpectator && d.wantsToJoinNextGame !== undefined) {
    spectatorWantsToJoin = d.wantsToJoinNextGame;
    if (d.wantsToJoinNextGame) {
      spectatorHasClickedRestart = true;
    }
    
    // Debug log
    console.log(`GAME END: Spectator ${myPlayerName} wantsToJoinNextGame=${d.wantsToJoinNextGame}`);
  }
          
          submit.textContent = 'Submit';
          submit.onclick = submitWord;
          
          let winnerColor;
          if (d.winner === 'Civilians') {
            winnerColor = '#2ecc71';
          } else if (d.winner === 'Impostors' || d.winner === 'Impostor') {
            winnerColor = '#e74c3c';
          } else if (d.winner === 'Draw') {
            winnerColor = '#f39c12';
          } else {
            winnerColor = '#95a5a6';
          }
          
          // FIX: Preserve spectator join state from server
          if (d.isSpectator && d.wantsToJoinNextGame !== undefined) {
            spectatorWantsToJoin = d.wantsToJoinNextGame;
            if (d.wantsToJoinNextGame) {
              spectatorHasClickedRestart = true;
            }
          }
          
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
              const voterColor = voterRole === 'civilian' ? '#2ecc71' : '#e74c3c';
              
              const votes = Array.isArray(votedFor) ? votedFor : [votedFor];
              
              votes.forEach(vote => {
                const votedForRole = d.roles.find(r => r.name === vote)?.role;
                const votedForColor = votedForRole === 'civilian' ? '#2ecc71' : '#e74c3c';
                
                votesHtml += `
                  <div class="vote-results-item">
                    <span class="vote-voter" style="color:${voterColor}">${voter}</span>
                    <div class="vote-arrow">→</div>
                    <span class="vote-voted" style="color:${votedForColor}">${vote}</span>
                  </div>
                `;
              });
            });
          }
          votesHtml += '</div>';
          
          let ejectedHtml = '';
          if (d.ejected && d.ejected.length > 0) {
            let ejectedText = '';
            if (Array.isArray(d.ejected)) {
              ejectedText = d.ejected.join(' and ');
            } else {
              ejectedText = d.ejected;
            }
            ejectedHtml = `<div style="margin: 10px 0; padding: 8px; background: rgba(231, 76, 60, 0.1); border-radius: 8px;">
              <b>Ejected:</b> ${ejectedText}
            </div>`;
          }
          
          let impostorGuessHtml = '';
          if (d.impostorGuesses && Object.keys(d.impostorGuesses).length > 0) {
            let guessesHtml = '<div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; margin: 10px 0;">';
            guessesHtml += '<b>Impostor Guesses:</b><br><br>';
            
            let anyCorrect = false;
            Object.values(d.impostorGuesses).forEach(guessData => {
              if (guessData.guess === d.secretWord.toLowerCase()) {
                anyCorrect = true;
                guessesHtml += `<div class="guess-result guess-correct">
                  <strong>${guessData.name}:</strong> "${guessData.guess}" ✓
                </div>`;
              } else {
                guessesHtml += `<div class="guess-result guess-incorrect">
                  <strong>${guessData.name}:</strong> "${guessData.guess}" ✗
                </div>`;
              }
            });
            
            if (anyCorrect) {
              guessesHtml += '<br><div style="color:#2ecc71; font-weight:bold;">At least one impostor guessed correctly! Impostors win!</div>';
            } else {
              guessesHtml += '<br><div style="color:#e74c3c; font-weight:bold;">No impostors guessed correctly! Civilians win!</div>';
            }
            
            guessesHtml += '</div>';
            impostorGuessHtml = guessesHtml;
          } else if (d.impostorGuess !== undefined) {
            const guessResult = d.impostorGuessCorrect ? 
              `<span style="color:#2ecc71">Correct guess! The impostors win!</span>` :
              `<span style="color:#e74c3c">Wrong guess! The impostor said: "${d.impostorGuess}"</span>`;
            
            impostorGuessHtml = `
              <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; margin: 10px 0;">
                <b>Impostor's Last Chance:</b><br>
                ${guessResult}
              </div>
            `;
          }
          
          let modeIndicator = '';
          if (d.twoImpostorsMode) {
            modeIndicator = `<div style="color:#9b59b6; margin-bottom: 10px; text-align: center;">
              <small>2 Impostors Mode</small>
            </div>`;
          }
          
          let reasonHtml = '';
          if (d.reason === 'impostorGuessTimeout') {
            reasonHtml = `<div style="color:#f39c12; text-align:center; margin:10px 0;">
              <i>Time expired! Impostor(s) failed to guess in time.</i>
            </div>`;
          }
          
          results.innerHTML =
            `<h2 style="color:${winnerColor}; text-align:center">${d.winner} ${d.winner === 'Draw' ? '' : 'Won!'}</h2>` +
            modeIndicator +
            reasonHtml +
            impostorGuessHtml +
            ejectedHtml +
            `<div class="word-hint-container">
              <div><b>Word:</b> ${capitalize(d.secretWord)}</div>
              <span class="word-hint-separator">|</span>
              <div><b>Hint:</b> ${capitalize(d.hint)}</div>
            </div>` +
            '<hr>' +
            '<b>Roles</b><br>' + rolesHtml +
            (d.votes ? '<hr><b>Votes</b><br>' + votesHtml : '') +
            '<br><br>';

          voting.innerHTML = '';
          
          exitLobbyBtn.style.display = 'block';
          
          if (isSpectator) {
            restart.classList.remove('hidden');
            if (spectatorWantsToJoin || spectatorHasClickedRestart) {
              restart.innerText = 'Joining next game...';
              restart.disabled = true;
              restart.style.opacity = '0.7';
              const playersInGame = d.roles ? d.roles.length : 0;
      restart.innerText = `Joining next game... (0/${playersInGame} players ready)`;
            } else {
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
            }
          } else if (myRoleInfo) {
            restart.classList.remove('hidden');
            restart.innerText = 'Restart Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          } else {
            restart.classList.remove('hidden');
            restart.innerText = 'Join Next Game';
            restart.disabled = false;
            restart.style.opacity = '1';
            hasClickedRestart = false;
          }
          
          turnEl.textContent = isSpectator ? 'Spectating - Game Over' : 'Game Over - Results';
        }

        if (d.type === 'restartUpdate') {
          console.log(`=== RESTART UPDATE ===`);
  console.log(`isSpectator: ${isSpectator}, wantsToJoin: ${d.wantsToJoin}`);
  console.log(`readyCount: ${d.readyCount}, totalPlayers: ${d.totalPlayers}`);
  console.log(`spectatorsWantingToJoin: ${d.spectatorsWantingToJoin}`);
          
          if (d.isSpectator) {
            spectatorWantsToJoin = d.wantsToJoin || false;

            if (d.wantsToJoin) {
              spectatorHasClickedRestart = true;
            }
            console.log(`Updated spectatorWantsToJoin to: ${spectatorWantsToJoin}`);

            if (spectatorWantsToJoin) {
              restart.innerText =
                `Joining next game... (${d.readyCount}/${d.totalPlayers} players ready)`;
              restart.disabled = true;
              restart.style.opacity = '0.7';
            } else {
              restart.innerText = 'Join Next Game';
              restart.disabled = false;
              restart.style.opacity = '1';
              spectatorHasClickedRestart = false;
            }
          } else {
            if (d.playerRole) {
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
              if (hasClickedRestart) {
                restart.innerText = `Joining next game... (${d.readyCount}/${d.totalPlayers} players ready)`;
                restart.disabled = true;
                restart.style.opacity = '0.7';
              } else {
                restart.innerText = 'Join Next Game';
                restart.disabled = false;
                restart.style.opacity = '1';
              }
            }
          }
        }

        if (d.type === 'roleChanged') {
          isSpectator = false;
          spectatorWantsToJoin = false;
          spectatorHasClickedRestart = false;
          hasClickedRestart = false;
          
          if (d.playerName) {
            myPlayerName = d.playerName.replace('👁️ ', '').trim();
          } else {
            myPlayerName = nickname.value.replace('👁️ ', '').trim();
          }
          
          nickname.value = myPlayerName;
          nickname.disabled = false;
          
          if (document.getElementById('playerNameDisplay')) {
            document.getElementById('playerNameDisplay').textContent = myPlayerName;
          }
          
          restart.innerText = 'Restart Game';
          restart.disabled = false;
          restart.style.opacity = '1';
          
          if (gameCard && !gameCard.classList.contains('hidden')) {
            restart.classList.remove('hidden');
          }
          
          if (lobbyCard && !lobbyCard.classList.contains('hidden')) {
            nickname.value = myPlayerName;
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
      
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      
      if (window.pingInterval) {
        clearInterval(window.pingInterval);
        window.pingInterval = null;
      }
      
      stopTurnTimerAnimation();
      stopImpostorGuessTimerAnimation();
      
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
      
      scheduleReconnect();
    };
  } catch (error) {
    safeError('Failed to create WebSocket:', error);
    updateConnectionStatus('disconnected', 'Failed to connect');
    scheduleReconnect();
  }
}

function updateVoteCountDisplay() {
  const voteCountElement = document.getElementById('voteCountDisplay');
  if (voteCountElement) {
    voteCountElement.textContent = `Selected: ${selectedVotes.length}/2`;
    if (selectedVotes.length === 2) {
      voteCountElement.style.color = '#2ecc71';
    } else {
      voteCountElement.style.color = '#f39c12';
    }
  }
}

window.vote = (v, btnElement) => {
  if (isSpectator) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  
  if (twoImpostorsMode) {
    const index = selectedVotes.indexOf(v);
    
    if (index === -1) {
      if (selectedVotes.length < 2) {
        selectedVotes.push(v);
        btnElement.style.background = '#fff';
        btnElement.style.color = '#000';
        btnElement.style.fontWeight = 'bold';
      } else {
        const firstVote = selectedVotes[0];
        const firstButton = document.querySelector(`.vote-btn:contains('${firstVote}')`);
        if (firstButton) {
          firstButton.style.background = '';
          firstButton.style.color = '';
          firstButton.style.fontWeight = '';
        }
        selectedVotes.shift();
        selectedVotes.push(v);
        btnElement.style.background = '#fff';
        btnElement.style.color = '#000';
        btnElement.style.fontWeight = 'bold';
      }
    } else {
      selectedVotes.splice(index, 1);
      btnElement.style.background = '';
      btnElement.style.color = '';
      btnElement.style.fontWeight = '';
    }
    
    updateVoteCountDisplay();
    
    if (selectedVotes.length === 2 && !hasSubmittedVotes) {
      submitVotes();
    }
  } else {
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
  }
};

function submitVotes() {
  if (hasSubmittedVotes || selectedVotes.length === 0) return;
  
  if (twoImpostorsMode) {
    if (selectedVotes.length !== 2) {
      const voteCountElement = document.getElementById('voteCountDisplay');
      if (voteCountElement) {
        voteCountElement.style.color = '#e74c3c';
        voteCountElement.textContent = 'Please select exactly 2 players';
        setTimeout(() => {
          updateVoteCountDisplay();
        }, 2000);
      }
      return;
    }
    
    // Check for duplicate votes
    const uniqueVotes = [...new Set(selectedVotes)];
    if (uniqueVotes.length !== 2) {
      const voteCountElement = document.getElementById('voteCountDisplay');
      if (voteCountElement) {
        voteCountElement.style.color = '#e74c3c';
        voteCountElement.textContent = 'Cannot vote for same player twice';
        setTimeout(() => {
          updateVoteCountDisplay();
        }, 2000);
      }
      return;
    }
  }
  
  ws.send(JSON.stringify({ type: 'vote', vote: twoImpostorsMode ? selectedVotes : selectedVotes[0] }));
  hasSubmittedVotes = true;
  
  const buttons = document.querySelectorAll('.vote-btn');
  buttons.forEach(b => {
    b.style.opacity = '0.3';
    b.style.pointerEvents = 'none';
  });
  
  const voteCountElement = document.getElementById('voteCountDisplay');
  if (voteCountElement) {
    voteCountElement.textContent = 'Votes submitted!';
    voteCountElement.style.color = '#2ecc71';
  }
}

window.clearVotes = () => {
  selectedVotes = [];
  hasSubmittedVotes = false;
  
  const buttons = document.querySelectorAll('.vote-btn');
  buttons.forEach(b => {
    b.style.background = '';
    b.style.color = '';
    b.style.fontWeight = '';
    b.style.opacity = '1';
    b.style.pointerEvents = 'auto';
  });
  
  updateVoteCountDisplay();
};

function submitImpostorGuess() {
  if (!input.value.trim() || !isEjectedImpostor) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  
  ws.send(JSON.stringify({ 
    type: 'impostorGuess', 
    guess: input.value.trim() 
  }));
  
  input.value = '';
  input.disabled = true;
  submit.disabled = true;
  submit.textContent = 'Guess Submitted';
  isEjectedImpostor = false;
}

function submitWord() {
  if (!input.value.trim() || isSpectator) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  ws.send(JSON.stringify({ type: 'submitWord', word: input.value.trim() }));
  input.value = '';
}

function toggleTwoImpostorsOption() {
  const checkbox = document.querySelector('#twoImpostorsToggle input[type="checkbox"]');
  if (!checkbox || !ws || ws.readyState !== WebSocket.OPEN) return;
  
  ws.send(JSON.stringify({ 
    type: 'toggleTwoImpostors', 
    enabled: checkbox.checked 
  }));
}

function toggleImpostorGuessOption() {
  const checkbox = document.querySelector('#impostorGuessToggle input[type="checkbox"]');
  if (!checkbox || !ws || ws.readyState !== WebSocket.OPEN) return;
  
  ws.send(JSON.stringify({ 
    type: 'toggleImpostorGuess', 
    enabled: checkbox.checked 
  }));
}

function updateTwoImpostorsToggle() {
  const twoImpostorsToggle = document.getElementById('twoImpostorsToggle');
  if (!twoImpostorsToggle) return;
  
  if (isSpectator) {
    twoImpostorsToggle.style.display = 'none';
    return;
  }
  
  twoImpostorsToggle.style.display = 'flex';
  const checkbox = twoImpostorsToggle.querySelector('input[type="checkbox"]');
  const label = twoImpostorsToggle.querySelector('.toggle-label');
  
  if (checkbox && label) {
    checkbox.checked = twoImpostorsOption;
    checkbox.disabled = !isOwner;
    
    if (isOwner) {
      label.style.color = '#fff';
      label.style.cursor = 'pointer';
      checkbox.style.cursor = 'pointer';
    } else {
      label.style.color = '#95a5a6';
      label.style.cursor = 'not-allowed';
      checkbox.style.cursor = 'not-allowed';
    }
  }
}

function updateImpostorGuessToggle() {
  const impostorGuessToggle = document.getElementById('impostorGuessToggle');
  if (!impostorGuessToggle) return;
  
  if (isSpectator) {
    impostorGuessToggle.style.display = 'none';
    return;
  }
  
  impostorGuessToggle.style.display = 'flex';
  const checkbox = impostorGuessToggle.querySelector('input[type="checkbox"]');
  const label = impostorGuessToggle.querySelector('.toggle-label');
  
  if (checkbox && label) {
    checkbox.checked = impostorGuessOption;
    checkbox.disabled = !isOwner;
    
    if (isOwner) {
      label.style.color = '#fff';
      label.style.cursor = 'pointer';
      checkbox.style.cursor = 'pointer';
    } else {
      label.style.color = '#95a5a6';
      label.style.cursor = 'not-allowed';
      checkbox.style.cursor = 'not-allowed';
    }
  }
}

function showImpostorGuessInfo() {
  alert('When enabled, if impostors are voted out, they get a 30-second last chance to guess the secret word. If any impostor guesses correctly, they win! Otherwise, civilians win!\n\n• Single impostor mode: Only the ejected impostor guesses\n• Two impostors mode: All ejected impostors get to guess');
}

function showTwoImpostorsInfo() {
  alert('When enabled, the game will have 2 impostors instead of 1. In voting phase, select 2 players you think are impostors. The top 2 voted players will be ejected. Game winning logic:\n\n• Both impostors voted out → Civilians win\n• No impostors voted out → Impostors win\n• One impostor voted out → Draw\n\nNote: Requires at least 4 players for balanced gameplay.');
}

join.onclick = () => joinAsPlayer(false);
spectate.onclick = joinAsSpectator;
exitLobbyBtn.onclick = exitLobby;

start.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  ws.send(JSON.stringify({ type: 'startGame' }));
};

submit.onclick = submitWord;

restart.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showConnectionWarning('Connection lost. Please wait for reconnection...');
    return;
  }
  
  // Prevent double clicks
  if (restart.disabled) return;
  
  if (isSpectator) {
    if (!spectatorHasClickedRestart) {
      spectatorHasClickedRestart = true;
      spectatorWantsToJoin = true;
      
      // Visual feedback
      restart.innerText = 'Joining next game...';
      restart.disabled = true;
      restart.style.opacity = '0.7';
      
      // Send restart request
      ws.send(JSON.stringify({ type: 'restart' }));
    }
  } else {
    if (!hasClickedRestart) {
      hasClickedRestart = true;
      
      // Visual feedback
      restart.innerText = 'Waiting for others...';
      restart.disabled = true;
      restart.style.opacity = '0.7';
      
      // Send restart request
      ws.send(JSON.stringify({ type: 'restart' }));
    }
  }
};

nickname.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinAsPlayer(false);
});

lobbyId.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinAsPlayer(false);
});

input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    if (isEjectedImpostor && submit.onclick === submitImpostorGuess) {
      submitImpostorGuess();
    } else if (!isSpectator) {
      submitWord();
    }
  }
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    safeLog('Page restored from bfcache, forcing reconnect');
    setTimeout(() => {
      forceImmediateReconnect();
    }, 100);
  }
});

window.addEventListener('online', () => {
  safeLog('Network came online, checking connection');
  if (currentLobbyId && (!ws || ws.readyState !== WebSocket.OPEN)) {
    safeLog('Network restored while in game - reconnecting immediately');
    setTimeout(() => {
      forceImmediateReconnect();
    }, 100);
  }
});

setInterval(() => {
  if (gameCard && !gameCard.classList.contains('hidden')) {
    if (ws && ws.readyState !== WebSocket.OPEN) {
      safeLog('Periodic check: WebSocket not open, forcing reconnect');
      forceReconnect();
    }
    else if (!ws) {
      safeLog('Periodic check: No WebSocket, forcing reconnect');
      forceReconnect();
    }
    else if (lastPingTime > 0 && (Date.now() - lastPingTime > 60000)) {
      safeLog('Periodic check: No pong in 60s, forcing reconnect');
      forceReconnect();
    }
  }
}, 30000);

window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'disconnecting' }));
    } catch (err) {
    }
  }
});

const style = document.createElement('style');
style.textContent = `
  .guess-result {
    margin: 5px 0;
    padding: 5px 10px;
    border-radius: 4px;
  }
  .guess-correct {
    background-color: rgba(46, 204, 113, 0.2);
    border-left: 3px solid #2ecc71;
  }
  .guess-incorrect {
    background-color: rgba(231, 76, 60, 0.2);
    border-left: 3px solid #e74c3c;
  }
  .role-badge {
    display: inline-block;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    font-size: 10px;
    font-weight: bold;
    text-align: center;
    line-height: 18px;
    margin-left: 5px;
  }
  .role-badge.role-civilian {
    background-color: #2ecc71;
    color: white;
  }
  .role-badge.role-impostor {
    background-color: #e74c3c;
    color: white;
  }
`;
document.head.appendChild(style);

updateConnectionStatus('disconnected');
safeLog('Game client initialized');

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (lobbyCard && !lobbyCard.classList.contains('hidden')) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        joinType = 'browseLobbies';
        connect();
      } else {
        refreshLobbyList();
      }
      startLobbyListAutoRefresh();
    }
  }, 100);
});
