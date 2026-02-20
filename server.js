const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rooms store ───────────────────────────────────────────────
// rooms[code] = { code, board, currentPlayer, winner, winningLine,
//                 isDraw, moveCount, scores,
//                 players: { X: ws|null, O: ws|null },
//                 disconnectTimers: { X: timer|null, O: timer|null },
//                 createdAt }
const rooms = {};
const ROOM_TTL = 10 * 60 * 1000;      // 10 min inactivity cleanup
const DISCONNECT_GRACE = 60 * 1000;   // 60 s to rejoin

// ── Helpers ───────────────────────────────────────────────────
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length: 4}, () => chars[Math.random() * chars.length | 0]).join(''); }
  while (rooms[code]);
  return code;
}

function createRoom() {
  const code = makeCode();
  rooms[code] = {
    code,
    board: Array(9).fill(null),
    currentPlayer: 'X',
    winner: null, winningLine: null,
    isDraw: false, moveCount: 0,
    scores: { X: 0, O: 0, draws: 0 },
    players: { X: null, O: null },
    disconnectTimers: { X: null, O: null },
    lastActivity: Date.now(),
  };
  return rooms[code];
}

const WIN_PATTERNS = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function checkWinner(board) {
  for (const [a,b,c] of WIN_PATTERNS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { winner: board[a], line: [a,b,c] };
  }
  return null;
}

function roomState(room, symbol) {
  const opp = symbol === 'X' ? 'O' : 'X';
  return {
    board: room.board,
    currentPlayer: room.currentPlayer,
    winner: room.winner,
    winningLine: room.winningLine,
    isDraw: room.isDraw,
    scores: room.scores,
    mySymbol: symbol,
    opponentConnected: room.players[opp] !== null,
    playerCount: (room.players.X ? 1 : 0) + (room.players.O ? 1 : 0),
  };
}

function broadcastRoom(room) {
  ['X','O'].forEach(sym => {
    const ws = room.players[sym];
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'state', payload: roomState(room, sym) }));
    }
  });
}

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

// Periodic room cleanup
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(code => {
    if (now - rooms[code].lastActivity > ROOM_TTL) {
      console.log('Cleaning up room', code);
      delete rooms[code];
    }
  });
}, 60 * 1000);

// ── Swap player symbols randomly ─────────────────────────────
function reshufflePlayers(room) {
  // Always randomly reassign — put both players in an array, shuffle, reassign
  const players = [room.players.X, room.players.O];
  // Fisher-Yates shuffle on 2 items = always 50/50 swap
  if (Math.random() < 0.5) players.reverse();
  room.players.X = players[0];
  room.players.O = players[1];
  if (players[0]) players[0].symbol = 'X';
  if (players[1]) players[1].symbol = 'O';
  room.currentPlayer = 'X';
}

// ── WebSocket handler ─────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.symbol = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type } = msg;

    // ── CREATE ROOM ──────────────────────────────────────────
    if (type === 'create') {
      const symbol = Math.random() < 0.5 ? 'X' : 'O';

      const room = createRoom();
      room.players[symbol] = ws;
      ws.roomCode = room.code;
      ws.symbol = symbol;

      send(ws, { type: 'created', code: room.code, symbol });
      send(ws, { type: 'state', payload: roomState(room, symbol) });
      console.log(`Room ${room.code} created — host assigned ${symbol}`);
    }

    // ── JOIN ROOM ────────────────────────────────────────────
    if (type === 'join') {
      const code = (msg.code || '').toString().toUpperCase().trim();
      const room = rooms[code];

      if (!room) return send(ws, { type: 'error', message: 'Room not found' });

      // Determine available symbol
      const available = ['X','O'].find(s => room.players[s] === null);
      if (!available) return send(ws, { type: 'error', message: 'Room is full' });

      // Cancel any pending disconnect timer for this symbol
      if (room.disconnectTimers[available]) {
        clearTimeout(room.disconnectTimers[available]);
        room.disconnectTimers[available] = null;
      }

      room.players[available] = ws;
      ws.roomCode = code;
      ws.symbol = available;
      room.lastActivity = Date.now();

      send(ws, { type: 'joined', code, symbol: available });
      broadcastRoom(room);
      console.log(`${available} joined room ${code}`);
    }

    // ── MOVE ─────────────────────────────────────────────────
    if (type === 'move') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const { index } = msg;

      if (room.currentPlayer !== ws.symbol)
        return send(ws, { type: 'error', message: 'Not your turn' });
      if (typeof index !== 'number' || index < 0 || index > 8 || room.board[index] || room.winner || room.isDraw)
        return send(ws, { type: 'error', message: 'Invalid move' });

      room.board[index] = ws.symbol;
      room.moveCount++;
      room.lastActivity = Date.now();

      const result = checkWinner(room.board);
      if (result) {
        room.winner = result.winner;
        room.winningLine = result.line;
        room.scores[result.winner]++;
      } else if (room.moveCount === 9) {
        room.isDraw = true;
        room.scores.draws++;
      } else {
        room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
      }

      broadcastRoom(room);
    }

    // ── RESET (keep scores) ───────────────────────────────────
    if (type === 'reset') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const scores = { ...room.scores };
      Object.assign(room, {
        board: Array(9).fill(null), currentPlayer: 'X',
        winner: null, winningLine: null,
        isDraw: false, moveCount: 0, scores,
      });
      reshufflePlayers(room);
      room.lastActivity = Date.now();
      // Notify each player of their (possibly new) symbol
      ['X','O'].forEach(sym => {
        const pw = room.players[sym];
        if (pw && pw.readyState === 1) pw.send(JSON.stringify({ type: 'symbolUpdate', symbol: sym }));
      });
      broadcastRoom(room);
    }

    // ── NEW GAME (wipe scores) ────────────────────────────────
    if (type === 'new') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      Object.assign(room, {
        board: Array(9).fill(null), currentPlayer: 'X',
        winner: null, winningLine: null,
        isDraw: false, moveCount: 0,
        scores: { X: 0, O: 0, draws: 0 },
      });
      reshufflePlayers(room);
      room.lastActivity = Date.now();
      ['X','O'].forEach(sym => {
        const pw = room.players[sym];
        if (pw && pw.readyState === 1) pw.send(JSON.stringify({ type: 'symbolUpdate', symbol: sym }));
      });
      broadcastRoom(room);
    }
  });

  // ── DISCONNECT ────────────────────────────────────────────
  ws.on('close', () => {
    const room = rooms[ws.roomCode];
    if (!room || !ws.symbol) return;

    const sym = ws.symbol;
    room.players[sym] = null;

    // Notify opponent
    const opp = sym === 'X' ? 'O' : 'X';
    const oppWs = room.players[opp];
    if (oppWs) send(oppWs, { type: 'opponentLeft', gracePeriod: 60 });

    // Start 60s grace timer
    room.disconnectTimers[sym] = setTimeout(() => {
      const r = rooms[ws.roomCode];
      if (!r) return;
      if (r.players[sym] === null) {
        // Still not reconnected — end the room
        const oppWs2 = r.players[opp];
        if (oppWs2) send(oppWs2, { type: 'roomClosed', reason: 'Opponent did not reconnect' });
        delete rooms[ws.roomCode];
        console.log(`Room ${ws.roomCode} closed — ${sym} did not reconnect`);
      }
    }, DISCONNECT_GRACE);

    console.log(`${sym} disconnected from room ${ws.roomCode}`);
  });
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
module.exports = app;
