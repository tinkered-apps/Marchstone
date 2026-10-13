/* app.js: screens, map, tracking loop. */

import { evaluate, area, perimeter, formatArea, formatLength, formatHa, formatAcres,
         centroid, haversine, validateRing } from './geo.js';
import { readBoundaryFile, toGeoJSON, toGeoJSONAll, toKML,
         marksToGPX, marksToKML, marksToGeoJSON } from './io.js';
import { makeMark, cleanMarks, cleanLabel, markTitle, markDetail, isStale,
         isHandPlaced, handPlace, handOffset, putBack, MAX_LABEL } from './marks.js';
import { fixTime, keepFix, verdict, settle, provisional, countsAsGood, ageLabel,
         ACC_WARN, ACC_NETWORK } from './track.js';
import * as alerts from './alerts.js';
// As tr, because t is what this file calls the tracking session.
import { t as tr, setLang, getLang, LANGS } from './i18n.js';

/* ---------------------------------------------------------------- state */

const DEFAULTS = { buffer: 5, layer: 'satellite', keepAwake: true, muted: false,
                   theme: 'auto', accGate: 30, lang: 'en' };

/* Shown in the footer and at the foot of Settings, so "have you got the fix
 * yet?" is a question you can answer by looking instead of guessing. It reads
 * out of the app.js the phone actually loaded, which is the point: a stale copy
 * reports the stale number. Bump it and CACHE in sw.js together: the cache name
 * is what makes the phone fetch this file again at all. npm test fails if they
 * differ.
 *
 * Two decimals, one step of 0.01 per release. A string, not a number, or 1.10
 * prints as 1.1 and the version on screen stops matching the one you shipped. */
const APP_VERSION = '1.00';

/* Hands a file to the browser's download. Lives here rather than in io.js,
 * which touches no page and is tested without one. */
function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const state = {
  fields: load('fb.fields', []),
  settings: Object.assign({}, DEFAULTS, load('fb.settings', {})),
  screen: 'fields',
  mode: null,        // 'edit' | 'track' while the map screen is up
  draft: null,       // { name, ring } being edited
  editing: null,     // id of the field in play, or null for a new draft
  undo: [],
  tracking: null,    // { wakeLock, status, candidate, since } while the answer is up
  walking: null,     // { wakeLock, follow } while a boundary is being walked out
};
setLang(state.settings.lang);

/* Two things in this app run the position feed and want the map to keep up
 * with them: tracking a boundary, and walking one out. Everything that is true
 * of either, the follow behaviour, the wake lock, the warning strip, asks
 * for whichever is running rather than for tracking by name. */
function session() { return state.tracking || state.walking; }

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

/* Browser storage is best-effort by default: it can be full, it can be turned
 * off, and an origin the browser decides is idle can simply be evicted. A
 * failed write used to be silent, which meant the first you knew of it was an
 * area missing from the list on the morning you needed it.
 *
 * So every write is read back. If it did not stick, say so at once and offer
 * the only thing that actually helps, getting the areas into a file. */
function store(key, value) {
  const text = JSON.stringify(value);
  try {
    localStorage.setItem(key, text);
    if (localStorage.getItem(key) !== text) throw new Error('the write did not stick');
    return true;
  } catch (e) {
    return false;
  }
}

function saveFields() {
  if (store('fb.fields', state.fields)) return true;
  sheet(tr('save.failTitle'), [
    { label: tr('save.failBackup'), icon: 'export', sub: tr('save.failBackupSub'),
      run: backupAll },
    { label: tr('save.failCarry'), icon: 'warning',
      sub: tr('save.failCarrySub'), run: () => {} },
  ], [tr('save.failNote')]);
  return false;
}

function saveSettings() { store('fb.settings', state.settings); }

/* Ask the browser to stop treating this origin as disposable. Chrome grants it
 * to installed apps without prompting; others may refuse, and the Settings
 * screen reports whichever answer came back. */
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) { /* not supported, the Settings screen will say as much */ }
}

async function storageNote() {
  if (!state.fields.length) return tr('store.none');
  const count = tr('store.count', { n: state.fields.length }) + ' ';
  try {
    if (navigator.storage && navigator.storage.persisted) {
      return count + ((await navigator.storage.persisted())
        ? tr('store.persisted') : tr('store.evictable'));
    }
  } catch (e) { /* fall through */ }
  return count + tr('store.unknown');
}

function backupAll() {
  if (!state.fields.length) { toast(tr('backup.none')); return; }
  const day = new Date().toISOString().slice(0, 10);
  download('marchstone-' + day + '.geojson', toGeoJSONAll(state.fields),
    'application/geo+json');
  toast(tr('backup.done', { n: state.fields.length }));
}

/* Restoring adds; it never replaces. Someone reaching for a backup is already
 * having a bad day and should not be able to make it worse in one tap. */
async function restoreAll(file) {
  let geoms;
  try {
    geoms = await readBoundaryFile(file);
  } catch (e) {
    sheet(tr('restore.unreadable'), [{ label: tr('common.back'), icon: 'back', run: () => {} }],
      [e.message]);
    return;
  }
  const added = [], refused = [];
  geoms.forEach((g) => {
    const check = validateRing(g.ring);
    if (check.fatal.length) { refused.push(g.name); return; }
    state.fields.push({ id: 'f' + Date.now() + '-' + added.length, name: g.name,
                        ring: check.ring, marks: cleanMarks(g.marks), updated: Date.now() });
    added.push(g.name);
  });
  if (!added.length) {
    sheet(tr('restore.nothing'), [{ label: tr('common.back'), icon: 'back', run: () => {} }],
      [tr('restore.nothingNote')]);
    return;
  }
  saveFields();
  render();
  toast(tr('restore.done', { n: added.length, skipped: refused.length }));
}

/* Offline is the whole premise, so its one moving part reports for duty rather
 * than failing into a discarded catch. The Settings screen shows whichever of
 * these it ended on; the registration itself is at the foot of this file. */
let offlineState = 'unsupported';

const el = {};
['topbar', 'btnBack', 'title', 'btnSettings', 'btnTheme', 'langSwitch', 'scrFields', 'fieldTally', 'fieldList', 'overview', 'btnDraw',
 'btnImport', 'fileInput', 'scrMap', 'map', 'editReadout', 'roPoints', 'roArea',
 'roEdge', 'roWalk', 'roAcc', 'roAge', 'roHint', 'accWarn', 'accWarnText', 'editBar',
 'btnUndo', 'btnClear', 'btnWalk', 'btnCorner', 'cornerNum',
 'btnLocate', 'btnLayer', 'layerName', 'btnOffline', 'offlineName', 'btnCancelEdit',
 'btnSaveEdit', 'trackPanel', 'trackStatus', 'trackNum', 'trackUnit', 'trackCaption',
 'gauge', 'gaugeTicks', 'gaugeBand', 'gaugeMark', 'gaugeYou', 'gaugeScale',
 'metaStrip', 'metaAcc', 'metaBuffer', 'metaAge',
 'btnStop', 'btnMute', 'muteName', 'btnMark', 'btnMarks', 'markCount', 'btnRecentre',
 'btnLastMark', 'lastMarkNum', 'moveBar', 'moveText', 'btnMovePlace', 'btnMoveCancel',
 'scrSettings', 'bufferRange', 'bufferValue',
 'chkAwake', 'chkMuted', 'vibNote', 'gateNote', 'btnClearTiles', 'tileInfo', 'toast', 'sheet',
 'storeInfo', 'btnBackup', 'btnRestore', 'restoreInput', 'footerVersion',
 'sheetBody', 'sheetTitle', 'sheetClose',
].forEach((id) => { el[id] = document.getElementById(id); });
el.footerVersion.textContent = 'v' + APP_VERSION;

/* ------------------------------------------------------------- helpers */

function icon(name, cls) {
  return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' +
    name + '"/></svg>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------------------------------------------------------- toast */

let toastTimer;
function toast(message, actionLabel, action) {
  el.toast.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = message;
  el.toast.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { hideToast(); action(); };
    el.toast.appendChild(b);
  }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 3000);
}
function hideToast() { el.toast.hidden = true; }

/* ---------------------------------------------------------------- sheet */

function sheet(title, rows, notes) {
  el.sheet.classList.remove('is-form');
  el.sheetTitle.textContent = title;
  el.sheetBody.innerHTML = '';
  (notes || []).forEach((text) => {
    const p = document.createElement('p');
    p.className = 'sheet-note';
    p.textContent = text;
    el.sheetBody.appendChild(p);
  });
  rows.forEach((row) => {
    const b = document.createElement('button');
    b.className = 'sheet-row' + (row.danger ? ' danger' : '');
    b.innerHTML = (row.icon ? icon(row.icon) : '') + '<span><strong>' +
      escapeHtml(row.label) + '</strong>' +
      (row.sub ? '<em>' + escapeHtml(row.sub) + '</em>' : '') + '</span>';
    b.onclick = () => { closeSheet(); row.run(); };
    el.sheetBody.appendChild(b);
  });
  openSheet();
}
/* A sheet is a modal dialog, so it behaves like one: focus goes into it, stays
 * inside it while it is up, Escape closes it, and the control that opened it
 * gets focus back. Without that, a keyboard or switch user tabs straight past
 * the dialog into a map they cannot see. */
let sheetReturn = null;

function openSheet() {
  sheetReturn = document.activeElement;
  el.sheet.hidden = false;
  const first = el.sheetBody.querySelector('button') || el.sheetClose;
  first.focus();
}

function closeSheet() {
  if (el.sheet.hidden) return;
  el.sheet.hidden = true;
  clearInterval(sheetTick);   // the GPS sheet refreshes itself while it is up
  sheetTick = null;
  if (sheetReturn && document.contains(sheetReturn)) sheetReturn.focus();
  sheetReturn = null;
}

el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });
el.sheetClose.onclick = closeSheet;

/* Questions, asked in the app's own voice. The browser's prompt() and confirm()
 * were in the same place: a grey system box over an interface that draws every
 * other choice as a sheet, and, being modal to the whole page, a box that freezes
 * the position feed and holds the alarm still while it is up. Some standalone
 * webviews suppress them outright, and then a rename or a delete silently does
 * nothing. Both take callbacks, as guard() does; a question that is dismissed
 * simply never calls back. */

/* Answering with text. The card sits at the top of the screen, not the foot:
 * a field is named with the keyboard up, and a keyboard covers the bottom. */
function askText(opts, run) {
  sheet(opts.title, [], opts.notes);
  el.sheet.classList.add('is-form');
  const form = document.createElement('form');
  form.className = 'sheet-form';
  form.innerHTML = '<label for="sheetInput">' + escapeHtml(opts.label) + '</label>' +
    '<input id="sheetInput" type="text" maxlength="' + (opts.maxLength || 80) + '" ' +
      'autocomplete="off" spellcheck="false" enterkeyhint="done">' +
    '<button type="submit" class="btn btn-filled">' + icon('check') +
      escapeHtml(opts.ok) + '</button>';
  const input = form.querySelector('input');
  input.value = opts.value || '';
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !opts.allowEmpty) { input.focus(); return; }
    closeSheet();
    run(text);
  };
  el.sheetBody.appendChild(form);
  input.focus();
  input.select();
}

/* Answering yes or no. Both answers are named for what they do, and focus
 * starts on the one that changes nothing, so a stray Enter cannot delete. */
function askConfirm(opts, run) {
  sheet(opts.title, [
    { label: opts.ok, icon: 'clear', danger: true, run },
    { label: opts.keep, icon: 'back', run: () => {} },
  ], opts.notes);
  el.sheetBody.querySelectorAll('.sheet-row')[1].focus();
}

el.sheet.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const stops = [...el.sheet.querySelectorAll('button, [href], input, select, textarea')]
    .filter((n) => !n.disabled && n.offsetParent !== null);
  if (!stops.length) return;
  const first = stops[0], last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ----------------------------------------------------------------- map */

let map, tileLayers, polyLine, bandLine, vertexGroup, markGroup, meMarker, meAccuracy;

/* Both of these are somebody else's tile servers, used under somebody else's
 * terms, and the terms differ in a way the interface has to respect.
 *
 * OpenStreetMap's tile usage policy names offline or prefetch features as
 * something its public server is explicitly not for. So Save map is not
 * offered on that layer at all: browsing draws tiles and the service worker
 * keeps what was drawn, which is ordinary caching, but nothing here walks a
 * grid pulling down tiles nobody asked to see.
 *
 * Esri's imagery is kept, with a much smaller ceiling than before, because a
 * parcel needs a few dozen tiles and anything beyond that is not a field. The
 * honest fix for both is self-hosted tiles; see the README. */
const TILES = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19,
    label: 'layer.satellite',
    offline: true,
  },
  street: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" ' +
                 'target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    maxZoom: 19,
    label: 'layer.street',
    offline: false,
    // OpenStreetMap's tile policy asks a web page to say who it is. The page
    // sends no referrer anywhere else (_headers); this layer sends the origin.
    referrerPolicy: 'strict-origin',
  },
};

const MAX_OFFLINE_TILES = 1200;

/* Attribution is a condition of using either service, and a condition it is
 * easy to break by accident: the answer panel and the edit bar both sit over
 * the bottom of the map, which is exactly where Leaflet puts the credit. So
 * the map's bottom controls are lifted by whatever is docked down there. */
