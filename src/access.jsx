// The closed start, on screen: the access code, and "are we up?".
//
// The owner's words (2 October 2026): "i need a UI to see how much is mined /
// whats the update. Are we up." and "add to the node application a code". So:
//   * AccessCodeCard  - paste the code once; afterwards only the machine name
//                       it was made for is ever shown, and one button removes it;
//   * StatusCard      - one card, readable at a glance: the network as a whole,
//                       the tunnel, this node, this computer's mining, and what
//                       this computer has found.
// Every figure comes from the engine snapshot or the server's published status
// file. Unknown renders as a dash, never as zero.

import React, { useEffect, useState } from 'react';
import { Notice, Pill, fmtAge, fmtCoins, fmtSolps } from './ui.jsx';

export function AccessCodeCard({ s, onChanged, compact }) {
  const a = s.access || {};
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [status, setStatus] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    let live = true;
    window.access.status().then((r) => { if (live) setStatus(r); }).catch(() => {});
    return () => { live = false; };
  }, [a.present]);

  if (!a.required) return null;

  async function save() {
    setBusy(true);
    setErr('');
    setOk('');
    const r = await window.access.set(text);
    setBusy(false);
    if (!r || !r.ok) { setErr((r && r.error) || 'That code could not be used.'); return; }
    // The field is emptied at once: the code is never shown again.
    setText('');
    setOk(r.message + (r.protectedByOs ? '.' : '. This computer has no protected store, so the code is kept in a file only your user account can read.'));
    setStatus(await window.access.status());
    if (onChanged) onChanged();
  }

  async function remove() {
    setBusy(true);
    await window.access.remove();
    setBusy(false);
    setConfirmRemove(false);
    setOk('');
    setStatus(await window.access.status());
    if (onChanged) onChanged();
  }

  return (
    <div className="card" id="access-code">
      <h3>Access code</h3>
      {!a.present ? (
        <>
          <p className="small muted">{a.reason}</p>
          {status && status.problem ? <div style={{ marginBottom: 10 }}><Notice kind="warn">{status.problem}</Notice></div> : null}
          <textarea
            className="mono"
            rows={compact ? 3 : 4}
            spellCheck={false}
            autoComplete="off"
            placeholder="SWARMKEY1.…"
            value={text}
            onChange={(e) => { setText(e.target.value); setErr(''); }}
            style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <span className="tiny dim">Paste it exactly as you received it. It is checked on this computer.</span>
            <div className="spacer" />
            <button className="btn primary" disabled={busy || !text.trim()} onClick={save}>
              {busy ? 'Checking…' : 'Use this code'}
            </button>
          </div>
          {err ? <div style={{ marginTop: 10 }}><Notice kind="bad">{err}</Notice></div> : null}
        </>
      ) : (
        <>
          <div className="row" style={{ gap: 10 }}>
            <Pill kind="ok">accepted</Pill>
            <span className="small">Access code accepted for <b>{a.machine}</b></span>
          </div>
          {ok ? <div style={{ marginTop: 10 }}><Notice kind="ok">{ok}</Notice></div> : null}
          <p className="tiny dim" style={{ marginTop: 10 }}>
            The code is kept {status && status.protectedByOs === false
              ? 'in a file only your user account can read'
              : 'with your computer’s own protected storage'} and is never shown again.
            Without it this computer cannot connect to the closed network.
          </p>
          {!confirmRemove ? (
            <button className="btn sm" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove access code</button>
          ) : (
            <Notice kind="warn">
              <div style={{ width: '100%' }}>
                <b>Remove the access code?</b>
                <div className="small" style={{ marginTop: 4 }}>
                  Mining and the node stop, and this computer cannot connect until a code is pasted again.
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn sm danger" disabled={busy} onClick={remove}>{busy ? 'Removing…' : 'Remove it'}</button>
                  <button className="btn sm" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep it</button>
                </div>
              </div>
            </Notice>
          )}
        </>
      )}
    </div>
  );
}

