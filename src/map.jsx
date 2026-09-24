// The swarm map, as a page of the app.
//
// Same module as the one live on swarm.green: the geometry, the projection and
// the TopoJSON decoder are the website's files, bundled into the app, and the
// data is the same swarm-map.json. Nothing is fetched by this page — the main
// process fetches the one allow-listed URL and hands the result over IPC, so
// the renderer keeps connect-src 'none'.
//
// It draws only what the files say: the live census of nodes connected to the
// seed right now (places, by city), falling back to the published list. There
// is no toggle that pretends to add or remove anyone beyond actually
// connecting or disconnecting a node.

import React, { useEffect, useRef, useState } from 'react';
import { Icon, Notice } from './ui.jsx';
import { CityOptIn } from './mapCityPanel.jsx';

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
    // Not `s`: in this file `s` is the engine state snapshot, and a test scans
    // every `s.<key>` in the renderer against what the engine really
    // publishes. One local shadowing it would blind that check on the very
    // page where reading a key that did not exist went unnoticed.
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(tag);
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

  // Every place is NAMED on the map, not only on hover.
  //
  // The owner's report was that the locations were "still not showing up": a
  // lone 2.6 px dot on a world map is a thing you can look straight past, and a
  // tooltip needs a mouse to find. With a handful of places the names fit
  // (they are drawn only while there are at most eight of them, so a busy map
  // stays a heat map rather than a wall of text).
  const labels = el('g');
  if (points.length <= 8) {
    for (const p of points) {
      const name = p.node.city + (p.node.country ? ', ' + p.node.country : '');
      const mine = !!p.node.mine;
      const anchor = p.x > W - 120 ? 'end' : 'start';
      const dx = anchor === 'end' ? -8 : 8;
      labels.appendChild(textNode({
        x: (p.x + dx).toFixed(1), y: (p.y + 3.2).toFixed(1), 'text-anchor': anchor,
        fill: mine ? '#FFE0B0' : '#D9D1C4', 'font-family': 'JetBrains Mono, monospace',
        'font-size': '10', 'paint-order': 'stroke', stroke: '#0A0908', 'stroke-width': '3',
        'stroke-opacity': '.85'
      }, mine ? `YOUR CITY - ${name}` : name));
    }
  }
  frag.appendChild(labels);

  // The operator's own city gets a dashed ring and a filled dot of its own, so
  // "on this machine, not published" cannot be mistaken for a published place.
  const mineDots = el('g');
  for (const p of points.filter((q) => q.node.mine)) {
    mineDots.appendChild(el('circle', {
      cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: '9',
      fill: 'none', stroke: '#FFE0B0', 'stroke-width': '1', 'stroke-dasharray': '3 2'
    }));
    mineDots.appendChild(el('circle', {
      cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: '3',
      fill: '#FFE0B0', opacity: '.95'
    }));
  }
  frag.appendChild(mineDots);

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

