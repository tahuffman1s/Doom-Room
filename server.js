// ===================== DOOM ROOM - Multiplayer Server =====================
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---- Config ----
const PORT        = process.env.PORT || 3000;
const AI_HZ       = 20;          // enemy AI tick rate
const MOVE_HZ     = 20;          // epos broadcast rate
const ARENA       = 29.5;        // keep in sync with client
const ENEMY_SPEED = 3.5;         // units/sec normal
const ELITE_SPEED = 5.0;
const SHOOT_RANGE = 20;
const WAVE_BASE   = 5;           // enemies in wave 1
const WAVE_INCR   = 2;           // extra enemies per wave

// ---- State ----
let players      = new Map();   // id → { ws, x, y, z, yaw, color, hp, alive }
let enemies      = new Map();   // id → enemy obj
let wave         = 0;
let waveActive   = false;
let enemyIdSeq   = 1;
let playerIdSeq  = 1;

const COLORS = [
  '#00cfff', '#00ff88', '#ffdd00', '#ff44cc',
  '#aaffaa', '#44aaff', '#ff8844', '#ff44ff'
];
let colorIdx = 0;

// ---- HTTP Server ----
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ---- WebSocket Server ----
const wss = new WebSocketServer({ server });

function broadcast(obj, excludeId) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  }
}

function broadcastAll(obj) {
  broadcast(obj, null);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function randomSpawnPos() {
  const side = Math.floor(Math.random() * 4);
  const r = ARENA - 2;
  if (side === 0) return { x: (Math.random() - 0.5) * r * 2, z: -r };
  if (side === 1) return { x: (Math.random() - 0.5) * r * 2, z:  r };
  if (side === 2) return { x: -r, z: (Math.random() - 0.5) * r * 2 };
                  return { x:  r, z: (Math.random() - 0.5) * r * 2 };
}

function randomPlayerSpawn() {
  const ang = Math.random() * Math.PI * 2;
  const r   = 2 + Math.random() * 4;
  return { x: Math.cos(ang) * r, z: Math.sin(ang) * r };
}

function spawnEnemy(isElite) {
  const id    = enemyIdSeq++;
  const pos   = randomSpawnPos();
  const maxHp = isElite ? 200 + wave * 30 : 80 + wave * 10;
  const enemy = {
    id,
    x: pos.x,
    z: pos.z,
    hp: maxHp,
    maxHp,
    isElite,
    speed:         isElite ? ELITE_SPEED : ENEMY_SPEED + wave * 0.15,
    shootInterval: isElite ? 1.2 : Math.max(1.0, 2.5 - wave * 0.1),
    shootTimer:    Math.random() * 2,
    wave,
    alive: true,
  };
  enemies.set(id, enemy);
  broadcastAll({ type: 'enemySpawn', id, x: pos.x, z: pos.z, elite: isElite, maxHp, wave });
  return enemy;
}

function startWave(n) {
  wave      = n;
  waveActive = true;
  const count = WAVE_BASE + (wave - 1) * WAVE_INCR;
  broadcastAll({ type: 'waveStart', wave });
  console.log(`Wave ${wave} starting — ${count} enemies`);

  let spawned = 0;
  function doSpawn() {
    if (spawned >= count) return;
    const isElite = wave >= 3 && Math.random() < 0.2;
    spawnEnemy(isElite);
    spawned++;
    if (spawned < count) setTimeout(doSpawn, 600);
  }
  doSpawn();
}

function checkWaveComplete() {
  if (!waveActive) return;
  if (enemies.size === 0) {
    waveActive = false;
    broadcastAll({ type: 'waveEnd', wave });
    console.log(`Wave ${wave} cleared`);
    setTimeout(() => {
      if (players.size > 0) startWave(wave + 1);
    }, 3000);
  }
}

// ---- Enemy AI Loop ----
let lastAiTick = Date.now();
setInterval(() => {
  if (players.size === 0 || enemies.size === 0) return;

  const now = Date.now();
  const dt  = (now - lastAiTick) / 1000;
  lastAiTick = now;

  // Build alive player list for targeting
  const alivePlayers = [];
  for (const [, p] of players) {
    if (p.alive) alivePlayers.push(p);
  }
  if (alivePlayers.length === 0) return;

  for (const [eid, enemy] of enemies) {
    if (!enemy.alive) continue;

    // Find nearest player
    let nearest  = null;
    let nearDist = Infinity;
    for (const p of alivePlayers) {
      const dx = p.x - enemy.x;
      const dz = p.z - enemy.z;
      const d  = Math.sqrt(dx * dx + dz * dz);
      if (d < nearDist) { nearDist = d; nearest = p; }
    }
    if (!nearest) continue;

    const dx = nearest.x - enemy.x;
    const dz = nearest.z - enemy.z;
    const dist = nearDist;

    // Move toward nearest player
    if (dist > 1.5) {
      const nx = dx / dist;
      const nz = dz / dist;
      enemy.x += nx * enemy.speed * dt;
      enemy.z += nz * enemy.speed * dt;
      // Clamp to arena
      enemy.x = Math.max(-ARENA, Math.min(ARENA, enemy.x));
      enemy.z = Math.max(-ARENA, Math.min(ARENA, enemy.z));
    }

    // Shoot
    enemy.shootTimer -= dt;
    if (enemy.shootTimer <= 0 && dist < SHOOT_RANGE) {
      enemy.shootTimer = enemy.shootInterval + Math.random() * 0.5;
      // Direction toward nearest player with spread
      const spread = 0.08;
      let sdx = dx / dist + (Math.random() - 0.5) * spread;
      let sdz = dz / dist + (Math.random() - 0.5) * spread;
      const len = Math.sqrt(sdx * sdx + sdz * sdz);
      sdx /= len; sdz /= len;
      broadcastAll({
        type: 'enemyShoot',
        id: eid,
        x: enemy.x,
        z: enemy.z,
        dx: sdx,
        dz: sdz,
        elite: enemy.isElite
      });
    }

    // Melee damage (handled by proximity on server — deal continuous damage)
    if (dist < 1.5) {
      const dmg = (enemy.isElite ? 20 : 10) * dt * 2;
      if (nearest.hp > 0) {
        nearest.hp = Math.max(0, nearest.hp - dmg);
        send(nearest.ws, { type: 'damage', hp: Math.round(nearest.hp) });
        if (nearest.hp <= 0) killPlayer(nearest);
      }
    }
  }
}, Math.floor(1000 / AI_HZ));

// ---- Broadcast enemy positions at MOVE_HZ ----
setInterval(() => {
  if (enemies.size === 0 || players.size === 0) return;
  const pos = [];
  for (const [id, e] of enemies) {
    pos.push({ id, x: +e.x.toFixed(3), z: +e.z.toFixed(3) });
  }
  broadcastAll({ type: 'epos', pos });
}, Math.floor(1000 / MOVE_HZ));

function killPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  broadcastAll({ type: 'died', id: p.id });
}

