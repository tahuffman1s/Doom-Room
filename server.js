// ===================== DOOM ROOM - Multiplayer Server =====================
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---- Config ----
const PORT        = process.env.PORT || 3000;
const AI_HZ       = 20;
const ARENA       = 29.5;
const ENEMY_SPEED = 3.0;
const ELITE_SPEED = 4.5;
const SHOOT_RANGE = 15;
const WAVE_BASE   = 5;
const WAVE_INCR   = 3;
const INVINC_DURATION = 5000; // ms

// ---- Safe Room ----
const SAFE_ROOM = { x1: -24, x2: -16, z1: -26, z2: -18 };
function isInSafeRoom(x, z) {
  return x > SAFE_ROOM.x1 && x < SAFE_ROOM.x2 && z > SAFE_ROOM.z1 && z < SAFE_ROOM.z2;
}

// ---- State ----
let players     = new Map();
let enemies     = new Map();
let items       = new Map();
let wave        = 0;
let waveActive  = false;
let enemyIdSeq  = 1;
let playerIdSeq = 1;
let itemIdSeq   = 1;

// ---- Fixed item positions ----
const AMMO_POSITIONS = [
  [0, 0, 0], [-3, 0, 8], [3, 0, -8], [-8, 0, -3],
  [8, 0, 3], [18, 0, 18], [-18, 0, -18], [18, 0, -18],
];
const HEALTH_POSITIONS = [
  [-12, 0, 0], [12, 0, 0], [0, 0, -16], [0, 0, 16],
];
const GRENADE_POSITIONS = [
  [0, 0, 10], [0, 0, -10], [10, 0, 0], [-10, 0, 0],
  [18, 0, 0], [-18, 0, 0],
];

function placeItems() {
  AMMO_POSITIONS.forEach(([x, , z]) => {
    const id = itemIdSeq++;
    items.set(id, { id, type: 'ammo', x, z, active: true, respawnDelay: 20000, fixed: true });
  });
  HEALTH_POSITIONS.forEach(([x, , z]) => {
    const id = itemIdSeq++;
    items.set(id, { id, type: 'health', x, z, active: true, respawnDelay: 25000, fixed: true });
  });
  GRENADE_POSITIONS.forEach(([x, , z]) => {
    const id = itemIdSeq++;
    items.set(id, { id, type: 'grenade_pickup', x, z, active: true, respawnDelay: 30000, fixed: true });
  });
}
placeItems();

// ---- HTTP Server ----
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server });

// ---- Helpers ----
function broadcast(obj, excludeId) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === 1) p.ws.send(msg);
  }
}
function broadcastAll(obj) { broadcast(obj, null); }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function randomSpawnPos() {
  const side = Math.floor(Math.random() * 4);
  const r = ARENA - 2;
  if (side === 0) return { x: (Math.random() - 0.5) * r * 2, z: -r };
  if (side === 1) return { x: (Math.random() - 0.5) * r * 2, z:  r };
  if (side === 2) return { x: -r, z: (Math.random() - 0.5) * r * 2 };
                  return { x:  r, z: (Math.random() - 0.5) * r * 2 };
}

function randomPlayerSpawn() {
  // Spawn inside safe room with 1-unit margin from walls
  return {
    x: SAFE_ROOM.x1 + 1 + Math.random() * (SAFE_ROOM.x2 - SAFE_ROOM.x1 - 2),
    z: SAFE_ROOM.z1 + 1 + Math.random() * (SAFE_ROOM.z2 - SAFE_ROOM.z1 - 2),
  };
}

// ---- Items ----
function broadcastItemSpawn(item) {
  broadcastAll({ type: 'itemSpawn', id: item.id, itemType: item.type, x: item.x, z: item.z });
}

function dropPowerup(x, z) {
  // Powerup drop (35% chance)
  if (Math.random() < 0.35) {
    const types = ['powerup_speed', 'powerup_damage', 'powerup_rapidfire'];
    const type = types[Math.floor(Math.random() * types.length)];
    const id = itemIdSeq++;
    const item = { id, type, x, z, active: true, respawnDelay: 0, fixed: false };
    items.set(id, item);
    broadcastItemSpawn(item);
  }
  // Grenade drop (20% chance)
  if (Math.random() < 0.20) {
    const gx = x + (Math.random() - 0.5) * 2;
    const gz = z + (Math.random() - 0.5) * 2;
    const id = itemIdSeq++;
    const item = { id, type: 'grenade_pickup', x: gx, z: gz, active: true, respawnDelay: 0, fixed: false };
    items.set(id, item);
    broadcastItemSpawn(item);
  }
}

