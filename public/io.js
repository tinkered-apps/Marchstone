/* io.js: reading boundaries out of files, and writing them back out.
 *
 * Everything normalises to the same shape the rest of the app uses:
 *   { name, ring }  where ring is [[lat, lng], ...] with no repeated
 *   closing point.
 */

import { haversine } from './geo.js';
import { markTitle, markNote, isHandPlaced } from './marks.js';
import { t } from './i18n.js';

/* How far a walked line ends from where it started. A perimeter that closes
 * within a few paces is just how walking works; one that ends a field away
 * means the app is about to invent an edge that was never surveyed, along a
 * straight line between the two ends. Say so before it is trusted. */
const GAP_WORTH_SAYING = 25;   // metres

function closingNote(ring) {
  if (ring.length < 3) return null;
  const gap = haversine(ring[0], ring[ring.length - 1]);
  if (gap < GAP_WORTH_SAYING) return null;
  return t('io.closed', { gap: Math.round(gap) });
}

/* Drop a trailing point that just repeats the first one (KML and GeoJSON both
 * close their rings explicitly; we don't). */
function open(ring) {
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) {
      return ring.slice(0, -1);
    }
  }
  return ring;
}

function usable(ring) {
  return ring && open(ring).length >= 3;
}

/* --- GeoJSON ---------------------------------------------------------- */
/* GeoJSON is [lng, lat]; we want [lat, lng]. */
function fromGeoJSON(text) {
  const data = JSON.parse(text);
  const out = [];
  const visit = (node, name, props) => {
    if (!node) return;
    if (node.type === 'FeatureCollection') {
      node.features.forEach((f) => visit(f, name));
    } else if (node.type === 'Feature') {
      const p = node.properties || {};
      visit(node.geometry, p.name || p.Name || p.NAME || p.title || name, p);
    } else if (node.type === 'GeometryCollection') {
      node.geometries.forEach((g) => visit(g, name, props));
    } else if (node.type === 'Polygon') {
      out.push({ name, ring: open(node.coordinates[0].map((c) => [c[1], c[0]])),
                 notes: [holeNote(node.coordinates.length - 1)],
                 marks: props ? props.marks : null });
    } else if (node.type === 'MultiPolygon') {
      node.coordinates.forEach((poly, i) => out.push({
        name: node.coordinates.length > 1 ? name + ' (' + (i + 1) + ')' : name,
        ring: open(poly[0].map((c) => [c[1], c[0]])),
        notes: [holeNote(poly.length - 1)],
        // Marks belong to a place, and a multi-part parcel gives them more than
        // one. Only the first part can honestly claim them.
        marks: i === 0 && props ? props.marks : null,
      }));
    } else if (node.type === 'LineString') {
      const ring = open(node.coordinates.map((c) => [c[1], c[0]]));
      out.push({ name, ring, notes: [closingNote(ring)] });
    } else if (node.type === 'MultiLineString') {
      node.coordinates.forEach((line, i) => {
        const ring = open(line.map((c) => [c[1], c[0]]));
        out.push({ name: name + ' (' + (i + 1) + ')', ring, notes: [closingNote(ring)] });
      });
    }
  };
  visit(data, t('io.imported'));
  return out.filter((g) => usable(g.ring));
}

/* The app carries one outline per area, so a parcel with a pond cut out of it
 * arrives as its outer edge, and the pond reads as inside. Nobody should
 * discover that in a field. */
function holeNote(holes) {
  if (holes < 1) return null;
  return t('io.holes', { n: holes });
}

