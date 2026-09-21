import React, { useEffect, useRef, useState } from 'react';

// SWARM node client — the operator experience.
// Flow: welcome → consent → account → scan → main shell.
// Main shell: sidebar navigation over Dashboard / Earnings / Account /
// Settings / Help. Every engine interaction goes through window.engine
// (preload bridge); the UI is identical whether the builtin or native Go
// engine is behind it.

// The SWARM mark: many node-points implying one forward-moving form
// (docs/brand-guidelines.html §02). The lead node reads white.
const MARK_PTS = [
  [34, 10], [46, 18], [22, 18], [34, 22], [52, 28], [16, 28], [34, 32],
  [40, 40], [28, 40], [34, 44], [46, 50], [22, 50], [34, 54], [34, 64]
];

function Mark({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 68 68" aria-hidden="true">
      {MARK_PTS.map((p, i) => (
        <circle
          key={i} cx={p[0]} cy={p[1]}
          r={i === 6 ? 4.2 : i % 3 === 0 ? 3 : 2.2}
          fill={i === 6 ? '#ffffff' : '#F5A623'}
          opacity={0.55 + 0.45 * (1 - Math.abs(p[1] - 34) / 30)}
        />
      ))}
    </svg>
  );
}

const SCAN_STEPS = [
  'Detecting GPU…',
  'Reading VRAM and driver…',
  'Profiling CPU and memory…',
  'Checking network link…',
  'Assigning capability tier…'
];

function fmtEth(v) {
  return (v || 0).toFixed(6);
}

