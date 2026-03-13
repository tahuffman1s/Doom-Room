// ===================== DOOM ROOM - Multiplayer Server =====================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ---- Config ----
const PORT = process.env.PORT || 8080;
const AI_HZ = 20;
const ARENA = 79.5;
const ENEMY_SPEED  = 3.5;
const ELITE_SPEED  = 5.2;
const BOSS_SPEED   = 2.2;
const SHOOT_RANGE  = 22;
const WAVE_BREAK   = 8;
const MAX_ENEMIES  = 40;
const INVINC_DURATION = 5000;
const AFK_TIMEOUT     = 120_000; // 2 minutes idle → kick
const AFK_WARN        =  90_000; // warn at 90 s

function waveEnemyCount(n) { return 10 + n * 5; }   // wave1=15, wave5=35, wave10=60
function spawnInterval(wv)  { return Math.max(800, 3200 - wv * 180); }
function eliteChance(wv)    { return Math.min(0.65, 0.08 + wv * 0.05); }
function bossChance(wv)     { return wv % 3 === 0; }  // boss every 3rd wave

// ---- Safe Room ----
const SAFE_ROOM = { x1: -78, x2: -70, z1: -78, z2: -70 };
function isInSafeRoom(x, z) {
  return (
    x > SAFE_ROOM.x1 && x < SAFE_ROOM.x2 && z > SAFE_ROOM.z1 && z < SAFE_ROOM.z2
  );
}

// ---- Server-side wall collidables (mirrors client makeWall/makePillar/makeCover calls) ----
// Each entry: { cx, cz, hw, hd } — axis-aligned box half-extents
const ENEMY_RADIUS = 0.5;
const SERVER_WALLS = [
  // Perimeter
  { cx: 0,    cz: -80, hw: 80,   hd: 0.3 },
  { cx: 0,    cz:  80, hw: 80,   hd: 0.3 },
  { cx: -80,  cz:   0, hw: 0.3,  hd: 80  },
  { cx:  80,  cz:   0, hw: 0.3,  hd: 80  },
  // Center pillars
  { cx: -12, cz: -12, hw: 1.25, hd: 1.25 },
  { cx:  12, cz: -12, hw: 1.25, hd: 1.25 },
  { cx: -12, cz:  12, hw: 1.25, hd: 1.25 },
  { cx:  12, cz:  12, hw: 1.25, hd: 1.25 },
  // Reactor obelisk
  { cx: 0, cz: 0, hw: 0.9, hd: 0.9 },
  // North trench wall (z=-35) — two gaps for player routes
  { cx: -46,   cz: -35, hw: 34,   hd: 0.3 },
  { cx:  25,   cz: -35, hw: 13,   hd: 0.3 },
  { cx:  67.5, cz: -35, hw: 12.5, hd: 0.3 },
  // South trench wall (z=+35, symmetric)
  { cx: -46,   cz:  35, hw: 34,   hd: 0.3 },
  { cx:  25,   cz:  35, hw: 13,   hd: 0.3 },
  { cx:  67.5, cz:  35, hw: 12.5, hd: 0.3 },
  // North fortifications
  { cx: -30, cz: -67.5, hw: 0.3, hd: 12.5 },
  { cx:  30, cz: -67.5, hw: 0.3, hd: 12.5 },
  { cx:   0, cz: -60,   hw: 10,  hd: 0.3  },
  // South fortifications
  { cx: -30, cz:  67.5, hw: 0.3, hd: 12.5 },
  { cx:  30, cz:  67.5, hw: 0.3, hd: 12.5 },
  { cx:   0, cz:  60,   hw: 10,  hd: 0.3  },
  // Center cover boxes
  { cx: -6, cz:  0, hw: 1, hd: 1 }, { cx:  6, cz:  0, hw: 1, hd: 1 },
  { cx:  0, cz: -6, hw: 1, hd: 1 }, { cx:  0, cz:  6, hw: 1, hd: 1 },
  // North zone cover
  { cx: -20, cz: -50, hw: 1.25, hd: 1.25 }, { cx:  0, cz: -50, hw: 1.5, hd: 0.75 },
  { cx:  20, cz: -50, hw: 1.25, hd: 1.25 },
  { cx: -10, cz: -22, hw: 1,    hd: 1    }, { cx: 10, cz: -22, hw: 1,   hd: 1    },
  { cx: -30, cz: -22, hw: 1.5,  hd: 0.75 },
  // South zone cover
  { cx: -20, cz:  50, hw: 1.25, hd: 1.25 }, { cx:  0, cz:  50, hw: 1.5, hd: 0.75 },
  { cx:  20, cz:  50, hw: 1.25, hd: 1.25 },
  { cx: -10, cz:  22, hw: 1,    hd: 1    }, { cx: 10, cz:  22, hw: 1,   hd: 1    },
  { cx:  30, cz:  22, hw: 1.5,  hd: 0.75 },
  // East gallery cover
  { cx: 60, cz: -15, hw: 1, hd: 1 }, { cx: 60, cz: 15, hw: 1, hd: 1 },
  { cx: 70, cz:   0, hw: 1, hd: 1.5 },
  // West gallery cover
  { cx: -60, cz: -15, hw: 1, hd: 1 }, { cx: -60, cz: 15, hw: 1, hd: 1 },
  { cx: -70, cz:   0, hw: 1, hd: 1.5 },
];

