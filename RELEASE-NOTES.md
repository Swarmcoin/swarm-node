# SWARM Node 0.2.0-testnet.1

A small Windows app that turns your computer into a full node of the SWARM test
network, and mines with your processor when you press Start.

**This is a test network.** The coins it pays have no money value, they cannot
be sold, and the whole chain may be wiped and started again. Nothing here is a
promise of earnings. Please treat it as an experiment you are helping to run.

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

Two ways, both 64-bit Windows 10 or newer:

| File | What it is |
| --- | --- |
| `SWARM-Node-0.2.0-testnet.1-win-x64.exe` | The installer. Adds a Start-menu entry and an uninstall entry. |
| `SWARM-Node-0.2.0-testnet.1-win-x64.zip` | Portable. Unzip it anywhere and run `SWARM Node.exe`. Installs nothing. |

### Windows will warn you, and here is why

This build is **not code-signed**. A signing certificate is a purchase the
project has not made yet. So when you run the installer, Windows SmartScreen
shows a blue box saying *"Windows protected your PC"*.

To continue: click **More info**, then **Run anyway**.

Your antivirus may also flag it, because it contains a miner and that is a
pattern antivirus products watch for. Before you trust any of that, check the
file you downloaded is the file that was built:

1. Open PowerShell where you saved the file.
2. Run `Get-FileHash .\SWARM-Node-0.2.0-testnet.1-win-x64.exe -Algorithm SHA256`
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
4. **Press Start.**

### Why mining sometimes refuses to start

The app will not let you mine until your node has at least one other node to
talk to and has finished downloading. That is not caution for its own sake: a
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

* Windows 64-bit only. Linux and macOS are not built yet.
* Unsigned, so SmartScreen warns. See above.
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
| Source | https://github.com/brs-holding |

There is no Discord and no Telegram. Anything else claiming to be SWARM is not.

**SWARM will never ask you for a recovery phrase, a private key or a payment.**
Not by email, not on any website, and not in this app — it has no way to accept
one.
