/* Marks: what a number means, what a mark is allowed to say about itself, and
 * what survives the trip out to a file and back. */

import { nextNumber, makeMark, cleanMarks, cleanLabel, markTitle, markDetail,
         markNote, isStale, clockTime, isHandPlaced, handPlace, handOffset,
         putBack, STALE_MS, MAX_LABEL } from '../public/marks.js';
import { marksToGPX, marksToKML, marksToGeoJSON, toGeoJSON, toGeoJSONAll,
         readBoundaryFile } from '../public/io.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
};

const NOW = 1_700_000_000_000;
const LAT = 52.0, LNG = 21.0;
const fix = (over = {}) => Object.assign({ lat: LAT, lng: LNG, acc: 4, at: NOW }, over);

/* ------------------------------------------------------------- numbering */

console.log('numbering: it grows, and gives the last one back');

ok('the first mark is 1', nextNumber([]) === 1);
ok('a missing list is still 1', nextNumber(undefined) === 1);
ok('the next one follows the highest', nextNumber([{ n: 1 }, { n: 2 }, { n: 3 }]) === 4);

ok('deleting the last hands its number back',
   nextNumber([{ n: 1 }, { n: 2 }]) === 3);

ok('deleting from the middle leaves the gap, #7 is painted on a tree by now',
   nextNumber([{ n: 1 }, { n: 2 }, { n: 4 }]) === 5);

ok('an unnumbered stray does not reset the count',
   nextNumber([{ n: 3 }, {}]) === 4);

/* ------------------------------------------------------------ making one */

console.log('making a mark: it carries the fix it came from');

const m1 = makeMark(fix(), [], NOW);
ok('takes the next number', m1.n === 1);
ok('starts unlabelled', m1.label === '');
ok('keeps the position', m1.lat === LAT && m1.lng === LNG);
ok('keeps the accuracy it was taken at', m1.acc === 4);
ok('is stamped when it was dropped', m1.at === NOW);

ok('a fix measured seconds ago records that age',
   makeMark(fix({ at: NOW - 4000 }), [], NOW).age === 4000);

ok('a fresh mark is not stale', !isStale(m1));
ok('one cut from a fix older than ten seconds is',
   isStale(makeMark(fix({ at: NOW - STALE_MS - 1 }), [], NOW)));

ok('an accuracy the browser never gave is recorded as absent, not as zero',
   makeMark(fix({ acc: undefined }), [], NOW).acc === null);

ok('a clock that ran backwards never yields a negative age',
   makeMark(fix({ at: NOW + 5000 }), [], NOW).age === 0);

/* ---------------------------------------------------------------- naming */

console.log('naming: a number until you say otherwise');

ok('an unlabelled mark is its number', markTitle({ n: 7, label: '' }) === 'Mark 7');
ok('a labelled one is its label', markTitle({ n: 7, label: 'Dead oak' }) === 'Dead oak');
ok('whitespace is not a label', markTitle({ n: 7, label: '   ' }) === 'Mark 7');
ok('a label is trimmed', cleanLabel('  Dead oak  ') === 'Dead oak');
ok('a label is capped', cleanLabel('x'.repeat(200)).length === MAX_LABEL);
ok('a label that is not text at all is no label', cleanLabel(undefined) === '');

/* ------------------------------------------------------------- what it says */

console.log('what a mark says about itself: accuracy first, always');

ok('accuracy leads the line', markDetail(m1).startsWith('±4 m'));
ok('a mark with no accuracy says so rather than showing a number',
   markDetail({ n: 1, lat: LAT, lng: LNG, acc: null, at: null, age: null }) ===
   'accuracy not recorded');

const old = makeMark(fix({ at: NOW - 41000 }), [], NOW);
ok('a stale mark says which fix it was cut from',
   markDetail(old).includes('from a fix 41 s old'));

ok('a fresh mark says nothing about age', !markDetail(m1).includes('from a fix'));

ok('distance is offered when there is somewhere to measure from',
   markDetail(m1, [LAT + 0.001, LNG]).includes('111 m away'));

ok('and left out when there is not', !markDetail(m1).includes('away'));

ok('the note that travels with it names the accuracy',
   markNote(m1) === 'GPS accuracy ±4 m');
ok('and the staleness, where there is any',
   markNote(old) === 'GPS accuracy ±4 m, taken from a fix 41 s old');

ok('a mark with no timestamp shows no clock', clockTime(null) === '');
ok('the clock is zero-padded', /^\d{2}:\d{2}$/.test(clockTime(NOW)));

/* ------------------------------------------------------------ moved by hand */

console.log('moved by hand: a drag is a different claim, not a better fix');

/* 52.0 -> 52.0002 is a shade over 22 m due north. */
const dropped = makeMark(fix(), [], NOW);
const byHand = Object.assign({}, dropped, handPlace(dropped, LAT + 0.0002, LNG));

