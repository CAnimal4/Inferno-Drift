/*
InfernoDrift2 refactor plan:
- Replace the old embedded THREE.js launcher with a lean Canvas 2D game loop.
- Reuse the spirit of drifting/heat/boost from the original while rewriting the engine for clarity and mobile support.
- Keep a modular single-file layout: config/utilities -> input -> renderer -> world/maps -> entities -> AI -> UI state machine -> persistence/debug.
- Preserve the classic build under assets/classic-launcher.html while making the new experience the default.
*/

(() => {
  'use strict';

  /* Config & constants */
  const CONFIG = {
    tile: 56,
    maxHeat: 100,
    driftGain: 18,
    driftToBoost: 0.55,
    boostDrain: 24,
    boostForce: 220,
    accel: 160,
    brake: 120,
    turnRate: 2.7,
    grip: 6.5,
    drag: 0.92,
    offroadDrag: 0.84,
    lavaHeat: 26,
    pickupRespawn: 6,
    cameraLerp: 0.12,
    shakeDecay: 0.9,
    scoreBase: 4,
    comboWindow: 2.8,
    lapGoal: 2,
    maxParticles: 260,
  };

  const QUALITY = {
    high: { particles: 1, shadows: true },
    medium: { particles: 0.6, shadows: true },
    low: { particles: 0.25, shadows: false },
  };

  const SETTINGS_KEY = 'infernodrift2-settings';
  const UPGRADE_KEY = 'infernodrift2-upgrade';
  const DEFAULT_SETTINGS = { sound: 'on', gfx: 'high', controls: 'wasd' };

  const STATE = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', OVER: 'over', ATTRACT: 'attract' };

  /* Utilities */
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpVec = (a, b, t, out) => { out.x = lerp(a.x, b.x, t); out.y = lerp(a.y, b.y, t); return out; };
  const len = v => Math.hypot(v.x, v.y);
  const norm = (v, out) => { const l = len(v) || 1; out.x = v.x / l; out.y = v.y / l; return out; };
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const perp = (v, out) => { out.x = -v.y; out.y = v.x; return out; };
  const seedRand = seed => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const randRange = (r, rng = Math.random) => rng() * r;
  const pick = (arr, rng = Math.random) => arr[(rng() * arr.length) | 0];
  const now = () => performance.now() / 1000;

  /* DOM grabs */
  const el = sel => document.querySelector(sel);
  const els = sel => Array.from(document.querySelectorAll(sel));

  const canvas = el('#gameCanvas');
  const ctx = canvas.getContext('2d');
  const hud = el('#hud');
  const hudSpeed = el('#hudSpeed');
  const hudScore = el('#hudScore');
  const hudCombo = el('#hudCombo');
  const hudLap = el('#hudLap');
  const heatBar = el('#heatBar');
  const driftBar = el('#driftBar');
  const boostBar = el('#boostBar');
  const toast = el('#toast');
  const mapListEl = el('#mapList');
  const mapPreview = el('#mapPreview');
  const mapName = el('#mapName');
  const mapDesc = el('#mapDesc');

  /* Game state */
  const game = {
    state: STATE.MENU,
    mapIndex: 0,
    map: null,
    player: null,
    enemies: [],
    pickups: [],
    particles: [],
    checkpoints: [],
    passedCheckpoints: new Set(),
    lap: 1,
    time: 0,
    combo: 1,
    comboTimer: 0,
    score: 0,
    driftMeter: 0,
    boost: 0,
    heat: 0,
    overheatLock: false,
    shield: 0,
    settings: loadSettings(),
    upgrade: loadUpgrade(),
    difficulty: 0,
    spawnTimer: 0,
    attract: false,
    startTouch: false,
    pickupTimer: CONFIG.pickupRespawn,
    camera: { x: 0, y: 0, shake: 0, zoom: 1 },
    debug: false,
    fps: 0,
    lastFrame: now(),
  };

  /* Map definitions */
  const MAPS = [
    {
      id: 'cradle',
      name: 'Ember Cradle',
      desc: 'Gentle oval with central lava. Starter laps.',
      laps: 2,
      strings: [
        '######################',
        '#......P.....L......##',
        '#..######...###....C##',
        '#..#....#...#.#.....##',
        '#..#....#...#.#..P..##',
        '#..#....#...#.#.....##',
        '#..#....#####.#.....##',
        '#..#............#####S',
        '#..###..LLLL..#......#',
        '#......P.....P#......#',
        '######################',
      ],
      spawn: { player: { x: 2.5, y: 7.5, dir: 0 }, enemies: [{ x: 3.5, y: 7.5 }, { x: 4.5, y: 7.5 }] },
    },
    {
      id: 'fork',
      name: 'Molten Fork',
      desc: 'Split path with a risky lava fork.',
      laps: 2,
      strings: [
        '########################',
        '#...P....######....P..S#',
        '#...####.#....#.#####..#',
        '#...#..#.#.LL.#.#..C#..#',
        '#...#..#.#.LL.#.#..#...#',
        '#...#..#.#....#.#..#...#',
        '#...#..#.######.#..#...#',
        '#...#..#........#..#...#',
        '#...#..##########..#...#',
        '#...#..............#...#',
        '#...#####P####P#####...#',
        '#......................#',
        '########################',
      ],
      spawn: { player: { x: 1.5, y: 11.5, dir: 0 }, enemies: [{ x: 2.5, y: 11.5 }, { x: 3.5, y: 11.5 }] },
    },
    {
      id: 'spire',
      name: 'Spiral Spire',
      desc: 'A spiral that tightens near hot vents.',
      laps: 2,
      strings: [
        '########################',
        '#S....................#',
        '#.######.###########..#',
        '#.#....#.#.......C.#..#',
        '#.#.LL.#.#.#####.#.#..#',
        '#.#.LL.#.#.#...#.#.#..#',
        '#.#.LL.#.#.#.#.#.#.#..#',
        '#.#.LL...#.#.#.#.#.#..#',
        '#.#.#####.#.#.#.#.#...#',
        '#.#.......#.#.#.#.#####',
        '#.#########.#.#.#.....#',
        '#...........#.#.#####.#',
        '#############.#.....#.#',
        '#P...........#.###.#P.#',
        '#.............C...#...#',
        '########################',
      ],
      spawn: { player: { x: 1.5, y: 1.5, dir: 0.2 }, enemies: [{ x: 2.5, y: 1.5 }, { x: 3.5, y: 1.5 }] },
    },
    {
      id: 'bridges',
      name: 'Twin Bridges',
      desc: 'Two overpasses and a lava river.',
      laps: 2,
      strings: [
        '########################',
        '#S.........#####......#',
        '#.#####.LLL#####.#####.',
        '#.#...#.........#...#.#',
        '#.#.P.#.#####.#.#.P#.#',
        '#.#.#.#.#...#.#.#.#.#C',
        '#.#.#.#.#...#.#.#.#.#.',
        '#.#.#.#.#...#.#.#.#.#.',
        '#.#.#.#.#...#.#.#.#.#.',
        '#.#...#.....P#.#...#.#',
        '#.#####.#######.#####.',
        '#....................#',
        '######################',
      ],
      spawn: { player: { x: 1.5, y: 1.5, dir: 0 }, enemies: [{ x: 2.5, y: 1.5 }, { x: 3.5, y: 1.5 }] },
    },
    {
      id: 'serpentine',
      name: 'Serpentine Verge',
      desc: 'S-curves with edge lava and tight apexes.',
      laps: 3,
      strings: [
        '########################',
        '#S.....P..............#',
        '#.#####.#########.#####',
        '#.....#.#.....C#.#....#',
        '#####.#.#.LLL.#.#.##..#',
        '#...#.#.#.LLL.#.#.#...#',
        '#...#.#.#.LLL.#.#.#...#',
        '#...#.#.#.....#.#.###.#',
        '#...#.#.#######.#.#...#',
        '#...#.#.........#.#...#',
        '#...#.###########.#...#',
        '#...P.............#...#',
        '########################',
      ],
      spawn: { player: { x: 1.5, y: 1.5, dir: 0.1 }, enemies: [{ x: 2.5, y: 1.5 }, { x: 3.5, y: 1.5 }] },
    },
    {
      id: 'engine',
      name: 'Heart of the Engine',
      desc: 'Cross-chambers with rotating traffic.',
      laps: 2,
      strings: [
        '########################',
        '#S....#....LLL....#...#',
        '#.#######.LLL.#######.#',
        '#.#....#.......#....#.#',
        '#.#.P..#.#####.#..P.#.#',
        '#.#.####.#...#.####.#.#',
        '#.#......#...#......#.#',
        '#.########...########.#',
        '#....................C#',
        '########################',
      ],
      spawn: { player: { x: 1.5, y: 1.5, dir: 0 }, enemies: [{ x: 2.5, y: 1.5 }, { x: 3.5, y: 1.5 }] },
    },
    {
      id: 'procedural',
      name: 'Procedural Flux',
      desc: 'Daily seeded survival loop with cooling islands.',
      laps: Infinity,
      strings: [],
      spawn: null,
      procedural: true,
    },
  ];

  /* Map builder */
  const TILE = {
    ROAD: 0,
    WALL: 1,
    LAVA: 2,
    BOOST: 3,
    CHECK: 4,
  };

  function parseMap(def) {
    const rng = def.procedural ? seedRand(getDailySeed()) : Math.random;
    const grid = def.procedural ? buildProceduralGrid(rng) : def.strings.map(r => r);
    const h = grid.length;
    const w = grid[0].length;
    const tiles = new Array(h);
    const checkpoints = [];
    const pickups = [];
    let spawn = def.spawn ? { ...def.spawn } : null;
    for (let y = 0; y < h; y++) {
      tiles[y] = new Array(w);
      for (let x = 0; x < w; x++) {
        const ch = grid[y][x] || '#';
        let t = TILE.ROAD;
        if (ch === '#' || ch === 'X') t = TILE.WALL;
        else if (ch === 'L') t = TILE.LAVA;
        else if (ch === 'B') t = TILE.BOOST;
        else if (ch === 'C') { t = TILE.CHECK; checkpoints.push({ x, y }); }
        if (ch === 'P') pickups.push({ x, y });
        if (ch === 'S' && !spawn) spawn = { player: { x: x + 0.5, y: y + 0.5, dir: 0 }, enemies: [] };
        tiles[y][x] = t;
      }
    }
    if (!spawn && def.procedural) {
      spawn = { player: { x: w / 2, y: h / 2, dir: 0 }, enemies: [] };
    }
    return { tiles, w, h, checkpoints, pickups, spawn, isProcedural: !!def.procedural };
  }

  function buildProceduralGrid(rng) {
    const size = 22 + ((rng() * 6) | 0);
    const grid = Array.from({ length: size }, () => '#'.repeat(size).split(''));
    let x = (size / 2) | 0;
    let y = (size / 2) | 0;
    grid[y][x] = 'S';
    const steps = size * size * 1.2;
    let dir = 0;
    for (let i = 0; i < steps; i++) {
      const turn = (rng() > 0.82) ? (rng() > 0.5 ? 1 : -1) : 0;
      dir = (dir + turn + 4) % 4;
      const nx = clamp(x + (dir === 1 ? 1 : dir === 3 ? -1 : 0), 1, size - 2);
      const ny = clamp(y + (dir === 2 ? 1 : dir === 0 ? -1 : 0), 1, size - 2);
      x = nx; y = ny;
      grid[y][x] = '.';
      if (rng() > 0.9) grid[y][x] = 'P';
      if (rng() > 0.93) grid[y][x] = 'C';
      if (rng() > 0.95) grid[y][x] = 'L';
    }
    return grid.map(r => r.join(''));
  }

  function getDailySeed() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  /* Entities */
  function createCar(spawn, isPlayer) {
    return {
      pos: { x: spawn.x * CONFIG.tile, y: spawn.y * CONFIG.tile },
      vel: { x: 0, y: 0 },
      dir: spawn.dir || 0,
      radius: 13,
      grip: CONFIG.grip,
      maxSpeed: 260,
      slip: 0,
      aiType: null,
      shield: 0,
    };
  }

  function createEnemy(spawn, type) {
    const car = createCar(spawn, false);
    car.aiType = type;
    car.maxSpeed = 210 + (type === 'chaser' ? 30 : type === 'blocker' ? -10 : 0);
    return car;
  }

  /* Input */
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Escape' && game.state === STATE.PLAYING) pauseGame();
    if (e.key === '~') toggleDebug();
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  const touch = { steer: { active: false, x: 0 }, drift: false, boost: false };
  const stickEl = el('#touchSteer');
  const stickInner = el('#touchSteer .stick-inner');
  const touchDrift = el('#touchDrift');
  const touchBoost = el('#touchBoost');

  function setupTouch() {
    const touchControls = el('#touchControls');
    const isMobile = matchMedia('(pointer: coarse)').matches;
    touchControls.classList.toggle('hidden', !isMobile);
    const start = e => {
      touch.steer.active = true;
      move(e);
    };
    const move = e => {
      if (!touch.steer.active) return;
      const rect = stickEl.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const dx = clamp(clientX - rect.left - rect.width / 2, -rect.width / 2, rect.width / 2);
      touch.steer.x = dx / (rect.width / 2);
      stickInner.style.transform = `translate(${dx * 0.35}px, 0px)`;
    };
    const end = () => { touch.steer.active = false; touch.steer.x = 0; stickInner.style.transform = 'translate(0,0)'; };
    stickEl.addEventListener('touchstart', start);
    stickEl.addEventListener('touchmove', move);
    stickEl.addEventListener('touchend', end);
    stickEl.addEventListener('touchcancel', end);
    touchDrift.addEventListener('touchstart', () => touch.drift = true);
    touchDrift.addEventListener('touchend', () => touch.drift = false);
    touchBoost.addEventListener('touchstart', () => touch.boost = true);
    touchBoost.addEventListener('touchend', () => touch.boost = false);
  }

  /* Audio */
  let audioCtx = null;
  function playTone(freq = 320, dur = 0.08, vol = 0.1) {
    if (game.settings.sound === 'off') return;
    if (!audioCtx) audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  }

  /* UI helpers */
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function setToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(setToast.tid);
    setToast.tid = setTimeout(() => toast.classList.remove('show'), 1200);
  }

  /* Settings */
  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings));
  }
  function loadUpgrade() {
    try { return JSON.parse(localStorage.getItem(UPGRADE_KEY)) || null; }
    catch { return null; }
  }
  function saveUpgrade(upg) { localStorage.setItem(UPGRADE_KEY, JSON.stringify(upg)); }

  /* Initialization */
  function init() {
    buildMapList();
    bindUI();
    setupTouch();
    resizeCanvas();
    requestAnimationFrame(loop);
    drawPreview();
  }

  function bindUI() {
    el('#startBtn').addEventListener('click', startRun);
    el('#resumeBtn').addEventListener('click', () => { if (game.state === STATE.PAUSED) resumeGame(); });
    el('#watchDemo').addEventListener('click', startAttract);
    el('#openHelp').addEventListener('click', () => show(el('#helpOverlay')));
    el('#closeHelp').addEventListener('click', () => hide(el('#helpOverlay')));
    el('#openSettings').addEventListener('click', () => {
      const s = game.settings;
      el('#settingSound').value = s.sound;
      el('#settingGfx').value = s.gfx;
      el('#settingControls').value = s.controls;
      show(el('#settingsOverlay'));
    });
    el('#closeSettings').addEventListener('click', () => {
      game.settings.sound = el('#settingSound').value;
      game.settings.gfx = el('#settingGfx').value;
      game.settings.controls = el('#settingControls').value;
      saveSettings();
      hide(el('#settingsOverlay'));
    });
    el('#resumePlay').addEventListener('click', resumeGame);
    el('#restartPlay').addEventListener('click', restartRun);
    el('#backToMenu').addEventListener('click', () => gotoMenu());
    el('#playAgain').addEventListener('click', restartRun);
    el('#menuReturn').addEventListener('click', () => gotoMenu());
    el('#pauseBtn').addEventListener('click', () => {
      if (game.state === STATE.PLAYING) pauseGame();
    });
    window.addEventListener('resize', resizeCanvas);
    canvas.addEventListener('click', () => canvas.focus());
  }

  function buildMapList() {
    mapListEl.innerHTML = '';
    MAPS.forEach((m, idx) => {
      const card = document.createElement('button');
      card.className = 'map-card';
      card.innerHTML = `<div class="name">${m.name}</div><div class="muted tiny">${m.desc}</div>`;
      card.addEventListener('click', () => selectMap(idx));
      mapListEl.appendChild(card);
    });
    selectMap(0);
  }

  function selectMap(idx) {
    game.mapIndex = idx;
    els('.map-card').forEach((c, i) => c.classList.toggle('active', i === idx));
    const m = MAPS[idx];
    mapName.textContent = m.name;
    mapDesc.textContent = m.desc;
    drawPreview();
  }

  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }

  /* Game flow */
  function startRun() {
    hide(el('#menuPanel'));
    hide(el('#gameoverOverlay'));
    hide(el('#pauseOverlay'));
    hud.classList.remove('hidden');
    game.state = STATE.PLAYING;
    game.attract = false;
    buildWorld();
    setToast('Lap ' + game.lap);
  }

  function startAttract() {
    hide(el('#menuPanel'));
    game.state = STATE.ATTRACT;
    game.attract = true;
    buildWorld();
  }

  function gotoMenu() {
    game.state = STATE.MENU;
    show(el('#menuPanel'));
    hud.classList.add('hidden');
    hide(el('#pauseOverlay'));
    hide(el('#gameoverOverlay'));
  }

  function pauseGame() {
    if (game.state !== STATE.PLAYING) return;
    game.state = STATE.PAUSED;
    show(el('#pauseOverlay'));
  }
  function resumeGame() {
    if (game.state !== STATE.PAUSED) return;
    game.state = STATE.PLAYING;
    hide(el('#pauseOverlay'));
  }
  function restartRun() {
    hide(el('#gameoverOverlay'));
    startRun();
  }

  /* World setup */
  function buildWorld() {
    const def = MAPS[game.mapIndex];
    game.map = parseMap(def);
    game.lap = 1;
    game.time = 0;
    game.combo = 1;
    game.comboTimer = 0;
    game.score = 0;
    game.driftMeter = 0;
    game.boost = 0;
    game.heat = 0;
    game.overheatLock = false;
    game.shield = 0;
    game.checkpoints = game.map.checkpoints;
    game.passedCheckpoints = new Set();
    game.particles.length = 0;
    game.pickups = [];
    game.enemies = [];
    game.spawnTimer = 2;
    game.startTouch = false;
    game.pickupTimer = CONFIG.pickupRespawn;
    const spawn = game.map.spawn.player;
    game.player = createCar(spawn, true);
    applyUpgrade(game.player);
    spawnPickups(game.map.pickups);
    spawnEnemiesInitial();
    centerCamera();
  }

  function applyUpgrade(car) {
    const upg = game.upgrade;
    if (!upg) return;
    if (upg.id === 'heat') game.heat = -10;
    if (upg.id === 'boost') game.boost = 35;
    if (upg.id === 'shield') car.shield = 1;
    if (upg.id === 'grip') car.grip *= 1.08;
    if (upg.id === 'score') game.score += 100;
  }

  function spawnPickups(list) {
    game.pickups.length = 0;
    for (const p of list) {
      game.pickups.push(makePickup(p.x, p.y, pick(['coin', 'cool', 'cell'])));
    }
  }
  function makePickup(x, y, type) {
    return { x: x * CONFIG.tile + CONFIG.tile / 2, y: y * CONFIG.tile + CONFIG.tile / 2, type, pulse: 0 };
  }

  function spawnEnemiesInitial() {
    const def = MAPS[game.mapIndex];
    const base = def.spawn.enemies || [{ x: def.spawn.player.x + 1, y: def.spawn.player.y + 1 }];
    const types = ['chaser', 'blocker', 'opportunist'];
    base.forEach((s, i) => {
      const type = types[i % types.length];
      game.enemies.push(createEnemy({ ...s, dir: 0 }, type));
    });
  }

  /* Loop */
  function loop() {
    const t = now();
    const dt = clamp(t - game.lastFrame, 0, 0.05);
    game.lastFrame = t;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  function update(dt) {
    game.fps = lerp(game.fps, 1 / dt, 0.05);
    if (game.state === STATE.MENU) return;
    if (game.state === STATE.PAUSED) return;
    if (game.state === STATE.OVER) return;

    game.time += dt;
    if (game.state === STATE.PLAYING || game.state === STATE.ATTRACT) {
      updatePlayer(dt);
      updateEnemies(dt);
      updatePickups(dt);
      updateParticles(dt);
      updateDifficulty(dt);
      handleLaps();
      updateHUD();
      game.comboTimer = Math.max(0, game.comboTimer - dt);
      if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.25);
      game.camera.shake *= CONFIG.shakeDecay;
    }
    el('#resumeBtn').disabled = game.state !== STATE.PAUSED;
    const pauseBtn = el('#pauseBtn');
    if (pauseBtn) pauseBtn.disabled = game.state !== STATE.PLAYING;
  }

  function updateDifficulty(dt) {
    const lapFactor = Math.min(4, game.lap * 0.8);
    game.difficulty = 1 + lapFactor + game.time * 0.08;
    game.spawnTimer -= dt;
    if (game.spawnTimer <= 0) {
      if (game.enemies.length < 6) spawnEnemyWave();
      game.spawnTimer = 10 - Math.min(6, game.difficulty * 0.6);
    }
  }

  function spawnEnemyWave() {
    const def = MAPS[game.mapIndex];
    const choices = ['chaser', 'blocker', 'opportunist'];
    const type = pick(choices);
    const base = def.spawn.player;
    const offset = ((Math.random() * 6) | 0) - 3;
    const enemy = createEnemy({ x: base.x + offset * 0.8, y: base.y + offset * 0.4, dir: 0 }, type);
    enemy.maxSpeed += game.difficulty * 6;
    game.enemies.push(enemy);
  }

  function updatePlayer(dt) {
    const p = game.player;
    const autop = game.state === STATE.ATTRACT;
    const input = autop ? autoInput() : readInput();
    const forward = { x: Math.cos(p.dir), y: Math.sin(p.dir) };
    const speed = len(p.vel);
    const throttle = input.throttle ? 1 : 0;
    const brake = input.brake ? 1 : 0;

    const steerDir = clamp(input.steer, -1, 1);
    const steerStrength = CONFIG.turnRate * (0.5 + Math.min(1, speed / 200));
    p.dir += steerDir * steerStrength * dt;

    if (throttle) {
      p.vel.x += forward.x * CONFIG.accel * dt;
      p.vel.y += forward.y * CONFIG.accel * dt;
    }
    if (brake) {
      p.vel.x *= (1 - CONFIG.brake * 0.003 * dt);
      p.vel.y *= (1 - CONFIG.brake * 0.003 * dt);
    }

    const velDir = Math.atan2(p.vel.y, p.vel.x);
    const diff = wrapAngle(velDir - p.dir);
    const slip = Math.sin(diff);
    p.vel.x -= Math.sin(diff) * p.grip * dt * speed * 0.8;
    p.vel.y += Math.cos(diff) * 0.0;
    p.slip = slip;

    if (input.drift) {
      p.vel.x *= 0.995;
      p.vel.y *= 0.995;
      game.driftMeter = clamp(game.driftMeter + Math.abs(slip) * CONFIG.driftGain * dt, 0, 100);
      addCombo(0.08);
      game.heat += Math.abs(slip) * 5 * dt;
      addSmoke(p.pos, p.vel);
    }

    if (input.boost && game.boost > 0 && !game.overheatLock) {
      const b = CONFIG.boostForce;
      p.vel.x += forward.x * b * dt;
      p.vel.y += forward.y * b * dt;
      game.boost = clamp(game.boost - CONFIG.boostDrain * dt, 0, 100);
      game.heat += 18 * dt;
      addFlare(p.pos, p.vel);
    }

    if (!input.drift && game.driftMeter > 5) {
      game.boost = clamp(game.boost + game.driftMeter * CONFIG.driftToBoost, 0, 100);
      game.driftMeter = 0;
      playTone(520, 0.1, 0.12);
      setToast('Boost charged');
    }

    applyFriction(p, dt);
    integratePosition(p, dt);
    handleCollisions(p, true);
    applyHeat(dt);
    gainScore(speed, dt);
    checkNearMiss();
    centerCamera();
  }

  function autoInput() {
    return {
      steer: Math.sin(game.time * 0.9) * 0.7,
      throttle: true,
      brake: false,
      drift: Math.sin(game.time * 1.4) > 0.65,
      boost: Math.random() > 0.985 && game.boost > 10,
    };
  }

  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function readInput() {
    const scheme = game.settings.controls;
    const accelKey = scheme === 'arrows' ? 'arrowup' : 'w';
    const brakeKey = scheme === 'arrows' ? 'arrowdown' : 's';
    const leftKey = scheme === 'arrows' ? 'arrowleft' : 'a';
    const rightKey = scheme === 'arrows' ? 'arrowright' : 'd';
    const driftKey = ' ';
    const steer = (keys[leftKey] ? -1 : 0) + (keys[rightKey] ? 1 : 0) + touch.steer.x;
    const throttle = keys[accelKey] || touch.steer.active;
    const brake = keys[brakeKey];
    const drift = keys[driftKey] || touch.drift;
    const boost = keys['shift'] || touch.boost;
    return { steer, throttle, brake, drift, boost };
  }

  function applyFriction(car, dt) {
    const speed = len(car.vel);
    const drag = CONFIG.drag;
    car.vel.x *= Math.pow(drag, dt * 60);
    car.vel.y *= Math.pow(drag, dt * 60);
    if (speed > car.maxSpeed) {
      const n = { x: car.vel.x / speed, y: car.vel.y / speed };
      car.vel.x = n.x * car.maxSpeed;
      car.vel.y = n.y * car.maxSpeed;
    }
  }

  function integratePosition(car, dt) {
    car.pos.x += car.vel.x * dt;
    car.pos.y += car.vel.y * dt;
  }

  function handleCollisions(car, isPlayer) {
    const { tile } = CONFIG;
    const grid = game.map.tiles;
    const w = game.map.w;
    const h = game.map.h;
    const cx = clamp((car.pos.x / tile) | 0, 0, w - 1);
    const cy = clamp((car.pos.y / tile) | 0, 0, h - 1);
    const radius = car.radius;
    const neighbors = [
      [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, -1], [1, -1], [-1, 1],
    ];
    let inLava = false;
    for (const [dx, dy] of neighbors) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const t = grid[ny][nx];
      const rect = {
        x: nx * tile,
        y: ny * tile,
        w: tile,
        h: tile,
      };
      if (t === TILE.WALL) {
        const mtv = circleRectMTV(car.pos, radius, rect);
        if (mtv) {
          if (isPlayer && game.player.shield > 0) {
            game.player.shield = 0;
            game.shield = 0;
            setToast('Shield spent');
          }
          car.pos.x += mtv.x;
          car.pos.y += mtv.y;
          car.vel.x *= 0.45;
          car.vel.y *= 0.45;
          if (isPlayer) bump('wall');
        }
      } else if (t === TILE.LAVA) {
        inLava = true;
      }
    }
    if (inLava) {
      if (isPlayer && game.player.shield > 0) {
        game.player.shield = 0;
        game.shield = 0;
        setToast('Shield blocked lava');
      } else {
        game.heat += CONFIG.lavaHeat * (1 / 60);
        addCombo(0.05);
      }
    }
  }

  function circleRectMTV(c, r, rect) {
    const nearestX = clamp(c.x, rect.x, rect.x + rect.w);
    const nearestY = clamp(c.y, rect.y, rect.y + rect.h);
    const dx = c.x - nearestX;
    const dy = c.y - nearestY;
    const dist = Math.hypot(dx, dy);
    if (dist >= r || dist === 0) return null;
    const overlap = r - dist;
    return { x: (dx / dist) * overlap, y: (dy / dist) * overlap };
  }

  function applyHeat(dt) {
    if (game.heat > 0) {
      game.heat = clamp(game.heat - 8 * dt, 0, CONFIG.maxHeat);
    }
    if (game.heat >= CONFIG.maxHeat && !game.overheatLock) {
      game.overheatLock = true;
      endRun('Overheated');
    }
  }

  function addCombo(v) {
    game.combo = clamp(game.combo + v, 1, 9);
    game.comboTimer = CONFIG.comboWindow;
  }

  function gainScore(speed, dt) {
    const runScore = (CONFIG.scoreBase + speed * 0.08) * (1 + 0.15 * game.combo);
    game.score += runScore * dt;
    if (game.attract) game.score += 0.2;
  }

  function handleLaps() {
    const p = game.player;
    const tile = CONFIG.tile;
    const gx = (p.pos.x / tile) | 0;
    const gy = (p.pos.y / tile) | 0;
    const here = game.map.tiles[gy]?.[gx];
    if (here === TILE.CHECK) {
      const id = gx + gy * game.map.w;
      if (!game.passedCheckpoints.has(id)) {
        game.passedCheckpoints.add(id);
        setToast('Checkpoint');
        playTone(680, 0.06, 0.16);
        addCombo(0.5);
      }
    }
    const needed = game.checkpoints.length === 0 ? 0 : game.checkpoints.length;
    const onStart = nearSpawn(p.pos, game.map.spawn.player);
    if (onStart && !game.startTouch && game.passedCheckpoints.size >= needed) {
      game.lap += 1;
      game.passedCheckpoints.clear();
      setToast('Lap ' + game.lap);
      game.spawnTimer = Math.max(2, game.spawnTimer - 0.6);
      game.score += 150 * game.lap;
      if (game.lap > (MAPS[game.mapIndex].laps === Infinity ? Infinity : MAPS[game.mapIndex].laps)) {
        endRun('Finished');
      }
    }
    game.startTouch = onStart;
  }

  function nearSpawn(pos, spawn) {
    const dx = pos.x / CONFIG.tile - spawn.x;
    const dy = pos.y / CONFIG.tile - spawn.y;
    return Math.hypot(dx, dy) < 0.6;
  }

  function checkNearMiss() {
    for (const e of game.enemies) {
      const d = Math.hypot(e.pos.x - game.player.pos.x, e.pos.y - game.player.pos.y);
      if (d > 28 && d < 120) addCombo(0.02);
    }
  }

  /* Enemies */
  function updateEnemies(dt) {
    const grid = game.map.tiles;
    for (const e of game.enemies) {
      const forward = { x: Math.cos(e.dir), y: Math.sin(e.dir) };
      const toPlayer = { x: game.player.pos.x - e.pos.x, y: game.player.pos.y - e.pos.y };
      const dist = len(toPlayer);
      norm(toPlayer, toPlayer);
      let desired = { x: toPlayer.x, y: toPlayer.y };

      if (e.aiType === 'blocker') {
        desired = leadTarget(game.player, e, 0.7);
      } else if (e.aiType === 'opportunist') {
        const pickup = game.pickups[0];
        if (pickup && Math.random() > 0.5) {
          desired = norm({ x: pickup.x - e.pos.x, y: pickup.y - e.pos.y }, desired);
        }
      }

      const avoid = avoidHazard(e, grid);
      desired.x += avoid.x * 1.8;
      desired.y += avoid.y * 1.8;
      norm(desired, desired);

      const desiredAngle = Math.atan2(desired.y, desired.x);
      const diff = wrapAngle(desiredAngle - e.dir);
      e.dir += clamp(diff, -1, 1) * CONFIG.turnRate * dt * 0.8;

      const accel = clamp(1 - Math.abs(diff) * 0.7, 0.2, 1.1);
      e.vel.x += Math.cos(e.dir) * CONFIG.accel * 0.6 * accel * dt;
      e.vel.y += Math.sin(e.dir) * CONFIG.accel * 0.6 * accel * dt;

      applyFriction(e, dt);
      integratePosition(e, dt);
      handleCollisions(e, false);
      if (dist < 30) {
        bump('enemy');
        game.heat += 8;
        game.player.vel.x *= 0.7;
        game.player.vel.y *= 0.7;
      }
    }
  }

  function leadTarget(target, chaser, amt) {
    const offset = { x: target.vel.x * amt, y: target.vel.y * amt };
    const v = { x: target.pos.x + offset.x - chaser.pos.x, y: target.pos.y + offset.y - chaser.pos.y };
    return norm(v, v);
  }

  function avoidHazard(car, grid) {
    const ahead = { x: car.pos.x + Math.cos(car.dir) * 80, y: car.pos.y + Math.sin(car.dir) * 80 };
    const tile = CONFIG.tile;
    const ax = (ahead.x / tile) | 0;
    const ay = (ahead.y / tile) | 0;
    const t = grid[ay]?.[ax];
    const out = { x: 0, y: 0 };
    if (t === TILE.WALL || t === TILE.LAVA) {
      perp({ x: ahead.x - car.pos.x, y: ahead.y - car.pos.y }, out);
      norm(out, out);
    }
    return out;
  }

  /* Pickups */
  function updatePickups(dt) {
    for (const p of game.pickups) {
      p.pulse += dt;
      if (Math.hypot(game.player.pos.x - p.x, game.player.pos.y - p.y) < 24) {
        collectPickup(p);
      }
    }
    game.pickupTimer -= dt;
    if (game.pickupTimer <= 0 && game.pickups.length < 6) {
      const x = 1 + ((Math.random() * (game.map.w - 2)) | 0);
      const y = 1 + ((Math.random() * (game.map.h - 2)) | 0);
      if (game.map.tiles[y][x] === TILE.ROAD) {
        game.pickups.push(makePickup(x, y, pick(['coin', 'cool', 'cell', 'shield'])));
      }
      game.pickupTimer = Math.max(2.5, CONFIG.pickupRespawn - game.difficulty * 0.2);
    }
    for (let i = game.pickups.length - 1; i >= 0; i--) {
      if (game.pickups[i].x < 0) game.pickups.splice(i, 1);
    }
  }

  function collectPickup(p) {
    if (p.type === 'coin') {
      game.score += 80 * game.combo;
      addCombo(0.4);
      playTone(740, 0.08, 0.12);
    } else if (p.type === 'cool') {
      game.heat = Math.max(0, game.heat - 25);
      playTone(420, 0.08, 0.1);
    } else if (p.type === 'cell') {
      game.boost = clamp(game.boost + 30, 0, 100);
    } else if (p.type === 'shield') {
      game.shield = 1;
      game.player.shield = 1;
    }
    p.x = -9999;
  }

  /* Particles */
  function addSmoke(pos, vel) {
    if (!shouldRenderParticles()) return;
    pushParticle(pos, { x: vel.x * 0.02, y: vel.y * 0.02 }, 0.9, 'smoke');
  }
  function addFlare(pos, vel) {
    if (!shouldRenderParticles()) return;
    pushParticle(pos, { x: vel.x * 0.04, y: vel.y * 0.04 }, 0.6, 'flare');
  }
  function pushParticle(pos, vel, life, kind) {
    if (game.particles.length > CONFIG.maxParticles * QUALITY[game.settings.gfx].particles) return;
    game.particles.push({
      x: pos.x,
      y: pos.y,
      vx: vel.x + randRange(4),
      vy: vel.y + randRange(4),
      life,
      max: life,
      kind,
    });
  }

  function updateParticles(dt) {
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const p = game.particles[i];
      p.life -= dt;
      if (p.life <= 0) { game.particles.splice(i, 1); continue; }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.98;
      p.vy *= 0.98;
    }
  }

  function shouldRenderParticles() {
    return QUALITY[game.settings.gfx].particles > 0.1;
  }

  /* HUD + overlays */
  function updateHUD() {
    const speed = (len(game.player.vel) * 0.4) | 0;
    hudSpeed.textContent = speed;
    hudScore.textContent = game.score.toFixed(0);
    hudCombo.textContent = `x${game.combo.toFixed(1)}`;
    hudLap.textContent = `${game.lap}${MAPS[game.mapIndex].laps === Infinity ? '+' : '/' + MAPS[game.mapIndex].laps} · ${game.time.toFixed(1)}s`;
    heatBar.style.width = `${(game.heat / CONFIG.maxHeat) * 100}%`;
    driftBar.style.width = `${game.driftMeter}%`;
    boostBar.style.width = `${game.boost}%`;
    if (game.debug) {
      hudLap.textContent += ` · FPS ${game.fps.toFixed(0)}`;
    }
  }

  /* Rendering */
  function render() {
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!game.map) { ctx.restore(); return; }
    const cam = game.camera;
    const cx = cam.x, cy = cam.y;
    const shakeX = (Math.random() - 0.5) * cam.shake;
    const shakeY = (Math.random() - 0.5) * cam.shake;
    ctx.translate(canvas.width / 2 - cx + shakeX, canvas.height / 2 - cy + shakeY);
    drawTiles();
    drawPickups();
    drawParticles();
    drawCar(game.player, true);
    game.enemies.forEach(e => drawCar(e, false));
    if (game.debug) drawDebug();
    ctx.restore();
  }

  function drawTiles() {
    const tile = CONFIG.tile;
    for (let y = 0; y < game.map.h; y++) {
      for (let x = 0; x < game.map.w; x++) {
        const t = game.map.tiles[y][x];
        const px = x * tile;
        const py = y * tile;
        if (t === TILE.WALL) {
          ctx.fillStyle = '#0c111c';
          ctx.fillRect(px, py, tile, tile);
          ctx.strokeStyle = 'rgba(255,255,255,0.04)';
          ctx.strokeRect(px + 2, py + 2, tile - 4, tile - 4);
        } else if (t === TILE.LAVA) {
          ctx.fillStyle = 'rgba(255,86,48,0.45)';
          ctx.fillRect(px, py, tile, tile);
          ctx.fillStyle = 'rgba(255,180,90,0.35)';
          ctx.fillRect(px + 8, py + 8, tile - 16, tile - 16);
        } else {
          ctx.fillStyle = '#121a27';
          ctx.fillRect(px, py, tile, tile);
        }
        if (t === TILE.CHECK) {
          ctx.strokeStyle = 'rgba(69,240,182,0.5)';
          ctx.setLineDash([6, 6]);
          ctx.strokeRect(px + 4, py + 4, tile - 8, tile - 8);
          ctx.setLineDash([]);
        }
        if ((x + y) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.01)';
          ctx.fillRect(px, py, tile, tile);
        }
      }
    }
  }

  function drawCar(car, isPlayer) {
    ctx.save();
    ctx.translate(car.pos.x, car.pos.y);
    ctx.rotate(car.dir);
    const color = isPlayer ? '#45f0b6' : (car.aiType === 'blocker' ? '#ff9f40' : car.aiType === 'opportunist' ? '#7bdcff' : '#f5597b');
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-14, -10);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-14, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(-12, -3, 14, 6);
    if (isPlayer && game.boost > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(-16, -4, 6, 8);
    }
    ctx.restore();
  }

  function drawPickups() {
    for (const p of game.pickups) {
      if (p.x < 0) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      const t = p.type;
      let color = '#ffd166';
      if (t === 'cool') color = '#7bdcff';
      if (t === 'cell') color = '#ff9f40';
      if (t === 'shield') color = '#b3ff74';
      const pulse = 1 + Math.sin(p.pulse * 4) * 0.1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, 8 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of game.particles) {
      const alpha = p.life / p.max;
      ctx.fillStyle = p.kind === 'smoke'
        ? `rgba(255,255,255,${alpha * 0.2})`
        : `rgba(255,120,80,${alpha * 0.4})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8 * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawDebug() {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeRect(game.player.pos.x - CONFIG.tile / 2, game.player.pos.y - CONFIG.tile / 2, CONFIG.tile, CONFIG.tile);
    ctx.fillStyle = 'rgba(255,0,0,0.3)';
    ctx.fillRect(game.player.pos.x - 2, game.player.pos.y - 2, 4, 4);
    ctx.fillStyle = 'rgba(0,255,0,0.3)';
    ctx.fillRect(game.camera.x - 2, game.camera.y - 2, 4, 4);
    ctx.strokeStyle = 'rgba(255,255,0,0.6)';
    for (const e of game.enemies) {
      ctx.beginPath();
      ctx.arc(e.pos.x, e.pos.y, e.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(e.pos.x, e.pos.y);
      ctx.lineTo(e.pos.x + Math.cos(e.dir) * 32, e.pos.y + Math.sin(e.dir) * 32);
      ctx.stroke();
    }
  }

  function centerCamera() {
    const focus = game.player.pos;
    const cam = game.camera;
    cam.x = lerp(cam.x, focus.x, CONFIG.cameraLerp);
    cam.y = lerp(cam.y, focus.y, CONFIG.cameraLerp);
  }

  /* End conditions */
  function endRun(reason) {
    game.state = STATE.OVER;
    show(el('#gameoverOverlay'));
    hud.classList.add('hidden');
    el('#gameoverTitle').textContent = reason;
    el('#gameoverStats').textContent = `Score ${game.score.toFixed(0)} · Lap ${game.lap} · Time ${game.time.toFixed(1)}s · Combo x${game.combo.toFixed(1)}`;
    buildUpgrades();
    saveUpgrade(null);
  }

  function buildUpgrades() {
    const upgrades = [
      { id: 'heat', name: '+Heat buffer', desc: 'Start slightly cooler and slow heat gain.' },
      { id: 'boost', name: '+Boost cell', desc: 'Begin with 35% boost.' },
      { id: 'shield', name: 'Safety glass', desc: 'Start with one shield hit.' },
      { id: 'grip', name: 'Stickier tires', desc: '+8% grip for drifts.' },
      { id: 'score', name: 'Bonus bank', desc: '+100 starting score.' },
    ];
    const grid = el('#upgradeGrid');
    grid.innerHTML = '';
    pickShuffled(upgrades, 3).forEach(upg => {
      const card = document.createElement('div');
      card.className = 'upgrade-card';
      card.innerHTML = `<div class="name">${upg.name}</div><div class="tiny muted">${upg.desc}</div>`;
      card.addEventListener('click', () => {
        game.upgrade = upg;
        saveUpgrade(upg);
        setToast('Upgrade locked for next run');
        restartRun();
      });
      grid.appendChild(card);
    });
  }

  function pickShuffled(arr, n) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }

  function bump(type) {
    game.combo = Math.max(1, game.combo - 0.5);
    game.camera.shake = Math.min(16, game.camera.shake + (type === 'enemy' ? 10 : 6));
    playTone(220, 0.05, 0.1);
  }

  function toggleDebug() {
    game.debug = !game.debug;
    setToast(game.debug ? 'Debug on (~)' : 'Debug off');
  }

  /* Map preview */
  function drawPreview() {
    const ctxp = mapPreview.getContext('2d');
    ctxp.clearRect(0, 0, mapPreview.width, mapPreview.height);
    const def = MAPS[game.mapIndex];
    const map = def.procedural ? parseMap({ ...def }) : { tiles: def.strings.map(r => r.split('').map(ch => ch === '#' ? TILE.WALL : ch === 'L' ? TILE.LAVA : TILE.ROAD)), w: def.strings[0].length, h: def.strings.length };
    const scale = Math.min(mapPreview.width / (map.w * 1.2), mapPreview.height / (map.h * 1.2));
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const t = map.tiles[y][x];
        const px = x * scale + 8;
        const py = y * scale + 8;
        ctxp.fillStyle = t === TILE.WALL ? '#0c111c' : t === TILE.LAVA ? 'rgba(255,107,74,0.5)' : '#1a2333';
        ctxp.fillRect(px, py, scale, scale);
      }
    }
  }

  // kick off
  init();
})();
