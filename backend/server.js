const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = process.env.FRONTEND_DIR || '../frontend';
app.use(express.static(FRONTEND_DIR));

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

// Load words
const WORDS_FILE = process.env.WORDS_FILE || __dirname + '/words.json';
const words = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf-8'));

let lobbies = {}; // lobbyId -> lobby state
let usedWordIndexes = []; // Track previously used words

// Random word selection avoiding repeats
function getRandomWord() {
    if (usedWordIndexes.length >= words.length) {
        usedWordIndexes = []; // reset if all words used
    }

    let availableIndexes = words.map((_, i) => i).filter(i => !usedWordIndexes.includes(i));
    const randomIndex = availableIndexes[crypto.randomInt(0, availableIndexes.length)];
    usedWordIndexes.push(randomIndex);

    return words[randomIndex];
}

function broadcast(lobbyId, data) {
    lobbies[lobbyId].players.forEach(p => {
        if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(data));
    });
}

wss.on('connection', (ws) => {
    let currentLobby = null;
    let playerName = null;

    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        switch(msg.type) {
            case 'joinLobby':
                playerName = msg.name;
                let lobbyId = msg.lobbyId;

                if (!lobbyId) {
                    lobbyId = Math.floor(1000 + Math.random() * 9000).toString();
                    ws.send(JSON.stringify({ type: 'lobbyAssigned', lobbyId }));
                }

                if (!lobbies[lobbyId]) {
                    lobbies[lobbyId] = { 
                        players: [], 
                        phase: 'lobby', 
                        turnIndex: 0, 
                        round1Submissions: [], 
                        round2Submissions: [] 
                    };
                }

                currentLobby = lobbyId;
                lobbies[lobbyId].players.push({ name: playerName, ws, role: '', vote: '' });

                broadcast(currentLobby, { type: 'lobbyUpdate', players: lobbies[currentLobby].players.map(p => p.name) });
                break;

            case 'startGame':
                if (!currentLobby) return;
                const lobby = lobbies[currentLobby];
                if (lobby.players.length < 3) return;

                const impostorIndex = crypto.randomInt(0, lobby.players.length);
                lobby.players.forEach((p,i) => p.role = (i === impostorIndex ? 'impostor' : 'civilian'));

                // Assign truly random word
                const wordPair = getRandomWord();
                lobby.secretWord = wordPair.word;
                lobby.hint = wordPair.hint;

                // Initialize round 1
                lobby.phase = 'round1';
                lobby.turnIndex = 0;
                lobby.round1Submissions = [];
                lobby.round2Submissions = [];

                // Notify players
                lobby.players.forEach(p => {
                    p.ws.send(JSON.stringify({
                        type: 'gameStart',
                        role: p.role,
                        word: p.role === 'civilian' ? lobby.secretWord : lobby.hint
                    }));
                });

                broadcast(currentLobby, {
                    type: 'turnUpdate',
                    submissions: [],
                    currentPlayer: lobby.players[lobby.turnIndex].name,
                    phase: lobby.phase
                });
                break;

            case 'submitWord':
                if (!currentLobby) return;
                const lobbySub = lobbies[currentLobby];
                const player = lobbySub.players[lobbySub.turnIndex];
                if (ws !== player.ws) return;

                const word = msg.word;
                if (lobbySub.phase === 'round1') lobbySub.round1Submissions.push({ name: player.name, word });
                if (lobbySub.phase === 'round2') lobbySub.round2Submissions.push({ name: player.name, word });

                lobbySub.turnIndex++;
                if (lobbySub.turnIndex >= lobbySub.players.length) {
                    if (lobbySub.phase === 'round1') {
                        lobbySub.phase = 'round2';
                        lobbySub.turnIndex = 0;
                        broadcast(currentLobby, { type: 'roundsSummary', round1: lobbySub.round1Submissions });
                    } else if (lobbySub.phase === 'round2') {
                        lobbySub.phase = 'voting';
                        lobbySub.turnIndex = 0;
                        broadcast(currentLobby, {
                            type: 'roundsSummary',
                            round1: lobbySub.round1Submissions,
                            round2: lobbySub.round2Submissions
                        });
                        broadcast(currentLobby, { type: 'startVoting', players: lobbySub.players.map(p => p.name) });
                    }
                }

                if (lobbySub.phase === 'round1' || lobbySub.phase === 'round2') {
                    broadcast(currentLobby, {
                        type: 'turnUpdate',
                        submissions: (lobbySub.phase === 'round1' ? lobbySub.round1Submissions : lobbySub.round2Submissions),
                        currentPlayer: lobbySub.players[lobbySub.turnIndex]?.name || null,
                        phase: lobbySub.phase
                    });
                }
                break;

            case 'vote':
                if (!currentLobby) return;
                const lobbyVote = lobbies[currentLobby];
                const voter = lobbyVote.players.find(p => p.ws === ws);
                voter.vote = msg.vote;

                if (lobbyVote.players.every(p => p.vote)) {
                    const votesCount = {};
                    lobbyVote.players.forEach(p => votesCount[p.vote] = (votesCount[p.vote] || 0) + 1);

                    let maxVotes = 0;
                    let selected = '';
                    for (const name in votesCount) {
                        if (votesCount[name] > maxVotes) {
                            maxVotes = votesCount[name];
                            selected = name;
                        }
                    }

                    const impostor = lobbyVote.players.find(p => p.role === 'impostor').name;
                    const civiliansWin = selected === impostor;

                    broadcast(currentLobby, {
                        type: 'gameEnd',
                        impostor,
                        secretWord: lobbyVote.secretWord,
                        selected,
                        civiliansWin
                    });

                    // Reset for next game
                    lobbyVote.phase = 'lobby';
                    lobbyVote.players.forEach(p => { p.role = ''; p.vote = ''; });
                    lobbyVote.turnIndex = 0;
                    lobbyVote.round1Submissions = [];
                    lobbyVote.round2Submissions = [];
                }
                break;
        }
    });

    ws.on('close', () => {
        if (!currentLobby) return;
        const lobby = lobbies[currentLobby];
        lobby.players = lobby.players.filter(p => p.ws !== ws);
        broadcast(currentLobby, { type: 'lobbyUpdate', players: lobby.players.map(p => p.name) });
    });
});
