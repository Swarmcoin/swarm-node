// First run: welcome -> consent -> payout -> machine check -> dashboard.
//
// The consent screen is the one screen that must not be softened. It lists
// exactly what will run on this machine, in plain words, and the user ticks
// each item. Nothing starts before it is accepted.

import React, { useEffect, useRef, useState } from 'react';
import { Mark, Icon, Notice, fmtBytes } from './ui.jsx';

function Steps({ index }) {
  return (
    <div className="steps" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={`step-dot${i < index ? ' done' : i === index ? ' on' : ''}`} />
      ))}
    </div>
  );
}

export function Welcome({ network, onNext }) {
  return (
    <div className="setup" style={{ textAlign: 'center' }}>
      <div className="hero-mark"><Mark size={72} /></div>
      <div className="kicker" style={{ marginBottom: 10 }}>{network?.network_name || 'SWARM'} · testnet</div>
      <h1 style={{ fontSize: 40, marginBottom: 14 }}>Run a piece of the swarm</h1>
      <p className="muted" style={{ fontSize: 17, maxWidth: 540, margin: '0 auto 28px' }}>
        This app turns your computer into a full SWARM node. It keeps its own copy of the chain,
        checks every block for itself, and — when you press Start — mines with your CPU.
        Rewards go straight to your own wallet address. There is no account.
      </p>
      <div className="grid c3" style={{ textAlign: 'left', marginBottom: 28 }}>
        <div className="card flat">
          <h3>You decide</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Nothing runs until you say so, and Stop is always one click away. Closing the window
            stops everything.
          </p>
        </div>
        <div className="card flat">
          <h3>No keys here</h3>
          <p className="small muted" style={{ margin: 0 }}>
            You paste one address from the SWARM Wallet. This app never sees a seed phrase,
            a password or a private key, because it never needs one.
          </p>
        </div>
        <div className="card flat">
          <h3>Testnet coins</h3>
          <p className="small muted" style={{ margin: 0 }}>
            This is an engineering testnet. The coins have no value and the chain may be
            restarted from scratch.
          </p>
        </div>
      </div>
      <button className="btn primary big" onClick={onNext}>Get started</button>
    </div>
  );
}

const CONSENT_ITEMS = [
  {
    key: 'node',
    text: 'This app will run a full SWARM node on my computer. It downloads the chain, stores it in a folder I choose, and keeps a connection open to other nodes. That uses disk space and internet bandwidth.'
  },
  {
    key: 'miner',
    text: 'It will use my CPU to mine only while I have pressed Start. Mining stops when I press Stop, when I close the window, and when the node loses its connection to the network.'
  },
  {
    key: 'keys',
    text: 'I will paste a payout address from my own wallet. This app stores only that address — no keys, no seed phrase, no password, no email address, no account.'
  },
  {
    key: 'value',
    text: 'This is a testnet. The coins it pays have no monetary value, and nothing here is a promise of earnings.'
  },
  {
    key: 'stop',
    text: 'I can stop everything at any moment and uninstall the app normally. Nothing keeps running in the background afterwards.'
  }
];

