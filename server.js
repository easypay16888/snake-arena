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

// --- Free-move mode constants ---
const FM_SPEED = 180;
const FM_TURN_RATE = 4.5;
const FM_HEAD_RADIUS = 12;
const FM_SEGMENT_GAP = 12;
const FM_INITIAL_LENGTH = 10;
const FM_LENGTH_SPEED_FACTOR = 0.02;
const FM_FOOD_RADIUS_MIN = 5;
const FM_FOOD_RADIUS_MAX = 14;
const FM_POWERUP_RADIUS = 12;
const FM_FOOD_COUNT = 15;
const FM_POWERUP_MAX = 4;
const FM_POWERUP_SPAWN_SEC = 6;
const FM_POWERUP_TTL = 15;
const FM_BOUNDARY_MARGIN = 20;
const FM_WORLD_W = 2000;
const FM_WORLD_H = 2000;
const FM_TICK_MS = 33;

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

let gameMode = 'grid'; // 'grid' | 'free'
let fmFoods = [];
let fmPowerups = [];
let fmWrapMode = false;
let fmPowerupTimer = 0;
let fmTickInterval = null;
let fmBroadcastInterval = null;

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

function fmDist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function angleLerp(current, target, t) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + Math.max(-t, Math.min(t, diff));
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
  if (gameMode === 'free') return initFreeGame();

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
    // Project player head 2-4 steps forward based on direction
    // so bots can anticipate where humans are heading and avoid them
    const head = p.snake[0];
    const d = p.direction;
    for (let step = 1; step <= 4; step++) {
      let px = head.x + d.x * step;
      let py = head.y + d.y * step;
      if (wrapMode) {
        px = (px + GRID) % GRID;
        py = (py + GRID) % GRID;
      } else {
        if (px < 0 || px >= GRID || py < 0 || py >= GRID) break;
      }
      obs.add(`${px},${py}`);
    }
  }
  return obs;
}

function floodFill(sx, sy, obstacles) {
  const visited = new Set();
  const queue = [{ x: sx, y: sy }];
  visited.add(`${sx},${sy}`);
  let count = 0;
  while (queue.length > 0 && count < 250) {
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
  const obstacles = buildObstacleSet(p); // other players' bodies + projected heads (hard block)
  const snakeLen = p.snake.length;

  // Own body cells (soft penalty — prefer avoiding but can pass through)
  const ownBody = new Set();
  for (let i = 1; i < snakeLen; i++) {
    ownBody.add(`${p.snake[i].x},${p.snake[i].y}`);
  }

  // Multi-food scoring function — scores a cell's attractiveness
  // based on all nearby foods, not just the single nearest one.
  // This prevents oscillation when two foods are equidistant.
  function foodScoreAt(x, y) {
    let best = 0;
    let count = 0;
    for (const f of foods) {
      const d = Math.abs(f.x - x) + Math.abs(f.y - y);
      // Weight decays sharply with distance; only nearby foods matter
      const w = Math.max(0, 80 - d * 4);
      if (w > best) best = w;
      count++;
      if (count >= 5) break;
    }
    for (const pu of powerups) {
      const d = Math.abs(pu.x - x) + Math.abs(pu.y - y);
      if (d < 15) best = Math.max(best, 120);
    }
    return best;
  }

  const directions = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  ];

  // Score each direction: flood fill space + multi-food score + danger avoidance + momentum
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

    // Multi-food weighted score — better than single-target distance
    const foodScore = foodScoreAt(nx, ny);

    // Danger zone: check if any other alive snake's head is heading toward
    // this cell within the next 2 ticks. If so, big penalty to avoid collision.
    let dangerPenalty = 0;
    for (const other of players) {
      if (!other.alive || other === p) continue;
      const otherHead = other.snake[0];
      const od = other.direction;
      for (let ahead = 1; ahead <= 2; ahead++) {
        let ox = otherHead.x + od.x * ahead;
        let oy = otherHead.y + od.y * ahead;
        if (wrapMode) { ox = (ox + GRID) % GRID; oy = (oy + GRID) % GRID; }
        if (ox === nx && oy === ny) {
          dangerPenalty = -600;
          break;
        }
      }
      if (dangerPenalty !== 0) break;
    }

    // Soft penalty for entering own body (prefer avoiding, but can in emergencies)
    const selfPenalty = ownBody.has(key) ? -300 : 0;
    // Heavy penalty for tight spaces, but still pickable if all else fails
    const spacePenalty = space < snakeLen ? -500 : 0;
    // Momentum bonus: prefer continuing in current direction to reduce circling/hesitation
    const momentumBonus = (d.x === dir.x && d.y === dir.y) ? 40 : 0;
    const score = space * 8 + foodScore * 1.2 + selfPenalty + spacePenalty + dangerPenalty + momentumBonus + Math.random() * 2;

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
  console.log(`[BOT] ${p.name} NO SAFE DIR at (${head.x},${head.y}) dir=(${dir.x},${dir.y}) len=${snakeLen} obs=${obstacles.size}`);
  p.nextDirection = { x: -dir.x, y: -dir.y };
  if (p.buffs.reverse > 0) {
    p.nextDirection = { x: -p.nextDirection.x, y: -p.nextDirection.y };
  }
}

