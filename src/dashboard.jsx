// The running app: mining, node, rewards, settings, log.
//
// Every figure on these screens comes from the chain, from a miner's own
// output, or from this machine. Anything unknown renders as "—". There are no
// estimates, no per-day projections and no fiat values anywhere.

import React, { useEffect, useRef, useState } from 'react';
import { Icon, Pill, Metric, Notice, Switch, fmtCoins, fmtBytes, fmtDuration, fmtAge, fmtSolps, shortHash } from './ui.jsx';

// ---------------------------------------------------------------- mining
export function MiningView({ s, api }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const m = s.mining;
  const g = s.gate;
  const atomic = s.rewards.atomicPerCoin;

  async function toggle() {
    setBusy(true);
    setErr(null);
    const r = m.on ? await api.stopMining() : await api.startMining();
    if (r && r.ok === false) setErr(r.error);
    setBusy(false);
  }

  const canStart = g.allow && !busy;

  return (
    <div className="stack-lg">
      <div className="card glow">
        <div className="row wrap" style={{ gap: 20 }}>
          <div style={{ minWidth: 220 }}>
            <div className="kicker">This machine</div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 30, marginTop: 6 }}>
              {m.on ? (m.mode === 'shielded' ? 'Mining · shielded' : `Mining · ${m.workers} core${m.workers === 1 ? '' : 's'}`) : 'Not mining'}
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {m.on ? `Running for ${fmtDuration(m.uptimeSec)}` : g.allow ? 'Ready when you are.' : 'Waiting for the node.'}
            </div>
          </div>
          <div className="spacer" />
          <button
            className={`btn big ${m.on ? 'danger' : 'primary'}`}
            disabled={m.on ? busy : !canStart}
            onClick={toggle}
          >
            {busy ? 'Working…' : m.on ? '■  Stop mining' : '▶  Start mining'}
          </button>
        </div>
      </div>

      {!g.allow ? (
        <Notice kind={g.reason === 'no-peers' || g.reason === 'tip-too-old' ? 'warn' : 'plain'}>
          <div style={{ width: '100%' }}>
            <b>Mining is held back.</b>
            <div style={{ marginTop: 4 }}>{g.message}</div>
            {/* The numbers being waited for, always. "Why can I not click
                mining" must be answerable from the screen. */}
            <div className="row wrap tiny" style={{ marginTop: 10, gap: 16, opacity: 0.85 }}>
              <span>your node: <b className="mono">{g.myHeight == null ? '—' : '#' + g.myHeight}</b></span>
              <span>
                network: <b className="mono">{g.networkHeight == null ? '—' : '#' + g.networkHeight}</b>
                {g.networkSource ? ` (${g.networkSource})` : ''}
              </span>
              <span>peers: <b className="mono">{g.peers == null ? '—' : g.peers}</b></span>
              {g.blockedForSec > 5 ? <span>held back for <b className="mono">{fmtDuration(g.blockedForSec)}</b></span> : null}
            </div>
            {g.rule ? <div className="tiny dim" style={{ marginTop: 6 }}>Rule in force: {g.rule}.</div> : null}
            {g.offerOverride ? (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.1)' }}>
                <div className="small">
                  This has gone on long enough that it may be wrong. If those two numbers look right
                  to you, you can start anyway — your node may not be on the network&apos;s best
                  chain, and blocks you find could be discarded.
                </div>
                <button className="btn sm" style={{ marginTop: 10 }} onClick={() => api.setUserOverride(true)}>
                  Start anyway
                </button>
              </div>
            ) : null}
          </div>
        </Notice>
      ) : null}
      {g.overridden && !g.firstNode && g.userOverride ? (
        <Notice kind="warn">
          <div>
            <b>Mining anyway, at your request.</b>
            <div style={{ marginTop: 4 }}>{g.message}</div>
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => api.setUserOverride(false)}>
              Go back to waiting for the network
            </button>
          </div>
        </Notice>
      ) : null}
      {g.overridden && g.firstNode ? (
        <Notice kind="warn"><div><b>First-node mode is on.</b><div>{g.message}</div></div></Notice>
      ) : null}
      {m.pausedByGate && !m.on ? (
        <Notice kind="warn">Mining paused itself and will start again on its own once the node is healthy.</Notice>
      ) : null}
      {m.pausedByIdle && !m.on ? (
        <Notice kind="info">Mining is paused because you are using this machine. It starts again after two minutes of no keyboard or mouse.</Notice>
      ) : null}
      {err ? <Notice kind="bad">{err}</Notice> : null}

      <div className="grid c4">
        <Metric
          label="Hash rate"
          value={m.solps == null ? null : fmtSolps(m.solps)}
          detail={m.solps == null
            ? (m.mode === 'shielded' ? 'The node’s internal miner reports no rate' : 'Not reported by the miner')
            : `measured from ${m.solpsSource}`}
          edge="var(--honey)"
        />
        <Metric
          label="Blocks found"
          value={s.rewards.blocksFound}
          detail={s.rewards.shieldedBlocks ? `${s.rewards.transparentBlocks} transparent · ${s.rewards.shieldedBlocks} shielded` : 'by this machine'}
          edge="var(--orange)"
        />
        <Metric
          label={`Honey spendable (${s.network.ticker})`}
          value={s.rewards.transparentBlocks ? fmtCoins(s.rewards.spendableZat, atomic) : null}
          detail={s.rewards.transparentBlocks ? `${s.rewards.maturity}+ confirmations` : 'transparent mining only'}
          edge="var(--green)"
        />
        <Metric
          label={`Honey maturing (${s.network.ticker})`}
          value={s.rewards.transparentBlocks ? fmtCoins(s.rewards.maturingZat, atomic) : null}
          detail={s.rewards.nextMaturesInBlocks != null ? `next unlocks in ${s.rewards.nextMaturesInBlocks} blocks` : 'nothing waiting'}
          edge="var(--honey)"
        />
      </div>

      <div className="card">
        <div className="row"><h3>How you mine</h3></div>
        <p className="small muted">
          Both engines pay you directly. Which one you can use depends on the kind of address you pasted.
        </p>
        <div className="seg" style={{ marginTop: 10 }}>
          <button
            className={m.mode === 'standard' ? 'on' : ''}
            disabled={!m.standardAvailable || s.payout.kind !== 'transparent'}
            onClick={() => api.setMiningMode('standard')}
          >Standard · many cores</button>
          <button
            className={m.mode === 'shielded' ? 'on' : ''}
            disabled={s.payout.kind !== 'unified'}
            onClick={() => api.setMiningMode('shielded')}
          >Shielded · 1 core</button>
        </div>

        {!m.standardAvailable ? (
          <div style={{ marginTop: 12 }}>
            <Notice kind="plain">
              Standard mining is not in this build yet: the separate miner program is not bundled.
              Shielded mining works now and needs a <span className="mono">utest…</span> address.
            </Notice>
          </div>
        ) : null}
        {m.standardSimulated ? (
          <div style={{ marginTop: 12 }}>
            <Notice kind="bad">
              <b>SIMULATED miner.</b> This development build runs fake workers so the screens can be
              tested. They never mine and never find a block.
            </Notice>
          </div>
        ) : null}
        {m.mode === 'shielded' ? (
          <div style={{ marginTop: 12 }}>
            <Notice kind="info">
              Shielded mining runs inside the node itself, on one core, and pays into your unified
              address where nobody can see the amount. Switching it on or off restarts the node,
              because that is the only time the node reads the setting.
            </Notice>
          </div>
        ) : null}

        {m.mode === 'standard' && m.standardAvailable ? (
          <div style={{ marginTop: 18 }}>
            <label className="field">
              <span>How many cores to use — {m.intensity} of {m.maxWorkers} available</span>
              <input
                type="range"
                min={1}
                max={m.maxWorkers}
                value={m.intensity}
                onChange={(e) => api.setIntensity(Number(e.target.value))}
              />
            </label>
            <div className="tiny dim">One core is always left free so the machine stays usable.</div>
          </div>
        ) : null}

        <div style={{ marginTop: 18 }}>
          <Switch
            checked={m.idleOnly}
            onChange={(v) => api.setIdleOnly(v)}
            label="Pause while I am using this machine (starts again after two minutes of no keyboard or mouse)"
          />
        </div>
      </div>

      <div className="card">
        <h3>What a found block pays you</h3>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Every block on this network splits its reward the same way, forever: <b>80% to the miner</b>,
          8% Core Development, 4% Grants &amp; Ecosystem, 8% Community &amp; Development Reserve.
          In the first era the block reward is 6.25 {s.network.ticker}, so a block you find pays
          you <b>5.00 {s.network.ticker}</b> plus that block&apos;s transaction fees — not 6.25.
          Coinbase rewards can only be spent after {s.rewards.maturity} confirmations.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- node
