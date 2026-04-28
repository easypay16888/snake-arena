const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const os = require('os');

const PORT = 8088;
const GRID = 40;
const MAX_PLAYERS = 4;
let matchTime = 120;
const TICK_MS = 100;
const BROADCAST_MS = 33;
const POWERUP_SPAWN_MS = 8000;
const MAX_POWERUPS = 3;

const COLORS = ['#ff6ec4', '#00ffcc', '#ffd700', '#7b68ee'];
const COLOR_NAMES = ['粉', '青', '金', '紫'];
const POWERUP_TYPES = ['double', 'speedUp', 'speedDown', 'magnet', 'reverse', 'invincible'];
const POWERUP_WEIGHTS = [25, 15, 15, 15, 15, 15]; // spawn weights
const LENGTH_SPEED_FACTOR = 0.04; // speed multiplier increase per extra segment
const POWERUP_TTL = 150; // 15 seconds at 10 ticks/sec

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let players = [];
let foods = [];
let powerups = [];
let gameState = 'lobby';
let wrapMode = false;
let immortalMode = false;
let timer = matchTime;
let tickInterval = null;
let broadcastInterval = null;
let powerupSpawnInterval = null;
let countdownValue = 0;
let countdownInterval = null;

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function genId() {
  return Math.random().toString(36).slice(2, 8);
}

function weightedRandom(items, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function isOccupied(x, y) {
  if (players.some(p => p.alive && p.snake.some(s => s.x === x && s.y === y))) return true;
  if (foods.some(f => f.x === x && f.y === y)) return true;
  if (powerups.some(p => p.x === x && p.y === y)) return true;
  return false;
}

function spawnFood() {
  let attempts = 0;
  while (attempts < 200) {
    const x = Math.floor(Math.random() * GRID);
    const y = Math.floor(Math.random() * GRID);
    if (!isOccupied(x, y)) { foods.push({ x, y, id: genId() }); return; }
    attempts++;
  }
  foods.push({ x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID), id: genId() });
}

function spawnPowerup() {
  if (powerups.length >= MAX_POWERUPS) return;
  let attempts = 0;
  while (attempts < 200) {
    const x = Math.floor(Math.random() * GRID);
    const y = Math.floor(Math.random() * GRID);
    if (!isOccupied(x, y)) {
      const type = weightedRandom(POWERUP_TYPES, POWERUP_WEIGHTS);
      powerups.push({ x, y, type, id: genId(), ttl: POWERUP_TTL });
      return;
    }
    attempts++;
  }
}

function convertBodyToFood(player) {
  const body = player.snake;
  for (const seg of body) {
    foods.push({ x: seg.x, y: seg.y, id: genId() });
  }
  // Bonus food based on score (eaten food gets "spit out")
  const bonusCount = Math.floor(player.score / 10);
  for (let i = 0; i < bonusCount; i++) {
    const seg = body[Math.floor(Math.random() * body.length)];
    const fx = Math.max(0, Math.min(GRID - 1, seg.x + Math.floor(Math.random() * 5) - 2));
    const fy = Math.max(0, Math.min(GRID - 1, seg.y + Math.floor(Math.random() * 5) - 2));
    foods.push({ x: fx, y: fy, id: genId() });
  }
  player.snake = [];
  player.score = 0;
}

const startY = [Math.floor(GRID / 2), Math.floor(GRID / 2), Math.floor(GRID / 2), Math.floor(GRID / 2)];
const startX = [3, GRID - 4, 3, GRID - 4];
const startDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }];

function initGame() {

  players.forEach((p, i) => {
    p.snake = [
      { x: startX[i], y: startY[i] },
      { x: startX[i] - startDirs[i].x, y: startY[i] },
      { x: startX[i] - startDirs[i].x * 2, y: startY[i] },
    ];
    p.direction = { ...startDirs[i] };
    p.nextDirection = { ...startDirs[i] };
    p.score = 0;
    p.alive = true;
    p.buffs = { double: 0, speedUp: 0, speedDown: 0, magnet: 0, reverse: 0, invincible: 0 };
    if (p._respawnTimer) { clearTimeout(p._respawnTimer); p._respawnTimer = null; }
  });

  foods = [];
  powerups = [];
  const foodCount = Math.max(2, players.length);
  for (let i = 0; i < foodCount; i++) spawnFood();
  timer = matchTime;
}

const BOT_NAMES = ['机器人🤖', 'AI蛇🐍', 'Bot🎯', '电脑💀'];
const BOT_COLORS = ['#ff4444', '#44aaff', '#ffaa00', '#aa44ff'];