function enemyHitsWall(x, z) {
  for (let i = 0; i < SERVER_WALLS.length; i++) {
    const w = SERVER_WALLS[i];
    if (
      x > w.cx - w.hw - ENEMY_RADIUS &&
      x < w.cx + w.hw + ENEMY_RADIUS &&
      z > w.cz - w.hd - ENEMY_RADIUS &&
      z < w.cz + w.hd + ENEMY_RADIUS
    )
      return true;
  }
  return false;
}

// ---- State ----
let players = new Map();
let enemies = new Map();
let items = new Map();
let wave = 0;
let waveActive = false;
let enemyIdSeq = 1;
let playerIdSeq = 1;
let itemIdSeq = 1;
let waveTotal      = 0;   // enemies to spawn this wave
let waveSpawned    = 0;   // enemies spawned so far this wave
let noTargetTimer  = 0;   // seconds with no valid targets outside safe room

function playingCount() {
  let n = 0;
  for (const p of players.values()) if (p.playing) n++;
  return n;
}

// ---- Fixed item positions (The Nexus layout) ----
const AMMO_POSITIONS = [
  [-15, 0, -50], // north zone left
  [ 15, 0, -50], // north zone right
  [  0, 0, -22], // north approach
  [-15, 0,  50], // south zone left
  [ 15, 0,  50], // south zone right
  [  0, 0,  22], // south approach
  [ 55, 0, -10], // east bastion
  [ 55, 0,  10], // east bastion
  [-55, 0, -10], // west gallery
  [-55, 0,  10], // west gallery
  [-25, 0,   0], // west mid
  [ 25, 0,   0], // east mid
];
const HEALTH_POSITIONS = [
  [-74, 0, -74], // safe room
  [  0, 0, -68], // north far
  [  0, 0,  68], // south far
  [ 65, 0,   0], // east far
  [-65, 0,   0], // west far
  [ -4, 0,   0], // center west of obelisk
  [  4, 0,   0], // center east of obelisk
];
const GRENADE_POSITIONS = [
  [-20, 0, -30], // north of trench left
  [ 20, 0, -30], // north of trench right
  [-20, 0,  30], // south of trench left
  [ 20, 0,  30], // south of trench right
  [ 48, 0, -18], // east bastion approach
  [ 48, 0,  18], // east bastion approach
  [  0, 0,   0], // dead center
];

function placeItems() {
  AMMO_POSITIONS.forEach(([x, , z]) => {
    const id = itemIdSeq++;
    items.set(id, {
      id,
      type: "ammo",
      x,
      z,
      active: true,
      respawnDelay: 20000,
      fixed: true,
    });
  });
  HEALTH_POSITIONS.forEach(([x, , z]) => {
    const id = itemIdSeq++;
    items.set(id, {
      id,
      type: "health",
      x,
      z,
      active: true,
      respawnDelay: 25000,
      fixed: true,
    });
  });
  GRENADE_POSITIONS.forEach(([x, , z]) => {
    const id = itemIdSeq++;
    items.set(id, {
      id,
      type: "grenade_pickup",
      x,
      z,
      active: true,
      respawnDelay: 30000,
      fixed: true,
    });
  });
}
placeItems();

// ---- HTTP Server ----
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end("Not Found");
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
  if (side === 1) return { x: (Math.random() - 0.5) * r * 2, z: r };
  if (side === 2) return { x: -r, z: (Math.random() - 0.5) * r * 2 };
  return { x: r, z: (Math.random() - 0.5) * r * 2 };
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
  broadcastAll({
    type: "itemSpawn",
    id: item.id,
    itemType: item.type,
    x: item.x,
    z: item.z,
  });
}