function resetGame() {
  enemies.clear();
  wave      = 0;
  waveActive = false;
  enemyIdSeq = 1;
  console.log('Game reset — all players disconnected');
}

// ---- Connection Handler ----
wss.on('connection', (ws) => {
  const id    = playerIdSeq++;
  const color = COLORS[colorIdx++ % COLORS.length];
  const sp    = randomPlayerSpawn();
  const player = {
    id, ws, color,
    x: sp.x, y: 1.7, z: sp.z,
    yaw: 0,
    hp: 100,
    alive: true,
  };
  players.set(id, player);

  console.log(`Player ${id} connected (${players.size} total)`);

  // Build current state for init message
  const otherPlayers = [];
  for (const [pid, p] of players) {
    if (pid !== id) {
      otherPlayers.push({ id: pid, x: p.x, y: p.y, z: p.z, yaw: p.yaw, color: p.color });
    }
  }
  const currentEnemies = [];
  for (const [eid, e] of enemies) {
    currentEnemies.push({ id: eid, x: e.x, z: e.z, elite: e.isElite, maxHp: e.maxHp, wave: e.wave });
  }

  send(ws, {
    type: 'init',
    id,
    color,
    wave,
    players: otherPlayers,
    enemies: currentEnemies,
  });

  // Tell others about new player
  broadcast({ type: 'join', id, x: player.x, y: player.y, z: player.z, yaw: 0, color }, id);

  // Broadcast player count to everyone
  broadcastAll({ type: 'count', n: players.size });

  // Start first wave if this is the first player
  if (players.size === 1 && wave === 0 && !waveActive) {
    setTimeout(() => {
      if (players.size > 0) startWave(1);
    }, 2000);
  }

  // ---- Message Handler ----
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'move': {
        player.x   = msg.x;
        player.y   = msg.y;
        player.z   = msg.z;
        player.yaw = msg.yaw;
        broadcast({ type: 'pmove', id, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw }, id);
        break;
      }
      case 'shoot': {
        broadcast({ type: 'pshoot', id }, id);
        break;
      }
      case 'hit': {
        const eid = msg.eid;
        const dmg = Math.min(Math.max(0, Number(msg.dmg) || 0), 200);
        const enemy = enemies.get(eid);
        if (!enemy || !enemy.alive) break;
        enemy.hp -= dmg;
        if (enemy.hp <= 0) {
          enemy.alive = false;
          enemies.delete(eid);
          const pts = enemy.isElite ? 500 : 100;
          broadcastAll({ type: 'ekill', eid, killer: id, elite: enemy.isElite, pts });
          console.log(`Enemy ${eid} killed by player ${id} (${enemies.size} remaining)`);
          checkWaveComplete();
        }
        break;
      }
      case 'respawn': {
        if (player.alive) break;
        const rsp = randomPlayerSpawn();
        player.hp    = 100;
        player.alive = true;
        player.x     = rsp.x;
        player.z     = rsp.z;
        // Tell this player their new position + HP
        send(ws, { type: 'selfResp', x: rsp.x, z: rsp.z });
        // Tell others this player respawned
        broadcast({ type: 'presp', id, x: rsp.x, z: rsp.z }, id);
        break;
      }
    }
  });

  // ---- Disconnect ----
  ws.on('close', () => {
    players.delete(id);
    console.log(`Player ${id} disconnected (${players.size} remaining)`);
    broadcastAll({ type: 'leave', id });
    broadcastAll({ type: 'count', n: players.size });
    if (players.size === 0) resetGame();
  });

  ws.on('error', (err) => {
    console.error(`WS error for player ${id}:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`DOOM ROOM server running at http://localhost:${PORT}`);
});
