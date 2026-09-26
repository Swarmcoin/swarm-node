// Shared presentation pieces: the SWARM mark, icons, and the small
// building blocks the screens are assembled from.

import React from 'react';

/**
 * The SWARM mark: an amber chevron over the hive's two eyes.
 *
 * A file, not a drawing. `public/swarm-mark.svg` is installed from the brand
 * kit together with every app icon, so this window's logo and the icon in the
 * taskbar are the same artwork; the inline hive bee this replaces was a second
 * drawing of the same logo, which is how a window ends up showing an older mark
 * than the icon beside it. Installed by `scripts/brand/install_app_brand.py` in
 * the project repository.
 */
export function Mark({ size = 34 }) {
  return (
    <img
      src="./swarm-mark.svg"
      width={size}
      height={Math.round(size * 0.468)}
      alt=""
      aria-hidden="true"
    />
  );
}

const PATHS = {
  mine: 'M14 6 6 14l4 4M12 4c3 0 6 1 8 4-2-1-5-1-7 0z',
  node: 'M12 4.5 17.2 7.5v6L12 16.5 6.8 13.5v-6zM12 16.5V21M6.8 13.5 3 16M17.2 13.5 21 16',
  honey: 'M12 3 19.8 7.5 19.8 16.5 12 21 4.2 16.5 4.2 7.5Z M12 8v5M12 16h.01',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  log: 'M4 5h16M4 10h16M4 15h10M4 20h7',
  map: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  wallet: 'M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 12h3M16 12a1.5 1.5 0 1 0 3 0',
  check: 'M4 12l5 5L20 6',
  shield: 'M12 3 5 6v5c0 4 3 6 7 8 4-2 7-4 7-8V6z',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'
};

export function Icon({ name, size = 18 }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Pill({ kind = '', children }) {
  return <span className={`pill ${kind}`}><span className="dot" />{children}</span>;
}

/** A metric card. `value` of null renders an em dash: unknown is never zero. */
export function Metric({ label, value, detail, edge, small }) {
  const shown = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <div className="metric" style={edge ? { '--edge': edge } : undefined}>
      <div className="k">{label}</div>
      <div className={`v${small ? ' small' : ''}`}>{shown}</div>
      {detail ? <div className="d">{detail}</div> : null}
    </div>
  );
}

/**
 * The band across the top of every screen that says WHICH NETWORK this is.
 *
 * It used to be a hard-coded testnet warning: `<network name> · engineering
 * testnet. Coins have no value…`, rendered whatever network was running. A
 * SWARM mainnet build therefore told the owner its real coins were worthless
 * test coins, and the app said nothing anywhere else about which chain it was
 * on. Now the profile decides: the warning belongs to the testnet, and the
 * production network gets its chain label and its genesis instead, which are
 * the two things that identify a chain beyond argument.
 */
export function NetworkStrip({ network, compact }) {
  if (!network) return null;
  const production = network.production === true;
  return (
    <div className={`net-strip${production ? ' production' : ''}`}>
      <Mark size={16} />
      {production ? (
        <span>
          <b>{network.name}</b> · {network.profileLabel} · chain{' '}
          <span className="mono">{network.chainLabel}</span>
          {network.genesisShort ? <> · genesis <span className="mono">{network.genesisShort}…</span></> : null}
        </span>
      ) : (
        <span>
          <b>{network.name}</b> · engineering testnet. Coins have no value
          {compact ? '.' : ' and the chain may restart.'}
        </span>
      )}
    </div>
  );
}

export function Notice({ kind = 'plain', children }) {
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="small">{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------- formatting
export function fmtCoins(zat, atomic = 100000000, minDecimals = 2) {
  if (zat === null || zat === undefined || !Number.isFinite(zat)) return '—';
  const whole = Math.floor(Math.abs(zat) / atomic);
  const frac = String(Math.abs(zat) % atomic).padStart(8, '0').replace(/0+$/, '').padEnd(minDecimals, '0');
  return `${zat < 0 ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtAge(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 90) return `${Math.round(sec)}s ago`;
  return fmtDuration(sec) + ' ago';
}

export function fmtSolps(v) {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MSol/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)} kSol/s`;
  return `${v.toFixed(1)} Sol/s`;
}

export function shortHash(h, n = 10) {
  if (typeof h !== 'string' || h.length <= n * 2) return h || '—';
  return `${h.slice(0, n)}…${h.slice(-6)}`;
}
