---
name: phong-i18n
description: >-
  Add, change or remove user-facing copy in Phong across all seven locales (en es ja de fr pt
  zh). Use this whenever a change introduces or edits text a player can read — a button label,
  a modal, a toast, an error, an empty state, a tooltip — and whenever tests/i18n.test.ts
  fails, whenever the user mentions translations, locales, copy or wording, and whenever you
  are about to write a bare string into a component. In this repo an untranslated string does
  not fail the build and does not throw; it just renders in English (or as the raw key) to the
  player, so it must be caught here rather than noticed later.
---

# Copy in Phong

The rule (CLAUDE.md §9.11): **a user-facing string ships in all seven locales, or it is not
shipped** — and the dictionary and the product must agree in *both* directions.

Both failure modes are silent, which is the whole reason there is a skill for this. `t()`
falls back to English for a key a locale lacks, so an untranslated string renders in English —
70 of them accumulated that way, and a Japanese player just saw a half-English menu. And `t()`
returns the **key itself** for a key nothing defines, so a typo renders `menu_quickmach` on
screen instead of failing anywhere a developer would look.

## The tool

```bash
node .claude/skills/phong-i18n/scripts/locale-key.mjs audit
node .claude/skills/phong-i18n/scripts/locale-key.mjs add <key> \
     --en ".." --es ".." --ja ".." --de ".." --fr ".." --pt ".." --zh ".." [--after <siblingKey>]
node .claude/skills/phong-i18n/scripts/locale-key.mjs rm <key>
```

`TRANSLATIONS` is 3,600 lines, so one new string is seven insertions in seven places — the
tool does them in one call and refuses the two mistakes that are easy to make by hand:

- **A partial add is refused**, not defaulted. Six locales plus the English fallback is
  exactly the drift the rule exists to prevent, and it looks fine on screen.
- **Placeholders must match English.** A locale that drops a `{name}` renders a literal hole.

Use `--after` to place the key beside its siblings — the dictionary is grouped by feature, and
a key appended to the bottom of seven blocks is a key nobody finds again.

`audit` mirrors `tests/i18n.test.ts` exactly — same regexes, same "quoted anywhere counts"
rule — so the two can never disagree. It just names the key and the locale instead of printing
an array diff. The test is still the authority; run it after any write:

```bash
npx vitest run tests/i18n.test.ts
```

## Writing the translations

You are translating, not transliterating. Match the register of the surrounding keys — this
product's English is terse and physical ("Nothing Given", "Iron Wrist", "Machine Breaker"), so
a limp literal translation is a worse answer than a short idiomatic one. Keep UI labels short
enough for a phone: a German button that wraps to two lines breaks the layout the English one
fits.

If you genuinely cannot translate a term (a proper noun, a mode name that is deliberately the
same everywhere), keeping it identical across locales is a legitimate answer — but make it a
decision, not an omission.

## Removing copy

When `audit` or the test reports a **dead** key, deleting it is usually right: 47 of 333 keys
were once referenced nowhere, including ten theme names that had drifted out of sync with
`themes.ts` and would have rendered the wrong words if anything had used them. Dead weight is
cheap to carry and expensive to trust.

One trap worth knowing: **do not name a key in a test to keep it alive.** "Quoted anywhere
counts" means a test file referencing a key satisfies the dead-key check, which is how a test
becomes the only thing keeping a dead string in the product. If a key is only used by a test,
it is dead.

## Shipping the change

`tests/i18n.test.ts` is the authority on the dictionary and states it completely, so run it
first — it is where a locale problem will actually be named.

It is not a release gate, though. **Follow `phong-ship-check` like any other change**: an
earlier version of this skill told you to skip the browser suites for copy-only work, which
was wrong twice over. Copy is rendered by components, so a string that changes length or
wraps differently is exactly the kind of thing only a browser sees. And deciding which suites
a change needs from the file it touched is the reasoning `phong-ship-check` documents as
having failed — it is not this skill's call to make.