/** "12:41" today, or "2 Oct 12:41" on another day; '—' when unknown. */
function when(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${hm}`;
}

const yes = (label) => <Pill kind="ok">{label}</Pill>;
const no = (label) => <Pill kind="warn">{label}</Pill>;
const unknown = (label) => <Pill kind="idle">{label}</Pill>;

/** The network status file, polled while this card is on screen. */
function useNetworkStatus() {
  const [ns, setNs] = useState(null);
  useEffect(() => {
    let live = true;
    const load = (force) => window.shell.getNetworkStatus(force).then((r) => { if (live) setNs(r); }).catch(() => {});
    load(true);
    const t = setInterval(() => load(false), 30000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return ns;
}

export function StatusCard({ s }) {
  const ns = useNetworkStatus();
  const n = s.node;
  const m = s.mining;
  const r = s.rewards;
  const t = s.tunnel;
  const a = s.access || {};
  const atomic = r.atomicPerCoin;
  const data = ns && ns.ok ? ns.data : null;
  const verdict = (ns && ns.verdict) || { producing: null, tipAgeSec: null };
  const netHeight = data && Number.isInteger(data.seedHeight) ? data.seedHeight : (Number.isInteger(n.networkHeight) ? n.networkHeight : null);

  const rows = [];

  // 1. The network as a whole - true even if this computer finds nothing.
  rows.push([
    'Network',
    verdict.producing === true ? yes('producing blocks') : verdict.producing === false ? no('no new blocks') : unknown('not known'),
    data
      ? <>newest block <b className="mono">#{data.seedHeight == null ? '—' : data.seedHeight.toLocaleString('en-US')}</b>,{' '}
          {verdict.tipAgeSec == null ? '—' : fmtAge(verdict.tipAgeSec)}
          {data.tipTimeUtc ? <span className="dim"> (at {when(Date.parse(data.tipTimeUtc))})</span> : null}</>
      : <span className="dim">{ns && ns.error ? `the SWARM status page did not answer (${ns.error})` : 'asking the SWARM status page…'}</span>
  ]);

  // 2. The tunnel, during the closed start.
  if (a.required) {
    let pill;
    let detail;
    if (!a.present) { pill = no('no access code'); detail = 'paste the access code to connect'; }
    else if (!t || t.state === 'stopped') { pill = unknown('off'); detail = 'starts with the node'; }
    else if (t.connected === true) {
      pill = yes('connected');
      detail = <>last handshake {t.handshakeAgeSec == null ? '—' : fmtAge(t.handshakeAgeSec)} · {a.machine}</>;
    } else if (t.connected === false) {
      pill = no('not connected');
      detail = t.lastError ? `no connection to the SWARM server (${t.lastError})` : 'no connection to the SWARM server';
    } else { pill = unknown('connecting'); detail = 'waiting for the SWARM server to answer'; }
    rows.push(['Tunnel', pill, detail]);
  }

  // 3. This node.
  const behind = Number.isInteger(n.height) && Number.isInteger(netHeight) ? netHeight - n.height : null;
  rows.push([
    'Your node',
    !n.running ? unknown('stopped') : n.synced === true || (behind != null && behind <= 2 && n.peers > 0) ? yes('up to date') : n.peers > 0 ? no('catching up') : no('no peers'),
    <>block <b className="mono">{n.height == null ? '—' : n.height.toLocaleString('en-US')}</b> of{' '}
      <b className="mono">{netHeight == null ? '—' : netHeight.toLocaleString('en-US')}</b> · {n.running ? `${n.peers} peer${n.peers === 1 ? '' : 's'}` : '— peers'}</>
  ]);

  // 4. This computer's mining.
  const threads = m.mode === 'shielded' ? (m.runningShieldedThreads || (m.on ? m.intensity : null)) : (m.on ? m.workers : null);
  rows.push([
    'Mining',
    m.on ? yes('mining') : m.armed || m.wanted ? unknown('waiting') : unknown('off'),
    <>{m.solps == null ? '—' : fmtSolps(m.solps)} · {threads == null ? '—' : `${threads} ${threads === 1 ? 'thread' : 'threads'}`}</>
  ]);

  // 5. What this computer found.
  const shieldedOnly = r.shieldedBlocks > 0 && !r.transparentBlocks;
  rows.push([
    'Found by this computer',
    r.blocksFound ? yes(`${r.blocksFound} block${r.blocksFound === 1 ? '' : 's'}`) : unknown('none yet'),
    <>{r.blocksFound
      ? <>last at {when(r.lastFoundAt)}{r.lastFoundHeight != null ? <> (block #{r.lastFoundHeight.toLocaleString('en-US')})</> : null}</>
      : 'no block found yet'}
      {r.blocksFound
        ? (shieldedOnly
            ? <> · <b>{fmtCoins(r.shieldedSubsidyZat, atomic)} {s.network.ticker}</b> found by this computer</>
            : <> · <b>{fmtCoins(r.totalZat, atomic)} {s.network.ticker}</b> paid to your address</>)
        : null}
      {r.orphanedBlocks ? <span className="dim"> · {r.orphanedBlocks} replaced, not counted</span> : null}</>
  ]);

  return (
    <div className="card glow">
      <div className="row">
        <h3 style={{ margin: 0 }}>Are we up?</h3>
        <div className="spacer" />
        {s.network.chainLabel ? <span className="mono tiny dim">{s.network.chainLabel}</span> : null}
      </div>
      <table className="tbl" style={{ marginTop: 10 }}>
        <tbody>
          {rows.map(([label, pill, detail]) => (
            <tr key={label}>
              <td className="muted" style={{ width: 170 }}>{label}</td>
              <td style={{ width: 150 }}>{pill}</td>
              <td className="small">{detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shieldedOnly ? (
        <p className="tiny dim" style={{ marginTop: 8, marginBottom: 0 }}>
          Your payout address is shielded, so the chain hides the amounts: this is the number of blocks
          this computer found times the miner&apos;s {s.network.ticker} per block, not your wallet balance.
          Your wallet shows what arrived.
        </p>
      ) : null}
      {s.relaunch ? (
        <p className="tiny dim" style={{ marginTop: 8, marginBottom: 0 }}>{s.relaunch.sentence}</p>
      ) : null}
    </div>
  );
}