ok('a dropped mark has no hand on it', !isHandPlaced(dropped));
ok('a moved one does', isHandPlaced(byHand));
ok('it is where the hand put it', byHand.lat === LAT + 0.0002);
ok('and it remembers where the fix put it',
   byHand.fix[0] === LAT && byHand.fix[1] === LNG);
ok('which is how far the hand took it', Math.round(handOffset(byHand)) === 22);

ok('it stops offering a ±, the error is now the imagery’s, not the receiver’s',
   !markDetail(byHand).includes('±'));
ok('and says what it is instead', markDetail(byHand).startsWith('placed by hand'));
ok('with the distance that would catch the wrong tree',
   markDetail(byHand).includes('22 m from its fix'));
ok('it still measures from where you are standing',
   markDetail(byHand, [LAT, LNG]).includes('22 m away'));

/* The fix is kept, so it is still there to go back to. Keeping it is not the
 * same as letting it speak for the point. */
ok('the accuracy of the fix survives the move', byHand.acc === 4);
ok('but nothing shows it as the mark’s own', !markDetail(byHand).includes('4 m ·'));

const staleHand = handPlace(makeMark(fix({ at: NOW - 41000 }), [], NOW), LAT, LNG + 0.0002);
const staleMoved = Object.assign(makeMark(fix({ at: NOW - 41000 }), [], NOW), staleHand);
ok('a stale fix stops being mentioned once the hand has moved it off',
   !markDetail(staleMoved).includes('from a fix'));

ok('the note that travels to a file says a hand did it',
   markNote(byHand).startsWith('position placed by hand on the map, not read from GPS'));
ok('and names the distance', markNote(byHand).includes('moved 22 m from where the fix put it'));
ok('and what the fix itself had read', markNote(byHand).includes('that fix read ±4 m'));

const backAgain = Object.assign({}, byHand, putBack(byHand));
ok('putting it back returns it to the fix',
   backAgain.lat === LAT && backAgain.lng === LNG);
ok('and hands the ± back with it', markDetail(backAgain).startsWith('±4 m'));
ok('there is nothing to put back on a mark nobody moved', putBack(dropped) === null);

ok('a second move measures from the fix, not from the first hand',
   Math.round(handOffset(Object.assign({}, byHand,
     handPlace(byHand, LAT + 0.0004, LNG)))) === 45);

/* ---------------------------------------------------------------- cleaning */

console.log('coming back from a file: anything that is not a place is dropped');

const dirty = cleanMarks([
  { n: 1, lat: LAT, lng: LNG, acc: 4, label: 'Keep' },
  { n: 2, lat: 'north a bit', lng: LNG },
  { n: 3, lat: 95, lng: LNG },
  { n: 4, lat: LAT, lng: 400 },
  null,
  'not a mark',
  { n: 1, lat: LAT, lng: LNG },
], NOW);

ok('a mark with a usable position survives', dirty[0].label === 'Keep');
ok('coordinates that are not numbers are dropped', dirty.length === 2);
ok('latitude past the pole is dropped', !dirty.some((m) => m.lat === 95));
ok('longitude off the earth is dropped', !dirty.some((m) => m.lng === 400));
ok('a repeated number is given a fresh one, so no two discs claim to be the same',
   dirty[1].n === 2);
ok('every mark comes back with an id', dirty.every((m) => typeof m.id === 'string' && m.id));
ok('a missing list is an empty one', cleanMarks(undefined).length === 0);
ok('a number that is not a number is replaced',
   cleanMarks([{ lat: LAT, lng: LNG }], NOW)[0].n === 1);

/* ------------------------------------------------------------------ files */

console.log('out to a file: a mark keeps its accuracy in every format');

const marks = [
  makeMark(fix(), [], NOW),
  Object.assign(makeMark(fix({ lat: 52.001, acc: 12 }), [{ n: 1 }], NOW), { label: 'Dead oak' }),
];

const gpx = marksToGPX('Test <parcel>', marks);
ok('GPX names the file after the area, escaped',
   gpx.includes('<name>Test &lt;parcel&gt;</name>'));
ok('GPX writes one waypoint per mark', (gpx.match(/<wpt /g) || []).length === 2);
ok('GPX puts time before name, as the schema requires',
   gpx.indexOf('<time>') < gpx.indexOf('<name>Mark 1</name>'));
ok('GPX carries the label where there is one', gpx.includes('<name>Dead oak</name>'));
ok('GPX carries the accuracy', gpx.includes('GPS accuracy ±12 m'));
ok('GPX writes lat and lon the way GPX means them',
   gpx.includes('lat="52.0000000" lon="21.0000000"'));

const kml = marksToKML('Test', marks);
ok('KML writes a point per mark', (kml.match(/<Point>/g) || []).length === 2);
ok('KML is lng,lat, which is where a coordinate swap would show',
   kml.includes('<coordinates>21,52,0</coordinates>'));
ok('KML carries the accuracy', kml.includes('GPS accuracy ±4 m'));