function syncDock() {
  const dock = !el.trackPanel.hidden ? el.trackPanel : !el.editBar.hidden ? el.editBar : null;
  const h = dock ? Math.round(dock.getBoundingClientRect().height) : 0;
  el.scrMap.style.setProperty('--dock-h', h + 'px');
  // Also on the root, so a toast, which sits outside #scrMap so it can float
  // over every screen, can clear the same dock instead of covering it.
  document.documentElement.style.setProperty('--dock-h', h + 'px');
  // The mark key floats above the credit rather than over it, and the credit
  // wraps to two lines on a narrow phone, so its height is measured, not
  // guessed.
  const credit = el.scrMap.querySelector('.leaflet-control-attribution');
  const c = credit ? Math.round(credit.getBoundingClientRect().height) : 0;
  el.scrMap.style.setProperty('--credit-h', c + 'px');
  // What is stacked along the top: the drawing readout, and under it the
  // warning strip. The strip clears the zoom control by pushing it down rather
  // than by giving up width, because a warning cut off by a + button is a
  // warning nobody reads. Both are measured, since both change height with the
  // words in them and the readout grows a row while you are out walking.
  const r = el.editReadout.hidden
    ? 0 : Math.round(el.editReadout.getBoundingClientRect().height) + 8;
  el.scrMap.style.setProperty('--readout-h', r + 'px');
  const w = el.accWarn.hidden
    ? 0 : Math.round(el.accWarn.getBoundingClientRect().height) + 8;
  el.scrMap.style.setProperty('--warn-h', w + 'px');
}

/* Ink over imagery, so the plan reads the same as it does on the ledger. */
const INK = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
const PAPER = () => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, tap: false });
  map.setView([52.2, 21.0], 5);
  L.control.zoom({ position: 'topright' }).addTo(map);

  // The panel grows and shrinks with its own contents, so measuring it once is
  // not enough.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncDock);
    ro.observe(el.trackPanel);
    ro.observe(el.editBar);
    ro.observe(el.editReadout);
    ro.observe(el.accWarn);
    // The credit wraps to a second line on a narrow phone and back again when
    // the phone is turned, and the mark key sits on top of whatever it becomes.
    const credit = el.scrMap.querySelector('.leaflet-control-attribution');
    if (credit) ro.observe(credit);
    // Turning the phone hands the map a different box. Leaflet caches the old
    // one until it is told, and a stale size puts every position on screen in
    // the wrong place.
    new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(el.map);
  }

  tileLayers = {};
  Object.keys(TILES).forEach((key) => {
    tileLayers[key] = L.tileLayer(TILES[key].url, {
      attribution: TILES[key].attribution,
      maxZoom: TILES[key].maxZoom,
      crossOrigin: 'anonymous', // so prefetched tiles match the cached responses
      referrerPolicy: TILES[key].referrerPolicy || false,
    });
  });
  applyLayer();

  bandLine = L.polygon([], { color: '#ffffff', weight: 10, opacity: 0.45, fill: false }).addTo(map);
  polyLine = L.polygon([], {
    color: '#ffffff', weight: 3.5, opacity: 1,
    fillColor: '#000000', fillOpacity: 0.16, lineJoin: 'miter',
  }).addTo(map);
  vertexGroup = L.layerGroup().addTo(map);
  markGroup = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    if (moving) { holdAt(e.latlng.lat, e.latlng.lng); return; }
    if (state.mode === 'edit') { addPoint(e.latlng.lat, e.latlng.lng); return; }
    // Tapping the ground puts a spread pile back together. Nothing else does,
    // so a pile stays open while you work through it.
    if (openPileId) { openPileId = null; redrawMarks(); }
  });
  map.on('zoomend', drawBand);
  // Which discs are hiding which is a question about pixels, and the answer
  // changes at every zoom. So the piles are worked out again each time, and a
  // pile too crowded to spread here closes itself when you step back out.
  map.on('zoomend', redrawMarks);
  // Leaflet fires dragstart for a hand on the map and never for a pan the app
  // asked for, so it is the one signal that means "I am looking at something".
  map.on('dragstart', () => {
    const s = session();
    if (!s || !s.follow) return;
    s.follow = false;
    syncRecentre();
  });
}

function setLayer(key) {
  state.settings.layer = key;
  saveSettings();
  applyLayer();
}

function applyLayer() {
  Object.keys(tileLayers).forEach((key) => {
    if (key === state.settings.layer) tileLayers[key].addTo(map);
    else map.removeLayer(tileLayers[key]);
  });
  el.layerName.textContent = tr(TILES[state.settings.layer].label);
}

/* The scale of the map, which is how the border band gets drawn at its true
 * width on the ground: the buffer in metres becomes a stroke weight in pixels.
 *
 * It takes a zoom because the marks ask it about zooms the map is not at yet:
 * "how far in would I have to go before those discs stopped hiding each
 * other?" is a question you have to be able to ask from here. */
function metresPerPixel(zoom) {
  const lat = map.getCenter().lat;
  const z = Number.isFinite(zoom) ? zoom : map.getZoom();
  return 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z + 8);
}

function drawBand() {
  const ring = currentRing();
  if (!ring || ring.length < 3) { bandLine.setLatLngs([]); return; }
  const px = (state.settings.buffer * 2) / metresPerPixel();
  bandLine.setLatLngs(ring);
  bandLine.setStyle({ weight: Math.max(3, Math.min(140, px)) });
}

function currentRing() {
  if (state.mode === 'edit') return state.draft ? state.draft.ring : null;
  const f = state.fields.find((x) => x.id === state.editing);
  return f ? f.ring : null;
}

function redrawShape() {
  const ring = currentRing() || [];
  polyLine.setLatLngs(ring);
  vertexGroup.clearLayers();
  if (state.mode === 'edit') {
    ring.forEach((p, i) => {
      const m = L.marker(p, {
        draggable: true,
        title: tr('corner.title', { n: i + 1 }),
        icon: L.divIcon({ className: 'vertex', html: String(i + 1), iconSize: [28, 28] }),
      });
      m.on('dragend', () => {
        pushUndo();
        const ll = m.getLatLng();
        state.draft.ring[i] = [ll.lat, ll.lng];
        // A hand has moved it, so whatever the fix underneath claimed is no
        // longer what this corner is. It gives the figure up rather than keep
        // one it has not earned, the same way a moved mark does.
        state.draft.acc[i] = null;
        redrawShape();
      });
      m.on('click', (e) => { L.DomEvent.stop(e); removePoint(i); });
      vertexGroup.addLayer(m);
    });
  }
  drawBand();
  updateEditReadout();
}

/* ---------------------------------------------- the plan of an area */
/* Each saved area draws itself, so you recognise it by shape before you
 * read the name, the way a field book page works. */
function planSVG(ring, marks) {
  const c = centroid(ring);
  const kx = Math.cos(c[0] * Math.PI / 180);
  const project = (lat, lng) => [(lng - c[1]) * kx, -(lat - c[0])]; // y down for screen
  const pts = ring.map((p) => project(p[0], p[1]));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = 72 / span;                       // 100 box, 14 units of margin
  // Centred a little above the middle, so the scale bar under it has a strip
  // of the sheet to itself.
  const ox = (100 - (maxX - minX) * scale) / 2;
  const oy = (90 - (maxY - minY) * scale) / 2;
  const at = (p) => [(p[0] - minX) * scale + ox, (p[1] - minY) * scale + oy];
  const xy = pts.map((p) => at(p).map((v) => v.toFixed(2)));

  // Neatline ticks at the quarters, the way a drawing frames its sheet.
  let ticks = '';
  [25, 50, 75].forEach((t) => {
    ticks += 'M' + t + ' 0v3M' + t + ' 100v-3M0 ' + t + 'h3M100 ' + t + 'h-3';
  });

  let out = '<svg viewBox="0 0 100 100" aria-hidden="true">' +
    '<path class="neat" d="' + ticks + '"/>' +
    '<polygon class="outline" points="' + xy.map((p) => p.join(',')).join(' ') + '"/>';
  // Corner ticks only while they still read as distinct marks.
  if (xy.length <= 24) {
    out += xy.map((p) => '<circle class="corner" cx="' + p[0] + '" cy="' + p[1] + '" r="2.6"/>').join('');
  }
  // Marks, as the open rings they are on the map, where they fall on the sheet.
  (marks || []).forEach((m) => {
    const p = at(project(m.lat, m.lng));
    if (p[0] < 2 || p[0] > 98 || p[1] < 2 || p[1] > 98) return;
    out += '<circle class="mark" cx="' + p[0].toFixed(2) + '" cy="' + p[1].toFixed(2) + '" r="2.4"/>';
  });

  // A true scale bar: the longest round length that fits a third of the sheet.
  const perUnit = (span * 111320) / 72;          // metres per viewBox unit
  let len = 1;
  for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) {
    if (step / perUnit <= 32) len = step;
  }
  const w = len / perUnit;
  out += '<g class="scale"><path d="M7 89v4h' + w.toFixed(2) + 'v-4"/>' +
    '<text x="' + (w + 10).toFixed(2) + '" y="94">' +
    (len >= 1000 ? len / 1000 + ' km' : len + ' m') + '</text></g>';
  return '<div class="area-plan">' + out + '</svg></div>';
}

/* -------------------------------------------------------------- editing */

/* A corner and what the fix behind it was worth travel together while the
 * drawing lasts: acc[i] is the accuracy of the reading that dropped ring[i],
 * or null where a hand put it there, tapped onto the imagery, or dragged
 * afterwards. It is not part of the boundary and is not saved with it. It is
 * here so the shape can be asked, once, at the moment it is committed, how
 * good the fixes underneath it actually were. */
function pushUndo() {
  state.undo.push({
    ring: JSON.parse(JSON.stringify(state.draft.ring)),
    acc: state.draft.acc.slice(),
  });
  if (state.undo.length > 60) state.undo.shift();
}

function addPoint(lat, lng, acc) {
  pushUndo();
  state.draft.ring.push([lat, lng]);
  state.draft.acc.push(Number.isFinite(acc) ? acc : null);
  redrawShape();
}

function removePoint(i) {
  pushUndo();
  state.draft.ring.splice(i, 1);
  state.draft.acc.splice(i, 1);
  redrawShape();
  toast(tr('toast.cornerRemoved'), tr('common.undo'), undoLast);
}

function undoLast() {
  if (!state.undo.length) { toast(tr('toast.nothingToUndo')); return; }
  const back = state.undo.pop();
  state.draft.ring = back.ring;
  state.draft.acc = back.acc;
  redrawShape();
}

function updateEditReadout() {
  if (state.mode !== 'edit') return;
  const ring = state.draft.ring;
  const n = ring.length;
  el.roPoints.textContent = n;
  el.roArea.textContent = n >= 3 ? formatArea(area(ring)).replace(/ \(.*\)/, '') : '–';
  el.roEdge.textContent = n >= 3 ? formatLength(perimeter(ring)) : '–';

  // Walking adds the two numbers that decide whether the next corner is worth
  // dropping, in the same pair and the same order the tracking screen uses.
  const walking = !!state.walking;
  const f = lastFix();
  el.roWalk.hidden = !walking;
  if (walking) {
    el.roAcc.textContent = f ? '±' + Math.round(f.acc) + ' m' : '–';
    el.roAge.textContent = f ? ageLabel(Date.now() - f.at) : '–';
  }
  el.roHint.textContent = walking ? walkHint(n, f) : drawHint(n);

  el.btnUndo.disabled = !state.undo.length;
  el.btnClear.disabled = n === 0;
  el.btnSaveEdit.disabled = n < 3;
  syncWalk();
}

function drawHint(n) {
  return n === 0 ? tr('hint.first')
    : n < 3 ? tr('hint.more', { n: 3 - n })
    : tr('hint.edit');
}

/* The drawing screen stops telling you to tap the map the moment you are out
 * walking it, because at that point the map is not what you are aiming at. */
function walkHint(n, f) {
  if (!f) return tr('walk.searching');
  if (n === 0) return tr('walk.first');
  if (n < 3) return tr('walk.next');
  return tr('walk.last');
}

function startEdit(field) {
  state.mode = 'edit';
  state.editing = field ? field.id : null;
  state.draft = field
    ? { name: field.name, ring: JSON.parse(JSON.stringify(field.ring)),
        // Corners that came back out of storage carry no reading with them:
        // nothing here knows what made them, so nothing here claims to.
        acc: field.ring.map(() => null) }
    : { name: '', ring: [], acc: [] };
  state.undo = [];
  show('map');
  el.title.textContent = field ? field.name : tr('title.newArea');
  el.editBar.hidden = false;
  syncDock();
  el.editReadout.hidden = false;
  el.scrMap.classList.add('has-readout');
  el.trackPanel.hidden = true;
  syncMarksButton();
  syncWalk();
  syncRecentre();
  redrawMarks();
  redrawShape();
  if (state.draft.ring.length >= 3) {
    map.fitBounds(L.polygon(state.draft.ring).getBounds(), { padding: [40, 40] });
  } else {
    locateMe(true);
  }
}

/* Nothing becomes a boundary without passing through here. Fatal problems are
 * refused outright and told why; odd-but-workable ones are shown and left to
 * the person who drew or exported the shape, because they are the only one who
 * knows whether the oddity is a mistake or the parcel. */
function guard(ring, notes, proceed) {
  const check = validateRing(ring);
  if (check.fatal.length) {
    sheet(tr('guard.fatalTitle'), [
      { label: tr('common.back'), icon: 'back', run: () => {} },
    ], check.fatal);
    return;
  }
  const said = (notes || []).concat(check.warn);
  if (!said.length) { proceed(check.ring); return; }
  sheet(tr('guard.checkTitle'), [
    { label: tr('guard.useAnyway'), icon: 'check', sub: tr('guard.useAnywaySub'),
      run: () => proceed(check.ring) },
    { label: tr('common.cancel'), icon: 'back', run: () => {} },
  ], said);
}

/* What the fixes behind a walked boundary were worth, said once, at the only
 * moment it can still change anything. A corner dropped at ±15 m puts the line
 * through it 15 m out, and the shape on screen shows none of that, so it is
 * named here rather than left to be discovered by a warning going off in the
 * wrong field. Nothing is refused: the person who walked it is the only one
 * who knows whether that is close enough for the job. */
function walkedNote(ring, acc) {
  const walked = acc.filter((a) => Number.isFinite(a));
  if (!walked.length) return null;
  const worst = Math.round(Math.max.apply(null, walked));
  if (worst <= ACC_WARN) return null;
  return tr('walked.note', { walked: walked.length, total: ring.length, worst });
}

