import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const ORIGIN = 'http://localhost:8123';

// A 200 m square around 52.0 N, 21.0 E.
const LAT = 52.0, LNG = 21.0;
const dLat = 100 / 111320;
const dLng = 100 / (111320 * Math.cos(LAT * Math.PI / 180));
const SQUARE = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { name: 'Test Square' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [LNG - dLng, LAT - dLat], [LNG + dLng, LAT - dLat],
        [LNG + dLng, LAT + dLat], [LNG - dLng, LAT + dLat], [LNG - dLng, LAT - dLat],
      ]],
    },
  }],
};

// 1x1 transparent PNG: map tiles are answered locally, so a run never waits on
// Esri or OpenStreetMap. The requests are still counted as third-party below.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');

test.beforeEach(async ({ context, page }, testInfo) => {
  const outside = [];
  const errors = [];
  testInfo.outside = outside;
  testInfo.pageErrors = errors;
  await context.route(/server\.arcgisonline\.com|tile\.openstreetmap\.org/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL,
                    headers: { 'Access-Control-Allow-Origin': '*' } }));
  context.on('request', (request) => {
    if (!request.url().startsWith(ORIGIN) && !request.url().startsWith('data:')) {
      outside.push(request.url());
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  // Muted, and the one-time gauge note already seen, so no sheet stands in the way.
  await context.addInitScript(() => {
    if (!localStorage.getItem('fb.settings')) {
      localStorage.setItem('fb.settings', JSON.stringify({ muted: true }));
      localStorage.setItem('fb.gaugeSeen', '1');
    }
  });
});

test.afterEach(async ({}, testInfo) => {
  // Requests to other origins are a warning, not a failure: avoiding them is a
  // goal, and the map tiles are the approved exception.
  const hosts = [...new Set(testInfo.outside.map((u) => new URL(u).origin))];
  for (const host of hosts) {
    testInfo.annotations.push({ type: 'warning', description: 'third-party request: ' + host });
    console.warn('warning: third-party request: ' + host);
  }
  expect(testInfo.pageErrors).toEqual([]);
});

async function importSquare(page, testInfo) {
  const file = testInfo.outputPath('square.geojson');
  fs.writeFileSync(file, JSON.stringify(SQUARE));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import a boundary file' }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator('.area-name', { hasText: 'Test Square' })).toBeVisible();
}

test('the footer credits Kuba, and the page sends its security headers', async ({ page }) => {
  const response = await page.goto('/');
  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toContain("script-src 'self';");
  expect(headers['permissions-policy']).toContain('geolocation=(self)');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');

  const credit = page.locator('.footer-credit');
  await expect(credit).toHaveText('Marchstone v1.00 by Kuba · tinkered.app · Privacy');
  await expect(credit.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', 'privacy.html');
  await expect(credit.getByRole('link', { name: 'Kuba' }))
    .toHaveAttribute('href', 'mailto:kuba@tinkered.app');
  await expect(credit.getByRole('link', { name: 'tinkered.app' }))
    .toHaveAttribute('href', 'https://tinkered.app');
  await expect(credit.locator('svg.footer-logo')).toBeVisible();

  // On a screen taller than the list, the credit sits at the foot of the window.
  await page.setViewportSize({ width: 400, height: 1100 });
  const bottom = await page.evaluate(() => [
    Math.round(document.querySelector('.main-footer').getBoundingClientRect().bottom),
    Math.round(document.getElementById('scrFields').getBoundingClientRect().bottom)]);
  expect(bottom[0]).toBe(bottom[1]);

  const sw = await page.request.get('/sw.js');
  expect(sw.headers()['cache-control']).toBe('no-cache');
});

test('the footer links to a privacy page that search engines skip', async ({ page }) => {
  await page.goto('/');
  // Follow the link with the service worker in charge: Cloudflare redirects
  // privacy.html to /privacy, and a cached redirect would break the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    await caches.open('marchstone-v1.00').then(async (c) => {
      while (!(await c.match('./privacy'))) await new Promise((r) => setTimeout(r, 100));
    });
  });
  await page.locator('.footer-credit').getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy');
  await expect(page.getByRole('heading', { name: 'The map' })).toBeVisible();

  await page.getByRole('button', { name: 'Theme: follows your system' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // The Settings key leads back into the app, on the Settings screen.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('#scrSettings')).toBeVisible();
  await expect(page.locator('#title')).toHaveText('Settings');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(new URL(page.url()).hash).toBe('');
  await page.goBack();
  await expect(page.locator('#scrFields')).toBeVisible();
});

test('the privacy page is sent with a noindex header', async ({ request }) => {
  for (const path of ['/privacy', '/privacy.html']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()['x-robots-tag'], path).toBe('noindex');
  }
});

test('the header changes and remembers the theme', async ({ page }) => {
  await page.goto('/');
  const theme = page.locator('#btnTheme');
  await expect(theme).toHaveAttribute('aria-label', 'Theme: follows your system');
  await theme.click();
  await expect(theme).toHaveAttribute('aria-label', 'Theme: day');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await theme.click();
  await expect(theme).toHaveAttribute('aria-label', 'Theme: night');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(theme).toHaveAttribute('aria-label', 'Theme: night');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(theme).toBeVisible();
  await expect(page.locator('#scrSettings [data-theme]')).toHaveCount(0);
  await theme.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});