function buildObstacleSet(exclude) {
  const obs = new Set();
  for (const p of players) {
    if (!p.alive) continue;
    if (p === exclude) continue; // can pass through own body
    const body = p.snake;
    for (let i = 0; i < body.length; i++) {
      obs.add(`${body[i].x},${body[i].y}`);
    }
  }
  return obs;
}

function floodFill(sx, sy, obstacles) {
  const visited = new Set();
  const queue = [{ x: sx, y: sy }];
  visited.add(`${sx},${sy}`);
  let count = 0;
  while (queue.length > 0 && count < 80) {
    const pos = queue.shift();
    count++;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      let nx = pos.x + dx;
      let ny = pos.y + dy;
      if (wrapMode) { nx = (nx + GRID) % GRID; ny = (ny + GRID) % GRID; }
      if (!wrapMode && (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID)) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key) || obstacles.has(key)) continue;
      visited.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return count;
}

function calculateBotDirection(p) {
  if (!p.alive || !p.isBot) return;

  const head = p.snake[0];
  const dir = p.direction;
  const obstacles = buildObstacleSet(p); // other players' bodies (hard block)

  // Own body cells (soft penalty — prefer avoiding but can pass through)
  const ownBody = new Set();
  for (let i = 1; i < p.snake.length; i++) {
    ownBody.add(`${p.snake[i].x},${p.snake[i].y}`);
  }

  let target = null;
  let nearestDist = Infinity;

  for (const f of foods) {
    const dist = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
    if (dist < nearestDist) { nearestDist = dist; target = f; }
  }
  for (const pu of powerups) {
    const dist = Math.abs(pu.x - head.x) + Math.abs(pu.y - head.y);
    if (dist < 10 && dist < nearestDist) { nearestDist = dist; target = pu; }
  }

  const directions = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  ];

  // Score each direction: flood fill space + proximity to food
  let bestDir = null;
  let bestScore = -Infinity;

  for (const d of directions) {
    if (d.x === -dir.x && d.y === -dir.y) continue;

    const nx = wrapMode ? ((head.x + d.x) + GRID) % GRID : head.x + d.x;
    const ny = wrapMode ? ((head.y + d.y) + GRID) % GRID : head.y + d.y;

    if (!wrapMode && (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID)) {
      if (p.buffs.invincible <= 0) continue;
    }

    const key = `${nx},${ny}`;
    if (obstacles.has(key)) {
      if (p.buffs.invincible <= 0) continue;
    }

    // Flood fill to measure how much open space this direction leads to
    const space = floodFill(nx, ny, obstacles);

    const distToTarget = target ? Math.abs(target.x - nx) + Math.abs(target.y - ny) : 999;
    // Soft penalty for entering own body (prefer avoiding, but can in emergencies)
    const selfPenalty = ownBody.has(key) ? -300 : 0;
    // Heavy penalty for tight spaces, but still pickable if all else fails
    const spacePenalty = space < p.snake.length ? -500 : 0;
    const score = space * 10 - distToTarget + selfPenalty + spacePenalty + Math.random() * 3;

    if (score > bestScore) {
      bestScore = score;
      bestDir = d;
    }
  }

  if (bestDir) {
    if (p.buffs.reverse > 0) {
      bestDir = { x: -bestDir.x, y: -bestDir.y };
    }
    p.nextDirection = { ...bestDir };
    return;
  }

  // Fallback: any safe direction including reversal (can pass through own body)
  for (const d of directions) {
    const nx = wrapMode ? ((head.x + d.x) + GRID) % GRID : head.x + d.x;
    const ny = wrapMode ? ((head.y + d.y) + GRID) % GRID : head.y + d.y;
    if (!wrapMode && (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID)) continue;
    if (obstacles.has(`${nx},${ny}`)) continue;
    p.nextDirection = { ...d };
    if (p.buffs.reverse > 0) {
      p.nextDirection = { x: -p.nextDirection.x, y: -p.nextDirection.y };
    }
    return;
  }
  // No safe direction at all — force reverse as absolute last resort
  console.log(`[BOT] ${p.name} NO SAFE DIR at (${head.x},${head.y}) dir=(${dir.x},${dir.y}) len=${p.snake.length} obs=${obstacles.size}`);
  p.nextDirection = { x: -dir.x, y: -dir.y };
  if (p.buffs.reverse > 0) {
    p.nextDirection = { x: -p.nextDirection.x, y: -p.nextDirection.y };
  }
}