// ========== FREE-MOVE MODE ==========

function initFreeGame() {
  const margin = 80;
  const startPositions = [
    { x: margin, y: margin },
    { x: FM_WORLD_W - margin, y: margin },
    { x: margin, y: FM_WORLD_H - margin },
    { x: FM_WORLD_W - margin, y: FM_WORLD_H - margin },
  ];

  fmFoods = [];
  fmPowerups = [];
  fmPowerupTimer = 0;
  timer = matchTime;

  players.forEach((p, i) => {
    const pos = startPositions[i % startPositions.length];
    const angle = Math.atan2(FM_WORLD_H / 2 - pos.y, FM_WORLD_W / 2 - pos.x);
    p.fmHeadX = pos.x;
    p.fmHeadY = pos.y;
    p.fmAngle = angle;
    p.fmTargetAngle = angle;
    p.fmTrail = [];
    p.fmLength = FM_INITIAL_LENGTH;
    p.fmScore = 0;
    p.score = 0;
    p.alive = true;
    p.buffs = { double: 0, speedUp: 0, speedDown: 0, magnet: 0, reverse: 0, invincible: 0 };
    p.fmTurnRate = p.isBot ? FM_TURN_RATE * 1.5 : FM_TURN_RATE;
    for (let j = 0; j < FM_INITIAL_LENGTH * FM_SEGMENT_GAP; j++) {
      p.fmTrail.push({
        x: pos.x - Math.cos(angle) * j * 0.5,
        y: pos.y - Math.sin(angle) * j * 0.5,
      });
    }
  });

  for (let i = 0; i < FM_FOOD_COUNT; i++) spawnFreeFood();
}

function spawnFreeFood() {
  const margin = 40;
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = margin + Math.random() * (FM_WORLD_W - margin * 2);
    const y = margin + Math.random() * (FM_WORLD_H - margin * 2);
    const r = FM_FOOD_RADIUS_MIN + Math.random() * (FM_FOOD_RADIUS_MAX - FM_FOOD_RADIUS_MIN);
    let blocked = false;
    for (const p of players) {
      if (!p.alive) continue;
      if (fmDist(x, y, p.fmHeadX, p.fmHeadY) < FM_HEAD_RADIUS + r + 20) { blocked = true; break; }
      for (let i = 0; i < p.fmTrail.length; i += FM_SEGMENT_GAP * 3) {
        if (fmDist(x, y, p.fmTrail[i].x, p.fmTrail[i].y) < FM_HEAD_RADIUS + r) { blocked = true; break; }
      }
      if (blocked) break;
    }
    if (!blocked) {
      fmFoods.push({ x, y, r, id: genId() });
      return;
    }
  }
  fmFoods.push({ x: margin + Math.random() * (FM_WORLD_W - margin * 2), y: margin + Math.random() * (FM_WORLD_H - margin * 2), r: FM_FOOD_RADIUS_MIN, id: genId() });
}