function dropPowerup(x, z) {
  // Powerup drop (35% chance)
  if (Math.random() < 0.35) {
    const types = ["powerup_speed", "powerup_damage", "powerup_rapidfire"];
    const type = types[Math.floor(Math.random() * types.length)];
    const id = itemIdSeq++;
    const item = {
      id,
      type,
      x,
      z,
      active: true,
      respawnDelay: 0,
      fixed: false,
    };
    items.set(id, item);
    broadcastItemSpawn(item);
  }
  // Grenade drop (20% chance)
  if (Math.random() < 0.2) {
    const gx = x + (Math.random() - 0.5) * 2;
    const gz = z + (Math.random() - 0.5) * 2;
    const id = itemIdSeq++;
    const item = {
      id,
      type: "grenade_pickup",
      x: gx,
      z: gz,
      active: true,
      respawnDelay: 0,
      fixed: false,
    };
    items.set(id, item);
    broadcastItemSpawn(item);
  }
}

function applyPickup(player, item) {
  if (item.type === "health") {
    player.hp = Math.min(100, player.hp + 50);
    send(player.ws, {
      type: "pickupEffect",
      itemType: "health",
      hp: player.hp,
    });
  } else if (item.type === "ammo") {
    send(player.ws, { type: "pickupEffect", itemType: "ammo" });
  } else {
    send(player.ws, { type: "pickupEffect", itemType: item.type });
  }
}

// ---- Enemy ----
function spawnEnemy(isElite, isBoss) {
  const id = enemyIdSeq++;
  const pos = randomSpawnPos();
  let maxHp, speed, shootInterval, behavior;
  if (isBoss) {
    maxHp = 2000 + wave * 300;
    speed = BOSS_SPEED + wave * 0.05;
    shootInterval = Math.max(0.6, 1.4 - wave * 0.02);
    behavior = "charge";
  } else if (isElite) {
    maxHp = 280 + wave * 50;
    speed = ELITE_SPEED + wave * 0.12;
    shootInterval = Math.max(0.4, 1.0 - wave * 0.03);
    behavior = "strafe";
  } else {
    maxHp = 100 + wave * 18;
    speed = ENEMY_SPEED + wave * 0.22;
    shootInterval = Math.max(0.5, 2.0 - wave * 0.10);
    behavior = "charge";
  }
  const enemy = {
    id, x: pos.x, z: pos.z, hp: maxHp, maxHp,
    isElite: !!isElite, isBoss: !!isBoss, alive: true, wave,
    speed, shootInterval,
    shootTimer: Math.random() * 2,
    behavior, behaviorTimer: Math.random() * 2.5,
    strafDir: Math.random() < 0.5 ? 1 : -1,
    flankAngle: 0, targetId: null, targetTimer: Math.random() * 3,
  };
  enemies.set(id, enemy);
  broadcastAll({ type: "enemySpawn", id, x: pos.x, z: pos.z,
    elite: !!isElite, boss: !!isBoss, maxHp, wave });
  return enemy;
}

// ---- Wave timers ----
let waveSpawnHandle = null;

function clearWaveTimers() {
  if (waveSpawnHandle) { clearInterval(waveSpawnHandle); waveSpawnHandle = null; }
}

function sweepEnemies() { enemies.clear(); }

function endWave() {
  clearWaveTimers();
  waveActive = false;
  noTargetTimer = 0;
  sweepEnemies();
  broadcastAll({ type: "waveEnd", wave });
  console.log(`Wave ${wave} complete`);
  if (playingCount() > 0)
    setTimeout(() => startWave(wave + 1), WAVE_BREAK * 1000);
}