export function Consent({ onAccept, onBack }) {
  const [checks, setChecks] = useState({});
  const all = CONSENT_ITEMS.every((i) => checks[i.key]);
  return (
    <div className="setup">
      <Steps index={0} />
      <div className="kicker">Step 1 of 4 · what this app does</div>
      <h1 style={{ margin: '10px 0 8px' }}>Exactly what will run</h1>
      <p className="muted">Nothing is hidden and nothing starts before you agree. Tick each line.</p>
      <div className="consent-list">
        {CONSENT_ITEMS.map((item) => (
          <label key={item.key} className="check">
            <input
              type="checkbox"
              checked={!!checks[item.key]}
              onChange={(e) => setChecks({ ...checks, [item.key]: e.target.checked })}
            />
            <span>{item.text}</span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 24 }}>
        <button className="btn ghost" onClick={onBack}>Back</button>
        <div className="spacer" />
        <button className="btn primary" disabled={!all} onClick={onAccept}>I agree</button>
      </div>
    </div>
  );
}

/**
 * The payout step. It replaces the entire account system: there is nothing to
 * create, nothing to remember and nothing to lose.
 *
 * Defect N-3: this used to show a spinner ("checking with your node") and a red
 * error ("the node is not answering yet") at the same time, with Continue
 * greyed out and nothing the person could do. Three rules now:
 *
 *   1. ONE state at a time. The screen shows exactly one of: nothing typed,
 *      the format is wrong, the format is right and the node has not confirmed
 *      yet, the node confirmed, the node refused.
 *   2. The format is judged OFFLINE and INSTANTLY, so Continue is available as
 *      soon as a plausible address is pasted. The node's verdict is a
 *      confirmation that arrives afterwards, not a gate on typing.
 *   3. The node check runs BY ITSELF as soon as the node is up, and keeps
 *      trying. No button to mash. If the node is not running, the step says so
 *      once and offers to start it.
 */
export function Payout({ state, onBack, onNext, api }) {
  const [value, setValue] = useState(state?.payout?.address || '');
  const [format, setFormat] = useState(null);      // offline verdict
  const [confirmed, setConfirmed] = useState(null); // the node's verdict
  const [checking, setChecking] = useState(false);
  const [startingNode, setStartingNode] = useState(false);
  const nodeRunning = !!state?.node?.running;
  const asked = useRef('');

  // Offline look, on every keystroke.
  useEffect(() => {
    let live = true;
    if (!value.trim()) { setFormat(null); setConfirmed(null); return undefined; }
    api.inspectAddress(value.trim()).then((r) => { if (live) setFormat(r); });
    setConfirmed(null);
    asked.current = '';
    return () => { live = false; };
  }, [value]);

  // Ask the node by itself, once it is up and the format is plausible. Retries
  // on its own: the node takes a few seconds to answer after it starts.
  useEffect(() => {
    const addr = value.trim();
    if (!format?.looksValid || !nodeRunning || confirmed?.ok) return undefined;
    if (asked.current === addr && checking) return undefined;
    let live = true;
    const run = async () => {
      asked.current = addr;
      setChecking(true);
      const r = await api.setPayoutAddress(addr);
      if (!live) return;
      setChecking(false);
      // A node that is not answering yet is not a verdict; try again shortly.
      if (!r.ok && /not answering yet/i.test(r.error || '')) { asked.current = ''; return; }
      setConfirmed(r);
    };
    const t = setTimeout(run, 400);
    return () => { live = false; clearTimeout(t); };
  }, [format, nodeRunning, value, confirmed]);

  // Keep retrying while the node comes up.
  useEffect(() => {
    if (!format?.looksValid || confirmed || !nodeRunning) return undefined;
    const iv = setInterval(() => { if (!checking && !confirmed) asked.current = ''; }, 4000);
    return () => clearInterval(iv);
  }, [format, confirmed, nodeRunning, checking]);

  const canContinue = !!format?.looksValid;

  return (
    <div className="setup">
      <Steps index={1} />
      <div className="kicker">Step 2 of 4 · payout</div>
      <h1 style={{ margin: '10px 0 8px' }}>Where should your honey go?</h1>
      <p className="muted">
        Open the SWARM Wallet, copy a receive address, and paste it here. The protocol pays
        rewards straight to that address — this app never holds your coins, so there is nothing
        to withdraw later.
      </p>

      <div className="card" style={{ marginTop: 20 }}>
        <label className="field">
          <span>Payout address</span>
          <input
            type="text"
            spellCheck={false}
            placeholder="tm… for standard mining, or utest… for shielded mining"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn sm" onClick={async () => {
            const r = await window.shell.readClipboard();
            if (r?.text) setValue(r.text.trim());
          }}>Paste from clipboard</button>
          <button className="btn sm ghost" onClick={() => window.shell.openWallet()}>
            <span className="row" style={{ gap: 6 }}><Icon name="wallet" size={15} /> Open SWARM Wallet</span>
          </button>
        </div>

        {/* EXACTLY ONE of the following is ever on screen. */}
        <div style={{ marginTop: 14 }}>
          {!value.trim() ? null
            : !format ? null
            : !format.looksValid ? (
              <Notice kind="bad">{format.hint}</Notice>
            ) : confirmed && confirmed.ok ? (
              <Notice kind="ok">
                <div>
                  <b>{format.label} — checked by your node ✓</b>
                  <div className="small">{confirmed.detail || format.detail}</div>
                </div>
              </Notice>
            ) : confirmed && !confirmed.ok ? (
              <Notice kind="bad">
                <div>
                  <b>Your node does not recognise that address.</b>
                  <div className="small">{confirmed.error}</div>
                </div>
              </Notice>
            ) : !nodeRunning ? (
              <Notice kind="info">
                <div style={{ width: '100%' }}>
                  <b>{format.label}. Looks right.</b>
                  <div className="small" style={{ marginTop: 4 }}>
                    {format.detail} Your node is not running, so it has not double-checked this
                    address yet. You can continue now and it will check by itself, or start the
                    node here.
                  </div>
                  <button
                    className="btn sm"
                    style={{ marginTop: 10 }}
                    disabled={startingNode}
                    onClick={async () => { setStartingNode(true); await api.startNode(); setStartingNode(false); }}
                  >{startingNode ? 'Starting…' : 'Start node'}</button>
                </div>
              </Notice>
            ) : (
              <Notice kind="info">
                <span className="spinner" />
                <span><b>{format.label}. Looks right.</b> Waiting for your node to double-check it…</span>
              </Notice>
            )}
        </div>
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        <button className="btn ghost" onClick={onBack}>Back</button>
        <div className="spacer" />
        <button className="btn primary" disabled={!canContinue} onClick={onNext}>Continue</button>
      </div>
    </div>
  );
}

