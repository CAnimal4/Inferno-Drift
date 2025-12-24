/*
InfernoDrift2 — static Three.js open-arena racer (no build)
Run: any static server (e.g. `python -m http.server`) then open http://localhost:8000
Controls: Desktop W/A/S/D or Arrows throttle/steer, Space drift (charge), Shift boost, F fullscreen, Esc pause, ~ debug.
Mobile: steer with left pad, Drift hold then Boost tap (also accelerates), pause via on-screen button.
Maps: see MAPS; each is an arena {size, hazards[], boosts[], props[]} and preview is auto-drawn. Add entries to MAPS to create more arenas.
Toggles: fullscreen button or F, gfx setting (high/med/low), debug (~). Click/tap once to focus for input capture.
ENGINE CHOICE: Option A — Three.js real 3D (vendored) chosen; rewritten to open-world arena with chase bots.
BASELINE AUDIT (before fixes):
- Render loop crashed because drawPreview was missing; nothing started. Fixed with deterministic boot + error surface.
- Input/focus: no focus gate, overlays captured keys. Added click/tap focus overlay + canvas focus/tap to capture keys.
- Canvas/DPR: single resize path with DPR clamp.
- Gameplay: previous track-based lane system prevented steering; replaced with free-move yaw/velocity model and pursuit AI.
*/

