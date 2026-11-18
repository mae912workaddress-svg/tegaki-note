import { uid } from './notebooks.js';
export function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function pointInPolygon(p, polygon) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (distanceToSegment(p, a, b) < 1e-7) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export const selectStrokes = (strokes, polygon) => strokes.filter(s => s.points.every(p => pointInPolygon(p, polygon))).map(s => s.id);
export function strokeHit(stroke, center, radius) {
  const r = radius + stroke.size / 2;
  return stroke.points.some((p, i, points) => distanceToSegment(center, p, points[Math.max(0, i - 1)]) <= r);
}
const interpolate = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// Clip segments against the eraser circle, including sparse two-point strokes.
export function erasePartial(stroke, center, radius, makeId = uid) {
  if (!strokeHit(stroke, center, radius)) return [stroke];
  const r = radius + stroke.size / 2, chunks = []; let current = [];
  const finish = () => { if (current.length) chunks.push(current); current = []; };
  if (stroke.points.length === 1) return Math.hypot(stroke.points[0][0] - center[0], stroke.points[0][1] - center[1]) <= r ? [] : [stroke];
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1], b = stroke.points[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const ax = a[0] - center[0], ay = a[1] - center[1];
    const A = dx * dx + dy * dy, B = 2 * (ax * dx + ay * dy), C = ax * ax + ay * ay - r * r;
    const cuts = [0, 1], disc = B * B - 4 * A * C;
    if (A > 0 && disc > 0) for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) if (t > 0 && t < 1) cuts.push(t);
    cuts.sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      const lo = cuts[j - 1], hi = cuts[j], mid = interpolate(a, b, (lo + hi) / 2);
      if (Math.hypot(mid[0] - center[0], mid[1] - center[1]) <= r) { finish(); continue; }
      if (!current.length) current.push(interpolate(a, b, lo));
      current.push(interpolate(a, b, hi));
    }
  }
  finish();
  return chunks.map(points => ({ ...stroke, id: makeId(), points }));
}
export function eraseAt(strokes, center, radius, mode = 'whole') {
  return strokes.flatMap(s => mode === 'partial' ? erasePartial(s, center, radius) : strokeHit(s, center, radius) ? [] : [s]);
}
export function moveStrokes(strokes, ids, dx, dy, width, height) {
  const selected = strokes.filter(s => ids.includes(s.id));
  if (!selected.length) return strokes;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of selected) for (const [x, y] of s.points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  dx = Math.max(-minX, Math.min(width - maxX, dx)); dy = Math.max(-minY, Math.min(height - maxY, dy));
  return strokes.map(s => ids.includes(s.id) ? { ...s, points: s.points.map(([x, y, p]) => [x + dx, y + dy, p]) } : s);
}