function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtWhen(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- Welcome

function Welcome({ onNext }) {
  return (
    <div className="screen center">
      <div className="hero">
        <div className="logo-mark"><Mark size={68} /></div>
        <h1>SWARM</h1>
        <p className="tagline">Power in numbers. Your machine joins thousands of others to run AI compute — and earns ETH for the work it does. Only when you allow it. Always yours to stop.</p>
        <div className="hero-points">
          <div className="point"><span className="point-icon">⏻</span><div><b>You're in control</b><br />Your machine joins only when you say so. Stop is instant and always visible.</div></div>
          <div className="point"><span className="point-icon">⬚</span><div><b>Sandboxed</b><br />Jobs run in an isolated container. They see the GPU — never your files.</div></div>
          <div className="point"><span className="point-icon">Ξ</span><div><b>Every node earns</b><br />Verified work settles in ETH on an L2, withdrawable to your wallet.</div></div>
        </div>
        <button className="btn primary big" onClick={onNext}>Join the swarm</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Consent

const CONSENT_ITEMS = [
  { key: 'compute', text: 'This app will run AI compute jobs on my GPU when I start my node, and only then.' },
  { key: 'sandbox', text: 'Jobs run inside an isolated sandbox with no access to my files or other programs.' },
  { key: 'network', text: 'The app keeps one outbound connection open to the SWARM network to receive jobs.' },
  { key: 'stop', text: 'I can pause or leave the swarm at any time with one click, and uninstall normally.' }
];

function Consent({ onAccept, onBack }) {
  const [checks, setChecks] = useState({});
  const allChecked = CONSENT_ITEMS.every((i) => checks[i.key]);

  return (
    <div className="screen center">
      <div className="panel consent">
        <h2>What this app does — exactly</h2>
        <p className="muted">Nothing runs hidden. Tick each item to confirm you understand and agree.</p>
        {CONSENT_ITEMS.map((item) => (
          <label key={item.key} className="consent-item">
            <input
              type="checkbox"
              checked={!!checks[item.key]}
              onChange={(e) => setChecks({ ...checks, [item.key]: e.target.checked })}
            />
            <span>{item.text}</span>
          </label>
        ))}
        <div className="row gap" style={{ marginTop: 24 }}>
          <button className="btn" onClick={onBack}>Back</button>
          <button className="btn primary" disabled={!allChecked} onClick={onAccept}>
            I agree — scan my machine
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Account onboarding

// Every operator needs an account before scanning: it's their network
// identity and where ETH payouts go. Create a real wallet here (key is
// encrypted with their password into a keystore on this machine; recovery
// phrase shown exactly once) — or bring an existing address (watch-only).
function AccountSetup({ onDone }) {
  const [step, setStep] = useState('wallet'); // wallet → (backup) → profile
  const [mode, setMode] = useState('create');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [importValue, setImportValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null); // { address, mnemonic }
  const [backedUp, setBackedUp] = useState(false);
  const [address, setAddress] = useState(null);
  const [email, setEmail] = useState('');
  const [availability, setAvailability] = useState('always-on');
  const [machineType, setMachineType] = useState('gaming-pc');
  const [referral, setReferral] = useState('');   // discovery (analytics)
  const [sponsor, setSponsor] = useState('');     // sponsor address (affiliate link)

  // Prefill the sponsor from a referral link the app captured at launch
  // (swarm://join?ref=0x… or a SWARM_REF env), so invitees don't type it.
  useEffect(() => {
    window.shell?.getPendingReferral?.().then((ref) => { if (ref) setSponsor(ref); });
  }, []);

  const sponsorIsAddr = /^0x[0-9a-fA-F]{40}$/.test(sponsor.trim());

  // A returning member with a wallet but no profile resumes at the profile
  // step — sign-up isn't complete until the network can reach them.
  useEffect(() => {
    window.account.get().then((acc) => {
      if (acc) {
        setAddress(acc.address);
        if (acc.email) onDone(acc.address);
        else setStep('profile');
      }
    });
  }, []);

  const importIsKey = /^(0x)?[0-9a-fA-F]{64}$/.test(importValue.trim());

  const doCreate = async () => {
    setError(null);
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    const res = await window.account.create(password);
    setBusy(false);
    res.ok ? setCreated(res) : setError(res.error);
  };

  const doImport = async () => {
    setError(null);
    setBusy(true);
    const res = await window.account.import(importValue.trim(), importIsKey ? password : undefined);
    setBusy(false);
    if (res.ok) { setAddress(res.address); setStep('profile'); setError(null); }
    else setError(res.error);
  };

  const doProfile = async () => {
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      return setError('Enter a valid email address.');
    }
    setBusy(true);
    const res = await window.account.registerOperator(email.trim(),
      { availability, machineType, discovery: referral, referral: sponsor.trim() });
    setBusy(false);
    if (res.ok) onDone(address);
    else setError(res.error || 'Could not complete sign-up.');
  };

  // Final sign-up step: who is this member, so the network can set them up.
  if (step === 'profile') {
    return (
      <div className="screen center">
        <div className="panel consent">
          <h2>Almost in — tell us about you</h2>
          <p className="muted">Your email is for payout notices, security alerts, and nothing else. The two questions help the swarm route the right work to your node.</p>
          {address && <div className="addr-box">{address}</div>}
          <label className="field-label">Email</label>
          <input className="input" type="email" placeholder="you@example.com" value={email}
                 onChange={(e) => setEmail(e.target.value)} spellCheck={false} />
          <label className="field-label">When is this machine usually available?</label>
          <select className="input" value={availability} onChange={(e) => setAvailability(e.target.value)}>
            <option value="always-on">Always on (24/7)</option>
            <option value="evenings">Mostly evenings and nights</option>
            <option value="occasional">Occasionally — when I'm not using it</option>
          </select>
          <label className="field-label">What kind of machine is it?</label>
          <select className="input" value={machineType} onChange={(e) => setMachineType(e.target.value)}>
            <option value="gaming-pc">Gaming PC</option>
            <option value="workstation">Workstation / creator rig</option>
            <option value="dedicated">Dedicated rig (built to earn)</option>
          </select>
          <label className="field-label">How did you find the swarm? (optional)</label>
          <select className="input" value={referral} onChange={(e) => setReferral(e.target.value)}>
            <option value="">Prefer not to say</option>
            <option value="friend">A friend brought me in</option>
            <option value="x">X / Twitter</option>
            <option value="discord">Discord</option>
            <option value="other">Somewhere else</option>
          </select>
          <label className="field-label">Referral code (optional)</label>
          <input className="input" placeholder="0x… your sponsor's address" value={sponsor}
                 onChange={(e) => setSponsor(e.target.value)} spellCheck={false} />
          <p className="muted small">
            {sponsor.trim()
              ? (sponsorIsAddr ? '✓ Sponsor recognised — they earn from your production, not from your share of it.'
                               : 'That doesn’t look like a wallet address — leave blank if you weren’t referred.')
              : 'Were you invited? Paste your sponsor’s payout address. It’s locked once and can’t be changed later.'}
          </p>
          {error && <p className="est warn">{error}</p>}
          <div className="row gap" style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={busy} onClick={doProfile}>
              {busy ? 'Joining…' : 'Join the swarm'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Backup step after creating: the phrase is shown once, never stored.
  if (created) {
    return (
      <div className="screen center">
        <div className="panel consent">
          <h2>Back up your recovery phrase</h2>
          <p className="muted">This phrase is the only way to recover your wallet. It is shown once and never stored by this app. Write it down and keep it offline.</p>
          <div className="addr-box">{created.address}</div>
          <div className="mnemonic-box">{created.mnemonic}</div>
          <label className="consent-item">
            <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
            <span>I wrote down my recovery phrase and understand it cannot be recovered for me.</span>
          </label>
          <div className="row gap" style={{ marginTop: 24 }}>
            <button className="btn primary" disabled={!backedUp} onClick={() => { setAddress(created.address); setStep('profile'); }}>
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen center">
      <div className="panel consent">
        <h2>Create your account</h2>
        <p className="muted">Your account is the wallet your earnings are paid to. Verified work settles in ETH on an L2 to this address.</p>
        <div className="tabs">
          <button className={`tab ${mode === 'create' ? 'active' : ''}`} onClick={() => { setMode('create'); setError(null); }}>Create new wallet</button>
          <button className={`tab ${mode === 'import' ? 'active' : ''}`} onClick={() => { setMode('import'); setError(null); }}>Use existing</button>
        </div>

        {mode === 'create' ? (
          <>
            <p className="muted small">A real Ethereum wallet is generated on this machine. The private key is encrypted with your password (standard V3 keystore) and never leaves your computer.</p>
            <input className="input" type="password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
            <input className="input" type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {error && <p className="est warn">{error}</p>}
            <div className="row gap" style={{ marginTop: 16 }}>
              <button className="btn primary" disabled={busy} onClick={doCreate}>
                {busy ? 'Encrypting keystore…' : 'Create wallet'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">Paste an ETH address (watch-only payout target, checksum-validated) or a private key (encrypted into a local keystore).</p>
            <input className="input" placeholder="0x address or private key" value={importValue} onChange={(e) => setImportValue(e.target.value)} spellCheck={false} />
            {importIsKey && (
              <input className="input" type="password" placeholder="Password to encrypt the key (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
            {error && <p className="est warn">{error}</p>}
            <div className="row gap" style={{ marginTop: 16 }}>
              <button className="btn primary" disabled={busy || !importValue.trim()} onClick={doImport}>
                {busy ? 'Importing…' : 'Use this account'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Scan

function Scan({ onDone }) {
  const [step, setStep] = useState(0);
  const [hw, setHw] = useState(null);

  useEffect(() => {
    let alive = true;
    const stepTimer = setInterval(() => {
      setStep((s) => Math.min(s + 1, SCAN_STEPS.length - 1));
    }, 700);
    window.engine.scan().then((result) => {
      if (!alive) return;
      clearInterval(stepTimer);
      setStep(SCAN_STEPS.length - 1);
      setHw(result);
    });
    return () => { alive = false; clearInterval(stepTimer); };
  }, []);

  return (
    <div className="screen center">
      <div className="panel scan">
        {!hw ? (
          <>
            <div className="spinner" />
            <h2>Scanning your machine</h2>
            <p className="muted">{SCAN_STEPS[step]}</p>
          </>
        ) : (
          <>
            <h2>Scan complete</h2>
            <div className="hw-grid">
              <div className="hw-cell"><span className="hw-label">GPU</span><span className="hw-value">{hw.gpu}</span></div>
              <div className="hw-cell"><span className="hw-label">VRAM</span><span className="hw-value">{hw.vramGb} GB</span></div>
              <div className="hw-cell"><span className="hw-label">CPU</span><span className="hw-value">{hw.cpu}</span></div>
              <div className="hw-cell"><span className="hw-label">RAM</span><span className="hw-value">{hw.ramGb} GB</span></div>
              <div className="hw-cell"><span className="hw-label">Network</span><span className="hw-value">{hw.online ? 'Online' : 'Offline'}</span></div>
              <div className="hw-cell"><span className="hw-label">Tier</span><span className="hw-value tier">{hw.tier}</span></div>
            </div>
            {hw.eligible ? (
              <p className="est">Your node is eligible. You're paid per verified job — earnings depend on how much work the swarm routes to your tier and how often your machine is available.</p>
            ) : (
              <p className="est warn">This GPU is below the network minimum — you can still install, but jobs won't be assigned yet.</p>
            )}
            <button className="btn primary big" onClick={() => onDone(hw)}>Open dashboard</button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Dashboard view

function PerfBar({ label, value, max, unit, warnAt }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="perf-row">
      <span className="perf-label">{label}</span>
      <div className="perf-bar"><i style={{ width: `${pct}%` }} className={warnAt && value >= warnAt ? 'hot' : ''} /></div>
      <span className="perf-value">{value}{unit}</span>
    </div>
  );
}

function DashboardView({ status, earnings, hw, onNav }) {
  const startStop = async () => {
    status.running ? await window.engine.stop() : await window.engine.start();
  };
  const pauseResume = async () => {
    status.paused ? await window.engine.resume() : await window.engine.pause();
  };
  const perf = status.perf;

  return (
    <div className="grid">
      {status.engine === 'builtin' && (
        <section className="panel span2" style={{ borderColor: '#5C3C12', background: '#1a1407' }}>
          <strong style={{ color: '#F5A623' }}>⚠ Simulation mode — not on the network</strong>
          <p style={{ color: '#c8b080', fontSize: 13, margin: '6px 0 0' }}>
            The native compute engine isn&apos;t running, so this machine is <b>not connected and not earning</b>.
            Windows likely blocked the unsigned engine — add the SWARM install folder to Windows Defender
            exclusions and relaunch, or check <b>Help → Show logs</b>.
          </p>
        </section>
      )}
      {status.engine === 'native' && (
        <section className="panel span2" style={{ borderColor: '#16361f', background: '#0c1f13' }}>
          <strong style={{ color: '#3FB950' }}>● Engine connected — real compute on the SWARM network</strong>
        </section>
      )}
      <section className="panel span2">
        <h3>Earnings</h3>
        <div className="earn-row">
          <div className="earn-main">
            <div className="eth">{fmtEth(earnings.totalEth)} <span className="unit">ETH</span></div>
            <button className="btn primary" onClick={() => onNav('earnings')}>Earnings &amp; withdraw</button>
          </div>
          <div className="earn-stats">
            <div className="stat"><span className="stat-label">Session uptime</span><span className="stat-value">{fmtUptime(earnings.sessionUptime)}</span></div>
            <div className="stat"><span className="stat-label">Jobs completed</span><span className="stat-value">{earnings.jobsCompleted}</span></div>
            <div className="stat"><span className="stat-label">Verified rate</span><span className="stat-value">{Math.round(earnings.verifiedRate * 100)}%</span></div>
          </div>
        </div>
      </section>

      <section className="panel control-panel">
        <button className={`btn-power ${status.running ? 'on' : ''}`} onClick={startStop}>
          <span className="power-icon">⏻</span>
          {status.running ? 'STOP' : 'START'}
        </button>
        {status.running && (
          <button className="btn pause-btn" onClick={pauseResume}>
            {status.paused ? '▶ Resume jobs' : '❚❚ Pause new jobs'}
          </button>
        )}
        <p className="muted small center-text">
          {!status.running
            ? 'Nothing is running. Start to begin accepting jobs.'
            : status.paused
              ? 'Paused — the current job finishes, no new jobs are taken.'
              : 'Your node is accepting jobs. Stop halts all compute instantly.'}
        </p>
      </section>

      <section className="panel span2">
        <h3>Current job</h3>
        {status.currentJob ? (
          <div className="job">
            <div className="row spread">
              <span className="job-type">{status.currentJob.type}</span>
              <span className="muted">{status.currentJob.id}</span>
            </div>
            <div className="progress"><div className="progress-fill" style={{ width: `${status.currentJob.progress}%` }} /></div>
            <div className="muted small">{status.currentJob.progress}%</div>
          </div>
        ) : (
          <p className="muted">
            {!status.running ? 'Node is stopped — no jobs run while stopped.'
              : status.paused ? 'Paused — not taking new jobs.'
              : 'Waiting for next job…'}
          </p>
        )}
      </section>

      <section className="panel">
        <h3>Performance</h3>
        {perf ? (
          <>
            <PerfBar label="GPU" value={perf.gpuUtil} max={100} unit="%" warnAt={95} />
            <PerfBar label="VRAM" value={Number(perf.vramUsedGb.toFixed(1))} max={perf.vramTotalGb} unit={` / ${perf.vramTotalGb.toFixed(0)} GB`} />
            <PerfBar label="Temp" value={perf.tempC} max={95} unit="°C" warnAt={84} />
            <PerfBar label="Power" value={Math.round(perf.powerW)} max={180} unit=" W" />
          </>
        ) : (
          <p className="muted small">Live GPU readout appears while the node runs.</p>
        )}
      </section>

      <section className="panel span3">
        <h3>Your machine</h3>
        {hw ? (
          <div className="hw-grid wide">
            <div className="hw-cell"><span className="hw-label">GPU</span><span className="hw-value">{hw.gpu}</span></div>
            <div className="hw-cell"><span className="hw-label">VRAM</span><span className="hw-value">{hw.vramGb} GB</span></div>
            <div className="hw-cell"><span className="hw-label">CPU</span><span className="hw-value">{hw.cpu}</span></div>
            <div className="hw-cell"><span className="hw-label">Cores</span><span className="hw-value">{hw.cores}</span></div>
            <div className="hw-cell"><span className="hw-label">RAM</span><span className="hw-value">{hw.ramGb} GB</span></div>
            <div className="hw-cell"><span className="hw-label">Tier</span><span className="hw-value tier">{hw.tier}</span></div>
          </div>
        ) : <p className="muted">Loading…</p>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Earnings view

function EarningsView({ earnings, account }) {
  const [history, setHistory] = useState([]);
  const [claims, setClaims] = useState([]);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState(null);
  const [operator, setOperator] = useState(null);

  const load = () => {
    window.engine.getHistory().then((h) => setHistory((h || []).slice().reverse()));
    window.shell.getClaims().then((c) => setClaims((c || []).slice().reverse()));
    window.shell.getOperator().then(setOperator);
  };
  useEffect(load, [earnings.jobsCompleted]);

  const doWithdraw = async () => {
    const res = await window.engine.withdraw('');
    setWithdrawResult(res);
    setTimeout(load, 800);
  };

  const kindLabel = { credit: 'Job paid', reject: 'Rejected (unpaid)', withdraw: 'Withdrawal claim' };

  return (
    <div className="grid">
      <section className="panel span2">
        <h3>Balance</h3>
        <div className="earn-row">
          <div className="earn-main">
            <div className="eth">{fmtEth(earnings.totalEth)} <span className="unit">ETH</span></div>
            <button className="btn primary" onClick={() => { setWithdrawResult(null); setShowWithdraw(true); }}>
              Withdraw to wallet
            </button>
          </div>
          <div className="earn-stats">
            <div className="stat"><span className="stat-label">Lifetime (account)</span><span className="stat-value">{fmtEth(operator?.earnings?.earnedEth)}</span></div>
            <div className="stat"><span className="stat-label">Jobs verified</span><span className="stat-value">{operator?.earnings?.jobsVerified ?? '—'}</span></div>
          </div>
        </div>
      </section>

      <section className="panel">
        <h3>Payouts (on-chain)</h3>
        {claims.length ? (
          <div className="scrolly">
            {claims.map((c) => (
              <div key={c.id} className="hist-row">
                <div>
                  <div className="hist-main">{fmtEth(c.amountEth)} ETH</div>
                  <div className="muted small">{fmtWhen(c.requestedAt)}</div>
                </div>
                <div className="hist-right">
                  <span className={`pillet ${c.status}`}>{c.status}</span>
                  {c.txHash && <div className="muted small mono" title={c.txHash}>{c.txHash.slice(0, 12)}…</div>}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted small">No withdrawals yet.</p>}
      </section>

      <section className="panel span3">
        <div className="row spread">
          <h3>Earn history</h3>
          <button className="btn sm-btn" onClick={load}>Refresh</button>
        </div>
        {history.length ? (
          <div className="scrolly tall">
            {history.map((h, i) => (
              <div key={i} className="hist-row">
                <div>
                  <div className="hist-main">{kindLabel[h.kind] || h.kind}{h.jobId ? ` · ${h.jobId}` : ''}</div>
                  <div className="muted small">{fmtWhen(h.at)}</div>
                </div>
                <div className={`hist-amount ${h.kind}`}>
                  {h.kind === 'withdraw' ? '−' : h.kind === 'credit' ? '+' : ''}{fmtEth(h.eth)} ETH
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted small">No events this session yet — earnings events appear here as jobs verify.</p>}
      </section>

      {showWithdraw && (
        <div className="modal-backdrop" onClick={() => setShowWithdraw(false)}>
          <div className="panel modal" onClick={(e) => e.stopPropagation()}>
            <h3>Withdraw {fmtEth(earnings.totalEth)} ETH</h3>
            <p className="muted small">Claims settle in batched on-chain ETH payments to your account wallet. Your wallet must hold a SWARM Node Right.</p>
            {account && <div className="addr-box">{account.address}</div>}
            {withdrawResult && (
              <p className={withdrawResult.ok ? 'est' : 'est warn'}>
                {withdrawResult.ok
                  ? `Claim sent: ${fmtEth(withdrawResult.amount)} ETH. ${withdrawResult.note || ''}`
                  : withdrawResult.error}
              </p>
            )}
            <div className="row gap" style={{ marginTop: 16 }}>
              <button className="btn" onClick={() => setShowWithdraw(false)}>Close</button>
              <button className="btn primary" onClick={doWithdraw}>Withdraw</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Account view

function AccountView({ account, onSignOut }) {
  const [nft, setNft] = useState(null);
  const [operator, setOperator] = useState(null);
  const [machine, setMachine] = useState(null);
  const [copied, setCopied] = useState('');

  const [showExport, setShowExport] = useState(false);
  const [exportPw, setExportPw] = useState('');
  const [exportResult, setExportResult] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const closeExport = () => {
    // Clear the secret from memory/state on close.
    setShowExport(false); setExportPw(''); setExportResult(null); setRevealed(false);
  };
  const doExport = async () => {
    setExportBusy(true);
    const res = await window.account.exportKey(exportPw);
    setExportBusy(false);
    setExportResult(res);
  };

  const signOut = async () => {
    const ok = window.confirm(
      'Sign out of this account?\n\n' +
      'Your node will stop and the app returns to the welcome screen. To use ' +
      'this same wallet again, make sure you have its recovery phrase or ' +
      'private key saved — that is the only way back in. Sign out?'
    );
    if (!ok) return;
    await window.account.signOut();
    onSignOut();
  };

  useEffect(() => {
    window.shell.getNftStatus().then(setNft);
    window.shell.getOperator().then(setOperator);
    window.engine.getMachineId().then(setMachine);
  }, []);

  const copyText = (text, tag) => {
    navigator.clipboard.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(''), 1500);
  };
  const copy = () => copyText(account.address, 'addr');

  if (!account) return <p className="muted">No account yet.</p>;

  const modeLabel = { created: 'Created in this app (keystore on this machine)', imported: 'Imported private key (keystore on this machine)', 'watch-only': 'Watch-only payout address' };

  return (
    <div className="grid">
      <section className="panel span2">
        <h3>Wallet</h3>
        <div className="addr-box">{account.address}</div>
        <div className="row gap">
          <button className="btn sm-btn" onClick={copy}>{copied === 'addr' ? 'Copied ✓' : 'Copy address'}</button>
        </div>
        <div className="kv"><span>Type</span><b>{modeLabel[account.mode] || account.mode}</b></div>
        <div className="kv"><span>Created</span><b>{account.createdAt ? fmtWhen(Date.parse(account.createdAt)) : '—'}</b></div>
        {account.hasKeystore && (
          <p className="muted small" style={{ marginTop: 10 }}>
            Your encrypted keystore lives in the app data folder (Settings → Open data folder). Back it up — together with your password it is your wallet.
          </p>
        )}
        <div className="row gap" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn sm-btn" onClick={() => window.shell.openWeb()}>Open web dashboard ↗</button>
          {account.hasKeystore && (
            <button className="btn sm-btn" onClick={() => { setExportResult(null); setExportPw(''); setRevealed(false); setShowExport(true); }}>
              Export private key
            </button>
          )}
          <button className="btn sm-btn danger-btn" onClick={signOut}>Sign out</button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          The web dashboard uses this same wallet — connect <span className="mono-sm">{account.address.slice(0, 8)}…</span> there and you're the same member across both apps.
        </p>
      </section>

      <section className="panel">
        <h3>License</h3>
        {nft === null ? <p className="muted small">Checking…</p> : nft?.hasNodeRight ? (
          <>
            <div className="big-badge ok">✓ ACTIVE</div>
            <p className="muted small">This wallet holds a SWARM Node Right license — your node receives jobs and your withdrawals settle.</p>
          </>
        ) : (
          <>
            <div className="big-badge bad">NO LICENSE</div>
            <p className="muted small">No license found for this wallet (or the network is unreachable). Buy and activate a node license in the web app, then activate this machine below.</p>
          </>
        )}
      </section>

      <section className="panel span3">
        <h3>This machine</h3>
        <p className="muted small">To license this machine: open the SWARM web app, buy a node, then paste this machine fingerprint on the Nodes page to bind your license to it.</p>
        {machine ? (
          <>
            <div className="addr-box">{machine.fingerprint}</div>
            <div className="row gap">
              <button className="btn sm-btn" onClick={() => copyText(machine.fingerprint, 'fp')}>
                {copied === 'fp' ? 'Copied ✓' : 'Copy machine fingerprint'}
              </button>
            </div>
            <div className="kv"><span>On-chain machine hash</span><b className="mono-sm">{machine.machineHash ? machine.machineHash.slice(0, 18) + '…' : '—'}</b></div>
          </>
        ) : <p className="muted small">Reading machine identity…</p>}
      </section>

      <section className="panel span3">
        <h3>Member profile</h3>
        {operator ? (
          <>
            <div className="kv"><span>Email</span><b>{operator.email}</b></div>
            <div className="kv"><span>Availability</span><b>{operator.profile?.availability || '—'}</b></div>
            <div className="kv"><span>Machine</span><b>{operator.profile?.machineType || '—'}</b></div>
            <div className="kv"><span>Member since</span><b>{operator.createdAt ? fmtWhen(operator.createdAt) : '—'}</b></div>
            <div className="kv"><span>Lifetime earnings</span><b>{fmtEth(operator.earnings?.earnedEth)} ETH · {operator.earnings?.jobsVerified ?? 0} verified jobs</b></div>
          </>
        ) : <p className="muted small">Profile unavailable — the network can't be reached right now.</p>}
      </section>

      {showExport && (
        <div className="modal-backdrop" onClick={closeExport}>
          <div className="panel modal" onClick={(e) => e.stopPropagation()}>
            <h3>Export private key</h3>
            {!exportResult?.ok ? (
              <>
                <p className="est warn" style={{ marginTop: 0 }}>
                  ⚠ Anyone with your private key controls this wallet and everything in it. Never share it, never paste it into a website, and never store it where others can read it.
                </p>
                <p className="muted small">Enter your wallet password to decrypt and reveal the key.</p>
                <input
                  className="input" type="password" placeholder="Wallet password"
                  value={exportPw} onChange={(e) => setExportPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && exportPw) doExport(); }}
                  autoFocus
                />
                {exportResult && !exportResult.ok && <p className="est warn">{exportResult.error}</p>}
                <div className="row gap" style={{ marginTop: 16 }}>
                  <button className="btn" onClick={closeExport}>Cancel</button>
                  <button className="btn primary" disabled={!exportPw || exportBusy} onClick={doExport}>
                    {exportBusy ? 'Decrypting…' : 'Reveal private key'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted small">Private key for <span className="mono-sm">{exportResult.address.slice(0, 10)}…</span>. Keep it offline and safe.</p>
                <label className="field-label">Private key</label>
                <div className="addr-box" style={{ filter: revealed ? 'none' : 'blur(6px)', userSelect: revealed ? 'text' : 'none' }}>
                  {exportResult.privateKey}
                </div>
                <div className="row gap">
                  <button className="btn sm-btn" onClick={() => setRevealed(!revealed)}>{revealed ? 'Hide' : 'Reveal'}</button>
                  <button className="btn sm-btn" onClick={() => navigator.clipboard.writeText(exportResult.privateKey)}>Copy key</button>
                </div>
                {exportResult.mnemonic && (
                  <>
                    <label className="field-label">Recovery phrase</label>
                    <div className="mnemonic-box" style={{ filter: revealed ? 'none' : 'blur(6px)' }}>{exportResult.mnemonic}</div>
                  </>
                )}
                <div className="row gap" style={{ marginTop: 16 }}>
                  <button className="btn primary" onClick={closeExport}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Settings view

function SettingsView({ idleOnly, throttle, onIdleOnly, onThrottle }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { window.shell.getAppInfo().then(setInfo); }, []);

  return (
    <div className="grid">
      <section className="panel span2">
        <h3>Node behavior</h3>
        <label className="ctl-row">
          <span>Only run when I'm away (idle mode)</span>
          <input type="checkbox" checked={idleOnly} onChange={(e) => onIdleOnly(e.target.checked)} />
        </label>
        <div className="ctl-row col">
          <span>GPU limit: <b>{throttle}%</b> <span className="muted small">— lower is quieter and cooler, higher earns more</span></span>
          <input type="range" min="0" max="100" value={throttle} onChange={(e) => onThrottle(Number(e.target.value))} />
        </div>
        <p className="muted small">Pause (on the Dashboard) finishes the current job and takes no new ones. Stop halts all compute instantly.</p>
      </section>

      <section className="panel">
        <h3>App</h3>
        {info && (
          <>
            <div className="kv"><span>Version</span><b>{info.version}</b></div>
            <div className="kv"><span>Electron</span><b>{info.electron}</b></div>
            <div className="kv"><span>Network</span><b className="mono-sm">{info.dispatchUrl}</b></div>
          </>
        )}
        <button className="btn sm-btn" style={{ marginTop: 12 }} onClick={() => window.shell.openDataFolder()}>
          Open data folder
        </button>
        <p className="muted small" style={{ marginTop: 8 }}>Holds your config and encrypted keystore. Back it up.</p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Help view

const FAQ = [
  { q: 'What exactly runs on my machine?', a: 'AI compute jobs from the SWARM network, only while your node is started. Third-party workloads run inside an isolated Docker container with no network access and no view of your files — they see the GPU and a per-job folder, nothing else. The container is destroyed after every job.' },
  { q: 'How am I paid?', a: 'You earn 70% of every verified job\'s price, credited to your account. "Withdraw" sends a claim to the network; settlement pays claims in batched on-chain ETH to your wallet. Your wallet must hold a SWARM Node Right.' },
  { q: 'What is a Node Right?', a: 'An NFT held by your wallet that marks you as a member. Jobs are only routed to — and payouts only settle to — wallets that hold one.' },
  { q: 'What\'s the difference between Pause and Stop?', a: 'Pause finishes the current job and accepts no new ones (you stay connected). Stop halts all compute instantly, including a job in progress (it goes unpaid and is reassigned).' },
  { q: 'Why is my balance zero after withdrawing?', a: 'Withdrawing converts your balance into a claim. It appears under Earnings → Payouts with its status, and the transaction hash once paid on-chain.' },
  { q: 'Does this slow down my computer?', a: 'Use the GPU limit in Settings to cap how hard jobs drive your GPU, and idle mode to only work when you\'re away. Stop is always one click.' }
];

function HelpView() {
  const [open, setOpen] = useState(null);
  const [logs, setLogs] = useState(null);
  const [showLogs, setShowLogs] = useState(false);

  const loadLogs = () => window.engine.getLogs().then((l) => setLogs(l || []));

  return (
    <div className="grid">
      <section className="panel span2">
        <h3>Frequently asked</h3>
        {FAQ.map((f, i) => (
          <div key={i} className="faq-item" onClick={() => setOpen(open === i ? null : i)}>
            <div className="faq-q">{open === i ? '▾' : '▸'} {f.q}</div>
            {open === i && <div className="faq-a">{f.a}</div>}
          </div>
        ))}
      </section>

      <section className="panel">
        <h3>Support</h3>
        <p className="muted small">Something not working? The engine log usually says why.</p>
        <button className="btn sm-btn" onClick={() => { setShowLogs(!showLogs); if (!showLogs) loadLogs(); }}>
          {showLogs ? 'Hide logs' : 'Show logs'}
        </button>
      </section>

      {showLogs && (
        <section className="panel span3">
          <div className="row spread">
            <h3>Engine log</h3>
            <button className="btn sm-btn" onClick={loadLogs}>Refresh</button>
          </div>
          <pre className="logbox">{logs === null ? 'Loading…' : logs.length ? logs.join('\n') : 'No log lines yet.'}</pre>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Network view
// The affiliate side: your referral link, downline, rank progress, and the
// commission income your network produces — paid on the same rail as earnings.

function NetworkView({ account }) {
  const [aff, setAff] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = () => { window.shell.getAffiliate().then(setAff); };
  useEffect(load, [account?.address]);

  const link = account ? `swarm://join?ref=${account.address}` : '';
  const copy = async () => {
    await window.shell.copy(link);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const cur = Number(aff?.downlineRevenueUsd) || 0;
  const next = aff?.nextRank;
  const pct = next ? Math.min(100, Math.round((cur / next.thresholdUsd) * 100)) : 100;

  return (
    <div className="grid">
      <section className="panel span2">
        <h3>Your referral link</h3>
        <p className="muted small">Anyone who joins with your link becomes part of your downline. You earn a slice every time their machine produces — never out of your own share.</p>
        {account
          ? <div className="addr-box" style={{ wordBreak: 'break-all' }}>{link}</div>
          : <p className="muted">Sign in to get your link.</p>}
        <div className="row gap" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={!account} onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
          <button className="btn sm-btn" onClick={load}>Refresh</button>
        </div>
      </section>

      <section className="panel">
        <h3>Rank</h3>
        <div className="eth" style={{ fontSize: 28 }}>{aff?.rank || 'Unranked'}</div>
        {next ? (
          <>
            <div className="muted small" style={{ marginTop: 8 }}>
              {usd(cur)} of {usd(next.thresholdUsd)} downline revenue → <b>{next.name}</b> ({(next.rate * 100).toFixed(1)}%)
            </div>
            <div style={{ height: 8, background: 'var(--bg)', borderRadius: 99, marginTop: 8, overflow: 'hidden', border: '1px solid var(--panel-edge)' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
          </>
        ) : <div className="muted small" style={{ marginTop: 8 }}>Top rank reached — 2.5% on your whole downline.</div>}
      </section>

      <section className="panel">
        <h3>Direct referrals</h3>
        <div className="eth" style={{ fontSize: 30 }}>{aff?.directs ?? '—'}</div>
      </section>
      <section className="panel">
        <h3>Total downline</h3>
        <div className="eth" style={{ fontSize: 30 }}>{aff?.downline ?? '—'}</div>
      </section>
      <section className="panel">
        <h3>Affiliate income</h3>
        <div className="eth" style={{ fontSize: 30 }}>{fmtEth(aff?.lifetimeEarnedEth)} <span className="unit">ETH</span></div>
        <div className="muted small" style={{ marginTop: 6 }}>Paid into your balance — withdraw it with your earnings.</div>
      </section>

      <section className="panel span3">
        <h3>How you earn from your network</h3>
        <div className="hw-row" style={{ marginTop: 4 }}>
          <div className="hw-cell"><span className="hw-label">Production</span><span className="hw-value">15% of a downline node's share, 10 levels up</span></div>
          <div className="hw-cell"><span className="hw-label">Rewards</span><span className="hw-value">A slice of pool & staking rewards</span></div>
          <div className="hw-cell"><span className="hw-label">Rank bonus</span><span className="hw-value">Up to 2.5% of your whole downline's revenue</span></div>
        </div>
        {aff?.sponsor && (
          <p className="muted small" style={{ marginTop: 14 }}>
            Your sponsor: <span className="mono">{aff.sponsor.slice(0, 10)}…{aff.sponsor.slice(-6)}</span>
          </p>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Main shell

const NAV = [
  { key: 'dashboard', label: 'Dashboard', icon: '▣' },
  { key: 'earnings', label: 'Earnings', icon: 'Ξ' },
  { key: 'network', label: 'Network', icon: '⬡' },
  { key: 'account', label: 'Account', icon: '◇' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
  { key: 'help', label: 'Help', icon: '?' }
];

function MainShell({ hardware, onSignOut }) {
  const [view, setView] = useState('dashboard');
  const [status, setStatus] = useState({ running: false, paused: false, online: false, currentJob: null, perf: null });
  const [earnings, setEarnings] = useState({ totalEth: 0, sessionUptime: 0, jobsCompleted: 0, verifiedRate: 1 });
  const [account, setAccount] = useState(null);
  const [hw, setHw] = useState(hardware);
  const [idleOnly, setIdleOnly] = useState(true);
  const [throttle, setThrottle] = useState(80);
  const throttleDebounce = useRef(null);

  useEffect(() => {
    window.shell.getConfig().then((cfg) => {
      setIdleOnly(cfg.idleOnly !== false);
      setThrottle(typeof cfg.throttle === 'number' ? cfg.throttle : 80);
    });
    window.account.get().then(setAccount);
    if (!hw) window.engine.getHardware().then(setHw);
    window.engine.getStatus().then(setStatus);
    window.engine.getEarnings().then(setEarnings);
    const unsub = window.engine.onState((state) => {
      if (state.status) setStatus(state.status);
      if (state.earnings) setEarnings(state.earnings);
    });
    return unsub;
  }, []);

  const onIdleOnly = (v) => { setIdleOnly(v); window.engine.setIdleOnly(v); };
  const onThrottle = (v) => {
    setThrottle(v);
    clearTimeout(throttleDebounce.current);
    throttleDebounce.current = setTimeout(() => window.engine.setThrottle(v), 200);
  };

  const pillState = !status.running ? 'off' : status.paused ? 'paused' : 'on';
  const pillText = !status.running ? 'STOPPED' : status.paused ? 'PAUSED' : 'EARNING';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand side"><Mark size={24} /> <span>SWARM</span></div>
        {NAV.map((n) => (
          <button key={n.key} className={`nav-item ${view === n.key ? 'active' : ''}`} onClick={() => setView(n.key)}>
            <span className="nav-icon">{n.icon}</span> {n.label}
          </button>
        ))}
        <div className="sidebar-foot">
          {account && (
            <div className="account-chip" title={account.address}>
              Ξ {account.address.slice(0, 6)}…{account.address.slice(-4)}
            </div>
          )}
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <h2 className="view-title">{NAV.find((n) => n.key === view)?.label}</h2>
          <div className={`status-pill ${pillState}`}>
            <span className="dot" /> {pillText}
          </div>
        </header>

        {view === 'dashboard' && <DashboardView status={status} earnings={earnings} hw={hw} onNav={setView} />}
        {view === 'earnings' && <EarningsView earnings={earnings} account={account} />}
        {view === 'network' && <NetworkView account={account} />}
        {view === 'account' && <AccountView account={account} onSignOut={onSignOut} />}
        {view === 'settings' && <SettingsView idleOnly={idleOnly} throttle={throttle} onIdleOnly={onIdleOnly} onThrottle={onThrottle} />}
        {view === 'help' && <HelpView />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- App

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [hardware, setHardware] = useState(null);

  useEffect(() => {
    Promise.all([window.shell.getConfig(), window.account.get()]).then(([cfg, acc]) => {
      if (!cfg.consented) setScreen('welcome');
      else if (!acc || !acc.email) setScreen('account'); // wallet or profile still missing
      else setScreen('scan');
    });
  }, []);

  if (screen === 'loading') return <div className="screen center"><div className="spinner" /></div>;
  if (screen === 'welcome') return <Welcome onNext={() => setScreen('consent')} />;
  if (screen === 'consent') {
    return (
      <Consent
        onBack={() => setScreen('welcome')}
        onAccept={async () => { await window.shell.setConsent(true); setScreen('account'); }}
      />
    );
  }
  if (screen === 'account') return <AccountSetup onDone={() => setScreen('scan')} />;
  if (screen === 'scan') return <Scan onDone={(hw) => { setHardware(hw); setScreen('dashboard'); }} />;
  return <MainShell hardware={hardware} onSignOut={() => { setHardware(null); setScreen('account'); }} />;
}
