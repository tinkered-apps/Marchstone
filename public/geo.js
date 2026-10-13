/* geo.js: pure geometry. No DOM, no state. Everything in metres.
 *
 * Small areas (a field, not a country) let us flatten lat/lng onto a local
 * tangent plane and then do ordinary 2D maths. Error over a few km is
 * centimetres, which is far below GPS noise.
 */

import { t } from './i18n.js';

const EARTH_R = 6378137; // WGS84 equatorial radius, metres
const D2R = Math.PI / 180;

/* Build a lat/lng -> metres projector centred on a reference point. */
export function projector(refLat, refLng) {
  const kx = Math.cos(refLat * D2R) * EARTH_R * D2R;
  const ky = EARTH_R * D2R;
  return {
    to: (lat, lng) => [(lng - refLng) * kx, (lat - refLat) * ky],
    from: (x, y) => [refLat + y / ky, refLng + x / kx],
  };
}

/* Centre of a ring of [lat, lng] points, used as the projection reference. */
export function centroid(ring) {
  let lat = 0, lng = 0;
  for (const p of ring) { lat += p[0]; lng += p[1]; }
  return [lat / ring.length, lng / ring.length];
}

/* Project a ring of [lat, lng] to an array of [x, y] metres. */
function projectRing(ring, proj) {
  return ring.map((p) => proj.to(p[0], p[1]));
}

/* Ray casting. Points exactly on an edge are ambiguous here, but the border
 * band in evaluate() catches those long before it matters. */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* Shortest distance from a point to a line segment. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* Shortest distance from a point to the closed ring's outline. */
function distToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distToSegment(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d < best) best = d;
  }
  return best;
}

/* The whole question this app exists to answer.
 *
 *   point   [lat, lng]
 *   ring    array of [lat, lng], not repeating the first point
 *   buffer  half-width of the "on the border" band, metres
 *
 * Returns { status, inside, distance, signed } where distance is metres to
 * the nearest boundary line and signed is +inside / -outside. */
export function evaluate(point, ring, buffer) {
  if (!ring || ring.length < 3) return null;
  const c = centroid(ring);
  const proj = projector(c[0], c[1]);
  const flat = projectRing(ring, proj);
  const [x, y] = proj.to(point[0], point[1]);

  const inside = pointInRing(x, y, flat);
  const distance = distToRing(x, y, flat);
  const status = distance <= buffer ? 'border' : inside ? 'inside' : 'outside';
  return { status, inside, distance, signed: inside ? distance : -distance };
}

/* Enclosed area in square metres (shoelace on the projected ring). */
export function area(ring) {
  if (!ring || ring.length < 3) return 0;
  const c = centroid(ring);
  const flat = projectRing(ring, projector(c[0], c[1]));
  let sum = 0;
  for (let i = 0, j = flat.length - 1; i < flat.length; j = i++) {
    sum += flat[j][0] * flat[i][1] - flat[i][0] * flat[j][1];
  }
  return Math.abs(sum / 2);
}

/* Closed perimeter length in metres. */
export function perimeter(ring) {
  if (!ring || ring.length < 2) return 0;
  const c = centroid(ring);
  const flat = projectRing(ring, projector(c[0], c[1]));
  let sum = 0;
  for (let i = 0, j = flat.length - 1; i < flat.length; j = i++) {
    sum += Math.hypot(flat[i][0] - flat[j][0], flat[i][1] - flat[j][1]);
  }
  return sum;
}

/* Great-circle distance between two [lat, lng] points, metres. */
export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * D2R;
  const dLng = (b[1] - a[1]) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/* 4787134.00 cannot be read at a glance, and a drawing made with the map zoomed
 * out (no fix yet, a mis-tap) is exactly where it turns up. Groups of three
 * from five digits, set off with a no-break space: unlike a comma or a dot it is
 * a decimal point in no locale, so it reads the same on any phone. */
export function groupNumber(n, decimals) {
  const [whole, frac] = n.toFixed(decimals).split('.');
  const digits = whole.replace('-', '').length;
  const grouped = digits < 5 ? whole : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac === undefined ? grouped : grouped + '.' + frac;
}

export const formatHa = (ha) => groupNumber(ha, ha < 1 ? 3 : 2);
export const formatAcres = (ha) => groupNumber(ha * 2.4711, 2);

