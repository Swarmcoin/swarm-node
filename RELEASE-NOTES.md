# SWARM Node 0.2.0-testnet.4

A small Windows app that turns your computer into a full node of the SWARM test
network, and mines with your processor when you press Start.

**This is a test network.** The coins it pays have no money value, they cannot
be sold, and the whole chain may be wiped and started again. Nothing here is a
promise of earnings. Please treat it as an experiment you are helping to run.

---

## What changed since 0.2.0-testnet.3

**One button, one press.** The Mining page says **Start mining**, and that is
the only thing you ever press. It starts your node if it is not running, picks
the engine your address allows — a `utest1…` address mines inside the node, a
`tm…` address uses your processor cores — waits for the chain to catch up, and
begins mining on its own. The line underneath says where it has got to. The
same button stops it again at any point.

**Installing a new version now stops the old one first.** It did not, and that
broke mining outright: the previous version's node kept running in the
background, still holding the chain folder, so the new one could not open it
and stopped immediately. The app then waited for a node that was never coming.
The installer now stops whatever is running from the folder it is replacing,
and the uninstaller does the same, so nothing is left mining after you remove
the app.

**If another SWARM node is holding your chain folder, the app says so** — in
one sentence, with a button that stops it and carries on. Before, it tried to
start on top of it and sat there.

**If the node stops, the Mining page tells you why**, in the node's own words
put into plain language: another node has the folder, something else has the
port, the disk is full, the folder is not writable. Never a spinner that never
ends.

**Shielded mining stays on.** Switching it on restarts the node, because that
is the only time the node reads that setting — and the app was then treating
the freshly restarted node's few seconds without peers as a failure, stopping
mining, restarting the node again to switch mining off, and going round in a
circle. A node that has just started is now given time to reconnect before
anything is concluded from its silence.

## What changed since 0.2.0-testnet.2

All four of these came from someone installing the last build and telling us
what happened.

**The first-run wizard now actually runs.** It used to decide "this person has
already been set up" by looking for two settings — a consent flag and a payout
address — being present at all. Any machine that had those left over from an
earlier build went straight to the dashboard, never having been shown around.
The app now records, explicitly, that you reached the end of setup, and only
that record skips it. If you have used an earlier build, you will see the wizard
once more; your address is filled in already.

**"Start mining" is never greyed out.** There is one main button on the Mining
page and it always does the next useful thing — start your node, ask for an
address, or start mining — with a line underneath saying why. While your node is
still catching up it reads **Start mining when ready**: press it, walk away, and
mining begins by itself the moment the work would count. Where a choice is
unavailable, the reason is written next to it.

**A five-step guided tour** runs once when setup finishes and explains each page
while you are looking at it. You can leave it at any point, and replay it from
Settings → *Show me around*.

**The Swarm map says what it is.** It is an opt-in list of cities, never a count
of the network, so your own node is not on it — the page now says so instead of
leaving you wondering. Beside it is the one network-wide figure that can be
checked: how many nodes the project's seed server is connected to, read from the
seed's own status file and labelled for exactly what it is. The app still sends
nothing about your location anywhere.

**A good address is never called bad.** Pasting a payout address while the
node was stopped could produce "The node does not recognise that address on
this network" — about an address that was perfectly correct. The node had
simply not answered. The app now tells the three cases apart: your node
confirmed it, your node refused it, or your node could not be asked. In the
last case the address is accepted and used, marked *not confirmed yet*, and
the app checks again by itself as soon as the node is running.

**Two copies on one machine no longer fight.** The node's private control port
is moved to a free one if something else already has it, the same as the peer
port already was. Before, the second copy stopped with an error nobody could
act on.

**The Log reads in plain words.** Each line is tagged `node`, `miner` or `app`,
and the internal names the programs print for their own developers are stripped
from what you read — including the ones that appeared mid-sentence, and the
connection messages that used to print the whole network definition as one
unreadable line. The node's own log files on disk keep every original line, for
diagnosis.

---

## What it actually does

**It keeps its own copy of the chain.** Your computer downloads every block and
checks it for itself, rather than believing what someone else says. That is what
"running a node" means, and it is the part that makes the network hard to lie to.

