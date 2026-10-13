/* Every sentence has to exist in both languages, carry the same slots, and
 * follow the house rule on dashes. A key the page asks for that the
 * dictionary lacks would print the key itself on screen. */

import { readFileSync } from 'node:fs';
import { DICTS, LANGS, t, setLang, pl } from '../public/i18n.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
};

console.log('i18n');

const en = Object.keys(DICTS.en), plKeys = Object.keys(DICTS.pl);
ok('Polish has every English key', en.every((k) => k in DICTS.pl),
   en.filter((k) => !(k in DICTS.pl)).join(', '));
ok('English has every Polish key', plKeys.every((k) => k in DICTS.en),
   plKeys.filter((k) => !(k in DICTS.en)).join(', '));

// Where one side is a plural function the slots are its arguments, checked below.
const slots = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
const odd = en.filter((k) => typeof DICTS.en[k] === 'string' && typeof DICTS.pl[k] === 'string' &&
  slots(DICTS.en[k]) !== slots(DICTS.pl[k]));
ok('both languages fill the same slots', odd.length === 0, odd.join(', '));

// Functions are exercised with the numbers that pick each plural form.
const VARS = { n: 0, count: 0, walked: 3, total: 5, worst: 12, skipped: 1, done: 4, failed: 1, area: '1 ha' };
const texts = [];
for (const lang of LANGS) {
  setLang(lang);
  for (const k of en) {
    for (const n of [1, 2, 5, 12, 22]) texts.push([lang, k, t(k, { ...VARS, n, count: n })]);
  }
}
setLang('en');
ok('no entry prints undefined', !texts.some(([, , s]) => /undefined|NaN/.test(s)),
   texts.filter(([, , s]) => /undefined|NaN/.test(s)).map(([l, k]) => l + ':' + k).join(', '));
ok('no em dashes in user-facing text', !texts.some(([, , s]) => s.includes('—')),
   texts.filter(([, , s]) => s.includes('—')).map(([l, k]) => l + ':' + k).join(', '));

ok('Polish plural: 1 obszar', pl(1, 'obszar', 'obszary', 'obszarów') === 'obszar');
ok('Polish plural: 3 obszary', pl(3, 'obszar', 'obszary', 'obszarów') === 'obszary');
ok('Polish plural: 5 obszarów', pl(5, 'obszar', 'obszary', 'obszarów') === 'obszarów');
ok('Polish plural: 13 obszarów', pl(13, 'obszar', 'obszary', 'obszarów') === 'obszarów');
ok('Polish plural: 24 obszary', pl(24, 'obszar', 'obszary', 'obszarów') === 'obszary');

ok('an unknown language falls back to English', setLang('xx') === 'en' && t('title.areas') === 'My areas');
setLang('pl');
ok('the module-level language reaches t()', t('title.areas') === 'Obszary');
setLang('en');

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const asked = [...html.matchAll(/data-i18n(?:-html|-aria)?="([^"]+)"/g)].map((m) => m[1]);
const missing = asked.filter((k) => !(k in DICTS.en));
ok('index.html asks only for keys that exist (' + asked.length + ')', missing.length === 0, missing.join(', '));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
