const express = require('express');
broadcast(currentLobby, {
type: 'roundResult',
round: lobby1.phase,
submissions: lobby1.players.map(p => ({ name: p.name, word: p.submission }))
});


if (lobby1.phase === 'round1') {
lobby1.phase = 'round2';
lobby1.players.forEach(p => p.submission = '');
} else if (lobby1.phase === 'round2') {
lobby1.phase = 'voting';
lobby1.players.forEach(p => p.submission = '');
broadcast(currentLobby, { type: 'startVoting', players: lobby1.players.map(p => p.name) });
}
}
break;


case 'vote':
if (!currentLobby) return;
const lobby2 = lobbies[currentLobby];
const player2 = lobby2.players.find(p => p.ws === ws);
player2.vote = msg.vote;


if (lobby2.players.every(p => p.vote)) {
const votesCount = {};
lobby2.players.forEach(p => votesCount[p.vote] = (votesCount[p.vote] || 0) + 1);


let maxVotes = 0;
let selected = '';
for (const name in votesCount) {
if (votesCount[name] > maxVotes) {
maxVotes = votesCount[name];
selected = name;
}
}


const impostor = lobby2.players.find(p => p.role === 'impostor').name;
const civiliansWin = selected === impostor;


broadcast(currentLobby, {
type: 'gameEnd',
impostor,
secretWord: lobby2.secretWord,
selected,
civiliansWin
});


// Reset for new game
lobby2.phase = 'lobby';
lobby2.players.forEach(p => { p.role = ''; p.submission = ''; p.vote = ''; });
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