function applyPickup(player, item) {
  if (item.type === 'health') {
    player.hp = Math.min(100, player.hp + 50);
    send(player.ws, { type: 'pickupEffect', itemType: 'health', hp: player.hp });
  } else if (item.type === 'ammo') {
    send(player.ws, { type: 'pickupEffect', itemType: 'ammo' });
  } else {
    send(player.ws, { type: 'pickupEffect', itemType: item.type });
  }
}

// ---- Enemy ----
function spawnEnemy(isElite) {
  const id    = enemyIdSeq++;
  const pos   = randomSpawnPos();
  const maxHp = isElite ? 220 + wave * 35 : 75 + wave * 12;
  const enemy = {
    id, x: pos.x, z: pos.z, hp: maxHp, maxHp, isElite, alive: true, wave,
    speed:         isElite ? ELITE_SPEED + wave * 0.1 : ENEMY_SPEED + wave * 0.2,
    shootInterval: isElite ? 0.9 : Math.max(0.7, 2.2 - wave * 0.12),
    shootTimer:    Math.random() * 2,
  };
  enemies.set(id, enemy);
  broadcastAll({ type: 'enemySpawn', id, x: pos.x, z: pos.z, elite: isElite, maxHp, wave });
  return enemy;
}

function startWave(n) {
  wave = n; waveActive = true;
  const count = WAVE_BASE + (wave - 1) * WAVE_INCR;
  broadcastAll({ type: 'waveStart', wave });
  console.log(`Wave ${wave} — ${count} enemies`);
  let spawned = 0;
  const spawnWave = n;
  function doSpawn() {
    if (spawned >= count || players.size === 0 || wave !== spawnWave) return;
    spawnEnemy(wave >= 2 && Math.random() < 0.25);
    spawned++;
    if (spawned < count) setTimeout(doSpawn, 600);
  }
  doSpawn();
}

function checkWaveComplete() {
  if (!waveActive || enemies.size > 0) return;
  waveActive = false;
  broadcastAll({ type: 'waveEnd', wave });
  console.log(`Wave ${wave} cleared`);
  setTimeout(() => { if (players.size > 0) startWave(wave + 1); }, 3000);
}

function killPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  p.deaths++;
  broadcastAll({ type: 'died', id: p.id, name: p.name, deaths: p.deaths });
}

function resetGame() {
  enemies.clear(); wave = 0; waveActive = false; enemyIdSeq = 1;
  // Reset fixed items
  items.clear(); itemIdSeq = 1; placeItems();
  console.log('Game reset');
}