/* --- KML -------------------------------------------------------------- */
/* KML coordinate blocks are whitespace-separated "lng,lat[,alt]" tuples. */
function parseKmlCoords(text) {
  return text.trim().split(/\s+/).map((tuple) => {
    const parts = tuple.split(',');
    return [parseFloat(parts[1]), parseFloat(parts[0])];
  }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/* Walk up to the enclosing Placemark for a human-readable label. */
function kmlName(node, fallback) {
  let el = node;
  while (el && el.nodeName !== 'Placemark') el = el.parentNode;
  const n = el && el.getElementsByTagName('name')[0];
  return (n && n.textContent.trim()) || fallback;
}

/* Inner rings sit beside the outer one under the same Polygon. */
function countInnerRings(outerRing) {
  let poly = outerRing;
  while (poly && poly.nodeName !== 'Polygon') poly = poly.parentNode;
  if (!poly) return 0;
  return poly.getElementsByTagName('innerBoundaryIs').length;
}

function fromKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error(t('io.kmlBad'));
  }
  const out = [];
  const grab = (tag, kind) => {
    const nodes = doc.getElementsByTagName(tag);
    for (let i = 0; i < nodes.length; i++) {
      // A Polygon's outer ring lives under outerBoundaryIs; skip inner holes,
      // but count them, because dropping one silently changes the answer.
      if (tag === 'LinearRing' && nodes[i].parentNode &&
          nodes[i].parentNode.nodeName === 'innerBoundaryIs') continue;
      const coordEl = nodes[i].getElementsByTagName('coordinates')[0];
      if (!coordEl) continue;
      const ring = open(parseKmlCoords(coordEl.textContent));
      if (!usable(ring)) continue;
      const holes = tag === 'LinearRing' ? countInnerRings(nodes[i]) : 0;
      out.push({
        name: kmlName(nodes[i], kind + ' ' + (out.length + 1)),
        ring,
        notes: [holes ? holeNote(holes) : null, tag === 'LineString' ? closingNote(ring) : null],
      });
    }
  };
  grab('LinearRing', t('io.area'));
  if (!out.length) grab('LineString', t('io.line')); // some exports draw fields as open lines
  return out;
}

/* --- GPX -------------------------------------------------------------- */
/* A walked perimeter usually arrives as a track; we close it into a ring. */
function fromGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error(t('io.gpxBad'));
  }
  const out = [];
  const collect = (containerTag, pointTag, kind) => {
    const containers = doc.getElementsByTagName(containerTag);
    for (let i = 0; i < containers.length; i++) {
      const pts = containers[i].getElementsByTagName(pointTag);
      const ring = [];
      for (let j = 0; j < pts.length; j++) {
        ring.push([parseFloat(pts[j].getAttribute('lat')), parseFloat(pts[j].getAttribute('lon'))]);
      }
      const clean = open(ring.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
      if (!usable(clean)) continue;
      const nameEl = containers[i].getElementsByTagName('name')[0];
      out.push({
        name: (nameEl && nameEl.textContent.trim()) || kind + ' ' + (out.length + 1),
        ring: clean,
        notes: [closingNote(clean)],
      });
    }
  };
  collect('trk', 'trkpt', t('io.track'));
  collect('rte', 'rtept', t('io.route'));
  if (!out.length) {
    // Loose waypoints, taken in file order.
    const pts = doc.getElementsByTagName('wpt');
    const ring = [];
    for (let i = 0; i < pts.length; i++) {
      ring.push([parseFloat(pts[i].getAttribute('lat')), parseFloat(pts[i].getAttribute('lon'))]);
    }
    const clean = open(ring.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
    if (usable(clean)) out.push({ name: t('io.waypoints'), ring: clean, notes: [closingNote(clean)] });
  }
  return out;
}

/* --- entry point ------------------------------------------------------ */
export async function readBoundaryFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.kmz')) {
    throw new Error(t('io.kmz'));
  }
  const text = await file.text();
  const head = text.slice(0, 400);

  let geoms;
  if (name.endsWith('.gpx') || /<gpx[\s>]/i.test(head)) geoms = fromGPX(text);
  else if (name.endsWith('.kml') || /<kml[\s>]/i.test(head)) geoms = fromKML(text);
  else geoms = fromGeoJSON(text);

  if (!geoms.length) {
    throw new Error(t('io.noArea'));
  }
  return geoms.map((g) => ({ ...g, notes: (g.notes || []).filter(Boolean) }));
}

/* --- export ----------------------------------------------------------- */

/* Marks ride along in the polygon's own properties, so an area exported and
 * imported again comes back exactly as it left: another program ignores a
 * property it does not know, and this one reads it.
 *
 * But ignoring it is the whole problem. A mark parked in an attribute is a
 * mark that Geoportal, QGIS and Google Earth all draw as nothing at all, the
 * file looks like a bare boundary. So every mark leaves a second time as a
 * Point feature beside the polygon, which any viewer draws. The reader above
 * has no branch for Point, so a file that makes the round trip does not come
 * back carrying its marks twice. */
