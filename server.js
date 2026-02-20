const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory game state
let game = createNewGame();

function createNewGame() {
  return {
    board: Array(9).fill(null),
    currentPlayer: 'X',
    winner: null,
    winningLine: null,
    isDraw: false,
    moveCount: 0,
    scores: { X: 0, O: 0, draws: 0 }
  };
}

const WIN_PATTERNS = [
  [0,1,2],[3,4,5],[6,7,8], // rows
  [0,3,6],[1,4,7],[2,5,8], // cols
  [0,4,8],[2,4,6]           // diags
];

function checkWinner(board) {
  for (const [a,b,c] of WIN_PATTERNS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a,b,c] };
    }
  }
  return null;
}

// GET /api/game — get current state
app.get('/api/game', (req, res) => {
  res.json(sanitize(game));
});

// POST /api/move — make a move
app.post('/api/move', (req, res) => {
  const { index } = req.body;

  if (typeof index !== 'number' || index < 0 || index > 8) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  if (game.board[index] !== null) {
    return res.status(400).json({ error: 'Cell already taken' });
  }
  if (game.winner || game.isDraw) {
    return res.status(400).json({ error: 'Game is over' });
  }

  game.board[index] = game.currentPlayer;
  game.moveCount++;

  const result = checkWinner(game.board);
  if (result) {
    game.winner = result.winner;
    game.winningLine = result.line;
    game.scores[result.winner]++;
  } else if (game.moveCount === 9) {
    game.isDraw = true;
    game.scores.draws++;
  } else {
    game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
  }

  res.json(sanitize(game));
});

// POST /api/reset — reset the board (keep scores)
app.post('/api/reset', (req, res) => {
  const scores = { ...game.scores };
  game = createNewGame();
  game.scores = scores;
  res.json(sanitize(game));
});

// POST /api/new — full new game (reset scores too)
app.post('/api/new', (req, res) => {
  game = createNewGame();
  res.json(sanitize(game));
});

function sanitize(g) {
  return {
    board: g.board,
    currentPlayer: g.currentPlayer,
    winner: g.winner,
    winningLine: g.winningLine,
    isDraw: g.isDraw,
    scores: g.scores
  };
}

app.listen(PORT, () => {
  console.log(`Tic Tac Toe server running at http://localhost:${PORT}`);
});