function moveSnake(p) {
  p.direction = { ...p.nextDirection };
  let dx = p.direction.x;
  let dy = p.direction.y;

  const head = {
    x: p.snake[0].x + dx,
    y: p.snake[0].y + dy,
  };

  if (head.x < 0 || head.x >= GRID || head.y < 0 || head.y >= GRID) {
    if (wrapMode) {
      head.x = (head.x + GRID) % GRID;
      head.y = (head.y + GRID) % GRID;
    } else {
      if (p.buffs.invincible > 0) {
        p.nextDirection = { x: -dx, y: -dy };
        p.direction = { ...p.nextDirection };
        return;
      }
      console.log(`[DEATH] ${p.name}(${p.isBot ? 'bot' : 'human'}) hit wall at (${head.x},${head.y}) score=${p.score} len=${p.snake.length}`);
      convertBodyToFood(p);
      p.alive = false;
      return;
    }
  }

  // Check collision with other players (can pass through own body)
  const others = players.filter(o => o !== p && o.alive);
  const collision = others.find(o => o.snake.some(s => s.x === head.x && s.y === head.y));
  if (collision) {
    if (p.buffs.invincible > 0) return;
    console.log(`[DEATH] ${p.name}(${p.isBot ? 'bot' : 'human'}) hit ${collision.name}(${collision.isBot ? 'bot' : 'human'}) at (${head.x},${head.y}) score=${p.score} len=${p.snake.length}`);
    convertBodyToFood(p);
    p.alive = false;
    return;
  }

  p.snake.unshift(head);

  let ate = false;
  const foodIdx = foods.findIndex(f => f.x === head.x && f.y === head.y);
  if (foodIdx !== -1) {
    const gain = p.buffs.double > 0 ? 20 : 10;
    p.score += gain;
    foods.splice(foodIdx, 1);
    spawnFood();
    ate = true;
  }

  if (!ate && p.buffs.magnet > 0 && p.snake.length > 1) {
    const oldHead = p.snake[1];
    const magnetFoodIdx = foods.findIndex(f => f.x === oldHead.x && f.y === oldHead.y);
    if (magnetFoodIdx !== -1) {
      const gain = p.buffs.double > 0 ? 20 : 10;
      p.score += gain;
      foods.splice(magnetFoodIdx, 1);
      spawnFood();
      ate = true;
    }
  }

  if (!ate) {
    p.snake.pop();
  }

  const puIdx = powerups.findIndex(pu => pu.x === head.x && pu.y === head.y);
  if (puIdx !== -1) {
    applyPowerup(p, powerups[puIdx].type);
    powerups.splice(puIdx, 1);
  }
}

function applyPowerup(player, type) {
  switch (type) {
    case 'double':
      player.buffs.double = 150; // 15s
      break;
    case 'speedUp':
      player.buffs.speedUp = 150;
      break;
    case 'speedDown':
      player.buffs.speedDown = 150;
      break;
    case 'magnet':
      player.buffs.magnet = 150;
      break;
    case 'reverse':
      player.buffs.reverse = 150;
      break;
    case 'invincible':
      player.buffs.invincible = 150; // 15 seconds at 10 ticks/sec
      break;
  }
}

function getTickMultiplier(player) {
  let mult = 1;
  if (player.buffs.speedUp > 0) mult *= 1.8;
  if (player.buffs.speedDown > 0) mult *= 0.5;
  const lengthBonus = 1 + Math.max(0, player.snake.length - 3) * LENGTH_SPEED_FACTOR;
  mult *= lengthBonus;
  return mult;
}

function magnetPull(player) {
  if (player.buffs.magnet <= 0) return;
  const head = player.snake[0];
  const range = 5;
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    const dx = f.x - head.x;
    const dy = f.y - head.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= range && dist > 0) {
      // Move food toward head
      f.x += head.x > f.x ? 1 : head.x < f.x ? -1 : 0;
      f.y += head.y > f.y ? 1 : head.y < f.y ? -1 : 0;
    }
  }
}

let tickAccumulators = {};