**It mines when you say so, and only then.** Mining uses your processor. You
choose how many cores. Press Stop, or close the window, and it stops — there is
no background service and nothing keeps running afterwards.

**It has no account.** You paste one address, copied from the SWARM Wallet, and
that is the only thing about you the app stores. There is no sign-up, no email,
no password and no recovery phrase, because the app never needs one. Rewards are
paid by the network straight to your address, so there is nothing to withdraw
and nothing for this app to hold.

---

## Installing it

### Windows — 64-bit Windows 10 or newer

| File | What it is |
| --- | --- |
| `SWARM-Node-0.2.0-testnet.4-win-x64.exe` | The installer. Adds a Start-menu entry and an uninstall entry. |
| `SWARM-Node-0.2.0-testnet.4-win-x64.zip` | Portable. Unzip it anywhere and run `SWARM Node.exe`. Installs nothing. |

### Linux — 64-bit, Debian, Ubuntu, Fedora, Arch and anything else

| File | What it is |
| --- | --- |
| `SWARM-Node-0.2.0-testnet.4-linux-x86_64.AppImage` | One file, runs anywhere, installs nothing. |
| `swarm-node_0.2.0-testnet.4_amd64.deb` | For Debian and Ubuntu: `sudo apt install ./swarm-node_*.deb` |

**The AppImage will not run until you make it executable.** That is normal for
every AppImage, not something wrong with this one:

```
chmod +x SWARM-Node-0.2.0-testnet.4-linux-x86_64.AppImage
./SWARM-Node-0.2.0-testnet.4-linux-x86_64.AppImage
```

If it still does nothing on an older distribution, run it with
`--no-sandbox`, or install the `.deb` instead.

### macOS — Apple silicon and Intel

| File | What it is |
| --- | --- |
| `SWARM-Node-0.2.0-testnet.4-mac-arm64.dmg` | Apple silicon (M1 and later). |
| `SWARM-Node-0.2.0-testnet.4-mac-x64.dmg` | Intel Macs. |
| `…-mac-arm64.zip` / `…-mac-x64.zip` | The same app without the disk image. |

Pick the one that matches your Mac:  > About This Mac. An arm64 build will
not run on an Intel Mac.

These historical Mac test packages are **unsigned and not notarized**. They
are unsuitable for ordinary browser-download distribution. The Developer ID
build and its Gatekeeper checks are documented in `docs/MAC-DISTRIBUTION.md`.
If macOS reports a damaged or unverified app, retain the DMG for diagnosis;
removing its quarantine flag is not a release fix. Check its SHA-256 against
the matching `SHA256SUMS` and use a signed, notarized release once verified.

### Windows will warn you, and here is why

This build is **not code-signed**. A signing certificate is a purchase the
project has not made yet. So when you run the installer, Windows SmartScreen
shows a blue box saying *"Windows protected your PC"*.

To continue: click **More info**, then **Run anyway**.

Your antivirus may also flag it, because it contains a miner and that is a
pattern antivirus products watch for. Before you trust any of that, check the
file you downloaded is the file that was built:

1. Open PowerShell where you saved the file.
2. Run `Get-FileHash .\SWARM-Node-0.2.0-testnet.4-win-x64.exe -Algorithm SHA256`
3. Compare it with the matching line in `SHA256SUMS`.

If those two strings differ, do not run the file.

### What gets put on your computer

* The app itself, in `%LOCALAPPDATA%\Programs\SWARM Node (SWARM testnet)`
  (or wherever you unzip the portable version).
* `zebrad.exe`, the node program. This is the official Zcash Foundation Zebra
  node, version 6.3.0, built from unmodified source.
* `privacy-miner.exe`, the mining program.
* Three Microsoft runtime files — `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` and
  `MSVCP140.dll` — placed next to those two programs. They are shipped inside
  the app, not installed into Windows, because a clean Windows does not have
  them and the node will not start without them. Nothing else on your computer
  is touched by them.
* Your settings and the chain itself, in a folder you choose. The default is
  `%APPDATA%\green.swarm.node`.

