let ws = null;
let lobbyId = '';
let playerName = '';

const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');
const nicknameInput = document.getElementById('nickname');
const lobbyInput = document.getElementById('lobbyId');
const playersList = document.getElementById('playersList');

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

        // Random lobby assigned to first player
        if (data.type === 'lobbyAssigned') {
            alert(`Your lobby code is: ${data.lobbyId}\nShare this code with friends to join.`);
            lobbyInput.value = data.lobbyId;
            lobbyId = data.lobbyId;
        }

        // Lobby update
        if (data.type === 'lobbyUpdate') {
            playersList.innerHTML = '';
            data.players.forEach(p => {
                const div = document.createElement('div');
                div.textContent = p;
                playersList.appendChild(div);
            });
            startBtn.disabled = data.players.length < 3;
        }

        // Game start
        if (data.type === 'gameStart') {
            lobbyScreen.style.display = 'none';
            gameScreen.style.display = 'block';
            roleInfo.textContent = `Role: ${data.role}`;
            wordPrompt.textContent = `Word: ${data.word}`;
            roundSubmissions.innerHTML = '';
            votingDiv.style.display = 'none';
            resultsDiv.style.display = 'none';
        }

        // Round submissions
        if (data.type === 'roundResult') {
            roundSubmissions.innerHTML = `<h3>Round ${data.round} Submissions:</h3>`;
            data.submissions.forEach(s => {
                const div = document.createElement('div');
                div.textContent = `${s.name}: ${s.word}`;
                roundSubmissions.appendChild(div);
            });
        }

        // Voting phase
        if (data.type === 'startVoting') {
            votingDiv.style.display = 'block';
            voteButtonsDiv.innerHTML = '';
            data.players.forEach(name => {
                if (name !== playerName) {
                    const btn = document.createElement('button');
                    btn.textContent = name;
                    btn.onclick = () => {
                        ws.send(JSON.stringify({ type: 'vote', vote: name }));
                        Array.from(voteButtonsDiv.children).forEach(b => b.disabled = true);
                    };
                    voteButtonsDiv.appendChild(btn);
                }
            });
        }

        // Game results
        if (data.type === 'gameEnd') {
            resultsDiv.style.display = 'block';
            resultsDiv.innerHTML = `
                <h3>Game Over</h3>
                <p>Impostor: ${data.impostor}</p>
                <p>Secret Word: ${data.secretWord}</p>
                <p>${data.civiliansWin ? 'Civilians Win!' : 'Impostor Wins!'}</p>
            `;
        }
    };
};

// Start game button
startBtn.onclick = () => {
    ws.send(JSON.stringify({ type: 'startGame' }));
};

// Submit word
submitWordBtn.onclick = () => {
    const word = wordInput.value.trim();
    if (!word) return;
    ws.send(JSON.stringify({ type: 'submitWord', word }));
    wordInput.value = '';
};