test('the header switches to Polish, remembers it, and the privacy page follows', async ({ page }) => {
  await page.goto('/');
  const polish = page.getByRole('radio', { name: 'Polski' });
  await expect(page.getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
  await polish.click();
  await expect(polish).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
  await expect(page.locator('#title')).toHaveText('Obszary');
  await expect(page.getByRole('button', { name: 'Narysuj nowy obszar' })).toBeVisible();
  await expect(page.locator('#btnTheme')).toHaveAttribute('aria-label', 'Motyw: jak w systemie');

  await page.reload();
  await expect(page.locator('#title')).toHaveText('Obszary');
  await page.getByRole('button', { name: 'Ustawienia' }).click();
  await expect(page.getByRole('heading', { name: 'Jakość pozycji' })).toBeVisible();
  await expect(page.locator('#gateNote')).toContainText('Zalecane');

  await page.goto('/privacy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Prywatność');
  await expect(page.getByRole('heading', { name: 'Mapa', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The map' })).toBeHidden();
  await page.getByRole('radio', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'The map' })).toBeVisible();
  await page.goto('/');
  await expect(page.locator('#title')).toHaveText('My areas');
});

test('an area drawn on the map is saved and listed', async ({ page, context }) => {
  await context.grantPermissions(['geolocation'], { origin: ORIGIN });
  await context.setGeolocation({ latitude: LAT, longitude: LNG, accuracy: 4 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Draw a new area' }).click();
  const map = page.locator('#map');
  await expect(map).toBeVisible();
  // Find me takes the map down to field scale, where a few taps make a field.
  await page.getByRole('button', { name: 'Find me' }).click();
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('.leaflet-tile')?.src.match(/tile\/(\d+)\//)?.[1] | 0)).toBeGreaterThanOrEqual(15);
  const box = await map.boundingBox();
  const at = (fx, fy) => ({ x: box.width * fx, y: box.height * fy });
  for (const p of [at(0.3, 0.3), at(0.7, 0.3), at(0.7, 0.6), at(0.3, 0.6)]) {
    await map.click({ position: p });
  }
  await expect(page.locator('#roPoints')).toHaveText('4');
  await expect(page.locator('#roArea')).toHaveText(/(m²|ha)$/);
  await page.getByRole('button', { name: 'Save area' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Drawn Field');
  await page.locator('.sheet-form').getByRole('button', { name: 'Save area' }).click();
  await expect(page.locator('.area-name', { hasText: 'Drawn Field' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.area-name', { hasText: 'Drawn Field' })).toBeVisible();
});

test('OpenStreetMap tiles name the site, Esri tiles are sent no referrer', async ({ page, context }) => {
  const referers = { esri: new Set(), osm: new Set() };
  context.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    const key = host === 'server.arcgisonline.com' ? 'esri' : host === 'tile.openstreetmap.org' ? 'osm' : null;
    if (key) r.allHeaders().then((h) => referers[key].add(h.referer ?? 'none'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Draw a new area' }).click();
  await expect.poll(() => referers.esri.size).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Satellite' }).click();
  await expect.poll(() => referers.osm.size).toBeGreaterThan(0);
  expect([...referers.esri]).toEqual(['none']);
  expect([...referers.osm]).toEqual([ORIGIN + '/']);
});

test('tracking says inside, then outside, and a mark can be dropped', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['geolocation'], { origin: ORIGIN });
  await context.setGeolocation({ latitude: LAT, longitude: LNG, accuracy: 4 });
  await page.goto('/');
  await importSquare(page, testInfo);

  await page.locator('.area', { hasText: 'Test Square' })
    .getByRole('button', { name: 'Track' }).click();
  await expect(page.locator('#trackStatus')).toHaveText(/inside/i);
  await expect(page.locator('#trackPanel')).toHaveAttribute('data-status', 'inside');

  await page.getByRole('button', { name: 'Mark', exact: true }).click();
  await expect(page.locator('#markCount')).toHaveText('1');

  // Walk north out of the square at a walking pace: the app throws away a fix
  // that jumps further than a person can move, so a teleport would not count.
  for (let m = 25; m <= 150; m += 25) {
    await context.setGeolocation({ latitude: LAT + m / 111320, longitude: LNG, accuracy: 4 });
    await page.waitForTimeout(1500);
  }
  await expect(page.locator('#trackPanel')).toHaveAttribute('data-status', 'outside',
    { timeout: 10_000 });
  await expect(page.locator('#trackStatus')).toHaveText(/outside/i);
});

test('a backup holds every area and restores in a fresh browser', async ({ page, browser }, testInfo) => {
  await page.goto('/');
  await importSquare(page, testInfo);
  await page.getByRole('button', { name: 'Settings' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up every area' }).click();
  const file = await (await download).path();
  expect(fs.readFileSync(file, 'utf8')).toContain('Test Square');

  const fresh = await browser.newPage();
  await fresh.goto('/');
  await fresh.getByRole('button', { name: 'Settings' }).click();
  const chooser = fresh.waitForEvent('filechooser');
  await fresh.getByRole('button', { name: 'Restore from a backup' }).click();
  await (await chooser).setFiles(file);
  await fresh.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(fresh.locator('.area-name', { hasText: 'Test Square' })).toBeVisible();
  await fresh.close();
});

test('a file that is not a boundary is refused with a reason', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('nonsense.geojson');
  fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import a boundary file' }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator('#sheetTitle')).toHaveText('That file could not be used');
});

test('the app is installable and opens with no network', async ({ page, context }, testInfo) => {
  await page.goto('/');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    expect((await page.request.get(icon.src.replace('./', '/'))).status(), icon.src).toBe(200);
  }

  await importSquare(page, testInfo);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await expect.poll(() => page.evaluate(async () =>
    (await (await caches.open('marchstone-v1.00')).keys()).length), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(32);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('.area-name', { hasText: 'Test Square' })).toBeVisible();
    await expect(page.locator('.footer-credit')).toContainText('v1.00');
  } finally {
    await context.setOffline(false);
  }
});
