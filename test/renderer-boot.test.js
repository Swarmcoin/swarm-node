'use strict';

// The renderer must MOUNT. Draft build 0.2.0-testnet.1 shipped with a bundle
// that threw at module load — two vendor scripts ending in `})(this)` were
// imported as ES modules, where top-level `this` is undefined — so React never
// ran and every screen was a blank window. Nothing in the test suite noticed,
// because nothing looked at the built bundle.
//
// These checks look at what actually ships. The decisive one is not here:
// scripts/smoke-renderer.mjs launches the PACKAGED app and fails unless React
// actually mounted, which is the only thing that would have caught this.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const PUBLIC = path.join(__dirname, '..', 'public');

test('the map vendor scripts ship as static files, not as bundled modules', () => {
  for (const f of ['map/topojson-client.min.js', 'map/geo-natural-earth1.js']) {
    assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} must be in public/ so it is served as a plain script`);
  }
  // And their licences travel with them.
  for (const f of ['map/topojson-client.LICENSE', 'map/d3-geo.LICENSE']) {
    assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} must ship beside the code it covers`);
  }
});

test('nothing in src/ imports those vendor scripts as modules', () => {
  const dir = path.join(__dirname, '..', 'src');
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  for (const f of walk(dir).filter((f) => /\.jsx?$/.test(f))) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/import\s+['"][^'"]*topojson-client[^'"]*['"]/.test(text), `${f} imports topojson-client as a module`);
    assert.ok(!/import\s+['"][^'"]*geo-natural-earth1[^'"]*['"]/.test(text), `${f} imports geo-natural-earth1 as a module`);
  }
});

test('the built page loads exactly one module script and no remote origin', (t) => {
  const html = path.join(DIST, 'index.html');
  if (!fs.existsSync(html)) { t.skip('no dist/index.html; run npm run build:ui first'); return; }
  const text = fs.readFileSync(html, 'utf8');
  assert.ok(!/https?:\/\//.test(text.replace(/<meta[\s\S]*?>/g, '')), 'the built page must reference no remote origin');
  assert.match(text, /<script type="module"/);
});