/** Machine check. Everything is measured here and stays here. */
export function MachineCheck({ onBack, onNext, api, dataDir }) {
  const [report, setReport] = useState(null);

  useEffect(() => { api.machineCheck().then(setReport); }, []);

  return (
    <div className="setup">
      <Steps index={2} />
      <div className="kicker">Step 3 of 4 · this machine</div>
      <h1 style={{ margin: '10px 0 8px' }}>Can this computer run a node?</h1>
      <p className="muted">{report?.note || 'Reading what this machine has…'}</p>

      <div className="checks" style={{ marginTop: 18 }}>
        {!report ? <div className="card flat row"><span className="spinner" /><span className="muted">Checking…</span></div> : null}
        {report?.checks.map((c) => (
          <div className="check-row" key={c.key}>
            <div>
              <div className="name">{c.name} <span className="req">· needs {c.requirement}</span></div>
              <div className="found">{c.found}</div>
            </div>
            <span className={`pill ${c.result === 'pass' ? 'ok' : c.result === 'warn' ? 'warn' : 'bad'}`}>
              <span className="dot" />{c.result === 'pass' ? 'OK' : c.result === 'warn' ? 'CHECK' : 'TOO LOW'}
            </span>
          </div>
        ))}
      </div>

      <div className="card flat" style={{ marginTop: 18 }}>
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <div className="kicker">Chain folder</div>
            <div className="addr" style={{ marginTop: 6 }}>{dataDir}</div>
            {report?.freeGb != null ? <div className="tiny dim" style={{ marginTop: 4 }}>{fmtBytes(report.freeBytes)} free on that drive</div> : null}
          </div>
          <div className="spacer" />
          <button className="btn sm" onClick={() => api.chooseDataFolder()}>
            <span className="row" style={{ gap: 6 }}><Icon name="folder" size={15} /> Change</span>
          </button>
        </div>
      </div>

      {report && !report.canRunNode ? (
        <div style={{ marginTop: 16 }}>
          <Notice kind="warn">
            One of the checks is below what a node needs. You can still continue, but the node
            may be slow or run out of space.
          </Notice>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 24 }}>
        <button className="btn ghost" onClick={onBack}>Back</button>
        <div className="spacer" />
        <button className="btn primary" disabled={!report} onClick={onNext}>Go to my node</button>
      </div>
    </div>
  );
}
