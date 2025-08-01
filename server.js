const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store game rooms
const gameRooms = new Map();

// Generate random room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Create new game room
function createGameRoom(roomId) {
  return {
    id: roomId,
    players: [],
    board: ['', '', '', '', '', '', '', '', ''],
    currentPlayer: 'X',
    gameActive: false,
    scores: { X: 0, O: 0, draws: 0 },
    gamesPlayed: 0,
    spectators: []
  };
}

// Check for winner
function checkWinner(board) {
  const winningCombinations = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  for (let combination of winningCombinations) {
    const [a, b, c] = combination;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return {
        winner: board[a],
        winningCells: combination
      };
    }
  }
  return null;
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create or join room
  socket.on('create-room', (data) => {
    const { playerName } = data;
    const roomId = generateRoomId();
    const gameRoom = createGameRoom(roomId);

    gameRoom.players.push({
      id: socket.id,
      name: playerName,
      symbol: 'X'
    });

    gameRooms.set(roomId, gameRoom);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;
    socket.symbol = 'X';

    socket.emit('room-created', {
      roomId,
      playerSymbol: 'X',
      playerName,
      gameRoom
    });

    console.log(`Room created: ${roomId} by ${playerName}`);
  });

  // Join existing room
  socket.on('join-room', (data) => {
    const { roomId, playerName } = data;
    const gameRoom = gameRooms.get(roomId);

    if (!gameRoom) {
      socket.emit('room-error', { message: 'Room not found' });
      return;
    }

    if (gameRoom.players.length >= 2) {
      // Join as spectator
      gameRoom.spectators.push({
        id: socket.id,
        name: playerName
      });
      socket.join(roomId);
      socket.roomId = roomId;
      socket.playerName = playerName;
      socket.isSpectator = true;

      socket.emit('joined-as-spectator', { gameRoom });
      socket.to(roomId).emit('spectator-joined', { playerName });
      return;
    }

    gameRoom.players.push({
      id: socket.id,
      name: playerName,
      symbol: 'O'
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;
    socket.symbol = 'O';

    // Game can start now
    gameRoom.gameActive = true;

    // Notify all players
    io.to(roomId).emit('game-ready', {
      gameRoom,
      message: 'Both players joined! Game starting...'
    });

    console.log(`${playerName} joined room: ${roomId}`);
  });

  // Handle game moves
  socket.on('make-move', (data) => {
    const { roomId, cellIndex } = data;
    const gameRoom = gameRooms.get(roomId);

    if (!gameRoom || !gameRoom.gameActive) {
      socket.emit('move-error', { message: 'Game not active' });
      return;
    }

    // Check if it's player's turn
    const player = gameRoom.players.find(p => p.id === socket.id);
    if (!player || player.symbol !== gameRoom.currentPlayer) {
      socket.emit('move-error', { message: 'Not your turn' });
      return;
    }

    // Check if cell is empty
    if (gameRoom.board[cellIndex] !== '') {
      socket.emit('move-error', { message: 'Cell already occupied' });
      return;
    }

    // Make the move
    gameRoom.board[cellIndex] = gameRoom.currentPlayer;

    // Check for winner
    const winResult = checkWinner(gameRoom.board);
    let gameEnded = false;

    if (winResult) {
      gameRoom.gameActive = false;
      gameRoom.scores[winResult.winner]++;
      gameRoom.gamesPlayed++;
      gameEnded = true;

      io.to(roomId).emit('game-won', {
        winner: winResult.winner,
        winnerName: player.name,
        winningCells: winResult.winningCells,
        gameRoom
      });
    } else if (gameRoom.board.every(cell => cell !== '')) {
      // Draw
      gameRoom.gameActive = false;
      gameRoom.scores.draws++;
      gameRoom.gamesPlayed++;
      gameEnded = true;

      io.to(roomId).emit('game-draw', { gameRoom });
    }

    if (!gameEnded) {
      // Switch player
      gameRoom.currentPlayer = gameRoom.currentPlayer === 'X' ? 'O' : 'X';
    }

    // Broadcast move to all players
    io.to(roomId).emit('move-made', {
      cellIndex,
      symbol: player.symbol,
      playerName: player.name,
      gameRoom
    });
  });

  // Reset game
  socket.on('reset-game', (data) => {
    const { roomId } = data;
    const gameRoom = gameRooms.get(roomId);

    if (!gameRoom) return;

    gameRoom.board = ['', '', '', '', '', '', '', '', ''];
    gameRoom.currentPlayer = 'X';
    gameRoom.gameActive = gameRoom.players.length === 2;

    io.to(roomId).emit('game-reset', { gameRoom });
  });

  // Player reconnection
  socket.on('reconnect-to-room', (data) => {
    const { roomId, playerName } = data;
    const gameRoom = gameRooms.get(roomId);

    if (!gameRoom) {
      socket.emit('room-error', { message: 'Room not found' });
      return;
    }

    // Find player and update socket ID
    const player = gameRoom.players.find(p => p.name === playerName);
    if (player) {
      player.id = socket.id;
      socket.join(roomId);
      socket.roomId = roomId;
      socket.playerName = playerName;
      socket.symbol = player.symbol;

      socket.emit('reconnected', { gameRoom, playerSymbol: player.symbol });
      socket.to(roomId).emit('player-reconnected', { playerName });
    }
  });

  // Handle typing indicator for chat
  socket.on('typing', (data) => {
    socket.to(socket.roomId).emit('player-typing', {
      playerName: socket.playerName,
      isTyping: data.isTyping
    });
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    const { message } = data;
    const gameRoom = gameRooms.get(socket.roomId);

    if (!gameRoom) return;

    const chatMessage = {
      playerName: socket.playerName,
      message: message.trim(),
      timestamp: new Date().toLocaleTimeString(),
      isSpectator: socket.isSpectator || false
    };

    io.to(socket.roomId).emit('chat-message', chatMessage);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    if (socket.roomId) {
      const gameRoom = gameRooms.get(socket.roomId);
      if (gameRoom) {
        // Remove from spectators if spectator
        if (socket.isSpectator) {
          gameRoom.spectators = gameRoom.spectators.filter(s => s.id !== socket.id);
          socket.to(socket.roomId).emit('spectator-left', { playerName: socket.playerName });
        } else {
          // Notify other players about disconnection
          socket.to(socket.roomId).emit('player-disconnected', { 
            playerName: socket.playerName,
            symbol: socket.symbol
          });

          // Pause the game if a player disconnects
          if (gameRoom.gameActive) {
            gameRoom.gameActive = false;
            socket.to(socket.roomId).emit('game-paused', { 
              message: `${socket.playerName} disconnected. Game paused.` 
            });
          }
        }

        // Clean up empty rooms
        if (gameRoom.players.length === 0 && gameRoom.spectators.length === 0) {
          gameRooms.delete(socket.roomId);
          console.log(`Room ${socket.roomId} deleted (empty)`);
        }
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    activeRooms: gameRooms.size,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Real-Time Tic Tac Toe Server running on port ${PORT}`);
  console.log(`🕒 Started at: ${new Date().toISOString()}`);
});