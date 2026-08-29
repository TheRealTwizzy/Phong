export const meta = {
  name: 'implement-fixes',
  description: 'Plan, implement, and verify fixes for confirmed bugs in Phong.',
  whenToUse: 'After research-audit workflow produces a confirmed bug list and user approves scope.',
  phases: [
    { title: 'Plan', detail: 'Design the fix for each confirmed bug' },
    { title: 'Implement', detail: 'Write the code, one file at a time' },
    { title: 'Verify', detail: 'Re-read changes, run tests, confirm invariants' },
  ],
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bugTitle: { type: 'string' },
          file: { type: 'string' },
          change: { type: 'string' },
          reason: { type: 'string' },
          test: { type: 'string' },
        },
        required: ['bugTitle', 'file', 'change'],
      },
    },
    gateFunction: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['checklist', 'gateFunction'],
};

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    changedFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['path', 'summary'],
      },
    },
    testResults: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['changedFiles', 'testResults'],
};

const FINAL_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    nonRankedNoWrites: { type: 'boolean' },
    zeroSumVerified: { type: 'boolean' },
    spectatorNoWrites: { type: 'boolean' },
    kFactorCorrect: { type: 'boolean' },
    otherRankPaths: { type: 'array', items: { type: 'string' } },
    commitMessage: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['nonRankedNoWrites', 'zeroSumVerified', 'spectatorNoWrites', 'kFactorCorrect'],
};

// ─── Phase 1: Plan ───
phase('Plan');
const plan = await agent(
  `You are planning fixes for the Phong multiplayer web game.

Confirmed bugs to fix:
${JSON.stringify(CONFIRMED_BUGS, null, 2)}

Architecture context:
${JSON.stringify(ARCH_CONTEXT, null, 2)}

Rules:
- The ranked-gate must be a SINGLE choke-point function (e.g., isRankedTable(table)).
  Call it at the top of the reward function. Early-return if false.
- Do NOT change the ELO formula. K = 32 (K = 40 for < 15 ranked matches).
- For the delta-sign bug: fix the specific line, do not refactor.
- For spectators: filter by role BEFORE the reward loop, not inside it.
- If matchType is client-side only, include server-side validation in the plan.
- Each fix must include a test case.

Produce a numbered implementation checklist. For each item: which bug, which file, exact change description, and the test to add.
Also specify the gate function signature and where it should live.`,
  { label: 'plan', schema: PLAN_SCHEMA }
);

// ─── Phase 2: Implement ───
phase('Implement');
const impl = await agent(
  `Execute this plan exactly, one file at a time.

Plan:
${JSON.stringify(plan, null, 2)}

Rules:
- One file at a time. After each file, state what changed and why.
- Add the ranked-gate as a single guard function. Call it at the top of the reward function.
- For the delta-sign bug: fix the specific line, add a comment explaining the sign convention.
- For spectators: filter by role before the reward loop.
- Add all unit tests from the plan. Run them. If they fail, fix and re-run.
- Do NOT touch any file not listed in the plan.

When done, report: changed files, test results, and any assumptions made.`,
  { label: 'implement', schema: RESULT_SCHEMA }
);

// ─── Phase 3: Verify ───
phase('Verify');
const finalCheck = await agent(
  `Re-read the reward function and all changed files end-to-end. Verify:
1. Non-ranked table → ZERO writes to rank, XP, currency, stats, or any profile field.
2. Ranked table → exactly one positive and one negative delta (1v1), or sum(deltas) === 0 (team).
3. Spectator → ZERO writes, period. No "lastResult", no "matchesPlayed" increment.
4. K-factor: < 15 ranked matches → K=40, >= 15 → K=32. Only applied when isRankedTable() is true.
5. Check for ANY OTHER code path that mutates rank (daily reward, streak bonus, admin command, etc.).

If everything passes, write a conventional-commit message summarizing all fixes.
If anything fails, list the specific issue.`,
  { label: 'final-verify', schema: FINAL_CHECK_SCHEMA }
);

return { plan, impl, finalCheck };   
