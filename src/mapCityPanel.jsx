// "Put my city on the map" — the opt-in the map page was missing.
//
// The map is a published file: swarm.green/data/swarm-map.json, edited only by
// the project. Before this panel existed the page could tell an operator their
// node was not on the map and offer nothing at all to do about it, which is
// what "the heatmap locations are still not showing up" meant in practice.
//
// Two things, kept apart on purpose:
//
//   * CHOSEN HERE, ON THIS MACHINE: the operator's city is a setting. The map
//     draws it immediately, labelled "YOUR CITY", and it never leaves the box.
//   * ASKING TO BE PUBLISHED: one button copies a ready-made request line (and
//     opens the project's contact page). Nothing is sent automatically, and the
//     panel says so, because the map's whole claim is that nobody's location
//     appears without them asking.

import React, { useEffect, useState } from 'react';
import { Notice } from './ui.jsx';
import { CITIES, findCity, searchCities } from './cities.js';

const CONTACT = 'https://swarm.green/#contact';

export function CityOptIn({ cfg, onChanged, onRefresh }) {
  // Local, not straight from cfg: the page must show what was just saved even
  // though cfg belongs to the application shell and is refreshed on its own
  // schedule. cfg is the seed and the fallback.
  const [mine, setMine] = useState((cfg && cfg.mapCity) || null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState('');

  useEffect(() => {
    const fresh = (cfg && cfg.mapCity) || null;
    setMine((current) => (fresh ? fresh : current));
  }, [cfg]);

  const results = searchCities(query);

  async function afterChange() {
    try {
      const fresh = await window.shell.getConfig();
      setMine((fresh && fresh.mapCity) || null);
    } catch { /* the setting is still saved; the panel just keeps what it had */ }
    if (onChanged) await onChanged();
    if (onRefresh) await onRefresh(true);
  }

  async function choose(city) {
    setBusy(true);
    setMessage('');
    try {
      const answer = await window.shell.setMapCity(city);
      if (answer && answer.ok) {
        setMessage(`${city.city}${city.country ? ', ' + city.country : ''} is on your map. It is not published anywhere.`);
        setQuery('');
        await afterChange();
      } else {
        setMessage((answer && answer.error) || 'That city could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await window.shell.clearMapCity();
      setMessage('Your city is off the map. The published places are unaffected.');
      setRequest('');
      await afterChange();
    } finally {
      setBusy(false);
    }
  }

  async function askToPublish() {
    const where = mine ? `${mine.city}, ${mine.country}`.replace(/, $/, '') : query.trim();
    const line = mine
      ? `Please add my node to the SWARM heat map: ${where} (${mine.lon}, ${mine.lat}). City level only.`
      : `Please add my city to the SWARM heat map: ${where}. City level only.`;
    setRequest(line);
    try {
      await window.shell.copy(line);
      setMessage('Request copied. Paste it on the contact page and the project will add it to swarm.green.');
    } catch {
      setMessage('Copy it yourself from the box below and send it to the project.');
    }
  }

  return (
    <div className="card">
      <h3>Your city on the map</h3>
      <p className="small muted" style={{ marginBottom: 0 }}>
        The public map is a file the project publishes, and it lists cities only where the operator
        asked to be listed. Choose your city here and it appears on <b>your</b> map straight away —
        {mine ? ' it is not published anywhere yet.' : ' nothing is sent anywhere by choosing it.'}
      </p>

      {mine ? (
        <div className="row" style={{ marginTop: 12 }}>
          <span className="small">
            Yours: <b>{mine.city}{mine.country ? `, ${mine.country}` : ''}</b>{' '}
            <span className="dim">({mine.lon}, {mine.lat})</span>
            {!findCity(mine.city, mine.country) ? <span className="dim"> · not from the built-in list</span> : null}
          </span>
          <div className="spacer" />
          <button className="btn sm" onClick={askToPublish} disabled={busy}>Ask the project to publish it</button>
          <button className="btn sm danger" onClick={remove} disabled={busy}>Remove</button>
        </div>
      ) : (
        <>
          <input
            type="text"
            spellCheck={false}
            aria-label="Search for your city"
            placeholder={`Search ${CITIES.length} cities — try "berlin"`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ marginTop: 12 }}
          />
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
            {results.map((c) => (
              <button
                key={`${c.city}-${c.country}`}
                className="btn sm"
                disabled={busy}
                onClick={() => choose(c)}
              >
                {c.city}, {c.country}
              </button>
            ))}
            {results.length === 0 ? <span className="small muted">Nothing matched. Ask the project to add it below.</span> : null}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={askToPublish} disabled={busy || !query.trim()}>
              My city is not in the list — ask the project
            </button>
          </div>
        </>
      )}

      {message ? (
        <div style={{ marginTop: 10 }}>
          <Notice kind="plain">{message}</Notice>
        </div>
      ) : null}
      {request ? (
        <textarea
          readOnly
          aria-label="Request to publish"
          value={request}
          style={{ marginTop: 10, width: '100%', minHeight: 60 }}
          onFocus={(e) => e.target.select()}
        />
      ) : null}

      <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
        City level, never finer. SWARM Node never sends your location, your address or which city you
        looked at anywhere — not to the project, not to a geocoding service.
      </p>
      <a className="tiny dim" href={CONTACT} onClick={(e) => { e.preventDefault(); window.shell.openLink(CONTACT); }}>
        Contact the project
      </a>
    </div>
  );
}

export default CityOptIn;
