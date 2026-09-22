// SWARM Node — the shell.
//
// Flow: welcome -> consent -> payout -> machine check -> dashboard.
// The renderer holds no chain logic at all: it renders the state object the
// main process pushes once a second and calls back through the preload bridge.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mark, Icon, Pill } from './ui.jsx';
import { Welcome, Consent, Payout, MachineCheck } from './setup.jsx';
import { MiningView, NodeView, RewardsView, SettingsView, LogView } from './dashboard.jsx';
import { MapView } from './map.jsx';

const TABS = [
  ['mining', 'Mining', 'mine'],
  ['node', 'Node', 'node'],
  ['rewards', 'Honey', 'honey'],
  ['map', 'Swarm map', 'map'],
  ['settings', 'Settings', 'gear'],
  ['log', 'Log', 'log']
];

/**
 * Which screen does this install open on?
 *
 * The owner installed 0.2.0-testnet.2 and went straight to a dashboard,
 * never having seen the wizard. The old rule read "consent flag set AND a
 * payout address present" as "setup is done", so any profile that already
 * carried those two values — an earlier build, a copied folder, an abandoned
 * half-run — skipped the introduction silently.
 *
 * The rule now: the wizard runs unless THIS user finished it, proved by a
 * completion marker the main process stamps with the app version. Stray data
 * no longer counts as consent to skip; it is only used to pre-fill, so
 * finishing again is quick.
 */
