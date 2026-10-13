/* The version a phone reports has to be the version it is running: the footer
 * reads APP_VERSION, and the service worker's CACHE name is what makes a phone
 * fetch new files. Out of step, the app claims a version it is not running. */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
};

const read = (file) => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
const version = read('app.js').match(/const APP_VERSION = '([^']+)'/)?.[1];
const cache = read('sw.js').match(/const CACHE = '([^']+)'/)?.[1];

console.log('version');

ok('app.js declares APP_VERSION as a two-decimal number', /^\d+\.\d{2}$/.test(version ?? ''), version);
ok('the service worker cache carries the same number', cache === 'marchstone-v' + version,
   cache + ' vs ' + version);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
