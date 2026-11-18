import { getStroke } from '../../vendor/perfect-freehand/index.mjs';

export function pointerPressure(event) {
  if (!Number.isFinite(event.pressure)) return .5;
  if (event.pointerType === 'mouse' && event.pressure === 0) return .5;
  return Math.max(0, Math.min(1, event.pressure));
}

export function appendStrokePoint(points, point, { terminal = false } = {}) {
  const previous = points.at(-1);
  if (!previous) { points.push(point); return; }
  const distance = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
  if (distance < .02) return; // Keep slow, light movement; discard only subpixel jitter.
  if (points.length > 1) {
    const before = points.at(-2);
    const step = Math.hypot(previous[0] - before[0], previous[1] - before[1]);
    if (distance > Math.max(240, step * 12)) return;
  }
  points.push([point[0], point[1], terminal ? previous[2] : point[2]]);
}

// Transient samples are [pageX, pageY, eventTimeMs], never saved in a stroke.
// Be conservative: short marks and a pause before lifting are separate actions.
export function canJoinStrokeSegments(previous, next) {
  if (!previous || !next) return false;
  const length = points => points.reduce((sum, p, i) => i ? sum + Math.hypot(p[0]-points[i-1][0], p[1]-points[i-1][1]) : 0, 0);
  const gapTime = next.startTime - previous.endTime;
  if (!Number.isFinite(gapTime) || gapTime < 0 || gapTime > 80 ||
      length(previous.points) < 3 || length(next.points) < 3) return false;
  const tail = previous.samples.slice(-4), first = tail[0], last = tail.at(-1);
  if (tail.length < 2 || tail.some((p, i) => !Number.isFinite(p[2]) || (i && p[2] < tail[i-1][2]))) return false;
  const duration = previous.endTime - first[2];
  const dx = last[0] - first[0], dy = last[1] - first[1], distance = Math.hypot(dx, dy);
  let lastMotionTime = -Infinity;
  for (let i = 1; i < tail.length; i++) {
    if (Math.hypot(tail[i][0]-tail[i-1][0], tail[i][1]-tail[i-1][1]) >= .02) lastMotionTime = tail[i][2];
  }
  if (duration <= 0 || previous.endTime < last[2] || previous.endTime - lastMotionTime > 16 || distance / duration < .08) return false;
  const end = previous.points.at(-1), start = next.points[0];
  const gx = start[0] - end[0], gy = start[1] - end[1], gap = Math.hypot(gx, gy);
  const aligned = (x, y) => (x * dx + y * dy) / (Math.hypot(x, y) * distance) >= .8;
  if (gap > 3 || (gap >= .02 && !aligned(gx, gy))) return false;
  // Require the new input to actually move in the same direction, not just tap.
  const moving = next.points.find(p => Math.hypot(p[0]-start[0], p[1]-start[1]) >= .5);
  return Boolean(moving && aligned(moving[0]-start[0], moving[1]-start[1]));
}

// Correct a copy so old strokes benefit without rewriting saved coordinates.
// Live, committed, raster and vector export all use this exact same pipeline.
export function drawingPressure(pressure) {
  return .35 + .65 * Math.pow(Math.max(0, Math.min(1, pressure)), .65);
}

export function strokePoints(stroke) {
  let pressure;
  return stroke.points.map(([x, y, raw], i, points) => {
    if (stroke.tool === 'highlighter') return [x, y, .5];
    let next = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : .5;
    if (pressure === undefined) pressure = next;
    else {
      if (next === 0 || (i === points.length - 1 && Math.abs(next - points[i - 1][2]) > .15)) next = pressure;
      pressure += Math.max(-.15, Math.min(.15, next - pressure)) * .35;
    }
    return [x, y, drawingPressure(pressure)];
  });
}

export function strokeOptions(stroke) {
  const highlight = stroke.tool === 'highlighter';
  // A 1.25pt minimum survives at least 1.25 device pixels at scale .5 / DPR 2.
  // Use page units (not viewport-dependent widths) so exports stay identical.
  const size = highlight ? stroke.size : Math.max(1.5, stroke.size);
  const length = stroke.points.reduce((sum, point, i, points) => i ? sum + Math.hypot(point[0] - points[i-1][0], point[1] - points[i-1][1]) : 0, 0);
  const taper = highlight || length < size * 3 ? 0 : Math.min(size * 1.5, length * .2);
  const endFloor = Math.min(1, 1.25 / (size * .88));
  return { size, thinning:highlight ? 0 : .4, smoothing:.7,
    streamline:.35, simulatePressure:false, last:true,
    start:{ taper:0 }, end:{ taper, easing:t => endFloor + (1 - endFloor) * (1 - (1-t) ** 3) } };
}

export function strokeOutline(stroke) {
  return getStroke(strokePoints(stroke), strokeOptions(stroke));
}
