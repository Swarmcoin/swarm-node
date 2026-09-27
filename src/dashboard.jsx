// The running app: mining, node, rewards, settings, log.
//
// Every figure on these screens comes from the chain, from a miner's own
// output, or from this machine. Anything unknown renders as "—". There are no
// estimates, no per-day projections and no fiat values anywhere.

import React, { useEffect, useRef, useState } from 'react';
import { Icon, Pill, Metric, Notice, Switch, fmtCoins, fmtBytes, fmtDuration, fmtAge, fmtSolps, shortHash } from './ui.jsx';
import { CodeLockSettings } from './lock.jsx';
import { rewardStatus } from './reward-status.mjs';

// ---------------------------------------------------------------- mining
export function MiningView({ s, api }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const m = s.mining;
  const g = s.gate;
  const atomic = s.rewards.atomicPerCoin;

  // The one button, and what it does now. The decision is made in the main
  // process (electron/chain/next-action.js) from the same snapshot this page
  // renders, so the label, the reason and the behaviour cannot disagree.
  //
  // It is never disabled except for the moment a click is in flight. "Start
  // mining is greyed out and I do not know why" was the owner's complaint; a
  // button that explains itself and does the next useful thing is the answer.
  const next = s.next || { id: 'start', label: '▶  Start mining', tone: 'primary', why: '', progress: null, alternative: null };

  async function runNext(id) {
    setBusy(true);
    setErr(null);
    let r = null;
    if (id === 'stop') r = await api.stopMining();
    else if (id === 'start-everything') r = await api.startEverything();
    else if (id === 'start') r = await api.startMining();
    else if (id === 'arm') r = await api.armMining(true);
    else if (id === 'disarm') r = await api.armMining(false);
    else if (id === 'start-node') r = await api.startNode();
    else if (id === 'set-address') api.goToPayout();
    else if (id === 'fix-binary') r = await api.setMiningMode('shielded');
    else if (id === 'stop-foreign-node') r = await api.stopForeignNode();
    else if (id === 'choose-folder') r = await api.chooseDataFolder();
    else if (id === 'override') r = await api.setUserOverride(true);
    if (r && r.ok === false) setErr(r.error);
    setBusy(false);
  }

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
              {m.on ? `Running for ${fmtDuration(m.uptimeSec)}` : next.why}
            </div>
            {next.progress ? (
              <div style={{ marginTop: 10, maxWidth: 320 }}>
                <div className="bar">
                  <i style={{
                    width: next.progress.total
                      ? `${Math.max(2, Math.min(100, (next.progress.done / next.progress.total) * 100)).toFixed(1)}%`
                      : '100%'
                  }} />
                </div>
                <div className="tiny dim" style={{ marginTop: 5 }}>{next.progress.label}</div>
              </div>
            ) : null}
          </div>
          <div className="spacer" />
          <div style={{ textAlign: 'right' }}>
            <button
              className={`btn big ${next.tone === 'danger' ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={() => runNext(next.id)}
            >
              {busy ? 'Working…' : next.label}
            </button>
            {next.alternative ? (
              <div style={{ marginTop: 8 }}>
                <button className="btn sm ghost" disabled={busy} onClick={() => runNext(next.alternative.id)}>
                  {next.alternative.label}
                </button>
                <div className="tiny dim" style={{ marginTop: 4 }}>{next.alternative.why}</div>
              </div>
            ) : null}
          </div>
        </div>
        {/* WHICH CHAIN this would mine. The gate row below says it too, but
            only while mining is held back, and the owner's complaint was that
            nothing on any screen said which network was running. */}
        <div className="row wrap tiny" style={{ marginTop: 12, gap: 16, opacity: 0.85 }}>
          <span>network: <b className="mono">{s.network.chainLabel}</b></span>
          <span>genesis: <b className="mono" title={s.network.genesisHash || ''}>{s.network.genesisShort ? `${s.network.genesisShort}…` : '—'}</b></span>
          <span>payouts to: <b className="mono">{s.network.transparentHint} / {s.network.unifiedHint}</b></span>
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
                network: <b className="mono">{s.network.chainLabel}</b>
                {g.networkHeight == null ? '' : ` #${g.networkHeight}`}
                {g.networkSource ? ` (${g.networkSource})` : ''}
              </span>
              <span>peers: <b className="mono">{g.peers == null ? '—' : g.peers}</b></span>
              {g.blockedForSec > 5 ? <span>held back for <b className="mono">{fmtDuration(g.blockedForSec)}</b></span> : null}
            </div>
            {g.rule ? <div className="tiny dim" style={{ marginTop: 6 }}>Rule in force: {g.rule}.</div> : null}
            {g.offerOverride ? (
              // The button itself is beside the primary one above, so it is not
              // repeated here — only what pressing it costs you.
              <div className="small" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.1)' }}>
                This has gone on long enough that it may be wrong. <b>Start anyway</b> is offered
                next to the main button: if those two numbers look right to you, take it — but your
                node may not be on the network&apos;s best chain, and blocks you find could be
                discarded.
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

      <Notice kind="plain">
        <div>
          <b>You mine alone — there is no pool.</b>
          <div style={{ marginTop: 4 }}>
            Whichever machine finds the next valid block first gets that block’s full reward, paid
            by the protocol straight to your payout address. A machine that just started can win
            several blocks in a row — that is luck on a small number of blocks, not a preference.
            Over time every miner earns in proportion to its share of the network’s total hash power.
          </div>
        </div>
      </Notice>

      <div className="grid c4">
        <Metric
          label="Hash rate"
          value={m.solps == null ? null : fmtSolps(m.solps)}
          detail={m.solps == null
            ? (m.mode === 'shielded'
                ? 'the node’s own solver has not reported a rate yet'
                : 'Not reported by the miner')
            : (m.solpsSource === 'node log'
                ? 'measured by the node’s own solver'
                : `measured from ${m.solpsSource}`)}
          edge="var(--honey)"
        />
        <Metric
          label="Blocks found"
          value={s.rewards.blocksFound}
          detail={s.rewards.shieldedBlocks ? `${s.rewards.transparentBlocks} transparent · ${s.rewards.shieldedBlocks} shielded` : 'by this machine'}
          edge="var(--orange)"
        />
        {/* The two money tiles say what the engine that is running can prove.
            A transparent coinbase output is on the chain, so its amount and
            its 100-block maturity are facts. A shielded one is encrypted — from
            NU6.3 the network pays shielded coinbase value into the Ironwood
            pool — so the one figure this app can show is the miner's share of
            each block the node's own log reported as accepted. That is shown,
            labelled as credited, and never called a wallet balance: only the
            wallet can see the note. Nothing is estimated, and a tile with
            nothing behind it still says why. */}
        <Metric
          label={`${s.rewards.transparentBlocks ? 'Mature rewards' : 'Shielded subsidy'} (${s.network.ticker})`}
          value={s.rewards.transparentBlocks
            ? fmtCoins(s.rewards.spendableZat, atomic)
            : s.rewards.shieldedBlocks ? fmtCoins(s.rewards.shieldedSubsidyZat, atomic) : null}
          detail={s.rewards.transparentBlocks
            ? `${s.rewards.maturity}+ confirmations · mining income, not your wallet balance`
            : s.rewards.shieldedBlocks
              ? 'subsidy from blocks found · your wallet shows received funds and fees'
              : 'nothing mined yet'}
          edge="var(--green)"
        />
        <Metric
          label={`Honey maturing (${s.network.ticker})`}
          value={s.rewards.transparentBlocks
            ? fmtCoins(s.rewards.maturingZat, atomic)
            : s.rewards.shieldedBlocks ? fmtCoins(0, atomic) : null}
          detail={s.rewards.transparentBlocks
            ? (s.rewards.nextMaturesInBlocks != null ? `next unlocks in ${s.rewards.nextMaturesInBlocks} blocks` : 'nothing waiting')
            : s.rewards.shieldedBlocks
              ? 'shielded rewards have no coinbase maturity rule'
              : 'nothing waiting'}
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
          >Shielded · many cores</button>
        </div>

        {/* A greyed-out choice with no explanation is the same dead end as a
            greyed-out Start button. Whichever engine is unavailable, say why
            in one line and say what would change it. */}
        <div className="tiny dim" style={{ marginTop: 8 }}>
          {s.payout.kind === 'transparent'
            ? <>Your address is a transparent <span className="mono">{s.network.transparentHint}</span> one, so Standard is
              available and Shielded is not. Shielded needs a unified{' '}
              <span className="mono">{s.network.unifiedHint}</span> address — paste one in Settings to use it.</>
            : s.payout.kind === 'unified'
              ? <>Your address is a unified <span className="mono">{s.network.unifiedHint}</span> one, so Shielded is
                available and Standard is not. Standard pays a transparent{' '}
                <span className="mono">{s.network.transparentHint}</span> address — paste one in Settings to use it.</>
              : <>Neither engine is available until you paste a payout address in Settings.</>}
        </div>

        {!m.standardAvailable ? (
          <div style={{ marginTop: 12 }}>
            <Notice kind="plain">
              Standard mining is not in this build yet: the separate miner program is not bundled.
              Shielded mining works now and needs a <span className="mono">{s.network.unifiedHint}</span> address.
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
              Shielded mining runs inside the node itself, because only the node can build a
              block that pays a unified address where nobody can see the amount. It uses the
              cores you choose below. Switching it on or off restarts the node, because that
              is the only time the node reads the setting.
            </Notice>
          </div>
        ) : null}

        {m.mode === 'shielded' || (m.mode === 'standard' && m.standardAvailable) ? (
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
          Transparent rewards need {s.rewards.maturity} confirmations. Shielded rewards have no
          coinbase maturity countdown; your wallet shows their balance and when they can be spent.
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
              {/* The two values that identify a chain. Without them "which
                  network is this node on" could not be answered anywhere in
                  the app, and a mainnet build ran the testnet in silence. */}
              <tr><td className="muted">Network</td><td className="num">{s.network.profileLabel} ({s.network.chainLabel})</td></tr>
              <tr>
                <td className="muted">Genesis</td>
                <td className="num mono" style={{ fontSize: 11, wordBreak: 'break-all' }} title={s.network.genesisHash || ''}>
                  {s.network.genesisShort ? `${s.network.genesisShort}…` : '—'}
                </td>
              </tr>
              <tr>
                <td className="muted">Node reports</td>
                <td className="num">
                  {n.chainCheck && n.chainCheck.got ? n.chainCheck.got : '—'}
                  {n.chainCheck && n.chainCheck.ok === false ? ' — wrong chain' : ''}
                </td>
              </tr>
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
            <tr>
              <td className="muted">Control port</td>
              <td className="num">
                {n.rpcPort} <span className="dim">this machine only</span>
                {n.rpcMoved ? <span className="dim"> (moved from {n.rpcMoved.wanted})</span> : null}
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
                    ? (s.mining.on
                        ? `inside the node (${s.mining.intensity} ${s.mining.intensity === 1 ? 'thread' : 'threads'})`
                        : 'none')
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
          label={`${r.transparentBlocks ? 'Mature rewards' : 'Shielded subsidy'} (${s.network.ticker})`}
          value={r.transparentBlocks
            ? fmtCoins(r.spendableZat, atomic)
            : r.shieldedBlocks ? fmtCoins(r.shieldedSubsidyZat, atomic) : null}
          detail={r.transparentBlocks
            ? `${r.maturity}+ confirmations · mining income, not your wallet balance`
            : r.shieldedBlocks ? 'subsidy from blocks found · your wallet shows received funds and fees' : 'nothing mined yet'}
          edge="var(--green)"
        />
        <Metric
          label={`Maturing (${s.network.ticker})`}
          value={r.transparentBlocks
            ? fmtCoins(r.maturingZat, atomic)
            : r.shieldedBlocks ? fmtCoins(0, atomic) : null}
          detail={r.transparentBlocks
            ? (r.nextMaturesInBlocks != null ? `next unlocks in ${r.nextMaturesInBlocks} blocks` : 'nothing waiting')
            : r.shieldedBlocks ? 'shielded rewards have no coinbase maturity rule' : 'nothing waiting'}
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
                const status = rewardStatus(b, s.node.height, r.maturity);
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
                    <td className="num"><span className={status.mature ? undefined : 'dim'} style={status.mature ? { color: 'var(--green)' } : undefined}>{status.label}</span></td>
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
/**
 * WHICH NETWORK THIS APP RUNS, and the control to change it.
 *
 * THE DEFECT THIS FIXES. `shell:setNetworkProfile` has existed since the
 * mainnet profile was added, and nothing in the renderer ever called it. The
 * "This build" table listed both networks as text - "running now", "available
 * in this build" - so a SWARM mainnet installer opened on the testnet with the
 * two words the owner needed printed as a read-only row and no control
 * anywhere. The app has to be RESTARTED into a profile (the engine, the chain
 * folder and both ports are built around one at start-up), which is why this
 * asks before it acts and then restarts the app itself rather than telling
 * somebody to close a window.
 *
 * A network this build cannot run is shown and disabled with the reason in
 * words, for the same reason the old table did it: a missing network must
 * never be a silent absence.
 */
function NetworkCard({ s, cfg }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const profiles = cfg.networkProfiles || [];
  const current = profiles.find((p) => p.id === cfg.networkProfile) || null;
  const target = pending ? profiles.find((p) => p.id === pending) : null;

  return (
    <div className="card">
      <h3>Network</h3>
      <p className="small muted">
        Which SWARM chain this computer runs. Each network keeps its own chain folder, its own
        ports and its own kind of payout address, so switching never touches the other one.
      </p>

      {/* The app's own segmented control (.seg), the same one the Mining page
          uses for the mining mode. The first version of this was a bare
          native dropdown: a white box with the browser's own chevron in the
          middle of a dark application, and the only one anywhere in the
          build. Nothing else here is a native dropdown, so this is not a
          restyle - it is the control this app already has. */}
      <div className="field" style={{ marginTop: 10 }}>
        <span>Network</span>
        <div className="seg" role="radiogroup" aria-label="Network" style={{ marginTop: 7 }}>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === cfg.networkProfile}
              className={p.id === cfg.networkProfile ? 'on' : ''}
              disabled={busy || !p.selectable}
              title={p.selectable ? `chain ${p.chainLabel}, port ${p.p2pPort}` : p.reason}
              onClick={() => {
                setError('');
                setPending(p.id === cfg.networkProfile ? null : p.id);
              }}
            >{p.menuLabel}</button>
          ))}
        </div>
      </div>

      {/* What is running, in the values that identify a chain beyond argument. */}
      <table className="tbl" style={{ marginTop: 12 }}>
        <tbody>
          <tr><td className="muted">Running now</td><td className="num">{s.network.profileLabel}</td></tr>
          <tr><td className="muted">Chain</td><td className="num">{s.network.chainLabel}</td></tr>
          <tr>
            <td className="muted">Genesis</td>
            <td className="num mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{s.network.genesisHash || '—'}</td>
          </tr>
          <tr><td className="muted">Ports (p2p / control)</td><td className="num">{s.network.p2pPort} / {s.network.rpcPort}</td></tr>
          <tr><td className="muted">Payout addresses</td><td className="num">{s.network.transparentHint} or {s.network.unifiedHint}</td></tr>
          <tr><td className="muted">This build was made for</td><td className="num">{(profiles.find((p) => p.builtFor) || {}).menuLabel || '—'}</td></tr>
        </tbody>
      </table>

      {profiles.filter((p) => !p.selectable).map((p) => (
        <div key={p.id} className="tiny dim" style={{ marginTop: 10, lineHeight: 1.6 }}>
          <b>{p.menuLabel}</b> cannot be chosen in this build: {p.reason}
        </div>
      ))}

      {/* Why THIS network and not the one that was saved. Never silent. */}
      {cfg.networkOverride ? (
        <div style={{ marginTop: 12 }}>
          <Notice kind="plain">
            This computer had <span className="mono">{cfg.networkOverride.stored}</span> saved from an
            earlier install. This is a <span className="mono">{cfg.networkOverride.build}</span> build, so it
            started on {current ? current.menuLabel : cfg.networkProfile}. Choose above to change it.
          </Notice>
        </div>
      ) : null}

      {error ? <div style={{ marginTop: 12 }}><Notice kind="bad">{error}</Notice></div> : null}

      {target ? (
        <div style={{ marginTop: 12 }}>
          <Notice kind="warn">
            <div style={{ width: '100%' }}>
              <b>Switch to {target.menuLabel}?</b>
              <div className="small" style={{ marginTop: 6, lineHeight: 1.6 }}>
                SWARM Node stops the node and any mining, then starts again on{' '}
                <span className="mono">{target.chainLabel}</span> (genesis{' '}
                <span className="mono">{(target.genesisHash || '').slice(0, 8)}…</span>, port {target.p2pPort}).
                That network keeps its own chain folder, so nothing already downloaded is lost.
                A payout address belonging to the other network is removed, because{' '}
                {target.menuLabel} cannot pay it — you will be asked for a{' '}
                <span className="mono">{target.addressHint}</span> address.
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="btn primary sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    const r = await window.shell.setNetworkProfile(target.id);
                    if (!r || !r.ok) {
                      setBusy(false);
                      setError((r && r.error) || 'That network could not be selected.');
                      return;
                    }
                    if (r.restartRequired) await window.shell.restartApp();
                    else { setBusy(false); setPending(null); }
                  }}
                >{busy ? 'Restarting…' : 'Switch and restart'}</button>
                <button className="btn sm" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
              </div>
            </div>
          </Notice>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsView({ s, cfg, api }) {
  const [phrase, setPhrase] = useState('');
  const [addr, setAddr] = useState(s.payout.address || '');
  const [addrResult, setAddrResult] = useState(null);
  const first = !!cfg.firstNodeOverride;

  return (
    <div className="stack-lg">
      {/* First, because which chain is running decides whether the payout
          address below is even a valid address. */}
      <NetworkCard s={s} cfg={cfg} />

      {/* The app removed an address that belonged to the other network. Said
          here rather than left as an empty field nobody emptied. */}
      {cfg.payoutClearedReason ? (
        <Notice kind="warn">
          <div style={{ width: '100%' }}>
            <b>Your payout address was removed.</b>
            <div style={{ marginTop: 4 }}>{cfg.payoutClearedReason}</div>
            <button
              className="btn sm"
              style={{ marginTop: 10 }}
              onClick={async () => { await window.shell.dismissPayoutNotice(); if (api.refreshConfig) await api.refreshConfig(); }}
            >Got it</button>
          </div>
        </Notice>
      ) : null}

      <div className="card">
        <div className="row">
          <div>
            <h3>New here?</h3>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Five short steps through the five pages of this app. It changes nothing and you can
              leave at any point.
            </p>
          </div>
          <div className="spacer" />
          <button className="btn sm" onClick={() => api.showTour()}>Show me around</button>
        </div>
      </div>

      <div className="card">
        <h3>Payout address</h3>
        <p className="small muted">
          The only thing this app keeps about you besides the lock you may set: your payout address, which is a
          public identifier. Change it any time; the node restarts to pick it up.
        </p>
        <input type="text" spellCheck={false} value={addr} onChange={(e) => setAddr(e.target.value)} />
        <div className="row" style={{ marginTop: 12 }}>
          {/* The answer this screen just got, in preference to the state
              snapshot, which is up to a second behind. Showing "Not set yet."
              beside "Saved, but not checked yet" is two contradictory states
              on one screen, which is the thing this release removed from the
              wizard; it has no business here either. */}
          <span className="small muted">
            {(addrResult && addrResult.ok && addrResult.detail) || s.payout.detail || 'Not set yet.'}
            {(addrResult ? addrResult.ok && !addrResult.confirmed : s.payout.address && !s.payout.confirmed)
              ? <span className="dim"> · not confirmed by your node yet</span>
              : null}
          </span>
          <div className="spacer" />
          <button className="btn sm primary" disabled={!addr.trim() || addr.trim() === s.payout.address} onClick={async () => {
            setAddrResult(await api.setPayoutAddress(addr.trim()));
          }}>Save</button>
        </div>
        {/* Three different things, never confused with each other: the node
            rejected it, the node could not be asked, or it is confirmed. An
            address is only ever called wrong when the node actually said so. */}
        {addrResult && !addrResult.ok ? <div style={{ marginTop: 10 }}><Notice kind="bad">{addrResult.error}</Notice></div> : null}
        {addrResult && addrResult.ok && addrResult.note ? (
          <div style={{ marginTop: 10 }}>
            <Notice kind="plain">
              <div style={{ width: '100%' }}>
                <div>{addrResult.note}</div>
                {!s.node.running ? (
                  <button className="btn sm" style={{ marginTop: 10 }} onClick={() => api.startNode()}>
                    Start the node
                  </button>
                ) : null}
              </div>
            </Notice>
          </div>
        ) : null}
        {addrResult && addrResult.ok && addrResult.confirmed ? (
          <div style={{ marginTop: 10 }}><Notice kind="ok">Saved. Your node confirmed it.</Notice></div>
        ) : null}
      </div>

      <div className="card">
        <h3>Lock and sign out</h3>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Lock puts this window behind your code. Sign out stops the node and every miner and starts the
          application again from the outside — nothing is deleted, and your address and chain data stay put.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={() => api.lockNow()}>Lock now</button>
          <button className="btn sm" onClick={() => window.sessionLock.signOut()}>Sign out</button>
        </div>
      </div>

      <CodeLockSettings
        onNotice={async () => {
          if (api.refreshLockStatus) await api.refreshLockStatus();
        }}
      />

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
            {/* Which network this build was MADE for. The list of networks and
                the control that switches between them now live in the Network
                card at the top of this page; this row is the build's own
                identity, which is a different question and the one the release
                manifest answers. */}
            <tr>
              <td className="muted">Built for</td>
              <td className="num">{cfg.buildNetworkProfile}</td>
            </tr>
            <tr><td className="muted">Node program</td><td className="num">{s.binaries.zebrad.ok ? 'verified' : 'not usable'}</td></tr>
            <tr><td className="muted">Node SHA-256</td><td className="num" style={{ fontSize: 11, wordBreak: 'break-all' }}>{s.binaries.zebrad.sha256 || '—'}</td></tr>
            <tr><td className="muted">Miner program</td><td className="num">{s.binaries.miner.simulated ? 'simulated' : s.binaries.miner.ok ? 'verified' : 'not bundled'}</td></tr>
            <tr><td className="muted">Automatic updates</td><td className="num">off — this build has no update feed</td></tr>
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
// Who said it, in words the user can act on. The engine tags every entry
// 'node', 'miner' or 'app'; the log shows that tag instead of the upstream
// crate path the programs print themselves.
const SOURCE_LABEL = { node: 'node', miner: 'miner', app: 'app' };

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
            <span className={`k ${l.kind}`}>{SOURCE_LABEL[l.kind] || 'app'}</span>
            <span className={`m ${l.kind}`}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
