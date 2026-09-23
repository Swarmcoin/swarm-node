// The lock screen, and the settings that go with it.
//
// SWARM Node has no account, so "lock" here means the controls on this machine
// are put behind a code until somebody types it. The code itself never reaches
// this file's logic: it is handed to the main process, which is the only place
// that holds the record and the count of wrong tries (see electron/lock-code.js
// and the lock:* handlers in electron/main.js). What this file decides is what
// a person sees: whether a code is set, what went wrong, and how long they are
// asked to wait.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mark, Notice } from './ui.jsx';

const bridge = () => (typeof window !== 'undefined' ? window.sessionLock : null);

/** Counts a wait down so the button does not look broken while it runs. */
function useCountdown(seconds) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    if (!seconds || seconds <= 0) return undefined;
    const timer = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  return left;
}

export function LockScreen({ onUnlock, onSignOut, status }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState((status && status.waitSeconds) || 0);
  const left = useCountdown(wait);
  const input = useRef(null);

  useEffect(() => {
    if (input.current) input.current.focus();
  }, []);

  const unlock = async () => {
    if (busy || left > 0) return;
    const typed = code.trim();
    if (!typed) {
      setError('Enter your code.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const answer = await bridge().verify(typed);
      if (answer && answer.ok) {
        setCode('');
        onUnlock();
      } else {
        setError((answer && answer.reason) || 'That code is not right.');
        setWait((answer && answer.waitSeconds) || 0);
        setCode('');
        if (input.current) input.current.focus();
      }
    } catch {
      setError('The code could not be checked. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-card card">
        <div className="row">
          <Mark size={34} />
          <div>
            <h2 style={{ margin: 0 }}>SWARM Node is locked</h2>
            <div className="tiny dim">Enter your code to use this computer&apos;s node and miner again.</div>
          </div>
        </div>

        <input
          ref={input}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Lock code"
          placeholder="Your code"
          value={code}
          disabled={busy || left > 0}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') unlock();
          }}
          style={{ marginTop: 16, letterSpacing: '0.3em', textAlign: 'center' }}
        />

        {error ? (
          <div style={{ marginTop: 10 }}>
            <Notice kind="bad">{error}</Notice>
          </div>
        ) : null}
        {left > 0 ? (
          <div className="tiny dim" style={{ marginTop: 10 }}>
            Try again in {left} second{left === 1 ? '' : 's'}.
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={unlock} disabled={busy || left > 0}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
          <div className="spacer" />
          {/*
            The code locks these controls; it does not encrypt the chain data or
            anything else on this machine, and it cannot be recovered. Both are
            said here rather than discovered later, and signing out is offered
            because it is the only way out of a code nobody remembers.
          */}
          <button className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        <div className="tiny dim" style={{ marginTop: 12 }}>
          The code locks this application — it does not encrypt anything on this disk, and it cannot be
          recovered. Forgotten it? Sign out, then start the app again; the code stays set, and the node and your
          address are untouched.
        </div>
      </div>
    </div>
  );
}

/** Set, change or remove the code. Used from Settings. */
export function CodeLockSettings({ onNotice }) {
  const [status, setStatus] = useState(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await bridge().status());
    } catch {
      setStatus({ hasCode: false });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const shape = (value) => {
    const code = value.trim();
    if (!/^[0-9]+$/.test(code)) return 'Use digits only.';
    if (code.length < 6) return 'Use at least 6 digits.';
    if (code.length > 12) return 'Use at most 12 digits.';
    return null;
  };

  const save = async () => {
    const problem = shape(next);
    if (problem) {
      setMessage(problem);
      return;
    }
    if (next.trim() !== again.trim()) {
      setMessage('The two codes are not the same.');
      return;
    }
    if (status && status.hasCode && !current.trim()) {
      setMessage('Enter your current code first.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const answer = await bridge().set(next.trim(), current.trim());
      if (answer && answer.ok) {
        setCurrent('');
        setNext('');
        setAgain('');
        setMessage(
          answer.encrypted
            ? "Your code is set, and kept encrypted with this machine's own store."
            : 'Your code is set. This machine has no OS keystore, so the record is kept in the settings file — a salt and a scrambled value, never the code.',
        );
        await refresh();
        if (onNotice) onNotice(true);
      } else {
        setMessage((answer && answer.reason) || 'The code could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (status && status.hasCode && !current.trim()) {
      setMessage('Enter your current code first.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const answer = await bridge().clear(current.trim());
      if (answer && answer.ok) {
        setCurrent('');
        setMessage('The code is removed. The lock no longer asks for one.');
        await refresh();
        if (onNotice) onNotice(false);
      } else {
        setMessage((answer && answer.reason) || 'The code could not be removed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const hasCode = !!(status && status.hasCode);

  return (
    <div className="card">
      <h3>Code lock</h3>
      <p className="small muted" style={{ marginBottom: 0 }}>
        {hasCode
          ? 'A code is set. It is asked for every time you press Lock.'
          : 'A code you type to use this node again after locking it. Six to twelve digits.'}
      </p>
      <p className="small muted" style={{ marginBottom: 0 }}>
        It locks these controls. It does not encrypt the chain data, and it cannot be recovered.
      </p>

      {hasCode ? (
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Current code"
          placeholder="Current code"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      ) : null}
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label="New code"
        placeholder="New code"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label="New code again"
        placeholder="New code again"
        value={again}
        onChange={(e) => setAgain(e.target.value)}
      />

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn sm primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : hasCode ? 'Change code' : 'Set code'}
        </button>
        {hasCode ? (
          <button className="btn sm danger" onClick={remove} disabled={busy}>
            Remove code
          </button>
        ) : null}
        <div className="spacer" />
        {message ? <span className="small muted">{message}</span> : null}
      </div>
    </div>
  );
}

export default LockScreen;
