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

// Function to update join button text based on lobby input
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

// Add event listeners for the lobby input
document.addEventListener('DOMContentLoaded', () => {
  const lobbyInput = document.getElementById('lobbyId');
  if (lobbyInput) {
    lobbyInput.addEventListener('input', updateJoinButtonText);
    lobbyInput.addEventListener('change', updateJoinButtonText);
    lobbyInput.addEventListener('keyup', updateJoinButtonText);
    
    // Initial update
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

// Timer animation variables
let timerAnimationFrame = null;
let currentTurnEndsAt = null;
let isMyTurn = false;

// Reconnection timers
let reconnectTimer = null;
let connectTimeout = null;
let visibilityReconnectTimer = null;

// Server restart detection
let lastServerId = localStorage.getItem('lastServerId');

// Lobby list auto-refresh
let lobbyListRefreshInterval = null;

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

// Absolute-time timer functions
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
      // Time's up
      stopTurnTimerAnimation();
      turnTimerEl.classList.add('hidden');
      turnEl.textContent = 'Time expired! Waiting for next player...';
      return;
    }
    
    // Update circular timer
    const circumference = 2 * Math.PI * 18;
    const totalDuration = 30000; // Fixed 30-second turns
    const progress = (remainingMs / totalDuration) * 100;
    const offset = circumference - (progress / 100) * circumference;
    
    updateTimerColor(timeLeftSeconds);
    timerProgress.style.strokeDashoffset = offset;
    
    // Update timer text
    timerText.textContent = timeLeftSeconds;
    
    // Continue animation
    timerAnimationFrame = requestAnimationFrame(animateTimer);
  }
  
  // Start animation
  timerAnimationFrame = requestAnimationFrame(animateTimer);
}

function stopTurnTimerAnimation() {
  if (timerAnimationFrame) {
    cancelAnimationFrame(timerAnimationFrame);
    timerAnimationFrame = null;
  }
  currentTurnEndsAt = null;
  turnTimerEl.classList.add('hidden');
}

