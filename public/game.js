// ─── Config ────────────────────────────────────────────────
const LANE_KEYS = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'];
const LANE_COUNT = LANE_KEYS.length;
const LANE_WIDTH = 70;
const CANVAS_WIDTH = LANE_COUNT * LANE_WIDTH; // 630
const CANVAS_HEIGHT = 600;
const HIT_ZONE_Y = 520;       // centro de la zona de impacto (coincide con el servidor)
const HIT_ZONE_TOLERANCE = 80; // rango total de detección visual

// ─── DOM refs ──────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;

const lobby = document.getElementById('lobby');
const gameScreen = document.getElementById('gameScreen');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const playerList = document.getElementById('playerList');
const waitingPlayers = document.getElementById('waitingPlayers');
const myScore = document.getElementById('myScore');
const myCombo = document.getElementById('myCombo');
const myPerfects = document.getElementById('myPerfects');
const myMisses = document.getElementById('myMisses');
const leaderboardList = document.getElementById('leaderboardList');
const hitFeedback = document.getElementById('hitFeedback');
const countdownEl = document.getElementById('countdown');

// ─── Estado del cliente ────────────────────────────────────
let playerId = null;
let playerName = '';
let ws = null;
let gamePhase = 'waiting';
let connected = false;

// Jugadores locales (datos visibles)
let players = [];
let notes = [];

// Mis estadísticas locales (para respuesta instantánea)
let myStats = { score: 0, combo: 0, perfects: 0, misses: 0, hits: 0 };

// Estado de teclas presionadas (para efecto visual)
let pressedKeys = {}; // { key: timestamp }

// ─── WebSocket ─────────────────────────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host || 'localhost:3001';
  ws = new WebSocket(`${protocol}//${host}`);

  ws.onopen = () => {
    connected = true;
    ws.send(JSON.stringify({ type: 'join', name: playerName }));
  };

  ws.onclose = () => {
    connected = false;
    setTimeout(connectWebSocket, 2000);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMessage(data);
  };
}

function handleMessage(data) {
  switch (data.type) {
    case 'welcome': {
      playerId = data.playerId;
      gamePhase = data.phase;
      if (data.players) {
        players = data.players;
        updatePlayerList();
      }
      break;
    }

    case 'playerJoined': {
      players = data.players || [];
      updatePlayerList();
      break;
    }

    case 'playerLeft': {
      players = data.players || [];
      updatePlayerList();
      updateLeaderboard();
      break;
    }

    case 'phase': {
      gamePhase = data.phase;
      if (data.phase === 'countdown') {
        showCountdown();
      } else if (data.phase === 'playing') {
        lobby.classList.remove('active');
        gameScreen.classList.add('active');
        countdownEl.classList.add('hidden');
        startRenderLoop();
      }
      break;
    }

    case 'gameState': {
      notes = data.notes || [];
      players = data.players || [];
      updateLeaderboard();

      // Actualizar mis stats del server
      const me = players.find(p => p.id === playerId);
      if (me) {
        myStats.score = me.score;
        myStats.combo = me.combo;
        myStats.perfects = me.perfects;
        myStats.misses = me.misses;
        myStats.hits = me.hits;
        updateMyStats();
      }
      break;
    }

    case 'hitResult': {
      showHitFeedback(data.rating);
      if (data.combo >= 5) {
        showComboPopup(data.combo);
      }
      showFloatScore(data.rating, data.points, data.combo);
      break;
    }
  }
}

// ─── UI: Lobby ─────────────────────────────────────────────
function updatePlayerList() {
  if (players.length === 0) {
    playerList.innerHTML = '<p style="color:#6666aa;font-size:0.9rem;">Esperando jugadores...</p>';
    return;
  }
  playerList.innerHTML = players.map(p =>
    `<span class="player-chip">${escapeHtml(p.name)}</span>`
  ).join('');
}

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    nameInput.style.borderColor = '#ff4444';
    setTimeout(() => nameInput.style.borderColor = '', 1000);
    return;
  }
  playerName = name;
  joinBtn.disabled = true;
  joinBtn.textContent = 'CONECTANDO...';
  connectWebSocket();
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ─── UI: Countdown ─────────────────────────────────────────
function showCountdown() {
  lobby.classList.remove('active');
  gameScreen.classList.add('active');
  countdownEl.classList.remove('hidden');

  let count = 3;
  countdownEl.textContent = count;
  const interval = setInterval(() => {
    count--;
    if (count > 0) {
      countdownEl.textContent = count;
      countdownEl.classList.remove('hidden');
      // Re-trigger animation
      countdownEl.style.animation = 'none';
      requestAnimationFrame(() => {
        countdownEl.style.animation = 'countdownPulse 0.8s ease-out';
      });
    } else {
      countdownEl.textContent = '¡YA!';
      setTimeout(() => {
        countdownEl.classList.add('hidden');
      }, 600);
      clearInterval(interval);
    }
  }, 1000);
}

