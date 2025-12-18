/*
InfernoDrift2 refactor plan:
- Replace the old embedded THREE.js launcher with a lean Canvas 2D pseudo-3D racer.
- Reuse the state machine/settings UI, but rebuild gameplay: segment-based road, heat/boost/drift, enemies/pickups.
- Keep everything static (no bundler); add an adaptive (bandit) enemy mode stored in localStorage.
- Preserve classic build under assets/classic-launcher.html while making the new experience the default.
*/

(() => {
  'use strict';

  /* Config */
  const CONFIG = {
    segmentLength: 18,
    drawSegments: 220,
    roadWidth: 2000,
    cameraHeight: 1200,
    cameraDepth: 0.9,
    lanes: 3,
    maxSpeed: 260,
    accel: 120,
    brake: 180,
    offroad: 0.7,
    driftGain: 28,
    boostForce: 520,
    boostDrain: 30,
    heatGain: 28,
    heatLava: 40,
    heatCool: 22,
    maxHeat: 100,
    comboWindow: 3,
    pickupInterval: 8,
    enemySpawnInterval: 6,
    fpsSmooth: 0.08,
    mlUpdateHz: 6,
    mlGamma: 0.85,
    mlAlpha: 0.3,
    mlEpsilon: 0.05,
  };

  const QUALITY = {
    high: { particles: true, motionLines: true },
    low: { particles: false, motionLines: false },
  };

  const SETTINGS_KEY = 'infernodrift2-settings';
  const QTABLE_KEY = 'infernodrift2-ql';
  const BEST_KEY = 'infernodrift2-bests';
  const UPGRADE_KEY = 'infernodrift2-upgrade';

  const DEFAULT_SETTINGS = {
    sound: 'on',
    gfx: 'high',
    controls: 'wasd',
    enemyAI: 'standard',
  };

  const STATE = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', OVER: 'over', ATTRACT: 'attract' };
  const ACTIONS = ['left', 'right', 'hold', 'brake', 'ram', 'pickup'];

  /* Utilities */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a = 1) => Math.random() * a;
  const pick = arr => arr[(Math.random() * arr.length) | 0];
  const now = () => performance.now() / 1000;

  /* DOM */
  const el = s => document.querySelector(s);
  const els = s => Array.from(document.querySelectorAll(s));
  const canvas = el('#gameCanvas');
  const ctx = canvas.getContext('2d');
  let viewW = canvas.clientWidth, viewH = canvas.clientHeight, viewScale = 1;
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

  /* Tracks */
  const TRACKS = [
    {
      id: 'ember-loop',
      name: 'Ember Loop',
      desc: 'Warm-up sweepers over lava vents.',
      laps: 2,
      difficulty: 'Easy',
      length: '1.2 km',
      sections: [
        { len: 50, curve: 0, hill: 0 },
        { len: 80, curve: 0.5, hill: 4 },
        { len: 60, curve: -0.4, hill: -2, hazard: 'lava' },
        { len: 40, curve: 0, hill: 0 },
      ],
    },
    {
      id: 'forked-rise',
      name: 'Forked Rise',
      desc: 'Split curves with rolling hills.',
      laps: 2,
      difficulty: 'Medium',
      length: '1.6 km',
      sections: [
        { len: 70, curve: 0.2, hill: 1 },
        { len: 90, curve: -0.6, hill: 5, hazard: 'lava' },
        { len: 60, curve: 0.4, hill: -3 },
        { len: 40, curve: 0, hill: 0 },
      ],
    },
    {
      id: 'spiral-hearth',
      name: 'Spiral Hearth',
      desc: 'Tight spiral apexes over a hot core.',
      laps: 3,
      difficulty: 'Hard',
      length: '1.9 km',
      sections: [
        { len: 50, curve: 0.3, hill: 2 },
        { len: 70, curve: 0.6, hill: 4, hazard: 'lava' },
        { len: 80, curve: -0.7, hill: -4 },
        { len: 40, curve: -0.4, hill: 1 },
      ],
    },
    {
      id: 'bridgeflare',
      name: 'Bridgeflare',
      desc: 'Twin bridge straights, big sweepers.',
      laps: 2,
      difficulty: 'Medium',
      length: '1.5 km',
      sections: [
        { len: 80, curve: 0, hill: 2 },
        { len: 60, curve: 0.5, hill: 1, hazard: 'lava' },
        { len: 80, curve: -0.5, hill: -2 },
        { len: 50, curve: 0, hill: 0 },
      ],
    },
    {
      id: 'serpent-veil',
      name: 'Serpent Veil',
      desc: 'S-curves with edge hazards.',
      laps: 3,
      difficulty: 'Hard',
      length: '1.7 km',
      sections: [
        { len: 60, curve: 0.4, hill: 2 },
        { len: 60, curve: -0.5, hill: -3, hazard: 'lava' },
        { len: 60, curve: 0.5, hill: 1 },
        { len: 60, curve: -0.4, hill: 0 },
      ],
    },
    {
      id: 'engine-core',
      name: 'Engine Core',
      desc: 'Fast straights into tight corks.',
      laps: 2,
      difficulty: 'Medium',
      length: '1.8 km',
      sections: [
        { len: 70, curve: 0, hill: 0 },
        { len: 60, curve: 0.7, hill: 3, hazard: 'lava' },
        { len: 60, curve: -0.7, hill: -3 },
        { len: 70, curve: 0.3, hill: 1 },
      ],
    },
    {
      id: 'flux-proc',
      name: 'Flux Procedural',
      desc: 'Daily-seeded survival track.',
      laps: Infinity,
      difficulty: 'Endless',
      length: 'Procedural',
      sections: null,
      procedural: true,
    },
  ];

  /* Game state */
  const game = {
    state: STATE.MENU,
    settings: loadSettings(),
    bests: loadJSON(BEST_KEY, {}),
    qtable: loadJSON(QTABLE_KEY, {}),
    mapIndex: 0,
    track: null,
    player: null,
    enemies: [],
    pickups: [],
    particles: [],
    pos: { z: 0, x: 0 },
    speed: 0,
    lap: 1,
    time: 0,
    score: 0,
    combo: 1,
    comboTimer: 0,
    driftMeter: 0,
    boost: 0,
    heat: 0,
    overheat: false,
    spawnTimer: 0,
    pickupTimer: 0,
    camera: { x: 0, y: CONFIG.cameraHeight, z: 0, shake: 0 },
    debug: false,
    fps: 0,
    lastFrame: now(),
    mlClock: 0,
    lapGate: false,
  };

  /* Input */
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Escape' && game.state === STATE.PLAYING) pauseGame();
    if (e.key === '~') toggleDebug();
    if (e.key.toLowerCase() === 'f') toggleFullscreen();
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  /* Touch */
  const touch = { left: false, right: false, accel: false, drift: false, boost: false };
  setupTouch();

  /* Audio */
  let audioCtx = null;
  function playTone(freq = 420, dur = 0.05, vol = 0.06) {
    if (game.settings.sound === 'off') return;
    if (!audioCtx) audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sawtooth';
    g.gain.value = vol;
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  }

  /* Initialization */
  function init() {
    buildMapList();
    bindUI();
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
      el('#settingEnemyAI').value = s.enemyAI || 'standard';
      show(el('#settingsOverlay'));
    });
    el('#closeSettings').addEventListener('click', () => {
      game.settings.sound = el('#settingSound').value;
      game.settings.gfx = el('#settingGfx').value;
      game.settings.controls = el('#settingControls').value;
      game.settings.enemyAI = el('#settingEnemyAI').value;
      saveSettings();
      hide(el('#settingsOverlay'));
    });
    el('#resetAI').addEventListener('click', () => {
      game.qtable = {};
      saveJSON(QTABLE_KEY, game.qtable);
      setToast('Enemy learning reset');
    });
    el('#toggleFull').addEventListener('click', toggleFullscreen);
    el('#resumePlay').addEventListener('click', resumeGame);
    el('#restartPlay').addEventListener('click', restartRun);
    el('#backToMenu').addEventListener('click', () => gotoMenu());
    el('#playAgain').addEventListener('click', restartRun);
    el('#menuReturn').addEventListener('click', () => gotoMenu());
    el('#pauseBtn').addEventListener('click', () => { if (game.state === STATE.PLAYING) pauseGame(); });
    window.addEventListener('resize', resizeCanvas);
    canvas.addEventListener('click', () => canvas.focus());
  }

  function buildMapList() {
    mapListEl.innerHTML = '';
    TRACKS.forEach((m, idx) => {
      const card = document.createElement('button');
      card.className = 'map-card';
      card.innerHTML = `<div class="name">${m.name}</div><div class="muted tiny">${m.desc}</div><div class="tiny muted">${m.length} · ${m.difficulty}</div>`;
      card.addEventListener('click', () => selectMap(idx));
      mapListEl.appendChild(card);
    });
    selectMap(0);
  }

  function selectMap(idx) {
    game.mapIndex = idx;
    els('.map-card').forEach((c, i) => c.classList.toggle('active', i === idx));
    const m = TRACKS[idx];
    mapName.textContent = m.name;
    mapDesc.textContent = `${m.desc} (${m.length})`;
    drawPreview();
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    viewW = canvas.clientWidth;
    viewH = canvas.clientHeight;
    viewScale = dpr;
  }

  /* Settings */
  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings)); }
  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  }
  function saveJSON(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

  /* Game flow */
  function startRun() {
    hide(el('#menuPanel')); hide(el('#gameoverOverlay')); hide(el('#pauseOverlay'));
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
    hide(el('#pauseOverlay')); hide(el('#gameoverOverlay'));
  }
  function pauseGame() { if (game.state === STATE.PLAYING) { game.state = STATE.PAUSED; show(el('#pauseOverlay')); } }
  function resumeGame() { if (game.state === STATE.PAUSED) { game.state = STATE.PLAYING; hide(el('#pauseOverlay')); } }
  function restartRun() { hide(el('#gameoverOverlay')); startRun(); }

  /* World */
  function buildWorld() {
    const def = TRACKS[game.mapIndex];
    game.track = buildTrack(def);
    game.pos.z = 0; game.pos.x = 0; game.speed = 0;
    game.lap = 1; game.time = 0; game.score = 0; game.combo = 1; game.comboTimer = 0;
    game.driftMeter = 0; game.boost = 0; game.heat = 0; game.overheat = false;
    game.enemies = []; game.pickups = []; game.particles = [];
    game.spawnTimer = CONFIG.enemySpawnInterval; game.pickupTimer = CONFIG.pickupInterval;
    game.lapGate = false;
    spawnInitialEnemies();
  }

  function buildTrack(def) {
    const segments = [];
    const sections = def.procedural ? buildProceduralSections() : def.sections;
    let z = 0;
    sections.forEach(sec => {
      for (let i = 0; i < sec.len; i++) {
        const curve = sec.curve || 0;
        const hill = sec.hill || 0;
        const y = Math.sin((i / sec.len) * Math.PI) * hill * 40;
        segments.push({
          index: segments.length,
          curve,
          y,
          z,
          width: CONFIG.roadWidth,
          color: (segments.length % 2 === 0) ? '#111827' : '#0d1320',
          hazard: sec.hazard === 'lava' && i > sec.len * 0.3 && i < sec.len * 0.7,
        });
        z += CONFIG.segmentLength;
      }
    });
    return {
      segments,
      length: segments.length * CONFIG.segmentLength,
      laps: def.laps,
    };
  }

  function buildProceduralSections() {
    const rng = Math.random;
    const sections = [];
    for (let i = 0; i < 6; i++) {
      sections.push({
        len: 60 + (rng() * 40) | 0,
        curve: (rng() * 1.2 - 0.6),
        hill: (rng() * 6 - 3),
        hazard: rng() > 0.55 ? 'lava' : null,
      });
    }
    return sections;
  }

  function spawnInitialEnemies() {
    for (let i = 0; i < 3; i++) spawnEnemy();
  }

  function spawnEnemy() {
    let z = game.pos.z + 400 + rand(600);
    if (z > game.track.length) z -= game.track.length;
    const lane = (rand(1) - 0.5) * 1.4;
    const archetypes = ['chaser', 'blocker', 'opportunist'];
    const type = pick(archetypes);
    game.enemies.push({
      z, lane, speed: game.speed * 0.8 + 80, type, action: 'hold', alive: true,
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
    game.fps = lerp(game.fps, 1 / dt, CONFIG.fpsSmooth);
    if (game.state === STATE.MENU || game.state === STATE.PAUSED || game.state === STATE.OVER) return;

    game.time += dt;
    const input = game.state === STATE.ATTRACT ? autoInput() : readInput();
    handlePlayer(input, dt);
    updateEnemies(dt);
    updatePickups(dt);
    updateParticles(dt);
    handleLap(dt);
    updateHUD();
    if (game.state === STATE.PLAYING) {
      game.spawnTimer -= dt;
      if (game.spawnTimer <= 0 && game.enemies.length < 7) { spawnEnemy(); game.spawnTimer = CONFIG.enemySpawnInterval; }
    }
  }

  function autoInput() {
    return {
      steer: Math.sin(game.time * 0.7) * 0.4,
      accel: true,
      brake: false,
      drift: Math.sin(game.time * 1.1) > 0.7,
      boost: Math.random() > 0.98,
    };
  }

  function readInput() {
    const scheme = game.settings.controls;
    const leftKey = scheme === 'arrows' ? 'arrowleft' : 'a';
    const rightKey = scheme === 'arrows' ? 'arrowright' : 'd';
    const upKey = scheme === 'arrows' ? 'arrowup' : 'w';
    const downKey = scheme === 'arrows' ? 'arrowdown' : 's';
    const steer = (keys[leftKey] || touch.left ? -1 : 0) + (keys[rightKey] || touch.right ? 1 : 0);
    return {
      steer,
      accel: keys[upKey] || touch.accel,
      brake: keys[downKey] || false,
      drift: keys[' '] || touch.drift,
      boost: keys['shift'] || touch.boost,
    };
  }

  function handlePlayer(input, dt) {
    const track = game.track;
    const seg = findSegment(game.pos.z);
    const curve = seg.curve;
    game.pos.x -= curve * game.speed * dt * 0.0015;
    game.pos.x += input.steer * dt * (1 + game.speed * 0.0025);
    if (input.accel) game.speed += CONFIG.accel * dt;
    if (input.brake) game.speed -= CONFIG.brake * dt;
    if (!input.accel && !input.brake) game.speed -= CONFIG.accel * 0.4 * dt;
    game.speed = clamp(game.speed, 0, CONFIG.maxSpeed);

    const offroad = Math.abs(game.pos.x) > 1;
    if (offroad) game.speed *= CONFIG.offroad;
    if (seg.hazard) {
      game.heat += CONFIG.heatLava * dt;
      addCombo(0.05);
    }

    // drift/boost
    if (input.drift) {
      game.driftMeter = clamp(game.driftMeter + Math.abs(input.steer) * CONFIG.driftGain * dt, 0, 100);
      addCombo(0.05);
      addSmoke();
      game.heat += CONFIG.heatGain * 0.4 * dt;
    } else if (game.driftMeter > 5) {
      game.boost = clamp(game.boost + game.driftMeter * 0.6, 0, 100);
      game.driftMeter = 0;
      playTone(520, 0.08, 0.12);
      setToast('Boost charged');
    }
    if (input.boost && game.boost > 0 && !game.overheat) {
      game.speed = clamp(game.speed + CONFIG.boostForce * dt, 0, CONFIG.maxSpeed * 1.2);
      game.boost = clamp(game.boost - CONFIG.boostDrain * dt, 0, 100);
      game.heat += CONFIG.heatGain * dt;
      addFlare();
    }

    // advance
    game.pos.z += game.speed * dt;
    if (game.pos.z >= track.length) game.pos.z -= track.length;
    applyHeat(dt);
    game.score += game.speed * 0.12 * dt * game.combo;
    game.comboTimer = Math.max(0, game.comboTimer - dt);
    if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.25);

    // collisions with enemies
    for (const e of game.enemies) {
      const dz = wrapZ(e.z - game.pos.z);
      if (Math.abs(dz) < 30) {
        const dx = (e.lane - game.pos.x) * CONFIG.roadWidth * 0.25;
        if (Math.abs(dx) < 120) {
          bump('enemy');
          game.speed *= 0.7;
          game.heat += 8;
        }
      }
    }
  }

  function wrapZ(z) {
    const len = game.track.length;
    if (z > len / 2) return z - len;
    if (z < -len / 2) return z + len;
    return z;
  }

  function findSegment(z) {
    const i = Math.floor(z / CONFIG.segmentLength) % game.track.segments.length;
    return game.track.segments[i];
  }

  function applyHeat(dt) {
    game.heat = clamp(game.heat - CONFIG.heatCool * dt, 0, CONFIG.maxHeat);
    if (game.heat >= CONFIG.maxHeat && !game.overheat) {
      game.overheat = true;
      endRun('Overheated');
    }
  }

  /* Enemies */
  function updateEnemies(dt) {
    const ml = game.settings.enemyAI === 'adaptive';
    game.mlClock += dt;
    for (const e of game.enemies) {
      const seg = findSegment(e.z);
      const desiredLane = ml ? decideML(e) : decideStandard(e, seg);
      const laneForce = clamp(desiredLane - e.lane, -0.6, 0.6);
      e.lane += laneForce * dt * 1.8;
      e.speed = lerp(e.speed, game.speed * 0.9 + 80, 0.2 * dt);
      e.z += e.speed * dt;
      if (e.z > game.track.length) e.z -= game.track.length;
      if (seg.hazard && Math.random() > 0.7) e.lane += (Math.random() > 0.5 ? 0.3 : -0.3);
    }
    // ML update cadence
    if (ml && game.mlClock >= 1 / CONFIG.mlUpdateHz) {
      game.mlClock = 0;
      updateMLRewards();
    }
  }

  function decideStandard(e, seg) {
    if (e.type === 'chaser') return clamp(game.pos.x + 0.05, -1.4, 1.4);
    if (e.type === 'blocker') return clamp(game.pos.x + (Math.random() - 0.5) * 0.3, -1.3, 1.3);
    if (e.type === 'opportunist') {
      const pk = game.pickups[0];
      if (pk) return clamp(pk.lane + (Math.random() - 0.5) * 0.4, -1.4, 1.4);
    }
    return clamp(seg.curve * 0.5, -1, 1);
  }

  function stateVector(e) {
    const rel = clamp(e.lane - game.pos.x, -1.6, 1.6);
    const laneBucket = rel < -0.5 ? 'L' : rel > 0.5 ? 'R' : 'C';
    const dist = Math.abs(wrapZ(e.z - game.pos.z));
    const distBucket = dist < 80 ? 'N' : dist < 220 ? 'M' : 'F';
    const curve = findSegment(e.z).curve;
    const curveBucket = curve < -0.3 ? 'L' : curve > 0.3 ? 'R' : 'S';
    const speedBucket = game.speed < 90 ? 'Lo' : game.speed < 170 ? 'Md' : 'Hi';
    const hazard = findSegment(e.z).hazard ? 'H' : 'S';
    return `${laneBucket}|${distBucket}|${curveBucket}|${speedBucket}|${hazard}`;
  }

  function decideML(e) {
    const s = stateVector(e);
    const table = game.qtable[s] || {};
    let best = 'hold', bestVal = -1e9;
    for (const a of ACTIONS) {
      const v = table[a] ?? 0;
      if (v > bestVal) { bestVal = v; best = a; }
    }
    if (Math.random() < CONFIG.mlEpsilon) best = pick(ACTIONS);
    e.action = best;
    if (best === 'left') return e.lane - 0.4;
    if (best === 'right') return e.lane + 0.4;
    if (best === 'ram') return game.pos.x;
    if (best === 'pickup' && game.pickups[0]) return game.pickups[0].lane;
    return e.lane;
  }

  function updateMLRewards() {
    for (const e of game.enemies) {
      const s = stateVector(e);
      const reward = computeReward(e);
      const table = game.qtable[s] || {};
      const prev = table[e.action] ?? 0;
      const nextMax = Math.max(...ACTIONS.map(a => (table[a] ?? 0)));
      const updated = prev + CONFIG.mlAlpha * (reward + CONFIG.mlGamma * nextMax - prev);
      table[e.action] = updated;
      game.qtable[s] = table;
    }
    saveJSON(QTABLE_KEY, game.qtable);
  }

  function computeReward(e) {
    let r = 0.02;
    const dz = Math.abs(wrapZ(e.z - game.pos.z));
    if (dz < 60) r += 0.2;
    if (findSegment(e.z).hazard) r -= 0.1;
    if (Math.abs(e.lane) > 1.3) r -= 0.05;
    return r;
  }

  /* Pickups */
  function updatePickups(dt) {
    for (const p of game.pickups) {
      const dz = wrapZ(p.z - game.pos.z);
      if (Math.abs(dz) < 30 && Math.abs(p.lane - game.pos.x) < 0.25) {
        collectPickup(p);
      }
    }
    game.pickupTimer -= dt;
    if (game.pickupTimer <= 0 && game.pickups.length < 4) {
      spawnPickup();
      game.pickupTimer = CONFIG.pickupInterval;
    }
    game.pickups = game.pickups.filter(p => p.z <= game.track.length);
  }

  function spawnPickup() {
    let z = game.pos.z + 200 + rand(800);
    if (z > game.track.length) z -= game.track.length;
    game.pickups.push({
      z,
      lane: (rand(1) - 0.5) * 1.4,
      type: pick(['coin', 'cool', 'cell', 'shield']),
    });
  }

  function collectPickup(p) {
    if (p.type === 'coin') { game.score += 120 * game.combo; addCombo(0.4); }
    if (p.type === 'cool') { game.heat = Math.max(0, game.heat - 30); }
    if (p.type === 'cell') { game.boost = clamp(game.boost + 40, 0, 100); }
    if (p.type === 'shield') { game.heat = Math.max(0, game.heat - 10); game.speed += 20; }
    p.z = Infinity;
    playTone(640, 0.05, 0.1);
  }

  /* Particles */
  function addSmoke() {
    if (!QUALITY[game.settings.gfx].particles) return;
    game.particles.push({ life: 0.5, max: 0.5, kind: 'smoke', x: 0, y: 0 });
  }
  function addFlare() {
    if (!QUALITY[game.settings.gfx].particles) return;
    game.particles.push({ life: 0.4, max: 0.4, kind: 'flare', x: 0, y: 0 });
  }
  function updateParticles(dt) {
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const p = game.particles[i];
      p.life -= dt;
      if (p.life <= 0) game.particles.splice(i, 1);
    }
  }

  /* Lap handling */
  function handleLap(dt) {
    const track = TRACKS[game.mapIndex];
    const nearStart = game.pos.z >= game.track.length - CONFIG.segmentLength * 2 || game.pos.z <= CONFIG.segmentLength * 2;
    if (nearStart && !game.lapGate && game.speed > 10) {
      if (game.state === STATE.PLAYING && track.laps !== Infinity) {
        game.lap += 1;
        game.score += 300 * game.lap;
        setToast('Lap ' + game.lap);
        if (game.lap > track.laps) endRun('Finished');
      }
      game.lapGate = true;
    }
    if (!nearStart) game.lapGate = false;
  }

  /* HUD */
  function updateHUD() {
    hudSpeed.textContent = (game.speed | 0);
    hudScore.textContent = game.score.toFixed(0);
    hudCombo.textContent = `x${game.combo.toFixed(1)}`;
    hudLap.textContent = `${game.lap}/${TRACKS[game.mapIndex].laps === Infinity ? '∞' : TRACKS[game.mapIndex].laps} · ${game.time.toFixed(1)}s`;
    heatBar.style.width = `${(game.heat / CONFIG.maxHeat) * 100}%`;
    driftBar.style.width = `${game.driftMeter}%`;
    boostBar.style.width = `${game.boost}%`;
  }

  /* Rendering */
  function render() {
    const w = viewW, h = viewH;
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!game.track) return;
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    renderRoad(w, h);
    renderPickups(w, h);
    renderEnemies(w, h);
    renderPlayer(w, h);
    renderParticles(w, h);
    if (game.debug) renderDebug(w, h);
  }

  function project(x, y, z, camera, w, h) {
    const dz = z - camera.z;
    if (dz <= 0.1) return null;
    const scale = camera.depth / dz;
    return {
      x: (1 + scale * (x - camera.x)) * w / 2,
      y: (1 - scale * (y - camera.y)) * h / 2,
      scale,
    };
  }

  function renderRoad(w, h) {
    const base = findSegment(game.pos.z);
    const camera = {
      x: game.pos.x * CONFIG.roadWidth,
      y: CONFIG.cameraHeight + base.y,
      z: game.pos.z - 300,
      depth: CONFIG.cameraDepth,
    };
    let x = 0, dx = 0;
    for (let n = 0; n < CONFIG.drawSegments; n++) {
      const seg = game.track.segments[(base.index + n) % game.track.segments.length];
      const z1 = seg.z - game.pos.z;
      const z2 = z1 + CONFIG.segmentLength;
      const p1 = project(x, seg.y, z1, camera, w, h);
      x += dx;
      dx += seg.curve * 0.5;
      const p2 = project(x, seg.y, z2, camera, w, h);
      if (!p1 || !p2) continue;
      ctx.fillStyle = seg.color;
      drawQuad(p1.x, p1.y, p2.x, p2.y, p1.scale, p2.scale);
      // rumble
      ctx.fillStyle = (seg.index % 2 === 0) ? '#1f2a44' : '#111827';
      drawQuad(p1.x * 0.96, p1.y, p2.x * 0.96, p2.y, p1.scale * 0.96, p2.scale * 0.96);
      // hazard
      if (seg.hazard) {
        ctx.fillStyle = 'rgba(255,96,48,0.4)';
        drawQuad(p1.x * 0.4, p1.y, p2.x * 0.4, p2.y, p1.scale * 0.4, p2.scale * 0.4);
      }
      // center line
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.moveTo(w / 2 + (p1.x - w / 2) * 0.02, p1.y);
      ctx.lineTo(w / 2 + (p2.x - w / 2) * 0.02, p2.y);
      ctx.stroke();
    }
  }

  function drawQuad(x1, y1, x2, y2, s1, s2) {
    const rw1 = s1 * CONFIG.roadWidth * 0.5;
    const rw2 = s2 * CONFIG.roadWidth * 0.5;
    ctx.beginPath();
    ctx.moveTo(x1 - rw1, y1);
    ctx.lineTo(x1 + rw1, y1);
    ctx.lineTo(x2 + rw2, y2);
    ctx.lineTo(x2 - rw2, y2);
    ctx.closePath();
    ctx.fill();
  }

  function renderPlayer(w, h) {
    const scale = 1.6;
    const carW = 26 * scale;
    const carH = 50 * scale;
    const x = w / 2;
    const y = h * 0.72;
    ctx.fillStyle = '#45f0b6';
    roundRect(ctx, x - carW / 2, y - carH / 2, carW, carH, 8, true);
    ctx.fillStyle = '#0c1320';
    ctx.fillRect(x - carW * 0.35, y - carH * 0.35, carW * 0.7, carH * 0.7);
    if (QUALITY[game.settings.gfx].motionLines && game.speed > 140) {
      ctx.strokeStyle = 'rgba(69,240,182,0.3)';
      ctx.beginPath();
      ctx.moveTo(x, y + carH / 2);
      ctx.lineTo(x, y + carH / 2 + 28);
      ctx.stroke();
    }
  }

  function renderEnemies(w, h) {
    const cam = { x: game.pos.x * CONFIG.roadWidth, y: CONFIG.cameraHeight, z: game.pos.z - 300, depth: CONFIG.cameraDepth };
    for (const e of game.enemies) {
      const seg = findSegment(e.z);
      const p = project(e.lane * CONFIG.roadWidth, seg.y, e.z - game.pos.z, cam, w, h);
      if (!p) continue;
      const size = 24 * p.scale * 40;
      ctx.fillStyle = e.type === 'blocker' ? '#ff9f40' : e.type === 'opportunist' ? '#7bdcff' : '#f5597b';
      roundRect(ctx, p.x - size * 0.5, p.y - size, size, size * 1.4, 6, true);
    }
  }

  function renderPickups(w, h) {
    const cam = { x: game.pos.x * CONFIG.roadWidth, y: CONFIG.cameraHeight, z: game.pos.z - 300, depth: CONFIG.cameraDepth };
    for (const p of game.pickups) {
      const seg = findSegment(p.z);
      const pr = project(p.lane * CONFIG.roadWidth, seg.y, p.z - game.pos.z, cam, w, h);
      if (!pr) continue;
      const r = 12 * pr.scale * 40;
      let color = '#ffd166';
      if (p.type === 'cool') color = '#7bdcff';
      if (p.type === 'cell') color = '#ff9f40';
      if (p.type === 'shield') color = '#b3ff74';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function renderParticles(w, h) {
    if (!QUALITY[game.settings.gfx].particles) return;
    for (const p of game.particles) {
      const alpha = p.life / p.max;
      ctx.fillStyle = p.kind === 'smoke' ? `rgba(255,255,255,${alpha * 0.2})` : `rgba(255,140,90,${alpha * 0.4})`;
      ctx.beginPath();
      ctx.arc(w / 2 + rand(10) - 5, h * 0.8 + rand(6) - 3, 8 * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function roundRect(context, x, y, w, h, r, fill) {
    const rr = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r;
    context.beginPath();
    context.moveTo(x + rr.tl, y);
    context.lineTo(x + w - rr.tr, y);
    context.quadraticCurveTo(x + w, y, x + w, y + rr.tr);
    context.lineTo(x + w, y + h - rr.br);
    context.quadraticCurveTo(x + w, y + h, x + w - rr.br, y + h);
    context.lineTo(x + rr.bl, y + h);
    context.quadraticCurveTo(x, y + h, x, y + h - rr.bl);
    context.lineTo(x, y + rr.tl);
    context.quadraticCurveTo(x, y, x + rr.tl, y);
    context.closePath();
    if (fill) context.fill();
  }

  function renderDebug(w, h) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(10, 10, 200, 120);
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    const lines = [
      `fps ${game.fps.toFixed(0)}`,
      `spd ${game.speed.toFixed(1)}`,
      `heat ${game.heat.toFixed(1)}`,
      `drift ${game.driftMeter.toFixed(1)}`,
      `boost ${game.boost.toFixed(1)}`,
      `AI ${game.settings.enemyAI}`,
      `qStates ${Object.keys(game.qtable).length}`,
    ];
    lines.forEach((t, i) => ctx.fillText(t, 16, 26 + i * 14));
  }

  /* Finish */
  function endRun(reason) {
    game.state = STATE.OVER;
    show(el('#gameoverOverlay'));
    hud.classList.add('hidden');
    el('#gameoverTitle').textContent = reason;
    el('#gameoverStats').textContent = `Score ${game.score.toFixed(0)} · Lap ${game.lap} · Time ${game.time.toFixed(1)}s`;
    updateBests(game.score);
  }

  function updateBests(score) {
    const id = TRACKS[game.mapIndex].id;
    const prev = game.bests[id] || 0;
    if (score > prev) {
      game.bests[id] = score;
      saveJSON(BEST_KEY, game.bests);
      setToast('New best for this track');
    }
  }

  function bump(type) {
    game.combo = Math.max(1, game.combo - 0.4);
    game.camera.shake = Math.min(12, game.camera.shake + (type === 'enemy' ? 8 : 4));
    playTone(220, 0.05, 0.1);
  }

  function addCombo(v) {
    game.combo = clamp(game.combo + v, 1, 9);
    game.comboTimer = CONFIG.comboWindow;
  }

  /* UI helpers */
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function setToast(msg) {
    toast.textContent = msg; toast.classList.add('show');
    clearTimeout(setToast.tid);
    setToast.tid = setTimeout(() => toast.classList.remove('show'), 1200);
  }

  function toggleDebug() {
    game.debug = !game.debug;
    setToast(game.debug ? 'Debug on (~)' : 'Debug off');
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }

  /* Touch setup */
  function setupTouch() {
    const controls = el('#touchControls');
    const isMobile = matchMedia('(pointer: coarse)').matches;
    controls.classList.toggle('hidden', !isMobile);
    el('#touchDrift').addEventListener('touchstart', () => touch.drift = true);
    el('#touchDrift').addEventListener('touchend', () => touch.drift = false);
    el('#touchBoost').addEventListener('touchstart', () => { touch.boost = true; touch.accel = true; });
    el('#touchBoost').addEventListener('touchend', () => { touch.boost = false; touch.accel = false; });
    const steer = el('#touchSteer');
    steer.addEventListener('touchstart', e => {
      touch.left = touch.right = false;
      updateSteer(e);
    });
    steer.addEventListener('touchmove', updateSteer);
    steer.addEventListener('touchend', () => { touch.left = touch.right = false; });
    function updateSteer(e) {
      const rect = steer.getBoundingClientRect();
      const x = e.touches[0].clientX - rect.left;
      const centered = (x / rect.width) - 0.5;
      touch.left = centered < -0.1; touch.right = centered > 0.1;
    }
  }

  /* Map preview */
  function drawPreview() {
    const ctxp = mapPreview.getContext('2d');
    ctxp.clearRect(0, 0, mapPreview.width, mapPreview.height);
    ctxp.fillStyle = '#0c1320';
    ctxp.fillRect(0, 0, mapPreview.width, mapPreview.height);
    const def = TRACKS[game.mapIndex];
    const sections = def.procedural ? buildProceduralSections() : def.sections;
    let x = mapPreview.width / 2;
    let y = mapPreview.height - 10;
    ctxp.strokeStyle = '#45f0b6';
    ctxp.lineWidth = 2;
    ctxp.beginPath();
    ctxp.moveTo(x, y);
    sections.forEach(sec => {
      for (let i = 0; i < sec.len; i++) {
        x += sec.curve * 1.4;
        y -= 1.1;
        ctxp.lineTo(x, y);
      }
    });
    ctxp.stroke();
  }

  // kick off
  init();
})();