function saveEdit() {
  const ring = state.draft.ring;
  if (ring.length < 3) return;
  const suggested = state.draft.name || tr('area.defaultName', { n: state.fields.length + 1 });
  askText({ title: tr('name.title'), label: tr('name.label'), value: suggested, ok: tr('edit.save') },
    (name) => {
      const note = walkedNote(ring, state.draft.acc);
      guard(ring, note ? [note] : null, (clean) => commitEdit(name, clean));
    });
}

function commitEdit(name, ring) {
  if (state.editing) {
    const f = state.fields.find((x) => x.id === state.editing);
    f.name = name;
    f.ring = ring;
    f.updated = Date.now();
  } else {
    state.fields.push({ id: 'f' + Date.now(), name, ring, updated: Date.now() });
  }
  saveFields();
  toast(tr('toast.saved', { name }));
  show('fields');
}

/* -------------------------------------------------- walking the boundary
 *
 * The third way to mark an area, and the only one that needs nothing but the
 * ground. Imagery answers "which of those hedges is it?" and a file answers
 * "what did the last survey say?", and neither answers "where is the peg I am
 * standing next to", which on new fence, in plantation, or under cloud is
 * the only question there is. So: walk it, and drop a corner where you stand.
 *
 * It is the tracking screen's machinery pointed at a different job. The same
 * stubborn feed, the same map that keeps up until you drag it away, the same
 * wake lock, because getting round a boundary on foot is a screen-on job for
 * as long as it takes. What it does not get is a verdict or an alarm: there is
 * no boundary yet, that is what you are out here making.
 *
 * Tapping the map still drops a corner while you walk, on purpose. Half a
 * perimeter is fence you can stand on and half is the far side of a river you
 * can see perfectly well on the imagery, and the shape does not care which
 * hand made which corner. */

function startWalk() {
  if (state.mode !== 'edit' || state.walking) return;
  if (!navigator.geolocation) { toast(tr('toast.noGeo')); return; }
  state.walking = {
    wakeLock: null, ageTimer: null, warnText: '',
    ready: { wake: null },
    // Same bargain as tracking: the map keeps up with you until you drag it.
    follow: true,
  };
  el.scrMap.classList.add('is-walking');
  // The tap that starts the walk is the last one before the phone goes in a
  // hand and stays there, so it is the tap the confirmation sound has to be
  // started from.
  alerts.setMuted(state.settings.muted);
  alerts.unlock();
  requestWakeLock();
  startFeed(walkFix, onWalkError);
  state.walking.ageTimer = setInterval(tickFixAge, 1000);
  syncRecentre();
  updateEditReadout();
  syncDock();
}

function stopWalk() {
  const w = state.walking;
  if (!w) return;
  stopFeed();
  clearInterval(w.ageTimer);
  if (w.wakeLock) { try { w.wakeLock.release(); } catch (e) { /* already gone */ } }
  state.walking = null;
  el.scrMap.classList.remove('is-walking');
  // The dot was live, and nothing is going to keep it that way. A stale "you
  // are here" is the one lie the rest of this app spends its time not telling,
  // so it goes out with the feed that fed it.
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  if (meAccuracy) { map.removeLayer(meAccuracy); meAccuracy = null; }
  el.accWarn.hidden = true;
  // Directly rather than through the readout: the readout stands down the
  // moment the drawing screen does, and the key must go with the walk whether
  // it stopped on its own or went out with the screen under it.
  syncWalk();
  syncRecentre();
  updateEditReadout();
  syncDock();
}

/* No verdict to reach, so a fix has two jobs here: move the dot, and say
 * whether a corner dropped on it would be worth having. */
function walkFix(fix) {
  if (!state.walking) return;
  drawMe([fix.lat, fix.lng], fix.acc);
  const acc = Math.round(fix.acc);
  if (fix.acc > ACC_NETWORK) {
    setWarn(tr('warn.walkNetwork', { acc, hint: preciseHint() }));
  } else if (fix.acc > ACC_WARN) {
    setWarn(tr('warn.walkWeak', { acc }));
  } else {
    setWarn('');
  }
  updateEditReadout();
  tickFixAge();
}

function onWalkError(err) {
  if (!state.walking) return;
  if (err.code === 1) { walkRefused(); return; }
  // Two channels report errors. A timeout on one while the other is still
  // delivering is not a failure anybody needs to read about.
  const f = lastFix();
  if (f && Date.now() - f.at < STALL_MS) return;
  setWarn(tr(err.code === 2 ? 'err.noSats' : 'err.timeout'));
}

function walkRefused() {
  stopWalk();
  sheet(tr('refused.title'), [
    { label: tr('refused.backToDrawing'), icon: 'back', run: () => {} },
  ], [tr('refused.walkNote'), refusedHowTo(), tr('refused.android', { hint: preciseHint() })]);
}

/* One tap where you are standing, on the same terms the mark key works on: the
 * corner exists first and is questioned afterwards. What it may not do is pass
 * a poor fix off as a surveyed corner, so the confirmation names the ± it was
 * dropped at, and says so out loud when the reading behind it has gone cold. */
function dropCorner() {
  if (!state.walking || state.mode !== 'edit') return;
  const f = lastFix();
  if (!f) { toast(tr('toast.noPositionCorner')); return; }
  addPoint(f.lat, f.lng, f.acc);
  alerts.marked();
  const age = Date.now() - f.at;
  toast(tr('corner.title', { n: state.draft.ring.length }) + ' · ±' + Math.round(f.acc) + ' m' +
    (age > 10000 ? ' · ' + tr('toast.fromFix', { age: ageLabel(age) }) : ''),
    tr('common.undo'), undoLast);
}

/* Walk is a mode, so its key is filled while it is on, the way every switch in
 * this app is. CORNER carries the number it is about to make, the way the last
 * mark key carries the mark it opens: you read what the next station will be
 * before you make it, and the key and the disc it drops are one object. */
function syncWalk() {
  const walking = state.mode === 'edit' && !!state.walking;
  el.btnWalk.setAttribute('aria-pressed', String(walking));
  el.btnCorner.hidden = !walking;
  if (!walking || !state.draft) return;
  const next = state.draft.ring.length + 1;
  el.cornerNum.textContent = next;
  el.btnCorner.setAttribute('aria-label', tr('corner.dropAria', { n: next }));
}

/* ------------------------------------------------------------- tracking */

/* The thresholds that decide what the app may claim live in track.js, with the
 * functions that apply them. These two are about running the feed, not judging
 * it, so they stay here. */
const POLL_MS = 1200;      // how often we ask for a position outright
const STALL_MS = 8000;     // silence this long and the watch gets rebuilt

function startTracking(field) {
  if (!navigator.geolocation) {
    toast(tr('toast.noGeo'));
    return;
  }
  if (state.walking) stopWalk();
  state.mode = 'track';
  state.editing = field.id;
  state.tracking = {
    ageTimer: null, wakeLock: null, status: null, candidate: null, since: 0,
    warnText: '', goodFixes: 0,
    ready: { sound: null, wake: null }, denied: false,
    // The map keeps up with you until you drag it away yourself.
    follow: true,
  };

  show('map');
  // A new session on a new area has no mark you were last working with.
  lastMarkId = null;
  el.title.textContent = field.name;
  el.editBar.hidden = true;
  el.editReadout.hidden = true;
  el.scrMap.classList.remove('has-readout');
  el.trackPanel.hidden = false;
  el.scrMap.classList.add('is-tracking');
  syncDock();
  syncWalk();
  syncMarksButton();
  syncRecentre();
  redrawShape();
  redrawMarks();
  map.fitBounds(L.polygon(field.ring).getBounds(), { padding: [40, 40] });

  el.metaBuffer.textContent = state.settings.buffer + ' m';
  el.metaAcc.textContent = '–';
  el.metaAge.textContent = '–';
  state.tracking.ageTimer = setInterval(tickFixAge, 1000);
  renderGaugeScale();
  delete el.trackPanel.dataset.provisional;
  showWaiting('status.waiting', 'cap.searching');

  // Audio only starts after a real tap, and the tap that started tracking is
  // the last one we are going to get before you put the phone in a pocket. If
  // it did not take, that has to be said now rather than discovered by a
  // warning that never sounded.
  alerts.unlock().then((running) => {
    if (!state.tracking) return;
    state.tracking.ready.sound = running;
    if (sheetTick) renderGpsSheet();
    if (!running && !state.settings.muted) soundFailedSheet();
  });
  alerts.setMuted(state.settings.muted);
  syncMuteButton();
  requestWakeLock();
  startFeed(applyFix, onTrackError);

  if (!localStorage.getItem('fb.gaugeSeen')) {
    localStorage.setItem('fb.gaugeSeen', '1');
    toast(tr('toast.gaugeHint'), tr('toast.gaugeWhat'), gaugeSheet);
  }
}

function stopTracking() {
  if (!state.tracking) return;
  stopFeed();
  clearInterval(state.tracking.ageTimer);
  if (state.tracking.wakeLock) { try { state.tracking.wakeLock.release(); } catch (e) { /* already gone */ } }
  state.tracking.wakeLock = null;
  state.tracking = null;
  closeSheet();
  if (moving) endMove();
  lastMarkId = null;
  alerts.stop();
  syncMarksButton();
  syncRecentre();
  redrawMarks();
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  if (meAccuracy) { map.removeLayer(meAccuracy); meAccuracy = null; }
  el.accWarn.hidden = true;
  el.scrMap.classList.remove('is-tracking');
  delete el.trackPanel.dataset.provisional;
  syncDock();
  show('fields');
}

/* -------------------------------------------------------- the position feed
 *
 * One geolocation watch turned out not to be enough. Browsers disagree wildly
 * about what watchPosition means: some report every second, some read it as
 * "tell me when the position changes a lot" and stay silent for a minute while
 * you walk a headland, and some let the watch quietly die. Firefox on Android
 * manages all three. So the feed has three parts working together:
 *
 *   1. the watch, cheap and prompt where it behaves;
 *   2. an outright request every POLL_MS, which forces a fresh fix out of the
 *      browsers that will not volunteer one;
 *   3. a stall check that tears the watch down and rebuilds it when nothing
 *      has arrived from either.
 *
 * Both channels land in ingest(), which throws away the duplicates they cause
 * and then judges whether what arrived is a real fix at all.
 *
 * Two jobs want all of that and share nothing else: tracking, which judges
 * every fix against a boundary, and walking one out, which turns fixes into
 * corners. So the plumbing and the is-this-a-fix question live here, the
 * caller is handed only the readings that survived, and what a reading means
 * is entirely the caller's business. One feed runs at a time, the two jobs
 * are two screens and you cannot be on both. */

const GEO_OPTS = { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 };

let feed = null;

function startFeed(onFix, onError) {
  stopFeed();
  feed = {
    watchId: null, pollTimer: null, stallTimer: null, polling: false,
    lastStamp: 0, lastWatchAt: 0, lastDeliveryAt: Date.now(),
    last: null,            // the last reading kept: { lat, lng, acc, at }
    bestAcc: Infinity,
    seen: 0, accepted: 0, rejected: 0, restarts: 0, intervals: [],
    onFix, onError,
  };
  feed.watchId = navigator.geolocation.watchPosition(onWatchFix, onFeedError, GEO_OPTS);
  feed.pollTimer = setInterval(pollOnce, POLL_MS);
  feed.stallTimer = setInterval(checkStall, 2000);
  pollOnce();
}

function stopFeed() {
  if (!feed) return;
  if (feed.watchId != null) navigator.geolocation.clearWatch(feed.watchId);
  clearInterval(feed.pollTimer);
  clearInterval(feed.stallTimer);
  feed = null;
}

/* The last reading that got through, or null before there is one. Everything
 * that acts on where you are, the mark key, the corner key, the follow key,
 * the age on screen, asks the feed rather than keeping a copy, so there is
 * one answer to "where are you" and it cannot go out of step with itself. */
function lastFix() { return feed ? feed.last : null; }

function herePoint() {
  const f = lastFix();
  return f ? [f.lat, f.lng] : null;
}

/* The watch is the cheap channel, so it gets first refusal: while it is
 * delivering on its own the poll stands down entirely, and nothing is asked of
 * the receiver twice. It only takes over where the watch has gone quiet. */
function onWatchFix(pos) {
  if (!feed) return;
  feed.lastWatchAt = Date.now();
  ingest(pos);
}

function onFeedError(err) {
  if (feed && feed.onError) feed.onError(err);
}

function pollOnce() {
  // One request in flight at a time, and none at all while the phone is away:
  // a hidden page gets no fresh fix anyway, and asking just burns the battery.
  if (!feed || feed.polling || document.visibilityState !== 'visible') return;
  if (Date.now() - feed.lastWatchAt < POLL_MS * 1.5) return;   // the watch has it covered
  feed.polling = true;
  // The request outlives the feed that made it if the screen changes under it,
  // so it answers to the feed it was asked for and to no other.
  const mine = feed;
  navigator.geolocation.getCurrentPosition(
    (pos) => { if (feed === mine) { feed.polling = false; ingest(pos); } },
    () => { if (feed === mine) feed.polling = false; },   // the watch owns the errors
    GEO_OPTS);
}

function checkStall() {
  if (!feed || document.visibilityState !== 'visible') return;
  if (Date.now() - feed.lastDeliveryAt < STALL_MS) return;
  navigator.geolocation.clearWatch(feed.watchId);
  feed.watchId = navigator.geolocation.watchPosition(onWatchFix, onFeedError, GEO_OPTS);
  feed.lastDeliveryAt = Date.now();   // the new watch gets its own grace period
  feed.restarts++;
}

/* Delivery time and measurement time are two different clocks and the app needs
 * both. Arrival drives the stall machinery, a watch that has gone quiet is a
 * fact about the browser. The receiver's own timestamp drives everything the
 * user reads, because a position the browser cached four minutes ago and handed
 * over unchanged must not be able to present itself as current. */
