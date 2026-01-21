import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';

const SOCKET_URL = process.env.NODE_ENV === 'production' 
  ? window.location.origin 
  : 'http://localhost:3001';

const GAME_PHASES = {
  LOBBY: 'lobby',
  ROLE_REVEAL: 'role_reveal',
  ROUND_1: 'round_1',
  ROUND_1_REVEAL: 'round_1_reveal',
  ROUND_2: 'round_2',
  ROUND_2_REVEAL: 'round_2_reveal',
  VOTING: 'voting',
  RESULTS: 'results'
};

function App() {
  const [socket, setSocket] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [playerName, setPlayerName] = useState('');
  const [lobbyInput, setLobbyInput] = useState('');
  const [isJoined, setIsJoined] = useState(false);
  const [isSpectator, setIsSpectator] = useState(false);
  const [playerId, setPlayerId] = useState(null);
  const [currentSubmission, setCurrentSubmission] = useState('');
  const [selectedVote, setSelectedVote] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    newSocket.on('lobby-joined', (data) => {
      setIsJoined(true);
      setPlayerId(data.playerId);
      setIsSpectator(data.isSpectator);
    });

    newSocket.on('game-state-update', (state) => {
      setGameState(state);
    });

    newSocket.on('game-error', (data) => {
      setError(data.message);
      setTimeout(() => setError(''), 3000);
    });

    return () => newSocket.close();
  }, []);

  const joinLobby = (asSpectator = false) => {
    if (!playerName.trim()) return;
    socket.emit('join-lobby', {
      playerName: playerName.trim(),
      lobbyCode: lobbyInput.trim().toUpperCase() || null,
      isSpectator: asSpectator
    });
  };

  const startGame = () => {
    socket.emit('start-game', { lobbyCode: gameState.lobbyCode });
  };

  const submitWord = () => {
    if (!currentSubmission.trim()) return;
    socket.emit('submit-word', {
      lobbyCode: gameState.lobbyCode,
      word: currentSubmission.trim()
    });
    setCurrentSubmission('');
  };

  const submitVote = () => {
    if (!selectedVote) return;
    socket.emit('submit-vote', {
      lobbyCode: gameState.lobbyCode,
      votedPlayerId: selectedVote
    });
  };

  const resetGame = () => {
    socket.emit('reset-game', { lobbyCode: gameState.lobbyCode });
    setSelectedVote(null);
  };

  if (!isJoined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-5xl font-bold text-gray-800 mb-2">🎭</h1>
            <h2 className="text-3xl font-bold text-gray-800 mb-2">Impostor</h2>
            <p className="text-gray-600">Find the impostor among you!</p>
          </div>
          {error && (
            <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
              {error}
            </div>
          )}
          <div className="space-y-4">
            <input type="text" placeholder="Your nickname" value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:outline-none"
              maxLength={20} />
            <input type="text" placeholder="Lobby code (optional)" value={lobbyInput}
              onChange={(e) => setLobbyInput(e.target.value.toUpperCase())}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:outline-none"
              maxLength={6} />
            <button onClick={() => joinLobby(false)} disabled={!playerName.trim()}
              className="w-full bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition">
              {lobbyInput ? 'Join Lobby' : 'Create New Lobby'}
            </button>
            <button onClick={() => joinLobby(true)} disabled={!playerName.trim() || !lobbyInput.trim()}
              className="w-full bg-gray-600 text-white py-3 rounded-lg font-semibold hover:bg-gray-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition">
              Join as Spectator
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!gameState) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
        <div className="text-white text-2xl">Loading...</div>
      </div>
    );
  }

  const isHost = gameState.players.find(p => p.id === playerId)?.isHost;
  const hasSubmitted = gameState.submissions && gameState.submissions[playerId];
  const hasVoted = gameState.votes && gameState.votes[playerId];

  if (isSpectator) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-600 to-gray-800 p-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6">
            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-2">👁️ Spectator Mode</h2>
              <p className="text-sm text-gray-600">Lobby: {gameState.lobbyCode}</p>
            </div>
            {gameState.phase === GAME_PHASES.LOBBY && (
              <div>
                <h3 className="font-bold mb-3">Players ({gameState.players.length}/15)</h3>
                <div className="space-y-2">
                  {gameState.players.map(p => (
                    <div key={p.id} className="p-3 bg-gray-100 rounded-lg flex items-center gap-3">
                      <div className="w-10 h-10 bg-purple-500 rounded-full flex items-center justify-center text-white font-bold">
                        {p.name[0].toUpperCase()}
                      </div>
                      <span>{p.name}</span>
                      {p.isHost && <span className="ml-auto text-yellow-600">👑 Host</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {gameState.phase !== GAME_PHASES.LOBBY && (
              <div className="space-y-4">
                <div className="p-4 bg-yellow-100 border-2 border-yellow-400 rounded-lg">
                  <p className="font-bold">Secret Word: {gameState.secretWord}</p>
                  <p className="text-sm">Hint: {gameState.hint}</p>
                  <p className="text-sm mt-2">Impostor: {gameState.players.find(p => p.id === gameState.impostor)?.name}</p>
                </div>
                {(gameState.phase === GAME_PHASES.ROUND_1_REVEAL || 
                  gameState.phase === GAME_PHASES.ROUND_2_REVEAL || 
                  gameState.phase === GAME_PHASES.VOTING || 
                  gameState.phase === GAME_PHASES.RESULTS) && (
                  <div>
                    <h3 className="font-bold mb-2">Submissions:</h3>
                    {gameState.players.map(p => (
                      <div key={p.id} className="p-3 bg-gray-100 rounded mb-2">
                        <span className="font-medium">{p.name}: </span>
                        <span className={p.id === gameState.impostor ? 'text-red-600 font-bold' : ''}>
                          {gameState.submissions[p.id] || 'No submission'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (gameState.phase === GAME_PHASES.LOBBY) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 p-4">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6 mb-4">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-gray-800">Game Lobby</h2>
                <p className="text-sm text-gray-600">Code: {gameState.lobbyCode}</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-purple-600">{gameState.players.length}/15</div>
                <div className="text-sm text-gray-600">Players</div>
              </div>
            </div>
            <div className="space-y-3 mb-6">
              {gameState.players.map(player => (
                <div key={player.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-10 h-10 bg-gradient-to-br from-purple-400 to-blue-400 rounded-full flex items-center justify-center text-white font-bold">
                    {player.name[0].toUpperCase()}
                  </div>
                  <span className="font-medium text-gray-800">{player.name}</span>
                  {player.isHost && <span className="ml-auto text-yellow-600">👑</span>}
                  {player.id === playerId && <span className="ml-auto text-green-600">(You)</span>}
                </div>
              ))}
            </div>
            {gameState.spectators && gameState.spectators.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-gray-600 mb-2">Spectators</h3>
                <div className="space-y-2">
                  {gameState.spectators.map(spec => (
                    <div key={spec.id} className="p-2 bg-gray-100 rounded text-sm">
                      👁️ {spec.name}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {isHost && (
              <button onClick={startGame} disabled={gameState.players.length < 3}
                className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition">
                {gameState.players.length < 3 ? 'Need 3+ Players' : 'Start Game'}
              </button>
            )}
            {!isHost && gameState.players.length < 3 && (
              <div className="text-center text-gray-600">Waiting for more players...</div>
            )}
            {!isHost && gameState.players.length >= 3 && (
              <div className="text-center text-gray-600">Waiting for host to start...</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (gameState.phase === GAME_PHASES.ROLE_REVEAL) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md text-center">
          <h2 className="text-3xl font-bold mb-6">
            {gameState.isImpostor ? '🎭 You are the Impostor!' : '✅ You are a Civilian'}
          </h2>
          {gameState.isImpostor ? (
            <div className="space-y-4">
              <p className="text-lg text-gray-700">Your hint:</p>
              <div className="p-4 bg-red-50 border-2 border-red-300 rounded-lg">
                <p className="text-xl font-bold text-red-700">{gameState.hint}</p>
              </div>
              <p className="text-sm text-gray-600">Submit words related to this hint without being too obvious!</p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-lg text-gray-700">The secret word is:</p>
              <div className="p-4 bg-green-50 border-2 border-green-300 rounded-lg">
                <p className="text-xl font-bold text-green-700">{gameState.secretWord}</p>
              </div>
              <p className="text-sm text-gray-600">Submit related words to prove you know it!</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (gameState.phase === GAME_PHASES.ROUND_1 || gameState.phase === GAME_PHASES.ROUND_2) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 p-4">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6">
            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Round {gameState.currentRound}</h2>
              <p className="text-gray-600">
                {gameState.isImpostor ? `Hint: ${gameState.hint}` : `Word: ${gameState.secretWord}`}
              </p>
            </div>
            {!hasSubmitted ? (
              <div className="space-y-4 mb-6">
                <input type="text" placeholder="Enter your word..." value={currentSubmission}
                  onChange={(e) => setCurrentSubmission(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && submitWord()}
                  className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:outline-none"
                  maxLength={30} />
                <button onClick={submitWord} disabled={!currentSubmission.trim()}
                  className="w-full bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 disabled:bg-gray-300 transition">
                  Submit Word
                </button>
              </div>
            ) : (
              <div className="text-center p-8 mb-6">
                <div className="text-6xl mb-4">✓</div>
                <p className="text-lg text-gray-700">Word submitted!</p>
                <p className="text-sm text-gray-500 mt-2">Waiting for others...</p>
              </div>
            )}
            <div className="space-y-2">
              <h3 className="font-semibold text-gray-700 mb-3">Players:</h3>
              {gameState.players.map(player => (
                <div key={player.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-8 h-8 bg-gradient-to-br from-purple-400 to-blue-400 rounded-full flex items-center justify-center text-white text-sm font-bold">
                    {player.name[0].toUpperCase()}
                  </div>
                  <span className="text-gray-800">{player.name}</span>
                  {gameState.submissions[player.id] && <span className="ml-auto text-green-600">✓</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (gameState.phase === GAME_PHASES.ROUND_1_REVEAL || gameState.phase === GAME_PHASES.ROUND_2_REVEAL) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 p-4">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-6 text-center">
              Round {gameState.phase === GAME_PHASES.ROUND_1_REVEAL ? 1 : 2} Results
            </h2>
            <div className="space-y-3">
              {gameState.players.map(player => (
                <div key={player.id} className="p-4 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 bg-gradient-to-br from-purple-400 to-blue-400 rounded-full flex items-center justify-center text-white text-sm font-bold">
                      {player.name[0].toUpperCase()}
                    </div>
                    <span className="font-medium text-gray-800">{player.name}</span>
                  </div>
                  <p className="text-lg ml-11 text-purple-600 font-semibold">
                    "{gameState.submissions[player.id] || 'No submission'}"
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (gameState.phase === GAME_PHASES.VOTING) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 p-4">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-6 text-center">Vote for the Impostor</h2>
            {!hasVoted ? (
              <>
                <div className="space-y-3 mb-6">
                  {gameState.players.filter(p => p.id !== playerId).map(player => (
                    <button key={player.id} onClick={() => setSelectedVote(player.id)}
                      className={`w-full p-4 rounded-lg border-2 transition ${
                        selectedVote === player.id ? 'border-purple-600 bg-purple-50' : 'border-gray-300 hover:border-purple-400'
                      }`}>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gradient-to-br from-purple-400 to-blue-400 rounded-full flex items-center justify-center text-white font-bold">
                          {player.name[0].toUpperCase()}
                        </div>
                        <span className="font-medium text-gray-800">{player.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
                <button onClick={submitVote} disabled={!selectedVote}
                  className="w-full bg-red-600 text-white py-3 rounded-lg font-semibold hover:bg-red-700 disabled:bg-gray-300 transition">
                  Submit Vote
                </button>
              </>
            ) : (
              <div className="text-center p-8">
                <div className="text-6xl mb-4">✓</div>
                <p className="text-lg text-gray-700">Vote submitted!</p>
                <p className="text-sm text-gray-500 mt-2">Waiting for others...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (gameState.phase === GAME_PHASES.RESULTS) {
    const impostorPlayer = gameState.players.find(p => p.id === gameState.impostor);
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 p-4">
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl p-6">
            <div className="text-center mb-6">
              <h2 className="text-3xl font-bold mb-4">
                {gameState.winner === 'civilians' ? '✅ Civilians Win!' : '🎭 Impostor Wins!'}
              </h2>
              <div className="p-4 bg-red-50 rounded-lg mb-4">
                <p className="text-gray-700 mb-2">The impostor was:</p>
                <p className="text-2xl font-bold text-red-600">{impostorPlayer?.name}</p>
              </div>
              <div className="p-4 bg-green-50 rounded-lg">
                <p className="text-gray-700 mb-2">The secret word was:</p>
                <p className="text-2xl font-bold text-green-600">{gameState.secretWord}</p>
              </div>
            </div>
            {isHost && (
              <button onClick={resetGame}
                className="w-full bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 transition">
                Play Again
              </button>
            )}
            {!isHost && (
              <div className="text-center text-gray-600">Waiting for host to start next game...</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default App;
