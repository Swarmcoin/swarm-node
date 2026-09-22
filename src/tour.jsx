// The guided tour: five steps, one per page, shown once after setup.
//
// The owner asked for "some guided steps like an onboarding sequence". This is
// it. It moves the app to the page it is talking about, so the user is looking
// at the real screen with their real numbers on it while it is explained - the
// panel never covers the page it describes.
//
// EVERY claim below has to be true of THIS build. Where a figure appears it is
// either read from the state the engine published or it is one of the
// network's own constants, quoted from the embedded manifest. There is no
// "coming soon", no feature that does not exist, and nothing about a price.
//
// It can be replayed at any time from Settings, and skipping it is one click.

import React, { useEffect, useState } from 'react';
import { Mark, Icon } from './ui.jsx';

/**
 * @param {object} s    the engine state snapshot, for the live figures
 * @param {object} cfg  the app config, for the network name and the ticker
 */
export function tourSteps(s, cfg) {
  const ticker = (s && s.network && s.network.ticker) || 'SWM';
  const maturity = (s && s.rewards && s.rewards.maturity) || 100;
  const net = (s && s.network && s.network.name) || (cfg && cfg.network && cfg.network.network_name) || 'the testnet';

  return [
    {
      tab: 'mining',
      icon: 'mine',
      title: 'One button, and it is never greyed out',
      body: (
        <>
          <p>
            This page starts and stops mining. There is one main button and it always does the
            next useful thing: start your node if it is not running, ask for a payout address if
            you have not given one, or start mining when everything is ready.
          </p>
          <p>
            While your node is still catching up the button reads <b>Start mining when ready</b>.
            Press it and you can walk away — mining begins by itself the moment your node is in a
            state where the work would count. The line under the button always says what it is
            waiting for.
          </p>
        </>
      )
    },
    {
      tab: 'node',
      icon: 'node',
      title: 'You are running a real full node',
      body: (
        <>
          <p>
            SWARM Node runs your own copy of the chain. It checks every block itself rather than
            trusting anybody, which is the whole point of running one. This page shows its height,
            how many other nodes it is talking to, how much disk it is using and where that data
            lives — you can move it.
          </p>
          <p>
            Stopping it here stops it properly, the same way pressing Ctrl-C in a console would.
            Closing the window does the same. The app does not leave anything running behind you.
          </p>
        </>
      )
    },
    {
      tab: 'rewards',
      icon: 'honey',
      title: `Honey: what you earn, and when you can spend it`,
      body: (
        <>
          <p>
            Every block found on {net} today pays <b>6.25 {ticker}</b>, and the miner&apos;s share
            of that is <b>80%</b> — <b>5.00 {ticker}</b> to you, plus any transaction fees in the
            block. The remaining 20% goes to the network&apos;s funding streams. This app never
            shows the whole 6.25 as your income.
          </p>
          <p>
            New rewards are not spendable immediately: a freshly mined coin needs{' '}
            <b>{maturity} confirmations</b> before the network lets it move, so it appears here as
            <i> maturing</i> first and becomes <i>spendable</i> on its own.
          </p>
        </>
      )
    },
    {
      tab: 'map',
      icon: 'map',
      title: 'The map is opt-in, so you are not on it',
      body: (
        <>
          <p>
            The Swarm map shows cities whose operators <i>asked</i> to be listed, never finer than
            a city. It is not a count of the network and your machine is not on it. SWARM Node
            sends nothing about your location anywhere.
          </p>
          <p>
            The page also shows how many nodes the project&apos;s seed server is connected to,
            which is the one network-wide figure that can actually be checked. It is a lower
            bound, and the page says so.
          </p>
        </>
      )
    },
    {
      tab: 'settings',
      icon: 'gear',
      title: 'Settings, and the Log when you want to look',
      body: (
        <>
          <p>
            Settings is where you change the address you are paid to, how many cores to use,
            whether to pause while you are using the machine, and where the chain is stored. There
            is no account here and never will be: this app stores your payout address and your
            preferences, and no key, seed phrase or password of any kind.
          </p>
          <p>
            The Log page shows what is happening, with every line tagged <b>node</b>, <b>miner</b>
            {' '}or <b>app</b> so you can see who said it. You can replay this tour whenever you
            like — it is the <b>Show me around</b> button in Settings.
          </p>
        </>
      )
    }
  ];
}

export function Tour({ s, cfg, onTab, onClose }) {
  const steps = tourSteps(s, cfg);
  const [i, setI] = useState(0);
  const step = steps[i];

  // Move the app to the page being described, so the panel explains what is
  // actually on screen behind it.
  useEffect(() => { onTab(step.tab); }, [i]);

  // Escape leaves. A tour you cannot get out of is a trap, not a tour.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose(false);
      if (e.key === 'ArrowRight' && i < steps.length - 1) setI(i + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [i]);

  const last = i === steps.length - 1;

  return (
    <div className="tour-wrap" role="dialog" aria-modal="false" aria-label="Guided tour">
      <div className="tour">
        <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
          <div className="tour-badge"><Icon name={step.icon} /></div>
          <div style={{ flex: 1 }}>
            <div className="kicker">Step {i + 1} of {steps.length}</div>
            <h3 style={{ marginTop: 2 }}>{step.title}</h3>
          </div>
          <button className="btn sm ghost" onClick={() => onClose(false)} aria-label="Close the tour">Skip</button>
        </div>

        <div className="tour-body small">{step.body}</div>

        <div className="tour-dots" aria-hidden="true">
          {steps.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          {/* Hidden rather than greyed out on the first step: a disabled
              control with nothing to say is the thing this release removes. */}
          {i > 0 ? <button className="btn sm ghost" onClick={() => setI(i - 1)}>Back</button> : null}
          <div className="spacer" />
          <button className="btn sm primary" onClick={() => (last ? onClose(true) : setI(i + 1))}>
            {last ? 'Start using SWARM Node' : 'Next'}
          </button>
        </div>
      </div>
      <div className="tour-foot tiny dim">
        <Mark size={12} /> Everything above is true of this build. Nothing here is a preview.
      </div>
    </div>
  );
}
