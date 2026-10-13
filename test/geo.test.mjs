import { evaluate, area, perimeter, formatArea, formatLength, formatHa, formatAcres,
         groupNumber, haversine,
         validateRing, dedupe, extent, selfIntersects } from '../public/geo.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A ~200 m square near Warsaw. 1 deg lat = 111320 m; 1 deg lng = 68550 m at 52N.
const LAT = 52.0, LNG = 21.0;
const dLat = 200 / 111320;
const dLng = 200 / (111320 * Math.cos(52 * Math.PI / 180));
const square = [[LAT, LNG], [LAT + dLat, LNG], [LAT + dLat, LNG + dLng], [LAT, LNG + dLng]];

const at = (northM, eastM) => [LAT + northM / 111320, LNG + eastM / (111320 * Math.cos(52 * Math.PI / 180))];

console.log('geometry');
const centre = evaluate(at(100, 100), square, 5);
ok('centre is inside', centre.status === 'inside' && centre.inside, JSON.stringify(centre));
ok('centre is 100 m from the nearest edge', near(centre.distance, 100, 0.5), centre.distance);

const nearEdge = evaluate(at(100, 3), square, 5);
ok('3 m inside the west edge reads as border', nearEdge.status === 'border', JSON.stringify(nearEdge));
ok('  ...and still counts as geometrically inside', nearEdge.inside === true);

const justOut = evaluate(at(100, -3), square, 5);
ok('3 m outside the west edge reads as border', justOut.status === 'border', JSON.stringify(justOut));
ok('  ...and counts as geometrically outside', justOut.inside === false);
ok('  ...with a negative signed distance', justOut.signed < 0);

const wayOut = evaluate(at(100, -60), square, 5);
ok('60 m outside reads as outside', wayOut.status === 'outside', JSON.stringify(wayOut));
ok('60 m outside measures ~60 m', near(wayOut.distance, 60, 0.5), wayOut.distance);

const beyondCorner = evaluate(at(-30, -40), square, 5);
ok('past a corner measures to the corner, not the edge line',
   near(beyondCorner.distance, 50, 0.5), beyondCorner.distance);

const tight = evaluate(at(100, 3), square, 2);
ok('a 2 m buffer leaves the same point clear of the border', tight.status === 'inside', JSON.stringify(tight));

const wide = evaluate(at(100, -8), square, 10);
ok('a 10 m buffer catches a point 8 m out', wide.status === 'border', JSON.stringify(wide));

console.log('measurement');
ok('area of the 200 m square is ~40000 m2', near(area(square), 40000, 40), area(square));
ok('perimeter is ~800 m', near(perimeter(square), 800, 1), perimeter(square));
ok('area formats in hectares and acres', formatArea(40000) === '4.00 ha (9.88 ac)', formatArea(40000));
ok('a small area is left ungrouped', formatHa(4) === '4.00' && formatAcres(4) === '9.88');
ok('a sub-hectare area keeps three places', formatHa(0.082) === '0.082');
ok('a four-digit figure is left alone', groupNumber(1017.02, 2) === '1017.02');
ok('from five digits, figures group in threes',
   groupNumber(4787134, 2) === '4\u00A0787\u00A0134.00', groupNumber(4787134, 2));
ok('grouping never touches the decimals', groupNumber(12345.6789, 2) === '12\u00A0345.68');
ok('a whole number with no decimals groups too', groupNumber(1234567, 0) === '1\u00A0234\u00A0567');
ok('a huge area reads in groups in both units',
   formatArea(4.787134e10) === '4\u00A0787\u00A0134.00 ha (11\u00A0829\u00A0486.83 ac)', formatArea(4.787134e10));
ok('a long distance groups its kilometres',
   formatLength(12345678) === '12\u00A0345.68 km', formatLength(12345678));
ok('a short distance stays in metres', formatLength(840) === '840 m');
ok('haversine agrees with the flat projection',
   near(haversine([LAT, LNG], at(0, 200)), 200, 0.1), haversine([LAT, LNG], at(0, 200)));

