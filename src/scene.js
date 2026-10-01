import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FACILITY, WALLS, obstacles } from './facility.js';

export function createFacilityScene(host, labelHost, onSelect) {
  const mobile = matchMedia('(max-width: 600px)').matches;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8eff3);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 120);
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.25 : 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  host.prepend(renderer.domElement);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const envTarget = pmrem.fromScene(environment, 0.04);
  scene.environment = envTarget.texture;
  environment.dispose(); pmrem.dispose();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !reducedMotion;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.minDistance = 5;
  controls.maxDistance = 37;
  controls.maxPolarAngle = Math.PI / 2 - 0.07;
  controls.target.set(0, 0.5, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb5c7d5, 2.6));
  const sun = new THREE.DirectionalLight(0xfff7eb, 3.6);
  sun.position.set(-5, 15, 8); sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  sun.shadow.camera.left = -12; sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 11; sun.shadow.camera.bottom = -11;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 40;
  sun.shadow.normalBias = 0.025; sun.shadow.bias = -0.0001;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbbd8ff, 1.1);
  fill.position.set(7, 5, -7); scene.add(fill);
  const mats = {
    white: new THREE.MeshStandardMaterial({ color: 0xe9eef0, roughness: 0.36, metalness: 0.32 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xa2b5bf, roughness: 0.28, metalness: 0.78 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x3a5063, roughness: 0.55, metalness: 0.4 }),
    blue: new THREE.MeshStandardMaterial({ color: 0x527ba1, roughness: 0.42, metalness: 0.5 }),
    cyan: new THREE.MeshStandardMaterial({ color: 0x36acba, roughness: 0.34, metalness: 0.45 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x263949, roughness: 0.85, metalness: 0.03 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xcad7df, roughness: 0.86 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xb8d7e2, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.2, depthWrite: false }),
    amber: new THREE.MeshStandardMaterial({ color: 0xe9a452, roughness: 0.5, metalness: 0.25 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xf8fbfc, roughness: 0.9 }),
  };
  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (parent, w, h, d, mat, x = 0, y = 0, z = 0, rounded = false) =>
    mesh(rounded ? new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.08) : new THREE.BoxGeometry(w, h, d), mat, parent, x, y, z);
  const cylinder = (parent, radius, height, mat, x = 0, y = 0, z = 0, segments = 20) =>
    mesh(new THREE.CylinderGeometry(radius, radius, height, segments), mat, parent, x, y, z);
  const pipe = (parent, points, radius = 0.07, mat = mats.metal) => {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)), false, 'centripetal');
    return mesh(new THREE.TubeGeometry(curve, points.length * 8, radius, 7, false), mat, parent);
  };
  const planeText = (text, width, height, color = '#526c80', background = null) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const ctx = c.getContext('2d');
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.font = '600 62px Pretendard, sans-serif'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 64);
    const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: !background, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  };
  const structure = new THREE.Group(); scene.add(structure);
  const backgroundFloor = mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0xe8eff3, roughness: 1 }), scene, 0, -0.29, 0);
  backgroundFloor.rotation.x = -Math.PI / 2;
  box(structure, 16.5, 0.28, 11.3, mats.concrete, 0, -0.14, 0, true);
  box(structure, 16.1, 0.035, 10.9, new THREE.MeshStandardMaterial({ color: 0xdce5e8, roughness: 0.8 }), 0, 0.017, 0);
  for (let x = -7; x <= 7; x++) box(structure, 0.008, 0.003, 10.7, new THREE.MeshBasicMaterial({ color: 0xc3d1d9 }), x, 0.038, 0);
  for (let z = -4.5; z <= 4.5; z++) box(structure, 15.5, 0.003, 0.008, new THREE.MeshBasicMaterial({ color: 0xc3d1d9 }), 0, 0.038, z);
  for (const wall of WALLS) {
    box(structure, wall.w, wall.h, wall.d, mats.white, wall.x, wall.h / 2, wall.z);
    box(structure, wall.w + 0.03, 0.05, wall.d + 0.03, mats.metal, wall.x, wall.h + 0.025, wall.z);
  }
  // The front and roof are intentionally cut away, so operating paths remain visible.
  for (const x of [-7.45, -0.5, 7.45]) {
    box(structure, 0.16, 2.75, 0.16, mats.metal, x, 1.38, -4.92);
    box(structure, 0.32, 0.13, 0.32, mats.dark, x, 0.065, -4.92);
  }
  for (let x = -6.6; x < 6.7; x += 2.2) {
    box(structure, 1.75, 0.68, 0.025, mats.glass, x, 1.45, -4.88);
    for (const dx of [-0.9, 0.9]) box(structure, 0.03, 0.75, 0.045, mats.metal, x + dx, 1.45, -4.84);
  }
  for (let i = 0; i < 3; i++) {
    pipe(structure, [[-7, 2.8 + i * 0.16, -4.4], [-2.2, 2.8 + i * 0.16, -4.4], [3.0, 2.8 + i * 0.16, -4.4], [6.7, 2.8 + i * 0.16, -4.4]], 0.058, i === 1 ? mats.blue : mats.metal);
    for (const x of [-6, -1.6, 3.5, 6]) box(structure, 0.045, 0.28, 0.4, mats.dark, x, 2.9, -4.4);
  }
  box(structure, 2.25, 0.012, 1.15, new THREE.MeshStandardMaterial({ color: 0xcbdde6, roughness: 0.8 }), -6.0, 0.043, 3.5);
  const dockText = planeText('R-01 / DOCK', 1.65, 0.35); dockText.rotation.x = -Math.PI / 2; dockText.position.set(-6, 0.052, 4.25); structure.add(dockText);
  for (const z of [2.67, 4.23]) box(structure, 2.65, 0.008, 0.04, mats.paint, -6, 0.05, z);
  const dock = new THREE.Group(); dock.position.set(-6.85, 0, 3.45); scene.add(dock);
  box(dock, 0.22, 0.7, 0.8, mats.dark, 0, 0.35, 0, true);
  box(dock, 0.03, 0.1, 0.55, mats.cyan, 0.13, 0.45, 0);
  const laneLabel = planeText('Inspection corridor', 2.8, 0.43, '#94aab8');
  laneLabel.rotation.x = -Math.PI / 2; laneLabel.position.set(0.2, 0.055, 3.75); structure.add(laneLabel);
  for (let i = 0; i < 10; i++) box(structure, 0.45, 0.005, 0.025, mats.paint, -3.4 + i * 0.65, 0.05, 2.4);
  const assetRoots = new Map(), selectable = [], fans = [], labels = [];
  const makeFan = (parent, x, y, z, radius, vertical = true) => {
    const fan = new THREE.Group(); fan.position.set(x, y, z); if (!vertical) fan.rotation.x = -Math.PI / 2; parent.add(fan);
    const opening = cylinder(fan, radius, 0.06, mats.rubber, 0, 0, 0); opening.rotation.x = Math.PI / 2;
    const ring = mesh(new THREE.TorusGeometry(radius * 0.94, 0.022, 7, 28), mats.metal, fan);
    ring.position.z = 0.05;
    const rotor = new THREE.Group(); rotor.position.z = 0.07; fan.add(rotor);
    for (let i = 0; i < 6; i++) {
      const blade = box(rotor, radius * 0.62, radius * 0.21, 0.025, mats.metal, 0, 0, 0, true);
      const a = i * Math.PI / 3; blade.position.set(Math.cos(a) * radius * 0.43, Math.sin(a) * radius * 0.43, 0);
      blade.rotation.z = a + 0.4;
    }
    const hub = cylinder(rotor, radius * 0.13, 0.065, mats.dark); hub.rotation.x = Math.PI / 2;
    fans.push(rotor);
    return fan;
  };
  for (const asset of FACILITY.assets) {
    const group = new THREE.Group(); group.position.set(asset.x, 0, asset.z); group.userData.assetId = asset.id;
    scene.add(group); assetRoots.set(asset.id, group);
    box(group, asset.w + 0.18, 0.17, asset.d + 0.17, mats.dark, 0, 0.09, 0, true);
    if (asset.kind === 'ahu') {
      box(group, asset.w, 1.48, asset.d, mats.white, 0, 0.92, 0, true);
      box(group, 0.045, 1.36, asset.d + 0.012, mats.metal, 0, 0.94, 0);
      makeFan(group, -0.75, 1.0, 1.075, 0.43);
      makeFan(group, 0.75, 1.0, 1.075, 0.43);
      for (let x = -1.38; x < 1.4; x += 0.15) box(group, 0.035, 0.16, 0.018, mats.dark, x, 0.44, 1.08);
      box(group, 2.5, 0.2, 1.4, mats.metal, 0, 1.75, 0);
      pipe(group, [[0.9, 1.6, -1], [0.9, 2.65, -1.4], [0.9, 2.78, -1.8]], 0.23);
    } else if (asset.kind === 'chiller') {
      box(group, asset.w, 1.1, asset.d, mats.white, 0, 0.78, 0, true);
      const grille = new THREE.MeshStandardMaterial({ color: 0x778e9f, metalness: 0.48, roughness: 0.65 });
      for (let x = -1.17; x < 1.18; x += 0.13) box(group, 0.025, 0.73, 0.02, grille, x, 0.75, 0.97);
      for (const x of [-0.65, 0.65]) makeFan(group, x, 1.34, 0, 0.46, false);
      for (const x of [-1.45, 1.45]) {
        pipe(group, [[x, 0.45, 0.65], [x, 0.45, -0.6], [x, 1.65, -1.4], [x, 2.8, -1.8]], 0.095, mats.blue);
        cylinder(group, 0.13, 0.18, mats.metal, x, 0.9, -0.7);
      }
      box(group, 0.3, 0.2, 0.03, mats.dark, 0.85, 1.05, 0.985);
      box(group, 0.18, 0.07, 0.01, mats.cyan, 0.85, 1.075, 1.006);
    } else if (asset.kind === 'tank') {
      cylinder(group, 0.57, 1.82, mats.metal, 0, 1.24, 0, 28);
      const top = mesh(new THREE.SphereGeometry(0.57, 24, 12), mats.metal, group, 0, 2.15, 0); top.scale.y = 0.42;
      const bottom = mesh(new THREE.SphereGeometry(0.57, 24, 12), mats.metal, group, 0, 0.33, 0); bottom.scale.y = 0.42;
      for (const y of [0.45, 1.0, 1.6, 2.1]) cylinder(group, 0.582, 0.025, mats.dark, 0, y, 0, 28);
      for (const x of [-0.35, 0.35]) box(group, 0.11, 0.35, 0.9, mats.dark, x, 0.25, 0);
      pipe(group, [[0.58, 0.75, 0], [1.0, 0.75, 0], [1.0, 0.2, -1.8]], 0.07, mats.blue);
      const gauge = cylinder(group, 0.095, 0.07, mats.white, 0, 1.45, 0.59); gauge.rotation.x = Math.PI / 2;
    } else if (asset.kind === 'pump') {
      for (const x of [-0.5, 0.5]) {
        const motor = cylinder(group, 0.25, 0.75, mats.blue, x, 0.55, 0); motor.rotation.x = Math.PI / 2;
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          box(group, 0.02, 0.03, 0.57, mats.metal, x + Math.cos(a) * 0.26, 0.55 + Math.sin(a) * 0.26, 0);
        }
        pipe(group, [[x, 0.53, -0.42], [x, 0.53, -0.75], [x, 1.5, -1.1], [x, 1.5, -1.8]], 0.085, mats.blue);
      }
    } else {
      box(group, asset.w, 1.84, asset.d, mats.white, 0, 1.12, 0, true);
      for (const x of [-1, 0, 1]) {
        box(group, 0.025, 1.73, 0.024, mats.metal, x - 0.49, 1.12, 0.586);
        box(group, 0.04, 0.3, 0.05, mats.dark, x + 0.32, 1.0, 0.61);
        box(group, 0.34, 0.15, 0.03, mats.dark, x, 1.5, 0.606);
        for (let i = 0; i < 6; i++) box(group, 0.58, 0.024, 0.02, mats.metal, x, 0.53 + i * 0.055, 0.6);
      }
    }
    const plate = planeText(asset.id, 0.57, 0.14, '#f7fafc', '#455f76');
    plate.position.set(asset.w * -0.3, asset.kind === 'tank' ? 1.1 : 0.32, asset.d / 2 + 0.04); group.add(plate);
    group.traverse(o => { if (o.isMesh) selectable.push(o); });
    const label = document.createElement('button'); label.className = 'asset-label';
    label.setAttribute('aria-label', asset.name + ' 상태 보기');
    label.textContent = asset.id;
    const temp = document.createElement('span'); temp.className = 'label-temp'; temp.textContent = asset.temperature.toFixed(1) + '°'; label.append(temp);
    label.onclick = () => onSelect(asset.id);
    labelHost.append(label); labels.push({ element: label, asset, temp, point: new THREE.Vector3(asset.x, asset.h + 0.42, asset.z) });
  }
  // Pipework belongs to the equipment, while collision footprints use the validated navigation geometry.
  pipe(structure, [[-3.2, 0.3, -3.5], [-2.1, 0.3, -3.5], [-2.1, 0.3, -4.0], [2.0, 0.3, -4.0], [2.0, 0.3, -3.5]], 0.065, mats.cyan);
  const blocker = new THREE.Group(); const ob = FACILITY.obstruction;
  blocker.position.set(ob.x, 0, ob.z); scene.add(blocker); blocker.visible = false;
  box(blocker, ob.w, 0.18, ob.d, mats.dark, 0, 0.1, 0);
  box(blocker, ob.w - 0.1, 0.8, ob.d - 0.1, new THREE.MeshStandardMaterial({ color: 0xc89766, roughness: 0.9 }), 0, 0.6, 0, true);
  for (const x of [-0.45, 0.45]) box(blocker, 0.06, 0.82, ob.d, mats.dark, x, 0.61, 0);
  for (const z of [-0.44, 0.44]) box(blocker, ob.w, 0.025, 0.12, mats.amber, 0, 1.03, z);
  const goal = new THREE.Group(); goal.position.set(FACILITY.inspection.x, 0.06, FACILITY.inspection.z); scene.add(goal);
  const goalRing = mesh(new THREE.TorusGeometry(0.45, 0.025, 6, 48), new THREE.MeshBasicMaterial({ color: 0x23a9bd, transparent: true, opacity: 0.8 }), goal); goalRing.rotation.x = -Math.PI / 2;
  const goalCenter = mesh(new THREE.CircleGeometry(0.13, 24), new THREE.MeshBasicMaterial({ color: 0x23a9bd, transparent: true, opacity: 0.7 }), goal); goalCenter.rotation.x = -Math.PI / 2;
  const hotMaterial = new THREE.MeshBasicMaterial({ color: 0xec8b42, transparent: true, opacity: 0.07, depthWrite: false });
  const halo = mesh(new THREE.CylinderGeometry(1.45, 1.65, 2.0, 40, 1, true), hotMaterial, scene, 4.8, 1.15, -2.6);
  halo.visible = false;
  const alarmRing = mesh(new THREE.TorusGeometry(1.7, 0.035, 6, 48), new THREE.MeshBasicMaterial({ color: 0xe9974f, transparent: true, opacity: 0.7 }), scene, 4.8, 0.07, -2.6);
  alarmRing.rotation.x = -Math.PI / 2; alarmRing.visible = false;
  const selection = mesh(new THREE.TorusGeometry(1.75, 0.012, 5, 64), new THREE.MeshBasicMaterial({ color: 0x769cda, transparent: true, opacity: 0.65 }), scene);
  selection.rotation.x = -Math.PI / 2;
  const robot = new THREE.Group(); scene.add(robot);
  const wheels = [];
  for (const x of [-0.25, 0.25]) for (const z of [-0.27, 0.27]) {
    const wheel = cylinder(robot, 0.145, 0.095, mats.rubber, x, 0.16, z, 20); wheel.rotation.x = Math.PI / 2; wheels.push(wheel);
    const hub = cylinder(robot, 0.075, 0.102, mats.metal, x, 0.16, z, 16); hub.rotation.x = Math.PI / 2;
  }
  box(robot, 0.75, 0.25, 0.47, mats.white, 0, 0.33, 0, true);
  box(robot, 0.61, 0.06, 0.4, mats.blue, 0, 0.485, 0, true);
  box(robot, 0.03, 0.05, 0.34, mats.cyan, 0.385, 0.36, 0);
  cylinder(robot, 0.036, 0.35, mats.metal, -0.15, 0.66, 0);
  box(robot, 0.17, 0.13, 0.2, mats.dark, -0.15, 0.89, 0, true);
  cylinder(robot, 0.095, 0.09, mats.cyan, 0.17, 0.57, 0);
  const cameraLens = cylinder(robot, 0.043, 0.05, mats.cyan, -0.04, 0.89, 0); cameraLens.rotation.z = Math.PI / 2;
  const scanPositions = new Float32Array(25 * 2 * 3);
  const scanGeometry = new THREE.BufferGeometry(); scanGeometry.setAttribute('position', new THREE.BufferAttribute(scanPositions, 3));
  const scan = new THREE.LineSegments(scanGeometry, new THREE.LineBasicMaterial({ color: 0x299fad, transparent: true, opacity: 0.2, depthWrite: false })); scene.add(scan);
  const marker = mesh(new THREE.TorusGeometry(0.65, 0.018, 5, 48), new THREE.MeshBasicMaterial({ color: 0x315de0, transparent: true, opacity: 0.65 }), scene); marker.rotation.x = -Math.PI / 2;
  let route = null, routeVersion = -1, selected = 'CH-02', thermal = false, view = 'orbit', body = null;
  const targetPos = new THREE.Vector3(), targetLook = new THREE.Vector3();
  let cameraTransition = false;
  const orbitPosition = () => new THREE.Vector3(mobile ? 19 : 14.5, mobile ? 17 : 12.6, mobile ? 22 : 16.3);
  camera.position.copy(orbitPosition()); camera.lookAt(controls.target);
  function setView(value, immediate = false) {
    view = value;
    if (value === 'top') { targetPos.set(0.02, 28, 0.02); targetLook.set(0, 0, 0); }
    else if (value === 'follow') { targetPos.copy(robot.position).add(new THREE.Vector3(5, 4.5, 5)); targetLook.copy(robot.position).add(new THREE.Vector3(0, 0.6, 0)); }
    else { targetPos.copy(orbitPosition()); targetLook.set(0, 0.5, 0); }
    cameraTransition = true;
    if (immediate || reducedMotion) { camera.position.copy(targetPos); controls.target.copy(targetLook); cameraTransition = false; controls.update(); }
  }
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; cameraTransition = false; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 7) return;
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(selectable, false)[0];
    if (hit) { let obj = hit.object; while (obj && !obj.userData.assetId) obj = obj.parent; if (obj) onSelect(obj.userData.assetId); }
    down = null;
  });
  function rebuildRoute(points) {
    if (route) { scene.remove(route); route.geometry.dispose(); route.material.dispose(); route = null; }
    if (points.length < 2) return;
    const line = new THREE.CurvePath();
    for (let i = 1; i < points.length; i++) line.add(new THREE.LineCurve3(new THREE.Vector3(points[i - 1].x, 0.085, points[i - 1].z), new THREE.Vector3(points[i].x, 0.085, points[i].z)));
    route = new THREE.Mesh(new THREE.TubeGeometry(line, Math.max(8, points.length * 8), 0.022, 5, false), new THREE.MeshBasicMaterial({ color: 0x4c75de, transparent: true, opacity: 0.86 }));
    scene.add(route);
  }
  function updateScan(s) {
    const p = s.robot, solids = obstacles(s.blocked);
    for (let i = 0; i < 25; i++) {
      const a = p.yaw - 0.75 + i / 24 * 1.5;
      let range = 2.1;
      for (let d = 0.5; d < range; d += 0.12) {
        const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
        if (solids.some(o => Math.abs(x - o.x) < o.w / 2 && Math.abs(z - o.z) < o.d / 2)) { range = d; break; }
      }
      const k = i * 6;
      scanPositions.set([p.x, 0.25, p.z, p.x + Math.cos(a) * range, 0.08, p.z + Math.sin(a) * range], k);
    }
    scanGeometry.attributes.position.needsUpdate = true;
  }
  let frame = 0, lastThermal = null;
  const thermalMats = new Map();
  function thermalColor(temp) { return new THREE.Color().setHSL(0.57 - Math.min(1, Math.max(0, (temp - 25) / 65)) * 0.55, 0.65, 0.62); }
  const resize = new ResizeObserver(() => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  });
  resize.observe(host);
  function update(s, dt) {
    frame++;
    robot.position.set(s.robot.x, 0.02, s.robot.z); robot.rotation.y = -s.robot.yaw;
    robot.visible = !body;
    marker.position.set(s.robot.x, 0.068, s.robot.z);
    scan.visible = s.active && s.stage !== 'complete';
    if (frame % 3 === 0) updateScan(s);
    for (const wheel of wheels) wheel.rotation.z += s.robot.speed * dt / 0.145;
    for (const fan of fans) fan.rotation.z += (0.9 + s.fan / 20) * dt;
    blocker.visible = s.blocked;
    const isHot = s.temperature > 60;
    halo.visible = isHot; alarmRing.visible = isHot;
    if (isHot) {
      const amplitude = reducedMotion ? 1 : 1 + 0.035 * Math.sin(s.time * 3.5);
      alarmRing.scale.setScalar(amplitude);
      hotMaterial.opacity = thermal ? 0.17 : 0.07;
    }
    if (s.routeVersion !== routeVersion) { routeVersion = s.routeVersion; rebuildRoute(s.route); }
    if (route) route.visible = s.active;
    goal.visible = s.active && s.stage !== 'complete' && s.stage !== 'return';
    const chosen = FACILITY.assets.find(a => a.id === selected);
    selection.position.set(chosen.x, 0.057, chosen.z);
    selection.scale.setScalar(Math.max(chosen.w, chosen.d) / 3.0);
    if (thermal !== lastThermal || thermal && frame % 12 === 0) {
      for (const asset of FACILITY.assets) assetRoots.get(asset.id).traverse(o => {
        if (!o.isMesh || !o.material || o.material.map) return;
        if (!o.userData.originalMaterial) o.userData.originalMaterial = o.material;
        if (thermal) {
          let mat = thermalMats.get(asset.id);
          if (!mat) { mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 }); thermalMats.set(asset.id, mat); }
          mat.color.copy(thermalColor(asset.id === 'CH-02' ? s.temperature : asset.temperature));
          o.material = mat;
        } else o.material = o.userData.originalMaterial;
      });
      lastThermal = thermal;
    }
    if (view === 'follow') {
      targetPos.set(s.robot.x + 5, 5, s.robot.z + 5);
      targetLook.set(s.robot.x, 0.5, s.robot.z);
      camera.position.lerp(targetPos, 1 - Math.exp(-dt * 3)); controls.target.lerp(targetLook, 1 - Math.exp(-dt * 4));
    } else if (cameraTransition) {
      camera.position.lerp(targetPos, 1 - Math.exp(-dt * 5)); controls.target.lerp(targetLook, 1 - Math.exp(-dt * 5));
      if (camera.position.distanceTo(targetPos) < 0.02) cameraTransition = false;
    }
    controls.update();
    renderer.render(scene, camera);
    const positioned = [];
    if (frame % 2 === 0) for (const item of labels) {
      const p = item.point.clone().project(camera);
      const x = (p.x + 1) / 2 * host.clientWidth;
      let y = (1 - p.y) / 2 * host.clientHeight;
      // Lift colliding annotations so each asset can be selected on a small screen.
      for (let pass = 0; pass < 6; pass++) {
        if (!positioned.some(q => Math.abs(q.x - x) < 76 && Math.abs(q.y - y) < 23)) break;
        y -= 25;
      }
      positioned.push({ x, y });
      item.element.style.left = x + 'px'; item.element.style.top = y + 'px';
      item.element.hidden = p.z > 1 || x < 20 || x > host.clientWidth - 20 || y < 18 || y > host.clientHeight - 30;
      const t = item.asset.id === 'CH-02' ? s.reported : item.asset.temperature;
      item.temp.textContent = t.toFixed(1) + '°';
      item.element.classList.toggle('hot', t > 60);
      item.element.classList.toggle('active', item.asset.id === selected);
    }
  }
  function destroy() {
    resize.disconnect(); controls.dispose();
    scene.traverse(o => { o.geometry?.dispose(); });
    for (const mat of Object.values(mats)) mat.dispose();
    envTarget.dispose(); renderer.dispose();
  }
  return {
    scene, update, destroy, setView,
    setThermal: value => { thermal = value; },
    select: value => { selected = value; },
    setPreciseBody: value => { body = value; },
  };
}
