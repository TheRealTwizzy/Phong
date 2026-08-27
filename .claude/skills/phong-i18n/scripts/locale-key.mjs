#!/usr/bin/env node
// locale-key.mjs — add, remove and audit keys across all seven locales.
//
// The rule (CLAUDE.md §9.11) is that a user-facing string ships in all seven
// locales or it does not ship. `t()` silently falls back to English for a key
// a locale lacks and returns the KEY ITSELF for one nothing defines, so both
// failure modes are invisible until a player sees them — which is how 70 keys
// drifted English-only and 47 more stayed in the file after the product
// stopped asking for them.
//
// tests/i18n.test.ts is the authority and this changes nothing about that.
// What it removes is the toil: TRANSLATIONS is 3,600 lines and one new string
// means seven insertions in seven places, each of which is a chance to drop a
// {placeholder} or a trailing comma. The audit here mirrors the test's
// detection EXACTLY (same regexes, same "quoted anywhere counts" rule) so the
// two can never disagree — it just says which key and which locale instead of
// printing an array diff.
//
//   node .claude/skills/phong-i18n/scripts/locale-key.mjs audit
//   node .claude/skills/phong-i18n/scripts/locale-key.mjs add menu_watch \
//        --en "Watch" --es "Ver" --ja "観戦" --de "Zuschauen" \
//        --fr "Regarder" --pt "Assistir" --zh "观战" --after menu_host
//   node .claude/skills/phong-i18n/scripts/locale-key.mjs rm menu_dead_string
//
// After any write: npx vitest run tests/i18n.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DICT = path.join(ROOT, 'src/i18n/translations.ts');
const LOCALES = ['en', 'es', 'ja', 'de', 'fr', 'pt', 'zh'];

// --- reading the dictionary ----------------------------------------------
// Line-based and deliberately tolerant, the way tests/protocolParity.test.ts
// reads the protocol: the goal is to name a key, not to police formatting.
// Values may wrap onto a second line, so an entry runs from its `key:` line
// to the line before the next one.
function parse(text) {
  const lines = text.split('\n');
  const blocks = {};
  let current = null;
  lines.forEach((line, i) => {
    const open = line.match(/^ {2}([a-z]{2}): \{$/);
    if (open && LOCALES.includes(open[1])) {
      current = { locale: open[1], start: i, entries: [] };
      return;
    }
    if (current && /^ {2}\},$/.test(line)) {
      current.end = i;
      blocks[current.locale] = current;
      current = null;
      return;
    }
    if (!current) return;
    const key = line.match(/^ {4}([A-Za-z0-9_]+):/);
    if (key) current.entries.push({ key: key[1], line: i });
  });
  for (const l of LOCALES) if (!blocks[l]) throw new Error(`could not parse locale block: ${l}`);
  // Where each entry really ends. Not simply "the line before the next key":
  // the dictionary is grouped by feature with `// App & Modes` headings and
  // blank separators between groups, and those belong to the group BELOW them.
  // Treating them as part of the entry above means removing the last key of a
  // group silently takes the next group's heading with it — a loss no test can
  // see, since the i18n suite has opinions about keys and none about layout.
  for (const locale of LOCALES) {
    const block = blocks[locale];
    block.entries.forEach((entry, idx) => {
      const limit = block.entries[idx + 1] ? block.entries[idx + 1].line : block.end;
      let end = entry.line;
      for (let i = entry.line + 1; i < limit; i++) {
        if (/^\s*$/.test(lines[i]) || /^\s*\/\//.test(lines[i])) break;
        end = i; // a wrapped value continuation
      }
      entry.end = end;
    });
  }
  return { lines, blocks };
}

/** The last line of an entry — its key line plus any wrapped value lines. */
const entryEnd = (block, idx) => block.entries[idx].end;

const placeholders = (s) => (s.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? []).sort();

// --- the product's side, read the same way the test reads it -------------
function productSource() {
  const out = [path.join(ROOT, 'server.ts')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith(path.join('i18n', 'translations.ts'))) {
        out.push(p);
      }
    }
  };
  for (const r of ['src', 'server']) walk(path.join(ROOT, r));
  return out.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

