// Your other existing code above

// Updated line 92
broadcast(lobby, { 
  type: 'lobbyUpdate', 
  players: lobby.players.map(p => p.name),
  owner: lobby.owner // Include owner in the message
});
// Your other existing code below