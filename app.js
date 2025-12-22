/*
InfernoDrift2 — Three.js chase racer (static, no build)
- Run locally: `python -m http.server` then open http://localhost:8000
- Controls: WASD/Arrows steer/throttle, Down brake, Space drift (banks boost), Shift boost, F fullscreen, ~ debug.
- Tracks: see TRACKS; each track is sections {len, curveDeg, width, hazard?, boost?}. Add a track by pushing a new object with metadata and sections; geometry is auto-built.
- Approach: real 3D chase camera using bundled vendor/three.min.js (no CDN). If WebGL is unavailable, log an error and skip.
*/

(() => {
  'use strict';

  /* Config */
  const CFG = {
    step: 14,              // meters per sample along path
    roadY: 0,
    carHeight: 1.4,
    accel: 160,
    brake: 220,
    maxSpeed: 320,
    offroad: 0.7,
    steer: 1.9,
    driftGain: 30,
    boostForce: 540,
    boostDrain: 36,
    heatGain: 30,
    heatCool: 24,
    heatLava: 44,
    maxHeat: 100,
    comboWin: 3,
    pickupInterval: 7,
    enemyInterval: 6,
    enemyLook: 220,
    dtClamp: 0.05,
  };

  /* Tracks */
  const TRACKS = [
    { id: 'beginner', name: 'Beginner Flow', desc: 'Gentle curves, wide lanes.', laps: 2,
      sections: [
        { len: 240, curveDeg: 0, width: 18 },
        { len: 300, curveDeg: 15, width: 18, boost: true },
        { len: 260, curveDeg: -12, width: 18 },
        { len: 140, curveDeg: 0, width: 18 },
      ],
    },
    { id: 'canyon', name: 'S-Curve Canyon', desc: 'S turns with lava edges.', laps: 3,
      sections: [
        { len: 200, curveDeg: 18, width: 15 },
        { len: 220, curveDeg: -22, width: 14, hazard: true },
        { len: 180, curveDeg: 20, width: 15, boost: true },
        { len: 160, curveDeg: -14, width: 15 },
      ],
    },
    { id: 'coast', name: 'Lava Coastline', desc: 'Fast sweepers along lava.', laps: 2,
      sections: [
        { len: 260, curveDeg: 10, width: 16 },
        { len: 260, curveDeg: -10, width: 16, hazard: true },
        { len: 240, curveDeg: 8, width: 16, boost: true },
        { len: 220, curveDeg: 0, width: 16 },
      ],
    },
    { id: 'chicane', name: 'Chicane Dash', desc: 'Straights into chicanes.', laps: 3,
      sections: [
        { len: 320, curveDeg: 0, width: 15, boost: true },
        { len: 160, curveDeg: 22, width: 14 },
        { len: 160, curveDeg: -22, width: 14 },
        { len: 320, curveDeg: 0, width: 15 },
      ],
    },
    { id: 'roller', name: 'Hill Roller', desc: 'Rolling grade with hazards.', laps: 3,
      sections: [
        { len: 200, curveDeg: 8, width: 15 },
        { len: 240, curveDeg: -8, width: 15, hazard: true },
        { len: 220, curveDeg: 6, width: 15 },
        { len: 200, curveDeg: -6, width: 15, boost: true },
      ],
    },
    { id: 'furnace', name: 'Technical Furnace', desc: 'Tighter apexes, heavy risk.', laps: 3,
      sections: [
        { len: 200, curveDeg: 24, width: 13, hazard: true },
        { len: 180, curveDeg: -18, width: 13 },
        { len: 140, curveDeg: 22, width: 12, boost: true },
        { len: 140, curveDeg: -20, width: 12 },
      ],
    },
  ];

  /* DOM */
  const el = s => document.querySelector(s);
  const els = s => Array.from(document.querySelectorAll(s));
  const canvas = el('#gameCanvas');
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

  /* Settings */
  const SETTINGS_KEY = 'infernodrift2-settings';
  const DEFAULT_SETTINGS = { sound: 'on', gfx: 'high', controls: 'wasd', enemyAI: 'standard' };
  function loadSettings() { try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; } catch { return { ...DEFAULT_SETTINGS }; } }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(game.settings)); }

  /* State */
  const game = {
    state: 'menu',
    settings: loadSettings(),
    mapIndex: 0,
    track: null,
    s: 0,
    lane: 0,
    speed: 0,
    drift: 0,
    boost: 0,
    heat: 0,
    combo: 1,
    comboTimer: 0,
    score: 0,
    lap: 1,
    time: 0,
    lapGate: false,
    enemies: [],
    pickups: [],
    spawnTimer: CFG.enemyInterval,
    pickupTimer: CFG.pickupInterval,
    debug: false,
    last: performance.now() / 1000,
    fps: 0,
    cameraShake: 0,
  };

  /* Three.js */
  if (!window.THREE) { console.error('THREE not found'); return; }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x060812, 30, 700);
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  const hemi = new THREE.HemisphereLight(0x8fc7ff, 0x0a0c16, 0.9);
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(80, 140, -80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(hemi, sun);

  // ground/backdrop
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshPhongMaterial({ color: 0x0a0f1c, emissive: 0x000000 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // car and enemies
  const playerCar = buildCar(0x5cf0b8);
  scene.add(playerCar);
  const enemyPool = [];
  for (let i = 0; i < 12; i++) { const m = buildCar(0xf5597b); m.visible = false; scene.add(m); enemyPool.push(m); }

  // track meshes
  let roadMesh, boostMesh, hazardMesh, propMesh;

  /* Input */
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === '~') toggleDebug();
    if (e.key.toLowerCase() === 'f') toggleFullscreen();
    if (e.key === 'Escape' && game.state === 'playing') pauseGame();
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  const touch = { left: false, right: false, accel: false, drift: false, boost: false };
  setupTouch();

  /* Audio */
  let audioCtx = null;
  function playTone(freq = 420, dur = 0.06, vol = 0.08) {
    if (game.settings.sound === 'off') return;
    if (!audioCtx) audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = freq; g.gain.value = vol;
    osc.connect(g).connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + dur);
  }

  /* Build car */
  function buildCar(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 2.8), new THREE.MeshPhongMaterial({ color, emissive: color === 0x5cf0b8 ? 0x10322c : 0x321018 }));
    body.castShadow = true; body.receiveShadow = true; g.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2), new THREE.MeshPhongMaterial({ color: 0x0c1320, emissive: 0x0c1320 }));
    cab.position.y = 0.55; cab.position.z = -0.1; cab.castShadow = true; g.add(cab);
    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.5, 12); wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshPhongMaterial({ color: 0x111 });
    [[0.7, -0.3, 0.95], [-0.7, -0.3, 0.95], [0.7, -0.3, -0.95], [-0.7, -0.3, -0.95]].forEach(o => {
      const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(o[0], o[1], o[2]); w.castShadow = true; g.add(w);
    });
    return g;
  }

  /* Track builder */
  function buildTrack(def) {
    const pts = [];
    let heading = 0, x = 0, z = 0;
    def.sections.forEach(sec => {
      const steps = Math.max(1, Math.floor(sec.len / CFG.step));
      const turn = THREE.MathUtils.degToRad(sec.curveDeg || 0) / steps;
      for (let i = 0; i < steps; i++) {
        heading += turn;
        x += Math.sin(heading) * CFG.step;
        z += Math.cos(heading) * CFG.step;
        pts.push({ x, z, heading, width: sec.width, hazard: !!sec.hazard, boost: !!sec.boost });
      }
    });

    // road mesh (triangle strip)
    if (roadMesh) scene.remove(roadMesh);
    if (boostMesh) scene.remove(boostMesh);
    if (hazardMesh) scene.remove(hazardMesh);
    if (propMesh) scene.remove(propMesh);

    const verts = [];
    const colors = [];
    const hazardVerts = [];
    const boostVerts = [];
    const colorRoad = new THREE.Color(0x111827);
    const colorAlt = new THREE.Color(0x0d1320);
    const colorHaz = new THREE.Color(0x7a1c1c);
    const colorBoost = new THREE.Color(0xffd15a);

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const ra = new THREE.Vector3(Math.cos(a.heading), 0, -Math.sin(a.heading));
      const rb = new THREE.Vector3(Math.cos(b.heading), 0, -Math.sin(b.heading));
      const la = new THREE.Vector3(ra.x * a.width * -0.5, 0, ra.z * a.width * -0.5);
      const lb = new THREE.Vector3(rb.x * b.width * -0.5, 0, rb.z * b.width * -0.5);
      const raOff = la.clone().multiplyScalar(-1);
      const rbOff = lb.clone().multiplyScalar(-1);
      const aL = new THREE.Vector3(a.x, CFG.roadY, a.z).add(la);
      const aR = new THREE.Vector3(a.x, CFG.roadY, a.z).add(raOff);
      const bL = new THREE.Vector3(b.x, CFG.roadY, b.z).add(lb);
      const bR = new THREE.Vector3(b.x, CFG.roadY, b.z).add(rbOff);
      const pushQuad = (arr, c) => {
        arr.push(
          aL.x, aL.y, aL.z, aR.x, aR.y, aR.z, bL.x, bL.y, bL.z,
          aR.x, aR.y, aR.z, bR.x, bR.y, bR.z, bL.x, bL.y, bL.z
        );
        for (let k = 0; k < 6; k++) colors.push(c.r, c.g, c.b);
      };
      const baseColor = (i % 2 === 0) ? colorRoad : colorAlt;
      pushQuad(verts, baseColor);
      if (a.hazard || b.hazard) pushQuad(hazardVerts, colorHaz);
      if (a.boost || b.boost) pushQuad(boostVerts, colorBoost);
    }

    roadMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide })
    );
    roadMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    roadMesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    roadMesh.geometry.computeVertexNormals();
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);

    if (hazardVerts.length) {
      hazardMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshPhongMaterial({ color: 0xff5f5f, emissive: 0x7a1c1c })
      );
      hazardMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(hazardVerts, 3));
      hazardMesh.geometry.computeVertexNormals();
      hazardMesh.receiveShadow = true;
      scene.add(hazardMesh);
    }

    if (boostVerts.length) {
      boostMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshPhongMaterial({ color: 0xffd15a, emissive: 0xffa500, transparent: true, opacity: 0.85 })
      );
      boostMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(boostVerts, 3));
      boostMesh.geometry.computeVertexNormals();
      boostMesh.receiveShadow = true;
      scene.add(boostMesh);
    }

    // props
    const propGeo = new THREE.ConeGeometry(2, 8, 6);
    const propMat = new THREE.MeshPhongMaterial({ color: 0x7cf0d8, emissive: 0x1f3a32 });
    const propCount = Math.floor(pts.length / 16);
    const propPositions = [];
    for (let i = 0; i < propCount; i++) {
      const p = pts[(i * 16) % pts.length];
      const right = new THREE.Vector3(Math.cos(p.heading), 0, -Math.sin(p.heading));
      const offset = (Math.random() > 0.5 ? 1 : -1) * (p.width * 0.7);
      const pos = new THREE.Vector3(p.x, 0, p.z).addScaledVector(right, offset);
      propPositions.push(pos.x, 0, pos.z);
    }
    propMesh = new THREE.InstancedMesh(propGeo, propMat, propCount);
    const m = new THREE.Matrix4();
    propPositions.forEach((_, idx) => {
      m.makeTranslation(propPositions[idx * 3], 4, propPositions[idx * 3 + 2]);
      propMesh.setMatrixAt(idx, m);
    });
    scene.add(propMesh);

    return { pts, length: pts.length * CFG.step, laps: def.laps, meta: def };
  }

  /* Helpers */
  function wrapS(s) { const len = game.track.length; if (s > len / 2) return s - len; if (s < -len / 2) return s + len; return s; }
  function sampleTrack(s) {
    const pts = game.track.pts;
    const len = pts.length;
    const idx = Math.floor((s / CFG.step) % len);
    return pts[idx];
  }

  /* Input helpers */
  function readInput() {
    const scheme = game.settings.controls;
    const left = scheme === 'arrows' ? 'arrowleft' : 'a';
    const right = scheme === 'arrows' ? 'arrowright' : 'd';
    const up = scheme === 'arrows' ? 'arrowup' : 'w';
    const down = scheme === 'arrows' ? 'arrowdown' : 's';
    return {
      steer: (keys[left] || touch.left ? -1 : 0) + (keys[right] || touch.right ? 1 : 0),
      accel: keys[up] || touch.accel,
      brake: keys[down] || false,
      drift: keys[' '] || touch.drift,
      boost: keys['shift'] || touch.boost,
    };
  }
  function autoInput() { return { steer: Math.sin(game.time * 0.7) * 0.6, accel: true, brake: false, drift: Math.sin(game.time * 1.2) > 0.7, boost: Math.random() > 0.98 }; }

  /* Game flow */
  function startRun() { hide(el('#menuPanel')); hide(el('#gameoverOverlay')); hide(el('#pauseOverlay')); game.state = 'playing'; buildWorld(); setToast('Lap ' + game.lap); }
  function startAttract() { hide(el('#menuPanel')); game.state = 'attract'; buildWorld(); }
  function pauseGame() { if (game.state === 'playing') { game.state = 'paused'; show(el('#pauseOverlay')); } }
  function resumeGame() { if (game.state === 'paused') { game.state = 'playing'; hide(el('#pauseOverlay')); } }
  function gotoMenu() { game.state = 'menu'; show(el('#menuPanel')); hide(el('#pauseOverlay')); hide(el('#gameoverOverlay')); }
  function restartRun() { hide(el('#gameoverOverlay')); startRun(); }

  function buildWorld() {
    const def = TRACKS[game.mapIndex];
    game.track = buildTrack(def);
    game.s = 0; game.lane = 0; game.speed = 0; game.drift = 0; game.boost = 0; game.heat = 0; game.combo = 1; game.comboTimer = 0; game.score = 0; game.lap = 1; game.time = 0; game.lapGate = false;
    game.enemies = []; game.pickups = []; game.spawnTimer = CFG.enemyInterval; game.pickupTimer = CFG.pickupInterval;
    enemyPool.forEach(m => m.visible = false);
    for (let i = 0; i < 3; i++) spawnEnemy();
  }

  /* Update */
  function update(dt) {
    game.fps = game.fps ? (game.fps * 0.92 + (1 / dt) * 0.08) : 1 / dt;
    game.time += dt;
    const input = game.state === 'attract' ? autoInput() : readInput();

    // player dynamics
    if (input.accel) game.speed += CFG.accel * dt;
    if (input.brake) game.speed -= CFG.brake * dt;
    if (!input.accel && !input.brake) game.speed -= CFG.accel * 0.3 * dt;
    game.speed = clamp(game.speed, 0, CFG.maxSpeed);
    game.lane = clamp(game.lane + input.steer * dt * (CFG.steer + game.speed * 0.003), -2.6, 2.6);

    if (input.drift) { game.drift = clamp(game.drift + CFG.driftGain * dt, 0, 100); game.speed *= 0.995; game.heat += CFG.heatGain * 0.35 * dt; }
    else if (game.drift > 5) { game.boost = clamp(game.boost + game.drift * 0.6, 0, 100); game.drift = 0; playTone(540, 0.08, 0.12); setToast('Boost charged'); }
    if (input.boost && game.boost > 0 && !game.overheat) { game.speed = clamp(game.speed + CFG.boostForce * dt, 0, CFG.maxSpeed * 1.25); game.boost = clamp(game.boost - CFG.boostDrain * dt, 0, 100); game.heat += CFG.heatGain * dt; }

    game.s = (game.s + game.speed * dt) % game.track.length;
    const sample = sampleTrack(game.s);
    const right = new THREE.Vector3(Math.cos(sample.heading), 0, -Math.sin(sample.heading));
    const pos = new THREE.Vector3(sample.x, CFG.carHeight, sample.z).addScaledVector(right, game.lane);
    playerCar.position.copy(pos);
    playerCar.rotation.y = sample.heading + input.steer * 0.08;

    camera.position.lerp(new THREE.Vector3(pos.x - right.x * 6, pos.y + 4, pos.z - Math.cos(sample.heading) * 12 - Math.sin(sample.heading) * 2), 0.1);
    camera.lookAt(pos.x, pos.y + 1, pos.z);

    if (Math.abs(game.lane) > sample.width * 0.5) { game.speed *= CFG.offroad; game.heat += CFG.heatGain * 0.2 * dt; }
    if (sample.hazard) game.heat += CFG.heatLava * dt;
    if (sample.boost) { game.speed = clamp(game.speed + CFG.boostForce * 0.3 * dt, 0, CFG.maxSpeed * 1.25); game.boost = clamp(game.boost + 15 * dt, 0, 100); }

    applyHeat(dt);
    game.score += game.speed * 0.1 * dt * game.combo;
    game.comboTimer = Math.max(0, game.comboTimer - dt); if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.25);

    // enemies
    updateEnemies(dt);

    // pickups
    updatePickups(dt);

    // collisions
    for (const e of game.enemies) {
      if (!e.mesh.visible) continue;
      const dz = Math.abs(wrapS(e.s - game.s));
      if (dz < 16 && Math.abs(e.lane - game.lane) < 0.8) { bump(); game.speed *= 0.7; game.heat += 10; }
    }

    handleLap();
    updateHUD();
  }

  function updateEnemies(dt) {
    for (const e of game.enemies) {
      if (!e.mesh.visible) continue;
      const targetS = (game.s + CFG.enemyLook) % game.track.length;
      const target = sampleTrack(targetS);
      const desiredLane = (e.type === 'blocker') ? clamp(game.lane + (Math.random() - 0.5) * 0.6, -2.4, 2.4)
        : (e.type === 'hunter') ? game.lane
        : clamp((Math.random() - 0.5) * 1.4, -2.4, 2.4);
      e.lane = lerp(e.lane, desiredLane, 0.5 * dt);
      e.speed = lerp(e.speed, clamp(game.speed * 0.95, 80, CFG.maxSpeed * 0.9), 0.4 * dt);
      e.s = (e.s + e.speed * dt) % game.track.length;
      const right = new THREE.Vector3(Math.cos(target.heading), 0, -Math.sin(target.heading));
      const pos = new THREE.Vector3(target.x, CFG.carHeight, target.z).addScaledVector(right, e.lane);
      e.mesh.position.copy(pos);
      e.mesh.rotation.y = target.heading;
      if (Math.random() < 0.001) { e.mesh.visible = false; }
    }
    game.enemies = game.enemies.filter(e => e.mesh.visible);
  }

  function spawnEnemy() {
    if (!game.track) return;
    const mesh = enemyPool.find(m => !m.visible);
    if (!mesh) return;
    mesh.visible = true;
    const s = (game.s + 160 + Math.random() * 400) % game.track.length;
    const lane = (Math.random() - 0.5) * 2;
    game.enemies.push({ s, lane, speed: game.speed * 0.8 + 60, mesh, type: pick(['racer', 'blocker', 'hunter']) });
  }

  function updatePickups(dt) {
    game.pickupTimer -= dt;
    if (game.pickupTimer <= 0 && game.pickups.length < 4) {
      const s = (game.s + 120 + Math.random() * 400) % game.track.length;
      const lane = (Math.random() - 0.5) * 2;
      game.pickups.push({ s, lane, type: pick(['cool', 'cell', 'shield', 'coin']) });
      game.pickupTimer = CFG.pickupInterval;
    }
    for (let i = game.pickups.length - 1; i >= 0; i--) {
      const p = game.pickups[i];
      const pt = sampleTrack(p.s);
      const dz = Math.abs(wrapS(p.s - game.s));
      if (dz < 10 && Math.abs(p.lane - game.lane) < 0.6) { collectPickup(p); game.pickups.splice(i, 1); }
    }
  }

  function collectPickup(p) {
    if (p.type === 'cool') game.heat = Math.max(0, game.heat - 30);
    if (p.type === 'cell') game.boost = clamp(game.boost + 40, 0, 100);
    if (p.type === 'shield') { game.speed += 15; game.heat = Math.max(0, game.heat - 12); }
    if (p.type === 'coin') { game.score += 150 * game.combo; addCombo(0.4); }
    playTone(640, 0.06, 0.1);
  }

  function applyHeat(dt) {
    game.heat = clamp(game.heat - CFG.heatCool * dt, 0, CFG.maxHeat);
    if (game.heat >= CFG.maxHeat && !game.overheat) endRun('Overheated');
  }

  /* Lap */
  function handleLap() {
    const def = TRACKS[game.mapIndex];
    const near = game.s <= CFG.step * 2 || game.s >= game.track.length - CFG.step * 2;
    if (near && !game.lapGate && game.speed > 10) {
      if (game.state === 'playing' && def.laps !== Infinity) {
        game.lap += 1; game.score += 300 * game.lap; if (game.lap > def.laps) endRun('Finished');
      }
      game.lapGate = true;
    }
    if (!near) game.lapGate = false;
  }

  /* HUD */
  function updateHUD() {
    hudSpeed.textContent = (game.speed | 0);
    hudScore.textContent = game.score.toFixed(0);
    hudCombo.textContent = `x${game.combo.toFixed(1)}`;
    hudLap.textContent = `${game.lap}/${TRACKS[game.mapIndex].laps === Infinity ? 'INF' : TRACKS[game.mapIndex].laps} - ${game.time.toFixed(1)}s`;
    heatBar.style.width = `${(game.heat / CFG.maxHeat) * 100}%`;
    driftBar.style.width = `${game.drift}%`;
    boostBar.style.width = `${game.boost}%`;
  }

  /* End */
  function endRun(reason) {
    game.state = 'over';
    show(el('#gameoverOverlay'));
    el('#gameoverTitle').textContent = reason;
    el('#gameoverStats').textContent = `Score ${game.score.toFixed(0)} - Lap ${game.lap} - Time ${game.time.toFixed(1)}s`;
  }

  /* Helpers */
  function setToast(msg) { toast.textContent = msg; toast.classList.add('show'); clearTimeout(setToast.tid); setToast.tid = setTimeout(() => toast.classList.remove('show'), 1200); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function toggleDebug() { game.debug = !game.debug; setToast(game.debug ? 'Debug on (~)' : 'Debug off'); }
  function toggleFullscreen() { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); else document.exitFullscreen().catch(() => {}); }

  function setupTouch() {
    const isMobile = matchMedia('(pointer: coarse)').matches;
    el('#touchControls').classList.toggle('hidden', !isMobile);
    el('#touchDrift').addEventListener('touchstart', () => touch.drift = true);
    el('#touchDrift').addEventListener('touchend', () => touch.drift = false);
    el('#touchBoost').addEventListener('touchstart', () => { touch.boost = true; touch.accel = true; });
    el('#touchBoost').addEventListener('touchend', () => { touch.boost = false; touch.accel = false; });
    const steer = el('#touchSteer');
    const move = e => { const r = steer.getBoundingClientRect(); const x = e.touches[0].clientX - r.left; const c = (x / r.width) - 0.5; touch.left = c < -0.1; touch.right = c > 0.1; };
    steer.addEventListener('touchstart', move); steer.addEventListener('touchmove', move); steer.addEventListener('touchend', () => { touch.left = touch.right = false; });
  }

  function bump() { game.combo = Math.max(1, game.combo - 0.4); game.cameraShake = 10; playTone(220, 0.05, 0.1); }
  function addCombo(v) { game.combo = clamp(game.combo + v, 1, 9); game.comboTimer = CFG.comboWin; }

  /* Debug overlay render */
  function renderDebug() {
    const ctx2d = canvas.getContext('2d');
    ctx2d.save();
    ctx2d.resetTransform();
    ctx2d.fillStyle = 'rgba(0,0,0,0.6)';
    ctx2d.fillRect(10, 10, 210, 110);
    ctx2d.fillStyle = '#fff';
    ctx2d.font = '12px monospace';
    const lines = [
      `fps ${game.fps.toFixed(0)} dt ${Math.min(CFG.dtClamp, performance.now()/1000 - game.last).toFixed(3)}`,
      `spd ${game.speed.toFixed(1)} lane ${game.lane.toFixed(2)}`,
      `drift ${game.drift.toFixed(1)} boost ${game.boost.toFixed(1)}`,
      `heat ${game.heat.toFixed(1)} combo ${game.combo.toFixed(1)}`,
      `track ${TRACKS[game.mapIndex].id} rivals ${game.enemies.length}`,
    ];
    lines.forEach((l, i) => ctx2d.fillText(l, 16, 28 + i * 14));
    ctx2d.restore();
  }

  /* Resize */
  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);

  /* UI setup */
  function bindUI() {
    el('#startBtn').addEventListener('click', startRun);
    el('#resumeBtn').addEventListener('click', () => resumeGame());
    el('#watchDemo').addEventListener('click', startAttract);
    el('#openHelp').addEventListener('click', () => show(el('#helpOverlay')));
    el('#closeHelp').addEventListener('click', () => hide(el('#helpOverlay')));
    el('#openSettings').addEventListener('click', () => {
      el('#settingSound').value = game.settings.sound;
      el('#settingGfx').value = game.settings.gfx;
      el('#settingControls').value = game.settings.controls;
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
    el('#backToMenu').addEventListener('click', gotoMenu);
    el('#playAgain').addEventListener('click', restartRun);
    el('#menuReturn').addEventListener('click', gotoMenu);
    el('#toggleFull').addEventListener('click', toggleFullscreen);
    el('#pauseBtn').addEventListener('click', () => { if (game.state === 'playing') pauseGame(); });
  }

  function buildMapList() {
    mapListEl.innerHTML = '';
    TRACKS.forEach((m, idx) => {
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
    mapName.textContent = TRACKS[idx].name;
    mapDesc.textContent = TRACKS[idx].desc;
    drawPreview();
  }

  /* Render */
  function render() {
    renderer.render(scene, camera);
    if (game.debug) renderDebug();
  }

  /* Boot */
  function init() {
    buildMapList();
    bindUI();
    onResize();
    requestAnimationFrame(function raf() { const t = performance.now() / 1000; const dt = Math.min(CFG.dtClamp, t - game.last); game.last = t; if (game.state === 'playing' || game.state === 'attract') update(dt); render(); requestAnimationFrame(raf); });
  }

  init();
})();