// --- audit ---------------------------------------------------------------
function audit() {
  const { lines, blocks } = parse(fs.readFileSync(DICT, 'utf8'));
  const keysOf = (l) => blocks[l].entries.map((e) => e.key);
  const en = keysOf('en');
  const enSet = new Set(en);
  let problems = 0;
  const say = (msg) => {
    problems++;
    console.log(msg);
  };

  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    const theirs = new Set(keysOf(locale));
    const missing = en.filter((k) => !theirs.has(k));
    const extra = [...theirs].filter((k) => !enSet.has(k));
    if (missing.length) say(`  ${locale}: missing ${missing.length} — ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
    if (extra.length) say(`  ${locale}: defines ${extra.length} key(s) English lacks — ${extra.join(', ')}`);
  }

  // Placeholder parity and blank values need the VALUES, so pull each entry's
  // text back out of the raw lines.
  const valueOf = (locale, key) => {
    const block = blocks[locale];
    const idx = block.entries.findIndex((e) => e.key === key);
    if (idx === -1) return null;
    return lines.slice(block.entries[idx].line, entryEnd(block, idx) + 1).join(' ');
  };
  for (const locale of LOCALES) {
    for (const { key } of blocks[locale].entries) {
      const raw = valueOf(locale, key);
      if (/:\s*(''|""|``|['"`]\s+['"`])\s*,?\s*$/.test(raw)) say(`  ${locale}.${key}: blank value`);
      if (locale === 'en') continue;
      // Unconditional, both directions: a locale that INVENTS a placeholder
      // English lacks is as broken as one that drops it — nothing supplies it,
      // so the player sees a literal `{ghost}`. Guarding this on
      // `want.length > 0` skips exactly that case.
      const want = placeholders(valueOf('en', key) ?? '');
      const got = placeholders(raw);
      if (got.join() !== want.join()) {
        say(
          `  ${locale}.${key}: placeholder mismatch — English declares ${want.join(' ') || '(none)'}, this has ${got.join(' ') || '(none)'}`
        );
      }
    }
  }

  const SOURCE = productSource();
  const dead = en.filter((k) => !new RegExp(`['"\`]${k}['"\`]`).test(SOURCE));
  if (dead.length) say(`  dead (defined, never quoted in src/ or server/): ${dead.join(', ')}`);

  const asked = new Set();
  for (const m of SOURCE.matchAll(/\bt\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) asked.add(m[1]);
  const absent = [...asked].filter((k) => !enSet.has(k));
  if (absent.length) say(`  asked for but undefined (renders as the raw key): ${absent.join(', ')}`);

  console.log(problems ? `\n${problems} problem(s).` : `Clean: ${en.length} keys x ${LOCALES.length} locales.`);
  return problems ? 1 : 0;
}

// --- add / rm ------------------------------------------------------------
function add(key, values, after) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`not a usable key: ${key}`);
  const absent = LOCALES.filter((l) => !values[l]);
  if (absent.length) {
    // Refused rather than defaulted. A key added to six locales is the exact
    // drift the rule exists to prevent, and English-everywhere is what the
    // fallback already does silently.
    throw new Error(`every locale or none — missing: ${absent.map((l) => `--${l}`).join(' ')}`);
  }
  const want = placeholders(values.en);
  for (const l of LOCALES) {
    if (placeholders(values[l]).join() !== want.join()) {
      throw new Error(`${l} must carry the same placeholders as English (${want.join(' ') || 'none'})`);
    }
  }

  const text = fs.readFileSync(DICT, 'utf8');
  const { lines, blocks } = parse(text);
  if (blocks.en.entries.some((e) => e.key === key)) throw new Error(`${key} already exists`);

  // Insert bottom-up so earlier insertions do not shift later line numbers.
  const inserts = LOCALES.map((locale) => {
    const block = blocks[locale];
    let at = block.end; // default: just before the block's closing brace
    if (after) {
      const idx = block.entries.findIndex((e) => e.key === after);
      if (idx === -1) throw new Error(`--after ${after} is not in the ${locale} block`);
      at = entryEnd(block, idx) + 1;
    }
    // JSON.stringify gives double quotes with everything escaped, which is
    // what the file already uses wherever a value contains an apostrophe.
    return { at, text: `    ${key}: ${JSON.stringify(values[locale])},` };
  }).sort((a, b) => b.at - a.at);

  for (const ins of inserts) lines.splice(ins.at, 0, ins.text);
  fs.writeFileSync(DICT, lines.join('\n'));
  console.log(`Added ${key} to all ${LOCALES.length} locales${after ? ` after ${after}` : ''}.`);
  console.log('Now: npx vitest run tests/i18n.test.ts');
}

function rm(key) {
  const { lines, blocks } = parse(fs.readFileSync(DICT, 'utf8'));
  const ranges = [];
  for (const locale of LOCALES) {
    const block = blocks[locale];
    const idx = block.entries.findIndex((e) => e.key === key);
    if (idx === -1) continue;
    ranges.push({ from: block.entries[idx].line, to: entryEnd(block, idx) });
  }
  if (!ranges.length) throw new Error(`${key} is in no locale`);
  for (const r of ranges.sort((a, b) => b.from - a.from)) lines.splice(r.from, r.to - r.from + 1);
  fs.writeFileSync(DICT, lines.join('\n'));
  console.log(`Removed ${key} from ${ranges.length} locale(s).`);
  console.log('Now: npx vitest run tests/i18n.test.ts');
}

// --- cli -----------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'audit' || !cmd) process.exit(audit());
  if (cmd === 'add' || cmd === 'rm') {
    const key = rest.find((a) => !a.startsWith('--'));
    if (!key) throw new Error(`${cmd} needs a key`);
    if (cmd === 'rm') {
      rm(key);
      process.exit(0);
    }
    const values = {};
    let after;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i].match(/^--([a-z]{2}|after)$/);
      if (flag) values[flag[1]] = rest[++i];
    }
    after = values.after;
    delete values.after;
    add(key, values, after);
    process.exit(0);
  }
  console.error(`usage: locale-key.mjs audit | add <key> --en .. --es .. --ja .. --de .. --fr .. --pt .. --zh .. [--after <key>] | rm <key>`);
  process.exit(2);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