export function firstScreen(cfg) {
  if (cfg && cfg.setupCompletedVersion) return 'dashboard';
  return 'welcome';
}

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [state, setState] = useState(null);
  const [screen, setScreen] = useState('loading');
  const [tab, setTab] = useState('mining');
  const [lines, setLines] = useState([]);
  const stopping = useRef(false);

  // ---- bridge ----
  const api = {
    startNode: () => window.engine.startNode(),
    stopNode: () => window.engine.stopNode(),
    startMining: () => window.engine.startMining(),
    stopMining: () => window.engine.stopMining(),
    armMining: (on) => window.engine.armMining(on),
    // The Mining page's primary button may need to leave the page — "add a
    // payout address" is not something that screen can do. It is routed here
    // rather than by the page, so the page never has to know about tabs.
    goToPayout: () => setTab('settings'),
    goToTab: (t) => setTab(t),
    setMiningMode: (m) => window.engine.setMiningMode(m),
    setIntensity: (n) => window.engine.setIntensity(n),
    setIdleOnly: (v) => window.engine.setIdleOnly(v),
    setPayoutAddress: (a) => window.engine.setPayoutAddress(a),
    inspectAddress: (a) => window.engine.inspectAddress(a),
    setUserOverride: (on) => window.engine.setUserOverride(on),
    setFirstNodeOverride: async (on, phrase) => {
      const r = await window.engine.setFirstNodeOverride(on, phrase);
      setCfg(await window.shell.getConfig());
      return r;
    },
    machineCheck: () => window.engine.machineCheck(),
    chooseDataFolder: async () => {
      const r = await window.shell.chooseDataFolder();
      setCfg(await window.shell.getConfig());
      return r;
    },
    setReducedMotion: async (v) => {
      await window.shell.setReducedMotion(v);
      setCfg(await window.shell.getConfig());
    }
  };

  useEffect(() => {
    let live = true;
    (async () => {
      const c = await window.shell.getConfig();
      const s = await window.engine.getState();
      const l = await window.engine.getLogs(300);
      if (!live) return;
      setCfg(c);
      setState(s);
      setLines(l || []);
      // Review hook: #shot=<screen> puts one screen on top so the capture
      // tool can photograph each in turn. It changes nothing else — the data
      // on the screen is whatever the engine really reports.
      const shot = /(?:^|#|&)shot=([a-z:]+)/.exec(window.location.hash || '');
      if (shot) {
        const [scr, tb] = shot[1].split(':');
        setScreen(scr);
        if (tb) setTab(tb);
        return;
      }
      setScreen(firstScreen(c));
    })();

    const offState = window.engine.onState((s) => setState(s));
    const offLog = window.engine.onLog((l) => setLines((prev) => [...prev.slice(-400), l]));
    return () => { live = false; offState(); offLog(); };
  }, []);

  // Reduced motion is applied to the root so the CSS rule can switch every
  // animation off for people whose OS setting alone is not enough.
  useEffect(() => {
    document.documentElement.setAttribute('data-motion', cfg?.reducedMotion ? 'off' : 'on');
  }, [cfg?.reducedMotion]);

  const stopEverything = useCallback(async () => {
    if (stopping.current) return;
    stopping.current = true;
    await window.engine.stopNode();
    stopping.current = false;
  }, []);

  if (screen === 'loading' || !cfg || !state) {
    return (
      <div className="app">
        <div className="main content center">
          <div className="row"><span className="spinner" /><span className="muted">Starting SWARM Node…</span></div>
        </div>
      </div>
    );
  }

  // ---- setup screens ----
  if (screen !== 'dashboard') {
    return (
      <div className="app">
        <div className="main">
          {cfg.testRun ? <div className="testrun-strip">TEST RUN — do not use — this window belongs to an automated check</div> : null}
          <div className="testnet-strip">
            <Mark size={16} />
            <span><b>{state.network.name}</b> · engineering testnet. Coins have no value.</span>
          </div>
          <div className="content center">
            {screen === 'welcome' ? (
              <Welcome network={cfg.network} onNext={() => setScreen('consent')} />
            ) : null}
            {screen === 'consent' ? (
              <Consent
                onBack={() => setScreen('welcome')}
                onAccept={async () => { await window.shell.setConsent(true); setCfg(await window.shell.getConfig()); setScreen('payout'); }}
              />
            ) : null}
            {screen === 'payout' ? (
              <Payout state={state} api={api} onBack={() => setScreen('consent')} onNext={() => setScreen('check')} />
            ) : null}
            {screen === 'check' ? (
              <MachineCheck
                api={api}
                dataDir={state.node.dataDir}
                onBack={() => setScreen('payout')}
                onNext={async () => {
                  // The end of the wizard, and the only thing that records it.
                  await window.shell.completeSetup();
                  setCfg(await window.shell.getConfig());
                  setScreen('dashboard');
                  setTab('mining');
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // ---- dashboard ----
  const n = state.node;
  const m = state.mining;
  const running = m.on || n.running;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <Mark size={30} />
          <div>
            <div className="brand-name">SWARM Node</div>
            <div className="brand-sub">{state.network.name}</div>
          </div>
        </div>

        <nav className="nav">
          {TABS.map(([id, label, icon]) => (
            <button key={id} className={`nav-item${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
              <Icon name={icon} />
              <span>{label}</span>
              {id === 'mining' && m.on ? <span className="nav-badge hot">ON</span> : null}
              {id === 'node' && n.running ? <span className="nav-badge">{n.peers}</span> : null}
              {id === 'rewards' && state.rewards.blocksFound ? <span className="nav-badge">{state.rewards.blocksFound}</span> : null}
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <button className="btn danger" disabled={!running} onClick={stopEverything}>■  Stop everything</button>
          <div className="tiny dim">Closing this window stops the node and the miner too.</div>
        </div>
      </aside>

      <div className="main">
        {cfg.testRun ? <div className="testrun-strip">TEST RUN — do not use — this window belongs to an automated check</div> : null}
        <div className="testnet-strip">
          <span><b>{state.network.name}</b> · engineering testnet. Coins have no value and the chain may restart.</span>
        </div>
        <header className="topbar">
          <h1>{TABS.find(([id]) => id === tab)?.[1] || 'SWARM Node'}</h1>
          <div className="topbar-right">
            {m.on ? <Pill kind="mining">mining</Pill> : null}
            {n.running
              ? (n.peers > 0
                  ? <Pill kind="ok">{n.peers} peer{n.peers === 1 ? '' : 's'}</Pill>
                  : <Pill kind="warn">no peers</Pill>)
              : <Pill kind="idle">node stopped</Pill>}
            {n.height != null ? <span className="mono dim">#{n.height.toLocaleString('en-US')}</span> : null}
          </div>
        </header>

        <div className="content">
          {tab === 'mining' ? <MiningView s={state} api={api} /> : null}
          {tab === 'node' ? <NodeView s={state} api={api} cfg={cfg} /> : null}
          {tab === 'rewards' ? <RewardsView s={state} /> : null}
          {tab === 'map' ? <MapView cfg={cfg} s={state} reducedMotion={!!cfg.reducedMotion} /> : null}
          {tab === 'settings' ? <SettingsView s={state} cfg={cfg} api={api} /> : null}
          {tab === 'log' ? <LogView lines={lines} /> : null}
        </div>
      </div>
    </div>
  );
}
