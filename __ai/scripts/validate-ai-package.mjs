#!/usr/bin/env node
// Validates the __ai reference package and the .claude/skills that consume it.
// Run: npm run ai:validate
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const aiDir = resolve(scriptDir, '..');
const repoRoot = resolve(aiDir, '..');
const skillsRoot = join(repoRoot, '.claude', 'skills');
const abiPath = join(repoRoot, 'src', 'chain', 'abi', 'Zarya.abi.json');

const problems = [];
const fail = (msg) => problems.push(msg);

const REQUIRED = [
  'CLAUDE.md',
  '__ai/README.md',
  '__ai/ROUTER.md',
  '__ai/references/ARCHITECTURE.md',
  '__ai/references/CONTRACT.md',
  '__ai/references/DECISIONS.md',
  '__ai/references/DEPLOYMENT.md',
  '__ai/references/DOCUMENTATION_STATUS.md',
  '__ai/references/IMPLEMENTATION_ORDER.md',
  '__ai/references/INVARIANTS.md',
  '__ai/references/STATE_MACHINES.md',
  '__ai/references/USE_CASES.md',
  '__ai/templates/BUG_TASK.md',
  '__ai/templates/IMPLEMENTATION_TASK.md',
  'src/chain/abi/Zarya.abi.json',
];

// Frontmatter keys Claude Code accepts in a project skill. The stricter
// six-field Agent Skills limit applies only to claude.ai uploads and the
// Skills API, not to skills read from .claude/skills/.
const ALLOWED_KEYS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments',
  'disable-model-invocation', 'user-invocable', 'allowed-tools',
  'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background',
  'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility',
]);

const MAX_SKILL_LINES = 200;

// ---------------------------------------------------------------- structure

for (const rel of REQUIRED) {
  try {
    await access(join(repoRoot, rel));
  } catch {
    fail(`missing required file: ${rel}`);
  }
}

// ---------------------------------------------------------------------- abi

let abiSymbols = new Set();
try {
  const abi = JSON.parse(await readFile(abiPath, 'utf8'));
  if (!Array.isArray(abi)) {
    fail('src/chain/abi/Zarya.abi.json must be a bare ABI array, not a build artifact');
  } else {
    abiSymbols = new Set(abi.map((e) => e.name).filter(Boolean));
  }
} catch (err) {
  fail(`cannot read ABI: ${err.message}`);
}

// -------------------------------------------------------------------- files

/** Collect every markdown file we own, plus this script. */
async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const docs = [
  ...(await collect(aiDir)),
  join(repoRoot, 'CLAUDE.md'),
];

let skillDirs = [];
try {
  skillDirs = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
} catch {
  fail('missing .claude/skills/ — skills must live where Claude Code reads them');
}

if (skillDirs.length === 0) fail('no skills found in .claude/skills/');

const skillFiles = skillDirs.map((n) => join(skillsRoot, n, 'SKILL.md'));
const allFiles = [...docs, ...skillFiles];

/** relative path for messages */
const rel = (p) => p.replace(repoRoot + '\\', '').replace(repoRoot + '/', '').replace(/\\/g, '/');

// ------------------------------------------------------------------ content

const bodies = new Map();

for (const file of allFiles) {
  let raw;
  try {
    raw = await readFile(file);
  } catch {
    fail(`unreadable: ${rel(file)}`);
    continue;
  }

  const text = raw.toString('utf8');
  bodies.set(file, text);

  // UTF-8 integrity. Cyrillic organ identifiers get silently mangled by
  // PowerShell 5.1's ANSI default; catch it before it reaches an organ call.
  if (text.includes('�')) {
    fail(`${rel(file)}: contains U+FFFD — file is not valid UTF-8`);
  }
  // Distinctive digraphs produced when UTF-8 Cyrillic is decoded as CP1251
  // (SOV -> the sequence below, curly quotes -> another). Verified against
  // real samples with zero false positives on genuine Russian text.
  const mojibake = /вЂ|рџ|Р[ЎћџЂ—”›’љќІ]|С[ЃѓЂ]/.exec(text);
  if (mojibake) {
    fail(`${rel(file)}: ${JSON.stringify(mojibake[0])} looks like UTF-8 decoded as CP1251 — rewrite the file as UTF-8`);
  }
}