function spawnFreePowerup() {
  if (fmPowerups.length >= FM_POWERUP_MAX) return;
  const margin = 60;
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = margin + Math.random() * (FM_WORLD_W - margin * 2);
    const y = margin + Math.random() * (FM_WORLD_H - margin * 2);
    let blocked = false;
    for (const p of players) {
      if (!p.alive) continue;
      if (fmDist(x, y, p.fmHeadX, p.fmHeadY) < FM_HEAD_RADIUS + FM_POWERUP_RADIUS + 20) { blocked = true; break; }
    }
    if (!blocked) {
      const type = weightedRandom(POWERUP_TYPES, POWERUP_WEIGHTS);
      fmPowerups.push({ x, y, type, id: genId(), ttl: FM_POWERUP_TTL });
      return;
    }
  }
}

function fmGetSpeed(p) {
  let speed = FM_SPEED;
  if (p.buffs.speedUp > 0) speed *= 1.8;
  if (p.buffs.speedDown > 0) speed *= 0.5;
  const segCount = Math.floor(p.fmTrail.length / FM_SEGMENT_GAP);
  const lengthBonus = 1 + Math.max(0, segCount - FM_INITIAL_LENGTH) * FM_LENGTH_SPEED_FACTOR;
  return speed * lengthBonus;
}

function fmDropTrailAsFood(p) {
  const trail = p.fmTrail;
  const maxDrop = Math.min(Math.floor(p.fmLength) || 8, 8);
  const step = Math.max(1, Math.floor(trail.length / maxDrop));
  for (let i = 0; i < trail.length; i += step) {
    const seg = trail[i];
    const r = FM_FOOD_RADIUS_MIN + Math.random() * 4;
    fmFoods.push({ x: seg.x, y: seg.y, r, id: genId() });
  }
}

/** Kill a free-move snake: drop trail food, reset score, notify clients for respawn UI. */
function fmKillPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  p.score = 0;
  p.fmScore = 0;
  fmDropTrailAsFood(p);
  p.fmTrail = [];
  // Free-move always respawns (slither-style); tell client to start the countdown now
  broadcast({ type: 'died', id: p.id, respawnIn: 3 });
}