function ingest(pos) {
  if (!feed) return;

  const arrivedAt = Date.now();
  feed.lastDeliveryAt = arrivedAt;

  // Watch and poll usually hand over the same underlying reading. Same
  // timestamp means the phone has not moved on, so neither do we.
  if (pos.timestamp && pos.timestamp === feed.lastStamp) return;
  feed.lastStamp = pos.timestamp;
  feed.seen++;

  const fix = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    acc: pos.coords.accuracy,
    at: fixTime(pos, arrivedAt),
  };
  const prev = feed.last
    ? { lat: feed.last.lat, lng: feed.last.lng, acc: feed.last.acc,
        at: feed.last.at, bestAcc: feed.bestAcc }
    : null;

  const reason = keepFix(fix, prev, state.settings.accGate);
  if (reason) { feed.rejected++; return; }

  if (feed.last) {
    feed.intervals.push(fix.at - feed.last.at);
    if (feed.intervals.length > 20) feed.intervals.shift();
  }
  feed.last = fix;
  feed.accepted++;
  feed.bestAcc = Math.min(feed.bestAcc, fix.acc);
  feed.onFix(fix);
}

async function requestWakeLock() {
  if (!state.settings.keepAwake) return;
  const s = session();
  if (!s) return;
  if (!navigator.wakeLock) { s.ready.wake = false; return; }
  if (s.wakeLock && !s.wakeLock.released) return;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    const now = session();
    if (now !== s) { sentinel.release(); return; }  // it stopped mid-request
    s.wakeLock = sentinel;
    s.ready.wake = true;
    // The system drops the lock whenever the page is hidden, and hands back a
    // spent sentinel rather than null. Forget it here, or the re-request on
    // return sees a truthy object and never runs, after one lock/unlock the
    // screen would quietly start sleeping again.
    sentinel.addEventListener('release', () => {
      if (s.wakeLock === sentinel) s.wakeLock = null;
    });
  } catch (e) {
    // Denied or unsupported. The screen will time out as usual, which stops the
    // position feed dead, so this belongs on the readiness list rather than in
    // a swallowed catch.
    s.ready.wake = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !session()) return;
  requestWakeLock();
  // Nothing reached the phone while it was away. Say so before the old number
  // gets read as current, then go and get a new one straight away.
  tickFixAge();
  if (feed) feed.lastDeliveryAt = Date.now();
  pollOnce();
});

function onTrackError(err) {
  const t = state.tracking;
  if (!t) return;

  // A refusal is not a bad fix, it is the end of the road: no amount of
  // polling, restarting or waiting will produce a position, and pretending
  // otherwise leaves a dead screen looking busy.
  if (err.code === 1) { permissionRefused(); return; }

  // The other two are ordinary. Two channels report errors, and a timeout on
  // one while the other is still delivering is not a failure anybody needs to
  // read about.
  const f = lastFix();
  if (f && Date.now() - f.at < STALL_MS) return;

  const messages = { 2: 'err.noSats', 3: 'err.timeout' };
  if (!f) showWaiting('status.noGps', 'cap.noPosition');
  setWarn(messages[err.code] ? tr(messages[err.code]) : err.message);
}

function permissionRefused() {
  const t = state.tracking;
  if (!t || t.denied) return;
  t.denied = true;

  stopFeed();
  clearInterval(t.ageTimer);
  alerts.stop();
  t.status = null;
  t.candidate = null;
  showWaiting('status.noGps', 'cap.refused');
  setWarn('');
  el.metaAge.textContent = '–';
  refusedSheet();
}

function refusedSheet() {
  sheet(tr('refused.title'), [
    { label: tr('refused.tryAgain'), icon: 'locate', sub: tr('refused.tryAgainSub'),
      run: () => {
        if (!state.tracking) return;
        state.tracking.denied = false;
        showWaiting('status.waiting', 'cap.searching');
        state.tracking.ageTimer = setInterval(tickFixAge, 1000);
        startFeed(applyFix, onTrackError);
      } },
    { label: tr('refused.stop'), icon: 'stop', run: stopTracking },
  ], [tr('refused.trackNote'), refusedHowTo(), tr('refused.android', { hint: preciseHint() })]);
}

/* Where to turn location back on, named for the browser in hand. */
function refusedHowTo() {
  const name = browserName();
  return tr('refused.howTo', { where: name ? tr('browser.in', { name }) : tr('browser.inThis') });
}

function applyFix(fix) {
  const t = state.tracking;
  const field = state.fields.find((x) => x.id === state.editing);
  if (!t || !field) return;

  const here = [fix.lat, fix.lng];
  const accuracy = fix.acc;
  const now = fix.at;

  if (countsAsGood(accuracy)) t.goodFixes++;

  const result = evaluate(here, field.ring, state.settings.buffer);
  const v = verdict(result, accuracy);
  drawMe(here, accuracy);

  // The screen always shows the live reading, colour, word, number and gauge
  // agree with each other on every fix. What changes with a vague fix is what
  // the app is willing to claim: a fix wider than the distance it is judging
  // loses the green, keeps the red.
  const metres = Math.round(result.distance);
  const acc = Math.round(accuracy);
  const caption = {
    border: 'cap.border',
    unsure: 'cap.unsure',
    inside: 'cap.inside',
    outside: v.uncertain ? 'cap.outsideVague' : 'cap.outside',
  }[v.status];

  // The first fixes out of a cold receiver are the worst ones it will give you,
  // so they are shown, you may already be standing at the line, but said to
  // be still settling rather than presented as a verdict.
  const settling = provisional(t.goodFixes);
  showPanel(() => setPanel(v.status, tr('status.' + v.status), metres,
    tr(caption, { acc }) + (settling ? ' · ' + tr('cap.settling') : '')));
  if (settling) el.trackPanel.dataset.provisional = '1';
  else delete el.trackPanel.dataset.provisional;

  updateGauge(result);
  el.metaAcc.textContent = '±' + acc + ' m';

  // The alarm, though, gets hysteresis: GPS jitter right on the edge would
  // otherwise start and stop the beeping every second until you went mad.
  const next = settle({ status: t.status, candidate: t.candidate, since: t.since }, v.status, now);
  t.status = next.status;
  t.candidate = next.candidate;
  t.since = next.since;
  if (next.changed) alerts.setStatus(next.status);

  // One strip, one message. The unsure panel already says the accuracy beat the
  // distance, so the strip stays out of its way and speaks for the other states.
  if (accuracy > ACC_NETWORK) {
    setWarn(tr('warn.trackNetwork', { acc, hint: preciseHint() }));
  } else if (v.uncertain && v.status !== 'unsure') {
    setWarn(tr('warn.trackVague', { acc, m: metres }));
  } else if (accuracy > ACC_WARN) {
    setWarn(tr('warn.trackWeak', { acc }));
  } else if (settling) {
    setWarn(tr('warn.settling'));
  } else {
    setWarn('');
  }
  tickFixAge();
  if (sheetTick) renderGpsSheet();
}

/* The one repair that actually fixes a wandering position, named for whichever
 * browser is asking. Android hands out approximate location to any app that has
 * not been granted the precise kind, and a browser is one app to Android. */
function browserName() {
  const ua = navigator.userAgent;
  if (/FxiOS|Firefox/.test(ua)) return 'Firefox';
  if (/EdgA?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/CriOS|Chrome/.test(ua)) return 'Chrome';
  return '';
}
function preciseHint() {
  return tr('precise.hint', { browser: browserName() || tr('browser.this') });
}

/* Chrome on Android reads position through Google Play Services, which blends
 * GPS with wifi, cell and the phone's motion sensors and streams the result.
 * That much is documented in Chromium.
 *
 * What Firefox for Android does inside is not something this app can know, and
 * the Geolocation API exposes no way to ask: a page may request high accuracy,
 * and the browser and the OS decide between them how to answer it. What can be
 * observed is the behaviour, and it is consistently worse, fixes further
 * apart, wider scatter, and on some devices and versions positions that come
 * back stale or coarse whatever permission is granted. The poll in this file
 * forces fixes out of it; nothing here can make a poor one precise.
 *
 * So the app recommends Chrome on the strength of what it can see, says it
 * once, and stays out of the way.
 *
 * iOS is not the same case: every browser there runs WebKit, so Firefox on an
 * iPhone behaves like Safari and gets no warning. */
function isFirefoxAndroid() {
  return /Android/.test(navigator.userAgent) && /Firefox\//.test(navigator.userAgent);
}

function browserSheet() {
  clearInterval(sheetTick);
  sheetTick = null;
  el.sheetTitle.textContent = tr('firefox.title');
  el.sheetBody.innerHTML = tr('firefox.body');
  openSheet();
}

/* A frozen reading is the quiet failure this app could have: the number looks
 * confident, the phone stopped listening minutes ago. So the age is on screen,
 * and past ten seconds it says so out loud. */
function tickFixAge() {
  const f = lastFix();
  if (!f) return;
  const ms = Date.now() - f.at;
  const stale = ms > 10000;
  if (state.tracking) {
    el.metaAge.textContent = ageLabel(ms);
    el.metaAge.style.opacity = stale ? '0.6' : '';
  }
  if (state.walking) el.roAge.textContent = ageLabel(ms);
  renderWarn(stale ? tr('warn.stale', { age: ageLabel(ms) }) : null);
}

/* One strip, one message: staleness outranks anything about accuracy. */
function setWarn(text) {
  const s = session();
  if (!s) return;
  s.warnText = text || '';
  renderWarn(null);
}

function renderWarn(override) {
  const s = session();
  const text = override || (s ? s.warnText : '');
  el.accWarnText.textContent = text;
  el.accWarn.hidden = !text;
}

/* What the panel says is kept as a function rather than as words, so the
 * language switch can say it again at once instead of waiting for a fix that
 * may never come. */
function showPanel(view) {
  if (state.tracking) state.tracking.view = view;
  view();
}

function showWaiting(verdictKey, captionKey) {
  showPanel(() => setPanel('waiting', tr(verdictKey), '––', tr(captionKey)));
}

function setPanel(status, verdict, number, caption) {
  el.trackPanel.dataset.status = status;
  el.trackStatus.textContent = verdict;
  el.trackNum.textContent = number;
  el.trackUnit.hidden = (status === 'waiting');
  el.trackCaption.textContent = caption;
}

/* ------------------------------------------------------ the GPS detail sheet
 * Tapping the readout strip opens the numbers behind it, because "GPS is bad"
 * is not something anyone can act on and "±40 m, one fix in 20 seconds, nine
 * thrown away" is. */

let sheetTick = null;

function gpsSheet() {
  if (!state.tracking) return;
  renderGpsSheet();
  openSheet();
  clearInterval(sheetTick);
  sheetTick = setInterval(renderGpsSheet, 1000);
}

/* Whether the three ways this app can reach you are actually working. Not a
 * list of what the browser claims to support, what has been observed since
 * tracking started. */
function readinessBlock() {
  const t = state.tracking;
  const r = alerts.readiness();
  const mark = (good) => good === false ? '✕' : good === true ? '✓' : '–';
  const line = (good, label, note) =>
    '<div class="ready-row" data-ok="' + (good === null ? 'unknown' : good) + '">' +
    '<span class="ready-mark">' + mark(good) + '</span><span><b>' + label + '</b>' +
    (note ? '<em>' + escapeHtml(note) + '</em>' : '') + '</span></div>';

  const sound = r.muted ? null : t.ready.sound;
  const soundNote = tr(r.muted ? 'ready.muted'
    : t.ready.sound === false ? 'ready.soundRefused'
    : t.ready.sound === true ? 'ready.soundOn' : 'ready.starting');

  const vib = r.vibrate;
  const vibNote = tr(!alerts.canVibrate ? 'ready.vibNo'
    : vib === false ? 'ready.vibFail'
    : vib === true ? 'ready.vibOk' : 'ready.vibWait');

  return '<div class="ready-list">' +
    line(sound, tr('ready.sound'), soundNote) +
    line(vib, tr('ready.vibration'), vibNote) +
    line(t.ready.wake, tr('ready.screen'), tr(
      !state.settings.keepAwake ? 'ready.screenOff'
        : t.ready.wake === false ? 'ready.screenFail'
        : t.ready.wake === true ? 'ready.held' : 'ready.asking')) +
    '</div>';
}

/* The one failure nobody would otherwise notice until it mattered. */
function soundFailedSheet() {
  sheet(tr('sound.title'), [
    { label: tr('sound.retry'), icon: 'sound', sub: tr('sound.retrySub'),
      run: async () => {
        const running = await alerts.unlock();
        if (state.tracking) state.tracking.ready.sound = running;
        if (running) { alerts.preview('border'); toast(tr('sound.works')); }
        else toast(tr('sound.still'));
      } },
    { label: tr('sound.carry'), icon: 'warning',
      sub: tr('sound.carrySub'), run: () => {} },
  ], [tr('sound.note')]);
}

function renderGpsSheet() {
  const t = state.tracking;
  if (!t || !feed) return;
  // The counters are facts about the feed, not about tracking, so they are
  // read off the feed itself.
  const gaps = feed.intervals;
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000 : 0;
  const row = (k, v) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>';
  const f = feed.last;

  el.sheetTitle.textContent = tr('gps.title');
  el.sheetBody.innerHTML =
    '<dl class="gps-table">' +
    row(tr('gps.accNow'), f ? '±' + Math.round(f.acc) + ' m' : '–') +
    row(tr('gps.best'), isFinite(feed.bestAcc) ? '±' + Math.round(feed.bestAcc) + ' m' : '–') +
    row(tr('gps.every'), avg ? avg.toFixed(1) + ' s' : '–') +
    row(tr('gps.used'), tr('gps.usedValue', { a: feed.accepted, b: feed.seen })) +
    row(tr('gps.thrown'), String(feed.rejected)) +
    row(tr('gps.restarts'), String(feed.restarts)) +
    '</dl>' +
    readinessBlock() +
    '<p class="sheet-note">' + tr('gps.note') + '</p>' +
    '<p class="sheet-note">' + tr('gps.poor', { hint: preciseHint() }) + '</p>' +
    (isFirefoxAndroid() ? '<p class="sheet-note">' + tr('gps.firefox') + '</p>' : '') +
    (feed.rejected > feed.accepted && feed.seen > 6
      ? '<p class="sheet-note">' + tr('gps.rejected') + '</p>'
      : '');
}