// --------------------------------------------------------- skill frontmatter

for (const name of skillDirs) {
  const file = join(skillsRoot, name, 'SKILL.md');
  const text = bodies.get(file);
  if (text === undefined) {
    fail(`missing .claude/skills/${name}/SKILL.md`);
    continue;
  }

  // The check that the old generated-wrapper installer would have failed:
  // frontmatter must be the very first bytes of the file.
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    fail(`.claude/skills/${name}/SKILL.md: frontmatter must start at byte 0 (no comment or blank line above it)`);
    continue;
  }

  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    fail(`.claude/skills/${name}/SKILL.md: unterminated frontmatter block`);
    continue;
  }

  const fm = text.slice(4, end);
  const keys = [];
  for (const line of fm.split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line)) continue; // nested value
    const m = /^([A-Za-z0-9_-]+):/.exec(line);
    if (m) keys.push(m[1]);
  }

  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) {
      fail(`.claude/skills/${name}/SKILL.md: unknown frontmatter key '${key}'`);
    }
  }

  if (!keys.includes('description')) {
    fail(`.claude/skills/${name}/SKILL.md: missing description — Claude needs it to route`);
  }

  const declared = /^name:\s*(\S+)\s*$/m.exec(fm);
  if (declared && declared[1] !== name) {
    fail(`.claude/skills/${name}/SKILL.md: name '${declared[1]}' does not match its directory`);
  }

  // context: fork implies background: false unless the author opted in —
  // a backgrounded fork detaches and loses the full tool set.
  if (/^context:\s*fork\s*$/m.test(fm) && !/^background:\s*/m.test(fm)) {
    fail(`.claude/skills/${name}/SKILL.md: context: fork without an explicit background — set 'background: false' to keep the result in-turn`);
  }

  const lines = text.split(/\r?\n/).length;
  if (lines > MAX_SKILL_LINES) {
    fail(`.claude/skills/${name}/SKILL.md: ${lines} lines exceeds ${MAX_SKILL_LINES} — skill bodies stay in context, so keep them lean`);
  }
}

// ------------------------------------------------------------- cross-links

const LINK = /`(__ai\/[A-Za-z0-9_./-]+|src\/chain\/abi\/[A-Za-z0-9_.]+|contracts\/[A-Za-z0-9_.]+)`/g;

// A path containing a placeholder token describes a naming pattern, not a file.
const isPlaceholder = (p) => /YYYY|MM-DD|<[^>]+>|\*|\.\.\./.test(p);

for (const [file, text] of bodies) {
  for (const [, target] of text.matchAll(LINK)) {
    if (target.endsWith('/')) continue; // directory reference
    if (isPlaceholder(target)) continue; // naming pattern, e.g. worklog filenames
    try {
      await access(join(repoRoot, target));
    } catch {
      fail(`${rel(file)}: broken reference to '${target}'`);
    }
  }
}

// --------------------------------------------------- doc/ABI conformance

// Every backticked identifier that looks like a contract call must exist in
// the ABI. This is what turns documentation drift into a failing check.
// Identifiers the docs mention that are deliberately not ABI members. Adding a
// new client-side function name to the docs means adding it here — a small cost
// that keeps the ABI check strict enough to catch a real rename.
const KNOWN_NON_ABI = new Set([
  // contract-adjacent: structs, enums, internal state
  'VotingEligibilityParameters', 'VoteResults', 'DecodedCheckpoint', 'Voting',
  'Region', 'PartyOrganType', 'SuggestionType',
  '_votingEligibilityParametersByOrgan', 'eligibilityParameters',
  // documented by temporal_docs but absent from the ABI — discussed on purpose
  'ValueAdded', 'getChairman', 'getVoting',
  // client-side and platform functions
  'reconcile', 'send', 'openDevTools', 'setTimeout', 'sendTransaction',
  'supports', 'parse', 'getBatch', 'submitBatch', 'getExecutorStatus',
  'runExecutorNow', 'onExecutorStatus', 'listFormTypes', 'issueForm',
  'importForms',
]);

