/* alerts.js: the noise the phone makes so you don't have to look at it.
 *
 * Four states, four deliberately different signals:
 *   inside   quiet. One soft blip when you come back in.
 *   unsure   one low tick every 7 s. Not a warning, a reminder that the app
 *            cannot see well enough to promise you are in.
 *   border   two mid beeps + a double buzz, every 1.8 s.
 *   outside  three fast high beeps + a long triple buzz, every 1.1 s.
 *
 * Repeating (rather than firing once on change) matters: if you drifted out
 * while looking at the saw, a single beep you missed is no warning at all.
 *
 * The gap between unsure and border is the point of it. Under canopy a ±12 m
 * fix can sit uncertain for an hour, and if that sounded like the border alarm
 * you would learn to ignore the border alarm. Slow and quiet says "I don't
 * know" without ever competing with the two signals that mean act now.
 */

const PATTERNS = {
  inside: { every: 0, beeps: [], freq: 520, len: 0.16, vibrate: null },
  unsure: { every: 7000, beeps: [0], freq: 400, len: 0.07, vibrate: [60], level: 0.18 },
  border: { every: 1800, beeps: [0, 200], freq: 880, len: 0.12, vibrate: [150, 100, 150] },
  outside: { every: 1100, beeps: [0, 140, 280], freq: 1320, len: 0.09, vibrate: [300, 120, 300, 120, 300] },
};

let ctx = null;
let timer = null;
let current = null;
let muted = false;

/* The API being present is not the same as the phone using it: Android can
 * have vibration switched off system-wide, and navigator.vibrate() then returns
 * false having done nothing. So the answer starts as "it says it can" and is
 * replaced by evidence the first time we actually ask it to buzz. */
export const canVibrate = typeof navigator !== 'undefined' && !!navigator.vibrate;
let vibrateWorked = null;

function buzz(pattern) {
  if (!navigator.vibrate) return;
  const accepted = navigator.vibrate(pattern);
  if (pattern) vibrateWorked = accepted !== false;
}

/* What the app can actually do right now, for the readiness sheet. */
export function readiness() {
  return {
    sound: ctx ? ctx.state === 'running' : null,
    vibrate: canVibrate ? vibrateWorked : false,
    muted,
  };
}

/* Browsers only allow audio after a real tap, so this is called from the
 * Start button rather than at load. */
export async function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx.state === 'running';
}

export function setMuted(value) {
  muted = value;
  if (muted) buzz(0);
}

export function isMuted() {
  return muted;
}

function beep(freq, len, delayMs, level) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delayMs / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, t);
  // Short ramps instead of hard starts/stops, which click on phone speakers.
  const peak = level || 0.35;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + 0.012);
  gain.gain.setValueAtTime(peak, t + len - 0.02);
  gain.gain.linearRampToValueAtTime(0, t + len);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + len + 0.02);
}

function fire(pattern) {
  if (muted) return;
  pattern.beeps.forEach((delay) => beep(pattern.freq, pattern.len, delay, pattern.level));
  if (pattern.vibrate) buzz(pattern.vibrate);
}

/* Point this at the current status on every fix. It only restarts the
 * pattern when the status actually changes, so the rhythm stays steady. */
export function setStatus(status) {
  if (status === current) return;
  current = status;
  clearInterval(timer);
  timer = null;

  const pattern = PATTERNS[status];
  if (!pattern) return;

  if (status === 'inside') {
    // A short "you're back in" chirp, then nothing.
    beep(PATTERNS.inside.freq, PATTERNS.inside.len, 0);
    buzz(80);
    return;
  }
  fire(pattern);
  timer = setInterval(() => fire(pattern), pattern.every);
}

/* Dropping a mark gets its own small noise: two rising notes and one short
 * buzz, once. Rising and never repeating is what makes it unmistakable, every
 * warning in this file is flat and says itself again.
 *
 * It goes quiet while the border or outside alarm is running. A confirmation
 * may not blunt a warning, and the vibration motor can only say one thing at a
 * time; on those two states the mark confirms itself on the screen instead. */
export function marked() {
  if (muted || current === 'border' || current === 'outside') return false;
  beep(680, 0.055, 0);
  beep(1020, 0.07, 85);
  buzz(70);
  return true;
}

export function stop() {
  clearInterval(timer);
  timer = null;
  current = null;
  buzz(0);
}

/* Used by the settings screen so you can hear each warning before you rely
 * on it in a field with a running chainsaw. */
export function preview(status) {
  const pattern = PATTERNS[status];
  if (!pattern) return;
  if (status === 'inside') {
    beep(pattern.freq, pattern.len, 0);
    buzz(80);
  } else {
    fire(pattern);
  }
}
