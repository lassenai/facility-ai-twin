export const FACILITY = {
  id: 'SIM-ICT-F01',
  name: '서관 지하 설비실',
  width: 16,
  depth: 11,
  dock: { x: -6.2, z: 3.45 },
  inspection: { x: 4.15, z: -0.75 },
  obstruction: { x: 0, z: 1.05, w: 1.65, d: 1.6, h: 1.0 },
  assets: [
    { id: 'AHU-01', name: '공조 유닛', kind: 'ahu', x: -4.9, z: -2.6, w: 3.1, d: 2.1, h: 1.75, temperature: 32.8 },
    { id: 'CH-02', name: '냉각 순환 설비', kind: 'chiller', x: 4.8, z: -2.6, w: 2.65, d: 1.9, h: 1.35, temperature: 38.4 },
    { id: 'TK-01', name: '팽창 탱크', kind: 'tank', x: -4.6, z: 0.55, w: 1.4, d: 1.4, h: 2.45, temperature: 27.1 },
    { id: 'PU-01', name: '보조 순환 펌프', kind: 'pump', x: 1.55, z: -2.7, w: 1.75, d: 1.25, h: 0.95, temperature: 35.6 },
    { id: 'EL-01', name: '배전반', kind: 'electric', x: 5.25, z: 3.3, w: 3.0, d: 1.15, h: 2.05, temperature: 29.4 },
  ],
};

export const WALLS = [
  { x: 0, z: -5.0, w: 15, d: 0.18, h: 2.15 },
  { x: -7.5, z: -0.25, w: 0.18, d: 9.7, h: 1.15 },
  { x: 7.5, z: -0.25, w: 0.18, d: 9.7, h: 1.15 },
];

export function obstacles(blocked = false) {
  return [...FACILITY.assets, ...WALLS, ...(blocked ? [FACILITY.obstruction] : [])];
}

export function isFree(x, z, solids, radius = 0.46) {
  if (Math.abs(x) > 7.05 || z < -4.5 || z > 4.6) return false;
  return !solids.some(o => Math.abs(x - o.x) < o.w / 2 + radius && Math.abs(z - o.z) < o.d / 2 + radius);
}

export function clearSegment(a, b, solids, radius = 0.46) {
  if (!isFree(a.x, a.z, solids, radius) || !isFree(b.x, b.z, solids, radius)) return false;
  // Exact segment / inflated rectangle intersection. Sampling can miss a tiny
  // crossing at a corner, which then traps a robot beside the obstacle.
  for (const o of solids) {
    let enter = 0, exit = 1, intersects = true;
    for (const [axis, extent] of [['x', o.w], ['z', o.d]]) {
      const lo = o[axis] - extent / 2 - radius + 1e-8;
      const hi = o[axis] + extent / 2 + radius - 1e-8;
      const d = b[axis] - a[axis];
      if (Math.abs(d) < 1e-12) { if (a[axis] < lo || a[axis] > hi) { intersects = false; break; } }
      else {
        const t1 = (lo - a[axis]) / d, t2 = (hi - a[axis]) / d;
        enter = Math.max(enter, Math.min(t1, t2));
        exit = Math.min(exit, Math.max(t1, t2));
        if (exit < enter) { intersects = false; break; }
      }
    }
    if (intersects) return false;
  }
  return true;
}

// Eight-neighbor A* with obstacle inflation and no diagonal corner cutting.
export function findPath(start, goal, solids, radius = 0.46) {
  if (!isFree(start.x, start.z, solids, radius) || !isFree(goal.x, goal.z, solids, radius)) return [];
  if (clearSegment(start, goal, solids, radius)) return [{ ...start }, { ...goal }];
  const size = 0.3, nx = 49, nz = 32;
  const pos = (x, z) => ({ x: -7.2 + x * size, z: -4.5 + z * size });
  const idx = p => [Math.round((p.x + 7.2) / size), Math.round((p.z + 4.5) / size)];
  const key = (x, z) => x + ',' + z;
  const ok = (x, z) => x >= 0 && x < nx && z >= 0 && z < nz && isFree(pos(x, z).x, pos(x, z).z, solids, radius);
  // A continuous pose can be safe while its rounded grid cell is inside inflation.
  // Connect to the closest visible free cell rather than rejecting that pose.
  const anchor = p => {
    const [cx, cz] = idx(p), candidates = [];
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const x = cx + dx, z = cz + dz;
      if (ok(x, z) && clearSegment(p, pos(x, z), solids, radius)) candidates.push({ x, z, d: Math.hypot(p.x - pos(x, z).x, p.z - pos(x, z).z) });
    }
    candidates.sort((a, b) => a.d - b.d);
    return candidates[0];
  };
  const begin = anchor(start), end = anchor(goal);
  if (!begin || !end) return [];
  const sx = begin.x, sz = begin.z, gx = end.x, gz = end.z;
  const queue = [{ x: sx, z: sz, g: 0, f: 0 }];
  const costs = new Map([[key(sx, sz), 0]]), parent = new Map();
  while (queue.length) {
    queue.sort((a, b) => a.f - b.f);
    const cur = queue.shift(), ck = key(cur.x, cur.z);
    if (cur.g !== costs.get(ck)) continue;
    if (cur.x === gx && cur.z === gz) {
      const raw = [{ ...goal }];
      let k = ck;
      while (parent.has(k)) {
        const [x, z] = k.split(',').map(Number);
        raw.push(pos(x, z)); k = parent.get(k);
      }
      raw.push(pos(sx, sz), { ...start }); raw.reverse();
      const path = [raw[0]];
      let i = 0;
      while (i < raw.length - 1) {
        let j = raw.length - 1;
        while (j > i + 1 && !clearSegment(raw[i], raw[j], solids, radius)) j--;
        path.push(raw[j]); i = j;
      }
      return path;
    }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if ((!dx && !dz) || !ok(cur.x + dx, cur.z + dz)) continue;
      if (dx && dz && (!ok(cur.x + dx, cur.z) || !ok(cur.x, cur.z + dz))) continue;
      const x = cur.x + dx, z = cur.z + dz, nk = key(x, z);
      const g = cur.g + Math.hypot(dx, dz);
      if (g >= (costs.get(nk) ?? Infinity)) continue;
      costs.set(nk, g); parent.set(nk, ck);
      queue.push({ x, z, g, f: g + Math.hypot(gx - x, gz - z) });
    }
  }
  return [];
}

export function pathLength(path) {
  return path.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - path[i].x, p.z - path[i].z), 0);
}

export function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
