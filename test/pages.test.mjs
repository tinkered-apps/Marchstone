/* The CSP allows scripts from this origin only, so an inline script would be
 * blocked in production while working from disk. And a page the service worker
 * does not cache is a page that fails with no signal. */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
};

const read = (file) => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
const sw = read('sw.js');
const PAGES = ['index.html', 'privacy.html'];

console.log('pages');

for (const page of PAGES) {
  const html = read(page);
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs, body]) => !/\bsrc=/.test(attrs) || body.trim());
  ok(page + ' has no inline scripts', inline.length === 0, inline.map((m) => m[0].slice(0, 60)).join(' | '));
  ok(page + ' has no inline event handlers', !/\son[a-z]+\s*=/i.test(html));
  // Cloudflare redirects x.html to its clean URL; the worker must cache that one.
  const clean = page === 'index.html' ? './' : './' + page.replace(/\.html$/, '');
  ok('the service worker caches ' + clean, sw.includes("'" + clean + "'"));
  for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="\.?\/?([^"]+)"/gi)) {
    ok('the service worker caches ' + src, sw.includes("'./" + src + "'"));
  }
}

const privacy = read('privacy.html');
ok('privacy.html asks search engines to skip it', /<meta name="robots" content="noindex">/.test(privacy));
ok('_headers sends noindex for /privacy and /privacy.html',
   /\/privacy\n\s+X-Robots-Tag: noindex\n\/privacy\.html\n\s+X-Robots-Tag: noindex/.test(read('_headers')));
ok('the footer links to privacy.html', /<footer[\s\S]*href="privacy\.html"[\s\S]*<\/footer>/.test(read('index.html')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
