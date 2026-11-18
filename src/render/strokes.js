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
  if (distance < .15) return; // Ignore duplicate/jitter samples, including lifts.
  if (points.length > 1) {
    const before = points.at(-2);
    const step = Math.hypot(previous[0] - before[0], previous[1] - before[1]);
    if (distance > Math.max(240, step * 12)) return;
  }
  points.push([point[0], point[1], terminal ? previous[2] : point[2]]);
}

// Correct a copy so old strokes benefit without rewriting saved coordinates.
// Live, committed, raster and vector export all use this exact same pipeline.
export function strokePoints(stroke) {
  let pressure;
  return stroke.points.map(([x, y, raw], i, points) => {
    if (stroke.tool === 'highlighter') return [x, y, .5];
    let next = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : .5;
    if (pressure === undefined) pressure = next;
    else {
      if (i === points.length - 1 && (next === 0 || Math.abs(next - points[i - 1][2]) > .15)) next = pressure;
      pressure += Math.max(-.15, Math.min(.15, next - pressure)) * .35;
    }
    return [x, y, pressure];
  });
}

export function strokeOptions(stroke) {
  const highlight = stroke.tool === 'highlighter';
  return { size:stroke.size, thinning:highlight ? 0 : .55, smoothing:.7,
    streamline:.35, simulatePressure:false, last:true,
    start:{ taper:0 }, end:{ taper:highlight ? 0 : stroke.size * 1.5 } };
}

export function strokeOutline(stroke) {
  return getStroke(strokePoints(stroke), strokeOptions(stroke));
}
