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

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const wss = new WebSocketServer({ server });

let words = JSON.parse(fs.readFileSync(__dirname + '/words.json', 'utf-8'));
words = words.map(w => ({
    word: w.word.charAt(0).toUpperCase() + w.word.slice(1),
    hint: w.hint.charAt(0).toUpperCase() + w.hint.slice(1)
}));

let lobbies = {};
let usedWordIndexes = [];

function getRandomWord() {
    if (usedWordIndexes.length >= words.length) usedWordIndexes = [];
    let availableIndexes = words.map((_, i) => i).filter(i => !usedWordIndexes.includes(i));
    const index = availableIndexes[crypto.randomInt(0, availableIndexes.length)];
    usedWordIndexes.push(index);
    return words[index];
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
                    ws.send(JSON.stringify({ type:'lobbyAssigned', lobbyId }));
                }
                if (!lobbies[lobbyId]) lobbies[lobbyId] = { players:[], phase:'lobby', turnIndex:0, round1Submissions:[], round2Submissions:[] };
                currentLobby = lobbyId;
                lobbies[lobbyId].players.push({ name:playerName, ws, role:'', vote:'' });
                broadcast(currentLobby, { type:'lobbyUpdate', players:lobbies[currentLobby].players.map(p=>p.name) });
                break;

            case 'startGame':
                if(!currentLobby) return;
                const lobby = lobbies[currentLobby];
                if(lobby.players.length<3) return;

                const impostorIndex = crypto.randomInt(0, lobby.players.length);
                lobby.players.forEach((p,i)=>p.role=(i===impostorIndex?'impostor':'civilian'));

                const wordPair = getRandomWord();
                lobby.secretWord = wordPair.word;
                lobby.hint = wordPair.hint;

                lobby.phase='round1';
                lobby.turnIndex=0;
                lobby.round1Submissions=[];
                lobby.round2Submissions=[];

                lobby.players.forEach(p=>{
                    p.ws.send(JSON.stringify({
                        type:'gameStart',
                        role:p.role,
                        word: p.role==='civilian'?lobby.secretWord:lobby.hint
                    }));
                });

                broadcast(currentLobby, {
                    type:'turnUpdate',
                    submissions:[],
                    currentPlayer:lobby.players[lobby.turnIndex].name,
                    phase:lobby.phase,
                    round1Submissions:[]
                });
                break;

            case 'submitWord':
                if(!currentLobby) return;
                const lobbySub = lobbies[currentLobby];
                const player = lobbySub.players[lobbySub.turnIndex];
                if(ws!==player.ws) return;

                const word = msg.word.charAt(0).toUpperCase() + msg.word.slice(1);
                if(lobbySub.phase==='round1') lobbySub.round1Submissions.push({ name:player.name, word });
                if(lobbySub.phase==='round2') lobbySub.round2Submissions.push({ name:player.name, word });

                lobbySub.turnIndex++;

                if(lobbySub.turnIndex>=lobbySub.players.length){
                    if(lobbySub.phase==='round1'){
                        lobbySub.phase='round2';
                        lobbySub.turnIndex=0;
                        broadcast(currentLobby, {
                            type:'roundsSummary',
                            round1:lobbySub.round1Submissions
                        });
                        broadcast(currentLobby, {
                            type:'turnUpdate',
                            submissions:lobbySub.round2Submissions,
                            currentPlayer:lobbySub.players[lobbySub.turnIndex].name,
                            phase:lobbySub.phase,
                            round1Submissions:lobbySub.round1Submissions
                        });
                    } else if(lobbySub.phase==='round2'){
                        lobbySub.phase='voting';
                        lobbySub.turnIndex=0;
                        broadcast(currentLobby, {
                            type:'roundsSummary',
                            round1:lobbySub.round1Submissions,
                            round2:lobbySub.round2Submissions
                        });
                        broadcast(currentLobby, { type:'startVoting', players:lobbySub.players.map(p=>p.name) });
                    }
                }

                if(lobbySub.phase==='round1'||lobbySub.phase==='round2'){
                    broadcast(currentLobby,{
                        type:'turnUpdate',
                        submissions:lobbySub.phase==='round1'?lobbySub.round1Submissions:lobbySub.round2Submissions,
                        currentPlayer:lobbySub.players[lobbySub.turnIndex]?.name||null,
                        phase:lobbySub.phase,
                        round1Submissions:lobbySub.round1Submissions
                    });
                }
                break;

            case 'vote':
                if(!currentLobby) return;
                const lobbyVote = lobbies[currentLobby];
                const voter = lobbyVote.players.find(p=>p.ws===ws);
                voter.vote=msg.vote;

                if(lobbyVote.players.every(p=>p.vote)){
                    const votesCount={};
                    lobbyVote.players.forEach(p=>votesCount[p.vote]=(votesCount[p.vote]||0)+1);

                    let maxVotes=0,selected='';
                    for(const name in votesCount){
                        if(votesCount[name]>maxVotes){ maxVotes=votesCount[name]; selected=name; }
                    }

                    const impostor=lobbyVote.players.find(p=>p.role==='impostor').name;
                    const civiliansWin = selected===impostor;

                    broadcast(currentLobby,{
                        type:'gameEnd',
                        impostor,
                        secretWord:lobbyVote.secretWord,
                        selected,
                        civiliansWin,
                        roles:lobbyVote.players.map(p=>({ name:p.name, role:p.role }))
                    });

                    lobbyVote.phase='lobby';
                    lobbyVote.players.forEach(p=>{p.role='';p.vote='';});
                    lobbyVote.turnIndex=0;
                    lobbyVote.round1Submissions=[];
                    lobbyVote.round2Submissions=[];
                }
                break;
        }
    });

    ws.on('close',()=>{
        if(!currentLobby) return;
        const lobby = lobbies[currentLobby];
        lobby.players = lobby.players.filter(p=>p.ws!==ws);
        broadcast(currentLobby,{ type:'lobbyUpdate', players:lobby.players.map(p=>p.name) });
    });
});