// Solidity keywords, modifiers, and value types that precede a paren but are
// not calls.
const SOL_NOISE = new Set([
  'returns', 'return', 'mapping', 'struct', 'enum', 'function', 'modifier',
  'external', 'internal', 'public', 'private', 'view', 'pure', 'payable',
  'nonpayable', 'indexed', 'memory', 'storage', 'calldata', 'immutable',
  'constant', 'require', 'revert', 'emit', 'error', 'event', 'address',
  'bool', 'string', 'interface', 'contract', 'library', 'using', 'abi',
  'encodePacked', 'push', 'add', 'remove',
]);
const isSolType = (s) => /^(u?int\d*|bytes\d*)$/.test(s);

/** Contract identifiers cited in a file: inline `foo(` plus solidity fences. */
function citedSymbols(text) {
  const found = new Set();

  // inline prose citations: `executeVoting(votingId)`
  for (const [, s] of text.matchAll(/`([a-z][A-Za-z0-9]{3,})\(/g)) found.add(s);

  // fenced solidity blocks — the primary drift surface
  for (const [, block] of text.matchAll(/```solidity\n([\s\S]*?)```/g)) {
    for (const [, s] of block.matchAll(/(?:^|[\s(])([a-z][A-Za-z0-9]{3,})\s*\(/gm)) {
      if (!SOL_NOISE.has(s) && !isSolType(s)) found.add(s);
    }
  }
  return found;
}

for (const [file, text] of bodies) {
  if (!/references|CLAUDE\.md|SKILL\.md/.test(rel(file))) continue;
  for (const symbol of citedSymbols(text)) {
    if (KNOWN_NON_ABI.has(symbol) || SOL_NOISE.has(symbol)) continue;
    if (abiSymbols.size && !abiSymbols.has(symbol)) {
      fail(`${rel(file)}: cites '${symbol}()' which is not in the ABI — stale doc or renamed function`);
    }
  }
}

// ----------------------------------------------------------------- worklog

// Entries are append-only records of what happened. Shape is enforced so the
// sections that matter — evidence, and what stayed unverified — cannot be
// quietly skipped.
const WORKLOG_HEADINGS = ['## Ask', '## Changes', '## Evidence', '## Unverified'];
const worklogDir = join(aiDir, 'worklog');
let worklogCount = 0;

for (const [file, text] of bodies) {
  if (!file.startsWith(worklogDir)) continue;
  worklogCount++;
  const name = file.slice(worklogDir.length + 1);

  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(name)) {
    fail(`__ai/worklog/${name}: name must be YYYY-MM-DD-kebab-slug.md`);
  }
  for (const heading of WORKLOG_HEADINGS) {
    if (!text.split(/\r?\n/).some((l) => l.trim() === heading)) {
      fail(`__ai/worklog/${name}: missing required '${heading}' section`);
    }
  }
}

// -------------------------------------------------------- stale terminology

// Governance documents are PDF AcroForms. DOCX was the earlier design and its
// vocabulary carried different security assumptions (ZIP bombs, macros,
// zip-slip) that do not apply. Keep it from creeping back.
//
// The worklog is exempt: it records what happened, including the migration
// away from DOCX, and is append-only. History has to be able to name what it
// replaced; only the current rules are held to current vocabulary.
for (const [file, text] of bodies) {
  if (file.startsWith(worklogDir)) continue;
  const stale = /\bDOCX\b|\.docx\b|\bWord document\b/i.exec(text);
  if (stale) {
    fail(`${rel(file)}: mentions ${JSON.stringify(stale[0])} — documents are PDF AcroForms; see .claude/skills/zarya-pdf-forms/`);
  }
}

// ------------------------------------------------------------- single-source

const ADDRESS = /0x141eb27110329c82de3c95045c96f6ebf15fdc4b/i;
const holders = [...bodies].filter(([, t]) => ADDRESS.test(t)).map(([f]) => rel(f));
if (holders.length > 1) {
  fail(`deployment address appears in ${holders.length} files (${holders.join(', ')}) — it belongs only in __ai/references/DEPLOYMENT.md`);
}

// -------------------------------------------------------------------- report

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}

const docLines = [...bodies.values()].reduce((n, t) => n + t.split(/\r?\n/).length, 0);
console.log(
  `AI package OK — ${skillDirs.length} skills, ${bodies.size} documents ` +
    `(${worklogCount} worklog), ${docLines} lines, ${abiSymbols.size} ABI symbols cross-checked.`,
);
