// Does this build still say anything it should not?
//
// Two things went wrong on a sibling app and must not happen here: the desktop
// wallet shipped with an unlock screen still reading "Zingo PC is locked", and
// the owner's rule against multilevel wording (referral, sponsor, invite codes,
// "licences") has to hold in every string a user can read.
//
// This checks the SOURCE and, when it exists, the PACKAGED app.asar — because
// what ships is the bundle, not the source tree.
//
//   node scripts/string-sweep.mjs [path/to/app.asar or release dir]
//
// Exits non-zero on any hit that is not in the allow-list below. The allow-list
// is deliberately narrow and every entry says why.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every rule: [pattern, what it would mean, allowed-context test or null]
const RULES = [
  // ---- the earlier AI-compute product ----
  [/\bAI compute\b|\bAI jobs?\b|\bAI\b(?=\s+(compute|job|workload|inference))/i, 'the earlier AI-compute product'],
  [/\bsandboxed (?:AI |GPU )?(?:compute|jobs?)\b/i, 'the earlier product’s job sandbox'],
  [/\baiinfra\b/i, 'the earlier engine name'],
  [/\bVRAM\b|\bnvidia-smi\b|\bSDXL\b|\bESRGAN\b/i, 'GPU compute leftovers'],
  [/\bNode[- ]Right\b|\bNFT\b/i, 'the earlier product’s NFT'],
  [/\bapi\.swarm\.green\b/i, 'the retired API host'],
  [/\bethers\b|\bEthereum\b|\b0x[0-9a-fA-F]{40}\b/, 'the Ethereum account system'],
  [/\bwithdraw(al)?\b/i, 'there is nothing to withdraw: the protocol pays the user directly', allowIfDenied],
  [/\bDAO\b|\bFounding Round\b|\bstaking\b|\bstake\b/i, 'the earlier investor product'],

  // ---- the owner's hard rule: no multilevel, ever ----
  [/\breferr?al\b/i, 'MULTILEVEL: referrals are forbidden'],
  [/\bsponsor\b/i, 'MULTILEVEL: sponsors are forbidden'],
  [/\bdownline\b|\bupline\b|\baffiliate\b|\bcommission\b/i, 'MULTILEVEL: forbidden'],
  [/\binvite code\b|\binvitation code\b/i, 'MULTILEVEL: invite codes are forbidden'],
  [/\bnode licen[cs]e\b|\blicen[cs]e (?:key|slot|tier|purchase)\b/i, 'MULTILEVEL: licence sales are forbidden'],

  // ---- accounts that do not exist here ----
  [/\bsign in\b|\bsign-in\b|\blog in\b|\blogin\b|\bcreate an account\b/i, 'there is no account in this app'],
  [/\bpassphrase\b|\bseed phrase\b|\brecovery phrase\b|\bprivate key\b/i, 'no key material exists here', allowIfWarning],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'an email address', allowOfficialEmail],

  // ---- upstream names where a user expects SWARM ----
  [/\bZcash\b/i, 'upstream name shown to a user', allowInLicenceOrAttribution],
  [/\bZEC\b|\bTAZ\b/, 'upstream ticker'],
  [/\bzebrad?\b/i, 'the node program’s name', allowZebra],
  [/\bZingo\b/i, 'the wallet fork’s upstream name'],

  // ---- invented figures ----
  [/\bMH\/s\b/, 'this proof of work is measured in Sol/s'],
  [/\bswm1[0-9a-z]{6,}/i, 'an invented address format'],
  [/\bPPLNS\b|\bstale shares?\b|\bpool fee\b/i, 'there is no mining pool']
];

// Rules that hold EVERYWHERE, including developer documentation, because the
// owner's rule against multilevel wording is about the product, not about
// which file a word sits in. Everything else is judged only where a user can
// read it: the renderer, the strings the engine sends to the renderer, and the
// packaged bundle.
const EVERYWHERE = [
  /MULTILEVEL/,
  /invented address format/
];

// ---- allow-list predicates ------------------------------------------------

// "zebrad" is the real file name of the program the app runs, and hiding that
// would be dishonest. It is allowed in code, in file names, in the log, and in
// an About line that names it. It is NOT allowed as the product's own name.
function allowZebra(line, file) {
  if (!/\.(jsx|html|md)$/.test(file) && !file.includes('asar')) return true;   // code and configs
  if (/zebrad?\.exe|zebra\.toml|zebra-chain|zebra-rpc|zebrad::/i.test(line)) return true;
  if (/Zcash Foundation|MIT|Apache/i.test(line)) return true;                   // attribution
  if (/node program|node software|built from unmodified source/i.test(line)) return true;
  return false;
}

// Upstream "Zcash" may appear only where it is attribution, a licence, or a
// statement that something was inherited unchanged — which is exactly what the
// network manifest records about the consensus rules.
function allowInLicenceOrAttribution(line) {
  // "the public Zcash chain tip" is a comment the canonical config renderer
  // writes, and this app reproduces that file byte for byte on purpose. It
  // names a different, real network; it is not this product's name.
  return /Zcash Foundation|Apache|MIT|licen[cs]e|upstream|inherited|getblocksubsidy|Zcash Community Grants|public Zcash chain|zebra/i.test(line);
}

