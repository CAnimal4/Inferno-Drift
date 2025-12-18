/*
InfernoDrift2 pseudo-3D racer (static, no build)
- Run locally: `python -m http.server` then open http://localhost:8000
- Controls: WASD/Arrows steer+throttle, Down brake, Space drift (banks boost), Shift/F boost, F fullscreen, ~ debug overlay.
- Tracks: TRACKS array below; each track is sections {len, curve, hill, hazard?, boost?}. Add new tracks by pushing a new object with metadata + sections; renderer builds segments automatically.
- Approach: OutRun-style segment projection with hills/curves, car physics (lateral slip, drift->boost, heat), enemies with simple/adaptive AI, pickups, full-viewport canvas with DPR scaling.
*/

(() => {
  'use strict';

  /* Config */
  const CONFIG = {
    segmentLength: 18,
    drawSegments: 200,
    roadWidth: 2200,
    cameraHeight: 1400,
    cameraDepth: 0.9,
    accel: 130,
    brake: 200,
    offroad: 0.72,
    maxSpeed: 280,
    driftGain: 26,
    boostForce: 520,
    boostDrain: 32,
    heatGain: 26,
    heatCool: 22,
    heatLava: 40,
    maxHeat: 100,
    comboWindow: 3,
    pickupInterval: 7.5,
    enemySpawnInterval: 6,
    fpsSmooth: 0.08,
    mlUpdateHz: 6,
    mlAlpha: 0.25,
    mlGamma: 0.85,
    mlEps: 0.05,
  };

  const QUALITY = {
    high: { particles: true, lines: true },
    low: { particles: false, lines: false },
  };

  /* Tracks */
  const TRACKS = [
    {
      id: 'ember-loop', name: 'Ember Loop', desc: 'Warm-up sweepers over lava vents.', laps: 2, difficulty: 'Easy', length: '1.2 km',
      sections: [
        { len: 50, curve: 0, hill: 0, boost: true },
        { len: 70, curve: 0.4, hill: 4 },
        { len: 60, curve: -0.4, hill: -2, hazard: 'lava' },
        { len: 40, curve: 0, hill: 0 },
      ],
    },
    {
      id: 'forked-rise', name: 'Forked Rise', desc: 'Split curves with rolling hills.', laps: 2, difficulty: 'Medium', length: '1.6 km',
      sections: [
        { len: 70, curve: 0.2, hill: 2 },
        { len: 80, curve: -0.6, hill: 5, hazard: 'lava', boost: true },
        { len: 60, curve: 0.4, hill: -3 },
        { len: 40, curve: 0, hill: 0 },
      ],
    },
    {
      id: 'spiral-hearth', name: 'Spiral Hearth', desc: 'Tight spiral apexes over a hot core.', laps: 3, difficulty: 'Hard', length: '1.9 km',
      sections: [
        { len: 50, curve: 0.3, hill: 2 },
        { len: 70, curve: 0.6, hill: 4, hazard: 'lava', boost: true },
        { len: 80, curve: -0.7, hill: -4 },
        { len: 40, curve: -0.4, hill: 1 },
      ],
    },
    {
      id: 'bridgeflare', name: 'Bridgeflare', desc: 'Twin bridge straights, big sweepers.', laps: 2, difficulty: 'Medium', length: '1.5 km',
      sections: [
        { len: 80, curve: 0, hill: 2 },
        { len: 60, curve: 0.5, hill: 1, hazard: 'lava' },
        { len: 80, curve: -0.5, hill: -2, boost: true },
        { len: 50, curve: 0, hill: 0 },
      ],
    },
    {
      id: 'serpent-veil', name: 'Serpent Veil', desc: 'S-curves with edge hazards.', laps: 3, difficulty: 'Hard', length: '1.7 km',
      sections: [
        { len: 60, curve: 0.4, hill: 2 },
        { len: 60, curve: -0.5, hill: -3, hazard: 'lava' },
        { len: 60, curve: 0.5, hill: 1, boost: true },
        { len: 60, curve: -0.4, hill: 0 },
      ],
    },
    {
      id: 'engine-core', name: 'Engine Core', desc: 'Fast straights into tight corks.', laps: 2, difficulty: 'Medium', length: '1.8 km',
      sections: [
        { len: 70, curve: 0, hill: 0 },
        { len: 60, curve: 0.7, hill: 3, hazard: 'lava' },
        { len: 60, curve: -0.7, hill: -3, boost: true },
        { len: 70, curve: 0.3, hill: 1 },
      ],
    },
    {
      id: 'flux-proc', name: 'Flux Procedural', desc: 'Daily-seeded survival track.', laps: Infinity, difficulty: 'Endless', length: 'Procedural', procedural: true },
  ];

  const SETTINGS_KEY = 'infernodrift2-settings';
  const QTABLE_KEY = 'infernodrift2-ql';
  const BEST_KEY = 'infernodrift2-bests';
  const DEFAULT_SETTINGS = { sound: 'on', gfx: 'high', controls: 'wasd', enemyAI: 'standard' };
  const STATE = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', OVER: 'over', ATTRACT: 'attract' };
  const ACTIONS = ['left', 'right', 'hold', 'ram', 'pickup'];

  /* Utils */
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
  let viewW = canvas.clientWidth, viewH = canvas.clientHeight, viewScale = 1, lastDt = 0;
  const hudSpeed = el('#hudSpeed'), hudScore = el('#hudScore'), hudCombo = el('#hudCombo'), hudLap = el('#hudLap');
  const heatBar = el('#heatBar'), driftBar = el('#driftBar'), boostBar = el('#boostBar'), toast = el('#toast');
  const mapListEl = el('#mapList'), mapPreview = el('#mapPreview'), mapName = el('#mapName'), mapDesc = el('#mapDesc');

  /* State */
  const game = {
    state: STATE.MENU,
    settings: loadSettings(),
    qtable: loadJSON(QTABLE_KEY, {}),
    bests: loadJSON(BEST_KEY, {}),
    mapIndex: 0,
    track: null,
    pos: { x: 0, z: 0 },
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
    enemies: [],
    pickups: [],
    particles: [],
    spawnTimer: CONFIG.enemySpawnInterval,
    pickupTimer: CONFIG.pickupInterval,
    camera: { shake: 0 },
    debug: false,
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
  const touch = { left: false, right: false, accel: false, drift: false, boost: false };
  setupTouch();

  /* Audio */
  let audioCtx = null;
  function playTone(freq = 420, dur = 0.06, vol = 0.08) {
    if (game.settings.sound === 'off') return;
    if (!audioCtx) audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    g.gain.value = vol;
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  }

  /* Init */
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
    el('#resetAI').addEventListener('click', () => { game.qtable = {}; saveJSON(QTABLE_KEY, game.qtable); setToast('Enemy learning reset'); });
    el('#toggleFull').addEventListener('click', toggleFullscreen);
    el('#resumePlay').addEventListener('click', resumeGame);
    el('#restartPlay').addEventListener('click', restartRun);
    el('#backToMenu').addEventListener('click', gotoMenu);
    el('#playAgain').addEventListener('click', restartRun);
    el('#menuReturn').addEventListener('click', gotoMenu);
    el('#pauseBtn').addEventListener('click', () => { if (game.state === STATE.PLAYING) pauseGame(); });
    window.addEventListener('resize', resizeCanvas);
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
    const w = window.innerWidth, h = window.innerHeight, dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    viewW = w; viewH = h; viewScale = dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Settings persistence */
  function loadSettings() { try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; } catch { return { ...DEFAULT_SETTINGS }; } }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings)); }
  function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
  function saveJSON(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

  /* Game flow */
  function startRun() { hide(el('#menuPanel')); hide(el('#gameoverOverlay')); hide(el('#pauseOverlay')); game.state = STATE.PLAYING; buildWorld(); setToast('Lap ' + game.lap); }
  function startAttract() { hide(el('#menuPanel')); game.state = STATE.ATTRACT; buildWorld(); }
  function gotoMenu() { game.state = STATE.MENU; show(el('#menuPanel')); hide(el('#pauseOverlay')); hide(el('#gameoverOverlay')); }
  function pauseGame() { if (game.state === STATE.PLAYING) { game.state = STATE.PAUSED; show(el('#pauseOverlay')); } }
  function resumeGame() { if (game.state === STATE.PAUSED) { game.state = STATE.PLAYING; hide(el('#pauseOverlay')); } }
  function restartRun() { hide(el('#gameoverOverlay')); startRun(); }

  /* Track builder */
  function buildTrack(def) {
    const sections = def.procedural ? buildProceduralSections() : def.sections;
    const segments = [];
    let z = 0;
    for (const sec of sections) {
      for (let i = 0; i < sec.len; i++) {
        const curve = sec.curve || 0;
        const hill = sec.hill || 0;
        const y = Math.sin((i / sec.len) * Math.PI) * hill * 40;
        segments.push({
          index: segments.length,
          curve,
          y,
          z,
          color: (segments.length % 2 === 0) ? '#111827' : '#0d1320',
          hazard: sec.hazard === 'lava' && i > sec.len * 0.3 && i < sec.len * 0.7,
          boost: sec.boost && i % 12 < 5,
          prop: Math.random() > 0.82 ? (Math.random() > 0.5 ? 'rock' : 'sign') : null,
        });
        z += CONFIG.segmentLength;
      }
    }
    return { segments, length: segments.length * CONFIG.segmentLength, laps: def.laps };
  }

  function buildProceduralSections() {
    const out = [];
    for (let i = 0; i < 6; i++) {
      out.push({ len: 60 + ((Math.random() * 40) | 0), curve: Math.random() * 1.2 - 0.6, hill: Math.random() * 6 - 3, hazard: Math.random() > 0.55 ? 'lava' : null, boost: Math.random() > 0.6 });
    }
    return out;
  }

  function buildWorld() {
    const def = TRACKS[game.mapIndex];
    game.track = buildTrack(def);
    game.pos.x = 0; game.pos.z = 0; game.speed = 0;
    game.lap = 1; game.time = 0; game.score = 0; game.combo = 1; game.comboTimer = 0; game.driftMeter = 0; game.boost = 0; game.heat = 0; game.overheat = false;
    game.enemies = []; game.pickups = []; game.particles = [];
    game.spawnTimer = CONFIG.enemySpawnInterval; game.pickupTimer = CONFIG.pickupInterval; game.lapGate = false;
    for (let i = 0; i < 3; i++) spawnEnemy();
  }

  function spawnEnemy() {
    let z = game.pos.z + 400 + rand(700); if (z > game.track.length) z -= game.track.length;
    game.enemies.push({ z, lane: (rand(1) - 0.5) * 1.4, speed: game.speed * 0.8 + 80, type: pick(['chaser', 'blocker', 'opportunist']), action: 'hold' });
  }

  /* Loop */
  function loop() {
    const t = now(); const dt = clamp(t - game.lastFrame, 0, 0.05); game.lastFrame = t; lastDt = dt;
    update(dt); render(); requestAnimationFrame(loop);
  }

  function update(dt) {
    if (game.state === STATE.MENU || game.state === STATE.PAUSED || game.state === STATE.OVER) return;
    game.fps = lerp(game.fps, 1 / dt, CONFIG.fpsSmooth);
    game.time += dt;
    const input = game.state === STATE.ATTRACT ? autoInput() : readInput();
    handlePlayer(input, dt);
    updateEnemies(dt);
    updatePickups(dt);
    updateParticles(dt);
    handleLap();
    updateHUD();
    if (game.state === STATE.PLAYING) {
      game.spawnTimer -= dt; if (game.spawnTimer <= 0 && game.enemies.length < 7) { spawnEnemy(); game.spawnTimer = CONFIG.enemySpawnInterval; }
    }
  }

  function autoInput() { return { steer: Math.sin(game.time * 0.7) * 0.4, accel: true, brake: false, drift: Math.sin(game.time * 1.1) > 0.7, boost: Math.random() > 0.98 }; }
  function readInput() {
    const scheme = game.settings.controls;
    const left = scheme === 'arrows' ? 'arrowleft' : 'a', right = scheme === 'arrows' ? 'arrowright' : 'd', up = scheme === 'arrows' ? 'arrowup' : 'w', down = scheme === 'arrows' ? 'arrowdown' : 's';
    const steer = (keys[left] || touch.left ? -1 : 0) + (keys[right] || touch.right ? 1 : 0);
    return { steer, accel: keys[up] || touch.accel, brake: keys[down] || false, drift: keys[' '] || touch.drift, boost: keys['shift'] || touch.boost };
  }

  function handlePlayer(input, dt) {
    const seg = findSegment(game.pos.z);
    game.pos.x -= seg.curve * game.speed * dt * 0.0016;
    game.pos.x += input.steer * dt * (1 + game.speed * 0.0025);
    if (input.accel) game.speed += CONFIG.accel * dt;
    if (input.brake) game.speed -= CONFIG.brake * dt;
    if (!input.accel && !input.brake) game.speed -= CONFIG.accel * 0.4 * dt;
    game.speed = clamp(game.speed, 0, CONFIG.maxSpeed);
    if (Math.abs(game.pos.x) > 1) game.speed *= CONFIG.offroad;
    if (seg.hazard) { game.heat += CONFIG.heatLava * dt; addCombo(0.05); }
    if (seg.boost) { game.speed = clamp(game.speed + CONFIG.boostForce * 0.35 * dt, 0, CONFIG.maxSpeed * 1.3); game.boost = clamp(game.boost + 18 * dt, 0, 100); }

    if (input.drift) { game.driftMeter = clamp(game.driftMeter + Math.abs(input.steer) * CONFIG.driftGain * dt, 0, 100); addCombo(0.05); addSmoke(); game.heat += CONFIG.heatGain * 0.4 * dt; }
    else if (game.driftMeter > 5) { game.boost = clamp(game.boost + game.driftMeter * 0.6, 0, 100); game.driftMeter = 0; playTone(520, 0.08, 0.1); setToast('Boost charged'); }
    if (input.boost && game.boost > 0 && !game.overheat) { game.speed = clamp(game.speed + CONFIG.boostForce * dt, 0, CONFIG.maxSpeed * 1.2); game.boost = clamp(game.boost - CONFIG.boostDrain * dt, 0, 100); game.heat += CONFIG.heatGain * dt; addFlare(); }

    game.pos.z += game.speed * dt; if (game.pos.z >= game.track.length) game.pos.z -= game.track.length;
    applyHeat(dt);
    game.score += game.speed * 0.12 * dt * game.combo;
    game.comboTimer = Math.max(0, game.comboTimer - dt); if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.25);
    if (!Number.isFinite(game.speed)) game.speed = 0; if (!Number.isFinite(game.pos.x)) game.pos.x = 0;

    // enemy collisions
    for (const e of game.enemies) {
      const dz = wrapZ(e.z - game.pos.z);
      if (Math.abs(dz) < 30) {
        const dx = (e.lane - game.pos.x) * CONFIG.roadWidth * 0.25;
        if (Math.abs(dx) < 120) { bump('enemy'); game.speed *= 0.72; game.heat += 8; }
      }
    }
  }

  function wrapZ(z) { const len = game.track.length; if (z > len / 2) return z - len; if (z < -len / 2) return z + len; return z; }
  function findSegment(z) { const i = Math.floor(z / CONFIG.segmentLength) % game.track.segments.length; return game.track.segments[i]; }
  function applyHeat(dt) { game.heat = clamp(game.heat - CONFIG.heatCool * dt, 0, CONFIG.maxHeat); if (game.heat >= CONFIG.maxHeat && !game.overheat) endRun('Overheated'); }

  /* Enemies */
  function updateEnemies(dt) {
    const adaptive = game.settings.enemyAI === 'adaptive';
    game.mlClock += dt;
    for (const e of game.enemies) {
      const desired = adaptive ? decideML(e) : decideStandard(e);
      e.lane += clamp(desired - e.lane, -0.6, 0.6) * dt * 1.8;
      e.speed = lerp(e.speed, game.speed * 0.9 + 70, 0.2 * dt);
      e.z += e.speed * dt; if (e.z > game.track.length) e.z -= game.track.length;
    }
    if (adaptive && game.mlClock >= 1 / CONFIG.mlUpdateHz) { game.mlClock = 0; updateML(); }
  }

  function decideStandard(e) {
    if (e.type === 'chaser') return clamp(game.pos.x, -1.4, 1.4);
    if (e.type === 'blocker') return clamp(game.pos.x + (Math.random() - 0.5) * 0.4, -1.3, 1.3);
    if (e.type === 'opportunist' && game.pickups[0]) return clamp(game.pickups[0].lane, -1.4, 1.4);
    return 0;
  }

  function stateVector(e) {
    const rel = clamp(e.lane - game.pos.x, -1.6, 1.6);
    const lane = rel < -0.5 ? 'L' : rel > 0.5 ? 'R' : 'C';
    const dist = Math.abs(wrapZ(e.z - game.pos.z));
    const distB = dist < 80 ? 'N' : dist < 200 ? 'M' : 'F';
    const curve = findSegment(e.z).curve;
    const curveB = curve < -0.3 ? 'L' : curve > 0.3 ? 'R' : 'S';
    const speedB = game.speed < 90 ? 'Lo' : game.speed < 170 ? 'Md' : 'Hi';
    const haz = findSegment(e.z).hazard ? 'H' : 'S';
    return `${lane}|${distB}|${curveB}|${speedB}|${haz}`;
  }

  function decideML(e) {
    const s = stateVector(e);
    const table = game.qtable[s] || {};
    let best = 'hold', bestVal = -1e9;
    for (const a of ACTIONS) { const v = table[a] ?? 0; if (v > bestVal) { bestVal = v; best = a; } }
    if (Math.random() < CONFIG.mlEps) best = pick(ACTIONS);
    e.action = best;
    if (best === 'left') return e.lane - 0.4;
    if (best === 'right') return e.lane + 0.4;
    if (best === 'ram') return game.pos.x;
    if (best === 'pickup' && game.pickups[0]) return game.pickups[0].lane;
    return e.lane;
  }

  function updateML() {
    for (const e of game.enemies) {
      const s = stateVector(e);
      const table = game.qtable[s] || {};
      const prev = table[e.action] ?? 0;
      const reward = computeReward(e);
      const next = Math.max(...ACTIONS.map(a => table[a] ?? 0));
      table[e.action] = prev + CONFIG.mlAlpha * (reward + CONFIG.mlGamma * next - prev);
      game.qtable[s] = table;
    }
    saveJSON(QTABLE_KEY, game.qtable);
  }

  function computeReward(e) {
    let r = 0.02;
    const dz = Math.abs(wrapZ(e.z - game.pos.z)); if (dz < 60) r += 0.2;
    if (Math.abs(e.lane) > 1.3) r -= 0.05;
    if (findSegment(e.z).hazard) r -= 0.1;
    return r;
  }

  /* Pickups */
  function updatePickups(dt) {
    for (const p of game.pickups) {
      const dz = wrapZ(p.z - game.pos.z);
      if (Math.abs(dz) < 30 && Math.abs(p.lane - game.pos.x) < 0.25) collectPickup(p);
    }
    game.pickupTimer -= dt;
    if (game.pickupTimer <= 0 && game.pickups.length < 4) { spawnPickup(); game.pickupTimer = CONFIG.pickupInterval; }
    game.pickups = game.pickups.filter(p => p.z <= game.track.length);
  }

  function spawnPickup() {
    let z = game.pos.z + 200 + rand(800); if (z > game.track.length) z -= game.track.length;
    game.pickups.push({ z, lane: (rand(1) - 0.5) * 1.4, type: pick(['coin', 'cool', 'cell', 'shield']) });
  }

  function collectPickup(p) {
    if (p.type === 'coin') { game.score += 120 * game.combo; addCombo(0.4); }
    if (p.type === 'cool') game.heat = Math.max(0, game.heat - 30);
    if (p.type === 'cell') game.boost = clamp(game.boost + 40, 0, 100);
    if (p.type === 'shield') { game.speed += 20; game.heat = Math.max(0, game.heat - 12); }
    p.z = Infinity; playTone(640, 0.05, 0.1);
  }

  /* Particles */
  function addSmoke() { if (!QUALITY[game.settings.gfx].particles) return; game.particles.push({ life: 0.5, max: 0.5, kind: 'smoke' }); }
  function addFlare() { if (!QUALITY[game.settings.gfx].particles) return; game.particles.push({ life: 0.4, max: 0.4, kind: 'flare' }); }
  function updateParticles(dt) { for (let i = game.particles.length - 1; i >= 0; i--) { game.particles[i].life -= dt; if (game.particles[i].life <= 0) game.particles.splice(i, 1); } }

  /* Laps */
  function handleLap() {
    const def = TRACKS[game.mapIndex];
    const nearStart = game.pos.z <= CONFIG.segmentLength * 2 || game.pos.z >= game.track.length - CONFIG.segmentLength * 2;
    if (nearStart && !game.lapGate && game.speed > 10) {
      if (game.state === STATE.PLAYING && def.laps !== Infinity) { game.lap += 1; game.score += 300 * game.lap; setToast('Lap ' + game.lap); if (game.lap > def.laps) endRun('Finished'); }
      game.lapGate = true;
    }
    if (!nearStart) game.lapGate = false;
  }

  /* HUD */
  function updateHUD() {
    hudSpeed.textContent = (game.speed | 0);
    hudScore.textContent = game.score.toFixed(0);
    hudCombo.textContent = `x${game.combo.toFixed(1)}`;
    hudLap.textContent = `${game.lap}/${TRACKS[game.mapIndex].laps === Infinity ? 'INF' : TRACKS[game.mapIndex].laps} · ${game.time.toFixed(1)}s`;
    heatBar.style.width = `${(game.heat / CONFIG.maxHeat) * 100}%`;
    driftBar.style.width = `${game.driftMeter}%`;
    boostBar.style.width = `${game.boost}%`;
  }

  /* Rendering */
  function render() {
    if (!game.track) return;
    const w = viewW, h = viewH;
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    renderRoad(w, h);
    renderPickups(w, h);
    renderProps(w, h);
    renderEnemies(w, h);
    renderPlayer(w, h);
    renderParticles(w, h);
    if (game.debug) renderDebug(w, h);
  }

  function cameraObj(base) {
    const shakeX = (Math.random() - 0.5) * game.camera.shake * 0.6;
    const shakeY = (Math.random() - 0.5) * game.camera.shake * 0.3;
    return {
      x: game.pos.x * CONFIG.roadWidth + shakeX,
      y: CONFIG.cameraHeight + base.y + shakeY,
      z: game.pos.z - 320,
      depth: CONFIG.cameraDepth * (1 + game.speed / 900),
    };
  }

  function project(x, y, z, camera, w, h) {
    const dz = z - camera.z; if (dz <= 0.1) return null;
    const scale = camera.depth / dz;
    return { x: (1 + scale * (x - camera.x)) * w / 2, y: (1 - scale * (y - camera.y)) * h / 2, scale };
  }

  function renderRoad(w, h) {
    const base = findSegment(game.pos.z);
    const cam = cameraObj(base);
    let x = 0, dx = 0;
    for (let n = 0; n < CONFIG.drawSegments; n++) {
      const seg = game.track.segments[(base.index + n) % game.track.segments.length];
      const z1 = seg.z - game.pos.z, z2 = z1 + CONFIG.segmentLength;
      const p1 = project(x, seg.y, z1, cam, w, h); x += dx; dx += seg.curve * 0.5;
      const p2 = project(x, seg.y, z2, cam, w, h); if (!p1 || !p2) continue;
      ctx.fillStyle = seg.color; drawQuad(p1, p2);
      ctx.fillStyle = (seg.index % 2 === 0) ? '#1f2a44' : '#111827'; drawQuad(scaleEdge(p1, 0.94), scaleEdge(p2, 0.94));
      if (seg.hazard) { ctx.fillStyle = 'rgba(255,96,48,0.4)'; drawQuad(scaleEdge(p1, 0.4), scaleEdge(p2, 0.4)); }
      if (seg.boost) { ctx.fillStyle = 'rgba(255,210,80,0.6)'; drawQuad(scaleEdge(p1, 0.2), scaleEdge(p2, 0.2)); }
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.moveTo(w / 2 + (p1.x - w / 2) * 0.02, p1.y); ctx.lineTo(w / 2 + (p2.x - w / 2) * 0.02, p2.y); ctx.stroke();
    }
    game.camera.shake *= 0.9;
  }

  function scaleEdge(p, m) { return { ...p, x: p.x * m, scale: p.scale * m }; }
  function drawQuad(p1, p2) {
    const rw1 = p1.scale * CONFIG.roadWidth * 0.5, rw2 = p2.scale * CONFIG.roadWidth * 0.5;
    ctx.beginPath();
    ctx.moveTo(p1.x - rw1, p1.y); ctx.lineTo(p1.x + rw1, p1.y);
    ctx.lineTo(p2.x + rw2, p2.y); ctx.lineTo(p2.x - rw2, p2.y);
    ctx.closePath(); ctx.fill();
  }

  function renderPlayer(w, h) {
    const carW = 36, carH = 70, x = w / 2, y = h * 0.72;
    ctx.fillStyle = '#45f0b6'; roundRect(x - carW / 2, y - carH / 2, carW, carH, 10, true);
    ctx.fillStyle = '#0c1320'; ctx.fillRect(x - carW * 0.35, y - carH * 0.35, carW * 0.7, carH * 0.7);
    if (QUALITY[game.settings.gfx].lines && game.speed > 140) { ctx.strokeStyle = 'rgba(69,240,182,0.3)'; ctx.beginPath(); ctx.moveTo(x, y + carH / 2); ctx.lineTo(x, y + carH / 2 + 30); ctx.stroke(); }
  }

  function renderEnemies(w, h) {
    const cam = cameraObj(findSegment(game.pos.z));
    for (const e of game.enemies) {
      const seg = findSegment(e.z);
      const p = project(e.lane * CONFIG.roadWidth, seg.y, e.z - game.pos.z, cam, w, h); if (!p) continue;
      const s = 26 * p.scale * 40;
      ctx.fillStyle = e.type === 'blocker' ? '#ff9f40' : e.type === 'opportunist' ? '#7bdcff' : '#f5597b';
      roundRect(p.x - s * 0.5, p.y - s, s, s * 1.4, 6, true);
    }
  }

  function renderPickups(w, h) {
    const cam = cameraObj(findSegment(game.pos.z));
    for (const p of game.pickups) {
      const seg = findSegment(p.z);
      const pr = project(p.lane * CONFIG.roadWidth, seg.y, p.z - game.pos.z, cam, w, h); if (!pr) continue;
      const r = 12 * pr.scale * 40;
      ctx.fillStyle = p.type === 'cool' ? '#7bdcff' : p.type === 'cell' ? '#ff9f40' : p.type === 'shield' ? '#b3ff74' : '#ffd166';
      ctx.beginPath(); ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function renderProps(w, h) {
    const cam = cameraObj(findSegment(game.pos.z));
    for (let i = 0; i < CONFIG.drawSegments; i += 8) {
      const seg = game.track.segments[(findSegment(game.pos.z).index + i) % game.track.segments.length];
      if (!seg.prop) continue;
      const offset = (seg.prop === 'rock' ? -1.6 : 1.6) * CONFIG.roadWidth;
      const p = project(offset, seg.y, seg.z - game.pos.z, cam, w, h); if (!p) continue;
      const size = 28 * p.scale * 40;
      ctx.fillStyle = seg.prop === 'rock' ? '#1f2937' : '#ff9f40';
      ctx.beginPath(); ctx.moveTo(p.x, p.y - size); ctx.lineTo(p.x - size * 0.6, p.y + size * 0.4); ctx.lineTo(p.x + size * 0.6, p.y + size * 0.4); ctx.closePath(); ctx.fill();
    }
  }

  function renderParticles(w, h) {
    if (!QUALITY[game.settings.gfx].particles) return;
    for (const p of game.particles) {
      const alpha = p.life / p.max;
      ctx.fillStyle = p.kind === 'smoke' ? `rgba(255,255,255,${alpha * 0.2})` : `rgba(255,140,90,${alpha * 0.4})`;
      ctx.beginPath(); ctx.arc(w / 2 + rand(10) - 5, h * 0.8 + rand(6) - 3, 8 * alpha, 0, Math.PI * 2); ctx.fill();
    }
  }

  function roundRect(x, y, w, h, r, fill) {
    const rr = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r;
    ctx.beginPath();
    ctx.moveTo(x + rr.tl, y);
    ctx.lineTo(x + w - rr.tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr.tr);
    ctx.lineTo(x + w, y + h - rr.br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr.br, y + h);
    ctx.lineTo(x + rr.bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr.bl);
    ctx.lineTo(x, y + rr.tl);
    ctx.quadraticCurveTo(x, y, x + rr.tl, y);
    ctx.closePath();
    if (fill) ctx.fill();
  }

  function renderDebug(w, h) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(10, 10, 210, 120);
    ctx.fillStyle = '#fff'; ctx.font = '12px monospace';
    const lines = [
      `fps ${game.fps.toFixed(0)} dt ${lastDt.toFixed(3)}`,
      `spd ${game.speed.toFixed(1)} steer ${game.pos.x.toFixed(2)}`,
      `heat ${game.heat.toFixed(1)} drift ${game.driftMeter.toFixed(1)}`,
      `boost ${game.boost.toFixed(1)} combo ${game.combo.toFixed(1)}`,
      `AI ${game.settings.enemyAI} enemies ${game.enemies.length}`,
      `track ${TRACKS[game.mapIndex].id}`,
    ];
    lines.forEach((t, i) => ctx.fillText(t, 16, 28 + i * 14));
  }

  /* End run */
  function endRun(reason) {
    game.state = STATE.OVER;
    show(el('#gameoverOverlay'));
    el('#gameoverTitle').textContent = reason;
    el('#gameoverStats').textContent = `Score ${game.score.toFixed(0)} · Lap ${game.lap} · Time ${game.time.toFixed(1)}s`;
    const id = TRACKS[game.mapIndex].id;
    if ((game.bests[id] || 0) < game.score) { game.bests[id] = game.score; saveJSON(BEST_KEY, game.bests); setToast('New best!'); }
  }

  /* Helpers */
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function setToast(msg) { toast.textContent = msg; toast.classList.add('show'); clearTimeout(setToast.tid); setToast.tid = setTimeout(() => toast.classList.remove('show'), 1200); }
  function toggleDebug() { game.debug = !game.debug; setToast(game.debug ? 'Debug on (~)' : 'Debug off'); }
  function toggleFullscreen() { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); else document.exitFullscreen().catch(() => {}); }

  function setupTouch() {
    const controls = el('#touchControls');
    const isMobile = matchMedia('(pointer: coarse)').matches;
    controls.classList.toggle('hidden', !isMobile);
    el('#touchDrift').addEventListener('touchstart', () => touch.drift = true);
    el('#touchDrift').addEventListener('touchend', () => touch.drift = false);
    el('#touchBoost').addEventListener('touchstart', () => { touch.boost = true; touch.accel = true; });
    el('#touchBoost').addEventListener('touchend', () => { touch.boost = false; touch.accel = false; });
    const steer = el('#touchSteer');
    const move = e => { const rect = steer.getBoundingClientRect(); const x = e.touches[0].clientX - rect.left; const c = (x / rect.width) - 0.5; touch.left = c < -0.1; touch.right = c > 0.1; };
    steer.addEventListener('touchstart', move); steer.addEventListener('touchmove', move); steer.addEventListener('touchend', () => { touch.left = touch.right = false; });
  }

  function drawPreview() {
    const ctxp = mapPreview.getContext('2d'); ctxp.clearRect(0, 0, mapPreview.width, mapPreview.height); ctxp.fillStyle = '#0c1320'; ctxp.fillRect(0, 0, mapPreview.width, mapPreview.height);
    const def = TRACKS[game.mapIndex]; const sections = def.procedural ? buildProceduralSections() : def.sections;
    let x = mapPreview.width / 2, y = mapPreview.height - 10; ctxp.strokeStyle = '#45f0b6'; ctxp.beginPath(); ctxp.moveTo(x, y);
    sections.forEach(sec => { for (let i = 0; i < sec.len; i++) { x += sec.curve * 1.2; y -= 1; ctxp.lineTo(x, y); } }); ctxp.stroke();
  }

  // start
  init();
})();
