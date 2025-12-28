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
- Speed: update() integrates game.vel with (CFG.accel/brake) and drag; top speed is governed by CFG.maxSpeed + CFG.throttleCurve and dt clamped via CFG.dtMax.
- Steering: readInput() returns steer axis where left is negative and right is positive; update() applies steer -> yawVel -> yaw; forward = (sin(yaw), 0, cos(yaw)).
- HUD: updateHUD() updates DOM (#hud*). Blur was caused by HUD being behind the topbar backdrop-filter due to stacking context; fixed in CSS (see style.css).
*/

(() => {
  'use strict';

  /* Helpers */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)] || arr[0];

  const ASSETS = { groundTex: null, skyTex: null, lavaTex: null, particleTex: null };

  /* Config */
  const CFG = {
    dtMax: 0.05,
    maxSpeed: 92,
    accel: 62,
    brake: 120,
    drag: 0.32,
    coastDrag: 0.55,
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
    maxHeat: 100,
    heatGainDrift: 16,
    heatGainBoost: 22,
    heatGainHazard: 40,
    heatCool: 10,
    hazardSlow: 0.75,
    heatCashBase: 90,
    heatCashPerPoint: 10,
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
    rivalAccel: 85,
    rivalDrag: 0.16,
    rivalMaxFactor: 0.92,
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
    { id: 'cool', name: 'Heat Bank', desc: 'Coolant cash-in +25%.', apply: g => g.mod.heatCash *= 1.25 },
    { id: 'grip', name: 'Grip Gel', desc: 'Grip up, cornering is steadier.', apply: g => { g.mod.grip *= 1.14; } },
    { id: 'boost', name: 'Ion Boost', desc: 'Boost gain +20%, drain -10%.', apply: g => { g.mod.boostGain *= 1.2; g.mod.boostDrain *= 0.9; } },
    { id: 'shield', name: 'Phase Shield', desc: 'Start with one shield hit.', apply: g => { g.mod.shield = true; } },
    { id: 'magnet', name: 'Pick Magnet', desc: 'Pickups pull from farther.', apply: g => { g.mod.pickRange *= 1.4; } },
    { id: 'resist', name: 'Lava Treads', desc: 'Hazard slowdown -25%.', apply: g => { g.mod.hazardSlow *= 0.75; } },
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
    return { coolRate: 1, grip: 1, steer: 1, boostGain: 1, boostDrain: 1, hazardSlow: 1, pickRange: 1, heatCash: 1, shield: false };
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
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, c.width, c.height);
    const g = ctx.createRadialGradient(256, 256, 10, 256, 256, 340);
    g.addColorStop(0, 'rgba(255,159,64,0.10)');
    g.addColorStop(1, 'rgba(92,123,255,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 14000; i++) {
      const x = Math.random() * c.width;
      const y = Math.random() * c.height;
      const v = 10 + Math.random() * 35;
      ctx.fillStyle = `rgba(${v},${v + 6},${v + 18},${Math.random() * 0.10})`;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#7cf0d8';
    ctx.lineWidth = 1;
    for (let x = 0; x <= c.width; x += 64) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, c.height); ctx.stroke(); }
    for (let y = 0; y <= c.height; y += 64) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(c.width, y + 0.5); ctx.stroke(); }
    ctx.globalAlpha = 1;
    // Crack/vein lines for readability at speed.
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 2;
    for (let i = 0; i < 34; i++) {
      const x0 = Math.random() * c.width;
      const y0 = Math.random() * c.height;
      const x1 = x0 + (Math.random() - 0.5) * 180;
      const y1 = y0 + (Math.random() - 0.5) * 180;
      ctx.strokeStyle = `rgba(255,95,122,${0.08 + Math.random() * 0.12})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) * 0.5 + (Math.random() - 0.5) * 90, (y0 + y1) * 0.5 + (Math.random() - 0.5) * 90, x1, y1);
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
    ctx.fillStyle = '#14050a';
    ctx.fillRect(0, 0, c.width, c.height);
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 140);
    g.addColorStop(0, 'rgba(255,95,122,0.95)');
    g.addColorStop(0.45, 'rgba(255,107,74,0.65)');
    g.addColorStop(1, 'rgba(20,5,10,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 180; i++) {
      const x = Math.random() * c.width;
      const y = Math.random() * c.height;
      const r = 6 + Math.random() * 24;
      const a = 0.08 + Math.random() * 0.18;
      const gg = ctx.createRadialGradient(x, y, 1, x, y, r);
      gg.addColorStop(0, `rgba(255,209,90,${a})`);
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 28; i++) {
      const x0 = Math.random() * c.width;
      const y0 = Math.random() * c.height;
      const x1 = x0 + (Math.random() - 0.5) * 140;
      const y1 = y0 + (Math.random() - 0.5) * 140;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) * 0.5 + (Math.random() - 0.5) * 80, (y0 + y1) * 0.5 + (Math.random() - 0.5) * 80, x1, y1);
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
      new THREE.SphereGeometry(1800, 32, 16),
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

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.9, metalness: 0.05, emissive: 0x060813, emissiveIntensity: 0.35 });
    const groundTex = getGroundTexture();
    groundTex.repeat.set(def.size / 110, def.size / 110);
    groundMat.map = groundTex;
    groundMat.map.needsUpdate = true;
    const groundGeo = new THREE.CircleGeometry(def.size * 1.4, 96);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.receiveShadow = true;
    world.arenaGroup.add(ground);

    const edgeGeo = new THREE.RingGeometry(def.size * 0.98, def.size * 1.02, 96);
    edgeGeo.rotateX(-Math.PI / 2);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x445, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
    const edge = new THREE.Mesh(edgeGeo, edgeMat);
    edge.renderOrder = 2;
    world.arenaGroup.add(edge);

    const wallGeo = new THREE.CylinderGeometry(def.size * 1.03, def.size * 1.03, 58, 80, 1, true);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 0.92, metalness: 0.05, emissive: 0x050817, emissiveIntensity: 0.25, side: THREE.BackSide });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = 29;
    wall.receiveShadow = true;
    world.arenaGroup.add(wall);

    def.hazards?.forEach(h => {
      const geo = new THREE.CircleGeometry(h.r, 48);
      geo.rotateX(-Math.PI / 2);
      const lavaTex = getLavaTexture().clone();
      lavaTex.needsUpdate = true;
      lavaTex.repeat.set(Math.max(1, h.r / 28), Math.max(1, h.r / 28));
      const mat = new THREE.MeshStandardMaterial({
        color: 0xff6b4a,
        emissive: 0xff3b2b,
        emissiveIntensity: 1.05,
        roughness: 0.55,
        metalness: 0.05,
        transparent: true,
        opacity: 0.92,
        map: lavaTex,
        emissiveMap: lavaTex,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(h.x, 0.02, h.z);
      world.arenaGroup.add(mesh); world.hazardMeshes.push({ mesh, data: h });
      const light = new THREE.PointLight(0xff4f36, 0.7, 220); light.position.set(h.x, 18, h.z); scene.add(light); world.hazardLights.push(light);
    });

    def.boosts?.forEach(b => {
      const geo = new THREE.RingGeometry(b.r * 0.6, b.r, 48);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffd15a, emissive: 0xff9f40, emissiveIntensity: 0.95, roughness: 0.35, metalness: 0.15, transparent: true, opacity: 0.95, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.x, 0.03, b.z);
      world.arenaGroup.add(mesh); world.boostMeshes.push({ mesh, data: b });
    });

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
      // Steer axis: left is positive, right is negative; yaw application below converts to screen-correct turn.
      // Steer axis: left is negative, right is positive (standard) 
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

    const forward = new THREE.Vector3(Math.sin(game.yaw), 0, Math.cos(game.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    const speedScale = Number(game.settings.speedScale || 1);
    const maxSpeed = CFG.maxSpeed * speedScale;
    const boostCap = maxSpeed * 1.25;
    const speedRatio = clamp(game.speed / Math.max(1, maxSpeed), 0, 1);

    const steerInput = input.steer;
    game.steerInput = steerInput;
    const throttleCurve = 1 - Math.pow(speedRatio, CFG.throttleCurve);
    const effAccel = CFG.accel * throttleCurve;
    if (input.accel) game.vel.addScaledVector(forward, effAccel * dt);
    if (input.brake) game.vel.addScaledVector(forward, -CFG.brake * dt);

    const steerGrip = (input.drift ? CFG.driftGrip : CFG.lateralGrip) * game.mod.grip;
    const steerRate = (input.drift ? CFG.steerDrift : CFG.steer) * game.mod.steer * (0.55 + (1 - speedRatio) * 0.6);
    // Negative here makes ArrowLeft/WASD-left turn left on screen (chase camera).
    game.yawVel = lerp(game.yawVel, (-steerInput) * steerRate, dt * (input.drift ? 6 : 8));
    game.yaw += game.yawVel * dt;

    const fSpeed = game.vel.dot(forward);
    let side = game.vel.dot(right);
    side = lerp(side, 0, dt * steerGrip);
    game.vel.copy(forward.clone().multiplyScalar(fSpeed)).add(right.clone().multiplyScalar(side));

    const baseDrag = CFG.drag + (input.accel ? 0 : CFG.coastDrag);
    game.vel.multiplyScalar(Math.max(0, 1 - baseDrag * dt));
    game.speed = game.vel.length();
    if (game.speed > boostCap) game.vel.setLength(boostCap);
    game.speed = game.vel.length();
    const speedNormNow = clamp(game.speed / Math.max(1, maxSpeed), 0, 1);
    const heat01 = clamp(game.heat / CFG.maxHeat, 0, 1);
    const scoreMult = 1 + heat01 * 0.65;

    if (input.drift) {
      game.drift = clamp(game.drift + CFG.driftGain * dt, 0, 100);
      game.speed *= 0.995;
      game.heat += CFG.heatGainDrift * dt;
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
      game.heat += CFG.heatGainBoost * dt;
      game.shake = Math.max(game.shake, 0.35);
    }
    if (game.boostPulse > 0) { game.vel.addScaledVector(forward, CFG.boostImpulse * dt); game.boostPulse -= dt; game.shake = Math.max(game.shake, 0.25); }

    game.pos.addScaledVector(game.vel, dt);
    clampToArena(game.map, game.pos, game.vel);

    applyHazards(dt, game.pos);
    applyBoostPads(dt, game.pos, forward);
    applyHeat(dt);
    animateArenaFx(game.runTime);
    updateSpeedFx(dt, speedNormNow, !!(input.boost || game.boostPulse > 0.01));
    updateParticles(dt, forward, input);

    game.comboTimer = Math.max(0, game.comboTimer - dt);
    if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.2 * dt);
    game.score += (game.speed * 0.06 + (input.drift ? 3 : 0)) * dt * game.combo * scoreMult;

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
    if (pos.length() > limit) {
      const dir = pos.clone().normalize();
      pos.copy(dir.multiplyScalar(limit * 0.995));
      const ref = vel.clone().reflect(dir);
      vel.copy(ref.multiplyScalar(CFG.arenaBounce));
      game.heat += 6;
      game.shake = Math.max(game.shake, 0.5);
      bounced = true;
    }
    if (bounced && game.mod.shield) game.mod.shield = false;
  }

  function applyHazards(dt, pos) {
    game.map.hazards?.forEach(h => {
      const d2 = (pos.x - h.x) ** 2 + (pos.z - h.z) ** 2;
      if (d2 < h.r * h.r) {
        game.heat += CFG.heatGainHazard * dt;
        game.vel.multiplyScalar(Math.max(0, 1 - CFG.hazardSlow * dt * game.mod.hazardSlow));
        if (Math.random() < 10 * dt) {
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
      }
    });
  }

  function animateArenaFx(t) {
    const lavaOx = (t * 0.03) % 1;
    const lavaOy = (t * 0.02) % 1;
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

  function applyBoostPads(dt, pos, forward) {
    game.map.boosts?.forEach(b => {
      const d2 = (pos.x - b.x) ** 2 + (pos.z - b.z) ** 2;
      if (d2 < b.r * b.r) {
        game.boost = clamp(game.boost + 16 * dt, 0, 140);
        game.vel.addScaledVector(forward, CFG.boostPower * 0.28 * dt);
        game.shake = Math.max(game.shake, 0.18);
      }
    });
  }

  function applyHeat(dt) {
    game.heat = clamp(game.heat - CFG.heatCool * dt * game.mod.coolRate, 0, CFG.maxHeat);
  }

  function updatePlayerMesh(forward, dt) {
    playerMesh.position.copy(game.pos);
    playerMesh.position.y = 0.6;
    playerMesh.rotation.y = Math.atan2(forward.x, forward.z);
    const wheels = playerMesh.userData?.wheels;
    if (wheels && wheels.length) {
      const signedSpeed = game.vel.dot(forward);
      const spin = (signedSpeed / 0.35) * dt;
      for (let i = 0; i < wheels.length; i++) wheels[i].rotation.x += spin;
    }
    if (playerShadow) { playerShadow.position.set(game.pos.x, 0.01, game.pos.z); playerShadow.scale.set(1, 1, 1); }
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
    const speedNorm = clamp(game.speed / (CFG.maxSpeed * (Number(game.settings.speedScale || 1))), 0, 1);
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
    const heat01 = clamp(game.heat / CFG.maxHeat, 0, 1);
    const scoreMult = 1 + heat01 * 0.65;
    if (p.type === 'cool') {
      const payout = (CFG.heatCashBase + game.heat * CFG.heatCashPerPoint) * game.mod.heatCash;
      game.score += payout * game.combo;
      game.heat = 0;
      addCombo(0.8);
      setToast('Coolant: cashed heat!');
      playTone(740, 0.08, 0.12);
    } else if (p.type === 'cell') {
      game.boost = clamp(game.boost + 45, 0, 140);
      playTone(520, 0.08, 0.12);
    } else if (p.type === 'shield') {
      game.mod.shield = true;
      setToast('Shield ready');
      playTone(560, 0.08, 0.12);
    } else if (p.type === 'coin') {
      game.score += 180 * game.combo * scoreMult;
      addCombo(0.5);
      playTone(480, 0.06, 0.12);
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
    const type = pick(['racer', 'blocker', 'hunter']);
    activeRivals.push({ pos, vel: new THREE.Vector3(), yaw: Math.random() * Math.PI * 2, speed: 0, mesh, type, nearCd: 0 });
  }

  function updateRivals(dt) {
    game.rivalTimer -= dt;
    if (game.rivalTimer <= 0 && activeRivals.length < CFG.rivalMax) { spawnRival(); game.rivalTimer = CFG.rivalInterval; }
    const speedScale = Number(game.settings.speedScale || 1);
    const playerTop = CFG.maxSpeed * speedScale;
    const rivalTop = playerTop * CFG.rivalMaxFactor;
    for (let i = activeRivals.length - 1; i >= 0; i--) {
      const r = activeRivals[i];
      r.hitCd = Math.max(0, (r.hitCd || 0) - dt);
      const toPlayer = game.pos.clone().sub(r.pos);
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
      r.yaw = Math.atan2(r.vel.x, r.vel.z);
      r.mesh.position.copy(r.pos); r.mesh.position.y = 0.55;
      r.mesh.rotation.y = r.yaw;

      r.nearCd = Math.max(0, (r.nearCd || 0) - dt);
      const dz = game.pos.clone().sub(r.pos).length();
      if (dz > 3 && dz < 8 && r.nearCd <= 0) {
        addCombo(0.12);
        const heat01 = clamp(game.heat / CFG.maxHeat, 0, 1);
        game.score += 18 * (1 + heat01 * 0.65);
        r.nearCd = 1;
      }
      if (dz < 2.85 && r.hitCd <= 0) {
        const minDist = 2.85;
        const n = game.pos.clone().sub(r.pos);
        if (n.lengthSq() < 1e-8) n.copy(game.vel).sub(r.vel);
        if (n.lengthSq() < 1e-8) n.set((Math.random() - 0.5), 0, (Math.random() - 0.5));
        n.y = 0;
        n.normalize();

        const penetration = Math.max(0, minDist - dz);
        if (Number.isFinite(penetration) && penetration > 0) {
          game.pos.addScaledVector(n, penetration * 0.58);
          r.pos.addScaledVector(n, -penetration * 0.58);
        }

        // Damped "swap" of normal velocity components to avoid infinite spin/overlap.
        const vpn = game.vel.dot(n);
        const vrn = r.vel.dot(n);
        if (Number.isFinite(vpn) && Number.isFinite(vrn)) {
          const damp = 0.55;
          game.vel.addScaledVector(n, (vrn - vpn) * damp);
          r.vel.addScaledVector(n, (vpn - vrn) * damp);
        }

        if (game.mod.shield) { game.mod.shield = false; setToast('Shield broke'); playTone(260, 0.06, 0.1); }
        else bump();

        r.hitCd = 0.35;
      }
    }
  }

  function bump() {
    game.vel.multiplyScalar(0.7);
    game.heat += 8;
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
        `drift ${game.drift.toFixed(1)} heat ${game.heat.toFixed(1)} boost ${game.boost.toFixed(1)} combo x${game.combo.toFixed(1)}`,
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

