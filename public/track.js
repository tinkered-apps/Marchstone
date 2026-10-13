/* track.js: the judgements behind the tracking screen.
 *
 * No DOM, no globals, no timers. Everything here is a pure function of a
 * position and what came before it, so the decisions that decide whether you
 * cut the neighbour's timber can be tested without standing in a field.
 *
 * The rule the uncertainty states follow, and the reason this file exists:
 *
 *   a fix too vague to answer the question removes the reassurance,
 *   never the warning.
 *
 * So a ±40 m fix 12 m inside the line stops being green and starts ticking:
 * it does not know that you are in. The same fix 12 m outside stays red and
 * keeps its alarm, because that is the one you have to act on, and a warning
 * you did not need costs you a pause.
 */

import { haversine } from './geo.js';
import { t } from './i18n.js';

export const READY_FIXES = 3;        // usable fixes before the reading stops being provisional
export const HOLD_MS = 1500;         // a new status must persist this long before the alarm follows
export const ACC_WARN = 10;          // metres, above this the in/out call is shaky
export const ACC_NETWORK = 60;       // metres, past this it is not satellites at all
export const STARVED_MS = 15000;     // no fix this long and we stop being fussy about quality
export const MAX_SPEED = 20;         // m/s, quicker than this between fixes is the phone guessing
export const MAX_SKEW_MS = 3600000;  // clock disagreement past this is a broken clock, not an old fix

/* ------------------------------------------------------------ when it was

 * position.timestamp is the receiver's own clock, and it is the only honest
 * basis for a fix age. Arrival time cannot tell a fresh position from one the
 * browser cached four minutes ago and handed over unchanged, which is exactly
 * the failure this app must never present as current.
 *
 * Two things make the timestamp useless: a browser reporting a monotonic clock
 * reading instead of epoch milliseconds, and a device clock that is simply
 * wrong. Both show up as a wild disagreement with arrival, so fall back to
 * arrival there. And a timestamp from the future never reads as fresher than
 * the moment it turned up. */
export function fixTime(pos, arrivedAt) {
  const t = pos && pos.timestamp;
  if (!Number.isFinite(t) || t <= 0) return arrivedAt;
  if (Math.abs(arrivedAt - t) > MAX_SKEW_MS) return arrivedAt;
  return Math.min(t, arrivedAt);
}

/* ----------------------------------------------------------- is it a fix?

 * Not every position is a position. With no satellite lock a phone will
 * happily hand back a guess from wifi and phone masts, hundreds of metres
 * wide, in the same shape of object as a real fix.
 *
 *   fix    { lat, lng, acc, at }        at is measurement time, from fixTime
 *   prev   { lat, lng, acc, at, bestAcc } or null for the first one
 *   gate   the Position quality setting, metres, or 0 for off
 *
 * Returns null to keep it, or a short reason to throw it away. */
export function keepFix(fix, prev, gate) {
  if (!prev) return null;

  // Measured before the fix it follows: it can say nothing new, and letting it
  // through would run the age clock backwards.
  if (fix.at < prev.at) return 'stale';

  // Past the starvation point a poor position beats none, and the accuracy
  // warning on screen does the honest work instead.
  if (fix.at - prev.at > STARVED_MS) return null;

  // Too vague to be satellites. The threshold follows the phone rather than a
  // fixed number: a receiver that has managed ±4 m today has no business
  // reporting ±60 m, while one that never beats ±25 m is simply what it is.
  if (gate && fix.acc > Math.max(gate, prev.bestAcc * 1.8)) return 'vague';

  // Teleported further than a person can walk, and no more precise for it.
  const seconds = Math.max(1, (fix.at - prev.at) / 1000);
  const reach = fix.acc + prev.acc + MAX_SPEED * seconds;
  if (fix.acc >= prev.acc && haversine([prev.lat, prev.lng], [fix.lat, fix.lng]) > reach) {
    return 'teleport';
  }

  return null;
}

/* ------------------------------------------------------- what it may claim

 * Takes the geometric result from evaluate() and the accuracy of the fix that
 * produced it, and decides what the screen is allowed to say.
 *
 * "unsure" is a fourth state and it is deliberately not a colour of the
 * answer: neither green nor amber nor red, because it is not an answer. On the
 * border the app is already saying "too close to tell", so uncertainty adds
 * nothing there and would only leave the strip permanently on. */
export function verdict(result, accuracy) {
  if (!result) return null;
  if (result.status === 'border') return { status: 'border', uncertain: false, would: 'border' };

  const uncertain = Number.isFinite(accuracy) && accuracy > result.distance;
  if (result.status === 'inside' && uncertain) {
    return { status: 'unsure', uncertain: true, would: 'inside' };
  }
  return { status: result.status, uncertain, would: result.status };
}

/* The first fixes out of a cold receiver are the worst ones it will ever give
 * you. The reading is shown from the very first one, withholding the answer
 * from someone already standing at the line helps nobody, but until a few
 * usable ones have landed it is marked as still settling. */
export function countsAsGood(acc) {
  return Number.isFinite(acc) && acc <= ACC_NETWORK;
}
export function provisional(goodFixes) {
  return goodFixes < READY_FIXES;
}

/* --------------------------------------------------------- the alarm lags

 * GPS jitter right on the edge would otherwise start and stop the beeping
 * every second until you went mad, so a new status must hold for HOLD_MS
 * before the alarm follows the screen. "outside" never waits: it is the one
 * you have to act on.
 *
 *   prev  { status, candidate, since }   status null before the first alarm
 *   next  the status the screen is showing now
 *
 * Returns the new record, with changed set when the alarm should follow. */
export function settle(prev, next, now) {
  const held = prev.candidate === next;
  const candidate = next;
  const since = held ? prev.since : now;
  const ready = prev.status === null || next === 'outside' || now - since >= HOLD_MS;

  if (ready && next !== prev.status) return { status: next, candidate, since, changed: true };
  return { status: prev.status, candidate, since, changed: false };
}

/* How old a fix reads on screen. Seconds while that is useful, then minutes,
 * because "four minutes ago" is the number that stops you trusting it. */
export function ageLabel(ms) {
  const s = Math.round(ms / 1000);
  return s < 2 ? t('age.now') : s < 90 ? s + ' s' : Math.round(s / 60) + ' min';
}