(() => {
  'use strict';

  /* Helpers */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)] || arr[0];

  /* Config */
  const CFG = {
    dtMax: 0.05,
    accel: 230,
    brake: 260,
    drag: 0.14,
    coastDrag: 0.08,
    steer: 2.2,
    steerDrift: 3.0,
    lateralDamp: 7,
    driftGain: 30,
    boostGain: 0.75,
    boostForce: 620,
    boostDrain: 40,
    boostImpulse: 140,
    maxSpeed: 360,
    offroadPenalty: 0.5,
    heatGainDrift: 20,
    heatGainBoost: 28,
    heatGainHazard: 55,
    heatCool: 16,
    overheatDuration: 2.8,
    pickupInterval: 7,
    rivalInterval: 5,
    rivalMax: 6,
    pickupMax: 6,
    pickupRange: 11,
    arenaBounce: 0.45,
    dprCap: 2,
    cameraLag: 0.12,
    cameraHeight: 6.2,
    cameraBack: 12.5,
    fovBase: 70,
    fovBoost: 10,
  };

  /* Maps (arenas) */
  const MAPS = [
    {
      id: 'crater',
      name: 'Ember Crater',
      desc: 'Compact bowl with central lava and outer boost rings.',
      difficulty: 'Easy',
      size: 420,
      hazards: [{ x: 0, z: 0, r: 90 }, { x: -160, z: 130, r: 60 }],
      boosts: [{ x: 160, z: -140, r: 60 }, { x: -200, z: -120, r: 50 }],
    },
    {
      id: 'ridge',
      name: 'Ridge Flats',
      desc: 'Long sightlines, staggered lava pools, chase-friendly.',
      difficulty: 'Medium',
      size: 520,
      hazards: [{ x: -120, z: 40, r: 70 }, { x: 140, z: 160, r: 80 }, { x: 60, z: -200, r: 60 }],
      boosts: [{ x: -220, z: -180, r: 60 }, { x: 230, z: 60, r: 60 }],
    },
    {
      id: 'switch',
      name: 'Switchyard',
      desc: 'Narrow corridors cut by lava grates and boost lanes.',
      difficulty: 'Hard',
      size: 360,
      hazards: [{ x: -60, z: 0, r: 60 }, { x: 80, z: -100, r: 70 }, { x: 90, z: 120, r: 60 }],
      boosts: [{ x: -180, z: -140, r: 50 }, { x: 190, z: 100, r: 40 }],
    },
    {
      id: 'dunes',
      name: 'Shifting Dunes',
      desc: 'Wide-open drift pad with scattered lava pockets.',
      difficulty: 'Medium',
      size: 640,
      hazards: [{ x: -200, z: 80, r: 80 }, { x: 220, z: -120, r: 90 }, { x: 0, z: 220, r: 100 }],
      boosts: [{ x: -280, z: -260, r: 80 }, { x: 280, z: 260, r: 80 }],
    },
    {
      id: 'spire',
      name: 'Spire Garden',
      desc: 'Clustered pillars, tight turns, lots of cover.',
      difficulty: 'Technical',
      size: 420,
      hazards: [{ x: -140, z: -40, r: 70 }, { x: 60, z: 140, r: 70 }],
      boosts: [{ x: 160, z: -160, r: 60 }, { x: -200, z: 140, r: 50 }],
    },
    {
      id: 'endless',
      name: 'Endless Yard',
      desc: 'Large playground for endless chase and score farming.',
      difficulty: 'Endless',
      size: 760,
      hazards: [{ x: 0, z: 0, r: 120 }, { x: 260, z: -200, r: 120 }, { x: -260, z: 200, r: 120 }],
      boosts: [{ x: -360, z: -260, r: 90 }, { x: 360, z: 260, r: 90 }],
    },
  ];

  /* Perks */
  const PERKS = [
    { id: 'cool', name: 'Cryo Lines', desc: 'Heat decay +25%.', apply: g => g.mod.coolRate *= 1.25 },
    { id: 'grip', name: 'Grip Gel', desc: 'Grip up, off-road hurts less.', apply: g => { g.mod.grip *= 1.12; g.mod.offroadResist += 0.15; } },
    { id: 'boost', name: 'Ion Boost', desc: 'Boost gain +20%, drain -10%.', apply: g => { g.mod.boostGain *= 1.2; g.mod.boostDrain *= 0.9; } },
    { id: 'shield', name: 'Phase Shield', desc: 'Start with one shield hit.', apply: g => { g.mod.shield = true; } },
    { id: 'magnet', name: 'Pick Magnet', desc: 'Pickups pull from farther.', apply: g => { g.mod.pickRange *= 1.4; } },
    { id: 'resist', name: 'Lava Skin', desc: 'Hazard heat -30%.', apply: g => { g.mod.hazardResist *= 0.7; } },
  ];

  /* DOM refs */
  const ui = {};
  const world = { arenaGroup: null, hazardMeshes: [], boostMeshes: [], props: null, hazardLights: [] };
  let renderer, scene, camera;
  let playerMesh, playerShadow;
  const rivalPool = [];
  const pickupPool = [];
  const activeRivals = [];
  const activePickups = [];
  const keys = {};
  const touch = { left: false, right: false, accel: false, drift: false, boost: false };
  const debugBox = document.createElement('div');
  const tone = { ctx: null };

  /* Game state */
  const STORAGE_KEYS = {
    settings: 'infernodrift2-settings',
    scores: 'infernodrift2-scores',
    perk: 'infernodrift2-perk',
  };

  const game = {
    state: 'menu',
    mode: 'player',
    settings: loadSettings(),
    scores: loadScores(),
    mapIndex: 0,
    map: MAPS[0],
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0,
    yawVel: 0,
    speed: 0,
    drift: 0,
    boost: 0,
    boostPulse: 0,
    heat: 0,
    overheat: 0,
    combo: 1,
    comboTimer: 0,
    score: 0,
    runTime: 0,
    last: 0,
    fps: 0,
    pickupTimer: CFG.pickupInterval,
    rivalTimer: CFG.rivalInterval,
    drifting: false,
    perk: loadPerk(),
    mod: defaultMods(),
    autopilotTime: 0,
    focusCaptured: false,
  };

  /* Boot */
  document.addEventListener('DOMContentLoaded', () => {
    try { boot(); } catch (err) { fatal(err); }
  });

  function boot() {
    cacheDom();
    buildDebugBox();
    if (!window.THREE) throw new Error('Three.js not found (vendor/three.min.js)');
    initRenderer();
    initScene();
    initPools();
    bindUI();
    buildMapList();
    selectMap(game.mapIndex);
    setupInput();
    setupTouch();
    setupFocusGate();
    resize();
    window.addEventListener('resize', resize);
    startLoop();
  }

  function cacheDom() {
    ui.canvas = document.querySelector('#gameCanvas');
    ui.hud = document.querySelector('#hud');
    ui.hudSpeed = document.querySelector('#hudSpeed');
    ui.hudScore = document.querySelector('#hudScore');
    ui.hudCombo = document.querySelector('#hudCombo');
    ui.hudLap = document.querySelector('#hudLap');
    ui.heatBar = document.querySelector('#heatBar');
    ui.driftBar = document.querySelector('#driftBar');
    ui.boostBar = document.querySelector('#boostBar');
    ui.toast = document.querySelector('#toast');
    ui.mapList = document.querySelector('#mapList');
    ui.mapPreview = document.querySelector('#mapPreview');
    ui.mapName = document.querySelector('#mapName');
    ui.mapDesc = document.querySelector('#mapDesc');
    ui.menuPanel = document.querySelector('#menuPanel');
    ui.pauseOverlay = document.querySelector('#pauseOverlay');
    ui.gameoverOverlay = document.querySelector('#gameoverOverlay');
    ui.settingsOverlay = document.querySelector('#settingsOverlay');
    ui.helpOverlay = document.querySelector('#helpOverlay');
    ui.upgradeGrid = document.querySelector('#upgradeGrid');
    ui.touchControls = document.querySelector('#touchControls');
    ui.focusGate = document.querySelector('#focusGate');
    ui.errorOverlay = document.querySelector('#errorOverlay');
    ui.errorTitle = document.querySelector('#errorTitle');
    ui.errorBody = document.querySelector('#errorBody');
  }

  function buildDebugBox() {
    debugBox.id = 'debugPanel';
    Object.assign(debugBox.style, {
      position: 'fixed',
      top: '10px',
      left: '10px',
      padding: '10px 12px',
      background: 'rgba(8,11,20,0.76)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '10px',
      font: '12px monospace',
      color: '#e7f3ff',
      zIndex: '60',
      display: 'none',
      whiteSpace: 'pre',
    });
    document.body.appendChild(debugBox);
  }

  function defaultMods() {
    return { coolRate: 1, grip: 1, boostGain: 1, boostDrain: 1, hazardResist: 1, offroadResist: 0, pickRange: 1, shield: false };
  }

  function loadSettings() {
    try { return { sound: 'on', gfx: 'high', controls: 'wasd', enemyAI: 'standard', ...(JSON.parse(localStorage.getItem(STORAGE_KEYS.settings)) || {}) }; }
    catch { return { sound: 'on', gfx: 'high', controls: 'wasd', enemyAI: 'standard' }; }
  }
  function saveSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(game.settings)); }
  function loadScores() { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.scores)) || {}; } catch { return {}; } }
  function saveScores() { localStorage.setItem(STORAGE_KEYS.scores, JSON.stringify(game.scores)); }
  function loadPerk() { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.perk)) || null; } catch { return null; } }
  function savePerk() { if (game.perk) localStorage.setItem(STORAGE_KEYS.perk, JSON.stringify(game.perk)); else localStorage.removeItem(STORAGE_KEYS.perk); }

  /* Renderer & Scene */
  function initRenderer() {
    renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    camera = new THREE.PerspectiveCamera(CFG.fovBase, window.innerWidth / window.innerHeight, 0.1, 3000);
    camera.position.set(0, CFG.cameraHeight, CFG.cameraBack);
    camera.lookAt(0, 0, 0);
  }

  function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04070f);
    scene.fog = new THREE.Fog(0x04070f, 50, 1200);
    const hemi = new THREE.HemisphereLight(0x7fb9ff, 0x0a0c16, 0.9);
    const sun = new THREE.DirectionalLight(0xfff1d0, 0.9);
    sun.position.set(160, 260, -160);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -240;
    sun.shadow.camera.right = 240;
    sun.shadow.camera.top = 240;
    sun.shadow.camera.bottom = -240;
    scene.add(hemi, sun);

    world.arenaGroup = new THREE.Group();
    scene.add(world.arenaGroup);
  }

  function initPools() {
    playerMesh = buildCar(0x7cf0d8, 0x102922);
    playerShadow = buildShadow();
    scene.add(playerMesh, playerShadow);

    for (let i = 0; i < 10; i++) { const m = buildCar(0xff6b74, 0x2a0f14); m.visible = false; scene.add(m); rivalPool.push(m); }

    const pickupGeo = new THREE.OctahedronGeometry(0.7);
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(pickupGeo, new THREE.MeshStandardMaterial({ color: 0xffd15a, emissive: 0x7a4c1f, roughness: 0.35, metalness: 0.2 }));
      m.visible = false; m.castShadow = true; scene.add(m); pickupPool.push(m);
    }
  }

  function buildCar(color, accent) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.65, 3), new THREE.MeshStandardMaterial({ color, emissive: accent, roughness: 0.4, metalness: 0.2 }));
    body.castShadow = true; body.receiveShadow = true; g.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.55, 1.2), new THREE.MeshStandardMaterial({ color: 0x0c1320, emissive: 0x0c1320, roughness: 0.6 }));
    cab.position.set(0, 0.55, -0.05); cab.castShadow = true; g.add(cab);
    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.5, 12); wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111, roughness: 0.8 });
    [[0.75, -0.3, 1], [-0.75, -0.3, 1], [0.75, -0.3, -1], [-0.75, -0.3, -1]].forEach(o => {
      const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(o[0], o[1], o[2]); w.castShadow = true; g.add(w);
    });
    return g;
  }

  function buildShadow() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 1.8), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = -1;
    mesh.receiveShadow = false;
    return mesh;
  }

  /* UI */
  function bindUI() {
    document.querySelector('#startBtn').addEventListener('click', () => startRun('player'));
    document.querySelector('#resumeBtn').addEventListener('click', resumeGame);
    document.querySelector('#watchDemo').addEventListener('click', () => startRun('demo'));
    document.querySelector('#openHelp').addEventListener('click', () => show(ui.helpOverlay));
    document.querySelector('#closeHelp').addEventListener('click', () => hide(ui.helpOverlay));
    document.querySelector('#openSettings').addEventListener('click', () => {
      document.querySelector('#settingSound').value = game.settings.sound;
      document.querySelector('#settingGfx').value = game.settings.gfx;
      document.querySelector('#settingControls').value = game.settings.controls;
      show(ui.settingsOverlay);
    });
    document.querySelector('#closeSettings').addEventListener('click', () => {
      game.settings.sound = document.querySelector('#settingSound').value;
      game.settings.gfx = document.querySelector('#settingGfx').value;
      game.settings.controls = document.querySelector('#settingControls').value;
      saveSettings();
      hide(ui.settingsOverlay);
    });
    document.querySelector('#resetAI').addEventListener('click', () => { game.scores = {}; saveScores(); game.perk = null; savePerk(); setToast('Progress reset'); });
    document.querySelector('#resumePlay').addEventListener('click', resumeGame);
    document.querySelector('#restartPlay').addEventListener('click', () => startRun(game.mode));
    document.querySelector('#backToMenu').addEventListener('click', gotoMenu);
    document.querySelector('#playAgain').addEventListener('click', () => startRun('player'));
    document.querySelector('#menuReturn').addEventListener('click', gotoMenu);
    document.querySelector('#toggleFull').addEventListener('click', toggleFullscreen);
    document.querySelector('#pauseBtn').addEventListener('click', pauseGame);
    document.querySelector('#errorClose').addEventListener('click', () => hide(ui.errorOverlay));
  }

  function buildMapList() {
    ui.mapList.innerHTML = '';
    MAPS.forEach((m, idx) => {
      const card = document.createElement('button');
      card.className = 'map-card';
      card.innerHTML = `<div class="name">${m.name}</div><div class="muted tiny">${m.desc}</div><div class="muted tiny">${m.difficulty} · Arena</div>`;
      card.addEventListener('click', () => selectMap(idx));
      ui.mapList.appendChild(card);
    });
  }

  function selectMap(idx) {
    game.mapIndex = idx;
    game.map = MAPS[idx];
    document.querySelectorAll('.map-card').forEach((c, i) => c.classList.toggle('active', i === idx));
    ui.mapName.textContent = MAPS[idx].name;
    ui.mapDesc.textContent = MAPS[idx].desc;
    drawPreview();
  }

  function setupInput() {
    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      keys[k] = true;
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (e.key === '~') toggleDebug();
      if (k === 'f') toggleFullscreen();
      if (e.key === 'Escape') handleEscape();
    });
    window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  }

  function setupTouch() {
    const steer = document.querySelector('#touchSteer');
    const driftBtn = document.querySelector('#touchDrift');
    const boostBtn = document.querySelector('#touchBoost');
    const isMobile = matchMedia('(pointer: coarse)').matches;
    ui.touchControls.classList.toggle('hidden', !isMobile);
    const move = e => {
      const r = steer.getBoundingClientRect();
      const x = e.touches[0].clientX - r.left;
      const c = (x / r.width) - 0.5;
      touch.left = c < -0.12; touch.right = c > 0.12;
      touch.accel = true;
    };
    steer.addEventListener('touchstart', move); steer.addEventListener('touchmove', move);
    steer.addEventListener('touchend', () => { touch.left = touch.right = false; touch.accel = false; });
    driftBtn.addEventListener('touchstart', () => touch.drift = true);
    driftBtn.addEventListener('touchend', () => touch.drift = false);
    boostBtn.addEventListener('touchstart', () => { touch.boost = true; touch.accel = true; });
    boostBtn.addEventListener('touchend', () => { touch.boost = false; touch.accel = false; });
  }

  function setupFocusGate() {
    const capture = () => focusCanvas();
    ui.focusGate?.addEventListener('click', capture);
    ui.canvas.addEventListener('pointerdown', capture);
  }

  function focusCanvas() {
    if (!ui.canvas) return;
    ui.canvas.tabIndex = 0;
    ui.canvas.focus({ preventScroll: true });
    game.focusCaptured = true;
    hide(ui.focusGate);
  }

  /* Game flow */
  function toggleFullscreen() { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); else document.exitFullscreen().catch(() => {}); }
  function toggleDebug() { game.debug = !game.debug; debugBox.style.display = game.debug ? 'block' : 'none'; setToast(game.debug ? 'Debug on (~)' : 'Debug off'); }
  function handleEscape() { if (game.state === 'playing') pauseGame(); else if (game.state === 'paused') resumeGame(); }
  function pauseGame() { if (game.state === 'playing') { game.state = 'paused'; show(ui.pauseOverlay); } }
  function resumeGame() { if (game.state === 'paused') { game.state = 'playing'; hide(ui.pauseOverlay); focusCanvas(); } }
  function gotoMenu() { game.state = 'menu'; show(ui.menuPanel); hide(ui.pauseOverlay); hide(ui.gameoverOverlay); ui.hud?.classList.add('hidden'); document.querySelector('#resumeBtn').disabled = true; }

  function startRun(mode) {
    hide(ui.menuPanel); hide(ui.gameoverOverlay); hide(ui.pauseOverlay);
    game.mode = mode === 'demo' ? 'attract' : 'player';
    game.state = mode === 'demo' ? 'attract' : 'playing';
    game.pos.set(0, 0, 0);
    game.vel.set(0, 0, 0);
    game.yaw = 0; game.yawVel = 0;
    game.speed = 0; game.drift = 0; game.boost = 0; game.boostPulse = 0; game.heat = 0; game.overheat = 0; game.combo = 1; game.comboTimer = 0; game.score = 0; game.runTime = 0;
    game.pickupTimer = CFG.pickupInterval; game.rivalTimer = CFG.rivalInterval; game.autopilotTime = 0;
    game.mod = defaultMods();
    if (game.perk) applyPerk(game.perk);
    buildArena(game.map);
    ui.hud.classList.remove('hidden');
    document.querySelector('#resumeBtn').disabled = false;
    if (!game.focusCaptured) show(ui.focusGate);
    focusCanvas();
    setToast(mode === 'demo' ? 'Attract loop' : 'Drive!');
  }

  function applyPerk(perk) {
    if (!perk) return;
    const p = PERKS.find(p => p.id === perk.id) || perk;
    try { p.apply(game); } catch { /* ignore */ }
  }

  /* Arena build */
  function buildArena(def) {
    if (world.arenaGroup) { scene.remove(world.arenaGroup); world.arenaGroup = new THREE.Group(); scene.add(world.arenaGroup); }
    world.hazardMeshes = []; world.boostMeshes = [];
    world.hazardLights?.forEach(l => scene.remove(l)); world.hazardLights = [];

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.9, metalness: 0.05 });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(def.size * 1.4, 64), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    world.arenaGroup.add(ground);

    const edgeGeo = new THREE.RingGeometry(def.size * 0.98, def.size * 1.02, 64);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x445, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
    const edge = new THREE.Mesh(edgeGeo, edgeMat); edge.rotation.x = -Math.PI / 2; world.arenaGroup.add(edge);

    def.hazards?.forEach(h => {
      const geo = new THREE.CircleGeometry(h.r, 32);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4b0c0c, emissive: 0xd63a25, roughness: 0.6, metalness: 0.1, transparent: true, opacity: 0.85 });
      const mesh = new THREE.Mesh(geo, mat); mesh.rotation.x = -Math.PI / 2; mesh.position.set(h.x, 0.01, h.z); mesh.receiveShadow = true;
      world.arenaGroup.add(mesh); world.hazardMeshes.push({ mesh, data: h });
      const light = new THREE.PointLight(0xff4f36, 0.7, 220); light.position.set(h.x, 18, h.z); scene.add(light); world.hazardLights.push(light);
    });

    def.boosts?.forEach(b => {
      const geo = new THREE.RingGeometry(b.r * 0.6, b.r, 32);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffd15a, emissive: 0xb06500, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(geo, mat); mesh.rotation.x = -Math.PI / 2; mesh.position.set(b.x, 0.015, b.z); mesh.receiveShadow = true;
      world.arenaGroup.add(mesh); world.boostMeshes.push({ mesh, data: b });
    });

    const propGeo = new THREE.ConeGeometry(2, 9, 6);
    const propMat = new THREE.MeshStandardMaterial({ color: 0x7cf0d8, emissive: 0x1f3a32 });
    const propCount = Math.floor(def.size / 12);
    const props = new THREE.InstancedMesh(propGeo, propMat, propCount);
    const m = new THREE.Matrix4();
    for (let i = 0; i < propCount; i++) {
      const ang = (i / propCount) * Math.PI * 2;
      const dist = def.size * (0.7 + Math.random() * 0.25);
      m.makeTranslation(Math.cos(ang) * dist, 4.5, Math.sin(ang) * dist);
      props.setMatrixAt(i, m);
    }
    world.arenaGroup.add(props);

    activeRivals.length = 0; activePickups.length = 0;
    rivalPool.forEach(m => m.visible = false);
    pickupPool.forEach(m => m.visible = false);
    spawnRival(); spawnRival();
    spawnPickup();
  }

  /* Loop */
  function startLoop() { requestAnimationFrame(tick); }
  function tick(now) {
    const t = now / 1000;
    const dt = Math.min(CFG.dtMax, t - (game.last || t));
    game.last = t;
    if (!Number.isFinite(dt) || dt <= 0) return requestAnimationFrame(tick);
    if (game.state === 'playing' || game.state === 'attract') update(dt);
    render();
    requestAnimationFrame(tick);
  }

  /* Input */
  function readInput() {
    const scheme = game.settings.controls;
    const left = scheme === 'arrows' ? 'arrowleft' : 'a';
    const right = scheme === 'arrows' ? 'arrowright' : 'd';
    const up = scheme === 'arrows' ? 'arrowup' : 'w';
    const down = scheme === 'arrows' ? 'arrowdown' : 's';
    return {
      steer: (keys[left] || touch.left ? -1 : 0) + (keys[right] || touch.right ? 1 : 0),
      accel: keys[up] || touch.accel || false,
      brake: keys[down] || false,
      drift: keys[' '] || touch.drift || false,
      boost: keys['shift'] || touch.boost || false,
    };
  }

  function autoInput(dt) {
    game.autopilotTime += dt;
    return {
      steer: Math.sin(game.autopilotTime * 0.7) * 0.8,
      accel: true,
      brake: false,
      drift: Math.sin(game.autopilotTime * 1.3) > 0.65,
      boost: Math.random() > 0.985,
    };
  }

  /* Update */
  function update(dt) {
    const input = game.state === 'attract' ? autoInput(dt) : readInput();
    game.runTime += dt;
    game.fps = game.fps ? lerp(game.fps, 1 / dt, 0.08) : 1 / dt;

    const forward = new THREE.Vector3(Math.sin(game.yaw), 0, Math.cos(game.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    if (input.accel) game.vel.addScaledVector(forward, CFG.accel * dt);
    if (input.brake) game.vel.addScaledVector(forward, -CFG.brake * dt);

    const steerRate = (input.drift ? CFG.steerDrift : CFG.steer) * (game.overheat > 0 ? 0.6 : 1) * game.mod.grip * (0.8 + game.speed / CFG.maxSpeed);
    game.yawVel = lerp(game.yawVel, input.steer * steerRate, dt * 8);
    game.yaw += game.yawVel * dt;

    const fSpeed = game.vel.dot(forward);
    let side = game.vel.dot(right);
    side = lerp(side, 0, dt * CFG.lateralDamp);
    game.vel.copy(forward.clone().multiplyScalar(fSpeed)).add(right.clone().multiplyScalar(side));

    const baseDrag = CFG.drag + (input.accel ? 0 : CFG.coastDrag);
    game.vel.multiplyScalar(Math.max(0, 1 - baseDrag * dt));
    game.speed = game.vel.length();
    game.speed = clamp(game.speed, 0, CFG.maxSpeed * 1.35);

    if (input.drift) {
      game.drift = clamp(game.drift + CFG.driftGain * dt, 0, 100);
      game.speed *= 0.995;
      game.heat += CFG.heatGainDrift * dt;
      game.drifting = true;
    } else if (game.drifting) {
      if (game.drift > 5) {
        const gain = game.drift * CFG.boostGain * game.mod.boostGain;
        game.boost = clamp(game.boost + gain, 0, 140);
        game.boostPulse = 0.9;
        setToast('Boost charged');
      }
      game.drift = 0;
      game.drifting = false;
    }

    if (input.boost && game.boost > 0) {
      game.vel.addScaledVector(forward, CFG.boostForce * dt);
      game.boost = clamp(game.boost - CFG.boostDrain * dt * game.mod.boostDrain, 0, 140);
      game.heat += CFG.heatGainBoost * dt;
    }
    if (game.boostPulse > 0) { game.vel.addScaledVector(forward, CFG.boostImpulse * dt); game.boostPulse -= dt; }

    game.pos.addScaledVector(game.vel, dt);
    clampToArena(game.map, game.pos, game.vel);

    applyHazards(dt, game.pos);
    applyBoostPads(dt, game.pos, forward);
    applyHeat(dt);

    game.comboTimer = Math.max(0, game.comboTimer - dt);
    if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.2 * dt);
    game.score += (game.speed * 0.08 + (input.drift ? 4 : 0)) * dt * game.combo;

    updatePickups(dt);
    updateRivals(dt);
    updatePlayerMesh(forward);
    updateCamera(forward);
    updateHUD();
  }

  function clampToArena(map, pos, vel) {
    const limit = map.size;
    let bounced = false;
    if (pos.length() > limit) {
      const dir = pos.clone().normalize();
      pos.copy(dir.multiplyScalar(limit * 0.995));
      const ref = vel.clone().reflect(dir);
      vel.copy(ref.multiplyScalar(CFG.arenaBounce));
      game.heat += 6;
      bounced = true;
    }
    if (bounced && game.mod.shield) game.mod.shield = false;
  }

  function applyHazards(dt, pos) {
    game.map.hazards?.forEach(h => {
      const d2 = (pos.x - h.x) ** 2 + (pos.z - h.z) ** 2;
      if (d2 < h.r * h.r) {
        game.heat += CFG.heatGainHazard * dt * game.mod.hazardResist;
        game.vel.multiplyScalar(1 - 0.6 * dt);
      }
    });
  }

  function applyBoostPads(dt, pos, forward) {
    game.map.boosts?.forEach(b => {
      const d2 = (pos.x - b.x) ** 2 + (pos.z - b.z) ** 2;
      if (d2 < b.r * b.r) {
        game.boost = clamp(game.boost + 16 * dt, 0, 140);
        game.vel.addScaledVector(forward, CFG.boostForce * 0.35 * dt);
      }
    });
  }

  function applyHeat(dt) {
    if (game.overheat > 0) game.overheat = Math.max(0, game.overheat - dt);
    game.heat = clamp(game.heat - CFG.heatCool * dt * game.mod.coolRate, 0, 100);
    if (game.heat >= 100 && game.overheat <= 0) {
      game.overheat = CFG.overheatDuration;
      playTone(180, 0.1, 0.12);
      setToast('Overheat! Grip down');
      endRun('Overheated');
    }
  }

  function updatePlayerMesh(forward) {
    playerMesh.position.copy(game.pos);
    playerMesh.position.y = 0.6;
    playerMesh.rotation.y = Math.atan2(forward.x, forward.z);
    if (playerShadow) { playerShadow.position.set(game.pos.x, 0.01, game.pos.z); playerShadow.scale.set(1, 1, 1); }
  }

  function updateCamera(forward) {
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const target = game.pos.clone()
      .addScaledVector(forward, -CFG.cameraBack)
      .addScaledVector(right, 0.4)
      .add(new THREE.Vector3(0, CFG.cameraHeight, 0));
    camera.position.lerp(target, CFG.cameraLag);
    camera.lookAt(game.pos.x, game.pos.y + 1.2, game.pos.z);
    camera.fov = lerp(camera.fov, CFG.fovBase + (game.speed / CFG.maxSpeed) * CFG.fovBoost, 0.12);
    camera.updateProjectionMatrix();
  }

  /* Pickups */
  function updatePickups(dt) {
    game.pickupTimer -= dt;
    if (game.pickupTimer <= 0 && activePickups.length < CFG.pickupMax) { spawnPickup(); game.pickupTimer = CFG.pickupInterval; }
    for (let i = activePickups.length - 1; i >= 0; i--) {
      const p = activePickups[i];
      const pos = p.pos;
      pos.y = 0.8 + Math.sin(game.runTime * 4 + i) * 0.2;
      p.mesh.position.copy(pos);
      p.mesh.rotation.y += dt * 2.6;
      const dist2 = pos.clone().sub(game.pos).lengthSq();
      const pullRange = (CFG.pickupRange * game.mod.pickRange);
      if (dist2 < pullRange * pullRange) {
        if (dist2 < 9) { collectPickup(p); activePickups.splice(i, 1); continue; }
        const dir = game.pos.clone().sub(pos).multiplyScalar(0.05);
        pos.add(dir);
      }
    }
  }

  function spawnPickup() {
    const mesh = pickupPool.find(m => !m.visible);
    if (!mesh || !game.map) return;
    mesh.visible = true;
    let pos;
    for (let tries = 0; tries < 10; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * game.map.size * 0.8;
      pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
      if (!insideHazard(game.map, pos)) break;
    }
    if (!pos) pos = new THREE.Vector3();
    const type = pick(['cool', 'cell', 'shield', 'coin']);
    const colors = { cool: 0x7cf0d8, cell: 0xffd15a, shield: 0x7ab7ff, coin: 0xff9f40 };
    mesh.material.color.setHex(colors[type]); mesh.material.emissive.setHex(colors[type]);
    activePickups.push({ pos, type, mesh });
  }

  function insideHazard(map, pos) {
    return (map.hazards || []).some(h => {
      const d2 = (pos.x - h.x) ** 2 + (pos.z - h.z) ** 2;
      return d2 < h.r * h.r;
    });
  }

  function collectPickup(p) {
    if (p.type === 'cool') game.heat = Math.max(0, game.heat - 28);
    if (p.type === 'cell') game.boost = clamp(game.boost + 45, 0, 140);
    if (p.type === 'shield') { game.mod.shield = true; setToast('Shield ready'); }
    if (p.type === 'coin') { game.score += 180 * game.combo; addCombo(0.5); }
    playTone(520, 0.08, 0.12);
    p.mesh.visible = false;
  }

  /* Rivals */
  function spawnRival() {
    const mesh = rivalPool.find(m => !m.visible);
    if (!mesh || !game.map) return;
    mesh.visible = true;
    const ang = Math.random() * Math.PI * 2;
    const r = game.map.size * (0.4 + Math.random() * 0.4);
    const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    const type = pick(['racer', 'blocker', 'hunter']);
    activeRivals.push({ pos, vel: new THREE.Vector3(), yaw: Math.random() * Math.PI * 2, speed: 0, mesh, type });
  }

  function updateRivals(dt) {
    game.rivalTimer -= dt;
    if (game.rivalTimer <= 0 && activeRivals.length < CFG.rivalMax) { spawnRival(); game.rivalTimer = CFG.rivalInterval; }
    for (let i = activeRivals.length - 1; i >= 0; i--) {
      const r = activeRivals[i];
      const toPlayer = game.pos.clone().sub(r.pos);
      const dir = toPlayer.clone().normalize();
      const side = new THREE.Vector3(dir.z, 0, -dir.x);
      let laneOffset = 0;
      if (r.type === 'blocker') laneOffset = Math.sin(game.runTime * 1.8 + i) * 0.6;
      if (r.type === 'hunter') laneOffset = Math.sin(game.runTime * 3 + i) * 0.2;
      const desiredDir = dir.clone().addScaledVector(side, laneOffset).normalize();
      r.vel.addScaledVector(desiredDir, (120 + Math.random() * 30) * dt);
      r.vel.multiplyScalar(Math.max(0, 1 - 0.12 * dt));
      r.speed = clamp(r.vel.length(), 40, CFG.maxSpeed * 0.9);
      r.pos.addScaledVector(r.vel, dt);
      clampToArena(game.map, r.pos, r.vel);
      r.yaw = Math.atan2(r.vel.x, r.vel.z);
      r.mesh.position.copy(r.pos); r.mesh.position.y = 0.55;
      r.mesh.rotation.y = r.yaw;

      const dz = game.pos.clone().sub(r.pos).length();
      if (dz < 3) {
        if (game.mod.shield) { game.mod.shield = false; setToast('Shield broke'); playTone(260, 0.06, 0.1); }
        else { bump(); }
        r.vel.multiplyScalar(0.6);
      }
    }
  }

  function bump() {
    game.vel.multiplyScalar(0.7);
    game.heat += 8;
    addCombo(-0.5);
    playTone(220, 0.08, 0.14);
  }

  function addCombo(v) { game.combo = clamp(game.combo + v, 1, 9); game.comboTimer = 3; }

  /* HUD & render */
  function render() {
    if (renderer && scene && camera) renderer.render(scene, camera);
    if (game.debug) {
      debugBox.style.display = 'block';
      debugBox.textContent = [
        `fps ${game.fps.toFixed(0)} dt ${(game.fps ? 1 / game.fps : 0).toFixed(3)}`,
        `spd ${game.speed.toFixed(1)} heat ${game.heat.toFixed(1)} drift ${game.drift.toFixed(1)} boost ${game.boost.toFixed(1)}`,
        `pos ${game.pos.x.toFixed(1)},${game.pos.z.toFixed(1)} combo x${game.combo.toFixed(1)}`,
        `map ${MAPS[game.mapIndex].id} rivals ${activeRivals.length} pickups ${activePickups.length}`,
      ].join('\\n');
    } else debugBox.style.display = 'none';
  }

  function updateHUD() {
    ui.hudSpeed.textContent = game.speed.toFixed(0);
    ui.hudScore.textContent = game.score.toFixed(0);
    ui.hudCombo.textContent = `x${game.combo.toFixed(1)}`;
    ui.hudLap.textContent = `${MAPS[game.mapIndex].name} · ${game.runTime.toFixed(1)}s`;
    ui.heatBar.style.width = `${game.heat}%`;
    ui.driftBar.style.width = `${game.drift}%`;
    ui.boostBar.style.width = `${game.boost / 1.4}%`;
  }

  function setToast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(setToast.tid);
    setToast.tid = setTimeout(() => ui.toast.classList.remove('show'), 1400);
  }

  /* End & scores */
  function endRun(reason) {
    if (game.state === 'over') return;
    game.state = 'over';
    show(ui.gameoverOverlay);
    document.querySelector('#gameoverTitle').textContent = reason;
    document.querySelector('#gameoverStats').textContent = `Score ${game.score.toFixed(0)} · Time ${game.runTime.toFixed(1)}s`;
    recordScore();
    populatePerks();
  }

  function recordScore() {
    const id = MAPS[game.mapIndex].id;
    const prev = game.scores[id] || { best: 0 };
    if (game.score > (prev.best || 0)) game.scores[id] = { best: game.score, time: game.runTime };
    saveScores();
  }

  function populatePerks() {
    if (!ui.upgradeGrid) return;
    ui.upgradeGrid.innerHTML = '';
    const options = [...PERKS].sort(() => Math.random() - 0.5).slice(0, 3);
    options.forEach(p => {
      const card = document.createElement('button');
      card.className = 'upgrade-card';
      card.innerHTML = `<div class="name">${p.name}</div><div class="tiny">${p.desc}</div>`;
      card.addEventListener('click', () => { game.perk = { id: p.id, name: p.name, desc: p.desc, apply: p.apply ? p.apply : null }; savePerk(); setToast(`${p.name} equipped next run`); });
      ui.upgradeGrid.appendChild(card);
    });
  }

  /* Preview */
  function drawPreview() {
    const ctx = ui.mapPreview.getContext('2d');
    const w = ui.mapPreview.width, h = ui.mapPreview.height;
    ctx.clearRect(0, 0, w, h);
    const def = MAPS[game.mapIndex];
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 2);
    const scale = (Math.min(w, h) / 2.4) / def.size;
    ctx.strokeStyle = '#5c7bff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, def.size * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,95,122,0.5)';
    def.hazards?.forEach(hz => { ctx.beginPath(); ctx.arc(hz.x * scale, hz.z * scale, hz.r * scale, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = 'rgba(255,209,90,0.5)';
    def.boosts?.forEach(b => { ctx.beginPath(); ctx.arc(b.x * scale, b.z * scale, b.r * scale, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
  }

  /* Resize */
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* Utils */
  function show(el) { el && el.classList.remove('hidden'); }
  function hide(el) { el && el.classList.add('hidden'); }

  function fatal(err) {
    console.error(err);
    if (ui.errorTitle && ui.errorBody) {
      ui.errorTitle.textContent = 'Load error';
      ui.errorBody.textContent = err.message || err.toString();
      show(ui.errorOverlay);
    }
  }

  function playTone(freq = 420, dur = 0.08, vol = 0.08) {
    if (game.settings.sound === 'off') return;
    if (!tone.ctx) tone.ctx = new AudioContext();
    const osc = tone.ctx.createOscillator();
    const g = tone.ctx.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = freq; g.gain.value = vol;
    osc.connect(g).connect(tone.ctx.destination);
    osc.start(); osc.stop(tone.ctx.currentTime + dur);
  }
})();