/* The gauge answers a question the number cannot, which also makes it the one
 * part of the panel that has to be learnt. So it explains itself on a tap, and
 * says so once, the first time anybody tracks anything. */
function gaugeSheet() {
  clearInterval(sheetTick);
  sheetTick = null;
  const row = (k, v) => '<div><dt>' + tr(k) + '</dt><dd>' + v + '</dd></div>';
  el.sheetTitle.textContent = tr('gauge.title');
  el.sheetBody.innerHTML =
    '<p class="sheet-note">' + tr('gauge.intro') + '</p>' +
    '<dl class="gps-table">' +
    row('gauge.edge', tr('gauge.edgeIs')) +
    row('gauge.left', tr('gauge.leftIs')) +
    row('gauge.right', tr('gauge.rightIs')) +
    row('gauge.band', tr('gauge.bandIs', { m: state.settings.buffer })) +
    '</dl>' +
    '<p class="sheet-note">' + tr('gauge.how', { r: Math.round(gaugeRange()) }) + '</p>';
  openSheet();
}

function gaugeRange() {
  return Math.max(20, state.settings.buffer * 4);
}

/* The gauge exists because the number alone cannot show approach: you watch the
 * mark slide towards the hatched band before you ever reach it. Everything on
 * it is named, INSIDE and OUTSIDE written across the two halves, EDGE under
 * the heavy middle line, YOU on the pointer, so nothing has to be deduced. */
function renderGaugeScale() {
  const r = gaugeRange();
  const round = (m) => Math.round(m * 10) / 10;
  el.gaugeScale.innerHTML =
    '<span style="left:0">' + round(r) + ' m</span>' +
    '<span style="left:25%">' + round(r / 2) + '</span>' +
    '<span class="edge" style="left:50%">' + tr('gauge.edge') + '</span>' +
    '<span style="left:75%">' + round(r / 2) + '</span>' +
    '<span style="left:100%">' + round(r) + ' m</span>';
  // A tick every eighth of the scale; the quarter marks are full height and
  // sit exactly under the printed numbers.
  el.gaugeTicks.innerHTML = [12.5, 25, 37.5, 62.5, 75, 87.5]
    .map((p) => '<i class="' + (p % 25 === 0 ? 'major' : '') + '" style="left:' + p + '%"></i>')
    .join('');
  el.gaugeBand.style.width = (state.settings.buffer / r) * 100 + '%';
}

function updateGauge(result) {
  const r = gaugeRange();
  // Inside on the left, outside on the right: you read left to right, and you
  // walk out of a field the same way the mark travels.
  const pct = 50 - (result.signed / r) * 50;
  const clamped = pct < 4 || pct > 96;
  el.gauge.classList.toggle('is-clamped', clamped);
  const at = Math.max(4, Math.min(96, pct)) + '%';
  el.gaugeMark.style.left = at;
  el.gaugeYou.style.left = at;
}


function drawMe(here, accuracy) {
  if (!meMarker) {
    meAccuracy = L.circle(here, {
      radius: accuracy, color: PAPER(), weight: 1, opacity: 0.6,
      fillColor: PAPER(), fillOpacity: 0.14,
    }).addTo(map);
    meMarker = L.circleMarker(here, {
      radius: 9, color: PAPER(), weight: 3.5, fillColor: INK(), fillOpacity: 1,
    }).addTo(map);
  } else {
    meMarker.setLatLng(here);
    meAccuracy.setLatLng(here).setRadius(accuracy);
  }
  keepInView(here);
}

/* Pan only when the marker leaves the map area the panel has not covered:
 * and only while the map is still following you. Walking a boundary, you want
 * the map to keep up without being asked. Standing still and reading the map,
 * you want it to hold still: being dragged back to yourself every few seconds
 * makes the map unusable for the one thing it is for, which is looking at
 * somewhere you are not. So dragging the map turns following off, and only the
 * FOLLOW key turns it back on. */
function keepInView(here) {
  const s = session();
  if (s && !s.follow) return;
  const free = uncoveredMap();
  // Below this there is no room left to pan into, so panning would only shove
  // you from one edge of a letterbox to the other.
  if (free.right < 120 || free.bottom < 120) return;
  const p = map.latLngToContainerPoint(here);
  const m = 44;
  let dx = 0, dy = 0;
  if (p.x < m) dx = p.x - m;
  else if (p.x > free.right - m) dx = p.x - (free.right - m);
  if (p.y < m) dy = p.y - m;
  else if (p.y > free.bottom - m) dy = p.y - (free.bottom - m);
  if (dx || dy) map.panBy([dx, dy], { animate: true, duration: 0.4 });
}

/* How much of the map is not hidden behind the answer panel, in the map's own
 * container coordinates. The panel docks along the bottom in portrait and
 * along the right edge when the phone is on its side, so where it sits is
 * measured rather than assumed, guessing "bottom" cost landscape its ability
 * to follow you at all. */
function uncoveredMap() {
  const size = map.getSize();
  const free = { right: size.x, bottom: size.y };
  // Whichever is docked: the answer panel while tracking, the drawing controls
  // while an area is being made and walked.
  const dock = !el.trackPanel.hidden ? el.trackPanel
    : !el.editBar.hidden ? el.editBar : null;
  if (!dock) return free;
  const box = el.map.getBoundingClientRect();
  const p = dock.getBoundingClientRect();
  const overlaps = p.left < box.right && p.right > box.left &&
                   p.top < box.bottom && p.bottom > box.top;
  if (!overlaps) return free;
  if (p.top > box.top) free.bottom = Math.min(free.bottom, p.top - box.top);
  if (p.left > box.left) free.right = Math.min(free.right, p.left - box.left);
  return free;
}

/* Only offered when it would do something: you are tracking, and you have
 * pushed the map off yourself. */
function syncRecentre() {
  const s = session();
  el.btnRecentre.hidden = !(s && !s.follow) || !!moving;
}

/* Back to yourself, at the zoom you were reading at, the map returns to you,
 * it does not undo the looking around you were doing. Following resumes,
 * because a key you press to be followed is a key you press once. */
function recentre() {
  const s = session();
  if (!s) return;
  s.follow = true;
  syncRecentre();
  const here = herePoint();
  if (!here) {
    // Nothing to go back to yet. Following is on, so the first fix will take
    // you there, say so, rather than looking like a key that did nothing.
    toast(tr('toast.noFixYet'));
    return;
  }
  map.setView(here, map.getZoom(), { animate: true });
}

function locateMe(zoomIn) {
  // A running feed already has a better position than a one-shot request will
  // get, and asking to be found while it runs is asking to be followed again.
  const s = session();
  if (s) {
    s.follow = true;
    syncRecentre();
    const here = herePoint();
    if (here) map.setView(here, zoomIn ? Math.max(map.getZoom(), 18) : map.getZoom());
    else toast(tr('toast.noFixYet'));
    return;
  }
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    const here = [pos.coords.latitude, pos.coords.longitude];
    map.setView(here, zoomIn ? 18 : map.getZoom());
    drawMe(here, pos.coords.accuracy);
  }, () => toast(tr('toast.noLocation')), { enableHighAccuracy: true, timeout: 15000 });
}

/* ----------------------------------------------------------------- marks
 *
 * The boundary answers one question all day. A mark answers a different one:
 * "this, here, now" -- a tree to fell, a broken post, a nest to keep clear of.
 * So a mark is deliberately cheap to make and hard to lose: one tap drops it
 * at the live position, it takes the next number without asking, and it is
 * written to storage in the same breath.
 *
 * Two rules it inherits from the rest of the app. It never claims more than
 * the fix it came from, so the accuracy it was taken at is stored with it and
 * shown everywhere it appears. And it is only in a browser until you get it
 * into a file, which the app says out loud rather than letting you assume. */

function marksOf(field) {
  return (field && field.marks) || [];
}

function trackedField() {
  return state.tracking ? state.fields.find((x) => x.id === state.editing) : null;
}

/* The mark you last dropped or last opened, by id, so the quick key can offer
 * it again. Held by id rather than by object: a mark that is deleted, or one
 * that comes back from a file as a different object, simply stops being found
 * and the key goes away on its own. */
let lastMarkId = null;

function lastMarkOf(field) {
  if (!lastMarkId) return null;
  return marksOf(field).find((m) => m.id === lastMarkId) || null;
}

function selectMark(mark) {
  lastMarkId = mark ? mark.id : null;
  syncLastMark();
  redrawMarks();
}

/* One mark being placed by hand: which one, and where the hand has it now.
 * The mark itself is not touched until you say place it, so leaving the move
 * needs no undo, nothing has changed yet. */
let moving = null;

/* ------------------------------------------------ discs on top of one another
 *
 * A survey walked on foot leaves marks a hand's width apart, and two of those
 * are one disc at any zoom a phone can draw: the second sits behind the first,
 * and the map says "mark 84" where there are four. A record of points may be
 * hard to read, but it may not quietly show you fewer points than you took.
 *
 * Moving discs apart is not free, a disc is a claim about a place, and the
 * rest of this app spends real effort not letting one drift. So the first
 * answer costs nothing: a pile is drawn AS a pile. One disc, still exactly on
 * its point, standing on the ones behind it, with how many there are written
 * on its shoulder. Nothing has moved and nothing is hidden.
 *
 * Spreading them out is then something you ask for by tapping the pile, or
 * something the app does for you when the mark you last opened is inside one,
 * which is precisely the case where you have centred the map on a mark and
 * still cannot find it. A spread disc is off its point, so it is drawn
 * tethered: a dotted leg back to a dot at the position it really holds. The
 * disc is the label; the dot is the mark.
 *
 * The marker itself never moves. The offset is applied to the icon's anchor,
 * so getLatLng() on any disc on this map is still the truth. */

/* Closer than this on screen and one disc hides the other. */
const PILE_PX = 20;
/* Centre to centre once spread. They still overlap, that is what keeps the
 * spread small, but every number reads and every edge is its own. */
const FAN_STEP = 20;
/* And a spread never takes a disc further from its point than this, so it only
 * ever happens at a zoom where the leg is short on the ground. Zoom out and the
 * pile closes itself back up. */
const FAN_MAX_M = 6;

/* Which pile you have opened by hand. The pile holding the mark you last
 * opened is open anyway; this is the other way in. Held by id, so a pile that
 * stops existing at the next zoom simply stops being found. */
let openPileId = null;

/* Piles, by distance on screen. Membership is measured against the first disc
 * of a pile rather than against any of them: a line of marks a stride apart
 * would otherwise chain itself into one enormous pile.
 *
 * project is passed in rather than assumed, because the same piling has to be
 * worked out for a zoom the map has not gone to yet, see zoomToShow. */
function pileUp(list, project) {
  const pts = list.map((m) => project([m.lat, m.lng]));
  const piles = [];
  const taken = new Array(list.length).fill(false);
  for (let i = 0; i < list.length; i++) {
    if (taken[i]) continue;
    taken[i] = true;
    const pile = [{ mark: list[i], pt: pts[i] }];
    for (let j = i + 1; j < list.length; j++) {
      if (!taken[j] && pts[i].distanceTo(pts[j]) < PILE_PX) {
        taken[j] = true;
        pile.push({ mark: list[j], pt: pts[j] });
      }
    }
    piles.push(pile);
  }
  return piles;
}

/* Where the discs of a spread pile sit, in pixels from where they were: rings
 * filled from the inside out, numbers ascending clockwise from the top, so the
 * same pile always spreads the same way and you can read it like a clock. */
function fanOffsets(n) {
  if (n < 2) return [[0, 0]];
  const out = [];
  let left = n, ring = 0;
  while (left > 0) {
    ring++;
    let radius, take;
    if (ring === 1 && left <= 7) {
      take = left;
      radius = FAN_STEP / (2 * Math.sin(Math.PI / take));
    } else {
      radius = 14 + 18 * (ring - 1);
      take = Math.min(left, Math.max(1, Math.floor(2 * Math.PI * radius / FAN_STEP)));
    }
    const turn = ring % 2 ? 0 : Math.PI / take;
    for (let i = 0; i < take; i++) {
      const a = -Math.PI / 2 + turn + (2 * Math.PI * i) / take;
      out.push([radius * Math.cos(a), radius * Math.sin(a)]);
    }
    left -= take;
  }
  return out;
}

/* How far out the widest disc of that spread would go. */
function fanRadius(offsets) {
  return offsets.reduce((r, o) => Math.max(r, Math.hypot(o[0], o[1])), 0);
}

/* Can a pile of this many spread at this zoom without any disc standing
 * further from its point than FAN_MAX_M? Close in, yes; a step out and the
 * answer turns, which is what closes the pile back up on its own. */
function canSpread(n, zoom) {
  return fanRadius(fanOffsets(n)) <= FAN_MAX_M / metresPerPixel(zoom);
}

/* How far in the map has to go before the pile holding this mark comes apart.
 * Centring on a mark that turns out to be under four others, and leaving you
 * at the zoom you were already at, is the whole of the complaint this answers:
 * you arrive, and it is open. */
function zoomToShow(field, mark, from) {
  const list = marksOf(field);
  const top = map.getMaxZoom();
  for (let z = from; z < top; z++) {
    const pile = pileUp(list, (ll) => map.project(ll, z))
      .find((g) => g.some((p) => p.mark.id === mark.id));
    if (!pile || pile.length === 1 || canSpread(pile.length, z)) return z;
  }
  return top;
}

/* Drawn while tracking only. During editing the corners are numbered discs of
 * their own, and two sets of numbered discs on one map is a way to cut the
 * wrong tree. */
