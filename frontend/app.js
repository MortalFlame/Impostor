let ws = null;
let lobbyId = '';
let playerName = '';

const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');
const nicknameInput = document.getElementById('nickname');
const lobbyInput = document.getElementById('lobbyId');
const playersList = document.getElementById('playersList');
const lobbyCodeDisplay = document.getElementById('lobbyCodeDisplay');

const lobbyScreen = document.getElementById('lobbyScreen');
const gameScreen = document.getElementById('gameScreen');
const roleInfo = document.getElementById('roleInfo');
const wordPrompt = document.getElementById('wordPrompt');
const wordInput = document.getElementById('wordInput');
const submitWordBtn = document.getElementById('submitWordBtn');
const roundSubmissions = document.getElementById('roundSubmissions');
const votingDiv = document.getElementById('voting');
const voteButtonsDiv = document.getElementById('voteButtons');
const resultsDiv = document.getElementById('results');
const currentTurnDiv = document.getElementById('currentTurn');
const countdownDiv = document.getElementById('countdown');
const restartBtn = document.getElementById('restartBtn');

// Join lobby
joinBtn.onclick = () => {
    playerName = nicknameInput.value.trim();
    lobbyId = lobbyInput.value.trim();
    if (!playerName) return;

    ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}`);

    ws.onopen = () => {
        ws.send(JSON.stringify({
            type: 'joinLobby',
            name: playerName,
            lobbyId: lobbyId || undefined
        }));
    };

    ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);

        if (data.type === 'lobbyAssigned') {
            lobbyCodeDisplay.textContent = `Your lobby code: ${data.lobbyId}`;
            lobbyInput.value = data.lobbyId;
            lobbyId = data.lobbyId;
        }

        if (data.type === 'lobbyUpdate') {
            playersList.innerHTML = '';
            data.players.forEach(p => {
                const div = document.createElement('div');
                div.textContent = p;
                playersList.appendChild(div);
            });
            startBtn.disabled = data.players.length < 3;
        }

        if (data.type === 'gameStart') {
            lobbyScreen.style.display = 'none';
            gameScreen.style.display = 'block';
            roleInfo.textContent = `Role: ${data.role}`;
            wordPrompt.textContent = `Word: ${data.word}`;
            roundSubmissions.innerHTML = '';
            votingDiv.style.display = 'none';
            resultsDiv.style.display = 'none';
            restartBtn.style.display = 'none';
            countdownDiv.textContent = '';
        }

        if (data.type === 'turnUpdate') {
            const submissionsList = data.submissions.map(s => `${s.name}: ${s.word}`).join('\n');
            roundSubmissions.textContent = submissionsList;
            currentTurnDiv.textContent = data.currentPlayer ? `Current turn: ${data.currentPlayer}` : '';
            wordInput.disabled = (data.currentPlayer !== playerName);
            submitWordBtn.disabled = (data.currentPlayer !== playerName);
        }

        if (data.type === 'roundsSummary') {
            let html = '';
            if (data.round1) {
                html += '<strong>Round 1:</strong><br>';
                data.round1.forEach(s => { html += `${s.name}: ${s.word}<br>`; });
            }
            if (data.round2) {
                html += '<strong>Round 2:</strong><br>';
                data.round2.forEach(s => { html += `${s.name}: ${s.word}<br>`; });
            }
            roundSubmissions.innerHTML = html;
        }

        if (data.type === 'startVoting') {
            votingDiv.style.display = 'block';
            voteButtonsDiv.innerHTML = '';
            data.players.forEach(name => {
                if (name !== playerName) {
                    const btn = document.createElement('button');
                    btn.textContent = name;
                    btn.className = 'voteButton';
                    btn.onclick = () => {
                        ws.send(JSON.stringify({ type: 'vote', vote: name }));
                        Array.from(voteButtonsDiv.children).forEach(b => b.disabled = true);
                    };
                    voteButtonsDiv.appendChild(btn);
                }
            });
        }

        if (data.type === 'gameEnd') {
            resultsDiv.style.display = 'block';
            resultsDiv.innerHTML = `
                <h3>Game Over</h3>
                <p>Impostor: ${data.impostor}</p>
                <p>Secret Word: ${data.secretWord}</p>
                <p>${data.civiliansWin ? 'Civilians Win!' : 'Impostor Wins!'}</p>
            `;
            restartBtn.style.display = 'inline-block';
            votingDiv.style.display = 'none';
        }

        if (data.type === 'countdown') {
            countdownDiv.textContent = `Next phase in: ${data.countdown}s`;
            if (data.countdown <= 0) countdownDiv.textContent = '';
        }
    };
};

// Start game
startBtn.onclick = () => ws.send(JSON.stringify({ type: 'startGame' }));

// Submit word
submitWordBtn.onclick = () => {
    const word = wordInput.value.trim();
    if (!word) return;
    ws.send(JSON.stringify({ type: 'submitWord', word }));
    wordInput.value = '';
};

// Restart game
restartBtn.onclick = () => {
    ws.send(JSON.stringify({ type: 'startGame' }));
    restartBtn.style.display = 'none';
    countdownDiv.textContent = '';
};