function markProps(marks) {
  if (!marks || !marks.length) return undefined;
  return marks.map((m) => {
    const out = { n: m.n, label: m.label || '', lat: m.lat, lng: m.lng,
                  acc: m.acc, at: m.at, age: m.age };
    // Only where there is one: an absent hand is the ordinary case and does
    // not need a line in every file.
    if (isHandPlaced(m)) { out.placed = 'hand'; out.fix = m.fix || null; }
    return out;
  });
}

/* One mark, as the rest of the world wants it: a point, named, carrying the
 * accuracy it was taken at. */
function markFeatures(areaName, marks) {
  return (marks || []).map((m) => ({
    type: 'Feature',
    properties: {
      name: markTitle(m),
      area: areaName,
      number: m.n,
      // A hand-placed point has no accuracy to give, and the fix's own figure
      // is not it. Anything reading this file gets the same refusal the app
      // gives on screen.
      accuracy_m: !isHandPlaced(m) && Number.isFinite(m.acc) ? Math.round(m.acc) : null,
      placed: isHandPlaced(m) ? 'hand' : 'gps',
      time: stamp(m.at),
      note: markNote(m),
    },
    geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
  }));
}

export function toGeoJSON(fieldName, ring, marks) {
  const closed = ring.concat([ring[0]]).map((p) => [p[1], p[0]]); // back to lng,lat
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: fieldName, marks: markProps(marks) },
      geometry: { type: 'Polygon', coordinates: [closed] },
    }].concat(markFeatures(fieldName, marks)),
  }, null, 2);
}

/* Every area in one FeatureCollection. Deliberately plain GeoJSON rather than
 * a private backup format: it reloads here, and it opens in Google Earth, QGIS
 * or whatever the next tool turns out to be. */
export function toGeoJSONAll(fields) {
  const features = [];
  fields.forEach((f) => {
    features.push({
      type: 'Feature',
      properties: { name: f.name, updated: f.updated || null, marks: markProps(f.marks) },
      geometry: {
        type: 'Polygon',
        coordinates: [f.ring.concat([f.ring[0]]).map((pt) => [pt[1], pt[0]])],
      },
    });
    markFeatures(f.name, f.marks).forEach((pt) => features.push(pt));
  });
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

export function toKML(fieldName, ring) {
  const coords = ring.concat([ring[0]]).map((p) => p[1] + ',' + p[0] + ',0').join(' ');
  const safe = xmlEscape(fieldName);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>',
    '<name>' + safe + '</name>',
    '<Polygon><outerBoundaryIs><LinearRing><coordinates>' + coords +
      '</coordinates></LinearRing></outerBoundaryIs></Polygon>',
    '</Placemark></Document></kml>',
  ].join('\n');
}

/* --- marks out --------------------------------------------------------- */
/* A mark is a numbered point, so it leaves as one: waypoints for a handheld,
 * placemarks for Google Earth, points for everything else. The accuracy it was
 * taken at travels with it in every format, a mark stripped of its error is a
 * precision this app never claimed. */

function xmlEscape(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function stamp(at) {
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/* GPX is schema-ordered: a waypoint's time comes before its name, and a file
 * that puts them the other way round is refused by the software people
 * actually load these into. */
export function marksToGPX(areaName, marks) {
  const body = marks.map((m) => {
    const time = stamp(m.at);
    return '<wpt lat="' + m.lat.toFixed(7) + '" lon="' + m.lng.toFixed(7) + '">' +
      (time ? '<time>' + time + '</time>' : '') +
      '<name>' + xmlEscape(markTitle(m)) + '</name>' +
      '<desc>' + xmlEscape(markNote(m)) + '</desc>' +
      '<sym>Flag, Blue</sym></wpt>';
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Marchstone" ' +
      'xmlns="http://www.topografix.com/GPX/1/1">',
    '<metadata><name>' + xmlEscape(areaName) + '</name></metadata>',
  ].concat(body, '</gpx>').join('\n');
}

export function marksToKML(areaName, marks) {
  const body = marks.map((m) =>
    '<Placemark><name>' + xmlEscape(markTitle(m)) + '</name>' +
    '<description>' + xmlEscape(markNote(m)) + '</description>' +
    '<Point><coordinates>' + m.lng + ',' + m.lat + ',0</coordinates></Point></Placemark>');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
    '<name>' + xmlEscape(t('file.marks', { name: areaName })) + '</name>',
  ].concat(body, '</Document></kml>').join('\n');
}

export function marksToGeoJSON(areaName, marks) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: markFeatures(areaName, marks),
  }, null, 2);
}
