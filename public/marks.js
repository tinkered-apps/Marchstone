/* marks.js: the points you drop where you are standing.
 *
 * A boundary is surveyed once and answered against for hours. A mark is the
 * opposite: noticed in passing, recorded in a second, and never any better
 * than the fix that recorded it. So a mark carries the accuracy it was taken
 * at, and the app never shows one without it, a point without its error bar
 * is a claim this app has not earned.
 *
 * No DOM in here, so what a mark is can be checked without standing in a field.
 */

import { haversine, formatLength } from './geo.js';
import { ageLabel } from './track.js';
import { t } from './i18n.js';

/* Past ten seconds the panel already refuses to stand behind a reading. A mark
 * cut from one that old is still worth having, you are at the tree now, but
 * it is recorded as what it is rather than passed off as where you are. */
export const STALE_MS = 10000;

/* Labels are for reading, not for storing an essay in. */
export const MAX_LABEL = 60;

/* Numbers grow. Deleting the last one hands its number back, which is what
 * anyone who has just mis-tapped expects; deleting from the middle leaves the
 * gap, because by then #7 is painted on a tree. */
export function nextNumber(marks) {
  return (marks || []).reduce((n, m) => Math.max(n, Number(m.n) || 0), 0) + 1;
}

/* fix is the live reading: { lat, lng, acc, at }, where at is when the
 * receiver measured it, not when we asked. */
export function makeMark(fix, marks, now) {
  const n = nextNumber(marks);
  return {
    id: 'm' + now + '-' + n,
    n,
    label: '',
    lat: fix.lat,
    lng: fix.lng,
    acc: Number.isFinite(fix.acc) ? fix.acc : null,
    at: now,
    age: Number.isFinite(fix.at) ? Math.max(0, now - fix.at) : null,
  };
}

export function isStale(mark) {
  return Number.isFinite(mark.age) && mark.age > STALE_MS;
}

/* ------------------------------------------------------------ moved by hand
 *
 * A mark is dropped where the phone thinks you are standing, and the phone is
 * routinely wrong by more than the tree is wide. On imagery you can often see
 * the thing itself, so the disc can be dragged onto it, and that is not the
 * fix getting better, it is a different kind of claim altogether. The error is
 * now the imagery's and your eye's, and neither of those hands out a ±.
 *
 * So a hand-placed mark stops offering an accuracy at all. The one it was
 * dropped at is kept, because it is still true about the fix, but it is no
 * longer allowed to describe the point. Where the fix put it is kept too, so
 * the hand can always be taken back off. */

export function isHandPlaced(mark) {
  return !!mark && mark.placed === 'hand';
}

export function handPlace(mark, lat, lng) {
  const fix = Array.isArray(mark.fix) && mark.fix.length === 2
    ? mark.fix
    : [mark.lat, mark.lng];
  return { lat, lng, fix, placed: 'hand' };
}

/* Back to the fix, never to the previous hand: a second drag corrects the
 * first, so there is nothing between here and the reading to return to. */
export function putBack(mark) {
  if (!isHandPlaced(mark) || !Array.isArray(mark.fix)) return null;
  return { lat: mark.fix[0], lng: mark.fix[1], fix: null, placed: null };
}

/* How far the hand took it from where the fix had it, the one figure that
 * catches a disc dragged onto the wrong tree. */
export function handOffset(mark) {
  if (!isHandPlaced(mark) || !Array.isArray(mark.fix)) return null;
  return haversine(mark.fix, [mark.lat, mark.lng]);
}

export function markTitle(mark) {
  const label = typeof mark.label === 'string' ? mark.label.trim() : '';
  return label || t('mark.title', { n: mark.n });
}

export function cleanLabel(text) {
  return typeof text === 'string' ? text.trim().slice(0, MAX_LABEL) : '';
}

/* Local clock, zero-padded, because "14:32" is what a field book says and it
 * reads the same in every language the phone might be set to. */
export function clockTime(at) {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* The line under a mark's name. Accuracy first, always: it is the one thing
 * that decides whether the mark is worth walking back to. */
export function markDetail(mark, from) {
  const parts = [];
  if (isHandPlaced(mark)) {
    parts.push(t('mark.byHand'));
    const off = handOffset(mark);
    if (Number.isFinite(off) && off >= 1) parts.push(t('mark.fromItsFix', { d: formatLength(off) }));
  } else {
    parts.push(Number.isFinite(mark.acc) ? '±' + Math.round(mark.acc) + ' m' : t('mark.noAcc'));
    if (isStale(mark)) parts.push(t('toast.fromFix', { age: ageLabel(mark.age) }));
  }
  if (from) parts.push(t('mark.away', { d: formatLength(haversine(from, [mark.lat, mark.lng])) }));
  const clock = clockTime(mark.at);
  if (clock) parts.push(clock);
  return parts.join(' · ');
}

/* What a mark says about itself when it leaves for another program. */
export function markNote(mark) {
  if (isHandPlaced(mark)) {
    const said = [t('mark.noteHand')];
    const off = handOffset(mark);
    if (Number.isFinite(off)) said.push(t('mark.noteMoved', { d: formatLength(off) }));
    if (Number.isFinite(mark.acc)) said.push(t('mark.noteFixRead', { acc: Math.round(mark.acc) }));
    return said.join(', ');
  }
  const parts = [Number.isFinite(mark.acc)
    ? t('mark.noteAcc', { acc: Math.round(mark.acc) })
    : t('mark.noteNoAcc')];
  if (isStale(mark)) parts.push(t('mark.noteOld', { age: ageLabel(mark.age) }));
  return parts.join(', ');
}

/* Marks arrive back from a file somebody may have edited, so they come in
 * through here: anything without a real position on Earth is dropped rather
 * than drawn at latitude NaN, and a repeated number is given a fresh one so no
 * two discs on the map claim to be the same mark. */
export function cleanMarks(raw, now) {
  if (!Array.isArray(raw)) return [];
  const stamp = Number.isFinite(now) ? now : Date.now();
  const out = [];
  const taken = new Set();
  raw.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const lat = Number(m.lat), lng = Number(m.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    let n = Math.floor(Number(m.n));
    if (!Number.isFinite(n) || n < 1 || taken.has(n)) n = nextNumber(out);
    taken.add(n);
    const clean = {
      id: 'm' + stamp + '-' + i,
      n,
      label: cleanLabel(m.label),
      lat,
      lng,
      acc: Number.isFinite(Number(m.acc)) ? Number(m.acc) : null,
      at: Number.isFinite(Number(m.at)) ? Number(m.at) : null,
      age: Number.isFinite(Number(m.age)) ? Number(m.age) : null,
    };
    // A hand comes back as a hand. Losing that on the way through a file would
    // hand a ± back to a point that has not been near a satellite, which is
    // the one thing this app must never do quietly.
    if (m.placed === 'hand') {
      clean.placed = 'hand';
      const f = Array.isArray(m.fix) ? [Number(m.fix[0]), Number(m.fix[1])] : null;
      clean.fix = f && Number.isFinite(f[0]) && Number.isFinite(f[1]) &&
                  Math.abs(f[0]) <= 90 && Math.abs(f[1]) <= 180 ? f : null;
    }
    out.push(clean);
  });
  return out;
}
