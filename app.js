/*
InfernoDrift2 -- static Three.js open-arena racer (no build)
Run: `python -m http.server` then open http://localhost:8000
Controls (desktop): W/Up throttle, S/Down brake, A/Left steer left, D/Right steer right, Space drift (charge), Shift boost, F fullscreen, Esc pause, ~ debug.
Controls (mobile): steer with left pad, hold Drift then tap Boost, pause via on-screen button.
Maps: see MAPS; each is an arena {size, hazards[], boosts[]} (props are auto-scattered). Add entries to MAPS to create more arenas.
Toggles: fullscreen button or F, gfx setting (high/med/low), debug (~). Click/tap once to focus for input capture.
ENGINE CHOICE: Three.js real 3D (vendored, no CDN) to keep this static and lightweight.
BASELINE AUDIT (before fixes):
- Render loop crashed because drawPreview was missing; nothing started. Fixed with deterministic boot + error surface.
- Input/focus: no focus gate, overlays captured keys. Added click/tap focus overlay + canvas focus/tap to capture keys.
- Canvas/DPR: single resize path with DPR clamp.
- Gameplay: previous track-based lane system prevented steering; replaced with free-move yaw/velocity model and pursuit AI.
*/
/* CURRENT AUDIT:
- Speed: update() integrates game.vel with (CFG.accel/brake) and drag; no hard cap (CFG.maxSpeed is only a very high soft reference).
- Steering: readInput() returns steer axis where left is negative and right is positive; update() applies steer -> yawVel -> yaw; forward = (sin(yaw), 0, cos(yaw)).
- HUD: updateHUD() updates DOM (#hud*). Blur was caused by HUD being behind the topbar backdrop-filter due to stacking context; fixed in CSS (see style.css).
*/

import * as THREE from './vendor/three.module.js';