function startWave(n) {
  clearWaveTimers();
  sweepEnemies();
  wave = n;
  waveActive = true;
  waveTotal   = waveEnemyCount(n);
  waveSpawned = 0;

  broadcastAll({ type: "waveStart", wave, total: waveTotal });
  console.log(`Wave ${wave} — total ${waveTotal}, interval ${spawnInterval(n)}ms, elite ${(eliteChance(n)*100)|0}%`);

  // Boss on every 3rd wave (spawns first)
  if (bossChance(n)) {
    setTimeout(() => {
      if (waveActive && playingCount() > 0 && waveSpawned < waveTotal) {
        spawnEnemy(false, true);
        waveSpawned++;
      }
    }, 800);
  }

  // Initial burst
  const initCount = Math.min(MAX_ENEMIES, 2 + Math.floor(n * 0.8));
  for (let i = 0; i < initCount; i++) {
    setTimeout(() => {
      if (waveActive && playingCount() > 0 && waveSpawned < waveTotal && enemies.size < MAX_ENEMIES) {
        spawnEnemy(Math.random() < eliteChance(n));
        waveSpawned++;
      }
    }, i * 350 + 1200);
  }

  // Continuous spawning until waveTotal reached
  waveSpawnHandle = setInterval(() => {
    if (!waveActive || playingCount() === 0) return;
    if (waveSpawned >= waveTotal) { clearInterval(waveSpawnHandle); waveSpawnHandle = null; return; }
    if (enemies.size < MAX_ENEMIES) {
      spawnEnemy(Math.random() < eliteChance(n));
      waveSpawned++;
    }
  }, spawnInterval(n));
}

function killPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  p.deaths++;
  broadcastAll({ type: "died", id: p.id, name: p.name, deaths: p.deaths });
}

function resetGame() {
  clearWaveTimers();
  enemies.clear();
  wave = 0;
  waveActive = false;
  enemyIdSeq = 1;
  items.clear();
  itemIdSeq = 1;
  placeItems();
  console.log("Game reset");
}