// ─── UI: Stats & Leaderboard ───────────────────────────────
function updateMyStats() {
  myScore.textContent = myStats.score.toLocaleString();
  myCombo.textContent = myStats.combo >= 5 ? `${myStats.combo}x 🔥` : `${myStats.combo}x`;
  myPerfects.textContent = myStats.perfects;
  myMisses.textContent = myStats.misses;
}

function updateLeaderboard() {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];

  leaderboardList.innerHTML = sorted.map((p, i) => {
    const rank = i < 3 ? medals[i] : `#${i + 1}`;
    const isMe = p.id === playerId;
    const name = escapeHtml(p.name);
    const score = p.score.toLocaleString();
    return `
      <div class="leaderboard-item ${isMe ? 'me' : ''}">
        <span class="leaderboard-rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}">${rank}</span>
        <span class="leaderboard-name">${name} ${isMe ? '(tú)' : ''}</span>
        <span class="leaderboard-score">${score}</span>
      </div>
    `;
  }).join('');
}

// ─── UI: Hit Feedback ──────────────────────────────────────
let feedbackTimeout = null;

function showHitFeedback(rating) {
  const labels = {
    perfect: '¡PERFECTO!',
    good: '¡BIEN!',
    ok: 'OK',
    bad: 'MAL',
  };

  hitFeedback.textContent = labels[rating] || rating;
  hitFeedback.className = `hit-feedback show ${rating}`;

  if (feedbackTimeout) clearTimeout(feedbackTimeout);
  feedbackTimeout = setTimeout(() => {
    hitFeedback.classList.remove('show');
  }, 300);
}