function redrawMarks() {
  if (!markGroup) return;
  markGroup.clearLayers();
  const field = state.mode === 'track' ? trackedField() : null;
  if (!field) return;
  const list = marksOf(field);

  // The one in hand is out of the piles entirely: where it is is not settled
  // yet, and a disc being placed must be free of anything the drawing does for
  // tidiness. It is added last, and above everything.
  const held = moving && moving.field === field ? moving.mark.id : null;
  const settled = held ? list.filter((m) => m.id !== held) : list;

  pileUp(settled, (ll) => map.latLngToLayerPoint(ll)).forEach((pile) => {
    if (pile.length === 1) { addDisc(field, pile[0], null, null); return; }
    const open = pile.some((p) => p.mark.id === openPileId || p.mark.id === lastMarkId);
    if (open && canSpread(pile.length)) {
      const offsets = fanOffsets(pile.length);
      addTethers(pile, offsets);
      pile.forEach((p, i) => addDisc(field, p, offsets[i], null));
    } else {
      // One disc for the lot, and it is the one you last opened if that is in
      // here, being able to find that one is the whole point of the pile.
      const rep = pile.find((p) => p.mark.id === lastMarkId) || pile[0];
      addDisc(field, rep, null, pile);
    }
  });

  if (held) addHeld();
}

/* The legs, and the dots they run back to. Drawn as overlays rather than
 * markers, so they sit under every disc without anyone having to say so, and
 * they take no taps: a leg is something to read, not something to hit. */
function addTethers(pile, offsets) {
  const legs = pile.map((p, i) => [
    map.layerPointToLatLng(p.pt),
    map.layerPointToLatLng(L.point(p.pt.x + offsets[i][0], p.pt.y + offsets[i][1])),
  ]);
  markGroup.addLayer(L.polyline(legs, {
    color: PAPER(), weight: 3.5, opacity: 0.55, interactive: false,
  }));
  markGroup.addLayer(L.polyline(legs, {
    color: INK(), weight: 1.25, opacity: 0.95, dashArray: '3 4', interactive: false,
  }));
  pile.forEach((p) => markGroup.addLayer(L.circleMarker(map.layerPointToLatLng(p.pt), {
    radius: 2.5, color: PAPER(), weight: 1.5, opacity: 0.9,
    fillColor: INK(), fillOpacity: 1, interactive: false,
  })));
}

/* One numbered disc. off is where the spread has pushed the icon, in pixels;
 * pile is the rest of the marks it is standing on when it is drawn closed. */
function addDisc(field, entry, off, pile) {
  const mark = entry.mark;
  const count = pile ? pile.length : 1;
  const size = 26;
  const cls = 'station'
    + (moving ? ' is-quiet' : '')
    + (mark.id === lastMarkId ? ' is-open' : '')
    + (count > 1 ? ' is-pile' : '');
  const marker = L.marker([mark.lat, mark.lng], {
    title: count > 1
      ? tr('marks.pileTitle', { count, top: markTitle(mark) })
      : markTitle(mark),
    icon: L.divIcon({
      className: cls,
      html: String(mark.n) + (count > 1 ? '<i class="station-more">' + count + '</i>' : ''),
      iconSize: [size, size],
      // Leaflet centres a divIcon by halving the size it was told, so this is
      // that centre moved by the spread. The marker keeps its true position.
      iconAnchor: [size / 2 - (off ? off[0] : 0), size / 2 - (off ? off[1] : 0)],
    }),
    // Leaflet makes every marker a tab stop. Two hundred marks then stand
    // between the keyboard and the STOP key, and a screen reader reads the
    // whole survey out before reaching the answer. The tally in the top bar
    // lists all of them as real rows, so nothing is lost by taking the discs
    // out of the tab order; they stay tappable.
    keyboard: false,
    // Leaflet stacks discs by how far down the screen they are, which is the
    // right default everywhere except on the one disc you are looking for.
    zIndexOffset: mark.id === lastMarkId ? 800 : 0,
  });
  marker.on('click', (e) => {
    // Every disc is inert while one is in hand: a tap on the map is how you
    // place it, and a tap that opened a second mark's options half way
    // through would lose the placing.
    L.DomEvent.stop(e);
    if (moving) return;
    if (count > 1) { openPile(field, pile); return; }
    markSheet(field, mark);   // which is what makes it the one you last opened
  });
  markGroup.addLayer(marker);
}

/* A tap on a closed pile. If it can spread here, it spreads. If it cannot:
 * too many of them for this zoom to hold them honestly, it says so as a list
 * instead, because "there are eleven and you may not see them" is not an
 * answer anybody can use. */
function openPile(field, pile) {
  if (canSpread(pile.length)) {
    openPileId = pile[0].mark.id;
    redrawMarks();
    return;
  }
  pileSheet(field, pile);
}

function pileSheet(field, pile) {
  const from = state.tracking ? herePoint() : null;
  sheet(tr('pile.title', { n: pile.length }), pile.map((p) => ({
    label: markTitle(p.mark),
    icon: 'mark',
    sub: markDetail(p.mark, from),
    run: () => markSheet(field, p.mark),
  })), [tr('pile.note1'), tr('pile.note2')]);
}

/* The disc in hand. Bigger, inverted, above everything, and the only one on
 * the map that can be dragged. */
function addHeld() {
  const mark = moving.mark;
  const marker = L.marker(moving.at, {
    title: markTitle(mark),
    icon: L.divIcon({ className: 'station is-held', html: String(mark.n), iconSize: [34, 34] }),
    keyboard: false,
    draggable: true,
    zIndexOffset: 1200,
  });
  marker.on('drag', () => {
    const ll = marker.getLatLng();
    moving.at = [ll.lat, ll.lng];
    moving.touched = true;
    syncMoveBar();
  });
  markGroup.addLayer(marker);
}

function syncMarksButton() {
  const field = trackedField();
  el.btnMarks.hidden = !field;
  el.btnMark.hidden = !field || !!moving;
  syncLastMark();
  if (!field) return;
  const n = marksOf(field).length;
  el.markCount.textContent = n;
  el.btnMarks.setAttribute('aria-label', tr('marks.aria', { n }));
}

/* One key, one mark, and everything you can do to it behind the tap. Spreading
 * label / move / delete across the map would put three more targets under a
 * gloved thumb that is already sharing the corner with MARK. */
function syncLastMark() {
  const field = trackedField();
  const mark = field ? lastMarkOf(field) : null;
  el.btnLastMark.hidden = !mark || !!moving;
  if (!mark) return;
  el.lastMarkNum.textContent = mark.n;
  el.btnLastMark.setAttribute('aria-label', tr('marks.lastAria', { title: markTitle(mark) }));
}

/* One tap, at the position on screen. Nothing is asked before the mark exists:
 * you are standing at the thing now, and a dialog between you and the record is
 * how marks stop getting made. Naming it is offered afterwards. */
function dropMark() {
  const t = state.tracking;
  const field = trackedField();
  if (!t || !field) return;
  const f = lastFix();
  if (!f) { toast(tr('toast.noPositionMark')); return; }

  const now = Date.now();
  if (!field.marks) field.marks = [];
  const mark = makeMark(
    { lat: f.lat, lng: f.lng, acc: f.acc, at: f.at }, field.marks, now);
  field.marks.push(mark);
  field.updated = now;
  saveFields();
  selectMark(mark);
  syncMarksButton();
  alerts.marked();

  const said = tr('mark.title', { n: mark.n }) +
    (Number.isFinite(mark.acc) ? ' · ±' + Math.round(mark.acc) + ' m' : '') +
    (isStale(mark) ? ' · ' + tr('toast.fromFix', { age: ageLabel(mark.age) }) : '');
  toast(said, tr('toast.nameIt'), () => renameMark(field, mark));
}

function renameMark(field, mark) {
  askText({ title: tr('label.title', { n: mark.n }), label: tr('label.label'),
            value: mark.label || '', ok: tr('label.ok'), maxLength: MAX_LABEL, allowEmpty: true,
            notes: mark.label ? [tr('label.clearNote', { n: mark.n })] : null },
    (answer) => {
      mark.label = cleanLabel(answer);
      saveFields();
      redrawMarks();
      syncLastMark();     // the quick key announces it by name, so the name moves
      render();
      toast(mark.label ? tr('toast.labelled', { n: mark.n, label: mark.label })
                       : tr('toast.labelCleared', { n: mark.n }));
    });
}

function deleteMark(field, mark) {
  const list = marksOf(field);
  const at = list.findIndex((m) => m.id === mark.id);
  if (at < 0) return;
  if (moving && moving.mark.id === mark.id) endMove();
  list.splice(at, 1);
  saveFields();
  redrawMarks();
  syncMarksButton();
  render();
  toast(tr('toast.markDeleted', { n: mark.n }), tr('common.undo'), () => {
    list.splice(at, 0, mark);
    saveFields();
    redrawMarks();
    syncMarksButton();
    render();
  });
}

/* ------------------------------------------------------- moving one by hand
 *
 * The fix put the disc where the phone thought you were. On imagery you can
 * often see the tree itself, a few metres off, and dragging the disc onto it
 * is a better record of where the thing is than the fix was.
 *
 * What it is not is a better fix, so the mark stops claiming one: see
 * handPlace() in marks.js. Nothing here is written until you say place it,
 * which is why leaving the move needs nothing undone. */

function beginMove(field, mark) {
  if (state.mode !== 'track' || !map) return;
  if (moving) endMove();
  moving = { field, mark, at: [mark.lat, mark.lng], touched: false };

  // A map that hauls you back to yourself every few seconds is a map you
  // cannot place anything on. Dragging it off yourself is what normally turns
  // following off, and this is the same act by other means.
  if (state.tracking) state.tracking.follow = false;
  syncRecentre();       // and it stands down itself while a disc is in hand
  el.scrMap.classList.add('is-moving');
  el.moveBar.hidden = false;
  syncMoveBar();
  syncMarksButton();
  redrawMarks();
  map.setView([mark.lat, mark.lng], Math.max(map.getZoom(), 18));
}

/* Tapping the map is the other hand: a thumb covers the disc it is dragging,
 * and at 34 px it covers what the disc is being lined up with too. */
function holdAt(lat, lng) {
  if (!moving) return;
  moving.at = [lat, lng];
  moving.touched = true;
  syncMoveBar();
  redrawMarks();
}

function endMove() {
  moving = null;
  el.scrMap.classList.remove('is-moving');
  el.moveBar.hidden = true;
  syncMarksButton();
  syncRecentre();
  redrawMarks();
}

function syncMoveBar() {
  if (!moving) return;
  const mark = moving.mark;
  const off = haversine(Array.isArray(mark.fix) ? mark.fix : [mark.lat, mark.lng], moving.at);
  el.moveText.textContent = moving.touched
    ? tr('move.moved', { title: markTitle(mark), d: formatLength(off) })
    : tr('move.prompt', { title: markTitle(mark) });
}

function placeMove() {
  if (!moving) return;
  const { field, mark, at, touched } = moving;
  endMove();
  if (!touched) { toast(tr('toast.markLeft', { n: mark.n })); return; }

  // Kept whole so undo puts back the claim as well as the place: a mark that
  // came back to the right spot still owing an accuracy it no longer has
  // would be the quiet lie this app exists not to tell.
  const before = { lat: mark.lat, lng: mark.lng, fix: mark.fix || null,
                   placed: mark.placed || null };
  Object.assign(mark, handPlace(mark, at[0], at[1]));
  field.updated = Date.now();
  saveFields();
  selectMark(mark);
  render();

  const off = handOffset(mark);
  toast(tr('toast.markMoved', { n: mark.n, d: formatLength(off) }),
    tr('common.undo'), () => {
      Object.assign(mark, before);
      saveFields();
      redrawMarks();
      render();
      toast(tr('toast.markBack', { n: mark.n }));
    });
}

/* Only ever back to the reading, and only offered while there is a hand on it
 * to take off. */
function putMarkBack(field, mark) {
  const back = putBack(mark);
  if (!back) return;
  const before = { lat: mark.lat, lng: mark.lng, fix: mark.fix, placed: mark.placed };
  Object.assign(mark, back);
  field.updated = Date.now();
  saveFields();
  redrawMarks();
  render();
  toast(tr('toast.markBack', { n: mark.n }), tr('common.undo'), () => {
    Object.assign(mark, before);
    saveFields();
    redrawMarks();
    render();
  });
}

function markSheet(field, mark) {
  const from = state.tracking ? herePoint() : null;
  selectMark(mark);
  const rows = [
    { label: tr(mark.label ? 'ms.relabel' : 'ms.label'), icon: 'rename',
      sub: mark.label ? tr('ms.now', { label: mark.label })
                      : tr('ms.otherwise', { n: mark.n }),
      run: () => renameMark(field, mark) },
  ];
  if (state.mode === 'track') {
    rows.push({ label: tr('ms.move'), icon: 'move', sub: tr('ms.moveSub'),
      run: () => beginMove(field, mark) });
    if (isHandPlaced(mark) && Array.isArray(mark.fix)) {
      rows.push({ label: tr('ms.putBack'), icon: 'undo',
        sub: tr('ms.putBackSub', { d: formatLength(handOffset(mark)) }),
        run: () => putMarkBack(field, mark) });
    }
    rows.push({ label: tr('ms.centre'), icon: 'locate', sub: tr('ms.centreSub'),
      run: () => map.setView([mark.lat, mark.lng],
                             zoomToShow(field, mark, Math.max(map.getZoom(), 18))) });
  }
  rows.push({ label: tr('ms.delete'), icon: 'clear', danger: true,
    sub: tr('ms.deleteSub'), run: () => deleteMark(field, mark) });
  sheet(markTitle(mark), rows, [markDetail(mark, from)]);
}