function fmBotTargetAngle(bot) {
  let foodDx = 0, foodDy = 0, foodWeight = 0;
  let sorted = [...fmFoods].map(f => ({ ...f, d: fmDist(bot.fmHeadX, bot.fmHeadY, f.x, f.y) }));
  sorted.sort((a, b) => a.d - b.d);
  for (let i = 0; i < Math.min(sorted.length, 5); i++) {
    const f = sorted[i];
    if (f.d < 1) continue;
    const w = 1 / Math.max(f.d, 1);
    foodDx += (f.x - bot.fmHeadX) / f.d * w;
    foodDy += (f.y - bot.fmHeadY) / f.d * w;
    foodWeight += w;
  }
  for (const pu of fmPowerups) {
    const d = fmDist(bot.fmHeadX, bot.fmHeadY, pu.x, pu.y);
    if (d < 400 && d > 0) {
      const w = 3 / Math.max(d, 1);
      foodDx += (pu.x - bot.fmHeadX) / d * w;
      foodDy += (pu.y - bot.fmHeadY) / d * w;
      foodWeight += w;
    }
  }

  let dx, dy;
  if (foodWeight > 0) {
    dx = foodDx / foodWeight;
    dy = foodDy / foodWeight;
  } else {
    dx = FM_WORLD_W / 2 - bot.fmHeadX;
    dy = FM_WORLD_H / 2 - bot.fmHeadY;
  }

  const m = FM_BOUNDARY_MARGIN + 30;
  if (!fmWrapMode) {
    const wallForce = 8;
    if (bot.fmHeadX < m) dx += wallForce;
    if (bot.fmHeadX > FM_WORLD_W - m) dx -= wallForce;
    if (bot.fmHeadY < m) dy += wallForce;
    if (bot.fmHeadY > FM_WORLD_H - m) dy -= wallForce;
  }

  const avoidRadius = FM_HEAD_RADIUS * 14;
  for (const other of players) {
    if (other.id === bot.id || !other.alive) continue;
    const d = fmDist(bot.fmHeadX, bot.fmHeadY, other.fmHeadX, other.fmHeadY);
    if (d < avoidRadius && d > 0.1) {
      const f = (1 - d / avoidRadius) * 1.2;
      const force = 8 * f * f;
      dx += (bot.fmHeadX - other.fmHeadX) / d * force;
      dy += (bot.fmHeadY - other.fmHeadY) / d * force;
    }
    const oSpeed = fmGetSpeed(other);
    for (let ahead = 1; ahead <= 3; ahead++) {
      const dist = oSpeed * 0.3 * ahead;
      const px = other.fmHeadX + Math.cos(other.fmAngle) * dist;
      const py = other.fmHeadY + Math.sin(other.fmAngle) * dist;
      const pd = fmDist(bot.fmHeadX, bot.fmHeadY, px, py);
      if (pd < avoidRadius && pd > 0.1) {
        const f = (1 - pd / avoidRadius) * 0.6 / ahead;
        const force = 8 * f * f;
        dx += (bot.fmHeadX - px) / pd * force;
        dy += (bot.fmHeadY - py) / pd * force;
      }
    }
    for (let i = FM_SEGMENT_GAP; i < other.fmTrail.length; i += FM_SEGMENT_GAP * 4) {
      const seg = other.fmTrail[i];
      const sd = fmDist(bot.fmHeadX, bot.fmHeadY, seg.x, seg.y);
      if (sd < avoidRadius && sd > 0.1) {
        const f = (1 - sd / avoidRadius) * 0.4;
        const force = 8 * f * f;
        dx += (bot.fmHeadX - seg.x) / sd * force;
        dy += (bot.fmHeadY - seg.y) / sd * force;
      }
    }
  }

  return Math.atan2(dy, dx);
}

function fmApplyBotReverse(bot) {
  if (bot.buffs.reverse > 0) {
    bot.fmAngle += Math.PI;
    bot.fmTargetAngle = bot.fmAngle;
  }
}

