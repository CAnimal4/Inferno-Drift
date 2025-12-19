/*
InfernoDrift2 — Three.js chase racer (static, no build)
- Run locally: `python -m http.server` then open http://localhost:8000
- Controls: WASD/Arrows steer/throttle, Down brake, Space drift (banks boost), Shift boost, F fullscreen, ~ debug overlay.
- Tracks: TRACKS below; each has sections {len, curveDeg, width, hazard?, boost?}. Add a new track by pushing an object with metadata and sections; track geometry auto-builds.
- Approach: Real 3D chase camera using local three.min.js (no CDN). If WebGL is unavailable, you’ll see a console error and nothing renders.
*/

(() => {
  'use strict';

  /* Config */
  const CONFIG = {
    step: 16,              // meters per sample along path
    carHeight: 1.4,
    accel: 160,
    brake: 220,
    maxSpeed: 320,
    offroad: 0.7,
    steerRate: 1.8,
    driftGain: 28,
    boostForce: 520,
    boostDrain: 36,
    heatGain: 28,
    heatCool: 24,
    heatLava: 42,
    maxHeat: 100,
    comboWindow: 3,
    pickupInterval: 7,
    enemySpawnInterval: 6,
    enemyLookahead: 220,
    dtClamp: 0.05,
  };

  /* Tracks */
  const TRACKS = [
    {
      id: 'beginner',
      name: 'Beginner Flow',
      desc: 'Gentle curves, wide lanes.',
      laps: 2,
      sections: [
        { len: 240, curveDeg: 0, width: 18 },
        { len: 300, curveDeg: 15, width: 18, boost: true },
        { len: 260, curveDeg: -12, width: 18 },
        { len: 140, curveDeg: 0, width: 18 },
      ],
    },
    {
      id: 'canyon',
      name: 'S-Curve Canyon',
      desc: 'S turns with lava edges.',
      laps: 3,
      sections: [
        { len: 200, curveDeg: 18, width: 15 },
        { len: 220, curveDeg: -22, width: 14, hazard: true },
        { len: 180, curveDeg: 20, width: 15, boost: true },
        { len: 160, curveDeg: -14, width: 15 },
      ],
    },
    {
      id: 'coast',
      name: 'Lava Coastline',
      desc: 'Fast sweepers along lava.',
      laps: 2,
      sections: [
        { len: 260, curveDeg: 10, width: 16 },
        { len: 260, curveDeg: -10, width: 16, hazard: true },
        { len: 240, curveDeg: 8, width: 16, boost: true },
        { len: 220, curveDeg: 0, width: 16 },
      ],
    },
    {
      id: 'chicane',
      name: 'Chicane Dash',
      desc: 'Straights into chicanes.',
      laps: 3,
      sections: [
        { len: 320, curveDeg: 0, width: 15, boost: true },
        { len: 160, curveDeg: 22, width: 14 },
        { len: 160, curveDeg: -22, width: 14 },
        { len: 320, curveDeg: 0, width: 15 },
      ],
    },
    {
      id: 'roller',
      name: 'Hill Roller',
      desc: 'Rolling grade with hazards.',
      laps: 3,
      sections: [
        { len: 200, curveDeg: 8, width: 15 },
        { len: 240, curveDeg: -8, width: 15, hazard: true },
        { len: 220, curveDeg: 6, width: 15 },
        { len: 200, curveDeg: -6, width: 15, boost: true },
      ],
    },
    {
      id: 'furnace',
      name: 'Technical Furnace',
      desc: 'Tighter apexes, heavy risk.',
      laps: 3,
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

  /* Game state */
  const game = {
    state: 'menu',
    settings: loadSettings(),
    mapIndex: 0,
    track: null,
    bests: {},
    // player kinematics on spline
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
    particles: [],
    spawnTimer: CONFIG.enemySpawnInterval,
    pickupTimer: CONFIG.pickupInterval,
    debug: false,
    last: performance.now() / 1000,
    fps: 0,
  };

  /* Three.js setup */
  if (!window.THREE) { console.error('THREE not found'); return; }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x070912, 20, 600);
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  const ambient = new THREE.HemisphereLight(0x8fc7ff, 0x1a1b25, 0.9);
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(60, 120, -60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(ambient, sun);

  // ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000, 1, 1),
    new THREE.MeshPhongMaterial({ color: 0x0a0f1c, emissive: 0x000000 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // car
  const car = buildCar(0x5cf0b8);
  scene.add(car);

  // enemy pool
  const enemyPool = [];
  for (let i = 0; i < 12; i++) {
    const m = buildCar(0xf55b7b);
    m.visible = false;
    scene.add(m);
    enemyPool.push(m);
  }

  // track containers
  let trackMesh, boostMesh, hazardMesh, propMesh;

  /* Input */
  const keys = {};
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === '~') toggleDebug();
    if (e.key.toLowerCase() === 'f') toggleFullscreen();
    if (e.key === 'Escape' && game.state === 'playing') pauseGame();
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  /* Touch */
  const touch = { left: false, right: false, accel: false, drift: false, boost: false };
  setupTouch();

  /* Audio */
  let audioCtx = null;
  function playTone(freq = 420, dur = 0.06, vol = 0.08) {
    if (game.settings.sound === 'off') return;
    if (!audioCtx) audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.frequency.value = freq; osc.type = 'sawtooth';
    g.gain.value = vol;
    osc.connect(g).connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + dur);
  }

  /* Track build */
  function buildTrack(def) {
    const pts = [];
    let heading = 0;
    let x = 0, z = 0;
    def.sections.forEach(sec => {
      const steps = Math.max(1, Math.floor(sec.len / CONFIG.step));
      const turn = THREE.MathUtils.degToRad(sec.curveDeg || 0) / steps;
      for (let i = 0; i < steps; i++) {
        heading += turn;
        x += Math.sin(heading) * CONFIG.step;
        z += Math.cos(heading) * CONFIG.step;
        pts.push({ x, z, heading, width: sec.width, hazard: !!sec.hazard, boost: !!sec.boost });
      }
    });
    // build meshes
    if (trackMesh) scene.remove(trackMesh);
    if (boostMesh) scene.remove(boostMesh);
    if (hazardMesh) scene.remove(hazardMesh);
    if (propMesh) scene.remove(propMesh);

    const roadGeo = new THREE.BoxGeometry(CONFIG.step, 1, 1);
    const roadMat = new THREE.MeshPhongMaterial({ color: 0x111827, emissive: 0x0b0f18 });
    trackMesh = new THREE.InstancedMesh(roadGeo, roadMat, pts.length);
    trackMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trackMesh.receiveShadow = true;
    scene.add(trackMesh);

    const boostMat = new THREE.MeshPhongMaterial({ color: 0xffd15a, emissive: 0xffa500 });
    boostMesh = new THREE.InstancedMesh(roadGeo, boostMat, pts.length);
    boostMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    boostMesh.visible = false;
    scene.add(boostMesh);

    const hazardMat = new THREE.MeshPhongMaterial({ color: 0xff5f5f, emissive: 0x7a1c1c });
    hazardMesh = new THREE.InstancedMesh(roadGeo, hazardMat, pts.length);
    hazardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    hazardMesh.visible = false;
    scene.add(hazardMesh);

    const propGeo = new THREE.ConeGeometry(2, 8, 6);
    const propMat = new THREE.MeshPhongMaterial({ color: 0x7cf0d8, emissive: 0x1f3a32 });
    propMesh = new THREE.InstancedMesh(propGeo, propMat, Math.floor(pts.length / 15));
    propMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(propMesh);

    let bi = 0, hi = 0, pi = 0;
    const m = new THREE.Matrix4();
    pts.forEach((p, i) => {
      const w = p.width;
      m.makeRotationY(p.heading);
      m.setPosition(p.x, 0.5, p.z);
      const scale = new THREE.Vector3(w, 1, CONFIG.step);
      m.scale(scale);
      trackMesh.setMatrixAt(i, m);
      if (p.boost) { boostMesh.setMatrixAt(bi++, m); }
      if (p.hazard) { hazardMesh.setMatrixAt(hi++, m); }
      if (i % 15 === 0) {
        const pm = m.clone();
        pm.setPosition(p.x + (Math.random() > 0.5 ? w : -w) * 1.2, 4, p.z);
        propMesh.setMatrixAt(pi++, pm);
      }
    });
    boostMesh.count = bi; boostMesh.instanceMatrix.needsUpdate = true; boostMesh.visible = bi > 0;
    hazardMesh.count = hi; hazardMesh.instanceMatrix.needsUpdate = true; hazardMesh.visible = hi > 0;
    propMesh.count = pi; propMesh.instanceMatrix.needsUpdate = true;

    return { pts, length: pts.length * CONFIG.step, laps: def.laps, meta: def };
  }

  /* Car builder */
  function buildCar(color) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 2.6), new THREE.MeshPhongMaterial({ color, emissive: color === 0x5cf0b8 ? 0x0e2f24 : 0x3a0b16 }));
    body.castShadow = true; body.receiveShadow = true;
    group.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 1.2), new THREE.MeshPhongMaterial({ color: 0x0c1320, emissive: 0x0c1320 }));
    cab.position.y = 0.55; cab.position.z = -0.1; cab.castShadow = true;
    group.add(cab);
    const wheelsGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.5, 12);
    wheelsGeo.rotateZ(Math.PI / 2);
    const wheelsMat = new THREE.MeshPhongMaterial({ color: 0x111, emissive: 0x000000 });
    const offsets = [
      [0.7, -0.3, 0.9], [-0.7, -0.3, 0.9],
      [0.7, -0.3, -0.9], [-0.7, -0.3, -0.9],
    ];
    offsets.forEach(o => {
      const w = new THREE.Mesh(wheelsGeo, wheelsMat);
      w.position.set(o[0], o[1], o[2]); w.castShadow = true; group.add(w);
    });
    return group;
  }

  /* UI setup */
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

  function drawPreview() {
    const ctx = mapPreview.getContext('2d');
    ctx.clearRect(0, 0, mapPreview.width, mapPreview.height);
    ctx.fillStyle = '#0c1320'; ctx.fillRect(0, 0, mapPreview.width, mapPreview.height);
    const def = TRACKS[game.mapIndex];
    let x = mapPreview.width / 2, y = mapPreview.height - 10;
    let heading = 0;
    ctx.strokeStyle = '#7cf0d8'; ctx.beginPath(); ctx.moveTo(x, y);
    def.sections.forEach(sec => {
      const steps = Math.max(1, Math.floor(sec.len / 20));
      const turn = THREE.MathUtils.degToRad(sec.curveDeg || 0) / steps;
      for (let i = 0; i < steps; i++) {
        heading += turn;
        x += Math.sin(heading) * 3;
        y -= 3;
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  /* Game flow */
  function startRun() {
    hide(el('#menuPanel')); hide(el('#gameoverOverlay')); hide(el('#pauseOverlay'));
    game.state = 'playing';
    buildWorld();
    setToast('Lap ' + game.lap);
  }
  function startAttract() { hide(el('#menuPanel')); game.state = 'attract'; buildWorld(); }
  function pauseGame() { if (game.state === 'playing') { game.state = 'paused'; show(el('#pauseOverlay')); } }
  function resumeGame() { if (game.state === 'paused') { game.state = 'playing'; hide(el('#pauseOverlay')); } }
  function gotoMenu() { game.state = 'menu'; show(el('#menuPanel')); hide(el('#pauseOverlay')); hide(el('#gameoverOverlay')); }
  function restartRun() { hide(el('#gameoverOverlay')); startRun(); }

  function buildWorld() {
    const def = TRACKS[game.mapIndex];
    game.track = buildTrack(def);
    game.s = 0; game.lane = 0; game.speed = 0; game.drift = 0; game.boost = 0; game.heat = 0; game.combo = 1; game.comboTimer = 0; game.score = 0; game.lap = 1; game.time = 0; game.lapGate = false;
    game.enemies = [];
    game.pickups = [];
    game.spawnTimer = CONFIG.enemySpawnInterval;
    game.pickupTimer = CONFIG.pickupInterval;
    for (let i = 0; i < 3; i++) spawnEnemy();
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
      accel: keys[up] || touch.accel,
      brake: keys[down] || false,
      drift: keys[' '] || touch.drift,
      boost: keys['shift'] || touch.boost,
    };
  }

  /* Update */
  function loop() {
    const t = performance.now() / 1000;
    const dt = Math.min(CONFIG.dtClamp, t - game.last);
    game.last = t;
    if (game.state === 'playing' || game.state === 'attract') update(dt);
    render();
    requestAnimationFrame(loop);
  }

  function update(dt) {
    game.fps = game.fps ? lerp(game.fps, 1 / dt, 0.08) : 1 / dt;
    game.time += dt;
    const input = game.state === 'attract' ? autoInput() : readInput();
    updatePlayer(input, dt);
    updateEnemies(dt);
    updatePickups(dt);
    updateParticles(dt);
    handleLap();
    updateHUD();
    game.spawnTimer -= dt;
    if (game.spawnTimer <= 0 && game.enemies.length < 8) { spawnEnemy(); game.spawnTimer = CONFIG.enemySpawnInterval; }
  }

  function updatePlayer(input, dt) {
    if (input.accel) game.speed += CONFIG.accel * dt;
    if (input.brake) game.speed -= CONFIG.brake * dt;
    if (!input.accel && !input.brake) game.speed -= CONFIG.accel * 0.35 * dt;
    game.speed = clamp(game.speed, 0, CONFIG.maxSpeed);
    game.lane += input.steer * dt * (CONFIG.steerRate + game.speed * 0.003);
    game.lane = clamp(game.lane, -2.5, 2.5);
    if (input.drift) { game.drift = clamp(game.drift + CONFIG.driftGain * dt, 0, 100); game.speed *= 0.995; game.heat += CONFIG.heatGain * 0.35 * dt; }
    else if (game.drift > 5) { game.boost = clamp(game.boost + game.drift * 0.6, 0, 100); game.drift = 0; setToast('Boost charged'); playTone(540, 0.08, 0.12); }
    if (input.boost && game.boost > 0 && !game.overheat) { game.speed = clamp(game.speed + CONFIG.boostForce * dt, 0, CONFIG.maxSpeed * 1.25); game.boost = clamp(game.boost - CONFIG.boostDrain * dt, 0, 100); game.heat += CONFIG.heatGain * dt; }

    game.s = (game.s + game.speed * dt) % game.track.length;
    const sample = sampleTrack(game.s);
    const right = new THREE.Vector3(Math.cos(sample.heading), 0, -Math.sin(sample.heading));
    const worldPos = new THREE.Vector3(sample.x, CONFIG.carHeight, sample.z).addScaledVector(right, game.lane);
    car.position.copy(worldPos);
    car.rotation.y = sample.heading + input.steer * 0.1;
    camera.position.lerp(new THREE.Vector3(worldPos.x - right.x * 6, worldPos.y + 4, worldPos.z - Math.cos(sample.heading) * 12 - Math.sin(sample.heading) * 2), 0.1);
    camera.lookAt(worldPos.x, worldPos.y + 1, worldPos.z);

    // offroad & hazard
    if (Math.abs(game.lane) > sample.width * 0.5) { game.speed *= CONFIG.offroad; game.heat += CONFIG.heatGain * 0.2 * dt; }
    if (sample.hazard) game.heat += CONFIG.heatLava * dt;
    if (sample.boost) { game.speed = clamp(game.speed + CONFIG.boostForce * 0.3 * dt, 0, CONFIG.maxSpeed * 1.25); game.boost = clamp(game.boost + 15 * dt, 0, 100); }

    applyHeat(dt);
    game.score += game.speed * 0.1 * dt * game.combo;
    game.comboTimer = Math.max(0, game.comboTimer - dt); if (game.comboTimer <= 0) game.combo = Math.max(1, game.combo - 0.25);

    // collisions with enemies
    for (const e of game.enemies) {
      if (!e.mesh.visible) continue;
      const dz = Math.abs(wrapS(e.s - game.s));
      if (dz < 18 && Math.abs(e.lane - game.lane) < 0.9) { bump(); game.speed *= 0.7; game.heat += 10; }
    }
  }

  function applyHeat(dt) {
    game.heat = clamp(game.heat - CONFIG.heatCool * dt, 0, CONFIG.maxHeat);
    if (game.heat >= CONFIG.maxHeat && !game.overheat) endRun('Overheated');
  }

  function autoInput() { return { steer: Math.sin(game.time * 0.7) * 0.6, accel: true, brake: false, drift: Math.sin(game.time * 1.2) > 0.7, boost: Math.random() > 0.98 }; }

  /* Track sampling */
  function wrapS(s) { const len = game.track.length; if (s > len / 2) return s - len; if (s < -len / 2) return s + len; return s; }
  function sampleTrack(s) {
    const pts = game.track.pts;
    const len = pts.length;
    const idx = Math.floor((s / CONFIG.step) % len);
    const p = pts[idx];
    return p;
  }

  /* Enemies */
  function spawnEnemy() {
    if (!game.track) return;
    const s = (game.s + 200 + Math.random() * 400) % game.track.length;
    const lane = (Math.random() - 0.5) * 2;
    const mesh = enemyPool.find(m => !m.visible);
    if (!mesh) return;
    mesh.visible = true;
    game.enemies.push({ s, lane, speed: game.speed * 0.8 + 50, mesh, type: pick(['racer', 'blocker', 'hunter']) });
  }

  function updateEnemies(dt) {
    for (const e of game.enemies) {
      if (!e.mesh.visible) continue;
      const targetS = (game.s + CONFIG.enemyLookahead) % game.track.length;
      const target = sampleTrack(targetS);
      const desiredLane = (e.type === 'blocker') ? clamp(game.lane + (Math.random() - 0.5) * 0.6, -2.5, 2.5)
                        : (e.type === 'hunter') ? game.lane
                        : clamp((Math.random() - 0.5) * 1.2, -2.5, 2.5);
      e.lane = lerp(e.lane, desiredLane, 0.6 * dt);
      e.speed = lerp(e.speed, clamp(game.speed * 0.95, 80, CONFIG.maxSpeed * 0.9), 0.5 * dt);
      e.s = (e.s + e.speed * dt) % game.track.length;
      const right = new THREE.Vector3(Math.cos(target.heading), 0, -Math.sin(target.heading));
      const pos = new THREE.Vector3(target.x, CONFIG.carHeight, target.z).addScaledVector(right, e.lane);
      e.mesh.position.copy(pos);
      e.mesh.rotation.y = target.heading;
      if (Math.random() < 0.001) e.mesh.visible = false;
    }
    game.enemies = game.enemies.filter(e => e.mesh.visible);
  }

  /* Pickups */
  function updatePickups(dt) {
    game.pickupTimer -= dt;
    if (game.pickupTimer <= 0 && game.pickups.length < 4) {
      const s = (game.s + 120 + Math.random() * 400) % game.track.length;
      const lane = (Math.random() - 0.5) * 2;
      game.pickups.push({ s, lane, type: pick(['cool', 'cell', 'shield', 'coin']) });
      game.pickupTimer = CONFIG.pickupInterval;
    }
    const cam = sampleTrack(game.s);
    for (let i = game.pickups.length - 1; i >= 0; i--) {
      const p = game.pickups[i];
      const pt = sampleTrack(p.s);
      const right = new THREE.Vector3(Math.cos(pt.heading), 0, -Math.sin(pt.heading));
      const pos = new THREE.Vector3(pt.x, 0.6, pt.z).addScaledVector(right, p.lane);
      const dz = Math.abs(wrapS(p.s - game.s));
      if (dz < 12 && Math.abs(p.lane - game.lane) < 0.6) {
        collectPickup(p);
        game.pickups.splice(i, 1);
        continue;
      }
      // render as small spheres via Three Points? simple: use HUD toast only when collected; skip rendering for brevity
    }
  }

  function collectPickup(p) {
    if (p.type === 'cool') game.heat = Math.max(0, game.heat - 30);
    if (p.type === 'cell') game.boost = clamp(game.boost + 40, 0, 100);
    if (p.type === 'shield') { game.speed += 15; game.heat = Math.max(0, game.heat - 12); }
    if (p.type === 'coin') { game.score += 150 * game.combo; addCombo(0.4); }
    playTone(640, 0.06, 0.1);
  }

  /* Particles */
  function addSmoke() { /* placeholder for optional smoke */ }
  function addFlare() { /* placeholder for optional flare */ }
  function updateParticles(dt) { /* currently no particle geometry */ }

  /* Lap */
  function handleLap() {
    const def = TRACKS[game.mapIndex];
    const near = game.s <= CONFIG.step * 2 || game.s >= game.track.length - CONFIG.step * 2;
    if (near && !game.lapGate && game.speed > 10) {
      if (game.state === 'playing' && def.laps !== Infinity) {
        game.lap += 1;
        game.score += 300 * game.lap;
        if (game.lap > def.laps) endRun('Finished');
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
    heatBar.style.width = `${(game.heat / CONFIG.maxHeat) * 100}%`;
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

  function bump() { game.combo = Math.max(1, game.combo - 0.4); game.camera && (game.camera.shake = 8); playTone(220, 0.05, 0.1); }
  function addCombo(v) { game.combo = clamp(game.combo + v, 1, 9); game.comboTimer = CONFIG.comboWindow; }

  function renderDebug() {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.resetTransform();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(10, 10, 210, 110);
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    const lines = [
      `fps ${game.fps.toFixed(0)} dt ${(game.last - performance.now()/1000).toFixed(3)}`,
      `spd ${game.speed.toFixed(1)} lane ${game.lane.toFixed(2)}`,
      `drift ${game.drift.toFixed(1)} boost ${game.boost.toFixed(1)}`,
      `heat ${game.heat.toFixed(1)} combo ${game.combo.toFixed(1)}`,
      `track ${TRACKS[game.mapIndex].id} rivals ${game.enemies.length}`,
    ];
    lines.forEach((l, i) => ctx.fillText(l, 16, 26 + i * 14));
    ctx.restore();
  }

  /* Resize */
  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);

  /* Render loop */
  function render() {
    renderer.render(scene, camera);
    if (game.debug) renderDebug();
  }

  /* Start */
  function initUI() {
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

  // boot
  buildMapList();
  initUI();
  onResize();
  loop();
})();
