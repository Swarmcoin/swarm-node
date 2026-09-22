// The swarm map, as a page of the app.
//
// Same module as the one live on swarm.green: the geometry, the projection and
// the TopoJSON decoder are the website's files, bundled into the app, and the
// data is the same swarm-map.json. Nothing is fetched by this page — the main
// process fetches the one allow-listed URL and hands the result over IPC, so
// the renderer keeps connect-src 'none'.
//
// It draws only what the file says. Today that is one place, the project's own
// seed node. There is no census service, so the map does not pretend to be a
// count of the network, and there is no toggle that pretends to add you to it.

import React, { useEffect, useRef, useState } from 'react';
import { Icon, Notice } from './ui.jsx';

// The geometry is imported; the two vendor scripts are NOT.
//
// Both are plain browser scripts that end in `})(this)` and hang themselves off
// the global object. Bundled as ES modules, `this` is undefined at the top
// level and they throw "Cannot set properties of undefined". They are therefore
// served as static files from the app's own folder and loaded with a script
// element, exactly as the website loads them — same-origin, allowed by
// script-src 'self', and no CDN anywhere.
import worldTopology from './assets/map/world-110m.json';

const VENDOR = ['./map/topojson-client.min.js', './map/geo-natural-earth1.js'];

/** Load the two vendor scripts once, lazily, when the map is first opened. */
let vendorPromise = null;
function loadVendor() {
  if (window.topojson && window.SwarmGeo) return Promise.resolve(true);
  if (vendorPromise) return vendorPromise;
  vendorPromise = Promise.all(VENDOR.map((src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  }))).then(() => !!(window.topojson && window.SwarmGeo));
  return vendorPromise;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const W = 960;
const H = 500;
const SCALE = 174;
const CENTRE = [480, 250];
// The domain floor keeps a young swarm honest: one node is a small glow, not
// a continent-sized bloom, and the scale grows as real hotspots appear.
const R_MIN = 7;
const R_MAX = 46;
const R_REF = 12;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function el(name, attrs) {
  const node = document.createElementNS(SVGNS, name);
  for (const k of Object.keys(attrs || {})) {
    if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
  }
  return node;
}
function textNode(attrs, value) {
  const t = el('text', attrs);
  t.textContent = value;
  return t;
}
const nf = new Intl.NumberFormat('en-GB');