function freeTick() {
  if (gameState !== 'playing') return;
  const dt = FM_TICK_MS / 1000;
  fmPowerupTimer += dt;

  for (const p of players) {
    if (!p.alive) continue;

    if (p.isBot) {
      p.fmTargetAngle = fmBotTargetAngle(p);
      if (p.buffs.reverse > 0) p.fmTargetAngle += Math.PI;
    }

    const turnAmount = p.fmTurnRate * dt;
    p.fmAngle = angleLerp(p.fmAngle, p.fmTargetAngle, Math.min(turnAmount, 1));

    const speed = fmGetSpeed(p);
    p.fmHeadX += Math.cos(p.fmAngle) * speed * dt;
    p.fmHeadY += Math.sin(p.fmAngle) * speed * dt;

    const bm = FM_BOUNDARY_MARGIN;
    if (fmWrapMode) {
      if (p.fmHeadX < 0) p.fmHeadX += FM_WORLD_W;
      if (p.fmHeadX >= FM_WORLD_W) p.fmHeadX -= FM_WORLD_W;
      if (p.fmHeadY < 0) p.fmHeadY += FM_WORLD_H;
      if (p.fmHeadY >= FM_WORLD_H) p.fmHeadY -= FM_WORLD_H;
    } else {
      if (p.fmHeadX < bm || p.fmHeadX > FM_WORLD_W - bm ||
          p.fmHeadY < bm || p.fmHeadY > FM_WORLD_H - bm) {
        if (p.buffs.invincible > 0) {
          p.fmHeadX = Math.max(bm, Math.min(FM_WORLD_W - bm, p.fmHeadX));
          p.fmHeadY = Math.max(bm, Math.min(FM_WORLD_H - bm, p.fmHeadY));
          p.fmAngle += Math.PI;
        } else {
          fmKillPlayer(p);
          continue;
        }
      }
    }

    // Only store trail point when moved >= 3px (matches 60fps solo density)
    // Accumulate distance and add trail points every 3px (matches solo 60fps density)
    p._trailDist = (p._trailDist || 0) + speed * dt;
    while (p._trailDist >= 3) {
      p._trailDist -= 3;
      p.fmTrail.unshift({ x: p.fmHeadX, y: p.fmHeadY });
    }
    const maxTrail = p.fmLength * FM_SEGMENT_GAP;
    while (p.fmTrail.length > maxTrail) p.fmTrail.pop();

    for (const k in p.buffs) {
      if (p.buffs[k] > 0) p.buffs[k] -= dt;
      if (p.buffs[k] < 0) p.buffs[k] = 0;
    }

    for (let i = fmFoods.length - 1; i >= 0; i--) {
      const foodR = fmFoods[i].r || FM_FOOD_RADIUS_MIN;
      if (fmDist(p.fmHeadX, p.fmHeadY, fmFoods[i].x, fmFoods[i].y) < FM_HEAD_RADIUS + foodR) {
        const sizeBonus = Math.round((foodR - FM_FOOD_RADIUS_MIN) / (FM_FOOD_RADIUS_MAX - FM_FOOD_RADIUS_MIN) * 15);
        const gain = p.buffs.double > 0 ? (10 + sizeBonus) * 2 : 10 + sizeBonus;
        p.score += gain;
        p.fmScore = p.score;
        p.fmLength += 1;
        fmFoods.splice(i, 1);
        spawnFreeFood();
      }
    }

    for (let i = fmPowerups.length - 1; i >= 0; i--) {
      if (fmDist(p.fmHeadX, p.fmHeadY, fmPowerups[i].x, fmPowerups[i].y) < FM_HEAD_RADIUS + FM_POWERUP_RADIUS) {
        const type = fmPowerups[i].type;
        p.buffs[type] = FM_POWERUP_TTL;
        if (type === 'reverse') {
          p.fmAngle += Math.PI;
          p.fmTargetAngle = p.fmAngle;
        }
        fmPowerups.splice(i, 1);
      }
    }
  }

  // Magnet pull for all alive players
  for (const pp of players) {
    if (!pp.alive || pp.buffs.magnet <= 0) continue;
    for (const f of fmFoods) {
      const d = fmDist(pp.fmHeadX, pp.fmHeadY, f.x, f.y);
      if (d <= 120 && d > 0) {
        const pull = 120 * dt;  // match solo 60fps pull rate (2px/frame * 60fps)
        f.x += ((pp.fmHeadX - f.x) / d) * pull;
        f.y += ((pp.fmHeadY - f.y) / d) * pull;
      }
    }
  }

  // Inter-snake collisions
  for (let a = 0; a < players.length; a++) {
    const pA = players[a];
    if (!pA.alive) continue;

    for (let b = 0; b < players.length; b++) {
      const pB = players[b];
      if (!pB.alive || a === b) continue;

      if (fmDist(pA.fmHeadX, pA.fmHeadY, pB.fmHeadX, pB.fmHeadY) < FM_HEAD_RADIUS * 2) {
        if (pA.buffs.invincible <= 0 && pB.buffs.invincible <= 0) {
          fmKillPlayer(pA);
          fmKillPlayer(pB);
        } else if (pA.buffs.invincible <= 0) {
          fmKillPlayer(pA);
        } else if (pB.buffs.invincible <= 0) {
          fmKillPlayer(pB);
        }
      }

      if (pA.alive && pB.alive) {
        for (let i = FM_SEGMENT_GAP; i < pB.fmTrail.length; i += FM_SEGMENT_GAP) {
          if (fmDist(pA.fmHeadX, pA.fmHeadY, pB.fmTrail[i].x, pB.fmTrail[i].y) < FM_HEAD_RADIUS * 1.5) {
            if (pA.buffs.invincible <= 0) {
              fmKillPlayer(pA);
            }
            break;
          }
        }
      }
    }
  }

  if (fmPowerupTimer >= FM_POWERUP_SPAWN_SEC) {
    fmPowerupTimer = 0;
    spawnFreePowerup();
  }

  for (let i = fmPowerups.length - 1; i >= 0; i--) {
    fmPowerups[i].ttl -= dt;
    if (fmPowerups[i].ttl <= 0) fmPowerups.splice(i, 1);
  }

  // Free-move always respawns after 3s (slither-style)
  players.forEach(p => {
    if (!p.alive && !p._respawnTimer && typeof p.fmHeadX === 'number') {
      p._respawnTimer = setTimeout(() => {
        p._respawnTimer = null;
        if (gameState !== 'playing' || gameMode !== 'free') return;
        const margin = 80;
        p.fmHeadX = margin + Math.random() * (FM_WORLD_W - margin * 2);
        p.fmHeadY = margin + Math.random() * (FM_WORLD_H - margin * 2);
        p.fmAngle = Math.random() * Math.PI * 2;
        p.fmTargetAngle = p.fmAngle;
        p.fmTrail = [];
        for (let j = 0; j < FM_INITIAL_LENGTH * FM_SEGMENT_GAP; j++) {
          p.fmTrail.push({
            x: p.fmHeadX - Math.cos(p.fmAngle) * j * 0.5,
            y: p.fmHeadY - Math.sin(p.fmAngle) * j * 0.5,
          });
        }
        p.fmLength = FM_INITIAL_LENGTH;
        p.score = 0;
        p.fmScore = 0;
        p.alive = true;
        p.buffs = { double: 0, speedUp: 0, speedDown: 0, magnet: 0, reverse: 0, invincible: 0 };
        broadcast({ type: 'respawn', id: p.id });
      }, 3000);
    }
  });

  // freeTick owns the match clock in free mode (do not also run timerTick)
  // matchTime === 0 means infinite — leave timer at 0 and never end on time
  if (matchTime > 0) {
    timer -= dt;
    if (timer <= 0) {
      timer = 0;
      endGame();
      return;
    }
  }

  broadcastFree();
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
      broadcast({ type: 'died', id: p.id, respawnIn: immortalMode ? 3 : 0 });
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
    broadcast({ type: 'died', id: p.id, respawnIn: immortalMode ? 3 : 0 });
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
  if (gameMode === 'free') { freeTick(); return; }

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

  // Grid mode: only respawn when immortal (永生) mode is enabled
  if (immortalMode) {
    players.forEach(p => {
      if (!p.alive && !p._respawnTimer) {
        p._respawnTimer = setTimeout(() => {
          p._respawnTimer = null;
          if (gameState !== 'playing' || gameMode !== 'grid' || !immortalMode) return;
          const idx = Math.max(0, players.indexOf(p));
          const si = idx % startX.length;
          p.alive = true;
          p.snake = [
            { x: startX[si], y: startY[si] },
            { x: startX[si] - startDirs[si].x, y: startY[si] - startDirs[si].y },
            { x: startX[si] - startDirs[si].x * 2, y: startY[si] - startDirs[si].y * 2 },
          ];
          p.direction = { ...startDirs[si] };
          p.nextDirection = { ...startDirs[si] };
          p.buffs = { double: 0, speedUp: 0, speedDown: 0, magnet: 0, reverse: 0, invincible: 0 };
          broadcast({ type: 'respawn', id: p.id, snake: p.snake, direction: p.direction });
        }, 3000);
      }
    });
  }
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
      if (gameMode === 'free') {
        initFreeGame();
        fmTickInterval = setInterval(freeTick, FM_TICK_MS);
        // freeTick owns the match timer — do not also run timerTick (would double-count)
      } else {
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
    }
  }, 1000);
}