const pts = JSON.parse(marksToGeoJSON('Test', marks));
ok('GeoJSON writes points', pts.features.every((f) => f.geometry.type === 'Point'));
ok('GeoJSON is lng,lat',
   pts.features[0].geometry.coordinates[0] === LNG &&
   pts.features[0].geometry.coordinates[1] === LAT);
ok('GeoJSON carries the accuracy as a number', pts.features[1].properties.accuracy_m === 12);
ok('GeoJSON keeps the number as well as the name', pts.features[1].properties.number === 2);

/* --------------------------------------------------------------- and back */

console.log('and back: a backup that loses your marks is not a backup');

const ring = [[52.0, 21.0], [52.0, 21.002], [51.998, 21.002], [51.998, 21.0]];
const field = { id: 'f1', name: 'Test parcel', ring, marks, updated: NOW };

const oneUp = JSON.parse(toGeoJSON(field.name, field.ring, field.marks));
ok('an exported area carries its marks in the polygon properties',
   oneUp.features[0].properties.marks.length === 2);
ok('an area with no marks does not invent an empty list',
   JSON.parse(toGeoJSON('Bare', ring, [])).features[0].properties.marks === undefined);
ok('a backup of every area carries them too',
   JSON.parse(toGeoJSONAll([field])).features[0].properties.marks.length === 2);

const readBack = await readBoundaryFile(
  new File([toGeoJSONAll([field])], 'backup.geojson', { type: 'application/geo+json' }));
ok('reading a backup gives the marks back', readBack[0].marks.length === 2);
ok('with their labels', cleanMarks(readBack[0].marks, NOW)[1].label === 'Dead oak');
ok('and their accuracies', cleanMarks(readBack[0].marks, NOW)[1].acc === 12);
ok('and their numbers', cleanMarks(readBack[0].marks, NOW).map((m) => m.n).join() === '1,2');

const plain = await readBoundaryFile(
  new File([toGeoJSON('Bare', ring)], 'bare.geojson', { type: 'application/geo+json' }));
ok('an area that never had marks reads back without any',
   cleanMarks(plain[0].marks, NOW).length === 0);

/* ------------------------------------------------- and visible on any map */

console.log('and visible: a mark stored only as an attribute is a mark nobody sees');

const points = oneUp.features.filter((f) => f.geometry.type === 'Point');
ok('the exported area draws each mark as a point too', points.length === 2);
ok('the polygon still comes first, so the marks sit on top of it',
   oneUp.features[0].geometry.type === 'Polygon');
ok('a point is lng,lat, which is where a coordinate swap would show',
   points[0].geometry.coordinates[0] === LNG && points[0].geometry.coordinates[1] === LAT);
ok('a point is named, so a viewer has something to label it with',
   points[1].properties.name === 'Dead oak');
ok('and carries the accuracy it was taken at', points[1].properties.accuracy_m === 12);
ok('an area with no marks exports the boundary alone',
   JSON.parse(toGeoJSON('Bare', ring, [])).features.length === 1);
ok('a backup of every area draws its marks as points as well',
   JSON.parse(toGeoJSONAll([field])).features
     .filter((f) => f.geometry.type === 'Point').length === 2);

/* ------------------------------------------- and the hand survives the trip */

console.log('a hand comes back a hand: a file must not hand the ± back');

const handField = { id: 'f2', name: 'Hand parcel', ring, updated: NOW,
                    marks: [Object.assign({}, byHand, { n: 1 })] };
const handOut = JSON.parse(toGeoJSONAll([handField]));
const handPt = handOut.features.find((f) => f.geometry.type === 'Point');

ok('the point it draws carries no accuracy, because it has none',
   handPt.properties.accuracy_m === null);
ok('and says who placed it', handPt.properties.placed === 'hand');
ok('a mark the fix placed still says so',
   JSON.parse(toGeoJSONAll([field])).features
     .find((f) => f.geometry.type === 'Point').properties.placed === 'gps');

const handBack = cleanMarks(
  (await readBoundaryFile(new File([JSON.stringify(handOut)], 'hand.geojson',
                                   { type: 'application/geo+json' })))[0].marks, NOW);
ok('reading it back keeps the hand on it', isHandPlaced(handBack[0]));
ok('and where the fix had put it', Math.round(handOffset(handBack[0])) === 22);
ok('so it still refuses to quote a ±', !markDetail(handBack[0]).includes('±'));

ok('a mark claiming a hand but no fix is still a mark, just one with nothing to go back to',
   cleanMarks([{ n: 1, lat: LAT, lng: LNG, placed: 'hand', fix: ['x', 2] }], NOW)[0].fix === null);
ok('and a file that says placed: nonsense is read as no hand at all',
   !isHandPlaced(cleanMarks([{ n: 1, lat: LAT, lng: LNG, placed: 'yes' }], NOW)[0]));

/* The reader has no branch for Point. If it ever grows one, this catches the
 * day every round trip starts doubling the marks. */
ok('reading that file back does not come home with the marks twice',
   readBack[0].marks.length === 2 && readBack.length === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