// ---- AI Loop ----
let lastAiTick = Date.now();
setInterval(() => {
  if (players.size === 0 || enemies.size === 0) return;

  const now = Date.now();
  const dt  = (now - lastAiTick) / 1000;
  lastAiTick = now;

  const allAlivePlayers = [];
  for (const p of players.values()) { if (p.alive) allAlivePlayers.push(p); }
  if (allAlivePlayers.length === 0) return;
  // Enemies only target players outside the safe room
  const alivePlayers = allAlivePlayers.filter(p => !isInSafeRoom(p.x, p.z));

  // ---- Enemy movement + combat ----
  for (const [, enemy] of enemies) {
    if (!enemy.alive) continue;
    let nearest = null, nearDist = Infinity;
    for (const p of alivePlayers) {
      const d = Math.hypot(p.x - enemy.x, p.z - enemy.z);
      if (d < nearDist) { nearDist = d; nearest = p; }
    }
    if (!nearest) continue; // all players in safe room — enemy idles

    const dx = nearest.x - enemy.x, dz = nearest.z - enemy.z, dist = nearDist;

    if (dist > 1.5) {
      const nx = enemy.x + (dx / dist) * enemy.speed * dt;
      const nz = enemy.z + (dz / dist) * enemy.speed * dt;
      // Enemies cannot enter the safe room
      if (!isInSafeRoom(nx, nz)) {
        enemy.x = nx;
        enemy.z = nz;
      }
      enemy.x = Math.max(-ARENA, Math.min(ARENA, enemy.x));
      enemy.z = Math.max(-ARENA, Math.min(ARENA, enemy.z));
    }

    // Ranged shot
    enemy.shootTimer -= dt;
    if (enemy.shootTimer <= 0 && dist < SHOOT_RANGE) {
      enemy.shootTimer = enemy.shootInterval + Math.random() * 0.5;
      const spread = 0.08;
      let sdx = dx / dist + (Math.random() - 0.5) * spread;
      let sdz = dz / dist + (Math.random() - 0.5) * spread;
      const len = Math.hypot(sdx, sdz);
      sdx /= len; sdz /= len;
      broadcastAll({ type: 'enemyShoot', id: enemy.id, x: enemy.x, z: enemy.z, dx: sdx, dz: sdz, elite: enemy.isElite });
      // Deal damage to target (skip if invincible)
      if (!nearest.invincible && Math.random() < Math.max(0.1, 0.7 - dist / SHOOT_RANGE)) {
        const dmg = enemy.isElite ? 12 : 7;
        nearest.hp = Math.max(0, nearest.hp - dmg);
        send(nearest.ws, { type: 'damage', hp: Math.round(nearest.hp) });
        if (nearest.hp <= 0) killPlayer(nearest);
      }
    }

    // Melee
    if (dist < 1.5 && !nearest.invincible) {
      const dmg = (enemy.isElite ? 18 : 9) * dt * 2;
      nearest.hp = Math.max(0, nearest.hp - dmg);
      send(nearest.ws, { type: 'damage', hp: Math.round(nearest.hp) });
      if (nearest.hp <= 0) killPlayer(nearest);
    }
  }

  // ---- Item proximity pickup ----
  for (const [iid, item] of items) {
    if (!item.active) {
      // Check respawn
      if (item.respawnAt && now >= item.respawnAt) {
        item.active = true;
        item.respawnAt = 0;
        broadcastItemSpawn(item);
      }
      continue;
    }
    for (const p of allAlivePlayers) {
      if (Math.hypot(p.x - item.x, p.z - item.z) < 1.2) {
        applyPickup(p, item);
        item.active = false;
        broadcastAll({ type: 'itemPickup', id: iid });
        if (item.fixed) {
          item.respawnAt = now + item.respawnDelay;
        } else {
          items.delete(iid);
        }
        break;
      }
    }
  }
}, Math.floor(1000 / AI_HZ));

// ---- Broadcast enemy positions ----
setInterval(() => {
  if (enemies.size === 0 || players.size === 0) return;
  const pos = [];
  for (const [id, e] of enemies) pos.push({ id, x: +e.x.toFixed(3), z: +e.z.toFixed(3) });
  broadcastAll({ type: 'epos', pos });
}, Math.floor(1000 / AI_HZ));

