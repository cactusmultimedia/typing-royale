const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── Config ────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const LANES = 'ASDFGHJKLÑ';  // 10 teclas — fila central español

const DIFFICULTIES = {
  facil:     { name: 'Nivel 1', noteSpeed: 0.35, spawnMs: 1200 },
  medio:     { name: 'Nivel 2', noteSpeed: 0.55, spawnMs: 900 },
  dificil:   { name: 'Nivel 3', noteSpeed: 0.80, spawnMs: 650 },
  dios:      { name: 'Nivel Dios', noteSpeed: 1.15, spawnMs: 450 },
};

let currentDifficulty = 'medio';
let NOTE_SPEED = DIFFICULTIES.medio.noteSpeed;
let SPAWN_INTERVAL_MS = DIFFICULTIES.medio.spawnMs;
const HIT_ZONE_Y = 520;       // donde el jugador debe presionar
const MISS_Y = 580;            // si pasa esto, se considera fallo
const MAX_LIVES = 5;           // vidas por jugador
const WRONG_KEY_PENALTY = 10;  // puntos perdidos por tecla equivocada

// ─── Estado del juego ──────────────────────────────────────
let tickCounter = 0;
let gameState = {
  notes: [],           // { id, lane, y, spawnedAt }
  players: new Map(),  // playerId -> { name, score, perfects, misses, combo, laneScores: {} }
  active: false,
  noteCounter: 0,
  spawnTimer: null,
  gameLoop: null,
  countdown: null,
  phase: 'waiting',    // waiting | countdown | playing | finished
  phaseEnd: null,
};

// ─── Servidor HTTP (sirve archivos estáticos) ────────────
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  let pathname = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;

  const filePath = path.join(__dirname, 'public', pathname);

  // Prevenir path traversal
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const mime = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error(`404: ${filePath} (${err.code})`);
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 - Not Found</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ─── WebSocket ─────────────────────────────────────────────
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function sendTo(ws, data) {
  ws.send(JSON.stringify(data));
}

// ─── Lógica del juego ──────────────────────────────────────

function spawnNote() {
  const laneIdx = Math.floor(Math.random() * LANES.length);
  const note = {
    id: gameState.noteCounter++,
    lane: laneIdx,
    y: -30,
    key: LANES[laneIdx],
  };
  gameState.notes.push(note);
}

function resetPlayerScores() {
  gameState.players.forEach(p => {
    p.score = 0;
    p.perfects = 0;
    p.misses = 0;
    p.combo = 0;
    p.hits = 0;
    p.lives = MAX_LIVES;
    p.eliminated = false;
  });
}

function startGame() {
  gameState.notes = [];
  gameState.noteCounter = 0;
  gameState.active = true;
  gameState.phase = 'countdown';
  gameState.phaseEnd = Date.now() + 3000;

  resetPlayerScores();
  broadcast({ type: 'phase', phase: 'countdown', endsAt: gameState.phaseEnd });

  // Después de la cuenta regresiva
  setTimeout(() => {
    gameState.phase = 'playing';
    broadcast({ type: 'phase', phase: 'playing' });

    // Spawn loop
    if (gameState.spawnTimer) clearInterval(gameState.spawnTimer);
    gameState.spawnTimer = setInterval(spawnNote, SPAWN_INTERVAL_MS);

    // Game loop
    if (gameState.gameLoop) clearInterval(gameState.gameLoop);
    gameState.gameLoop = setInterval(gameTick, 1000 / 60);
  }, 3000);
}

function gameTick() {
  if (gameState.phase !== 'playing') return;

  const now = Date.now();
  let anyActive = false;

  tickCounter++;

  // Mover notas y detectar fallos
  for (let i = gameState.notes.length - 1; i >= 0; i--) {
    const note = gameState.notes[i];
    note.y += NOTE_SPEED;

    if (note.y > MISS_Y) {
      // Miss - quienes no la presionaron pierden vida
      gameState.players.forEach(p => {
        if (!p.hitNotes || !p.hitNotes.has(note.id)) {
          p.misses++;
          p.combo = 0;
          p.lives = Math.max(0, p.lives - 1);
          if (p.lives <= 0 && !p.eliminated) {
            p.eliminated = true;
          }
        }
      });
      gameState.notes.splice(i, 1);
    } else if (note.y < 650) {
      anyActive = true;
    }
  }

  // Broadcast state (throttled ~20fps)
  if (tickCounter % 3 !== 0) return;

  const playersData = Array.from(gameState.players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score,
    perfects: p.perfects,
    misses: p.misses,
    combo: p.combo,
    hits: p.hits,
    lives: p.lives,
    eliminated: p.eliminated,
  }));

  // Ordenar por score descendente
  playersData.sort((a, b) => b.score - a.score);

  broadcast({
    type: 'gameState',
    notes: gameState.notes.map(n => ({ id: n.id, lane: n.lane, y: Math.round(n.y), key: n.key })),
    players: playersData,
  });

  if (!anyActive && gameState.notes.length === 0 && gameState.active) {
    // Terminar ronda si no hay más notas ni activas (después de un tiempo sin spawn)
    // Dejamos que siga hasta que no haya notas
  }
}