export function formatArea(m2) {
  const ha = m2 / 10000;
  if (ha < 1) return `${Math.round(m2)} m² (${formatAcres(ha)} ${t('unit.ac')})`;
  return `${formatHa(ha)} ha (${formatAcres(ha)} ${t('unit.ac')})`;
}

export function formatLength(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${groupNumber(m / 1000, 2)} km`;
}

/* ------------------------------------------------------------- validation
 *
 * A boundary arrives from a file somebody else's software wrote, or from
 * fingers on a map, and from then on the app answers a safety question
 * against it. So it gets checked once, at the door.
 *
 * Two severities, and the difference matters. Fatal means the ring cannot be
 * used at all, nothing here can answer "am I inside it?" Warnings mean the
 * shape is odd but workable, and those never block: a walked perimeter
 * crossing itself near the gate is an ordinary GPX track, and refusing it
 * would break the import that matters most.
 *
 * Returns { fatal: [...], warn: [...] }, both arrays of plain sentences. */

const MIN_VERTEX_GAP = 0.5;    // metres, closer than this is the same corner twice
const MIN_AREA = 1;            // m², below this the corners are in a line
const BIG_EXTENT = 25000;      // metres across before the flat-earth maths is a stretch
const CROSS_CHECK_LIMIT = 1200; // points, past this the O(n²) crossing check is skipped

/* Consecutive points closer together than a footstep are one corner. */
export function dedupe(ring) {
  if (!ring || ring.length < 2) return ring || [];
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    if (haversine(out[out.length - 1], ring[i]) >= MIN_VERTEX_GAP) out.push(ring[i]);
  }
  // The ring closes, so the last point must also clear the first.
  while (out.length > 2 && haversine(out[out.length - 1], out[0]) < MIN_VERTEX_GAP) out.pop();
  return out;
}

/* Corner-to-corner span of the bounding box, metres. */
export function extent(ring) {
  if (!ring || !ring.length) return 0;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of ring) {
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLng) minLng = p[1];
    if (p[1] > maxLng) maxLng = p[1];
  }
  return haversine([minLat, minLng], [maxLat, maxLng]);
}

/* Do two segments properly cross? Touching at a shared endpoint does not
 * count, which is what lets adjacent edges of any ordinary ring pass. */
function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => {
    const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0;
  };
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/* Does the closed outline cross itself? A figure of eight has no inside, so
 * point-in-polygon stops meaning what the user thinks it means. */
export function selfIntersects(ring) {
  const n = ring.length;
  if (n < 4 || n > CROSS_CHECK_LIMIT) return false;
  const c = centroid(ring);
  const proj = projector(c[0], c[1]);
  const flat = projectRing(ring, proj);
  for (let i = 0; i < n; i++) {
    const a = flat[i], b = flat[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;   // first and last edges share a corner
      if (segmentsCross(a, b, flat[j], flat[(j + 1) % n])) return true;
    }
  }
  return false;
}

export function validateRing(ring) {
  const fatal = [], warn = [];
  if (!Array.isArray(ring) || ring.length < 3) {
    fatal.push(t('v.fewCorners'));
    return { fatal, warn };
  }

  const bad = ring.some((p) => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]));
  if (bad) {
    fatal.push(t('v.badCoords'));
    return { fatal, warn };
  }

  // Latitude past the poles is the signature of a file written lng-first.
  if (ring.some((p) => Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180)) {
    fatal.push(t('v.offMap'));
    return { fatal, warn };
  }

  const clean = dedupe(ring);
  if (clean.length < 3) {
    fatal.push(t('v.samePlace'));
    return { fatal, warn };
  }
  if (clean.length < ring.length) {
    warn.push(t('v.dropped', { n: ring.length - clean.length }));
  }

  // The crossing check has to come first, because a figure of eight cancels
  // itself out under the shoelace and would otherwise be turned away as a
  // straight line, which is both wrong and unhelpful to anyone trying to fix
  // it. A ring that crosses itself is odd, not unusable: distance to the edge
  // still means what it says, and the warning explains what happened to in
  // and out.
  const crosses = selfIntersects(clean);
  if (crosses) {
    warn.push(t('v.crosses'));
  }

  if (!crosses && area(clean) < MIN_AREA) {
    fatal.push(t('v.line'));
    return { fatal, warn };
  }

  const span = extent(clean);
  if (span > BIG_EXTENT) {
    warn.push(t('v.big', { d: formatLength(span) }));
  }

  return { fatal, warn, ring: clean };
}
