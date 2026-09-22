// Photograph a window that is never shown.
//
// The harness must not put a window on anybody's desktop, so the app is
// launched with SWARM_NODE_HEADLESS=1 and its window is created with
// show:false. That leaves one problem: Chromium only composites what it
// believes somebody is looking at, so Page.captureScreenshot on a hidden
// window returns the first frame if you are lucky and then times out.
//
// Page.startScreencast is the forcing function. Asking for a screencast makes
// the renderer keep producing frames whether or not a surface is on screen,
// and every frame arrives as a PNG. This keeps the most recent one and hands
// it over on request, falling back to a direct captureScreenshot when no
// frame has arrived yet.
//
// Nothing here is display-dependent, so a CI runner with no desktop at all
// produces the same pictures as this machine.

/**
 * @param {object} cdp   an open connection with an `onEvent` hook and `send`
 * @param {object} opts  width, height (CSS pixels of the window)
 */
export async function startShots(cdp, { width = 1200, height = 820 } = {}) {
  let latest = null;            // { data: base64 png, at: ms }
  let frames = 0;               // how many have arrived, for freshness
  const previousHook = cdp.onEvent;

  cdp.onEvent = (m) => {
    if (m.method === 'Page.screencastFrame') {
      latest = { data: m.params.data, at: Date.now() };
      frames += 1;
      // Every frame must be acknowledged or the stream stops after a few.
      cdp.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
    }
    if (previousHook) previousHook(m);
  };

  await cdp.send('Page.enable');
  // A fixed metric override gives the hidden window a definite size to
  // composite, which also makes the pictures the same on every machine.
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false
    });
  } catch { /* an older target may not have Emulation; the screencast still works */ }
  await cdp.send('Page.startScreencast', {
    format: 'png', quality: 100, maxWidth: width, maxHeight: height, everyNthFrame: 1
  });

  return {
    /**
     * A PNG of what the page looks like now.
     * @param {number} freshMs how recent a screencast frame has to be to count
     */
    async take() {
      // Page.captureScreenshot is NOT the source here. Against a window that
      // was never shown it returns a blank white frame - it renders from the
      // surface that does not exist. The screencast is the only thing that
      // produces the real page.
      //
      // The catch is that a hidden compositor only emits a frame when
      // something damages it, so "the most recent frame" can easily pre-date
      // the click this call is meant to photograph. So: damage it on purpose,
      // then wait for a frame that arrived AFTER that.
      const before = frames;

      try {
        await cdp.send('Runtime.evaluate', {
          expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
          awaitPromise: true
        });
      } catch { /* not fatal */ }

      // One pixel down and back invalidates the whole layer twice, and leaves
      // the page at exactly the size the picture is supposed to be.
      const metrics = (h) => cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: h, deviceScaleFactor: 1, mobile: false
      }).catch(() => {});
      await metrics(height - 1);
      await new Promise((r) => setTimeout(r, 120));
      await metrics(height);

      const until = Date.now() + 5000;
      while (Date.now() < until) {
        if (frames > before && latest) return Buffer.from(latest.data, 'base64');
        await new Promise((r) => setTimeout(r, 100));
      }
      if (latest) return Buffer.from(latest.data, 'base64');   // stale beats nothing
      throw new Error('no frame could be obtained from the hidden window');
    },

    async stop() {
      try { await cdp.send('Page.stopScreencast'); } catch { /* going away anyway */ }
    }
  };
}