The app **refuses to run either program** unless its SHA-256 matches the value
recorded when this version was built, so a replaced or damaged file is caught
rather than run.

### If you already have the older "SWARM Node"

The owner's earlier app for AI compute has the same name. This one is a separate
program with its own install folder, its own uninstall entry and its own
settings folder, and **automatic updates are switched off**, so the old app can
never turn into this one behind your back. The two can sit side by side.

---

## Using it

1. **Read the consent screen.** It lists exactly what will run. Tick each line.
2. **Paste your payout address.** Open the SWARM Wallet, copy a receive address,
   paste it in, and press *Check this address*. Your own node checks it, so the
   app never has to understand addresses itself.
   * An address starting `tm…` is transparent. It allows **Standard** mining,
     which uses as many processor cores as you choose. Rewards paid to it are
     visible on the explorer.
   * An address starting `utest…` is unified. It allows **Shielded** mining,
     which uses one core inside the node and pays you privately.
3. **Let the machine check run.** Processor, memory, free disk space and whether
   the network port is free. All of it measured on your computer and none of it
   sent anywhere.
4. **Press Start.** If your node is still catching up, the button says *Start
   mining when ready* — press it and it will begin on its own.
5. **Take the tour.** Five short steps, one per page. It appears by itself when
   setup finishes, and Settings → *Show me around* replays it whenever you like.

### Why mining sometimes refuses to start

The app will not let you *mine* until your node has at least one other node to
talk to and has finished downloading — but it will always let you *press the
button*. That is not caution for its own sake: a
node mining on its own builds a private chain that everybody else throws away,
so the electricity is spent for nothing. The screen always says which of the two
is missing.

There is one deliberate exception, buried in Settings and requiring you to type
a confirmation: starting the very first node of a brand-new network, where there
is nobody to talk to yet. If you did not create the network, this is not for you.

### What a found block pays

Every block reward on this network is split the same way, for the whole life of
the chain: **80% to the miner**, 8% Core Development, 4% Grants & Ecosystem, 8%
Community & Development Reserve. Right now a block is worth 6.25 SWM, so a block
you find pays **you 5.00 SWM** plus that block's fees. The app never shows 6.25
as your income.

Newly mined coins cannot be spent for 100 blocks. The app shows them as
*maturing* until then, and *spendable* afterwards. For shielded mining the
amount is encrypted on the chain and the app cannot read it, so it counts the
blocks and tells you to check your wallet for the balance.

### Stopping, and removing it

* **Stop mining** — the button on the Mining screen.
* **Stop everything** — bottom left, always visible. Stops the miner and the node.
* **Closing the window** does the same, and waits for the node to shut down
  cleanly before the app exits. Give it a couple of seconds.
* **Uninstall** — Settings → Apps → *SWARM Node (SWARM testnet)* → Uninstall, or
  just delete the folder if you used the portable version. The chain folder is
  left alone so you do not lose it by accident; delete it yourself if you want
  the disk space back.

---

## Known limits of this version

* 64-bit only, on all three platforms. There is no 32-bit build and no
  Linux ARM build.
* Unsigned everywhere. Windows SmartScreen warns; macOS refuses the first
  launch until you right-click and choose Open. See above.
* No automatic updates. New versions are downloaded and installed by hand, on
  purpose, for this testnet.
* Shielded mining uses exactly one core. That is a limitation of the node's
  built-in miner, which has no thread setting; Standard mining is the one that
  scales across cores.
* Shielded mining reports no hash rate, so the app shows "—" rather than a
  number it made up. The same goes for the network hash rate until the chain has
  enough blocks to measure one.
* The app shows no temperature, no power draw and no graphics-card figures,
  because it has no reliable way to read them on every machine.

---

## Official SWARM channels

These are the only places the project speaks from.

| | |
| --- | --- |
| Website | https://swarm.green |
| X | https://x.com/swarm_coin |
| Email | swarmofficial@atomicmail.io |
| Source | https://github.com/Swarm-Official |

There is no Discord and no Telegram. Anything else claiming to be SWARM is not.

**SWARM will never ask you for a recovery phrase, a private key or a payment.**
Not by email, not on any website, and not in this app — it has no way to accept
one.