// ---- AI Loop ----
let lastAiTick = Date.now();
setInterval(
  () => {
    if (playingCount() === 0 || enemies.size === 0) return;

    const now = Date.now();
    const dt = Math.min((now - lastAiTick) / 1000, 0.1); // cap dt to avoid tunneling
    lastAiTick = now;

    const allAlivePlayers = [];
    for (const p of players.values()) {
      if (p.playing && p.alive) allAlivePlayers.push(p);
    }
    const alivePlayers = allAlivePlayers.filter((p) => !isInSafeRoom(p.x, p.z));

    if (alivePlayers.length === 0) {
      // No valid targets — all dead or all hiding in safe room
      if (waveActive) {
        noTargetTimer += dt;
        if (noTargetTimer >= 20) {
          noTargetTimer = 0;
          console.log("Wave stuck (no valid targets for 20s) — auto-advancing");
          endWave();
        }
      }
      return;
    }
    noTargetTimer = 0;

    // ---- Enemy movement + combat ----
    for (const [eid, enemy] of enemies) {
      if (!enemy.alive) continue;

      // ---- Target selection (periodic re-evaluation, spread targets in multiplayer) ----
      enemy.targetTimer -= dt;
      if (enemy.targetTimer <= 0 || !enemy.targetId) {
        enemy.targetTimer = 2.5 + Math.random() * 3;
        if (alivePlayers.length > 1 && Math.random() < 0.35) {
          // Occasionally pick a non-nearest player to spread pressure
          enemy.targetId =
            alivePlayers[Math.floor(Math.random() * alivePlayers.length)].id;
        } else {
          let best = null,
            bestD = Infinity;
          for (const p of alivePlayers) {
            const d = Math.hypot(p.x - enemy.x, p.z - enemy.z);
            if (d < bestD) {
              bestD = d;
              best = p;
            }
          }
          enemy.targetId = best ? best.id : null;
        }
      }

      let target = players.get(enemy.targetId);
      // Validate target — fall back to nearest if dead/in safe room
      if (!target || !target.alive || isInSafeRoom(target.x, target.z)) {
        let best = null,
          bestD = Infinity;
        for (const p of alivePlayers) {
          const d = Math.hypot(p.x - enemy.x, p.z - enemy.z);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        target = best;
        enemy.targetId = target ? target.id : null;
      }
      if (!target) continue;

      const dx = target.x - enemy.x,
        dz = target.z - enemy.z;
      const dist = Math.hypot(dx, dz);

      // ---- Behavior switching ----
      enemy.behaviorTimer -= dt;
      if (enemy.behaviorTimer <= 0) {
        const hpFrac = enemy.hp / enemy.maxHp;
        const roll = Math.random();

        if (enemy.isElite) {
          // Elites: tactical — prefer strafing at range, charge when close, retreat when low
          if (hpFrac < 0.28 && roll < 0.45) {
            enemy.behavior = "retreat";
            enemy.behaviorTimer = 1.2 + Math.random() * 1.5;
          } else if (dist > 7 && roll < 0.5) {
            enemy.behavior = "strafe";
            if (Math.random() < 0.4) enemy.strafDir *= -1;
            enemy.behaviorTimer = 1.5 + Math.random() * 2.0;
          } else if (roll < 0.3) {
            enemy.behavior = "flank";
            enemy.flankAngle =
              (Math.random() < 0.5 ? 1 : -1) *
              (Math.PI * 0.2 + Math.random() * Math.PI * 0.35);
            enemy.behaviorTimer = 2.0 + Math.random() * 2.5;
          } else {
            enemy.behavior = "charge";
            enemy.behaviorTimer = 1.0 + Math.random() * 2.0;
          }
        } else {
          // Normals: mostly charge, occasional strafe or flank
          if (hpFrac < 0.22 && roll < 0.28) {
            enemy.behavior = "retreat";
            enemy.behaviorTimer = 0.8 + Math.random();
          } else if (roll < 0.22) {
            enemy.behavior = "strafe";
            if (Math.random() < 0.45) enemy.strafDir *= -1;
            enemy.behaviorTimer = 0.7 + Math.random() * 1.0;
          } else if (roll < 0.12) {
            enemy.behavior = "flank";
            enemy.flankAngle =
              (Math.random() < 0.5 ? 1 : -1) *
              (Math.PI * 0.15 + Math.random() * Math.PI * 0.25);
            enemy.behaviorTimer = 1.2 + Math.random() * 1.5;
          } else {
            enemy.behavior = "charge";
            enemy.behaviorTimer = 1.5 + Math.random() * 2.5;
          }
        }
      }

      // ---- Movement direction from behavior ----
      let moveDx = 0,
        moveDz = 0;
      if (dist > 0.1) {
        const ndx = dx / dist,
          ndz = dz / dist; // unit vector toward player
        const perpDx = -ndz,
          perpDz = ndx; // perpendicular (left)

        switch (enemy.behavior) {
          case "charge":
            moveDx = ndx;
            moveDz = ndz;
            break;
          case "strafe": {
            const fwd = dist > 9 ? 0.25 : dist > 4 ? 0.1 : 0; // inch forward if far
            moveDx = perpDx * enemy.strafDir + ndx * fwd;
            moveDz = perpDz * enemy.strafDir + ndz * fwd;
            const sl = Math.hypot(moveDx, moveDz);
            if (sl > 0) {
              moveDx /= sl;
              moveDz /= sl;
            }
            break;
          }
          case "flank": {
            const c = Math.cos(enemy.flankAngle),
              s = Math.sin(enemy.flankAngle);
            moveDx = ndx * c - ndz * s;
            moveDz = ndx * s + ndz * c;
            break;
          }
          case "retreat":
            moveDx = -ndx;
            moveDz = -ndz;
            break;
        }
      }

      // ---- Repulsion from nearby enemies (spread out naturally) ----
      for (const [oid, other] of enemies) {
        if (oid === eid || !other.alive) continue;
        const ddx = enemy.x - other.x,
          ddz = enemy.z - other.z;
        const dd = Math.hypot(ddx, ddz);
        if (dd < 2.2 && dd > 0.01) {
          const str = (2.2 - dd) / 2.2;
          moveDx += (ddx / dd) * str * 0.35;
          moveDz += (ddz / dd) * str * 0.35;
        }
      }

      // ---- Apply movement if not melee range ----
      if (dist > 1.5) {
        const mlen = Math.hypot(moveDx, moveDz);
        if (mlen > 1) {
          moveDx /= mlen;
          moveDz /= mlen;
        }

        const step = enemy.speed * dt;
        const nx = enemy.x + moveDx * step;
        const nz = enemy.z + moveDz * step;

        // Sliding wall collision
        const blocked = enemyHitsWall(nx, nz) || isInSafeRoom(nx, nz);
        if (!blocked) {
          enemy.x = nx;
          enemy.z = nz;
        } else if (!enemyHitsWall(nx, enemy.z) && !isInSafeRoom(nx, enemy.z)) {
          enemy.x = nx;
        } else if (!enemyHitsWall(enemy.x, nz) && !isInSafeRoom(enemy.x, nz)) {
          enemy.z = nz;
        }
        enemy.x = Math.max(-ARENA, Math.min(ARENA, enemy.x));
        enemy.z = Math.max(-ARENA, Math.min(ARENA, enemy.z));
      }

      // ---- Ranged attack ----
      enemy.shootTimer -= dt;
      if (enemy.shootTimer <= 0 && dist < SHOOT_RANGE) {
        enemy.shootTimer = enemy.shootInterval + Math.random() * 0.4;
        // Spread: boss is perfectly accurate; elites are more accurate; narrows with wave number
        const spread = enemy.isBoss ? 0.01
          : enemy.isElite ? Math.max(0.02, 0.06 - wave * 0.002)
          : Math.max(0.04, 0.10 - wave * 0.003);
        let sdx = dx / dist + (Math.random() - 0.5) * spread;
        let sdz = dz / dist + (Math.random() - 0.5) * spread;
        const len = Math.hypot(sdx, sdz);
        sdx /= len;
        sdz /= len;
        broadcastAll({
          type: "enemyShoot",
          id: enemy.id,
          x: enemy.x,
          z: enemy.z,
          dx: sdx,
          dz: sdz,
          elite: enemy.isElite,
          boss: enemy.isBoss,
        });
        // Hit probability — increases with wave, decreases with distance
        if (!target.invincible) {
          const baseAcc = enemy.isBoss ? 0.95 : enemy.isElite ? 0.80 : 0.65;
          const waveBonus = Math.min(0.2, wave * 0.015);
          if (
            Math.random() <
            Math.max(0.08, baseAcc + waveBonus - dist / SHOOT_RANGE)
          ) {
            const dmg = enemy.isBoss ? 35 : enemy.isElite ? 22 : 12;
            target.hp = Math.max(0, target.hp - dmg);
            send(target.ws, { type: "damage", hp: Math.round(target.hp) });
            if (target.hp <= 0) killPlayer(target);
          }
        }
      }

      // ---- Melee ----
      if (dist < 1.5 && !target.invincible) {
        const dmg = (enemy.isBoss ? 50 : enemy.isElite ? 25 : 12) * dt * 2;
        target.hp = Math.max(0, target.hp - dmg);
        send(target.ws, { type: "damage", hp: Math.round(target.hp) });
        if (target.hp <= 0) killPlayer(target);
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
          broadcastAll({ type: "itemPickup", id: iid });
          if (item.fixed) {
            item.respawnAt = now + item.respawnDelay;
          } else {
            items.delete(iid);
          }
          break;
        }
      }
    }
  },
  Math.floor(1000 / AI_HZ),
);