// ---- Connection Handler ----
wss.on('connection', (ws) => {
  const id  = playerIdSeq++;
  const sp  = randomPlayerSpawn();
  const player = {
    id, ws,
    name: `Player${id}`,
    color: '#00cc44', // all players green
    x: sp.x, y: 1.7, z: sp.z, yaw: 0,
    hp: 100, alive: true,
    invincible: true,
    kills: 0, deaths: 0, score: 0,
  };
  players.set(id, player);

  // Auto-end invincibility after INVINC_DURATION
  setTimeout(() => {
    const p = players.get(id);
    if (p) p.invincible = false;
  }, INVINC_DURATION);

  console.log(`Player ${id} connected (${players.size} total)`);

  // Build init state
  const otherPlayers = [];
  for (const [pid, p] of players) {
    if (pid !== id) otherPlayers.push({ id: pid, x: p.x, y: p.y, z: p.z, yaw: p.yaw, color: p.color, name: p.name, kills: p.kills, deaths: p.deaths, score: p.score });
  }
  const currentEnemies = [];
  for (const [, e] of enemies) currentEnemies.push({ id: e.id, x: e.x, z: e.z, elite: e.isElite, maxHp: e.maxHp, wave: e.wave });
  const currentItems = [];
  for (const [, item] of items) { if (item.active) currentItems.push({ id: item.id, itemType: item.type, x: item.x, z: item.z }); }

  send(ws, { type: 'init', id, color: player.color, name: player.name, wave, x: sp.x, y: 1.7, z: sp.z, players: otherPlayers, enemies: currentEnemies, items: currentItems });
  broadcast({ type: 'join', id, x: player.x, y: player.y, z: player.z, yaw: 0, color: player.color, name: player.name, kills: 0, deaths: 0, score: 0 }, id);
  broadcastAll({ type: 'count', n: players.size });

  if (players.size === 1 && wave === 0 && !waveActive) {
    setTimeout(() => { if (players.size > 0) startWave(1); }, 2000);
  }

  // ---- Message Handler ----
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'move': {
        player.x = msg.x; player.y = msg.y; player.z = msg.z; player.yaw = msg.yaw;
        broadcast({ type: 'pmove', id, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw }, id);
        break;
      }
      case 'shoot': {
        broadcast({ type: 'pshoot', id }, id);
        break;
      }
      case 'hit': {
        const dmg = Math.min(Math.max(0, Number(msg.dmg) || 0), 200);
        const enemy = enemies.get(msg.eid);
        if (!enemy || !enemy.alive) break;
        enemy.hp -= dmg;
        if (enemy.hp <= 0) {
          enemy.alive = false;
          enemies.delete(msg.eid);
          const pts = enemy.isElite ? 500 : 100;
          player.kills++; player.score += pts;
          broadcastAll({ type: 'ekill', eid: msg.eid, killer: id, killerName: player.name, elite: enemy.isElite, pts, killerKills: player.kills, killerScore: player.score });
          dropPowerup(enemy.x, enemy.z);
          console.log(`Enemy ${msg.eid} killed by ${player.name} (${enemies.size} remaining)`);
          checkWaveComplete();
        }
        break;
      }
      case 'respawn': {
        if (player.alive) break;
        const rsp = randomPlayerSpawn();
        player.hp = 100; player.alive = true;
        player.x = rsp.x; player.z = rsp.z;
        player.invincible = true;
        setTimeout(() => { const p = players.get(id); if (p) p.invincible = false; }, INVINC_DURATION);
        send(ws, { type: 'selfResp', x: rsp.x, z: rsp.z });
        broadcast({ type: 'presp', id, x: rsp.x, z: rsp.z }, id);
        break;
      }
      case 'endInvincible': {
        player.invincible = false;
        break;
      }
      case 'setName': {
        const name = String(msg.name || '').replace(/[<>&"]/g, '').slice(0, 16).trim() || `Player${id}`;
        player.name = name;
        broadcastAll({ type: 'playerName', id, name });
        break;
      }
      case 'grenade': {
        const gx = Math.max(-ARENA, Math.min(ARENA, Number(msg.x) || 0));
        const gy = Number(msg.y) || 1.7;
        const gz = Math.max(-ARENA, Math.min(ARENA, Number(msg.z) || 0));
        const gdx = Number(msg.dx) || 0;
        const gdy = Number(msg.dy) || 0;
        const gdz = Number(msg.dz) || -1;
        const GRENADE_RADIUS = 6;
        const GRENADE_MAX_DMG = 90;
        // Simulate arc to find explosion point
        let px = gx, py = gy, pz = gz;
        let vx = gdx * 13, vy = gdy * 13 + 5, vz = gdz * 13;
        const simDt = 0.05;
        for (let t = 0; t < 3.0; t += simDt) {
          vy -= 15 * simDt;
          px += vx * simDt; py += vy * simDt; pz += vz * simDt;
          px = Math.max(-ARENA, Math.min(ARENA, px));
          pz = Math.max(-ARENA, Math.min(ARENA, pz));
          if (py <= 0) { py = 0; break; }
        }
        // Radius damage to all enemies
        for (const [eid, enemy] of enemies) {
          if (!enemy.alive) continue;
          const dist = Math.hypot(px - enemy.x, pz - enemy.z);
          if (dist < GRENADE_RADIUS) {
            const falloff = 1 - (dist / GRENADE_RADIUS);
            const dmg = Math.round(GRENADE_MAX_DMG * falloff * falloff);
            enemy.hp -= dmg;
            if (enemy.hp <= 0) {
              enemy.alive = false;
              enemies.delete(eid);
              const pts = enemy.isElite ? 500 : 100;
              player.kills++; player.score += pts;
              broadcastAll({ type: 'ekill', eid, killer: id, killerName: player.name, elite: enemy.isElite, pts, killerKills: player.kills, killerScore: player.score });
              dropPowerup(enemy.x, enemy.z);
              checkWaveComplete();
            }
          }
        }
        broadcastAll({ type: 'grenadeExplosion', x: px, y: 0.3, z: pz });
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').replace(/[<>&]/g, '').slice(0, 100).trim();
        if (!text) break;
        broadcastAll({ type: 'chat', id, name: player.name, color: player.color, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log(`Player ${id} disconnected (${players.size} remaining)`);
    broadcastAll({ type: 'leave', id });
    broadcastAll({ type: 'count', n: players.size });
    if (players.size === 0) resetGame();
  });

  ws.on('error', (err) => {
    console.error(`WS error P${id}:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`DOOM ROOM server running at http://localhost:${PORT}`);
});