function showComboPopup(combo) {
  const el = document.createElement('div');
  el.className = 'combo-popup';
  el.textContent = `${combo}x COMBO! 🔥`;
  el.style.left = `${window.innerWidth / 2 - 80}px`;
  el.style.top = `${window.innerHeight / 2 - 60}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function showFloatScore(rating, points, combo) {
  const el = document.createElement('div');
  el.className = `float-score ${rating}`;
  el.textContent = `+${points}`;
  el.style.left = `${window.innerWidth / 2 + Math.random() * 60 - 30}px`;
  el.style.top = `${window.innerHeight / 2 - 20}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

// ─── Canvas: Dibujo ────────────────────────────────────────
function drawGame() {
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Fondo
  const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
  gradient.addColorStop(0, '#0d0d22');
  gradient.addColorStop(0.5, '#111133');
  gradient.addColorStop(1, '#0a0a1a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Líneas divisorias de carriles
  for (let i = 0; i <= LANE_COUNT; i++) {
    const x = i * LANE_WIDTH;
    ctx.strokeStyle = '#1a1a3a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_HEIGHT);
    ctx.stroke();
  }

  // Zona de impacto (coincide con HIT_ZONE_Y=520 del servidor)
  const hitTop = HIT_ZONE_Y - 8;
  const hitBottom = HIT_ZONE_Y + 8;
  const hitGradient = ctx.createLinearGradient(0, hitTop, 0, hitBottom);
  hitGradient.addColorStop(0, 'rgba(100, 100, 255, 0)');
  hitGradient.addColorStop(0.3, 'rgba(100, 100, 255, 0.12)');
  hitGradient.addColorStop(0.5, 'rgba(150, 150, 255, 0.25)');
  hitGradient.addColorStop(0.7, 'rgba(100, 100, 255, 0.12)');
  hitGradient.addColorStop(1, 'rgba(100, 100, 255, 0)');
  ctx.fillStyle = hitGradient;
  ctx.fillRect(0, hitTop, CANVAS_WIDTH, 16);

  // Línea central brillante
  ctx.strokeStyle = 'rgba(200, 200, 255, 0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, HIT_ZONE_Y);
  ctx.lineTo(CANVAS_WIDTH, HIT_ZONE_Y);
  ctx.stroke();

  // Destellos laterales en los bordes de la zona
  ctx.strokeStyle = 'rgba(100, 100, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 8]);
  ctx.beginPath();
  ctx.moveTo(0, HIT_ZONE_Y - 8);
  ctx.lineTo(CANVAS_WIDTH, HIT_ZONE_Y - 8);
  ctx.moveTo(0, HIT_ZONE_Y + 8);
  ctx.lineTo(CANVAS_WIDTH, HIT_ZONE_Y + 8);
  ctx.stroke();
  ctx.setLineDash([]);

  // Notas
  for (const note of notes) {
    const x = note.lane * LANE_WIDTH + LANE_WIDTH / 2;
    const y = note.y; // coordenadas directas del servidor
    const size = 22;

    // Sombra
    ctx.shadowColor = 'rgba(85, 85, 255, 0.3)';
    ctx.shadowBlur = 12;

    // Círculo exterior
    const gradient2 = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, size);
    gradient2.addColorStop(0, '#8888ff');
    gradient2.addColorStop(0.5, '#5555dd');
    gradient2.addColorStop(1, '#3333aa');

    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = gradient2;
    ctx.fill();

    ctx.shadowBlur = 0;

    // Borde
    ctx.strokeStyle = '#6666ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Brillo central
    ctx.beginPath();
    ctx.arc(x - 6, y - 6, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();

    // Letra de la tecla
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(note.key, x, y + 1);
  }

  // Indicadores de tecla en la parte inferior
  const now = Date.now();
  for (let i = 0; i < LANE_COUNT; i++) {
    const x = i * LANE_WIDTH + LANE_WIDTH / 2;
    const y = CANVAS_HEIGHT - 30;
    const key = LANE_KEYS[i];

    // ¿Está presionada? (últimos 200ms)
    const isPressed = pressedKeys[key] && (now - pressedKeys[key] < 200);

    ctx.shadowBlur = 0;

    if (isPressed) {
      // Brillo intenso de la tecla presionada
      ctx.shadowColor = '#8888ff';
      ctx.shadowBlur = 25;
      ctx.fillStyle = '#3333dd';
      ctx.beginPath();
      ctx.roundRect(x - 26, y - 18, 52, 36, 7);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#9999ff';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(key, x, y);
    } else {
      // Normal
      ctx.fillStyle = '#1a1a44';
      ctx.beginPath();
      ctx.roundRect(x - 24, y - 16, 48, 32, 6);
      ctx.fill();
      ctx.strokeStyle = '#3333aa';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#6666aa';
      ctx.font = 'bold 14px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(key, x, y);
    }
  }
}

// roundRect polyfill para Canvas
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    return this;
  };
}

// ─── Render Loop ───────────────────────────────────────────
let renderRunning = false;

function startRenderLoop() {
  if (renderRunning) return;
  renderRunning = true;

  function loop() {
    if (gamePhase !== 'playing' && gamePhase !== 'countdown') {
      renderRunning = false;
      return;
    }
    drawGame();
    requestAnimationFrame(loop);
  }
  loop();
}

// ─── Keyboard Input ────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Evitar teclas de sistema
  if (e.repeat) return;
  const key = e.key.toUpperCase();
  if (!LANE_KEYS.includes(key)) return;

  // Registrar presión visual (dura ~200ms)
  pressedKeys[key] = Date.now();

  // No enviar si estamos en lobby o no conectados
  if (!connected || !playerId || gamePhase !== 'playing') return;

  e.preventDefault();

  ws.send(JSON.stringify({ type: 'keyPress', key }));

  // Efecto visual extra en el canvas
  const laneIdx = LANE_KEYS.indexOf(key);
  flashLane(laneIdx);
});

function flashLane(laneIdx) {
  const x = laneIdx * LANE_WIDTH;
  ctx.fillStyle = 'rgba(100, 100, 255, 0.15)';
  ctx.fillRect(x, 0, LANE_WIDTH, CANVAS_HEIGHT);
}

// ─── Helpers ───────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Inicializar canvas ────────────────────────────────────
// Draw initial state
drawGame();