// ---- Broadcast enemy positions ----
  setInterval(
  () => {
    if (enemies.size === 0 || playingCount() === 0) return;
    const pos = [];
    for (const [id, e] of enemies)
      pos.push({ id, x: +e.x.toFixed(3), z: +e.z.toFixed(3) });
    broadcastAll({ type: "epos", pos });
  },
  Math.floor(1000 / AI_HZ),
);

// ---- Connection Handler ----
wss.on("connection", (ws) => {
  const id = playerIdSeq++;
  const sp = randomPlayerSpawn();
  const player = {
    id,
    ws,
    playing: false,
    name: `Player${id}`,
    color: "#00cc44", // all players green
    x: sp.x,
    y: 1.7,
    z: sp.z,
    yaw: 0,
    hp: 100,
    alive: true,
    invincible: true,
    kills: 0,
    deaths: 0,
    score: 0,
    lastActivity: Date.now(),
    afkWarned: false,
  };
  players.set(id, player);

  console.log(`Player ${id} connected (${players.size} total, ${playingCount()} playing)`);

  // Not counted or spawned until they send "play"
  send(ws, { type: "lobby", id });

  // ---- Message Handler ----
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    player.lastActivity = Date.now();
    player.afkWarned = false;

    // Only "play" and "setName" allowed until they click Play
    if (!player.playing && msg.type !== "play" && msg.type !== "setName") {
      return;
    }

    switch (msg.type) {
      case "play": {
        if (player.playing) break;
        player.playing = true;
        const name =
          String(msg.name || player.name || "")
            .replace(/[<>&"]/g, "")
            .slice(0, 16)
            .trim() || `Player${id}`;
        player.name = name;
        const rsp = randomPlayerSpawn();
        player.x = rsp.x;
        player.z = rsp.z;
        player.hp = 100;
        player.alive = true;
        player.invincible = true;
        setTimeout(() => {
          const p = players.get(id);
          if (p) p.invincible = false;
        }, INVINC_DURATION);

        const otherPlayers = [];
        for (const [pid, p] of players) {
          if (pid !== id && p.playing)
            otherPlayers.push({
              id: pid,
              x: p.x,
              y: p.y,
              z: p.z,
              yaw: p.yaw,
              color: p.color,
              name: p.name,
              kills: p.kills,
              deaths: p.deaths,
              score: p.score,
            });
        }
        const currentEnemies = [];
        for (const [, e] of enemies)
          currentEnemies.push({ id: e.id, x: e.x, z: e.z, elite: e.isElite, boss: e.isBoss, maxHp: e.maxHp, wave: e.wave });
        const currentItems = [];
        for (const [, item] of items) {
          if (item.active)
            currentItems.push({
              id: item.id,
              itemType: item.type,
              x: item.x,
              z: item.z,
            });
        }
        send(ws, {
          type: "init",
          id,
          color: player.color,
          name: player.name,
          wave,
          x: rsp.x,
          y: 1.7,
          z: rsp.z,
          players: otherPlayers,
          enemies: currentEnemies,
          items: currentItems,
        });
        broadcast(
          {
            type: "join",
            id,
            x: player.x,
            y: player.y,
            z: player.z,
            yaw: 0,
            color: player.color,
            name: player.name,
            kills: 0,
            deaths: 0,
            score: 0,
          },
          id,
        );
        broadcastAll({ type: "count", n: playingCount() });
        if (playingCount() >= 1 && wave === 0 && !waveActive) {
          startWave(1);
        }
        break;
      }
      case "move": {
        player.x = msg.x;
        player.y = msg.y;
        player.z = msg.z;
        player.yaw = msg.yaw;
        broadcast(
          { type: "pmove", id, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw },
          id,
        );
        break;
      }
      case "shoot": {
        broadcast({ type: "pshoot", id }, id);
        break;
      }
      case "hit": {
        const dmg = Math.min(Math.max(0, Number(msg.dmg) || 0), 200);
        const enemy = enemies.get(msg.eid);
        if (!enemy || !enemy.alive) break;
        enemy.hp -= dmg;
        if (enemy.hp <= 0) {
          enemy.alive = false;
          enemies.delete(msg.eid);
          const pts = enemy.isBoss ? 2000 : enemy.isElite ? 500 : 100;
          player.kills++;
          player.score += pts;
          broadcastAll({
            type: "ekill",
            eid: msg.eid,
            killer: id,
            killerName: player.name,
            elite: enemy.isElite, boss: enemy.isBoss,
            pts,
            killerKills: player.kills,
            killerScore: player.score,
            enemiesLeft: (waveTotal - waveSpawned) + enemies.size,
          });
          dropPowerup(enemy.x, enemy.z);
          console.log(
            `Enemy ${msg.eid} killed by ${player.name} (${enemies.size} remaining)`,
          );
          // Check if wave is complete (all spawned enemies dead)
          if (waveActive && waveSpawned >= waveTotal && enemies.size === 0) {
            endWave();
          }
        }
        break;
      }
      case "selfDie": {
        // Player killed themselves (e.g. grenade cook-off) — mark dead so respawn works
        if (player.alive) killPlayer(player);
        // Player killed themselves — mark dead server-side so respawn works.
        // Do NOT send "died" back to the sender; they already handle their own death
        // display client-side. Sending it back risks arriving after selfResp and
        // re-killing the player, which leaves them unable to move after respawn.
        if (!player.alive) break;
        player.alive = false;
        player.deaths++;
        broadcast(
          {
            type: "died",
            id: player.id,
            name: player.name,
            deaths: player.deaths,
          },
          id,
        );
        break;
      }
      case "respawn": {
        if (player.alive) break;
        const rsp = randomPlayerSpawn();
        player.hp = 100;
        player.alive = true;
        player.x = rsp.x;
        player.z = rsp.z;
        player.invincible = true;
        setTimeout(() => {
          const p = players.get(id);
          if (p) p.invincible = false;
        }, INVINC_DURATION);
        send(ws, { type: "selfResp", x: rsp.x, z: rsp.z });
        broadcast({ type: "presp", id, x: rsp.x, z: rsp.z }, id);
        break;
      }
      case "endInvincible": {
        player.invincible = false;
        break;
      }
      case "setName": {
        const name =
          String(msg.name || "")
            .replace(/[<>&"]/g, "")
            .slice(0, 16)
            .trim() || `Player${id}`;
        player.name = name;
        broadcastAll({ type: "playerName", id, name });
        break;
      }
      case "grenade": {
        const gx = Math.max(-ARENA, Math.min(ARENA, Number(msg.x) || 0));
        const gy = Number(msg.y) || 1.7;
        const gz = Math.max(-ARENA, Math.min(ARENA, Number(msg.z) || 0));
        const gdx = Number(msg.dx) || 0;
        const gdy = Number(msg.dy) || 0;
        const gdz = Number(msg.dz) || -1;
        const GRENADE_RADIUS = 12; // blast radius (was 6)
        const GRENADE_MAX_DMG = 160; // max damage at epicenter (was 90)
        // Simulate arc with bouncing to find explosion point
        let px = gx,
          py = gy,
          pz = gz;
        let vx = gdx * 16,
          vy = gdy * 16 + 6,
          vz = gdz * 16;
        const simDt = 0.03;
        let bounces = 0;
        for (let t = 0; t < 4.0; t += simDt) {
          vy -= 22 * simDt;
          px += vx * simDt;
          py += vy * simDt;
          pz += vz * simDt;
          px = Math.max(-ARENA, Math.min(ARENA, px));
          pz = Math.max(-ARENA, Math.min(ARENA, pz));
          if (py <= 0) {
            py = 0;
            if (bounces < 2 && Math.abs(vy) > 1.5) {
              vy = -vy * 0.45;
              vx *= 0.72;
              vz *= 0.72;
              bounces++;
            } else {
              break;
            }
          }
        }
        // Radius damage to all enemies
        for (const [eid, enemy] of enemies) {
          if (!enemy.alive) continue;
          const dist = Math.hypot(px - enemy.x, pz - enemy.z);
          if (dist < GRENADE_RADIUS) {
            const falloff = 1 - dist / GRENADE_RADIUS;
            const dmg = Math.round(GRENADE_MAX_DMG * falloff * falloff);
            enemy.hp -= dmg;
            if (enemy.hp <= 0) {
              enemy.alive = false;
              enemies.delete(eid);
              const pts = enemy.isBoss ? 2000 : enemy.isElite ? 500 : 100;
              player.kills++;
              player.score += pts;
              broadcastAll({
                type: "ekill",
                eid,
                killer: id,
                killerName: player.name,
                elite: enemy.isElite, boss: enemy.isBoss,
                pts,
                killerKills: player.kills,
                killerScore: player.score,
                enemiesLeft: (waveTotal - waveSpawned) + enemies.size,
              });
              dropPowerup(enemy.x, enemy.z);
              // Check if wave is complete (all spawned enemies dead)
              if (waveActive && waveSpawned >= waveTotal && enemies.size === 0) {
                endWave();
              }
            }
          }
        }
        broadcast({ type: "grenadeExplosion", x: px, y: 0.3, z: pz }, id); // exclude thrower — they already explode locally
        break;
      }
      case "chat": {
        const text = String(msg.text || "")
          .replace(/[<>&]/g, "")
          .slice(0, 100)
          .trim();
        if (!text) break;
        broadcastAll({
          type: "chat",
          id,
          name: player.name,
          color: player.color,
          text,
        });
        break;
      }
    }
  });

  ws.on("close", () => {
    const wasPlaying = player.playing;
    players.delete(id);
    console.log(`Player ${id} disconnected (${players.size} remaining)`);
    if (wasPlaying) broadcastAll({ type: "leave", id });
    broadcastAll({ type: "count", n: playingCount() });
    if (playingCount() === 0) resetGame();
  });

  ws.on("error", (err) => {
    console.error(`WS error P${id}:`, err.message);
  });
});

// ---- AFK kicker — runs every 10 s ----
setInterval(() => {
  const now = Date.now();
  for (const [, p] of players) {
    const idle = now - p.lastActivity;
    if (idle >= AFK_TIMEOUT) {
      console.log(`Kicking player ${p.id} for AFK (${Math.round(idle/1000)}s idle)`);
      send(p.ws, { type: "kicked", reason: "AFK" });
      p.ws.terminate();
    } else if (!p.afkWarned && idle >= AFK_WARN) {
      send(p.ws, { type: "afkWarning", secsLeft: Math.round((AFK_TIMEOUT - idle) / 1000) });
      p.afkWarned = true;
    }
  }
}, 10_000);

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`DOOM ROOM server running at http://${HOST}:${PORT}`);
});