function tick() {
  if (gameState !== 'playing') return;

  // Expire powerups
  for (let i = powerups.length - 1; i >= 0; i--) {
    powerups[i].ttl--;
    if (powerups[i].ttl <= 0) powerups.splice(i, 1);
  }

  players.forEach(p => {
    if (!p.alive) return;

    // Decrement buff timers
    for (const k in p.buffs) {
      if (p.buffs[k] > 0) p.buffs[k]--;
    }

    // Magnet pull
    magnetPull(p);

    // Bot AI: set direction before movement
    if (p.isBot) {
      calculateBotDirection(p);
    }

    // Speed-based tick control: allow multiple moves per tick for speedUp
    const mult = getTickMultiplier(p);
    if (!tickAccumulators[p.id]) tickAccumulators[p.id] = 0;
    tickAccumulators[p.id] += mult;
    let moved = false;
    let movesThisTick = 0;
    const MAX_MOVES_PER_TICK = 2;
    while (tickAccumulators[p.id] >= 1 && p.alive && movesThisTick < MAX_MOVES_PER_TICK) {
      tickAccumulators[p.id] -= 1;
      movesThisTick++;
      moveSnake(p);
      moved = true;
      if (p.isBot && p.alive) {
        calculateBotDirection(p);
      }
    }
    if (!moved) return;
  });

  // Respawn dead players after 3 seconds (always active)
  players.forEach(p => {
    if (!p.alive && !p._respawnTimer) {
      p._respawnTimer = setTimeout(() => {
        p._respawnTimer = null;
        if (gameState === 'playing') {
          const idx = players.indexOf(p);
          p.alive = true;
          p.snake = [
            { x: startX[idx], y: startY[idx] },
            { x: startX[idx] - startDirs[idx].x, y: startY[idx] - startDirs[idx].y },
            { x: startX[idx] - startDirs[idx].x * 2, y: startY[idx] - startDirs[idx].y * 2 },
          ];
          p.direction = { ...startDirs[idx] };
          p.nextDirection = { ...startDirs[idx] };
          p.buffs = { double: 0, speedUp: 0, speedDown: 0, magnet: 0, reverse: 0, invincible: 0 };
          broadcast({ type: 'respawn', id: p.id, snake: p.snake, direction: p.direction });
        }
      }, 3000);
    }
  });
}

function timerTick() {
  if (gameState !== 'playing') return;
  if (matchTime === 0) return; // infinite time
  timer--;
  if (timer <= 0) { timer = 0; endGame(); }
}

function startCountdown() {
  gameState = 'countdown';
  countdownValue = 3;
  broadcast({ type: 'countdown', value: countdownValue });

  countdownInterval = setInterval(() => {
    countdownValue--;
    if (countdownValue > 0) {
      broadcast({ type: 'countdown', value: countdownValue });
    } else {
      clearInterval(countdownInterval);
      countdownInterval = null;
      gameState = 'playing';
      initGame();
      tickAccumulators = {};
      tickInterval = setInterval(tick, TICK_MS);
      broadcastInterval = setInterval(broadcastState, BROADCAST_MS);
      powerupSpawnInterval = setInterval(spawnPowerup, POWERUP_SPAWN_MS);
      const timerInt = setInterval(() => {
        if (gameState !== 'playing') { clearInterval(timerInt); return; }
        timerTick();
      }, 1000);
    }
  }, 1000);
}

function endGame() {
  gameState = 'result';
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (broadcastInterval) { clearInterval(broadcastInterval); broadcastInterval = null; }
  if (powerupSpawnInterval) { clearInterval(powerupSpawnInterval); powerupSpawnInterval = null; }

  const rankings = players
    .map(p => ({ name: p.name, color: p.color, score: p.score, colorName: p.colorName, alive: p.alive }))
    .sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.score - a.score;
    });

  broadcast({ type: 'result', rankings });
}

function broadcastState() {
  const state = {
    type: 'state',
    snakes: players.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      snake: p.snake,
      direction: p.direction,
      score: p.score,
      alive: p.alive,
      buffs: p.buffs,
    })),
    foods,
    powerups,
    timer,
    wrapMode,
    immortalMode,
  };
  broadcast(state);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(data);
  });
}

function sendLobby() {
  broadcast({
    type: 'lobby',
    players: players.map(p => ({
      id: p.id, name: p.name, color: p.color, colorName: p.colorName, ready: p.ready, host: p.host, isBot: p.isBot || false,
    })),
    gameState,
    wrapMode,
    immortalMode,
    matchTime,
  });
}