/** Draw the map into `plot`. Returns nothing; failures leave the table behind. */
function draw(plot, nodes, reduceMotion) {
  const G = window.SwarmGeo;
  const topojson = window.topojson;
  if (!G || !topojson || !plot) return false;

  const project = G.naturalEarth1(SCALE, CENTRE);
  const land = topojson.feature(worldTopology, worldTopology.objects.land);
  const frag = document.createDocumentFragment();

  const defs = el('defs');
  const grad = el('radialGradient', { id: 'swarm-heat' });
  grad.appendChild(el('stop', { offset: '0%', 'stop-color': '#FFB020', 'stop-opacity': '.95' }));
  grad.appendChild(el('stop', { offset: '35%', 'stop-color': '#FF8A1F', 'stop-opacity': '.55' }));
  grad.appendChild(el('stop', { offset: '100%', 'stop-color': '#FF8A1F', 'stop-opacity': '0' }));
  defs.appendChild(grad);
  const filter = el('filter', { id: 'swarm-soft', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  filter.appendChild(el('feGaussianBlur', { stdDeviation: '1.2' }));
  defs.appendChild(filter);
  frag.appendChild(defs);

  frag.appendChild(el('path', {
    d: G.path(G.graticule(30), project),
    fill: 'none', stroke: '#FFFFFF', 'stroke-opacity': '.05', 'stroke-width': '.6'
  }));
  frag.appendChild(el('path', {
    d: G.path(G.sphere(), project),
    fill: 'none', stroke: '#FF8A1F', 'stroke-opacity': '.18', 'stroke-width': '.8'
  }));
  frag.appendChild(el('path', {
    d: G.path(land, project),
    fill: '#171411', 'fill-rule': 'evenodd',
    stroke: '#FFFFFF', 'stroke-opacity': '.09', 'stroke-width': '.5'
  }));

  if (!nodes.length) {
    plot.replaceChildren(frag);
    return true;
  }

  const max = nodes.reduce((m, n) => Math.max(m, n.count), 0);
  const ref = Math.max(max, R_REF);
  const radius = (n) => R_MIN + (R_MAX - R_MIN) * Math.sqrt(Math.min(n, ref) / ref);
  const points = nodes.map((n) => {
    const xy = project([n.lon, n.lat]);
    return { node: n, x: xy[0], y: xy[1], r: radius(n.count) };
  });

  const heat = el('g', { class: 'swarmmap-heat' });
  for (const p of points) {
    heat.appendChild(el('circle', {
      cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: p.r.toFixed(1),
      fill: 'url(#swarm-heat)', filter: 'url(#swarm-soft)',
      opacity: (0.55 + 0.45 * Math.min(1, p.node.count / ref)).toFixed(2)
    }));
  }
  frag.appendChild(heat);

  if (!reduceMotion) {
    const rings = el('g');
    for (const p of points.filter((q) => q.node.count >= max * 0.6)) {
      rings.appendChild(el('circle', {
        class: 'swarmmap-ring', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: '10',
        fill: 'none', stroke: '#FFB020', 'stroke-width': '1'
      }));
    }
    frag.appendChild(rings);
  }

  const dots = el('g');
  for (const p of points) {
    dots.appendChild(el('circle', {
      cx: p.x.toFixed(1), cy: p.y.toFixed(1),
      r: p.node.count >= max * 0.6 ? '2.6' : '1.6',
      fill: '#FFE0B0', opacity: '.95'
    }));
  }
  frag.appendChild(dots);

  const tip = el('g', { class: 'swarmmap-tip', 'aria-hidden': 'true', visibility: 'hidden' });
  const tipBox = el('rect', { x: '0', y: '0', rx: '8', ry: '8', height: '40', fill: '#100E0C', 'fill-opacity': '.96', stroke: '#FF8A1F', 'stroke-opacity': '.4' });
  const tipCity = textNode({ x: '10', y: '17', fill: '#FFB020', 'font-family': 'JetBrains Mono, monospace', 'font-size': '11.5' }, '');
  const tipCount = textNode({ x: '10', y: '31', fill: '#D9D1C4', 'font-family': 'JetBrains Mono, monospace', 'font-size': '11' }, '');
  tip.append(tipBox, tipCity, tipCount);

  // Hit areas are focusable, so the hotspots work from the keyboard too.
  const hits = el('g');
  for (const p of points) {
    const n = p.node;
    const where = n.city + (n.country ? ', ' + n.country : '');
    const howMany = nf.format(n.count) + (n.count === 1 ? ' node' : ' nodes');
    const g = el('g', {
      class: 'swarmmap-hot', tabindex: '0', role: 'button',
      'aria-label': `${where} — ${howMany} sharing a city-level location`
    });
    g.appendChild(el('circle', {
      class: 'swarmmap-halo', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: Math.max(9, p.r * 0.55).toFixed(1)
    }));
    g.appendChild(el('circle', {
      cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: Math.max(14, p.r * 0.8).toFixed(1),
      fill: 'none', 'pointer-events': 'all'
    }));
    const show = () => {
      tipCity.textContent = where;
      tipCount.textContent = howMany;
      const width = Math.max(where.length, howMany.length) * 6.6 + 20;
      tipBox.setAttribute('width', width.toFixed(0));
      const tx = Math.min(Math.max(p.x + 14, 4), W - width - 4);
      const ty = p.y - 50 < 4 ? p.y + 16 : p.y - 50;
      tip.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
      tip.setAttribute('visibility', 'visible');
    };
    const hide = () => tip.setAttribute('visibility', 'hidden');
    g.addEventListener('mouseenter', show);
    g.addEventListener('mouseleave', hide);
    g.addEventListener('focus', show);
    g.addEventListener('blur', hide);
    hits.appendChild(g);
  }
  frag.appendChild(hits);
  frag.appendChild(tip);

  plot.replaceChildren(frag);
  return true;
}

function stamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function MapView({ cfg, reducedMotion }) {
  const plotRef = useRef(null);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load(force) {
    setBusy(true);
    const r = await window.shell.getMapData(force === true);
    setState(r);
    setBusy(false);
  }

  useEffect(() => { load(false); }, []);

  useEffect(() => {
    if (!state || !state.data || !plotRef.current) return;
    let live = true;
    loadVendor()
      .then((ready) => { if (live && ready && plotRef.current) draw(plotRef.current, state.data.nodes, reducedMotion); })
      .catch(() => { /* the table below is still the answer */ });
    return () => { live = false; };
  }, [state, reducedMotion]);

  const nodes = state && state.data ? state.data.nodes : [];
  const total = nodes.reduce((s, n) => s + n.count, 0);
  const when = stamp(state && state.data ? state.data.updated : null);

  return (
    <div className="stack-lg">
      <div className="swarmmap">
        <div className="swarmmap-frame">
          <svg ref={plotRef} viewBox={`0 0 ${W} ${H}`} className="swarmmap-plot" role="img"
               aria-label="World map of the places where SWARM nodes have chosen to be listed" />
          <div className="swarmmap-pill">
            <span className="dot" />
            {state && state.data
              ? `${nf.format(total)} ${total === 1 ? 'NODE' : 'NODES'}${when ? ' · UPDATED ' + when : ''}`
              : busy ? 'LOADING…' : 'NO DATA'}
          </div>
          <div className="swarmmap-key"><span>FEW</span><i /><span>MANY</span></div>
        </div>

        <div className="swarmmap-stats">
          <div>
            <div className="kicker">Nodes on the map</div>
            <div className="v">{state && state.data ? nf.format(total) : '—'}</div>
          </div>
          <div>
            <div className="kicker">Cities</div>
            <div className="v">{state && state.data ? nf.format(nodes.length) : '—'}</div>
          </div>
          <div>
            <div className="kicker">Location detail</div>
            <div className="v plain">City level</div>
          </div>
          <div>
            <div className="kicker">Listing</div>
            <div className="v plain">Opt-in</div>
          </div>
        </div>
      </div>

      {state && state.offline ? (
        <Notice kind="warn">
          <div>
            <b>Showing the last copy this app downloaded.</b>
            <div style={{ marginTop: 4 }}>
              {state.fetchedAt ? `Last updated ${new Date(state.fetchedAt).toLocaleString()}. ` : ''}
              The map could not be refreshed: {state.error}
            </div>
          </div>
        </Notice>
      ) : null}
      {state && !state.data ? (
        <Notice kind="plain">
          The map has not been downloaded yet{state.error ? `: ${state.error}` : '.'}
        </Notice>
      ) : null}

      <div className="card">
        <div className="row">
          <h3>What this map is</h3>
          <div className="spacer" />
          <button className="btn sm ghost" disabled={busy} onClick={() => load(true)}>
            {busy ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 8 }}>
          {state && state.data && state.data.note
            ? state.data.note
            : 'Only nodes whose operators chose to share a location appear here, and never finer than a city. It is not a count of the network.'}
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Want your city on the map? Listing is opt-in and is being built — for now, tell the
          project which city to show, at{' '}
          <button className="btn sm ghost" style={{ padding: '2px 6px' }}
                  onClick={() => window.shell.copy(cfg.contactEmail || '')}>
            <span className="mono">{cfg.contactEmail}</span>
          </button>
          . Your own node is <b>not</b> listed unless you ask, and this app sends nothing about
          your location anywhere.
        </p>
      </div>

      {nodes.length ? (
        <div className="card">
          <h3>Listed places</h3>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead><tr><th>City</th><th>Country</th><th style={{ textAlign: 'right' }}>Nodes</th></tr></thead>
            <tbody>
              {nodes.slice().sort((a, b) => b.count - a.count).map((n) => (
                <tr key={`${n.city}-${n.country}`}>
                  <td>{n.city}</td>
                  <td className="muted">{n.country}</td>
                  <td className="num">{nf.format(n.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny dim" style={{ marginTop: 12, marginBottom: 0 }}>
            Source: {state.data.source || 'the SWARM project'} · downloaded by this app from{' '}
            <span className="mono">swarm.green</span>, the same file the website shows.
          </p>
        </div>
      ) : null}
    </div>
  );
}
