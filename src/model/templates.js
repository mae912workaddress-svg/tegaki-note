export const MM = 72 / 25.4;
export const A4 = Object.freeze({ width: 595.28, height: 841.89 });
export const TEMPLATES = Object.freeze({ blank: '無地', grid: '方眼', ruled: '横罫', dot: 'ドット方眼' });
export function dimensions(orientation = 'portrait') {
  return orientation === 'landscape' ? { width: A4.height, height: A4.width } : { ...A4 };
}
// Coordinates in points are shared by screen rendering and future exporters.
export function templateGeometry(template, width, height) {
  const lines = [], dots = [];
  if (!Object.hasOwn(TEMPLATES, template) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 10000 || height > 10000) throw new Error('用紙が不正です');
  const grid = 5 * MM;
  if (template === 'grid') {
    for (let x = grid; x < width; x += grid) lines.push([x, 0, x, height]);
    for (let y = grid; y < height; y += grid) lines.push([0, y, width, y]);
  } else if (template === 'ruled') {
    for (let y = 14 * MM; y < height; y += 7 * MM) lines.push([0, y, width, y]);
  } else if (template === 'dot') {
    for (let y = grid; y < height; y += grid) for (let x = grid; x < width; x += grid) dots.push([x, y]);
  }
  return { lines, dots };
}