wss.on('connection', ws => {
  const humanCount = players.filter(p => !p.isBot).length;
  if (humanCount >= MAX_PLAYERS && gameState !== 'lobby') {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  const id = genId();
  const colorIdx = players.length % COLORS.length;
  const player = {
    id,
    ws,
    name: '',
    color: COLORS[colorIdx],
    colorName: COLOR_NAMES[colorIdx],
    ready: false,
    host: players.length === 0,
    snake: [],
    direction: { x: 1, y: 0 },
    nextDirection: { x: 1, y: 0 },
    score: 0,
    alive: false,
    rematch: false,
    buffs: { double: 0, speedUp: 0, speedDown: 0, magnet: 0, reverse: 0, invincible: 0 },
  };
  players.push(player);

  ws.send(JSON.stringify({ type: 'welcome', id, color: player.color, colorName: player.colorName, host: player.host }));
  sendLobby();

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      player.name = String(msg.name).slice(0, 10) || 'Player';
      if (msg.color && typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)) {
        player.color = msg.color;
      }
      sendLobby();
    }

    if (msg.type === 'ready') {
      player.ready = !player.ready;
      sendLobby();
    }

    if (msg.type === 'toggleWrap' && player.host) {
      wrapMode = !wrapMode;
      sendLobby();
    }

    if (msg.type === 'toggleImmortal' && player.host) {
      immortalMode = !immortalMode;
      sendLobby();
    }

    if (msg.type === 'setMatchTime' && player.host) {
      const t = parseInt(msg.time);
      if ([60, 120, 180, 0].includes(t)) {
        matchTime = t;
        sendLobby();
      }
    }

    if (msg.type === 'addBot' && player.host) {
      const botCount = players.filter(p => p.isBot).length;
      const humanCount = players.filter(p => !p.isBot).length;
      if (players.length < MAX_PLAYERS && botCount < 3) {
        const botIdx = botCount;
        const bot = {
          id: genId(),
          ws: { send: () => {}, close: () => {}, readyState: 1 },
          name: BOT_NAMES[botIdx % BOT_NAMES.length],
          color: BOT_COLORS[botIdx % BOT_COLORS.length],
          colorName: '机器人',
          ready: true,
          host: false,
          isBot: true,
          snake: [],
          direction: { x: 1, y: 0 },
          nextDirection: { x: 1, y: 0 },
          score: 0,
          alive: false,
          rematch: true,
          buffs: { double: 0, speedUp: 0, speedDown: 0, magnet: 0, reverse: 0, invincible: 0 },
        };
        players.push(bot);
        sendLobby();
      }
    }

    if (msg.type === 'removeBot' && player.host) {
      const bot = players.find(p => p.isBot);
      if (bot) {
        players = players.filter(p => p.id !== bot.id);
        sendLobby();
      }
    }

    if (msg.type === 'color' && typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)) {
      player.color = msg.color;
      sendLobby();
    }

    if (msg.type === 'start' && player.host && gameState === 'lobby') {
      const readyCount = players.filter(p => p.ready).length;
      const totalPlayers = players.length;
      console.log(`[START] host=${player.name} readyCount=${readyCount} gameState=${gameState} players=${totalPlayers}`);
      if (readyCount >= 1) startCountdown();
    }

    if (msg.type === 'dir' && player.alive) {
      const { dx, dy } = msg;
      if (typeof dx === 'number' && typeof dy === 'number') {
        let actualDx = dx, actualDy = dy;
        if (player.buffs.reverse > 0) { actualDx = -dx; actualDy = -dy; }
        if (actualDx !== 0 && player.direction.x === -actualDx) return;
        if (actualDy !== 0 && player.direction.y === -actualDy) return;
        player.nextDirection = { x: actualDx, y: actualDy };
      }
    }

    if (msg.type === 'rematch') {
      player.rematch = true;
      players.forEach(p => { if (p.isBot) p.rematch = true; });
      if (players.every(p => p.rematch)) {
        if (tick._deathTimer) { clearTimeout(tick._deathTimer); tick._deathTimer = null; }
        players.forEach(p => { p.rematch = false; p.ready = false; p.alive = false; p.score = 0; });
        gameState = 'lobby';
        sendLobby();
        broadcast({ type: 'rematch_start' });
      } else {
        broadcast({ type: 'rematch_wait', ready: players.filter(p => p.rematch).length, total: players.length });
      }
    }

    if (msg.type === 'backToLobby' && player.host) {
      gameState = 'lobby';
      if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
      if (broadcastInterval) { clearInterval(broadcastInterval); broadcastInterval = null; }
      if (powerupSpawnInterval) { clearInterval(powerupSpawnInterval); powerupSpawnInterval = null; }
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      players.forEach(p => { p.ready = false; p.alive = false; p.score = 0; });
      sendLobby();
    }
  });

  ws.on('close', () => {
    players = players.filter(p => p.id !== id);
    if (players.length > 0 && !players.some(p => p.host)) {
      players[0].host = true;
    }
    if (gameState === 'playing' && players.filter(p => p.alive).length === 0) {
      endGame();
    }
    sendLobby();
  });
});

const lanIP = getLanIP();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🐍 Snake Arena 已启动！\n`);
  console.log(`  本机:   http://localhost:${PORT}`);
  console.log(`  属域网: http://${lanIP}:${PORT}\n`);
  console.log(`  其他玩家请在浏览器打开局域网地址加入游戏\n`);
});