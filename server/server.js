const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const GameManager = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
}

const gameManager = new GameManager();

// Socket.IO event handlers
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Join lobby
  socket.on('join-lobby', ({ playerName, lobbyCode, isSpectator = false }) => {
    try {
      const result = gameManager.joinLobby(socket.id, playerName, lobbyCode, isSpectator);
      socket.join(result.lobbyCode);
      socket.emit('lobby-joined', result);
      
      io.to(result.lobbyCode).emit('game-state-update', 
        gameManager.getGameState(result.lobbyCode)
      );
      
      console.log(`${playerName} joined ${result.lobbyCode} as ${isSpectator ? 'spectator' : 'player'}`);
    } catch (error) {
      socket.emit('game-error', { message: error.message });
    }
  });

  // Start game
  socket.on('start-game', ({ lobbyCode }) => {
    try {
      gameManager.startGame(lobbyCode, socket.id);
      
      const game = gameManager.games.get(lobbyCode);
      
      // Send personalized state to each player
      game.players.forEach(player => {
        const personalizedState = gameManager.getPersonalizedState(lobbyCode, player.id);
        io.to(player.id).emit('game-state-update', personalizedState);
      });
      
      // Send spectator state to spectators
      game.spectators.forEach(spectator => {
        io.to(spectator.id).emit('game-state-update', 
          gameManager.getSpectatorState(lobbyCode)
        );
      });
    } catch (error) {
      socket.emit('game-error', { message: error.message });
    }
  });

  // Submit word
  socket.on('submit-word', ({ lobbyCode, word }) => {
    try {
      gameManager.submitWord(lobbyCode, socket.id, word);
      
      const game = gameManager.games.get(lobbyCode);
      
      // Update all players
      game.players.forEach(player => {
        const personalizedState = gameManager.getPersonalizedState(lobbyCode, player.id);
        io.to(player.id).emit('game-state-update', personalizedState);
      });
      
      // Update spectators
      game.spectators.forEach(spectator => {
        io.to(spectator.id).emit('game-state-update', 
          gameManager.getSpectatorState(lobbyCode)
        );
      });
      
      // Auto-advance if all submitted
      if (gameManager.checkAllSubmitted(lobbyCode)) {
        setTimeout(() => {
          gameManager.advancePhase(lobbyCode);
          
          game.players.forEach(player => {
            io.to(player.id).emit('game-state-update', 
              gameManager.getPersonalizedState(lobbyCode, player.id)
            );
          });
          
          game.spectators.forEach(spectator => {
            io.to(spectator.id).emit('game-state-update', 
              gameManager.getSpectatorState(lobbyCode)
            );
          });
        }, 2000);
      }
    } catch (error) {
      socket.emit('game-error', { message: error.message });
    }
  });

  // Submit vote
  socket.on('submit-vote', ({ lobbyCode, votedPlayerId }) => {
    try {
      gameManager.submitVote(lobbyCode, socket.id, votedPlayerId);
      
      const game = gameManager.games.get(lobbyCode);
      
      // Update all players
      game.players.forEach(player => {
        io.to(player.id).emit('game-state-update', 
          gameManager.getPersonalizedState(lobbyCode, player.id)
        );
      });
      
      // Update spectators
      game.spectators.forEach(spectator => {
        io.to(spectator.id).emit('game-state-update', 
          gameManager.getSpectatorState(lobbyCode)
        );
      });
      
      // Auto-calculate results if all voted
      if (gameManager.checkAllVoted(lobbyCode)) {
        setTimeout(() => {
          gameManager.calculateResults(lobbyCode);
          
          game.players.forEach(player => {
            io.to(player.id).emit('game-state-update', 
              gameManager.getPersonalizedState(lobbyCode, player.id)
            );
          });
          
          game.spectators.forEach(spectator => {
            io.to(spectator.id).emit('game-state-update', 
              gameManager.getSpectatorState(lobbyCode)
            );
          });
        }, 2000);
      }
    } catch (error) {
      socket.emit('game-error', { message: error.message });
    }
  });

  // Reset game
  socket.on('reset-game', ({ lobbyCode }) => {
    try {
      gameManager.resetGame(lobbyCode, socket.id);
      io.to(lobbyCode).emit('game-state-update', 
        gameManager.getGameState(lobbyCode)
      );
    } catch (error) {
      socket.emit('game-error', { message: error.message });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    gameManager.handleDisconnect(socket.id);
    
    // Notify remaining players in affected lobbies
    gameManager.games.forEach((game, lobbyCode) => {
      io.to(lobbyCode).emit('game-state-update', 
        gameManager.getGameState(lobbyCode)
      );
    });
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeGames: gameManager.games.size,
    timestamp: new Date().toISOString()
  });
});

// Serve React app in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build/index.html'));
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 Impostor Word Game server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
