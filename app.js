/*
InfernoDrift2 — static Three.js racer (no build)
Run: any static server (e.g. `python -m http.server`) then open http://localhost:8000
Controls: Desktop W/A/S/D or Arrows throttle/steer, Space drift (charge), Shift boost, F fullscreen, Esc pause, ~ debug.
Mobile: steer with left pad, Drift hold then Boost tap (also accelerates), pause via on-screen button.
Tracks: see TRACKS; add by pushing {id,name,desc,laps,difficulty,points:[{x,z,w,h?}],hazards:[{from,to}],boosts:[{from,to}]} – preview auto-draws.
Toggles: fullscreen button or F, gfx setting (high/med/low), debug (~), renderer: local vendor/three.min.js only. Click/tap focus gate once to capture input.
ENGINE CHOICE: Option A — Three.js real 3D (vendored) chosen for depth and lighting while keeping static + lightweight.
BASELINE AUDIT (before fixes):
- Render loop: init halts before requestAnimationFrame because selectMap() calls missing drawPreview(); uncaught ReferenceError stops setup entirely.
- Input: key listeners exist, but UI buttons are never bound due to the init crash, so Start/Resume do nothing and game.state stays "menu".
- Focus: no click-to-focus gate; canvas never receives focus or tabindex; overlays can hold focus, unlike classic launcher that focuses iframe on load and hints to click once.
- Canvas/DPR: renderer setSize runs once in init; resize handler never runs if init fails; no explicit DPR clamp per resize; canvas starts at 1280x720 attributes.
- Exceptions: drawPreview ReferenceError on load; no user-facing error surface. No other runtime guards.
- Assets: favicons and classic launcher present locally; no missing files identified in structure (no 404s expected).
*/
(() => {
  'use strict';

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)] || arr[0];
  const wrap01 = u => ((u % 1) + 1) % 1;

  const CFG = {
    dtMax: 0.05,
    accel: 150,
    brake: 220,
    drag: 34,
    coastDrag: 16,
    steer: 1.9,
    steerDrift: 2.7,
    lateralDamp: 7,
    driftGain: 32,
    boostGain: 0.85,
    boostForce: 560,
    boostDrain: 36,
    boostImpulse: 120,
    maxSpeed: 340,
    offroadPenalty: 0.5,
    hazardHeat: 48,
    heatGainDrift: 20,
    heatGainBoost: 26,
    heatGainHazard: 48,
    heatCool: 18,
    overheatDuration: 2.6,
    enemyInterval: 6,
    pickupInterval: 7,
    rivalLook: 190,
    rivalMax: 6,
    pickupMax: 5,
    pickupRange: 12,
    dprCap: 2,
    cameraLag: 0.12,
    cameraHeight: 5.4,
    cameraBack: 11.5,
    fovBase: 70,
    fovBoost: 8,
  };

  const TRACK_SAMPLES = 720;
  const STORAGE_KEYS = {
    settings: 'infernodrift2-settings',
    scores: 'infernodrift2-scores',
    perk: 'infernodrift2-perk',
  };

  const TRACKS = [
    {
      id: 'ember',
      name: 'Ember Loop',
      desc: 'Wide opener with one lava shoulder and boost pad.',
      difficulty: 'Easy',
      laps: 2,
      points: [
        { x: 0, z: 0, w: 12, h: 0 },
        { x: 90, z: 30, w: 12, h: 1 },
        { x: 180, z: -10, w: 12, h: 0 },
        { x: 230, z: -110, w: 12, h: -1 },
        { x: 150, z: -210, w: 11, h: -1 },
        { x: 10, z: -230, w: 11, h: 0 },
        { x: -150, z: -170, w: 12, h: 1 },
        { x: -220, z: -50, w: 12, h: 1 },
        { x: -170, z: 80, w: 12, h: 0 },
        { x: -50, z: 120, w: 12, h: 0 },
      ],
      hazards: [{ from: 0.16, to: 0.23 }],
      boosts: [{ from: 0.46, to: 0.52 }],
    },
    {
      id: 'sear',
      name: 'Sear S',
      desc: 'Linked S-bends with lava mid-sector.',
      difficulty: 'Medium',
      laps: 3,
      points: [
        { x: 0, z: 0, w: 11, h: 0 },
        { x: 90, z: 70, w: 11, h: 1 },
        { x: 190, z: 110, w: 10, h: 2 },
        { x: 240, z: 20, w: 10, h: 1 },
        { x: 170, z: -90, w: 10, h: 0 },
        { x: 60, z: -170, w: 10, h: -0.5 },
        { x: -60, z: -190, w: 11, h: -0.5 },
        { x: -170, z: -130, w: 11, h: 0 },
        { x: -230, z: -20, w: 11, h: 1 },
        { x: -170, z: 90, w: 11, h: 1 },
        { x: -50, z: 110, w: 11, h: 0 },
      ],
      hazards: [{ from: 0.34, to: 0.42 }, { from: 0.74, to: 0.8 }],
      boosts: [{ from: 0.12, to: 0.16 }, { from: 0.58, to: 0.63 }],
    },
    {
      id: 'ridge',
      name: 'Ridgeback Rise',
      desc: 'Hilly sweepers with mid-air boosts.',
      difficulty: 'Medium',
      laps: 3,
      points: [
        { x: 0, z: 0, w: 10, h: 0 },
        { x: 120, z: 30, w: 10, h: 2.4 },
        { x: 210, z: 130, w: 9.5, h: 4.4 },
        { x: 170, z: 230, w: 10, h: 5.2 },
        { x: 60, z: 280, w: 10, h: 3 },
        { x: -80, z: 260, w: 10, h: 2.2 },
        { x: -200, z: 200, w: 9.5, h: 3.4 },
        { x: -240, z: 90, w: 9.5, h: 4.2 },
        { x: -190, z: -30, w: 10, h: 3.2 },
        { x: -90, z: -80, w: 10, h: 1.2 },
        { x: -10, z: -40, w: 10, h: 0 },
      ],
      hazards: [{ from: 0.5, to: 0.58 }],
      boosts: [{ from: 0.22, to: 0.28 }, { from: 0.82, to: 0.86 }],
    },
    {
      id: 'furnace',
      name: 'Furnace Switchbacks',
      desc: 'Tight chicanes over lava grates.',
      difficulty: 'Hard',
      laps: 3,
      points: [
        { x: 0, z: 0, w: 9, h: 0 },
        { x: 60, z: 80, w: 8.8, h: 0.8 },
        { x: 130, z: 30, w: 8.5, h: 0 },
        { x: 190, z: -60, w: 8.5, h: -0.6 },
        { x: 150, z: -150, w: 8.8, h: -0.2 },
        { x: 60, z: -200, w: 9, h: 0.4 },
        { x: -30, z: -190, w: 8.6, h: 0.8 },
        { x: -130, z: -140, w: 8.4, h: 1.2 },
        { x: -190, z: -60, w: 8.6, h: 1.6 },
        { x: -170, z: 40, w: 8.4, h: 1 },
        { x: -90, z: 110, w: 8.6, h: 0.4 },
      ],
      hazards: [{ from: 0.08, to: 0.14 }, { from: 0.46, to: 0.53 }, { from: 0.86, to: 0.92 }],
      boosts: [{ from: 0.3, to: 0.34 }, { from: 0.66, to: 0.7 }],
    },
    {
      id: 'crest',
      name: 'Molten Crest',
      desc: 'Fast crests with long sightlines.',
      difficulty: 'Fast',
      laps: 2,
      points: [
        { x: 0, z: 0, w: 13, h: 0 },
        { x: 110, z: 50, w: 13, h: 1 },
        { x: 220, z: 20, w: 12, h: 1.2 },
        { x: 280, z: -80, w: 12, h: 0.6 },
        { x: 210, z: -190, w: 12, h: -0.4 },
        { x: 110, z: -240, w: 12, h: -0.6 },
        { x: -10, z: -250, w: 13, h: -0.2 },
        { x: -150, z: -190, w: 13, h: 0.2 },
        { x: -250, z: -80, w: 13, h: 1.2 },
        { x: -230, z: 40, w: 12, h: 1.6 },
        { x: -150, z: 130, w: 12, h: 1 },
        { x: -30, z: 160, w: 12, h: 0.6 },
      ],
      hazards: [{ from: 0.6, to: 0.7 }],
      boosts: [{ from: 0.28, to: 0.34 }, { from: 0.88, to: 0.93 }],
    },
    {
      id: 'endless',
      name: 'Endless Drift',
      desc: 'Survival ribbon that never ends; stack perks and score.',
      difficulty: 'Endless',
      laps: Infinity,
      points: [
        { x: 0, z: 0, w: 12, h: 0 },
        { x: 120, z: 60, w: 12, h: 1 },
        { x: 230, z: 0, w: 12, h: 0 },
        { x: 260, z: -120, w: 12, h: -0.8 },
        { x: 180, z: -220, w: 12, h: -0.6 },
        { x: 40, z: -260, w: 12, h: -0.2 },
        { x: -120, z: -220, w: 12, h: 0.2 },
        { x: -230, z: -120, w: 12, h: 0.6 },
        { x: -260, z: 20, w: 12, h: 0.6 },
        { x: -180, z: 120, w: 12, h: 0.4 },
        { x: -40, z: 160, w: 12, h: 0.2 },
      ],
      hazards: [{ from: 0.18, to: 0.22 }, { from: 0.52, to: 0.56 }, { from: 0.82, to: 0.86 }],
      boosts: [{ from: 0.3, to: 0.35 }, { from: 0.64, to: 0.69 }],
    },
  ];

  const PERKS = [
    { id: 'cool', name: 'Cryo Lines', desc: 'Heat decay +25%.', apply: g => g.mod.coolRate *= 1.25 },
    { id: 'grip', name: 'Grip Gel', desc: 'Grip up, off-road hurts less.', apply: g => { g.mod.grip *= 1.12; g.mod.offroadResist += 0.15; } },
    { id: 'boost', name: 'Ion Boost', desc: 'Boost gain +20%, drain -10%.', apply: g => { g.mod.boostGain *= 1.2; g.mod.boostDrain *= 0.9; } },
    { id: 'shield', name: 'Phase Shield', desc: 'Start with one shield hit.', apply: g => { g.mod.shield = true; } },
    { id: 'magnet', name: 'Pick Magnet', desc: 'Pickups pull from farther.', apply: g => { g.mod.pickRange *= 1.4; } },
    { id: 'resist', name: 'Lava Skin', desc: 'Hazard heat -30%.', apply: g => { g.mod.hazardResist *= 0.7; } },
  ];

  const ui = {};
  const world = { roadGroup: null, hazardMesh: null, boostMesh: null, markers: null };
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

  const game = {
    state: 'menu',
    mode: 'player',
    settings: loadSettings(),
    scores: loadScores(),
    trackIndex: 0,
    track: null,
    s: 0,
    lane: 0,
    laneVel: 0,
    speed: 0,
    drift: 0,
    boost: 0,
    boostPulse: 0,
    heat: 0,
    overheat: 0,
    combo: 1,
    comboTimer: 0,
    score: 0,
    lap: 1,
    runTime: 0,
    last: 0,
    fps: 0,
    pickupTimer: CFG.pickupInterval,
    rivalTimer: CFG.enemyInterval,
    drifting: false,
    perk: loadPerk(),
    nextPerk: null,
    mod: defaultMods(),
    autopilotTime: 0,
    focusCaptured: false,
    lastLapGate: false,
  };

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
    selectMap(game.trackIndex);
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
    ui.gameShell = document.querySelector('#gameShell');
    ui.touchControls = document.querySelector('#touchControls');
    ui.focusGate = document.querySelector('#focusGate');
    ui.errorOverlay = document.querySelector('#errorOverlay');
    ui.errorTitle = document.querySelector('#errorTitle');
    ui.errorBody = document.querySelector('#errorBody');
  }

  function buildDebugBox() {
    debugBox.id = 'debugPanel';
    debugBox.style.position = 'fixed';
    debugBox.style.top = '10px';
    debugBox.style.left = '10px';
    debugBox.style.padding = '10px 12px';
    debugBox.style.background = 'rgba(8,11,20,0.76)';
    debugBox.style.border = '1px solid rgba(255,255,255,0.08)';
    debugBox.style.borderRadius = '10px';
    debugBox.style.font = '12px monospace';
    debugBox.style.color = '#e7f3ff';
    debugBox.style.zIndex = '60';
    debugBox.style.display = 'none';
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

  function initRenderer() {
    renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    camera = new THREE.PerspectiveCamera(CFG.fovBase, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(0, CFG.cameraHeight, CFG.cameraBack);
    camera.lookAt(0, 0, 0);
  }

  function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080f);
    scene.fog = new THREE.Fog(0x05080f, 40, 900);
    const hemi = new THREE.HemisphereLight(0x7fb9ff, 0x0a0c16, 0.85);
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(140, 220, -120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
    scene.add(hemi, sun);

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x0a111e, roughness: 0.9, metalness: 0.02 });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(3200, 48), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    world.roadGroup = new THREE.Group();
    scene.add(world.roadGroup);
  }

  function initPools() {
    playerMesh = buildCar(0x7cf0d8, 0x102922);
    playerShadow = buildShadow();
    scene.add(playerMesh, playerShadow);

    for (let i = 0; i < 10; i++) { const m = buildCar(0xff6b74, 0x2a0f14); m.visible = false; scene.add(m); rivalPool.push(m); }

    const pickupGeo = new THREE.OctahedronGeometry(0.7);
    const pickupMat = new THREE.MeshStandardMaterial({ color: 0xffd15a, emissive: 0x7a4c1f, roughness: 0.35, metalness: 0.25 });
    for (let i = 0; i < 16; i++) { const m = new THREE.Mesh(pickupGeo, pickupMat.clone()); m.visible = false; m.castShadow = true; scene.add(m); pickupPool.push(m); }
  }

  function buildCar(color, accent) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.9), new THREE.MeshStandardMaterial({ color, emissive: accent, roughness: 0.4, metalness: 0.2 }));
    body.castShadow = true; body.receiveShadow = true; g.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.2), new THREE.MeshStandardMaterial({ color: 0x0c1320, emissive: 0x0c1320, roughness: 0.6 }));
    cab.position.set(0, 0.55, -0.1); cab.castShadow = true; g.add(cab);
    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.5, 12); wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111, roughness: 0.8 });
    [[0.7, -0.28, 0.95], [-0.7, -0.28, 0.95], [0.7, -0.28, -0.95], [-0.7, -0.28, -0.95]].forEach(o => {
      const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(o[0], o[1], o[2]); w.castShadow = true; g.add(w);
    });
    return g;
  }

  function buildShadow() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.6), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = -1;
    mesh.receiveShadow = false;
    return mesh;
  }

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
    TRACKS.forEach((m, idx) => {
      const card = document.createElement('button');
      card.className = 'map-card';
      card.innerHTML = `<div class="name">${m.name}</div><div class="muted tiny">${m.desc}</div><div class="muted tiny">${m.difficulty} · ${m.laps === Infinity ? 'Endless' : m.laps + ' laps'}</div>`;
      card.addEventListener('click', () => selectMap(idx));
      ui.mapList.appendChild(card);
    });
  }

  function selectMap(idx) {
    game.trackIndex = idx;
    document.querySelectorAll('.map-card').forEach((c, i) => c.classList.toggle('active', i === idx));
    ui.mapName.textContent = TRACKS[idx].name;
    ui.mapDesc.textContent = TRACKS[idx].desc;
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
    game.s = 0; game.lane = 0; game.laneVel = 0; game.speed = 0; game.drift = 0; game.boost = 0; game.boostPulse = 0; game.heat = 0; game.overheat = 0; game.combo = 1; game.comboTimer = 0; game.score = 0; game.lap = 1; game.runTime = 0; game.lastLapGate = false;
    game.pickupTimer = CFG.pickupInterval; game.rivalTimer = CFG.enemyInterval; game.autopilotTime = 0;
    game.mod = defaultMods();
    if (game.perk) applyPerk(game.perk);
    buildWorld();
    ui.hud.classList.remove('hidden');
    document.querySelector('#resumeBtn').disabled = false;
    if (!game.focusCaptured) show(ui.focusGate);
    focusCanvas();
    setToast(mode === 'demo' ? 'Attract loop' : 'Go fast');
  }

  function applyPerk(perk) {
    if (!perk) return;
    const p = PERKS.find(p => p.id === perk.id) || perk;
    try { p.apply(game); } catch { /* ignore */ }
  }

  function buildWorld() {
    const def = TRACKS[game.trackIndex];
    game.track = buildTrack(def);
    activeRivals.length = 0; activePickups.length = 0;
    rivalPool.forEach(m => m.visible = false);
    pickupPool.forEach(m => m.visible = false);
    spawnRival(); spawnRival();
    spawnPickup();
  }

  function buildTrack(def) {
    if (world.roadGroup) { scene.remove(world.roadGroup); world.roadGroup = new THREE.Group(); scene.add(world.roadGroup); }
    const pts = def.points.map(p => new THREE.Vector3(p.x, p.h || 0, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.28);
    const spaced = curve.getSpacedPoints(TRACK_SAMPLES);
    const samples = [];
    const len = curve.getLength();
    for (let i = 0; i < spaced.length; i++) {
      const u = i / (spaced.length - 1);
      const t = curve.getUtoTmapping(u);
      const pos = spaced[i].clone();
      const tan = curve.getTangentAt(t).normalize();
      const normal = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
      const width = widthAt(def, u);
      const hazard = rangeActive(def.hazards, u);
      const boost = rangeActive(def.boosts, u);
      samples.push({ pos, tan, normal, width, hazard, boost, u });
    }
    const track = { def, curve, samples, length: len, segment: len / spaced.length };
    buildRoadMeshes(track);
    return track;
  }

  function buildRoadMeshes(track) {
    const verts = [], cols = [], idx = [];
    const colorA = new THREE.Color(0x111826);
    const colorB = new THREE.Color(0x0d1320);
    for (let i = 0; i < track.samples.length; i++) {
      const s = track.samples[i];
      const left = s.pos.clone().addScaledVector(s.normal, s.width * 0.5);
      const right = s.pos.clone().addScaledVector(s.normal, -s.width * 0.5);
      verts.push(left.x, left.y, left.z, right.x, right.y, right.z);
      const c = (i % 2 === 0) ? colorA : colorB;
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (i < track.samples.length - 1) {
        const a = i * 2, b = a + 1, cIdx = a + 2, dIdx = a + 3;
        idx.push(a, b, cIdx, b, dIdx, cIdx);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = false;
    world.roadGroup.add(mesh);

    world.hazardMesh = buildBandMesh(track, s => s.hazard, 0.52, 0xff5f7a, 0x5f111a, 0.86);
    world.boostMesh = buildBandMesh(track, s => s.boost, 0.48, 0xffd15a, 0x7a4000, 0.82);
    if (world.hazardMesh) world.roadGroup.add(world.hazardMesh);
    if (world.boostMesh) world.roadGroup.add(world.boostMesh);
  }

  function buildBandMesh(track, predicate, scale, colorHex, emissive, opacity) {
    const verts = [], idx = [];
    for (let i = 0; i < track.samples.length - 1; i++) {
      const a = track.samples[i], b = track.samples[i + 1];
      if (!(predicate(a) || predicate(b))) continue;
      const aL = a.pos.clone().addScaledVector(a.normal, a.width * 0.5 * scale);
      const aR = a.pos.clone().addScaledVector(a.normal, -a.width * 0.5 * scale);
      const bL = b.pos.clone().addScaledVector(b.normal, b.width * 0.5 * scale);
      const bR = b.pos.clone().addScaledVector(b.normal, -b.width * 0.5 * scale);
      const base = verts.length / 3;
      verts.push(aL.x, aL.y, aL.z, aR.x, aR.y, aR.z, bL.x, bL.y, bL.z, bR.x, bR.y, bR.z);
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    if (!verts.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: colorHex, emissive, transparent: true, opacity, side: THREE.DoubleSide });
    return new THREE.Mesh(geo, mat);
  }

  function widthAt(def, u) {
    const pts = def.points;
    const scaled = u * pts.length;
    const i = Math.floor(scaled) % pts.length;
    const j = (i + 1) % pts.length;
    const t = scaled - Math.floor(scaled);
    const w0 = pts[i].w || pts[i].width || 10;
    const w1 = pts[j].w || pts[j].width || 10;
    return lerp(w0, w1, t);
  }

  function rangeActive(list, u) {
    if (!list) return false;
    return list.some(r => {
      const a = wrap01(r.from || 0), b = wrap01(r.to || 0);
      if (a <= b) return u >= a && u <= b;
      return u >= a || u <= b;
    });
  }

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
      steer: Math.sin(game.autopilotTime * 0.8) * 0.8,
      accel: true,
      brake: false,
      drift: Math.sin(game.autopilotTime * 1.4) > 0.65,
      boost: Math.random() > 0.985,
    };
  }

  function update(dt) {
    if (!game.track) return;
    const input = game.state === 'attract' ? autoInput(dt) : readInput();
    game.runTime += dt;
    game.fps = game.fps ? lerp(game.fps, 1 / dt, 0.08) : 1 / dt;

    const grip = (game.overheat > 0 ? 0.65 : 1) * game.mod.grip;
    if (input.accel) game.speed += CFG.accel * dt;
    if (input.brake) game.speed -= CFG.brake * dt;
    if (!input.accel && !input.brake) game.speed -= CFG.coastDrag * dt;
    game.speed = clamp(game.speed, 0, CFG.maxSpeed * 1.4);
    const drag = CFG.drag * (0.2 + game.speed / (CFG.maxSpeed * 1.1));
    game.speed = clamp(game.speed - drag * dt, 0, CFG.maxSpeed * 1.4);

    const steerRate = (input.drift ? CFG.steerDrift : CFG.steer) * grip * (0.9 + game.speed / CFG.maxSpeed);
    game.laneVel = lerp(game.laneVel, input.steer * steerRate, dt * (input.drift ? 8 : 6));
    game.lane += game.laneVel * dt;

    const sample = sampleTrack(game.track, game.s);
    const roadHalf = sample.width * 0.5 * (1 - 0.08);
    if (Math.abs(game.lane) > roadHalf) {
      const sign = Math.sign(game.lane);
      game.lane = sign * roadHalf;
      game.speed *= (1 - (1 - CFG.offroadPenalty + game.mod.offroadResist) * dt * 2);
      game.heat += CFG.heatGainDrift * dt * 0.5;
    }

    if (input.drift) {
      game.drift = clamp(game.drift + CFG.driftGain * dt, 0, 100);
      game.speed *= 0.995;
      game.heat += CFG.heatGainDrift * dt;
      game.drifting = true;
    } else if (game.drifting) {
      if (game.drift > 5) {
        const gain = game.drift * CFG.boostGain * game.mod.boostGain;
        game.boost = clamp(game.boost + gain, 0, 130);
        game.boostPulse = 0.9;
        setToast('Boost charged');
      }
      game.drift = 0;
      game.drifting = false;
    }

    if (input.boost && game.boost > 0) {
      game.speed = Math.min(game.speed + CFG.boostForce * dt, CFG.maxSpeed * 1.35);
      game.boost = clamp(game.boost - CFG.boostDrain * dt * game.mod.boostDrain, 0, 130);
      game.heat += CFG.heatGainBoost * dt;
    }
    if (game.boostPulse > 0) { game.speed += CFG.boostImpulse * dt; game.boostPulse -= dt; }

    if (sample.hazard) game.heat += CFG.heatGainHazard * dt * game.mod.hazardResist;
    if (sample.boost) { game.boost = clamp(game.boost + 14 * dt, 0, 130); game.speed = Math.min(game.speed + CFG.boostForce * 0.25 * dt, CFG.maxSpeed * 1.25); }

    applyHeat(dt);

    const prevS = game.s;
    game.s = wrapS(game.track, game.s + game.speed * dt);
    handleLap(prevS, game.s);

    const nowSample = sampleTrack(game.track, game.s);
    const pos = nowSample.pos.clone().addScaledVector(nowSample.normal, game.lane);
    playerMesh.position.copy(pos);
    playerMesh.rotation.y = Math.atan2(nowSample.tan.x, nowSample.tan.z) + game.laneVel * 0.08;
    if (playerShadow) { playerShadow.position.set(pos.x, 0.01, pos.z); playerShadow.scale.set(1, 1, 1); }

    updateCamera(nowSample, dt);

    game.comboTimer = Math.max(0, game.comboTimer - dt);
    if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.2 * dt);
    game.score += (game.speed * 0.08 + (input.drift ? 3 : 0)) * dt * game.combo;

    updatePickups(dt, pos);
    updateRivals(dt, pos);
    updateHUD();
  }

  function applyHeat(dt) {
    if (game.overheat > 0) game.overheat = Math.max(0, game.overheat - dt);
    game.heat = clamp(game.heat - CFG.heatCool * dt * game.mod.coolRate, 0, 100);
    if (game.heat >= 100 && game.overheat <= 0) {
      game.overheat = CFG.overheatDuration;
      playTone(180, 0.1, 0.12);
      setToast('Overheat! Grip down');
    }
  }

  function handleLap(prevS, currentS) {
    if (!game.track) return;
    const len = game.track.length;
    const crossed = prevS > currentS && prevS - currentS > len * 0.25;
    if (crossed) {
      if (game.state === 'playing' && game.track.def.laps !== Infinity) {
        game.lap += 1; game.score += 400 * game.lap;
        if (game.lap > game.track.def.laps) endRun('Finished');
      }
    }
  }

  function updateCamera(sample, dt) {
    const lookPos = sample.pos.clone().addScaledVector(sample.normal, game.lane);
    const right = sample.normal.clone();
    const back = sample.tan.clone().multiplyScalar(-1);
    const target = lookPos.clone().addScaledVector(back, CFG.cameraBack).addScaledVector(right, 0.2).add(new THREE.Vector3(0, CFG.cameraHeight, 0));
    camera.position.lerp(target, CFG.cameraLag);
    camera.lookAt(lookPos.x, lookPos.y + 1, lookPos.z);
    camera.fov = lerp(camera.fov, CFG.fovBase + (game.speed / CFG.maxSpeed) * CFG.fovBoost, 0.1);
    camera.updateProjectionMatrix();
  }

  function sampleTrack(track, s) {
    const len = track.length;
    const wrapped = wrapS(track, s);
    const u = wrapped / len;
    const f = u * (track.samples.length - 1);
    const i = Math.floor(f);
    const t = f - i;
    const a = track.samples[i];
    const b = track.samples[(i + 1) % track.samples.length];
    return {
      pos: a.pos.clone().lerp(b.pos, t),
      tan: a.tan.clone().lerp(b.tan, t).normalize(),
      normal: a.normal.clone().lerp(b.normal, t).normalize(),
      width: lerp(a.width, b.width, t),
      hazard: a.hazard || b.hazard,
      boost: a.boost || b.boost,
      u: lerp(a.u, b.u, t),
    };
  }

  function wrapS(track, s) { const len = track.length; let v = s % len; if (v < 0) v += len; return v; }
  function wrapDelta(a, b) { const len = game.track.length; let d = a - b; if (d > len / 2) d -= len; if (d < -len / 2) d += len; return d; }

  function updatePickups(dt, playerPos) {
    game.pickupTimer -= dt;
    if (game.pickupTimer <= 0 && activePickups.length < CFG.pickupMax) { spawnPickup(); game.pickupTimer = CFG.pickupInterval; }
    for (let i = activePickups.length - 1; i >= 0; i--) {
      const p = activePickups[i];
      const sample = sampleTrack(game.track, p.s);
      const pos = sample.pos.clone().addScaledVector(sample.normal, p.lane);
      pos.y += 0.8 + Math.sin(game.runTime * 4 + i) * 0.2;
      p.mesh.position.copy(pos);
      p.mesh.rotation.y += dt * 2.6;
      const dz = Math.abs(wrapDelta(p.s, game.s));
      const laneDelta = Math.abs(p.lane - game.lane);
      const range = CFG.pickupRange * game.mod.pickRange;
      if (dz < range && laneDelta < 1.4) {
        if (dz < 10 && laneDelta < 0.9) { collectPickup(p); activePickups.splice(i, 1); continue; }
        pos.lerp(playerPos, 0.05);
        p.mesh.position.copy(pos);
      }
    }
  }

  function spawnPickup() {
    const mesh = pickupPool.find(m => !m.visible);
    if (!mesh || !game.track) return;
    mesh.visible = true;
    const s = wrapS(game.track, game.s + 120 + Math.random() * 320);
    const lane = (Math.random() - 0.5) * 2.4;
    const type = pick(['cool', 'cell', 'shield', 'coin']);
    const colors = { cool: 0x7cf0d8, cell: 0xffd15a, shield: 0x7ab7ff, coin: 0xff9f40 };
    mesh.material.color.setHex(colors[type]); mesh.material.emissive.setHex(colors[type]);
    activePickups.push({ s, lane, type, mesh });
  }

  function collectPickup(p) {
    if (p.type === 'cool') game.heat = Math.max(0, game.heat - 28);
    if (p.type === 'cell') game.boost = clamp(game.boost + 45, 0, 130);
    if (p.type === 'shield') { game.mod.shield = true; setToast('Shield ready'); }
    if (p.type === 'coin') { game.score += 180 * game.combo; addCombo(0.5); }
    playTone(520, 0.08, 0.12);
    p.mesh.visible = false;
  }

  function updateRivals(dt, playerPos) {
    game.rivalTimer -= dt;
    if (game.rivalTimer <= 0 && activeRivals.length < CFG.rivalMax) { spawnRival(); game.rivalTimer = CFG.enemyInterval; }
    for (let i = activeRivals.length - 1; i >= 0; i--) {
      const r = activeRivals[i];
      const targetLane = r.type === 'blocker' ? clamp(game.lane + Math.sin(game.runTime * 2) * 0.6, -2.6, 2.6)
        : r.type === 'hunter' ? game.lane
        : clamp((Math.random() - 0.5) * 1.4, -2.6, 2.6);
      r.lane = lerp(r.lane, targetLane, dt * (r.type === 'blocker' ? 5 : 3.2));
      const targetSpeed = clamp(game.speed * (r.type === 'hunter' ? 1.05 : 0.92), 80, CFG.maxSpeed * 0.9);
      r.speed = lerp(r.speed, targetSpeed, dt * 2.2);
      r.s = wrapS(game.track, r.s + r.speed * dt);
      const sample = sampleTrack(game.track, r.s);
      const pos = sample.pos.clone().addScaledVector(sample.normal, r.lane);
      pos.y += 0.2;
      r.mesh.position.copy(pos);
      r.mesh.rotation.y = Math.atan2(sample.tan.x, sample.tan.z);
      const dz = Math.abs(wrapDelta(r.s, game.s));
      const laneDelta = Math.abs(r.lane - game.lane);
      if (dz < 14 && laneDelta < 1) {
        if (game.mod.shield) { game.mod.shield = false; setToast('Shield broke'); playTone(260, 0.06, 0.1); }
        else { bump(); }
        r.speed *= 0.8;
      }
      if (dz > game.track.length * 0.6) { r.mesh.visible = false; activeRivals.splice(i, 1); }
    }
  }

  function spawnRival() {
    const mesh = rivalPool.find(m => !m.visible);
    if (!mesh || !game.track) return;
    mesh.visible = true;
    const s = wrapS(game.track, game.s + CFG.rivalLook + Math.random() * 160);
    const lane = (Math.random() - 0.5) * 2.2;
    const type = pick(['racer', 'blocker', 'hunter']);
    activeRivals.push({ s, lane, speed: clamp(game.speed * 0.9, 80, 160), mesh, type });
  }

  function bump() {
    game.speed *= 0.78;
    game.heat += 8;
    game.laneVel *= 0.6;
    addCombo(-0.5);
    playTone(220, 0.08, 0.14);
  }

  function addCombo(v) { game.combo = clamp(game.combo + v, 1, 9); game.comboTimer = 3; }

  function render() {
    if (renderer && scene && camera) renderer.render(scene, camera);
    if (game.debug) {
      debugBox.style.display = 'block';
      debugBox.textContent = `fps ${game.fps.toFixed(0)}\nspd ${game.speed.toFixed(1)} lane ${game.lane.toFixed(2)}\nheat ${game.heat.toFixed(1)} drift ${game.drift.toFixed(1)} boost ${game.boost.toFixed(1)}\nscore ${game.score.toFixed(0)} combo x${game.combo.toFixed(1)}\ntrack ${TRACKS[game.trackIndex].id} lap ${game.lap}`;
    } else debugBox.style.display = 'none';
  }

  function updateHUD() {
    ui.hudSpeed.textContent = game.speed.toFixed(0);
    ui.hudScore.textContent = game.score.toFixed(0);
    ui.hudCombo.textContent = `x${game.combo.toFixed(1)}`;
    ui.hudLap.textContent = `${game.lap}/${game.track?.def?.laps === Infinity ? 'INF' : game.track?.def?.laps || 0} - ${game.runTime.toFixed(1)}s`;
    ui.heatBar.style.width = `${game.heat}%`;
    ui.driftBar.style.width = `${game.drift}%`;
    ui.boostBar.style.width = `${game.boost / 1.3}%`;
  }

  function setToast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(setToast.tid);
    setToast.tid = setTimeout(() => ui.toast.classList.remove('show'), 1400);
  }

  function endRun(reason) {
    game.state = 'over';
    show(ui.gameoverOverlay);
    document.querySelector('#gameoverTitle').textContent = reason;
    document.querySelector('#gameoverStats').textContent = `Score ${game.score.toFixed(0)} · Lap ${game.lap} · Time ${game.runTime.toFixed(1)}s`;
    recordScore();
    populatePerks();
  }

  function recordScore() {
    const id = TRACKS[game.trackIndex].id;
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

  function drawPreview() {
    const ctx = ui.mapPreview.getContext('2d');
    const w = ui.mapPreview.width, h = ui.mapPreview.height;
    ctx.clearRect(0, 0, w, h);
    const def = TRACKS[game.trackIndex];
    const pts = def.points;
    const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const rangeX = Math.max(1, maxX - minX), rangeZ = Math.max(1, maxZ - minZ);
    const scale = 0.9 * Math.min(w / rangeX, h / rangeZ);
    const cx = (maxX + minX) / 2, cz = (maxZ + minZ) / 2;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ff9f40';
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (p.x - cx) * scale;
      const z = (p.z - cz) * scale;
      if (i === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

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