export function MapView({ cfg, s, reducedMotion }) {
  const plotRef = useRef(null);
  const [state, setState] = useState(null);
  const [net, setNet] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load(force) {
    setBusy(true);
    try {
      const [r, n] = await Promise.all([
        window.shell.getMapData(force === true),
        window.shell.getNetworkStatus(force === true)
      ]);
      setState(r);
      setNet(n);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    let timer;
    async function refresh() {
      try {
        const [r, n] = await Promise.all([
          window.shell.getMapData(false),
          window.shell.getNetworkStatus(false)
        ]);
        if (active) { setState(r); setNet(n); }
      } catch {
        if (active) {
          setState({ ok: false, error: 'Could not refresh the map. Try Refresh.' });
          setNet(null);
        }
      } finally {
        if (active) timer = setTimeout(refresh, 30000);
      }
    }
    refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!state || !state.data || !plotRef.current) return;
    let live = true;
    loadVendor()
      .then((ready) => { if (live && ready && plotRef.current) draw(plotRef.current, state.data.nodes, reducedMotion); })
      .catch(() => { /* the table below is still the answer */ });
    return () => { live = false; };
  }, [state, reducedMotion]);

  const nodes = state && state.data ? state.data.nodes : [];
  // Two counts, never one. The published places are the swarm's; the operator's
  // own city is theirs and nobody else's, and a badge that added them together
  // would claim a network larger than the file does — the exact thing this map
  // refuses to do.
  const published = nodes.filter((n) => !n.mine);
  const minePlace = nodes.find((n) => n.mine) || null;
  const total = published.reduce((acc, n) => acc + n.count, 0);
  const when = stamp(state && state.data ? state.data.updated : null);
  const liveInfo = state && state.data && state.data.live ? state.data.live : null;
  const pillText = liveInfo
    ? `${nf.format(liveInfo.nodesOnline)} ${liveInfo.nodesOnline === 1 ? 'NODE ONLINE' : 'NODES ONLINE'}${liveInfo.stale ? ' · LIVE (STALE)' : ' · LIVE'}`
    : (state && state.data ? `${nf.format(total)} ${total === 1 ? 'NODE' : 'NODES'}${minePlace ? ' + YOUR CITY' : ''}${when ? ' · UPDATED ' + when : ''}` : '');

  // "How many bees" - a real figure or none at all.
  //
  // The seed server publishes how many peers IT is connected to. That is a
  // lower bound on the network and the label says so. When the seed cannot be
  // reached, the app falls back to this machine's own peer count and labels
  // THAT exactly, rather than showing one number under the other's name.
  // s.node, not s.chain: the engine publishes the node's own figures under
  // `node`. Reading a key that does not exist made this page say "Your node:
  // not running" while the title bar beside it said "1 PEER", and it meant the
  // fallback figure could never appear at all.
  const nodeRunning = !!(s && s.node && s.node.running);
  const localPeers = nodeRunning && Number.isFinite(s.node.peers) ? s.node.peers : null;
  const seedPeers = net && net.ok && net.data && net.data.seedPeers != null ? net.data.seedPeers : null;
  const reach = seedPeers != null && !(net && net.stale)
    ? { value: seedPeers, label: 'Seed node peers', detail: 'connections the project’s seed node reports right now' }
    : localPeers != null
      ? { value: localPeers, label: 'Your node’s peers', detail: 'nodes YOUR node is connected to (the seed could not be reached)' }
      : { value: null, label: 'Nodes reachable', detail: 'not known: the seed did not answer and your node is not running' };

  return (
    <div className="stack-lg">
      <div className="swarmmap">
        <div className="swarmmap-frame">
          <svg ref={plotRef} viewBox={`0 0 ${W} ${H}`} className="swarmmap-plot" role="img"
               aria-label="World map of SWARM node locations by city" />
          <div className="swarmmap-pill">
            <span className="dot" />
            {state && state.data
              ? pillText
              : busy ? 'LOADING…' : 'NO DATA'}
          </div>
          <div className="swarmmap-key"><span>FEW</span><i /><span>MANY</span></div>
        </div>

        <div className="swarmmap-stats">
          <div>
            <div className="kicker">Nodes online</div>
            <div className="v">{state && state.data ? (liveInfo ? nf.format(liveInfo.nodesOnline) : nf.format(total)) : '—'}</div>
            <div className="tiny dim">
              {liveInfo ? 'connected to the seed right now, city level' : 'published, city level — only those who asked to be listed'}
            </div>
          </div>
          <div>
            <div className="kicker">Cities</div>
            <div className="v">{state && state.data ? nf.format(published.length) : '—'}</div>
            <div className="tiny dim">
              {minePlace ? `+ your city (${minePlace.city}), on this machine only` : 'city level, never finer'}
            </div>
          </div>
          <div>
            <div className="kicker">{reach.label}</div>
            <div className="v">{reach.value == null ? '—' : nf.format(reach.value)}</div>
            <div className="tiny dim">{reach.detail}</div>
          </div>
          <div>
            <div className="kicker">Your node</div>
            <div className="v plain">{nodeRunning ? 'Connected' : 'Not running'}</div>
            <div className="tiny dim">
              {nodeRunning
                ? `${localPeers == null ? 'no' : localPeers} peer${localPeers === 1 ? '' : 's'}${minePlace ? ' · marked with your city on this machine only' : ''}`
                : 'start it on the Node page'}
            </div>
          </div>
        </div>
      </div>

      {/* The exact question the owner asked: "I connected my node but it's
          not showing." Answered on the page, next to the count — and, since
          2026-09-23, with something to do about it: the panel below puts the
          operator's OWN city on their own map at once. */}
      <CityOptIn cfg={cfg} onRefresh={load} />
      {nodeRunning ? (
        <Notice kind="plain">
          <div>
            <b>Live connections, grouped by city.</b>
            <div style={{ marginTop: 4 }}>
              The seed groups its current peer connections by approximate city using their network IP addresses.
              Your connection appears while it is active. The public feed contains city counts;
              it omits individual IP addresses and wallet addresses.
            </div>
          </div>
        </Notice>
      ) : null}

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
        <p className="small muted" style={{ marginBottom: 8 }}>
          <b>“{reach.label}” is {reach.value == null ? 'not known' : nf.format(reach.value)}</b> —{' '}
          {reach.detail}.{' '}
          {seedPeers != null
            ? <>Read from <span className="mono">lwd.swarm.green/status.json</span>, which the seed
              regenerates every 30 seconds{net && net.stale ? ' (this copy is older than that)' : ''}.
              It is a lower bound: it counts connections to one server, not everyone running SWARM.</>
            : net && net.error
              ? <>The seed did not answer ({net.error}), so nothing from it is shown.</>
              : null}
          {' '}There is no census service, so no total for the whole network exists to show.
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