function marksSheet(field) {
  const list = marksOf(field);
  const from = state.tracking ? herePoint() : null;
  const rows = list.map((m) => ({
    label: markTitle(m),
    icon: 'mark',
    sub: markDetail(m, from),
    run: () => markSheet(field, m),
  }));
  if (list.length) {
    rows.push({ label: tr('mk.save'), icon: 'export', sub: tr('mk.saveSub'),
      run: () => exportMarksSheet(field) });
    rows.push({ label: tr(list.length === 1 ? 'ms.delete' : 'mk.deleteAll'),
      icon: 'clear', danger: true,
      sub: list.length === 1 ? tr('mk.onlyOne') : tr('mk.allN', { n: list.length }),
      run: () => deleteAllMarks(field) });
  }
  sheet(tr('mk.title', { name: field.name }), rows, list.length
    ? [tr('mk.note1', { n: list.length }), tr('mk.note2')]
    : [tr('mk.empty')]);
}

function exportMarksSheet(field) {
  const list = marksOf(field);
  if (!list.length) return;
  const base = tr('file.marks', { name: field.name });
  const write = (name, text, mime) => {
    download(name, text, mime);
    offerToClear(field, list.length);
  };
  sheet(tr('ex.title', { n: list.length }), [
    { label: tr('ex.gpx'), icon: 'export', sub: tr('ex.gpxSub'),
      run: () => write(base + '.gpx', marksToGPX(field.name, list), 'application/gpx+xml') },
    { label: tr('ex.kml'), icon: 'export', sub: tr('ex.kmlSub'),
      run: () => write(base + '.kml', marksToKML(field.name, list),
                       'application/vnd.google-earth.kml+xml') },
    { label: tr('ex.geojson'), icon: 'export', sub: tr('ex.geojsonSub'),
      run: () => write(base + '.geojson', marksToGeoJSON(field.name, list),
                       'application/geo+json') },
  ], [tr('ex.note')]);
}

/* Offered, never done for you, and never before the file exists. From in here a
 * download the browser refused looks exactly like one it saved. */
function offerToClear(field, count) {
  sheet(tr('oc.title'), [
    { label: tr('oc.keep'), icon: 'back', sub: tr('oc.keepSub'),
      run: () => {} },
    { label: tr('oc.delete', { n: count }), icon: 'clear', danger: true,
      run: () => deleteAllMarks(field) },
  ], [tr('oc.note')]);
}

function deleteAllMarks(field) {
  const count = marksOf(field).length;
  if (!count) return;
  askConfirm({ title: tr('da.title', { n: count }), ok: tr('da.ok', { n: count }),
               keep: tr('da.keep', { n: count }),
               notes: [tr('da.note', { name: field.name })] }, () => {
    if (moving) endMove();
    field.marks = [];
    saveFields();
    redrawMarks();
    syncMarksButton();
    render();
    toast(tr('da.done', { n: count }));
  });
}

/* --------------------------------------------------------- offline maps */

function tileRange(bounds, z) {
  const n = Math.pow(2, z);
  const toX = (lng) => Math.floor((lng + 180) / 360 * n);
  const toY = (lat) => {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  return {
    x0: toX(bounds.getWest()), x1: toX(bounds.getEast()),
    y0: toY(bounds.getNorth()), y1: toY(bounds.getSouth()),
  };
}

function tileUrls(bounds, zooms) {
  const template = TILES[state.settings.layer].url;
  const urls = [];
  zooms.forEach((z) => {
    const r = tileRange(bounds, z);
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        urls.push(template.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
    }
  });
  return urls;
}

async function downloadOffline() {
  const source = TILES[state.settings.layer];
  if (!source.offline) {
    sheet(tr('off.notLayer'), [
      { label: tr('off.switch'), icon: 'layers',
        sub: tr('off.switchSub'), run: () => { setLayer('satellite'); downloadOffline(); } },
      { label: tr('common.back'), icon: 'back', run: () => {} },
    ], [tr('off.osmNote')]);
    return;
  }

  const bounds = map.getBounds().pad(0.15);
  const urls = tileUrls(bounds, [14, 15, 16, 17, 18]);
  if (urls.length > MAX_OFFLINE_TILES) {
    toast(tr('off.tooBig', { n: urls.length }));
    return;
  }
  const kb = urls.length * 14; // tiles run ~12-16 KB each
  const size = kb < 1024 ? kb + ' KB' : (kb / 1024).toFixed(1) + ' MB';
  sheet(tr('off.title'), [
    { label: tr('off.save', { n: urls.length }), icon: 'offline', sub: tr('off.size', { size }),
      run: () => fetchTiles(urls) },
    { label: tr('common.cancel'), icon: 'back', run: () => {} },
  ], [tr('off.note')]);
}

async function fetchTiles(urls) {
  const cache = await caches.open('fb-tiles-v1');
  let done = 0, failed = 0;
  el.btnOffline.disabled = true;
  for (let i = 0; i < urls.length; i += 8) {
    const batch = urls.slice(i, i + 8).map(async (url) => {
      try {
        const cached = await cache.match(url);
        if (cached) { done++; return; }
        const res = await fetch(url, { mode: 'cors' });
        if (res.ok) { await cache.put(url, res); done++; } else { failed++; }
      } catch (e) { failed++; }
    });
    await Promise.all(batch);
    el.offlineName.textContent = done + '/' + urls.length;
  }
  el.btnOffline.disabled = false;
  el.offlineName.textContent = tr('tool.saveMap');
  toast(tr('off.done', { done, failed }));
}

async function tileCacheInfo() {
  const ready =
    offlineState === 'ready' ? tr('app.ready')
    : offlineState === 'starting' ? tr('app.starting')
    : offlineState === 'unsupported' ? tr('app.unsupported')
    : tr('app.failed', { why: offlineState.slice(7) });

  if (!window.caches) return ready + ' ' + tr('tiles.noCache');
  const cache = await caches.open('fb-tiles-v1');
  const keys = await cache.keys();
  return ready + ' ' + (keys.length ? tr('tiles.count', { n: keys.length }) : tr('tiles.none'));
}

/* ---------------------------------------------------------------- import */

async function handleImport(file) {
  let geoms;
  try {
    geoms = await readBoundaryFile(file);
  } catch (e) {
    sheet(tr('imp.fail'), [
      { label: e.message, icon: 'warning', run: () => {} },
    ]);
    return;
  }
  const use = (g) => guard(g.ring, g.notes, (ring) => {
    state.fields.push({ id: 'f' + Date.now(), name: g.name, ring,
                        marks: cleanMarks(g.marks), updated: Date.now() });
    saveFields();
    render();
    toast(tr('toast.imported', { name: g.name }));
  });
  if (geoms.length === 1) { use(geoms[0]); return; }
  sheet(tr('imp.many', { n: geoms.length }), geoms.map((g) => ({
    label: g.name,
    icon: 'plan',
    sub: tr('imp.sub', { n: g.ring.length, area: formatArea(area(g.ring)) }),
    run: () => use(g),
  })));
}

/* --------------------------------------------------------------- screens */

function show(screen) {
  // Leaving the drawing screen ends the walk with it: the feed, the wake lock
  // and the live dot all belong to a drawing that is no longer on the glass.
  if (screen !== 'map' && state.walking) stopWalk();
  if (screen !== 'fields' && state.screen === 'fields') guardHistory();
  state.screen = screen;
  document.body.dataset.screen = screen;
  el.scrFields.hidden = screen !== 'fields';
  el.scrMap.hidden = screen !== 'map';
  el.scrSettings.hidden = screen !== 'settings';
  el.btnBack.hidden = screen === 'fields';
  el.btnSettings.hidden = screen !== 'fields';

  if (screen === 'fields') {
    state.mode = null;
    el.title.textContent = tr('title.areas');
    render();
  } else if (screen === 'settings') {
    el.title.textContent = tr('title.settings');
    renderSettings();
  } else if (screen === 'map') {
    // Built here rather than at startup. A map that exists asks Esri for the
    // tile under its centre, and until this screen opens nobody has asked to
    // see the ground.
    if (!map) initMap();
    // Leaflet measured the container while it was still hidden, so it thinks
    // the map is 0x0. Re-measure now, before anyone calls fitBounds, a
    // fitBounds against a zero-size map lands at maximum zoom.
    map.invalidateSize(false);
  }
}

/* An area half surveyed: two legs drawn, the third on its way to where the
 * next corner will go, and the line home not yet walked. It is the drawing
 * screen at the moment it starts to become an area. */
const EMPTY_PLAN =
  '<svg viewBox="0 0 160 120" aria-hidden="true">' +
  '<path class="e-home" d="M66 100 30 34"/>' +
  '<path class="e-leg" d="M30 34 118 22 134 82"/>' +
  '<path class="e-next" d="M134 82 66 100"/>' +
  '<g class="e-aim"><circle cx="66" cy="100" r="7"/><path d="M66 88v5M66 107v5M54 100h5M73 100h5"/></g>' +
  [[30, 34, 1], [118, 22, 2], [134, 82, 3]].map((s) =>
    '<g class="e-stn"><circle cx="' + s[0] + '" cy="' + s[1] + '" r="10"/>' +
    '<text x="' + s[0] + '" y="' + (s[1] + 4.2) + '">' + s[2] + '</text></g>').join('') +
  '</svg>';

function render() {
  el.fieldList.innerHTML = '';
  renderTally();
  if (!state.fields.length) {
    el.fieldList.innerHTML =
      '<div class="empty">' + EMPTY_PLAN +
      '<h2>' + tr('empty.title') + '</h2>' +
      '<p>' + tr('empty.text') + '</p>' +
      '</div>';
    syncOverview();
    return;
  }
  state.fields.forEach((f) => {
    const m2 = area(f.ring);
    const ha = m2 / 10000;
    const row = document.createElement('div');
    row.className = 'area';
    row.dataset.id = f.id;
    row.innerHTML =
      planSVG(f.ring, marksOf(f)) +
      '<h2 class="area-name">' + escapeHtml(f.name) + '</h2>' +
      '<dl class="area-spec">' +
        '<div><dd>' + formatHa(ha) + '</dd><dt>' + tr('unit.ha') + '</dt></div>' +
        '<div><dd>' + formatAcres(ha) + '</dd><dt>' + tr('unit.acres') + '</dt></div>' +
        (f.marks && f.marks.length
          ? '<div><dd>' + f.marks.length + '</dd><dt>' +
            tr('unit.marks', { n: f.marks.length }) + '</dt></div>' : '') +
      '</dl>' +
      '<button class="icon-btn area-more" aria-label="' +
        escapeHtml(tr('row.more', { name: f.name })) + '">' + icon('more') + '</button>' +
      '<button class="btn btn-filled area-go">' + icon('locate') + tr('row.track') + '</button>';

    row.querySelector('.area-more').onclick = () => fieldMenu(f);
    row.querySelector('.area-go').onclick = () => startTracking(f);
    // Beside the overview, a row and its parcel are one thing: pointing at
    // either lights both, and picking the row takes the map to it.
    row.onmouseenter = () => lightArea(f.id);
    row.onmouseleave = () => lightArea(null);
    row.addEventListener('focusin', () => lightArea(f.id));
    row.addEventListener('focusout', () => lightArea(null));
    row.onclick = (e) => { if (!e.target.closest('button')) flyToArea(f.id); };
    el.fieldList.appendChild(row);
  });
  syncOverview();
}

/* What the sheet holds, counted the way each row counts itself. */
function renderTally() {
  const n = state.fields.length;
  el.fieldTally.hidden = !n;
  if (!n) { el.fieldTally.innerHTML = ''; return; }
  const ha = state.fields.reduce((sum, f) => sum + area(f.ring), 0) / 10000;
  const marks = state.fields.reduce((sum, f) => sum + marksOf(f).length, 0);
  el.fieldTally.innerHTML =
    '<div><dd>' + n + '</dd><dt>' + tr('unit.areas', { n }) + '</dt></div>' +
    '<div><dd>' + formatHa(ha) + '</dd><dt>' + tr('unit.haAll') + '</dt></div>' +
    (marks ? '<div><dd>' + marks + '</dd><dt>' + tr('unit.marks', { n: marks }) + '</dt></div>' : '');
}

/* ------------------------------------------------ the overview, wide screens */

/* A desk has the room a field does not: the ledger down the left, and every
 * area on the ground beside it. It is a second, separate Leaflet map because
 * the working one belongs to drawing and tracking and carries their state.
 * It is only ever built once the screen is wide enough to show it, so a phone
 * never asks for a tile it would not draw. */
const WIDE = window.matchMedia('(min-width: 1024px) and (min-height: 540px)');
const OV_REST = { color: '#ffffff', weight: 2.5, opacity: 0.95, fillColor: '#000000',
                  fillOpacity: 0.14, lineJoin: 'miter' };
const OV_LIT = { weight: 4.5, opacity: 1, fillOpacity: 0.34 };
let overview = null, overviewTiles = null, overviewKey = '';
const overviewShapes = new Map();

function syncOverview() {
  const on = WIDE.matches && state.screen === 'fields' && state.fields.length > 0;
  el.scrFields.classList.toggle('has-overview', on);
  el.overview.hidden = !on;
  if (!on) return;

  if (!overview) {
    overview = L.map('overview', { zoomControl: false, attributionControl: true, tap: false });
    L.control.zoom({ position: 'topright' }).addTo(overview);
    if (window.ResizeObserver) {
      new ResizeObserver(() => overview.invalidateSize({ animate: false })).observe(el.overview);
    }
  }
  overview.invalidateSize(false);

  const layer = state.settings.layer;
  if (!overviewTiles || overviewTiles.key !== layer) {
    if (overviewTiles) overview.removeLayer(overviewTiles.tiles);
    overviewTiles = {
      key: layer,
      tiles: L.tileLayer(TILES[layer].url, {
        attribution: TILES[layer].attribution, maxZoom: TILES[layer].maxZoom,
        crossOrigin: 'anonymous', referrerPolicy: TILES[layer].referrerPolicy || false,
      }).addTo(overview),
    };
  }

  overviewShapes.forEach((s) => { s.poly.remove(); s.label.remove(); });
  overviewShapes.clear();
  const bounds = L.latLngBounds([]);
  state.fields.forEach((f) => {
    const poly = L.polygon(f.ring, OV_REST).addTo(overview);
    const c = centroid(f.ring);
    const label = L.marker(c, {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'ov-label', iconSize: [0, 0],
                        html: '<span>' + escapeHtml(f.name) + '</span>' }),
    }).addTo(overview);
    poly.on('mouseover', () => lightArea(f.id));
    poly.on('mouseout', () => lightArea(null));
    poly.on('click', () => {
      const row = el.fieldList.querySelector('[data-id="' + CSS.escape(f.id) + '"]');
      if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        row.querySelector('.area-go').focus({ preventScroll: true });
      }
    });
    overviewShapes.set(f.id, { poly, label });
    bounds.extend(poly.getBounds());
  });

  // Frame the whole sheet when what is on it changes, and leave the view alone
  // when it does not, so renaming an area does not throw away where you looked.
  const key = state.fields.map((f) => f.id + ':' + f.ring.length + ':' + f.ring[0]).join('|');
  if (key !== overviewKey && bounds.isValid()) {
    overviewKey = key;
    overview.fitBounds(bounds, { padding: [64, 64], maxZoom: 17, animate: false });
  }
}

