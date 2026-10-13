/* The safety-critical half: what the app is allowed to claim, what it throws
 * away, and when the alarm is allowed to follow the screen. */

import { fixTime, keepFix, verdict, settle, provisional, countsAsGood, ageLabel }
  from '../public/track.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
};

const NOW = 1_700_000_000_000;
const LAT = 52.0, LNG = 21.0;
const east = (m) => LNG + m / (111320 * Math.cos(52 * Math.PI / 180));

/* ------------------------------------------------------------- fix time */

console.log('fix time: measurement, not delivery');

ok('an ordinary timestamp is taken as measured',
   fixTime({ timestamp: NOW - 3000 }, NOW) === NOW - 3000);

ok('a position cached four minutes ago reads as four minutes old',
   fixTime({ timestamp: NOW - 240000 }, NOW) === NOW - 240000);

ok('a monotonic clock reading falls back to arrival',
   fixTime({ timestamp: 8421 }, NOW) === NOW);

ok('a wildly wrong device clock falls back to arrival',
   fixTime({ timestamp: NOW - 86400000 }, NOW) === NOW);

ok('a timestamp from the future never reads fresher than arrival',
   fixTime({ timestamp: NOW + 60000 }, NOW) === NOW);

ok('a missing timestamp falls back to arrival',
   fixTime({}, NOW) === NOW);

ok('a zero timestamp falls back to arrival',
   fixTime({ timestamp: 0 }, NOW) === NOW);

/* ------------------------------------------------------------ quality gate */

console.log('\nquality gate: is that a position at all?');

const prev = { lat: LAT, lng: LNG, acc: 6, at: NOW, bestAcc: 4 };

ok('the first fix is always kept', keepFix({ lat: LAT, lng: LNG, acc: 400, at: NOW }, null, 30) === null);

ok('a fix measured before the last one is dropped',
   keepFix({ lat: LAT, lng: LNG, acc: 5, at: NOW - 2000 }, prev, 30) === 'stale');

ok('a mast guess is dropped',
   keepFix({ lat: LAT, lng: LNG, acc: 400, at: NOW + 2000 }, prev, 30) === 'vague');

ok('a fix inside the gate is kept',
   keepFix({ lat: LAT, lng: LNG, acc: 25, at: NOW + 2000 }, prev, 30) === null);

ok('the gate follows the phone: a receiver that never beats 25 m keeps its 40 m fixes',
   keepFix({ lat: LAT, lng: LNG, acc: 40, at: NOW + 2000 },
           { lat: LAT, lng: LNG, acc: 30, at: NOW, bestAcc: 25 }, 30) === null);

ok('the gate off keeps everything short of a teleport',
   keepFix({ lat: LAT, lng: LNG, acc: 400, at: NOW + 2000 }, prev, 0) === null);

ok('a jump no walker could make is dropped',
   keepFix({ lat: LAT, lng: east(300), acc: 6, at: NOW + 1000 }, prev, 30) === 'teleport');

ok('  ...but the same jump is kept when the new fix is the sharper one',
   keepFix({ lat: LAT, lng: east(300), acc: 2, at: NOW + 1000 }, prev, 30) === null);

ok('a walkable step is kept',
   keepFix({ lat: LAT, lng: east(8), acc: 6, at: NOW + 2000 }, prev, 30) === null);

ok('after fifteen seconds of nothing, a poor fix beats no fix',
   keepFix({ lat: LAT, lng: LNG, acc: 400, at: NOW + 20000 }, prev, 30) === null);

/* ---------------------------------------------------------------- verdict */

console.log('\nverdict: uncertainty removes the reassurance, never the warning');

const inside = (d) => ({ status: 'inside', inside: true, distance: d, signed: d });
const outside = (d) => ({ status: 'outside', inside: false, distance: d, signed: -d });
const border = (d) => ({ status: 'border', inside: true, distance: d, signed: d });

ok('a sharp fix well inside says inside',
   verdict(inside(50), 6).status === 'inside');

ok('a fix wider than its distance to the edge stops saying inside',
   verdict(inside(12), 40).status === 'unsure');

ok('  ...and is marked uncertain',
   verdict(inside(12), 40).uncertain === true);

ok('  ...while remembering what the geometry said',
   verdict(inside(12), 40).would === 'inside');

ok('a vague fix outside still says outside',
   verdict(outside(12), 40).status === 'outside');

ok('  ...and is still marked uncertain, so the screen can say why',
   verdict(outside(12), 40).uncertain === true);

ok('a sharp fix outside says outside plainly',
   verdict(outside(50), 6).uncertain === false);

ok('the border band is never made uncertain, it already says "too close to tell"',
   verdict(border(2), 40).status === 'border' && verdict(border(2), 40).uncertain === false);

ok('accuracy exactly equal to the distance is not yet uncertain',
   verdict(inside(20), 20).status === 'inside');

/* -------------------------------------------------------------- readiness */

console.log('\nreadiness: the first fixes are the worst ones');

ok('one fix in is still provisional', provisional(1) === true);
ok('three fixes in is settled', provisional(3) === false);
ok('a ±20 m fix counts toward readiness', countsAsGood(20) === true);
ok('a ±400 m mast guess does not', countsAsGood(400) === false);

/* --------------------------------------------------------------- the alarm */

console.log('\nthe alarm lags the screen, except where it must not');

const fresh = { status: null, candidate: null, since: 0 };

ok('the first status sounds at once', settle(fresh, 'inside', NOW).changed === true);

const held = { status: 'inside', candidate: 'inside', since: NOW };
const step1 = settle(held, 'border', NOW + 100);
ok('a new status does not sound immediately', step1.changed === false);
ok('  ...and the screen status is left alone', step1.status === 'inside');

ok('  ...but it sounds once it has held for a second and a half',
   settle(step1, 'border', NOW + 1700).changed === true);

ok('jitter on the line never settles',
   settle(settle(settle(held, 'border', NOW + 100), 'inside', NOW + 900),
          'border', NOW + 1400).changed === false);

ok('crossing out sounds at once, with no hold',
   settle(held, 'outside', NOW + 50).changed === true);

ok('an unchanged status does not re-fire',
   settle(held, 'inside', NOW + 9000).changed === false);

ok('unsure is held like any other status',
   settle(held, 'unsure', NOW + 100).changed === false);

ok('  ...and then sounds',
   settle(settle(held, 'unsure', NOW + 100), 'unsure', NOW + 1700).changed === true);

/* -------------------------------------------------------------- fix age */

console.log('\nfix age reads plainly');

ok('a fresh fix reads "now"', ageLabel(600) === 'now');
ok('seconds while that is useful', ageLabel(12000) === '12 s');
ok('minutes once it is frightening', ageLabel(240000) === '4 min');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
