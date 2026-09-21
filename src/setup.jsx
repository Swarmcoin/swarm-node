// First run: welcome -> consent -> payout -> machine check -> dashboard.
//
// The consent screen is the one screen that must not be softened. It lists
// exactly what will run on this machine, in plain words, and the user ticks
// each item. Nothing starts before it is accepted.

import React, { useEffect, useState } from 'react';
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
 * create, nothing to remember and nothing to lose. The address is checked by
 * asking the local node, so this app contains no address-parsing code.
 */
export function Payout({ state, onBack, onNext, api }) {
  const [value, setValue] = useState(state?.payout?.address || '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const nodeRunning = state?.node?.running;

  useEffect(() => {
    if (!nodeRunning) api.startNode();
  }, [nodeRunning]);

  async function check() {
    setBusy(true);
    setResult(null);
    const r = await api.setPayoutAddress(value.trim());
    setResult(r);
    setBusy(false);
  }

  const kindLabel = result?.kind === 'transparent'
    ? 'Transparent address — standard mining, all CPU cores'
    : result?.kind === 'unified'
      ? 'Unified address — shielded mining, one core'
      : null;

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
          <div className="spacer" />
          <button className="btn primary sm" disabled={!value.trim() || busy} onClick={check}>
            {busy ? 'Asking the node…' : 'Check this address'}
          </button>
        </div>

        {!nodeRunning ? (
          <div style={{ marginTop: 14 }}>
            <Notice kind="info">
              <span className="spinner" />
              <span>Starting your node — the address is checked by the node itself, so it has to be running first.</span>
            </Notice>
          </div>
        ) : null}

        {result && result.ok ? (
          <div style={{ marginTop: 14 }}>
            <Notice kind="ok"><div><b>{kindLabel}</b><div className="small">{result.detail}</div></div></Notice>
          </div>
        ) : null}
        {result && !result.ok ? (
          <div style={{ marginTop: 14 }}><Notice kind="bad">{result.error}</Notice></div>
        ) : null}
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        <button className="btn ghost" onClick={onBack}>Back</button>
        <div className="spacer" />
        <button className="btn primary" disabled={!(result && result.ok)} onClick={onNext}>Continue</button>
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
