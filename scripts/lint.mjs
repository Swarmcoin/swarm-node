// Repo guard. Cheaper than ESLint and checks the things that actually matter
// for this app: that every file parses, and that none of the rules the product
// depends on have quietly come back.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'release', 'resources'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const jsFiles = files.filter((f) => /\.(js|mjs)$/.test(f) && !f.includes(`${path.sep}dist${path.sep}`));
const jsxFiles = files.filter((f) => f.endsWith('.jsx'));
const sourceText = new Map();
for (const f of [...jsFiles, ...jsxFiles]) sourceText.set(f, fs.readFileSync(f, 'utf8'));

// ---- 1. everything parses ----
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failures.push(`syntax error in ${path.relative(ROOT, f)}:\n${(e.stderr || '').toString().slice(0, 600)}`);
  }
}
// .jsx cannot go through node --check; a balanced-token sanity check catches
// the common truncation mistakes and the real check is the vite build.
for (const f of jsxFiles) {
  const t = sourceText.get(f);
  for (const [open, close, name] of [['{', '}', 'braces'], ['(', ')', 'parentheses'], ['[', ']', 'brackets']]) {
    const a = (t.match(new RegExp(`\\${open}`, 'g')) || []).length;
    const b = (t.match(new RegExp(`\\${close}`, 'g')) || []).length;
    if (a !== b) failures.push(`${path.relative(ROOT, f)}: unbalanced ${name} (${a} vs ${b})`);
  }
}

// ---- 2. things that must not come back ----
const BANNED = [
  [/\bapi\.swarm\.green\b/, 'the retired AI-compute API host'],
  [/\brequire\(['"]ethers['"]\)|from\s+['"]ethers['"]/, 'the ethers dependency'],
  [/\belectron-updater\b/, 'auto-update (deliberately removed for this testnet build)'],
  [/\bswarm-downloads\b/, 'the old release feed — publishing there would convert old installs'],
  [/nodeIntegration\s*:\s*true/, 'nodeIntegration'],
  [/contextIsolation\s*:\s*false/, 'contextIsolation disabled'],
  [/\bsandbox\s*:\s*false/, 'sandbox disabled'],
  [/\bwebSecurity\s*:\s*false/, 'webSecurity disabled'],
  [/\bshell\s*:\s*true/, 'spawning through a shell'],
  // child_process.exec/execSync take a shell string. Regex .exec() is fine, so
  // this only looks at what is pulled out of child_process.
  [/require\(['"]child_process['"]\)[^;\n]*\b(exec|execSync)\b(?!File)/, 'child_process exec/execSync (use execFile/spawn with an argument array)'],
  [/\bswm1[0-9a-z]{6,}/, 'an invented swm1… address'],
  [/PPLNS|stale shares|pool fee/i, 'mining-pool vocabulary — this app does not use a pool'],
  [/\bMH\/s\b/, 'MH/s — this proof of work is measured in Sol/s'],
  [/rewards?\s*\/\s*day|per\s+day\s+estimate/i, 'a per-day earnings estimate']
];
for (const [f, t] of sourceText) {
  const rel = path.relative(ROOT, f);
  // These two files exist to name the banned strings, so they are exempt from
  // the ban. Nothing else is.
  if (rel.startsWith('scripts' + path.sep + 'lint')) continue;
  if (rel.startsWith('scripts' + path.sep + 'string-sweep')) continue;
  for (const [re, why] of BANNED) {
    const m = re.exec(t);
    if (m) failures.push(`${rel}: ${why} — found ${JSON.stringify(m[0].slice(0, 60))}`);
  }
}

// ---- 3. the security posture is actually set ----
const main = sourceText.get(path.join(ROOT, 'electron', 'main.js')) || '';
for (const [re, what] of [
  [/contextIsolation:\s*true/, 'contextIsolation: true'],
  [/nodeIntegration:\s*false/, 'nodeIntegration: false'],
  [/sandbox:\s*true/, 'sandbox: true'],
  [/setWindowOpenHandler/, 'a window-open handler'],
  [/will-navigate/, 'a navigation guard'],
  [/Content-Security-Policy/, 'a CSP header']
]) {
  if (!re.test(main)) failures.push(`electron/main.js is missing ${what}`);
}

// ---- 4. no remote origin in the renderer ----
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (/https?:\/\//.test(html.replace(/<meta[\s\S]*?>/g, ''))) failures.push('index.html references a remote origin');
if (html.charCodeAt(0) === 0xfeff) failures.push('index.html starts with a byte-order mark');

// ---- 5. every IPC channel the preload uses has a handler ----
const preload = sourceText.get(path.join(ROOT, 'electron', 'preload.js')) || '';
const used = new Set([...preload.matchAll(/invoke\(\s*'([a-z]+:[A-Za-z]+)'/g)].map((m) => m[1]));
const handled = new Set([...main.matchAll(/handle\(\s*'([a-z]+:[A-Za-z]+)'/g)].map((m) => m[1]));
for (const c of used) if (!handled.has(c)) failures.push(`preload calls ${c} but main.js has no handler for it`);
for (const c of handled) if (!used.has(c)) notes.push(`main.js handles ${c}, which the preload never calls`);

// ---- 6. no raw control characters in source ----
// Two files once carried a raw NUL and a raw backspace where the author meant
// to write \x00 and \b. The code happened to behave identically, so nothing
// failed and nothing showed it. Raw control bytes in source are never intended.
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (!/\.(js|mjs|jsx|json|md|ps1|yml|nsh|html|css|toml)$/.test(rel)) continue;
  if (rel.startsWith('dist' + path.sep)) continue;
  const buf = fs.readFileSync(f);
  const ctrl = [...new Set([...buf].filter((b) => b < 0x09 || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f)))];
  if (ctrl.length) {
    failures.push(`${rel}: raw control byte(s) ${ctrl.map((b) => '0x' + b.toString(16)).join(', ')} — write the escape sequence instead`);
  }
}

// ---- 7. fonts are bundled, not fetched ----
const fontDir = path.join(ROOT, 'src', 'assets', 'fonts');
for (const f of ['Sora-Variable.woff2', 'Manrope-Variable.woff2', 'JetBrainsMono-Variable.woff2']) {
  if (!fs.existsSync(path.join(fontDir, f))) failures.push(`missing bundled font ${f}`);
}

for (const n of notes) console.log(`note: ${n}`);
if (failures.length) {
  console.error(`\nlint failed (${failures.length}):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log(`lint ok — ${jsFiles.length} js, ${jsxFiles.length} jsx checked`);