function endGame() {
  gameState = 'result';
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (broadcastInterval) { clearInterval(broadcastInterval); broadcastInterval = null; }
  if (powerupSpawnInterval) { clearInterval(powerupSpawnInterval); powerupSpawnInterval = null; }
  if (fmTickInterval) { clearInterval(fmTickInterval); fmTickInterval = null; }
  // Cancel pending respawns so they can't fire after the match ends
  players.forEach(p => {
    if (p._respawnTimer) { clearTimeout(p._respawnTimer); p._respawnTimer = null; }
  });

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

function broadcastFree() {
  const state = {
    type: 'freeState',
    players: players.map(p => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
      alive: p.alive, isBot: p.isBot,
      headX: p.fmHeadX, headY: p.fmHeadY, angle: p.fmAngle,
      trail: p.fmTrail, length: p.fmLength,
      buffs: p.buffs,
    })),
    foods: fmFoods,
    powerups: fmPowerups,
    timer: Math.ceil(timer),
    infinite: matchTime === 0,
    wrapMode: fmWrapMode,
  };
  wss.clients.forEach(c => {
    if (c.readyState === 1) {
      try { c.send(JSON.stringify(state)); } catch (e) {}
    }
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
    gameMode,
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
  const colorIdx = players.filter(p => !p.isBot).length % COLORS.length;
  const isFirstHuman = players.filter(p => !p.isBot).length === 0;
  const player = {
    id,
    ws,
    name: '',
    color: COLORS[colorIdx],
    colorName: COLOR_NAMES[colorIdx],
    ready: false,
    host: isFirstHuman,
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

    if (msg.type === 'freeAngle' && gameMode === 'free' && player.alive) {
      if (typeof msg.angle === 'number') {
        player.fmTargetAngle = msg.angle;
      }
    }

    if (msg.type === 'toggleGameMode' && player.host && gameState === 'lobby') {
      gameMode = gameMode === 'grid' ? 'free' : 'grid';
      sendLobby();
    }

    if (msg.type === 'toggleFreeWrap' && player.host) {
      fmWrapMode = !fmWrapMode;
      sendLobby();
    }

    if (msg.type === 'rematch') {
      player.rematch = true;
      players.forEach(p => { if (p.isBot) p.rematch = true; });
      if (players.every(p => p.rematch)) {
        if (tick._deathTimer) { clearTimeout(tick._deathTimer); tick._deathTimer = null; }
        if (fmTickInterval) { clearInterval(fmTickInterval); fmTickInterval = null; }
        if (fmBroadcastInterval) { clearInterval(fmBroadcastInterval); fmBroadcastInterval = null; }
        players.forEach(p => {
          if (p._respawnTimer) { clearTimeout(p._respawnTimer); p._respawnTimer = null; }
          p.rematch = false; p.ready = false; p.alive = false; p.score = 0;
        });
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
      if (fmTickInterval) { clearInterval(fmTickInterval); fmTickInterval = null; }
      if (fmBroadcastInterval) { clearInterval(fmBroadcastInterval); fmBroadcastInterval = null; }
      players.forEach(p => {
        if (p._respawnTimer) { clearTimeout(p._respawnTimer); p._respawnTimer = null; }
        p.ready = false; p.alive = false; p.score = 0;
      });
      sendLobby();
    }
  });

  ws.on('close', () => {
    players = players.filter(p => p.id !== id);
    if (players.length > 0 && !players.some(p => p.host)) {
      players[0].host = true;
    }
    if (gameState === 'playing') {
      const humanPlayers = players.filter(p => !p.isBot);
      const alivePlayers = players.filter(p => p.alive);
      if (alivePlayers.length === 0 || humanPlayers.length === 0) {
        endGame();
      }
    }
    // Clean up stale bots when lobby is empty of humans
    if (players.filter(p => !p.isBot).length === 0) {
      players = [];
      gameState = 'lobby';
    }
    sendLobby();
  });
});

const lanIP = getLanIP();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🐍 Snake Arena 已启动！\n`);
  console.log(`  本机:   http://localhost:${PORT}`);
  console.log(`  局域网: http://${lanIP}:${PORT}\n`);
  console.log(`  其他玩家请在浏览器打开局域网地址加入游戏\n`);
});