function handleKeyPress(ws, playerId, { key }) {
  const player = gameState.players.get(playerId);
  if (!player || gameState.phase !== 'playing') return;
  if (player.eliminated) return;

  const upperKey = key.toUpperCase();
  const laneIdx = LANES.indexOf(upperKey);
  if (laneIdx === -1) return;

  // Buscar la nota más cercana en este carril que no haya sido capturada
  let bestNote = null;
  let bestDist = Infinity;

  for (const note of gameState.notes) {
    if (note.lane !== laneIdx) continue;
    if (player.hitNotes && player.hitNotes.has(note.id)) continue;

    const dist = Math.abs(note.y - HIT_ZONE_Y);
    if (dist < bestDist) {
      bestDist = dist;
      bestNote = note;
    }
  }

  if (!bestNote) {
    // Tecla equivocada: no hay nota en este carril
    player.combo = 0;
    player.score = Math.max(0, player.score - WRONG_KEY_PENALTY);
    sendTo(ws, {
      type: 'wrongKey',
      penalty: WRONG_KEY_PENALTY,
      combo: 0,
      score: player.score,
    });
    return;
  }

  // Calcular puntuación basada en precisión
  let points = 0;
  let rating = 'miss';

  if (bestDist < 25) {
    points = 300;
    rating = 'perfect';
  } else if (bestDist < 60) {
    points = 200;
    rating = 'good';
  } else if (bestDist < 110) {
    points = 100;
    rating = 'ok';
  } else if (bestDist < 200) {
    points = 50;
    rating = 'bad';
  } else {
    points = 20;
    rating = 'early'; // reventada lejana
  }

  if (!player.hitNotes) player.hitNotes = new Set();
  player.hitNotes.add(bestNote.id);

  // Combo multiplier
  if (rating !== 'miss') {
    player.combo++;
    const multiplier = Math.min(1 + (player.combo - 1) * 0.1, 3);
    player.score += Math.round(points * multiplier);
    player.hits++;
    if (rating === 'perfect') player.perfects++;
  }

  // Efecto visual para este jugador
  sendTo(ws, {
    type: 'hitResult',
    noteId: bestNote.id,
    rating,
    points: Math.round(points * Math.min(1 + (player.combo - 1) * 0.1, 3)),
    combo: player.combo,
    score: player.score,
  });

  // Remover nota si alguien la acertó
  const noteStillExists = gameState.notes.find(n => n.id === bestNote.id);
  if (noteStillExists) {
    gameState.notes = gameState.notes.filter(n => n.id !== bestNote.id);
  }
}

// ─── Conexiones de clientes ──────────────────────────────

wss.on('connection', (ws) => {
  const playerId = `player_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  let playerName = 'Anónimo';

  sendTo(ws, {
    type: 'welcome',
    playerId,
    phase: gameState.phase,
    difficulty: currentDifficulty,
    difficultyName: DIFFICULTIES[currentDifficulty].name,
    difficulties: Object.keys(DIFFICULTIES),
    players: Array.from(gameState.players.entries()).map(([id, p]) => ({
      id, name: p.name, score: p.score,
    })),
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (data.type) {
      case 'join': {
        playerName = data.name || 'Anónimo';
        gameState.players.set(playerId, {
          name: playerName,
          score: 0,
          perfects: 0,
          misses: 0,
          combo: 0,
          hits: 0,
          lives: MAX_LIVES,
          eliminated: false,
          hitNotes: new Set(),
        });

        broadcast({
          type: 'playerJoined',
          playerId,
          name: playerName,
          players: Array.from(gameState.players.entries()).map(([id, p]) => ({
            id, name: p.name, score: p.score,
          })),
        });

        // Si es el primer jugador, iniciar el juego después de un momento
        if (gameState.players.size === 1 && gameState.phase === 'waiting') {
          // Esperar más jugadores
          setTimeout(() => {
            if (gameState.players.size >= 1 && gameState.phase === 'waiting') {
              startGame();
            }
          }, 5000); // 5 seg para que se unan más
        }
        break;
      }

      case 'keyPress': {
        handleKeyPress(ws, playerId, data);
        break;
      }

      case 'restart': {
        if (gameState.phase === 'playing' || gameState.phase === 'finished') {
          gameState.phase = 'waiting';
          if (gameState.spawnTimer) clearInterval(gameState.spawnTimer);
          if (gameState.gameLoop) clearInterval(gameState.gameLoop);
          startGame();
        }
        break;
      }

      case 'setDifficulty': {
        if (gameState.phase === 'waiting' && DIFFICULTIES[data.level]) {
          currentDifficulty = data.level;
          NOTE_SPEED = DIFFICULTIES[data.level].noteSpeed;
          SPAWN_INTERVAL_MS = DIFFICULTIES[data.level].spawnMs;
          broadcast({
            type: 'difficultyChanged',
            level: currentDifficulty,
            name: DIFFICULTIES[currentDifficulty].name,
          });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    gameState.players.delete(playerId);
    broadcast({
      type: 'playerLeft',
      playerId,
      players: Array.from(gameState.players.entries()).map(([id, p]) => ({
        id, name: p.name, score: p.score,
      })),
    });
  });
});

// ─── Iniciar ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🎮 Typing Royale corriendo en http://localhost:${PORT}`);
  console.log(`   Comparte la URL para que otros se unan!`);
});