/**
 * What a user can actually read in a source file: string literals and the text
 * between JSX tags. Comments and identifiers are developer material, and a
 * sweep that flags `s.binaries.zebrad.sha256` teaches people to ignore it.
 */
function userReadableText(source, file) {
  if (!/\.(js|mjs|jsx)$/.test(file)) return source;
  // Drop comments first so a comment can never be mistaken for a string.
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
  const lines = noComments.split('\n');
  return lines
    .map((line) => {
      const parts = [];
      const strings = line.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || [];
      parts.push(...strings);
      const jsxText = line.match(/>[^<>{}]{3,}</g) || [];
      parts.push(...jsxText);
      return parts.join(' ');
    })
    .join('\n');
}

// The one official address, and only that one.
function allowOfficialEmail(line) {
  const m = line.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
  return m.every((e) => e === 'swarmofficial@atomicmail.io' || e === 'noreply@anthropic.com');
}

// Key words are allowed only in a sentence that says this app has none and
// will never ask for one. "You need a seed phrase" fails; "this app never
// needs a seed phrase" passes.
function allowIfWarning(line) {
  return /never ask|never needs?|no way to accept|never sees|holds no|does not (?:hold|store|need|see)|\bno (?:key|seed|password|account)\b|never stored|never exists?|does not exist|forbidden|refus/i.test(line);
}

// Same idea for "withdraw": saying there is nothing to withdraw is the point.
function allowIfDenied(line) {
  return /nothing to withdraw|no withdraw|replaces? the (?:old )?withdraw|instead of withdraw/i.test(line);
}

// Files whose content is a third-party licence or provenance record.
const LICENCE_FILES = /(^|[\\/])(LICENSE|LICENCE|SOURCES\.json|.*licen[cs]e.*)$/i;

function sweepText(text, label, { everywhereOnly = false } = {}) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [re, why, allow] of RULES) {
      if (everywhereOnly && !EVERYWHERE.some((e) => e.test(why))) continue;
      const m = re.exec(line);
      if (!m) continue;
      if (allow && allow(line, label)) continue;
      hits.push({ file: label, line: i + 1, match: m[0].slice(0, 60), why, text: line.trim().slice(0, 140) });
    }
  }
  return hits;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'release', 'resources', 'staging', 'out', '_review'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const target = process.argv[2];
let hits = [];
let scanned = 0;

if (target) {
  // Packaged mode: read the asar (or any file) as bytes and sweep the printable
  // strings, which is what an auditor would actually look at.
  const file = fs.statSync(target).isDirectory()
    ? (() => {
        const found = walk(target).find((f) => f.endsWith('app.asar'));
        if (!found) { console.error(`no app.asar under ${target}`); process.exit(2); }
        return found;
      })()
    : target;
  const buf = fs.readFileSync(file);
  // Printable runs of 6+ characters, the classic `strings` behaviour.
  const text = buf.toString('latin1').replace(/[^\x20-\x7e\n]+/g, '\n');
  hits = sweepText(text, path.basename(file) + ' (packaged)');
  scanned = 1;
  console.log(`swept ${file} (${buf.length} bytes)`);
} else {
  // What a user can read: the renderer, plus the engine strings that reach it.
  const USER_FACING = /^(src|electron)[\\/]/;
  // Developer material. Only the rules that hold everywhere are applied.
  const DEV = /^(README\.md|RELEASE-NOTES\.md|docs[\\/]|scripts[\\/]|test[\\/]|\.github[\\/]|build[\\/])/;

  const files = walk(ROOT).filter((f) => /\.(js|mjs|jsx|json|html|css|md|ps1|yml|nsh)$/.test(f));
  let devScanned = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (LICENCE_FILES.test(rel)) continue;
    if (rel === 'package-lock.json') continue;
    // dist/ is the build output; the packaged sweep covers the real bundle and
    // minified identifiers there are not English words anybody reads.
    if (rel.startsWith('dist' + path.sep)) continue;
    if (rel.startsWith('scripts' + path.sep + 'string-sweep')) continue;  // this file names them all
    const text = fs.readFileSync(f, 'utf8');
    if (USER_FACING.test(rel)) { hits.push(...sweepText(userReadableText(text, rel), rel)); scanned += 1; }
    else if (DEV.test(rel)) { hits.push(...sweepText(text, rel, { everywhereOnly: true })); devScanned += 1; }
    else { hits.push(...sweepText(userReadableText(text, rel), rel)); scanned += 1; }
  }
  console.log(`swept ${scanned} user-facing files in full, ${devScanned} developer files for the rules that hold everywhere`);
}

if (hits.length) {
  console.error(`\n${hits.length} string(s) that should not ship:\n`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  ${JSON.stringify(h.match)}  — ${h.why}`);
    console.error(`      ${h.text}`);
  }
  process.exit(1);
}
console.log('string sweep clean');