export function NodeView({ s, api, cfg }) {
  const [busy, setBusy] = useState(false);
  const n = s.node;

  async function toggle() {
    setBusy(true);
    if (n.running) await api.stopNode(); else await api.startNode();
    setBusy(false);
  }

  const syncPill = !n.running
    ? <Pill kind="idle">stopped</Pill>
    : n.synced === false
      ? <Pill kind="warn">syncing</Pill>
      : n.peers > 0
        ? <Pill kind="ok">synced</Pill>
        : <Pill kind="warn">no peers</Pill>;

  return (
    <div className="stack-lg">
      <div className="card">
        <div className="row wrap">
          <div>
            <div className="kicker">Full node</div>
            <div className="row" style={{ marginTop: 8 }}>
              {syncPill}
              <span className="small muted">
                {n.running
                  ? (n.peers > 0
                      ? `Connected to the swarm: ${n.peers} peer${n.peers === 1 ? '' : 's'}, synced to block ${n.height == null ? '—' : n.height.toLocaleString('en-US')}`
                      : 'Looking for other nodes…')
                  : 'The node is not running.'}
              </span>
            </div>
          </div>
          <div className="spacer" />
          <button className={`btn ${n.running ? 'danger' : 'primary'}`} disabled={busy} onClick={toggle}>
            {busy ? 'Working…' : n.running ? '■  Stop node' : '▶  Start node'}
          </button>
        </div>
      </div>

      <div className="grid c4">
        <Metric label="Block height" value={n.height == null ? null : n.height.toLocaleString('en-US')} detail={n.bestHash ? shortHash(n.bestHash, 8) : null} edge="var(--orange)" />
        <Metric label="Newest block" value={n.tipAgeSec == null ? null : fmtAge(n.tipAgeSec)} detail="age of the chain tip" edge="var(--honey)" />
        <Metric label="Peers" value={n.running ? n.peers : null} detail={n.running ? `${n.peersIn} inbound · ${n.peersOut} outbound` : null} edge="var(--blue)" />
        <Metric label="On disk" value={n.stateBytes == null ? null : fmtBytes(n.stateBytes)} detail="chain database" edge="var(--green)" />
      </div>

      {n.p2pMoved ? (
        <Notice kind="info">
          <div>
            <b>Your node is listening on port {n.p2pMoved.chosen} instead of {n.p2pMoved.wanted}.</b>
            <div style={{ marginTop: 4 }}>
              Port {n.p2pMoved.wanted} was already in use ({n.p2pMoved.why}). Your node still syncs
              and mining still works — the only thing missing is other nodes being able to connect
              in to you. Free port {n.p2pMoved.wanted} and restart the node to get that back.
            </div>
          </div>
        </Notice>
      ) : null}

      <div className="grid c2">
        <div className="card">
          <h3>Network</h3>
          <table className="tbl" style={{ marginTop: 8 }}>
            <tbody>
              <tr><td className="muted">Chain</td><td className="num">{s.network.name}</td></tr>
              <tr><td className="muted">Network hash rate</td><td className="num">{s.network_stats.networkSolps == null ? '—' : fmtSolps(s.network_stats.networkSolps)}</td></tr>
              <tr><td className="muted">Difficulty</td><td className="num">{s.network_stats.difficulty == null ? '—' : s.network_stats.difficulty.toFixed(4)}</td></tr>
              <tr><td className="muted">Node uptime</td><td className="num">{n.running ? fmtDuration(n.uptimeSec) : '—'}</td></tr>
              <tr>
              <td className="muted">Listening on</td>
              <td className="num">
                port {n.p2pPort}
                {n.p2pMoved ? <span className="dim"> (moved from {n.p2pMoved.wanted})</span> : null}
              </td>
            </tr>
            </tbody>
          </table>
          <p className="tiny dim" style={{ marginTop: 10, marginBottom: 0 }}>
            A dash means the node has not measured that yet. Network hash rate needs a few blocks
            before it means anything.
          </p>
        </div>

        <div className="card">
          <h3>Where the chain lives</h3>
          <div className="addr" style={{ marginTop: 8 }}>{n.dataDir}</div>
          {/* The owner has to be able to see, at a glance, which folder and
              which processes this window is actually using — there may be more
              than one copy of the app on the machine. */}
          <table className="tbl" style={{ marginTop: 12 }}>
            <tbody>
              <tr>
                <td className="muted">Node process</td>
                <td className="num">{n.running ? `running, PID ${n.pid}` : 'not running'}</td>
              </tr>
              <tr>
                <td className="muted">Miner processes</td>
                <td className="num">
                  {s.mining.mode === 'shielded'
                    ? (s.mining.on ? 'inside the node (one thread)' : 'none')
                    : (s.mining.pids && s.mining.pids.length
                        ? s.mining.pids.map((p) => `PID ${p}`).join(', ')
                        : 'none')}
                </td>
              </tr>
              <tr>
                <td className="muted">Settings file</td>
                <td className="num" style={{ fontSize: 11, wordBreak: 'break-all' }}>{cfg?.userDataDir || '—'}</td>
              </tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn sm" onClick={() => window.shell.openDataFolder()}>
              <span className="row" style={{ gap: 6 }}><Icon name="folder" size={15} /> Open folder</span>
            </button>
            <button className="btn sm ghost" disabled={n.running} onClick={() => api.chooseDataFolder()}>Move…</button>
          </div>
          {n.running ? <div className="tiny dim" style={{ marginTop: 8 }}>Stop the node to move its folder.</div> : null}
          {n.lastStop ? (
            <div className="tiny dim" style={{ marginTop: 12 }}>
              Last stop: {n.lastStop.graceful ? `clean shutdown in ${n.lastStop.ms} ms` : 'had to be forced — the database may need a moment to recover on the next start'}.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rewards
export function RewardsView({ s }) {
  const r = s.rewards;
  const atomic = r.atomicPerCoin;
  return (
    <div className="stack-lg">
      <div className="grid c3">
        <Metric label="Blocks found" value={r.blocksFound} detail="by this machine, on this chain" edge="var(--orange)" />
        <Metric
          label={`Spendable (${s.network.ticker})`}
          value={r.transparentBlocks ? fmtCoins(r.spendableZat, atomic) : null}
          detail={`${r.maturity}+ confirmations`}
          edge="var(--green)"
        />
        <Metric
          label={`Maturing (${s.network.ticker})`}
          value={r.transparentBlocks ? fmtCoins(r.maturingZat, atomic) : null}
          detail={r.nextMaturesInBlocks != null ? `next unlocks in ${r.nextMaturesInBlocks} blocks` : 'nothing waiting'}
          edge="var(--honey)"
        />
      </div>

      {r.shieldedBlocks ? (
        <Notice kind="info">
          <div>
            <b>{r.shieldedBlocks} block{r.shieldedBlocks === 1 ? '' : 's'} mined to your shielded address.</b>
            <div style={{ marginTop: 4 }}>
              The amounts are encrypted on the chain, so this app cannot read them. Based on what
              the node states each of those blocks paid, that is about{' '}
              <b>{fmtCoins(r.shieldedSubsidyZat, atomic)} {s.network.ticker}</b> — check your wallet
              for the real balance.
            </div>
          </div>
        </Notice>
      ) : null}

      <div className="card">
        <div className="row">
          <h3>Blocks this machine found</h3>
          <div className="spacer" />
          <button className="btn sm ghost" onClick={() => window.shell.openWallet()}>
            <span className="row" style={{ gap: 6 }}><Icon name="wallet" size={15} /> Open SWARM Wallet</span>
          </button>
        </div>
        {!r.blocks.length ? (
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            No blocks yet. A block appears here the moment the network accepts it.
          </p>
        ) : (
          <table className="tbl" style={{ marginTop: 10 }}>
            <thead>
              <tr><th>Height</th><th>Block</th><th>Kind</th><th style={{ textAlign: 'right' }}>Paid to you</th><th style={{ textAlign: 'right' }}>Status</th></tr>
            </thead>
            <tbody>
              {r.blocks.map((b) => {
                const conf = s.node.height == null ? 0 : Math.max(0, s.node.height - b.height + 1);
                const mature = conf >= r.maturity;
                return (
                  <tr key={b.hash}>
                    <td className="mono">{b.height.toLocaleString('en-US')}</td>
                    <td className="mono dim">{shortHash(b.hash, 8)}</td>
                    <td>{b.mode === 'shielded' ? <Pill kind="mining">shielded</Pill> : <Pill kind="clear">visible</Pill>}</td>
                    <td className="num">
                      {b.mode === 'shielded'
                        ? <span className="dim" title="encrypted on the chain">shielded</span>
                        : `${fmtCoins(b.paidZat, atomic)} ${s.network.ticker}`}
                    </td>
                    <td className="num">{mature ? <span style={{ color: 'var(--green)' }}>spendable</span> : <span className="dim">{r.maturity - conf} to go</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="tiny dim" style={{ marginTop: 14, marginBottom: 0 }}>
          There is nothing to withdraw: the protocol pays every reward straight to the address you
          pasted. Open your wallet to spend it.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings
export function SettingsView({ s, cfg, api }) {
  const [phrase, setPhrase] = useState('');
  const [addr, setAddr] = useState(s.payout.address || '');
  const [addrResult, setAddrResult] = useState(null);
  const first = !!cfg.firstNodeOverride;

  return (
    <div className="stack-lg">
      <div className="card">
        <h3>Payout address</h3>
        <p className="small muted">The only thing this app stores about you. Change it any time; the node restarts to pick it up.</p>
        <input type="text" spellCheck={false} value={addr} onChange={(e) => setAddr(e.target.value)} />
        <div className="row" style={{ marginTop: 12 }}>
          <span className="small muted">{s.payout.detail || 'Not set yet.'}</span>
          <div className="spacer" />
          <button className="btn sm primary" disabled={!addr.trim() || addr.trim() === s.payout.address} onClick={async () => {
            setAddrResult(await api.setPayoutAddress(addr.trim()));
          }}>Save</button>
        </div>
        {addrResult && !addrResult.ok ? <div style={{ marginTop: 10 }}><Notice kind="bad">{addrResult.error}</Notice></div> : null}
      </div>

      <div className="card">
        <h3>First node of a new network</h3>
        <p className="small muted">
          Normally this app refuses to mine until the node has at least one peer and a fresh block,
          because mining alone builds a private fork that everybody else throws away. The one case
          where that is wrong is starting a brand-new network, where there is nobody to peer with yet.
        </p>
        {!first ? (
          <>
            <label className="field" style={{ marginTop: 10 }}>
              <span>Type FIRST NODE to confirm</span>
              <input type="text" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="FIRST NODE" />
            </label>
            <button
              className="btn sm"
              style={{ marginTop: 12 }}
              disabled={phrase.trim().toUpperCase() !== 'FIRST NODE'}
              onClick={() => api.setFirstNodeOverride(true, phrase)}
            >Turn on first-node mode</button>
          </>
        ) : (
          <div style={{ marginTop: 10 }}>
            <Notice kind="warn">First-node mode is on. Blocks you mine are confirmed by nobody else until other nodes join.</Notice>
            <button className="btn sm" style={{ marginTop: 12 }} onClick={() => api.setFirstNodeOverride(false, '')}>Turn it off</button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>This build</h3>
        <table className="tbl" style={{ marginTop: 8 }}>
          <tbody>
            <tr><td className="muted">Version</td><td className="num">{cfg.appVersion}</td></tr>
            <tr><td className="muted">Network</td><td className="num">{s.network.name}</td></tr>
            <tr><td className="muted">Network definition</td><td className="num">{cfg.networkSource}</td></tr>
            <tr><td className="muted">Node program</td><td className="num">{s.binaries.zebrad.ok ? 'verified' : 'not usable'}</td></tr>
            <tr><td className="muted">Node SHA-256</td><td className="num" style={{ fontSize: 11, wordBreak: 'break-all' }}>{s.binaries.zebrad.sha256 || '—'}</td></tr>
            <tr><td className="muted">Miner program</td><td className="num">{s.binaries.miner.simulated ? 'simulated' : s.binaries.miner.ok ? 'verified' : 'not bundled'}</td></tr>
            <tr><td className="muted">Automatic updates</td><td className="num">off — this testnet build has no update feed</td></tr>
          </tbody>
        </table>
        {/* Each program says exactly where it came from. The two are NOT from
            the same upstream tree, and an earlier note claimed they were. */}
        <div style={{ marginTop: 16 }}>
          <div className="kicker">Where the bundled programs come from</div>
          {[['zebrad.exe', s.binaries.zebrad], ['privacy-miner.exe', s.binaries.miner]]
            .filter(([, b]) => b && b.provenance && b.provenance.commit)
            .map(([name, b]) => (
              <div key={name} className="card flat" style={{ marginTop: 10, padding: 12 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--honey)' }}>{name}</span>
                  <span className="tiny dim">{b.sha256 ? b.sha256.slice(0, 16) + '…' : '—'}</span>
                </div>
                <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
                  branch <span className="mono">{b.provenance.branch}</span> @{' '}
                  <span className="mono">{b.provenance.commit.slice(0, 12)}</span>, built on{' '}
                  {b.provenance.upstreamBase}
                </div>
                <div className="tiny dim" style={{ marginTop: 4, lineHeight: 1.6 }}>
                  Changes from upstream: {b.provenance.changes}
                </div>
              </div>
            ))}
        </div>
        <p className="tiny dim" style={{ marginTop: 14, marginBottom: 0 }}>
          The node software is Zebra by the Zcash Foundation, licensed MIT or Apache-2.0. SWARM
          Node adds no consensus or cryptographic code of its own. The two programs above come
          from different upstream trees, which is recorded rather than smoothed over: the miner
          asks the node for work and the node validates everything it accepts, so the node&apos;s
          rules decide. The fonts are Sora, Manrope and JetBrains Mono, under the SIL Open Font
          License 1.1. This app is MIT licensed.
        </p>
        {!s.binaries.zebrad.ok ? <div style={{ marginTop: 12 }}><Notice kind="bad">{s.binaries.zebrad.reason}</Notice></div> : null}
      </div>

      <div className="card">
        <h3>Display</h3>
        <Switch checked={!!cfg.reducedMotion} onChange={(v) => api.setReducedMotion(v)} label="Reduce motion" />
      </div>

      <div className="card">
        <h3>Official SWARM channels</h3>
        <p className="small muted">
          These are the only places the project speaks from. There is no Discord and no Telegram.
          Anything else claiming to be SWARM is not.
        </p>
        <table className="tbl" style={{ marginTop: 6 }}>
          <tbody>
            {LINK_LABELS.filter(([k]) => cfg.links && cfg.links[k]).map(([k, label]) => (
              <tr key={k}>
                <td className="muted">{label}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm ghost" onClick={() => window.shell.openLink(cfg.links[k])}>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="mono">{cfg.links[k].replace(/^https:\/\//, '')}</span>
                      <Icon name="external" size={13} />
                    </span>
                  </button>
                </td>
              </tr>
            ))}
            {cfg.contactEmail ? (
              <tr>
                <td className="muted">Email</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm ghost" onClick={() => window.shell.copy(cfg.contactEmail)}>
                    <span className="mono">{cfg.contactEmail}</span>
                  </button>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div style={{ marginTop: 14 }}>
          <Notice kind="warn">
            SWARM will never ask you for a recovery phrase, a private key or a payment — not by
            email, not on any website, not in this app. This app has no way to accept one.
          </Notice>
        </div>
        <p className="tiny dim" style={{ marginTop: 12, marginBottom: 0 }}>{s.network.status}</p>
      </div>
    </div>
  );
}

// Only these links exist, and the main process enforces the same allow-list.
const LINK_LABELS = [
  ['website', 'Website'],
  ['explorer', 'Explorer'],
  ['x', 'X'],
  ['source', 'Source code']
];

// ---------------------------------------------------------------- log
export function LogView({ lines }) {
  const box = useRef(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    if (stick && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, stick]);

  return (
    <div className="card">
      <div className="row">
        <h3>Log</h3>
        <div className="spacer" />
        <Switch checked={stick} onChange={setStick} label="Follow" />
      </div>
      <div
        className="log"
        style={{ height: 'calc(100vh - 260px)', marginTop: 12 }}
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) setStick(false);
        }}
      >
        {!lines.length ? <div className="dim">Nothing yet.</div> : null}
        {lines.map((l, i) => (
          <div className="ln" key={i}>
            <span className="t">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
            <span className={`m ${l.kind}`}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
