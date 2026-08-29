export const meta = {
  name: 'research-audit',
  description: 'Architecture audit + bug scan + false-positive verification for Phong.',
  whenToUse: 'Before any bug-fix session. Produces a confirmed bug list.',
  phases: [
    { title: 'Architecture', detail: 'Map structure, protocol, data model, reward path' },
    { title: 'Bug Scan', detail: 'Find unknown bugs across the codebase' },
    { title: 'Verify', detail: 'Adversarial refutation of each finding' },
  ],
};

const ARCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keyFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          responsibility: { type: 'string' },
        },
        required: ['path', 'responsibility'],
      },
    },
    dataModel: { type: 'string' },
    rewardPath: { type: 'array', items: { type: 'string' } },
    multiplayerProtocol: { type: 'string' },
  },
  required: ['summary', 'keyFiles', 'dataModel', 'rewardPath'],
};

const BUGS_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          symptom: { type: 'string' },
          fixDirection: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'description'],
      },
    },
    notABug: { type: 'array', items: { type: 'string' } },
  },
  required: ['issues'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'confidence'],
};

// ─── Phase 1: Architecture Audit ───
phase('Architecture');
const arch = await agent(
  `Read the entire codebase at the repo root. Produce a structured architecture report:
1. Project structure: entry points, server/client split, how rooms/tables are created and destroyed.
2. Multiplayer protocol: transport (websocket? polling?), message types, how state is authoritative.
3. Data model: what does a "table" look like in memory/DB? What fields distinguish match types? How are players vs. spectators represented?
4. Reward/rank path: trace the full call chain from match-end to the final rank/XP/currency DB write. Include file:line references for each step.
5. Where is matchType stored? Is it validated server-side or trusted from the client?`,
  { label: 'architecture-audit', schema: ARCH_SCHEMA }
);

// ─── Phase 2: Bug Scan ───
phase('Bug Scan');
const bugs = await agent(
  `Given this architecture:
${JSON.stringify(arch, null, 2)}

Scan the codebase for bugs. Focus areas:
- Race conditions in multiplayer state (concurrent writes, stale state, missing locks).
- Unhandled edge cases: disconnect mid-match, reconnect, browser tab closed, server restart, duplicate messages.
- Security: can a client forge a match result? Can a spectator trigger a reward? Can a player join a table twice?
- Resource leaks: uncleared intervals, unremoved event listeners, sockets never closed.
- Consistency: two code paths writing the same field with different logic.
- Reward/rank path specifically: is there a gate on matchType before rank mutation? Are spectators filtered out? Is the ELO delta zero-sum?

Report each finding with severity, file, line, description, symptom (what the player observes), and a one-sentence fix direction.
Also list things you investigated and confirmed are NOT bugs.`,
  { label: 'bug-scan', schema: BUGS_SCHEMA }
);

// ─── Phase 3: Adversarial Verification (false-positive filter) ───
phase('Verify');
const toVerify = bugs.issues.filter(b => b.severity !== 'LOW');

const verified = await pipeline(
  toVerify,
  (issue) =>
    agent(
      `A reviewer claims this is a bug in the Phong game:
"${issue.title}" at ${issue.file}${issue.line ? ':' + issue.line : ''}
Description: ${issue.description}
Symptom: ${issue.symptom || 'N/A'}

Try your HARDEST to refute this. Read the actual code. Consider:
- Is there already a guard elsewhere that handles this?
- Is this dead code that's never reached?
- Is this actually intended behavior (documented or implied by the architecture)?
- Is the "bug" a style preference, not a defect?

Only say isReal=true if you CANNOT refute it after genuine investigation.`,
      { label: `verify: ${issue.title.slice(0, 40)}`, schema: VERDICT_SCHEMA }
    )
);

const confirmed = toVerify
  .map((issue, i) => ({ issue, verdict: verified[i] }))
  .filter(({ verdict }) => verdict?.isReal);

const deferred = toVerify
  .map((issue, i) => ({ issue, verdict: verified[i] }))
  .filter(({ verdict }) => !verdict?.isReal)
  .map(({ issue }) => issue.title);

const lowSeverity = bugs.issues.filter(b => b.severity === 'LOW').map(b => b.title);

return {
  architecture: arch,
  confirmedBugs: confirmed.map(({ issue }) => issue),
  falsePositives: deferred,
  lowSeverity: lowSeverity,
  notABug: bugs.notABug || [],
};   