(() => {
  'use strict';

  /* Helpers */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)] || arr[0];
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Lightweight deterministic 2D noise (value noise + fbm)
  const fract = v => v - Math.floor(v);
  const hash2 = (x, z) => fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453123);
  function noise2(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz);
    const b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1);
    const d = hash2(ix + 1, iz + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function fbm2(x, z) {
    let sum = 0;
    let amp = 0.55;
    let freq = 1;
    for (let i = 0; i < 4; i++) {
      sum += amp * noise2(x * freq, z * freq);
      freq *= 2;
      amp *= 0.5;
    }
    return sum;
  }

  const ASSETS = { groundTex: null, skyTex: null, lavaTex: null, particleTex: null };
  const UP = new THREE.Vector3(0, 1, 0);

  /* Config */
  const CFG = {
    dtMax: 0.05,
    // No hard top-speed cap: keep accelerating (drag still prevents infinity in practice).
    maxSpeed: 9999,
    accel: 52,
    brake: 120,
    drag: 0.10,
    coastDrag: 0.22,
    lateralGrip: 8.6,
    driftGrip: 3.2,
    steer: 1.95,
    steerDrift: 2.65,
    throttleCurve: 2.1,
    driftGain: 34,
    boostPower: 155,
    boostDrain: 28,
    boostImpulse: 55,
    boostGain: 1.0,
    pickupInterval: 7,
    rivalInterval: 8,
    rivalMax: 3,
    pickupMax: 6,
    pickupRange: 11,
    arenaBounce: 0.45,
    dprCap: 2,
    gravity: 26,
    groundContactEps: 0.12,
    groundStickVel: 1.0,
    airSteerMul: 0.35,
    airGripMul: 0.25,
    steerRefSpeed: 140,
    fxRefSpeed: 170,
    cameraLag: 0.12,
    cameraHeight: 6.2,
    cameraBack: 12.5,
    fovBase: 70,
    fovBoost: 10,
    rivalAccel: 85,
    rivalDrag: 0.16,
    rivalMaxFactor: 0.92,
  };

  /* Map (single open-world biome park) */
  const MAPS = [{
    id: 'megapark',
    name: 'Inferno Wilds',
    desc: 'One huge open world with biomes + a big stunt park.',
    difficulty: 'Open World',
    size: 3200,
    ramps: [
      // Central stunt park (connected, no single lonely ramp)
      { x: 0, z: -240, w: 34, l: 120, h: 22, yaw: 0.0 },
      { x: 180, z: -60, w: 26, l: 90, h: 16, yaw: 1.15 },
      { x: -180, z: -60, w: 26, l: 90, h: 16, yaw: -1.15 },
      { x: 0, z: 220, w: 38, l: 140, h: 24, yaw: Math.PI },
      { x: 340, z: 0, w: 28, l: 100, h: 18, yaw: Math.PI / 2 },
      { x: -340, z: 0, w: 28, l: 100, h: 18, yaw: -Math.PI / 2 },

      // Biome connectors: smaller kickers sprinkled around
      { x: 900, z: 400, w: 28, l: 90, h: 14, yaw: 0.6 },
      { x: 1200, z: -700, w: 30, l: 110, h: 18, yaw: -0.25 },
      { x: -1100, z: 800, w: 30, l: 110, h: 18, yaw: 2.4 },
      { x: -1400, z: -900, w: 34, l: 130, h: 22, yaw: -2.5 },

      // Stunt highway: long runs with real launches and safe landings
      { x: 0, z: -1280, w: 52, l: 190, h: 34, yaw: 0.0 },
      { x: 220, z: -1040, w: 34, l: 130, h: 22, yaw: 0.75 },
      { x: -240, z: -1020, w: 34, l: 130, h: 22, yaw: -0.75 },
      { x: 0, z: -760, w: 44, l: 170, h: 26, yaw: Math.PI },

      // Outer-world mega kickers
      { x: 1900, z: 900, w: 46, l: 180, h: 28, yaw: 0.55 },
      { x: -2100, z: 1100, w: 46, l: 180, h: 28, yaw: 2.3 },
      { x: 2100, z: -1300, w: 50, l: 210, h: 34, yaw: -0.4 },
      { x: -2300, z: -1500, w: 54, l: 220, h: 36, yaw: -2.4 },
    ],
    platforms: [
      // Multi-level plazas to jump onto/from
      { x: 0, z: -520, w: 420, l: 220, y: 16, yaw: 0 },
      { x: 520, z: 0, w: 220, l: 420, y: 16, yaw: Math.PI / 2 },
      { x: -520, z: 0, w: 220, l: 420, y: 16, yaw: Math.PI / 2 },
      { x: 0, z: 520, w: 420, l: 220, y: 16, yaw: 0 },
      { x: 0, z: 0, w: 220, l: 220, y: 10, yaw: 0 },
      { x: 0, z: -860, w: 220, l: 140, y: 26, yaw: 0 },

      // Highway landings (flat + wide so jumps feel fair)
      { x: 0, z: -1040, w: 520, l: 260, y: 30, yaw: 0 },
      { x: 0, z: -1420, w: 420, l: 220, y: 40, yaw: 0 },
      { x: 1800, z: 840, w: 380, l: 220, y: 24, yaw: 0.5 },
      { x: -2000, z: 1040, w: 380, l: 220, y: 24, yaw: -0.7 },
    ],
    rings: [
      // Elevated ring road for high-speed sweeping turns
      { x: 0, z: 0, inner: 140, outer: 210, y: 12 },
      { x: 900, z: -300, inner: 120, outer: 170, y: 10 },
      { x: -1050, z: 650, inner: 150, outer: 220, y: 12 },
      { x: 1550, z: 1050, inner: 170, outer: 260, y: 14 },
      { x: -1850, z: -1350, inner: 190, outer: 290, y: 16 },
    ],
  }];

  /* Perks */
  const PERKS = [
    { id: 'grip', name: 'Grip Gel', desc: 'Grip up, cornering is steadier.', apply: g => { g.mod.grip *= 1.14; } },
    { id: 'boost', name: 'Ion Boost', desc: 'Boost gain +20%, drain -10%.', apply: g => { g.mod.boostGain *= 1.2; g.mod.boostDrain *= 0.9; } },
    { id: 'magnet', name: 'Pick Magnet', desc: 'Pickups pull from farther.', apply: g => { g.mod.pickRange *= 1.4; } },
    { id: 'steer', name: 'Quick Rack', desc: 'Steering response +12%.', apply: g => { g.mod.steer *= 1.12; } },
  ];

  /* DOM refs */
  const ui = {};
  const world = {
    arenaGroup: null,
    hazardMeshes: [],
    boostMeshes: [],
    props: null,
    hazardLights: [],
    speedFx: null,
    speedFxAttr: null,
    speedFxPos: null,
    particles: null,
    ramps: [],
    floor: null,
    stunts: { ramps: [], platforms: [], rings: [] },
  };
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
    steerInput: 0,
    lastDt: 0,
    shake: 0,
    invuln: 0,
    grounded: true,
    groundY: 0,
    groundNormal: new THREE.Vector3(0, 1, 0),
    onRamp: false,
    rampId: -1,
  };

  /* Boot */
  document.addEventListener('DOMContentLoaded', () => {
    try { boot(); } catch (err) { fatal(err); }
  });

  function boot() {
    cacheDom();
    buildDebugBox();
    initRenderer();
    initScene();
    initPools();
    initParticles();
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
    return { grip: 1, steer: 1, boostGain: 1, boostDrain: 1, pickRange: 1 };
  }

  function loadSettings() {
    const base = { sound: 'on', gfx: 'high', controls: 'wasd', enemyAI: 'standard', speedScale: 1 };
    try { return { ...base, ...(JSON.parse(localStorage.getItem(STORAGE_KEYS.settings)) || {}) }; }
    catch { return base; }
  }
  function saveSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(game.settings)); }
  function loadScores() { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.scores)) || {}; } catch { return {}; } }
  function saveScores() { localStorage.setItem(STORAGE_KEYS.scores, JSON.stringify(game.scores)); }
  function loadPerk() { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.perk)) || null; } catch { return null; } }
  function savePerk() { if (game.perk) localStorage.setItem(STORAGE_KEYS.perk, JSON.stringify(game.perk)); else localStorage.removeItem(STORAGE_KEYS.perk); }

  function getGroundTexture() {
    if (ASSETS.groundTex) return ASSETS.groundTex;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#2b2a28';
    ctx.fillRect(0, 0, c.width, c.height);

    // Large blotches (mud/ash patches)
    for (let i = 0; i < 1600; i++) {
      const x = Math.random() * c.width;
      const y = Math.random() * c.height;
      const r = 8 + Math.random() * 55;
      const v = 38 + Math.random() * 50;
      const a = 0.04 + Math.random() * 0.08;
      const gg = ctx.createRadialGradient(x, y, 2, x, y, r);
      gg.addColorStop(0, `rgba(${v},${v - 4},${v - 8},${a})`);
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fine grain
    for (let i = 0; i < 52000; i++) {
      const x = (Math.random() * c.width) | 0;
      const y = (Math.random() * c.height) | 0;
      const v = 40 + (Math.random() * 70) | 0;
      ctx.fillStyle = `rgba(${v},${v - 3},${v - 8},${Math.random() * 0.06})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // Sparse pebbles
    for (let i = 0; i < 2200; i++) {
      const x = Math.random() * c.width;
      const y = Math.random() * c.height;
      const r = 0.6 + Math.random() * 1.9;
      const v = 60 + (Math.random() * 70) | 0;
      ctx.fillStyle = `rgba(${v},${v},${v + 4},${0.10 + Math.random() * 0.18})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Subtle tire streaks
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 6;
    for (let i = 0; i < 36; i++) {
      const x0 = Math.random() * c.width;
      const y0 = Math.random() * c.height;
      const x1 = x0 + (Math.random() - 0.5) * 420;
      const y1 = y0 + (Math.random() - 0.5) * 420;
      ctx.strokeStyle = `rgb(${18 + (Math.random() * 12) | 0},${18 + (Math.random() * 12) | 0},${18 + (Math.random() * 12) | 0})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) * 0.5 + (Math.random() - 0.5) * 160, (y0 + y1) * 0.5 + (Math.random() - 0.5) * 160, x1, y1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 8;
    ASSETS.groundTex = tex;
    return tex;
  }

  function getLavaTexture() {
    if (ASSETS.lavaTex) return ASSETS.lavaTex;
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    // Flow texture (no obvious circular blobs).
    ctx.fillStyle = '#0f0307';
    ctx.fillRect(0, 0, c.width, c.height);

    // Hot streaks
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 520; i++) {
      const y = Math.random() * c.height;
      const x = Math.random() * c.width;
      const len = 40 + Math.random() * 160;
      const thick = 2 + Math.random() * 10;
      const ang = (Math.random() - 0.5) * 0.9; // mostly horizontal
      const x1 = x + Math.cos(ang) * len;
      const y1 = y + Math.sin(ang) * len;
      const g = ctx.createLinearGradient(x, y, x1, y1);
      g.addColorStop(0, `rgba(255,90,70,${0.0})`);
      g.addColorStop(0.2, `rgba(255,90,70,${0.12 + Math.random() * 0.14})`);
      g.addColorStop(0.6, `rgba(255,209,90,${0.10 + Math.random() * 0.14})`);
      g.addColorStop(1, `rgba(255,209,90,0.0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = thick;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(
        (x + x1) * 0.5 + (Math.random() - 0.5) * 60,
        (y + y1) * 0.5 + (Math.random() - 0.5) * 60,
        x1,
        y1
      );
      ctx.stroke();
    }

    // Fine grain glow
    for (let i = 0; i < 22000; i++) {
      const x = (Math.random() * c.width) | 0;
      const y = (Math.random() * c.height) | 0;
      const a = Math.random() * 0.06;
      ctx.fillStyle = `rgba(255,140,90,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Dark cracks
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 2.5;
    for (let i = 0; i < 42; i++) {
      const x0 = Math.random() * c.width;
      const y0 = Math.random() * c.height;
      const x1 = x0 + (Math.random() - 0.5) * 200;
      const y1 = y0 + (Math.random() - 0.5) * 200;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) * 0.5 + (Math.random() - 0.5) * 120, (y0 + y1) * 0.5 + (Math.random() - 0.5) * 120, x1, y1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    ASSETS.lavaTex = tex;
    return tex;
  }

  function getParticleTexture() {
    if (ASSETS.particleTex) return ASSETS.particleTex;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.encoding = THREE.sRGBEncoding;
    ASSETS.particleTex = tex;
    return tex;
  }

  function biomeColorAt(map, x, z) {
    const s = Math.max(1, map.size);
    const nx = clamp(x / s, -1, 1);
    const nz = clamp(z / s, -1, 1);
    const n = fbm2((x + 5000) * 0.00055, (z - 2000) * 0.00055);
    const warp = (n - 0.5) * 0.45;

    const tE = smoothstep(-0.25, 0.75, nx + warp);
    const tN = smoothstep(-0.25, 0.75, nz - warp);

    let wAsh = tN * (1 - tE);
    let wCrystal = tN * tE;
    let wDunes = (1 - tN) * tE;
    let wBasalt = (1 - tN) * (1 - tE);

    const dist = Math.hypot(x, z);
    const wPark = smoothstep(520, 0, dist); // strongest at center
    wAsh *= (1 - wPark);
    wCrystal *= (1 - wPark);
    wDunes *= (1 - wPark);
    wBasalt *= (1 - wPark);

    const sum = Math.max(1e-6, wAsh + wCrystal + wDunes + wBasalt);
    wAsh /= sum; wCrystal /= sum; wDunes /= sum; wBasalt /= sum;

    // Biome palette (RGB in 0..1)
    const ash = [0.62, 0.60, 0.58];
    const crystal = [0.40, 0.70, 0.85];
    const dunes = [0.78, 0.60, 0.38];
    const basalt = [0.22, 0.26, 0.33];
    const park = [0.55, 0.55, 0.55];

    let r = ash[0] * wAsh + crystal[0] * wCrystal + dunes[0] * wDunes + basalt[0] * wBasalt;
    let g = ash[1] * wAsh + crystal[1] * wCrystal + dunes[1] * wDunes + basalt[1] * wBasalt;
    let b = ash[2] * wAsh + crystal[2] * wCrystal + dunes[2] * wDunes + basalt[2] * wBasalt;

    r = lerp(r, park[0], wPark);
    g = lerp(g, park[1], wPark);
    b = lerp(b, park[2], wPark);

    const grit = (fbm2((x - 1200) * 0.0022, (z + 700) * 0.0022) - 0.5) * 0.08;
    r = clamp(r + grit, 0, 1);
    g = clamp(g + grit, 0, 1);
    b = clamp(b + grit, 0, 1);
    return [r, g, b];
  }

  function baseHeightAt(map, x, z) {
    const s = Math.max(1, map.size);
    const nx = x / s;
    const nz = z / s;
    const n0 = fbm2((x + 1000) * 0.00075, (z - 1000) * 0.00075);
    const n1 = fbm2((x - 3400) * 0.0016, (z + 2100) * 0.0016);
    let h = (n0 - 0.5) * 6.0 + (n1 - 0.5) * 1.2;

    // Dunes (SE quadrant)
    const duneW = smoothstep(-0.05, 0.55, nx) * smoothstep(-0.65, -0.05, nz);
    const dune = (Math.sin((x + 80) * 0.012) + Math.cos((z - 60) * 0.011)) * 1.3 + Math.sin((x + z) * 0.008) * 0.9;
    h += duneW * dune;

    // Crystals (NE quadrant) - gentle plateaus
    const cryW = smoothstep(-0.05, 0.55, nx) * smoothstep(-0.05, 0.65, nz);
    h += cryW * (smoothstep(0.45, 0.8, n0) * 1.8);

    // Park region flatter
    const dist = Math.hypot(x, z);
    const parkW = smoothstep(900, 260, dist);
    h = lerp(h, (n0 - 0.5) * 1.1, parkW);

    return h;
  }

  function addSkyDome() {
    if (ASSETS.skyTex) return;
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, '#05060d');
    g.addColorStop(0.55, '#070b14');
    g.addColorStop(1, '#11061a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 1200; i++) {
      const x = Math.random() * c.width;
      const y = Math.random() * c.height * 0.7;
      const a = Math.random() * 0.7;
      ctx.fillStyle = `rgba(220,235,255,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.encoding = THREE.sRGBEncoding;
    ASSETS.skyTex = tex;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(4200, 32, 16),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })
    );
    scene.add(sky);
  }

  function createSpeedFx() {
    const count = 220;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 18;
      positions[i * 3 + 1] = (Math.random() - 0.4) * 10;
      positions[i * 3 + 2] = -10 - Math.random() * 140;
    }
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(positions, 3);
    geo.setAttribute('position', attr);
    const mat = new THREE.PointsMaterial({ color: 0xcfe3ff, size: 0.12, transparent: true, opacity: 0.0, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    world.speedFxAttr = attr;
    world.speedFxPos = positions;
    return pts;
  }

  function updateSpeedFx(dt, speedNorm, boosting) {
    if (!world.speedFx || !world.speedFxAttr || !world.speedFxPos) return;
    const mat = world.speedFx.material;
    const targetOpacity = boosting ? 0.65 : speedNorm > 0.7 ? 0.45 : 0.0;
    mat.opacity = lerp(mat.opacity, targetOpacity, dt * 6);
    const speed = 60 + speedNorm * 220 + (boosting ? 280 : 0);
    for (let i = 0; i < world.speedFxPos.length; i += 3) {
      world.speedFxPos[i + 2] += speed * dt;
      world.speedFxPos[i] += (Math.random() - 0.5) * 0.6 * dt;
      world.speedFxPos[i + 1] += (Math.random() - 0.5) * 0.4 * dt;
      if (world.speedFxPos[i + 2] > -8) {
        world.speedFxPos[i] = (Math.random() - 0.5) * 18;
        world.speedFxPos[i + 1] = (Math.random() - 0.4) * 10;
        world.speedFxPos[i + 2] = -120 - Math.random() * 120;
      }
    }
    world.speedFxAttr.needsUpdate = true;
  }

  function initParticles() {
    const max = 1400;
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const vel = new Float32Array(max * 3);
    const life = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    const colAttr = new THREE.BufferAttribute(col, 3);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    const mat = new THREE.PointsMaterial({
      size: 0.34,
      map: getParticleTexture(),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 10;
    scene.add(pts);
    world.particles = { max, pos, col, vel, life, head: 0, pts, posAttr, colAttr };
  }

  function spawnParticle(x, y, z, vx, vy, vz, r, g, b, ttl) {
    if (!world.particles) return;
    const p = world.particles;
    const i = p.head++ % p.max;
    const ii = i * 3;
    p.pos[ii] = x;
    p.pos[ii + 1] = y;
    p.pos[ii + 2] = z;
    p.vel[ii] = vx;
    p.vel[ii + 1] = vy;
    p.vel[ii + 2] = vz;
    p.col[ii] = r;
    p.col[ii + 1] = g;
    p.col[ii + 2] = b;
    p.life[i] = ttl;
    p.posAttr.needsUpdate = true;
    p.colAttr.needsUpdate = true;
  }

  function updateParticles(dt, forward, input) {
    const p = world.particles;
    if (!p) return;
    const drag = Math.max(0, 1 - 1.6 * dt);
    for (let i = 0; i < p.max; i++) {
      const l = p.life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      p.life[i] = nl;
      const ii = i * 3;
      p.pos[ii] += p.vel[ii] * dt;
      p.pos[ii + 1] += p.vel[ii + 1] * dt;
      p.pos[ii + 2] += p.vel[ii + 2] * dt;
      p.vel[ii] *= drag;
      p.vel[ii + 1] = (p.vel[ii + 1] - 0.35 * dt) * drag;
      p.vel[ii + 2] *= drag;
      if (nl <= 0) p.pos[ii + 1] = -9999;
    }
    p.posAttr.needsUpdate = true;

    // Drift smoke
    if (game.drifting && game.speed > 8) {
      const back = forward.clone().multiplyScalar(-2.1);
      for (let k = 0; k < 2; k++) {
        spawnParticle(
          game.pos.x + back.x + (Math.random() - 0.5) * 0.7,
          0.25 + Math.random() * 0.2,
          game.pos.z + back.z + (Math.random() - 0.5) * 0.7,
          back.x * (0.6 + Math.random() * 0.6) + (Math.random() - 0.5) * 1.2,
          1.2 + Math.random() * 0.7,
          back.z * (0.6 + Math.random() * 0.6) + (Math.random() - 0.5) * 1.2,
          0.55, 0.65, 0.8,
          0.55 + Math.random() * 0.35
        );
      }
    }

    // Boost sparks
    if (input.boost && game.boost > 0) {
      const back = forward.clone().multiplyScalar(-1.2);
      spawnParticle(
        game.pos.x + back.x + (Math.random() - 0.5) * 0.5,
        0.35 + Math.random() * 0.25,
        game.pos.z + back.z + (Math.random() - 0.5) * 0.5,
        back.x * (3.5 + Math.random() * 2.0) + (Math.random() - 0.5) * 2.2,
        2.0 + Math.random() * 1.8,
        back.z * (3.5 + Math.random() * 2.0) + (Math.random() - 0.5) * 2.2,
        1.0, 0.85, 0.55,
        0.22 + Math.random() * 0.18
      );
    }
  }

  /* Renderer & Scene */
  function initRenderer() {
    renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    camera = new THREE.PerspectiveCamera(CFG.fovBase, window.innerWidth / window.innerHeight, 0.1, 3000);
    camera.position.set(0, CFG.cameraHeight, CFG.cameraBack);
    camera.lookAt(0, 0, 0);
  }

  function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04070f);
    scene.fog = new THREE.Fog(0x04070f, 80, 2600);
    const hemi = new THREE.HemisphereLight(0x7fb9ff, 0x0a0c16, 0.9);
    const sun = new THREE.DirectionalLight(0xfff1d0, 0.9);
    sun.position.set(160, 260, -160);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -520;
    sun.shadow.camera.right = 520;
    sun.shadow.camera.top = 520;
    sun.shadow.camera.bottom = -520;
    scene.add(hemi, sun);

    world.arenaGroup = new THREE.Group();
    scene.add(world.arenaGroup);

    addSkyDome();
    world.speedFx = createSpeedFx();
    camera.add(world.speedFx);
    scene.add(camera);
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
    const bodyMat = new THREE.MeshStandardMaterial({ color, emissive: accent, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.65, 3.2), bodyMat);
    body.castShadow = true; body.receiveShadow = true; g.add(body);

    const cabMat = new THREE.MeshStandardMaterial({ color: 0x0c1320, emissive: 0x0c1320, roughness: 0.55, metalness: 0.05 });
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.58, 1.25), cabMat);
    cab.position.set(0, 0.56, -0.1); cab.castShadow = true; g.add(cab);

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.8, 1.4),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.24, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, -0.33, 0.2);
    glow.renderOrder = 1;
    g.add(glow);

    const lightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xcfe3ff, emissiveIntensity: 1.2, roughness: 0.25, metalness: 0.05 });
    const headL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.05), lightMat);
    const headR = headL.clone();
    headL.position.set(-0.55, 0.1, 1.62);
    headR.position.set(0.55, 0.1, 1.62);
    g.add(headL, headR);

    const tailMat = new THREE.MeshStandardMaterial({ color: 0xff3b2b, emissive: 0xff3b2b, emissiveIntensity: 1.2, roughness: 0.35, metalness: 0.05 });
    const tailL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.05), tailMat);
    const tailR = tailL.clone();
    tailL.position.set(-0.55, 0.12, -1.62);
    tailR.position.set(0.55, 0.12, -1.62);
    g.add(tailL, tailR);

    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.5, 12); wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111, roughness: 0.8 });
    const wheels = [];
    [[0.75, -0.3, 1], [-0.75, -0.3, 1], [0.75, -0.3, -1], [-0.75, -0.3, -1]].forEach(o => {
      const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(o[0], o[1], o[2]); w.castShadow = true; g.add(w);
      wheels.push(w);
    });
    g.userData.wheels = wheels;
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
      const scaleSel = document.querySelector('#settingSpeedScale'); if (scaleSel) scaleSel.value = String(game.settings.speedScale ?? 1);
      show(ui.settingsOverlay);
    });
    document.querySelector('#closeSettings').addEventListener('click', () => {
      game.settings.sound = document.querySelector('#settingSound').value;
      game.settings.gfx = document.querySelector('#settingGfx').value;
      game.settings.controls = document.querySelector('#settingControls').value;
      const scaleSel = document.querySelector('#settingSpeedScale'); if (scaleSel) game.settings.speedScale = Number(scaleSel.value || 1);
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
      card.innerHTML = `<div class="name">${m.name}</div><div class="muted tiny">${m.desc}</div><div class="muted tiny">${m.difficulty} &middot; Arena</div>`;
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
    game.speed = 0; game.drift = 0; game.boost = 0; game.boostPulse = 0; game.heat = 0; game.combo = 1; game.comboTimer = 0; game.score = 0; game.runTime = 0;
    game.pickupTimer = CFG.pickupInterval; game.rivalTimer = CFG.rivalInterval; game.autopilotTime = 0;
    game.shake = 0; game.lastDt = 0; game.steerInput = 0;
    game.invuln = 0;
    game.grounded = true;
    game.groundY = 0;
    game.groundNormal.set(0, 1, 0);
    game.onRamp = false;
    game.rampId = -1;
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

    // Biome terrain (heightfield + vertex-color tint).
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.02,
      emissive: 0x180208,
      emissiveIntensity: 0.28,
      vertexColors: true,
    });
    const gRepeat = def.size / 130;
    const lavaTex = getLavaTexture();
    const floorTex = lavaTex.clone();
    floorTex.needsUpdate = true;
    floorTex.repeat.set(gRepeat, gRepeat);
    const floorEm = lavaTex.clone();
    floorEm.needsUpdate = true;
    floorEm.repeat.set(gRepeat, gRepeat);
    groundMat.map = floorTex;
    groundMat.emissiveMap = floorEm;
    world.floor = { map: floorTex, emissiveMap: floorEm };

    const groundSize = def.size * 2.6;
    const segs = clamp(Math.floor(def.size / 14), 140, 240);
    const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize, segs, segs);
    groundGeo.rotateX(-Math.PI / 2);
    const posAttr = groundGeo.attributes.position;
    const colorAttr = new Float32Array(posAttr.count * 3);

    // Carve the terrain slightly under stunts so ramps/platforms don't look "buried" in noisy ground.
    const rampCarves = (def.ramps || []).map(r => {
      const yaw = r.yaw || 0;
      const cos = Math.cos(-yaw);
      const sin = Math.sin(-yaw);
      const dirX = Math.sin(yaw);
      const dirZ = Math.cos(yaw);
      const lowX = r.x - dirX * (r.l * 0.5);
      const lowZ = r.z - dirZ * (r.l * 0.5);
      const baseY = baseHeightAt(def, lowX, lowZ);
      return { x: r.x, z: r.z, w: r.w, l: r.l, h: r.h, cos, sin, baseY };
    });
    const platformThickness = 1.2;
    const platCarves = (def.platforms || []).map(p => {
      const yaw = p.yaw || 0;
      const cos = Math.cos(-yaw);
      const sin = Math.sin(-yaw);
      const baseY = baseHeightAt(def, p.x, p.z);
      const carveY = baseY + p.y - platformThickness - 0.35;
      return { x: p.x, z: p.z, w: p.w, l: p.l, cos, sin, carveY };
    });
    const ringCarves = (def.rings || []).map(r => {
      const baseY = baseHeightAt(def, r.x, r.z);
      const carveY = baseY + r.y - 0.35;
      return { x: r.x, z: r.z, inner: r.inner, outer: r.outer, carveY };
    });
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      let y = baseHeightAt(def, x, z);

      for (let j = 0; j < rampCarves.length; j++) {
        const r = rampCarves[j];
        const dx = x - r.x;
        const dz = z - r.z;
        const lx = dx * r.cos - dz * r.sin;
        const lz = dx * r.sin + dz * r.cos;
        if (Math.abs(lx) > r.w * 0.6 || lz < -r.l * 0.6 || lz > r.l * 0.6) continue;
        const t = (lz + r.l * 0.5) / r.l;
        const ry = r.baseY + clamp(t, 0, 1) * r.h;
        y = Math.min(y, ry - 0.45);
      }
      for (let j = 0; j < platCarves.length; j++) {
        const p = platCarves[j];
        const dx = x - p.x;
        const dz = z - p.z;
        const lx = dx * p.cos - dz * p.sin;
        const lz = dx * p.sin + dz * p.cos;
        if (Math.abs(lx) <= p.w * 0.55 && Math.abs(lz) <= p.l * 0.55) y = Math.min(y, p.carveY);
      }
      for (let j = 0; j < ringCarves.length; j++) {
        const r = ringCarves[j];
        const d = Math.hypot(x - r.x, z - r.z);
        if (d >= r.inner && d <= r.outer) y = Math.min(y, r.carveY);
      }
      posAttr.setY(i, y);
      const [r, g, b] = biomeColorAt(def, x, z);
      colorAttr[i * 3] = r;
      colorAttr[i * 3 + 1] = g;
      colorAttr[i * 3 + 2] = b;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));
    groundGeo.computeVertexNormals();

    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.receiveShadow = true;
    world.arenaGroup.add(ground);

    function makeWedgeGeometry(w, l, h) {
      const hw = w * 0.5;
      const hl = l * 0.5;
      const verts = new Float32Array([
        // bottom
        -hw, 0, -hl,
         hw, 0, -hl,
         hw, 0,  hl,
        -hw, 0,  hl,
        // top (start is 0, end is h)
        -hw, 0, -hl,
         hw, 0, -hl,
         hw, h,  hl,
        -hw, h,  hl,
      ]);
      const idx = [
        // bottom
        0, 2, 1, 0, 3, 2,
        // top
        4, 5, 6, 4, 6, 7,
        // left
        0, 4, 7, 0, 7, 3,
        // right
        1, 2, 6, 1, 6, 5,
        // back (low end)
        0, 1, 5, 0, 5, 4,
        // front (high end)
        3, 7, 6, 3, 6, 2,
      ];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }

    // Ramps (jumps) + platforms/rings (stunt park)
    world.ramps = [];
    world.stunts = { ramps: [], platforms: [], rings: [] };
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2f, roughness: 0.82, metalness: 0.06, emissive: 0x080a0f, emissiveIntensity: 0.35 });
    (def.ramps || []).forEach(r => {
      const yaw = r.yaw || 0;
      const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const lowX = r.x - dir.x * (r.l * 0.5);
      const lowZ = r.z - dir.z * (r.l * 0.5);
      const baseY = baseHeightAt(def, lowX, lowZ);
      const geo = makeWedgeGeometry(r.w, r.l, r.h);
      const mesh = new THREE.Mesh(geo, rampMat);
      mesh.rotation.y = yaw;
      mesh.position.set(r.x, baseY, r.z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      world.arenaGroup.add(mesh);
      const rr = { ...r, id: world.ramps.length, yaw, baseY, slope: r.h / r.l, dir, mesh };
      world.ramps.push(rr);
      world.stunts.ramps.push(rr);
    });

    const platMat = new THREE.MeshStandardMaterial({ color: 0x21242b, roughness: 0.9, metalness: 0.05, emissive: 0x05060a, emissiveIntensity: 0.2 });
    (def.platforms || []).forEach(p => {
      const baseY = baseHeightAt(def, p.x, p.z);
      const geo = new THREE.BoxGeometry(p.w, platformThickness, p.l);
      const mesh = new THREE.Mesh(geo, platMat);
      mesh.rotation.y = p.yaw || 0;
      mesh.position.set(p.x, baseY + p.y - platformThickness * 0.5, p.z);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      world.arenaGroup.add(mesh);
      world.stunts.platforms.push({ ...p, baseY });
    });

    const ringMat = new THREE.MeshStandardMaterial({ color: 0x1c2028, roughness: 0.92, metalness: 0.04, emissive: 0x05060a, emissiveIntensity: 0.22, side: THREE.DoubleSide });
    (def.rings || []).forEach(r => {
      const geo = new THREE.RingGeometry(r.inner, r.outer, 90);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, ringMat);
      const baseY = baseHeightAt(def, r.x, r.z);
      mesh.position.set(r.x, baseY + r.y, r.z);
      mesh.receiveShadow = true;
      world.arenaGroup.add(mesh);
      world.stunts.rings.push({ ...r, baseY });
    });

    // Remove circle decals on the floor (hazards/boost rings are not rendered).

    const propGeo = new THREE.ConeGeometry(2, 9, 6);
    const propMat = new THREE.MeshStandardMaterial({ color: 0x7cf0d8, emissive: 0x1f3a32, roughness: 0.55, metalness: 0.12 });
    const propCount = Math.floor(def.size / 9);
    const props = new THREE.InstancedMesh(propGeo, propMat, propCount);
    props.castShadow = true;
    props.receiveShadow = true;
    const m = new THREE.Matrix4();
    const rot = new THREE.Matrix4();
    const scl = new THREE.Matrix4();
    for (let i = 0; i < propCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = def.size * (0.82 + Math.random() * 0.34);
      const h = 6 + Math.random() * 10;
      m.makeTranslation(Math.cos(ang) * dist, h * 0.5, Math.sin(ang) * dist);
      rot.makeRotationY(Math.random() * Math.PI * 2);
      scl.makeScale(0.85 + Math.random() * 0.65, h / 9, 0.85 + Math.random() * 0.65);
      m.multiply(rot).multiply(scl);
      props.setMatrixAt(i, m);
    }
    world.arenaGroup.add(props);

    const rockGeo = new THREE.IcosahedronGeometry(1.6, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x1a2233, roughness: 0.95, metalness: 0.02, emissive: 0x070a12, emissiveIntensity: 0.15 });
    const rockCount = Math.floor(def.size / 6);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    for (let i = 0; i < rockCount; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = def.size * (0.2 + Math.random() * 0.78);
      const x = Math.cos(ang) * dist;
      const z = Math.sin(ang) * dist;
      m.makeTranslation(x, 0.8, z);
      rot.makeRotationY(Math.random() * Math.PI * 2);
      scl.makeScale(0.55 + Math.random() * 1.6, 0.55 + Math.random() * 1.3, 0.55 + Math.random() * 1.6);
      m.multiply(rot).multiply(scl);
      rocks.setMatrixAt(i, m);
    }
    world.arenaGroup.add(rocks);

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
    const leftDown = keys[left] || touch.left;
    const rightDown = keys[right] || touch.right;
    return {
      // Steer axis: left is negative, right is positive (so the yawVel formula below can be positive).
      steer: (rightDown ? 1 : 0) - (leftDown ? 1 : 0),
      left: leftDown,
      right: rightDown,
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
      left: false,
      right: false,
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
    game.lastDt = dt;
    game.fps = game.fps ? lerp(game.fps, 1 / dt, 0.08) : 1 / dt;

    const speedScale = Number(game.settings.speedScale || 1);
    const speedXZ = Math.hypot(game.vel.x, game.vel.z);
    const speed01 = clamp(speedXZ / Math.max(1, CFG.steerRefSpeed * speedScale), 0, 1);

    const steerInput = input.steer;
    game.steerInput = steerInput;
    const accel01 = clamp(speedXZ / Math.max(1, CFG.fxRefSpeed * 2.5 * speedScale), 0, 1);
    const throttleCurve = 1 - Math.pow(accel01, CFG.throttleCurve);
    const effAccel = CFG.accel * throttleCurve;

    const groundedSteerMul = game.grounded ? 1 : CFG.airSteerMul;
    const groundedGripMul = game.grounded ? 1 : CFG.airGripMul;
    const steerGrip = (input.drift ? CFG.driftGrip : CFG.lateralGrip) * game.mod.grip * groundedGripMul;
    const steerRate = (input.drift ? CFG.steerDrift : CFG.steer) * game.mod.steer * groundedSteerMul * (0.55 + (1 - speed01) * 0.6);
    game.yawVel = lerp(game.yawVel, (steerInput) * steerRate, dt * (input.drift ? 6 : 8));
    game.yaw += game.yawVel * dt;

    // Ground-aligned basis: climbing ramps feels natural and launches happen at edges (no "snap to top").
    const groundN = game.grounded ? game.groundNormal : UP;
    const forward = new THREE.Vector3(Math.sin(game.yaw), 0, Math.cos(game.yaw));
    if (game.grounded) {
      forward.addScaledVector(groundN, -forward.dot(groundN));
      if (forward.lengthSq() < 1e-6) forward.set(Math.sin(game.yaw), 0, Math.cos(game.yaw));
      forward.normalize();
    }
    const right = new THREE.Vector3().crossVectors(groundN, forward).normalize();

    if (input.accel) game.vel.addScaledVector(forward, effAccel * dt);
    if (input.brake) game.vel.addScaledVector(forward, -CFG.brake * dt);

    const fSpeed = game.vel.dot(forward);
    let side = game.vel.dot(right);
    side = lerp(side, 0, dt * steerGrip);
    const nSpeed = game.vel.dot(groundN);
    game.vel.copy(forward.clone().multiplyScalar(fSpeed)).add(right.clone().multiplyScalar(side)).addScaledVector(groundN, nSpeed);

    const baseDrag = CFG.drag + (input.accel ? 0 : CFG.coastDrag);
    const dragMul = Math.max(0, 1 - baseDrag * dt);
    game.vel.x *= dragMul;
    game.vel.z *= dragMul;

    const scoreMult = 1;
    if (input.drift && game.grounded) {
      game.drift = clamp(game.drift + CFG.driftGain * dt, 0, 100);
      game.vel.x *= 0.995;
      game.vel.z *= 0.995;
      game.drifting = true;
      if (game.drift > 25) { addCombo(0.05 * dt); game.score += 3 * dt * scoreMult; }
    } else if (game.drifting) {
      if (game.drift > 5) {
        const release01 = clamp(game.drift / 100, 0, 1);
        const gain = game.drift * CFG.boostGain * game.mod.boostGain;
        game.boost = clamp(game.boost + gain, 0, 140);
        game.boostPulse = Math.max(game.boostPulse, 0.22 + release01 * 0.55);
        game.vel.addScaledVector(forward, CFG.boostImpulse * (0.3 + release01));
        game.shake = Math.max(game.shake, 0.22 + release01 * 0.35);
        addCombo(0.35 + release01 * 0.4);
        game.score += (70 + 180 * release01) * game.combo * scoreMult;
        playTone(560 + release01 * 180, 0.07, 0.12);
        setToast('Drift boost!');
      }
      game.drift = 0;
      game.drifting = false;
    }

    if (input.boost && game.boost > 0) {
      game.vel.addScaledVector(forward, CFG.boostPower * dt);
      game.boost = clamp(game.boost - CFG.boostDrain * dt * game.mod.boostDrain, 0, 140);
      game.shake = Math.max(game.shake, 0.35);
    }
    if (game.boostPulse > 0) { game.vel.addScaledVector(forward, CFG.boostImpulse * dt); game.boostPulse -= dt; game.shake = Math.max(game.shake, 0.25); }

    // Integrate motion (full 3D), then resolve contact against the height-function (terrain + stunts).
    game.vel.y -= CFG.gravity * dt;
    game.pos.addScaledVector(game.vel, dt);
    clampToArena(game.map, game.pos, game.vel);

    const allowMidRampId = game.onRamp ? game.rampId : -1;
    const g = sampleGround(game.pos.x, game.pos.z, allowMidRampId);
    game.groundY = g.y;
    const dist = game.pos.y - game.groundY;
    if (dist <= CFG.groundContactEps) {
      const n = getGroundNormal(game.pos.x, game.pos.z, allowMidRampId);
      const vnn = game.vel.dot(n);
      if (dist < 0 || vnn <= CFG.groundStickVel) {
        game.pos.y = game.groundY;
        if (vnn < 0) {
          const impact = -vnn;
          if (impact > 10) {
            game.shake = Math.max(game.shake, clamp((impact - 10) / 24, 0, 0.75));
            if (impact > 18) playTone(180 + Math.min(220, impact * 8), 0.04, 0.08);
          }
          game.vel.addScaledVector(n, -vnn);
        }
        game.grounded = true;
        game.groundNormal.lerp(n, 0.35);
        game.groundNormal.normalize();
        game.onRamp = !!g.ramp;
        game.rampId = g.ramp ? g.ramp.id : -1;
      } else {
        game.grounded = false;
        game.onRamp = false;
        game.rampId = -1;
        game.groundNormal.copy(UP);
      }
    } else {
      game.grounded = false;
      game.onRamp = false;
      game.rampId = -1;
      game.groundNormal.copy(UP);
    }

    game.speed = Math.hypot(game.vel.x, game.vel.z);
    const speedNormNow = clamp(game.speed / Math.max(1, CFG.fxRefSpeed * speedScale), 0, 1);

    applyHazards(dt, game.pos);
    animateArenaFx(game.runTime);
    updateSpeedFx(dt, speedNormNow, !!(input.boost || game.boostPulse > 0.01));
    updateParticles(dt, forward, input);

    game.comboTimer = Math.max(0, game.comboTimer - dt);
    if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.2 * dt);
    game.score += (game.speed * 0.06 + ((input.drift && game.grounded) ? 3 : 0)) * dt * game.combo * scoreMult;

    game.invuln = Math.max(0, game.invuln - dt);
    game.shake = Math.max(0, game.shake - dt * 1.6);

    updatePickups(dt);
    updateRivals(dt);
    updatePlayerMesh(forward, dt);
    updateCamera(forward);
    updateHUD();
  }

  function clampToArena(map, pos, vel) {
    const limit = map.size;
    let bounced = false;
    const d = Math.hypot(pos.x, pos.z);
    if (d > limit) {
      const inv = 1 / Math.max(1e-6, d);
      const dir = new THREE.Vector3(pos.x * inv, 0, pos.z * inv);
      pos.x = dir.x * (limit * 0.995);
      pos.z = dir.z * (limit * 0.995);
      const horiz = new THREE.Vector3(vel.x, 0, vel.z).reflect(dir).multiplyScalar(CFG.arenaBounce);
      vel.x = horiz.x;
      vel.z = horiz.z;
      game.shake = Math.max(game.shake, 0.5);
      bounced = true;
    }
  }

  function applyHazards(dt, pos) {
    // Visual-only lava embers; no slowdown/overheat mechanics.
    game.map.hazards?.forEach(h => {
      const d2 = (pos.x - h.x) ** 2 + (pos.z - h.z) ** 2;
      if (d2 < h.r * h.r && Math.random() < 10 * dt) {
        const ang = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * h.r;
        spawnParticle(
          h.x + Math.cos(ang) * rr,
          0.2 + Math.random() * 0.2,
          h.z + Math.sin(ang) * rr,
          (Math.random() - 0.5) * 3.0,
          3.0 + Math.random() * 2.5,
          (Math.random() - 0.5) * 3.0,
          1.0, 0.45 + Math.random() * 0.2, 0.25,
          0.35 + Math.random() * 0.35
        );
      }
    });
  }

  function animateArenaFx(t) {
    const lavaOx = (t * 0.03) % 1;
    const lavaOy = (t * 0.02) % 1;
    if (world.floor?.map) world.floor.map.offset.set(lavaOx, lavaOy);
    if (world.floor?.emissiveMap) world.floor.emissiveMap.offset.set(lavaOx, lavaOy);
    for (let i = 0; i < world.hazardMeshes.length; i++) {
      const mat = world.hazardMeshes[i].mesh.material;
      if (mat && 'emissiveIntensity' in mat) mat.emissiveIntensity = 0.95 + 0.35 * Math.sin(t * 2.8 + i);
      if (mat && mat.map) mat.map.offset.set(lavaOx, lavaOy);
      if (mat && mat.emissiveMap) mat.emissiveMap.offset.set(lavaOx, lavaOy);
    }
    for (let i = 0; i < world.boostMeshes.length; i++) {
      const mesh = world.boostMeshes[i].mesh;
      const mat = mesh.material;
      if (mat && 'emissiveIntensity' in mat) mat.emissiveIntensity = 0.85 + 0.45 * Math.sin(t * 3.2 + i);
      mesh.rotation.y = t * 0.7 + i * 0.4;
    }
  }

  // Heat/boost zones are visual-only now.

  function sampleGround(x, z, allowMidRampId = -1) {
    const map = game.map;
    if (!map) return { y: 0, ramp: null };

    let bestY = baseHeightAt(map, x, z);
    let bestRamp = null;

    const ramps = world.stunts?.ramps || [];
    for (let i = 0; i < ramps.length; i++) {
      const r = ramps[i];
      const yaw = r.yaw || 0;
      const cos = Math.cos(-yaw);
      const sin = Math.sin(-yaw);
      const dx = x - r.x;
      const dz = z - r.z;
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) > r.w * 0.5 || lz < -r.l * 0.5 || lz > r.l * 0.5) continue;

      const t = (lz + r.l * 0.5) / r.l; // 0..1 along ramp (low->high)
      const allow = (r.id === allowMidRampId) || (t < 0.18); // prevents side "teleport to top"
      if (!allow) continue;

      const y = r.baseY + clamp(t, 0, 1) * r.h;
      if (y > bestY) {
        bestY = y;
        bestRamp = { id: r.id };
      }
    }

    const plats = world.stunts?.platforms || [];
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      const yaw = p.yaw || 0;
      const cos = Math.cos(-yaw);
      const sin = Math.sin(-yaw);
      const dx = x - p.x;
      const dz = z - p.z;
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) <= p.w * 0.5 && Math.abs(lz) <= p.l * 0.5) {
        const y = p.baseY + p.y;
        if (y > bestY) bestY = y;
      }
    }

    const rings = world.stunts?.rings || [];
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const dx = x - r.x;
      const dz = z - r.z;
      const d = Math.hypot(dx, dz);
      if (d >= r.inner && d <= r.outer) {
        const y = r.baseY + r.y;
        if (y > bestY) bestY = y;
      }
    }

    return { y: bestY, ramp: bestRamp };
  }

  const _tmpGroundN = new THREE.Vector3();
  function getGroundNormal(x, z, allowMidRampId = -1) {
    const e = 1.35;
    const hL = sampleGround(x - e, z, allowMidRampId).y;
    const hR = sampleGround(x + e, z, allowMidRampId).y;
    const hD = sampleGround(x, z - e, allowMidRampId).y;
    const hU = sampleGround(x, z + e, allowMidRampId).y;
    _tmpGroundN.set(hL - hR, 2 * e, hD - hU);
    if (_tmpGroundN.lengthSq() < 1e-8) _tmpGroundN.set(0, 1, 0);
    else _tmpGroundN.normalize();
    return _tmpGroundN;
  }

  function updatePlayerMesh(forward, dt) {
    playerMesh.position.copy(game.pos);
    playerMesh.position.y = game.pos.y + 0.6;
    playerMesh.rotation.y = Math.atan2(forward.x, forward.z);
    const pitchTarget = clamp(-game.vel.y * 0.02, -0.35, 0.35);
    playerMesh.rotation.x = lerp(playerMesh.rotation.x || 0, pitchTarget, 0.12);
    const wheels = playerMesh.userData?.wheels;
    if (wheels && wheels.length) {
      const signedSpeed = game.vel.dot(forward);
      const spin = (signedSpeed / 0.35) * dt;
      for (let i = 0; i < wheels.length; i++) wheels[i].rotation.x += spin;
    }
    if (playerShadow) {
      const h = clamp(game.pos.y - (game.groundY || 0), 0, 18);
      const s = 1 / (1 + h * 0.12);
      playerShadow.position.set(game.pos.x, (game.groundY || 0) + 0.02, game.pos.z);
      playerShadow.scale.set(s, s, 1);
      playerShadow.material.opacity = 0.35 * clamp(1 - h * 0.06, 0.15, 1);
    }
  }

  function updateCamera(forward) {
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const target = game.pos.clone()
      .addScaledVector(forward, -CFG.cameraBack)
      .addScaledVector(right, 0.4)
      .add(new THREE.Vector3(0, CFG.cameraHeight, 0));
    if (game.shake > 0) {
      target.add(new THREE.Vector3(
        (Math.random() - 0.5) * game.shake,
        (Math.random() - 0.5) * game.shake * 0.5,
        (Math.random() - 0.5) * game.shake
      ));
    }
    camera.position.lerp(target, CFG.cameraLag);
    camera.lookAt(game.pos.x, game.pos.y + 1.2, game.pos.z);
    const speedNorm = clamp(game.speed / Math.max(1, CFG.fxRefSpeed * (Number(game.settings.speedScale || 1))), 0, 1);
    camera.fov = lerp(camera.fov, CFG.fovBase + speedNorm * CFG.fovBoost, 0.12);
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
    const type = 'coin';
    mesh.material.color.setHex(0xff9f40);
    mesh.material.emissive.setHex(0xff9f40);
    activePickups.push({ pos, type, mesh });
  }

  function insideHazard(map, pos) {
    return (map.hazards || []).some(h => {
      const d2 = (pos.x - h.x) ** 2 + (pos.z - h.z) ** 2;
      return d2 < h.r * h.r;
    });
  }

  function collectPickup(p) {
    if (p.type === 'coin') {
      game.score += 180 * game.combo;
      addCombo(0.5);
      playTone(480, 0.06, 0.12);
      setToast('Coin');
    }
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
    pos.y = sampleGround(pos.x, pos.z, -1).y;
    const type = pick(['racer', 'blocker', 'hunter']);
    activeRivals.push({ pos, vel: new THREE.Vector3(), yaw: Math.random() * Math.PI * 2, speed: 0, mesh, type, nearCd: 0 });
  }

  function updateRivals(dt) {
    game.rivalTimer -= dt;
    if (game.rivalTimer <= 0 && activeRivals.length < CFG.rivalMax) { spawnRival(); game.rivalTimer = CFG.rivalInterval; }
    const speedScale = Number(game.settings.speedScale || 1);
    const rivalTop = Math.max(65, game.speed * 0.78 + 35);
    for (let i = activeRivals.length - 1; i >= 0; i--) {
      const r = activeRivals[i];
      r.hitCd = Math.max(0, (r.hitCd || 0) - dt);
      const toPlayer = new THREE.Vector3(game.pos.x - r.pos.x, 0, game.pos.z - r.pos.z);
      const dir = toPlayer.clone();
      if (dir.lengthSq() > 1e-8) dir.normalize();
      else dir.set(Math.cos(i), 0, Math.sin(i));
      const side = new THREE.Vector3(dir.z, 0, -dir.x);
      let laneOffset = 0;
      if (r.type === 'blocker') laneOffset = Math.sin(game.runTime * 1.4 + i) * 0.45;
      if (r.type === 'hunter') laneOffset = Math.sin(game.runTime * 2.6 + i) * 0.25;
      const desiredDir = dir.clone().addScaledVector(side, laneOffset).normalize();
      r.vel.addScaledVector(desiredDir, (CFG.rivalAccel * (0.85 + Math.random() * 0.3)) * dt);
      r.vel.multiplyScalar(Math.max(0, 1 - CFG.rivalDrag * dt));
      if (r.vel.length() > rivalTop) r.vel.setLength(rivalTop);
      r.speed = r.vel.length();
      r.pos.addScaledVector(r.vel, dt);
      clampToArena(game.map, r.pos, r.vel);
      r.pos.y = sampleGround(r.pos.x, r.pos.z, -1).y;
      r.yaw = Math.atan2(r.vel.x, r.vel.z);
      r.mesh.position.copy(r.pos); r.mesh.position.y = r.pos.y + 0.55;
      r.mesh.rotation.y = r.yaw;

      r.nearCd = Math.max(0, (r.nearCd || 0) - dt);
      const dz = Math.hypot(game.pos.x - r.pos.x, game.pos.z - r.pos.z);
      if (dz > 3 && dz < 8 && r.nearCd <= 0) {
        addCombo(0.12);
        game.score += 18;
        r.nearCd = 1;
      }
      if (dz < 2.85 && r.hitCd <= 0 && game.invuln <= 0 && game.pos.y < 1.2) {
        respawnPlayer();
        r.vel.multiplyScalar(0.6);
        r.hitCd = 0.6;
      }
    }
  }

  function respawnPlayer() {
    const map = game.map;
    if (!map) return;

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 18; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.random() * map.size * 0.85;
      const p = new THREE.Vector3(Math.cos(ang) * rr, 0, Math.sin(ang) * rr);
      let minD2 = Infinity;
      for (let j = 0; j < activeRivals.length; j++) {
        const d2 = p.distanceToSquared(activeRivals[j].pos);
        if (d2 < minD2) minD2 = d2;
      }
      if (minD2 > bestScore) { bestScore = minD2; best = p; }
    }

    if (best) game.pos.copy(best);
    game.pos.y = sampleGround(game.pos.x, game.pos.z, -1).y;
    game.vel.set(0, 0, 0);
    game.yaw = Math.random() * Math.PI * 2;
    game.yawVel = 0;
    game.grounded = true;
    game.groundY = game.pos.y;
    game.groundNormal.copy(UP);
    game.invuln = 1.25;
    game.shake = Math.max(game.shake, 0.8);
    addCombo(-1.0);
    setToast('Respawn');
    playTone(240, 0.07, 0.12);
  }

  function bump() {
    game.vel.multiplyScalar(0.7);
    addCombo(-0.5);
    playTone(220, 0.08, 0.14);
    game.shake = Math.max(game.shake, 0.6);
    for (let i = 0; i < 10; i++) {
      spawnParticle(
        game.pos.x + (Math.random() - 0.5) * 1.2,
        0.4 + Math.random() * 0.6,
        game.pos.z + (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 8,
        3 + Math.random() * 4,
        (Math.random() - 0.5) * 8,
        1.0, 0.7, 0.35,
        0.25 + Math.random() * 0.25
      );
    }
  }

  function addCombo(v) { game.combo = clamp(game.combo + v, 1, 9); game.comboTimer = 3; }

  /* HUD & render */
  function render() {
    if (renderer && scene && camera) renderer.render(scene, camera);
    if (game.debug) {
      debugBox.style.display = 'block';
      debugBox.textContent = [
        `fps ${game.fps.toFixed(0)} dt ${game.lastDt.toFixed(3)}`,
        `spd ${game.speed.toFixed(1)} steer ${game.steerInput.toFixed(2)} drifting ${game.drifting ? 'Y' : 'N'} shake ${game.shake.toFixed(2)}`,
        `drift ${game.drift.toFixed(1)} boost ${game.boost.toFixed(1)} combo x${game.combo.toFixed(1)} invuln ${game.invuln.toFixed(2)}`,
        `score ${game.score.toFixed(0)} pos ${game.pos.x.toFixed(1)},${game.pos.z.toFixed(1)}`,
        `map ${MAPS[game.mapIndex].id} rivals ${activeRivals.length} pickups ${activePickups.length}`,
      ].join('\\n');
    } else debugBox.style.display = 'none';
  }

  function updateHUD() {
    ui.hudSpeed.textContent = game.speed.toFixed(0);
    ui.hudScore.textContent = game.score.toFixed(0);
    ui.hudCombo.textContent = `x${game.combo.toFixed(1)}`;
    ui.hudLap.textContent = `${MAPS[game.mapIndex].name} - ${game.runTime.toFixed(1)}s`;
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
    document.querySelector('#gameoverStats').textContent = `Score ${game.score.toFixed(0)} - Time ${game.runTime.toFixed(1)}s`;
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
    // Keep preview simple (no circle decals).
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