function stopTurnTimer() {
  stopTurnTimerAnimation();
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

function updateLobbyList(lobbies) {
  const lobbyListContainer = document.getElementById('lobbyListContainer');
  if (!lobbyListContainer) return;
  
  // Ensure container is visible when we're browsing lobbies
  if (lobbyCard && !lobbyCard.classList.contains('hidden')) {
    lobbyListContainer.style.display = 'block';
  }
  
  // Sort lobbies by creation date (newest first)
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
      
      lobbiesHtml += `
        <div class="lobby-item" data-lobby-id="${lobby.id}">
          <div class="lobby-info">
            <div class="lobby-code">${lobby.id}</div>
            <div class="lobby-host">
              
              <span class="host-name" title="${lobby.host}">${lobby.host}</span>
            </div>
            <div class="lobby-stats">
              <span class="player-count">P: ${playerStatus}</span>
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
    
    // Add event listeners to join buttons
    document.querySelectorAll('.join-lobby-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const lobbyIdToJoin = e.target.getAttribute('data-lobby-id');
        if (lobbyIdToJoin) {
          document.getElementById('lobbyId').value = lobbyIdToJoin;
          joinAsPlayer(false);
        }
      });
    });
    
    // Add event listener to refresh button
    const refreshBtn = document.getElementById('refreshLobbies');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshLobbyList();
      });
    }
  }
}

function getTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return 'Long ago';
}

function refreshLobbyList() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'getLobbyList' }));
  }
}

// Auto-refresh lobby list every 5 seconds when on lobby screen
function startLobbyListAutoRefresh() {
  // Clear any existing interval first
  if (lobbyListRefreshInterval) {
    clearInterval(lobbyListRefreshInterval);
    lobbyListRefreshInterval = null;
  }
  
  // Start a new interval that refreshes every 5 seconds
  lobbyListRefreshInterval = setInterval(() => {
    // Only refresh if we're on the lobby screen (not in a game)
    if (lobbyCard && !lobbyCard.classList.contains('hidden') && 
        ws && ws.readyState === WebSocket.OPEN) {
      refreshLobbyList();
    }
  }, 5000); // 5 seconds
}

function stopLobbyListAutoRefresh() {
  if (lobbyListRefreshInterval) {
    clearInterval(lobbyListRefreshInterval);
    lobbyListRefreshInterval = null;
  }
}

// SINGLE visibility change handler (FIXED: removed duplicate)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentTurnEndsAt && isMyTurn) {
    startTurnTimerAnimation(currentTurnEndsAt);
  } else if (document.hidden && timerAnimationFrame) {
    cancelAnimationFrame(timerAnimationFrame);
    timerAnimationFrame = null;
  }
  
  // Reconnection logic for visibility changes
  safeLog('Page visible - checking connection');
  if (!document.hidden) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      safeLog('Page visible but no active WebSocket, forcing reconnect');
      updateConnectionStatus('connecting', 'Page resumed, reconnecting...');
      
      setTimeout(() => {
        forceReconnect();
      }, 500);
    } else {
      lastPingTime = Date.now();
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (err) {
        safeLog('Failed to send ping after visibility change, reconnecting');
        setTimeout(() => {
          forceReconnect();
        }, 500);
      }
    }
  }
});

// Force reconnect function
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
      // Ignore
    }
    ws = null;
  }
  
  reconnectDelay = 2000;
  scheduleReconnect(true);
}

function exitLobby() {
  // Stop auto-refresh first
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
      // Ignore send errors
    }
    
    try {
      ws.close(1000, 'User exited lobby');
    } catch (err) {
      // Ignore close errors
    }
  }
  updateJoinButtonText();
  
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
  updateConnectionStatus('disconnected');
  
  stopTurnTimerAnimation();
  
  if (window.pingInterval) {
    clearInterval(window.pingInterval);
    window.pingInterval = null;
  }
  
  safeLog('Exited lobby');
  
  // FIX #2: Show the lobby list container
  const lobbyListContainer = document.getElementById('lobbyListContainer');
  if (lobbyListContainer) {
    lobbyListContainer.style.display = 'block';
  }
  
  // Refresh lobby list after exiting
  setTimeout(() => {
    refreshLobbyList();
  }, 500);
  
  // Start auto-refresh again
  startLobbyListAutoRefresh();
  
  // Reconnect for lobby browsing
  setTimeout(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      joinType = 'browseLobbies';
      connect();
    }
  }, 300);
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
  updateConnectionStatus('disconnected');
  
  stopTurnTimerAnimation();
  
  if (window.pingInterval) {
    clearInterval(window.pingInterval);
    window.pingInterval = null;
  }
  
  // FIX #2: Show the lobby list container
  const lobbyListContainer = document.getElementById('lobbyListContainer');
  if (lobbyListContainer) {
    lobbyListContainer.style.display = 'block';
  }
  
  // // Refresh lobby list when returning to lobby screen
setTimeout(() => {
  refreshLobbyList();
}, 500);

// Start auto-refresh of lobby list
startLobbyListAutoRefresh();

// FIX #3: Reconnect for lobby browsing if not already connected
setTimeout(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    joinType = 'browseLobbies';
    connect();
  }
}, 100);
// Update join button text
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
  joinType = 'joinLobby';  // IMPORTANT: Set this before connect()
  connectionAttempts = 0;
  reconnectDelay = 2000;
  
  // Stop auto-refresh when joining a lobby
  stopLobbyListAutoRefresh();
  
  connect();
}

function joinAsSpectator() {
  isSpectator = true;
  spectatorWantsToJoin = false;
  spectatorHasClickedRestart = false;
  joinType = 'joinSpectator';  // IMPORTANT: Set this before connect()
  connectionAttempts = 0;
  reconnectDelay = 2000;
  
  // Stop auto-refresh when joining as spectator
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

  // Only require nickname for joinLobby or joinSpectator, not for browseLobbies
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
        // Ignore
      }
      ws = null;
    }
    
    ws = new WebSocket(wsUrl);
    connectionAttempts++;
    
    // Safari fix: Kill sockets stuck in CONNECTING state
    connectTimeout = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        safeLog('WebSocket stuck in CONNECTING, forcing close');
        try {
          ws.close();
        } catch (err) {
          // Ignore
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
  
  // Don't show game header for lobby browsing
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
  
  // FIX #2: Handle different connection types correctly
  setTimeout(() => {
    if (joinType === 'browseLobbies') {
      // For browsing lobbies, just send a getLobbyList request
      // Wait a bit to ensure connection is fully established
      try {
        ws.send(JSON.stringify({ type: 'getLobbyList' }));
      } catch (err) {
        safeError('Failed to send getLobbyList');
      }
    } else if (joinType === 'joinSpectator') {
      // Joining as spectator
      ws.send(JSON.stringify({
        type: 'joinSpectator',
        name: nickname.value.trim(),
        lobbyId: lobbyId.value.trim(),
        playerId
      }));
    } else {
      // Default: joining as player (host or regular player)
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
          
          // Show the lobby list container
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
          
          lobbyCodeDisplay.textContent = d.lobbyId;
          
          if (document.getElementById('playerNameDisplay')) {
            document.getElementById('playerNameDisplay').textContent = myPlayerName;
          }
          
          if (isSpectator) {
            nickname.value = nickname.value.startsWith('👁️ ') ? nickname.value : `👁️ ${nickname.value.trim()}`;
            nickname.disabled = true;
          }
          
          // Show exit button in header after joining lobby
          exitLobbyBtn.style.display = 'block';
          
          // Hide lobby list when in a lobby
          const lobbyListContainer = document.getElementById('lobbyListContainer');
          if (lobbyListContainer) {
            lobbyListContainer.style.display = 'none';
          }
          
          // FIX #3: Stop auto-refresh when assigned to a lobby
          stopLobbyListAutoRefresh();
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
          
          stopTurnTimerAnimation();
          
          if (d.currentPlayer === 'Voting Phase') {
            turnEl.textContent = isSpectator ? 'Spectating - Voting Starting...' : 'Round Complete - Voting Starting...';
            submit.disabled = true;
            input.value = '';
            input.placeholder = isSpectator ? 'Spectating voting...' : 'Get ready to vote...';
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
              
              // Use absolute time from server (turnEndsAt)
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
          
          turnEl.textContent = isSpectator ? 'Spectating - Vote for the Impostor!' : 'Vote for the Impostor!';
          input.value = '';
          input.placeholder = isSpectator ? 'Spectating votes...' : 'Voting in progress...';
          submit.disabled = true;
          isMyTurn = false;
          currentTurnEndsAt = null;
          
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
          stopTurnTimerAnimation();
          isMyTurn = false;
          currentTurnEndsAt = null;
          
          // FIXED: Don't show "Impostor Won" when impostor leaves
          const winnerColor = '#f39c12'; // Orange for neutral message
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
          
          // UPDATED: Word and hint on same line with proper alignment
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
            if (spectatorWantsToJoin) {
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
          isMyTurn = false;
          currentTurnEndsAt = null;
          
          const winnerColor = d.winner === 'Civilians' ? '#2ecc71' : '#e74c3c';
          
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
          
          // UPDATED: Word and hint on same line with proper alignment
          results.innerHTML =
            `<h2 style="color:${winnerColor}; text-align:center">${d.winner} Won!</h2>` +
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
            if (spectatorWantsToJoin) {
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
      
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      
      if (window.pingInterval) {
        clearInterval(window.pingInterval);
        window.pingInterval = null;
      }
      
      stopTurnTimerAnimation();
      
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
    if (restart.innerText === 'Join Next Game') {
      hasClickedRestart = true;
      ws.send(JSON.stringify({ type: 'restart' }));
      restart.innerText = 'Joining next game...';
      restart.disabled = true;
      restart.style.opacity = '0.7';
    } else if (restart.innerText === 'Restart Game') {
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
  if (e.key === 'Enter') joinAsPlayer(false);
});

lobbyId.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinAsPlayer(false);
});

input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !isSpectator) submit.click();
});

// Page lifecycle events for Android/Chrome
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    safeLog('Page restored from bfcache, forcing reconnect');
    setTimeout(() => {
      forceReconnect();
    }, 100);
  }
});

// Network online event for Android network switches
window.addEventListener('online', () => {
  safeLog('Network came online, checking connection');
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setTimeout(() => {
      forceReconnect();
    }, 500);
  }
});

// Periodic connection health check
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
      // Connection already closing
    }
  }
});

updateConnectionStatus('disconnected');
safeLog('Game client initialized');

// FIX #1: Auto-connect for lobby browsing AND start auto-refresh
// This runs immediately when page loads for ALL players
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    // Only connect if we're not already in a lobby/game
    if (lobbyCard && !lobbyCard.classList.contains('hidden')) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        joinType = 'browseLobbies';
        connect();
      } else {
        // Already connected, just refresh the lobby list
        refreshLobbyList();
      }
      startLobbyListAutoRefresh();
    }
  }, 100);
});