console.log('edges');
ok('fewer than 3 points returns null', evaluate([LAT, LNG], [[LAT, LNG], [LAT + dLat, LNG]], 5) === null);
ok('an empty ring returns null', evaluate([LAT, LNG], [], 5) === null);

// Winding order must not matter.
const reversed = square.slice().reverse();
const rev = evaluate(at(100, 100), reversed, 5);
ok('reversed winding still reads inside', rev.status === 'inside' && near(rev.distance, 100, 0.5));
ok('reversed winding gives the same area', near(area(reversed), area(square), 0.01));

// A concave shape: the classic case ray casting has to get right.
const L = [[LAT, LNG], [LAT + dLat, LNG], [LAT + dLat, LNG + dLng / 2],
           [LAT + dLat / 2, LNG + dLng / 2], [LAT + dLat / 2, LNG + dLng], [LAT, LNG + dLng]];
ok('concave shape: point in the notch is outside',
   evaluate(at(150, 150), L, 5).status === 'outside', JSON.stringify(evaluate(at(150, 150), L, 5)));
ok('concave shape: point in the arm is inside',
   evaluate(at(150, 50), L, 5).status === 'inside');

// Southern hemisphere / negative longitude sanity.
const south = [[-33.9, 151.2], [-33.898, 151.2], [-33.898, 151.203], [-33.9, 151.203]];
ok('works south of the equator', evaluate([-33.899, 151.2015], south, 5).status === 'inside');
ok('works south of the equator (outside)', evaluate([-33.91, 151.2015], south, 5).status === 'outside');

/* ---------------------------------------------------------- validation */

console.log('SECTION validation - checked once, at the door');

const V = (ring) => validateRing(ring);

ok('a plain square passes clean',
   V(square).fatal.length === 0 && V(square).warn.length === 0);

ok('two corners is not an area', V([[52, 21], [52.001, 21]]).fatal.length === 1);
ok('nothing at all is not an area', V(null).fatal.length === 1);

ok('a corner with no coordinates is fatal',
   V([[52, 21], [NaN, 21], [52, 21.001]]).fatal.length === 1);

ok('latitude past the pole is fatal',
   V([[52, 21], [121.5, 21], [52, 21.001]]).fatal[0].includes('off the map'));

ok('  ...and says why, because it is nearly always a lng/lat swap',
   V([[52, 21], [121.5, 21], [52, 21.001]]).fatal[0].includes('longitude'));

ok('three corners in the same spot enclose nothing',
   V([[52, 21], [52, 21], [52, 21]]).fatal.length === 1);

ok('collinear corners enclose nothing',
   V([[52, 21], [52.001, 21], [52.002, 21]]).fatal.length === 1);

// A walked perimeter that doubles back is ordinary, and must still import.
const bowtie = [at(0, 0), at(200, 200), at(200, 0), at(0, 200)];
ok('a self-crossing outline is a warning, not a refusal',
   V(bowtie).fatal.length === 0 && V(bowtie).warn.length === 1);
ok('  ...and says what it means for in and out',
   V(bowtie).warn[0].includes('swap over'));
ok('selfIntersects sees the crossing', selfIntersects(bowtie) === true);
ok('selfIntersects leaves an honest square alone', selfIntersects(square) === false);
ok('a concave but honest shape does not read as crossing', selfIntersects(L) === false);

// Duplicate corners are dropped, and said to have been dropped.
const doubled = [square[0], square[0], square[1], square[2], square[3]];
ok('a repeated corner is dropped', V(doubled).ring.length === 4, V(doubled).ring.length);
ok('  ...and mentioned', V(doubled).warn[0].includes('Dropped 1 corner'), V(doubled).warn[0]);
ok('  ...without blocking anything', V(doubled).fatal.length === 0);
ok('dedupe leaves a clean ring alone', dedupe(square).length === 4);

// A country-sized ring still works, but should not pass without comment.
const huge = [[50, 20], [56, 20], [56, 26], [50, 26]];
ok('a country-sized ring warns about its span', V(huge).warn.some((w) => w.includes('spans')));
ok('  ...but is still usable', V(huge).fatal.length === 0);
ok('extent measures the diagonal', near(extent(square), 283, 5), extent(square));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
