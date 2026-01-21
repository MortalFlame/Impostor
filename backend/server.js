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
    word: w.word.charAt(0).toUpperCase()+w.word.slice(1),
    hint: w.hint.charAt(0).toUpperCase()+w.hint.slice(1)
}));

let lobbies = {};
let usedWordIndexes = [];

function getRandomWord() {
    if(usedWordIndexes.length>=words.length) usedWordIndexes=[];
    let availableIndexes = words.map((_,i)=>i).filter(i=>!usedWordIndexes.includes(i));
    const index = availableIndexes[crypto.randomInt(0, availableIndexes.length)];
    usedWordIndexes.push(index);
    return words[index];
}

function broadcast(lobbyId, data){
    lobbies[lobbyId].players.forEach(p=>{
        if(p.ws.readyState===p.ws.OPEN) p.ws.send(JSON.stringify(data));
    });
}

function startGame(lobby){
    const impostorIndex = crypto.randomInt(0, lobby.players.length);
    lobby.players.forEach((p,i)=>p.role=(i===impostorIndex?'impostor':'civilian'));
    const wordPair = getRandomWord();
    lobby.secretWord = wordPair.word;
    lobby.hint = wordPair.hint;
    lobby.phase='round1';
    lobby.turnIndex=0;
    lobby.round1Submissions=[];
    lobby.round2Submissions=[];
    lobby.restartReady=[];

    lobby.players.forEach(p=>{
        p.ws.send(JSON.stringify({
            type:'gameStart',
            role:p.role,
            word:p.role==='civilian'?lobby.secretWord:lobby.hint
        }));
    });

    broadcast(lobby.id,{
        type:'turnUpdate',
        submissions:[],
        currentPlayer:lobby.players[lobby.turnIndex].name,
        phase:lobby.phase,
        round1Submissions:[]
    });
}

wss.on('connection', ws=>{
    let currentLobby = null;
    let playerName = null;
    let playerId = null;

    ws.on('message', message=>{
        const msg = JSON.parse(message);
        switch(msg.type){
            case 'joinLobby':
                playerName = msg.name;
                playerId = msg.playerId || crypto.randomUUID();

                currentLobby = msg.lobbyId;
                if(!currentLobby){
                    currentLobby = Math.floor(1000+Math.random()*9000).toString();
                    ws.send(JSON.stringify({ type:'lobbyAssigned', lobbyId:currentLobby }));
                }

                if(!lobbies[currentLobby]) lobbies[currentLobby] = { id:currentLobby, players:[], phase:'lobby', turnIndex:0, round1Submissions:[], round2Submissions:[], restartReady:[] };

                const lobby = lobbies[currentLobby];
                const existing = lobby.players.find(p=>p.id===playerId);
                if(existing){
                    existing.ws = ws;
                    existing.disconnected = false;
                } else {
                    lobby.players.push({ name:playerName, id:playerId, ws, role:'', vote:'', disconnected:false });
                }

                broadcast(currentLobby,{ type:'lobbyUpdate', players:lobby.players.map(p=>p.name) });
                break;

            case 'startGame':
                if(!currentLobby) return;
                startGame(lobbies[currentLobby]);
                break;

            case 'submitWord':
                if(!currentLobby) return;
                const lobbySub = lobbies[currentLobby];
                const player = lobbySub.players[lobbySub.turnIndex];
                if(ws!==player.ws) return;

                const word = msg.word.charAt(0).toUpperCase()+msg.word.slice(1);
                if(lobbySub.phase==='round1') lobbySub.round1Submissions.push({ name:player.name, word });
                if(lobbySub.phase==='round2') lobbySub.round2Submissions.push({ name:player.name, word });

                // Advance turn, skip disconnected
                do{
                    lobbySub.turnIndex = (lobbySub.turnIndex+1) % lobbySub.players.length;
                }while(lobbySub.players[lobbySub.turnIndex].disconnected);

                if(lobbySub.turnIndex===0){ // round over
                    if(lobbySub.phase==='round1'){
                        lobbySub.phase='round2';
                        broadcast(currentLobby,{
                            type:'roundsSummary',
                            round1:lobbySub.round1Submissions
                        });
                    } else if(lobbySub.phase==='round2'){
                        lobbySub.phase='voting';
                        broadcast(currentLobby,{
                            type:'roundsSummary',
                            round1:lobbySub.round1Submissions,
                            round2:lobbySub.round2Submissions
                        });
                        broadcast(currentLobby,{ type:'startVoting', players:lobbySub.players.map(p=>p.name) });
                    }
                }

                // Send current turn
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
                voter.vote = msg.vote;

                if(lobbyVote.players.every(p=>p.vote)){
                    const votesCount = {};
                    lobbyVote.players.forEach(p=>votesCount[p.vote]=(votesCount[p.vote]||0)+1);
                    const impostor = lobbyVote.players.find(p=>p.role==='impostor').name;
                    const selected = Object.keys(votesCount).reduce((a,b)=>votesCount[a]>=votesCount[b]?a:b);
                    const civiliansWin = selected===impostor;

                    const voteMap = {};
                    lobbyVote.players.forEach(p=>voteMap[p.name]=p.vote);

                    broadcast(currentLobby,{
                        type:'gameEnd',
                        impostor,
                        secretWord:lobbyVote.secretWord,
                        selected,
                        civiliansWin,
                        roles:lobbyVote.players.map(p=>({ name:p.name, role:p.role })),
                        votes:voteMap
                    });

                    lobbyVote.phase='lobby';
                    lobbyVote.players.forEach(p=>{ p.role=''; p.vote=''; });
                    lobbyVote.turnIndex=0;
                    lobbyVote.round1Submissions=[];
                    lobbyVote.round2Submissions=[];
                    lobbyVote.restartReady=[];
                }
                break;

            case 'restart':
                if(!currentLobby) return;
                const lobbyRestart = lobbies[currentLobby];
                if(!lobbyRestart.restartReady.includes(playerName)) lobbyRestart.restartReady.push(playerName);

                broadcast(currentLobby,{ type:'restartUpdate', ready:lobbyRestart.restartReady });

                if(lobbyRestart.restartReady.length === lobbyRestart.players.length){
                    lobbyRestart.restartReady=[];
                    startGame(lobbyRestart);
                }
                break;
        }
    });

    ws.on('close',()=>{
        if(!currentLobby) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(p=>p.ws===ws);
        if(p) p.disconnected=true;

        // remove after 15s if still disconnected
        setTimeout(()=>{
            const stillDisconnected = lobby.players.find(pl=>pl.id===p?.id && pl.disconnected);
            if(stillDisconnected){
                lobby.players = lobby.players.filter(pl=>pl.id!==p.id);
                broadcast(currentLobby,{ type:'lobbyUpdate', players:lobby.players.map(pl=>pl.name) });
            }
        },15000);
    });
});