function lightArea(id) {
  overviewShapes.forEach((s, key) => {
    const lit = key === id;
    s.poly.setStyle(lit ? Object.assign({}, OV_REST, OV_LIT) : OV_REST);
    if (lit) s.poly.bringToFront();
    const node = s.label.getElement();
    if (node) node.classList.toggle('is-lit', lit);
  });
  el.fieldList.querySelectorAll('.area').forEach((row) => {
    row.classList.toggle('is-lit', row.dataset.id === id);
  });
}

function flyToArea(id) {
  const s = overviewShapes.get(id);
  if (!s || el.overview.hidden) return;
  overview.flyToBounds(s.poly.getBounds(), { padding: [80, 80], maxZoom: 18, duration: 0.6 });
}

WIDE.addEventListener('change', syncOverview);

function fieldMenu(f) {
  const marks = marksOf(f).length;
  sheet(f.name, [
    { label: tr('fm.marks'), icon: 'mark',
      sub: marks ? tr('fm.marksSub', { n: marks }) : tr('fm.marksNone'),
      run: () => marksSheet(f) },
    { label: tr('fm.edit'), icon: 'edit', sub: tr('fm.editSub'), run: () => startEdit(f) },
    { label: tr('fm.rename'), icon: 'rename', run: () => {
      askText({ title: tr('fm.renameTitle'), label: tr('name.label'), value: f.name,
                ok: tr('fm.saveName') },
        (name) => { f.name = name; saveFields(); render(); });
    } },
    { label: tr('fm.geojson'), icon: 'export',
      sub: tr(marks ? 'fm.geojsonSubMarks' : 'fm.geojsonSub'),
      run: () => download(f.name + '.geojson', toGeoJSON(f.name, f.ring, f.marks),
                          'application/geo+json') },
    { label: tr('fm.kml'), icon: 'export', sub: tr('fm.kmlSub'),
      run: () => download(f.name + '.kml', toKML(f.name, f.ring),
                          'application/vnd.google-earth.kml+xml') },
    { label: tr('fm.delete'), icon: 'clear', danger: true, run: () => {
      askConfirm({ title: tr('fm.deleteTitle', { name: f.name }), ok: tr('fm.deleteOk'),
                   keep: tr('da.keep', { n: 1 }),
                   notes: [(marks ? tr('fm.deleteMarks', { n: marks }) : '') +
                           tr('common.noUndo')] }, () => {
        state.fields = state.fields.filter((x) => x.id !== f.id);
        saveFields();
        render();
      });
    } },
  ]);
}

/* ---------------------------------------------------------------- theme */

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const label = tr('theme.' + t);
  el.btnTheme.setAttribute('aria-label', label);
  el.btnTheme.title = label;
  el.btnTheme.querySelector('use').setAttribute('href', '#i-theme-' + t);
}

/* ---------------------------------------------------------------- language */

/* The words written into index.html are the English ones, so the page reads
 * right before this script runs. Each carries its key: data-i18n for text,
 * data-i18n-html where it holds markup, data-i18n-aria for a label read aloud. */
function applyStaticText() {
  document.documentElement.lang = getLang();
  document.title = tr('doc.title');
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = tr(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach((n) => { n.innerHTML = tr(n.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-aria]').forEach((n) => {
    n.setAttribute('aria-label', tr(n.dataset.i18nAria));
  });
  el.langSwitch.querySelectorAll('[data-lang]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.lang === getLang()));
  });
  syncRadioGroup(el.langSwitch);
}

/* Everything on the glass says itself again. A sheet is modal over the header,
 * so none can be up while the switch is pressed; toasts are left to expire. */
function applyLang() {
  applyStaticText();
  applyTheme();
  syncMuteButton();
  renderGaugeScale();
  if (map) applyLayer();
  if (state.screen === 'fields') el.title.textContent = tr('title.areas');
  if (state.screen === 'settings') { el.title.textContent = tr('title.settings'); renderSettings(); }
  if (state.mode === 'edit' && !state.editing) el.title.textContent = tr('title.newArea');
  if (state.mode === 'edit') { redrawShape(); syncWalk(); }
  if (state.tracking && state.tracking.view) state.tracking.view();
  if (moving) syncMoveBar();
  syncMarksButton();
  redrawMarks();
  render();
}

el.langSwitch.querySelectorAll('[data-lang]').forEach((b) => {
  b.onclick = () => {
    if (!LANGS.includes(b.dataset.lang) || b.dataset.lang === getLang()) return;
    state.settings.lang = setLang(b.dataset.lang);
    saveSettings();
    applyLang();
  };
});

/* The quality filter, in words rather than a number: what it will refuse. */
function renderGate() {
  const gate = state.settings.accGate;
  document.querySelectorAll('.segmented [data-gate]').forEach((b) => {
    b.setAttribute('aria-checked', String(Number(b.dataset.gate) === gate));
    syncRadioGroup(b.parentNode);
  });
  el.gateNote.textContent = tr('gate.' + ([0, 50, 30, 15].includes(gate) ? gate : 30));
}

/* These are role="radio" buttons, so Enter and Space already worked. What was
 * missing is the rest of the pattern: a radiogroup is a single tab stop, and
 * the arrow keys move the choice inside it. Without that, reaching the last
 * option means tabbing through every one before it. */
function syncRadioGroup(group) {
  const buttons = [...group.querySelectorAll('[role="radio"]')];
  const chosen = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  buttons.forEach((b, i) => b.tabIndex = i === (chosen < 0 ? 0 : chosen) ? 0 : -1);
}

document.querySelectorAll('[role="radiogroup"]').forEach((group) => {
  group.addEventListener('keydown', (e) => {
    const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    const step = keys[e.key];
    if (!step) return;
    e.preventDefault();
    const buttons = [...group.querySelectorAll('[role="radio"]')];
    const here = buttons.indexOf(document.activeElement);
    const next = buttons[(here + step + buttons.length) % buttons.length];
    next.focus();
    next.click();   // arrowing onto an option selects it, as radios do
  });
});

function syncMuteButton() {
  const muted = state.settings.muted;
  el.muteName.textContent = tr(muted ? 'panel.unmute' : 'panel.mute');
  el.btnMute.querySelector('use').setAttribute('href', muted ? '#i-sound-off' : '#i-sound');
}

async function renderSettings() {
  el.bufferRange.value = state.settings.buffer;
  el.bufferValue.innerHTML = state.settings.buffer + '<span class="unit">m</span>';
  el.chkAwake.checked = state.settings.keepAwake;
  el.chkMuted.checked = state.settings.muted;
  el.vibNote.hidden = alerts.canVibrate;
  renderGate();
  applyTheme();
  el.storeInfo.textContent = await storageNote();
  el.tileInfo.textContent = await tileCacheInfo();
}

/* ----------------------------------------------------------------- wiring */

el.btnBack.onclick = () => {
  if (state.tracking) { stopTracking(); return; }
  if (state.mode === 'edit' && state.draft && state.draft.ring.length) {
    const editing = !!state.editing;
    askConfirm({ title: tr(editing ? 'discard.titleEdit' : 'discard.titleNew'),
                 ok: tr('discard.ok'), keep: tr('discard.keep'),
                 notes: [tr(editing ? 'discard.noteEdit' : 'discard.noteNew')] },
      () => show('fields'));
    return;
  }
  show('fields');
};
el.btnSettings.onclick = () => show('settings');
el.btnDraw.onclick = () => startEdit(null);
el.btnImport.onclick = () => el.fileInput.click();
el.fileInput.onchange = (e) => {
  if (e.target.files[0]) handleImport(e.target.files[0]);
  e.target.value = '';
};

el.btnUndo.onclick = undoLast;
el.btnClear.onclick = () => {
  if (!state.draft.ring.length) return;
  pushUndo();
  state.draft.ring = [];
  state.draft.acc = [];
  redrawShape();
  toast(tr('toast.cleared'), tr('common.undo'), undoLast);
};
el.btnWalk.onclick = () => { if (state.walking) stopWalk(); else startWalk(); };
el.btnCorner.onclick = dropCorner;
el.btnLocate.onclick = () => locateMe(true);
el.btnLayer.onclick = () =>
  setLayer(state.settings.layer === 'satellite' ? 'street' : 'satellite');
el.btnOffline.onclick = downloadOffline;
el.btnCancelEdit.onclick = () => el.btnBack.onclick();
el.btnSaveEdit.onclick = saveEdit;

el.btnMark.onclick = dropMark;
el.btnRecentre.onclick = recentre;
el.btnLastMark.onclick = () => {
  const f = trackedField();
  const m = f ? lastMarkOf(f) : null;
  if (m) markSheet(f, m);
};
el.btnMovePlace.onclick = placeMove;
el.btnMoveCancel.onclick = () => {
  if (!moving) return;
  const mark = moving.mark;
  endMove();
  toast(tr('toast.markLeft', { n: mark.n }));
};
el.btnMarks.onclick = () => { const f = trackedField(); if (f) marksSheet(f); };
el.btnStop.onclick = stopTracking;
el.btnMute.onclick = () => {
  state.settings.muted = !state.settings.muted;
  saveSettings();
  alerts.setMuted(state.settings.muted);
  syncMuteButton();
};

el.bufferRange.oninput = () => {
  state.settings.buffer = Number(el.bufferRange.value);
  el.bufferValue.innerHTML = state.settings.buffer + '<span class="unit">m</span>';
  saveSettings();
  renderGaugeScale();
};
el.chkAwake.onchange = () => { state.settings.keepAwake = el.chkAwake.checked; saveSettings(); };
el.chkMuted.onchange = () => {
  state.settings.muted = el.chkMuted.checked;
  saveSettings();
  alerts.setMuted(state.settings.muted);
  syncMuteButton();
};
document.querySelectorAll('[data-preview]').forEach((b) => {
  b.onclick = async () => { await alerts.unlock(); alerts.preview(b.dataset.preview); };
});
el.btnTheme.onclick = () => {
  const themes = ['auto', 'light', 'dark'];
  state.settings.theme = themes[(themes.indexOf(state.settings.theme) + 1) % themes.length];
  saveSettings();
  applyTheme();
};
document.querySelectorAll('.segmented [data-gate]').forEach((b) => {
  b.onclick = () => {
    state.settings.accGate = Number(b.dataset.gate);
    saveSettings();
    renderGate();
  };
});
el.metaStrip.onclick = gpsSheet;
el.gauge.onclick = gaugeSheet;
el.btnBackup.onclick = backupAll;
el.btnRestore.onclick = () => el.restoreInput.click();
el.restoreInput.onchange = (e) => {
  if (e.target.files[0]) restoreAll(e.target.files[0]);
  e.target.value = '';
};
el.btnClearTiles.onclick = async () => {
  await caches.delete('fb-tiles-v1');
  toast(tr('toast.tilesCleared'));
  renderSettings();
};

/* The custom Back button asks before discarding a drawing. The phone's own Back
 * gesture used to bypass it entirely and leave the page, so the map screen
 * pushes a history entry, and Back is caught here and routed through the same
 * question. */
function guardHistory() {
  history.pushState({ fb: 'screen' }, '');
}

window.addEventListener('popstate', () => {
  if (state.screen === 'fields') return;      // nothing of ours left to leave
  guardHistory();                             // stay put while we ask
  // Back closes a question that is up, as it closes any dialog, rather than
  // stacking the same question on top of itself.
  if (!el.sheet.hidden) { closeSheet(); return; }
  el.btnBack.onclick();
});

window.addEventListener('beforeunload', (e) => {
  const drawing = state.mode === 'edit' && state.draft && state.draft.ring.length;
  if (state.tracking || state.walking || drawing) { e.preventDefault(); e.returnValue = ''; }
});

/* -------------------------------------------------------------- start up */

applyStaticText();
applyTheme();
requestPersistence();
renderGaugeScale();
syncMuteButton();
// The privacy page links back to Settings as index.html#settings. Open it, then
// drop the hash so a reload lands on the areas as usual.
if (location.hash === '#settings') {
  history.replaceState(null, '', location.pathname + location.search);
  show('settings');
} else {
  show('fields');
}

// A toast would be gone in six seconds, and this one decides whether the
// positions you are about to trust are any good. Say it properly, once.
if (isFirefoxAndroid() && !localStorage.getItem('fb.browserSeen')) {
  localStorage.setItem('fb.browserSeen', '1');
  browserSheet();
}

if ('serviceWorker' in navigator) {
  offlineState = 'starting';
  navigator.serviceWorker.register('./sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => { offlineState = 'ready'; })
    .catch((e) => { offlineState = 'failed:' + (e && e.message ? e.message : 'unknown'); });
}
