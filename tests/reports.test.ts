import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-reports-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let DELETED_PLAYER_ID: typeof import('../src/profileRules').DELETED_PLAYER_ID;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
  ({ DELETED_PLAYER_ID } = await import('../src/profileRules'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const init = (id: string, username: string) => {
  db.getProfile(id);
  const r = db.initializeProfile(id, username);
  if (!r.ok) throw new Error(`init failed: ${r.code}`);
  return r.profile!;
};

describe('daily counters', () => {
  it('counts per day and per name, and never throws', () => {
    const day = new Date('2026-03-01T12:00:00Z');
    db.bumpCounter('visit', day);
    db.bumpCounter('visit', day);
    db.bumpCounter('onboarded', day);
    const rows = db.readCounters(7);
    const visit = rows.find((r) => r.dayKey === '2026-03-01' && r.name === 'visit');
    const onboarded = rows.find((r) => r.dayKey === '2026-03-01' && r.name === 'onboarded');
    expect(visit?.n).toBe(2);
    expect(onboarded?.n).toBe(1);
  });

  it('starts a new row on a new UTC day rather than adding to yesterday', () => {
    db.bumpCounter('visit', new Date('2026-03-02T23:59:59Z'));
    db.bumpCounter('visit', new Date('2026-03-03T00:00:01Z'));
    const rows = db.readCounters(30);
    expect(rows.find((r) => r.dayKey === '2026-03-02' && r.name === 'visit')?.n).toBe(1);
    expect(rows.find((r) => r.dayKey === '2026-03-03' && r.name === 'visit')?.n).toBe(1);
  });
});

describe('a report outlives its reporter', () => {
  it('follows the account when it signs in on another browser', () => {
    // A report is filed under a device id, and players.id IS a device id, so
    // a sign-in renames it out from under the row. moveAccount handles this
    // table by hand — it is not in PLAYER_KEYED_TABLES, because that loop
    // DELETES before it moves and a report must never be deleted.
    const from = 'dev_report0000000001';
    const to = 'dev_report0000000002';
    init(from, 'Reporter');
    db.fileReport({ playerId: from, username: 'Reporter', category: 'bug', text: 'ball vanished' });
    // Through the real door: signInWithCode is what moveAccount exists for.
    const signedIn = db.signInWithCode(db.getProfile(from).recoveryCode!, to);
    expect(signedIn?.id).toBe(to);
    const mine = db.listReports(50, false).filter((r) => r.playerId === to);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toBe('ball vanished');
    expect(db.listReports(50, false).some((r) => r.playerId === from)).toBe(false);
  });

  it('survives the reporter deleting their account, with the pointer scrubbed', () => {
    // The whole reason this table is HANDLED_APART. Deleting an account must
    // not be a way to clear the record — and the username goes with the id,
    // because a released name returns to the pool and would otherwise sit in
    // a report naming whoever claims it next.
    const device = 'dev_report0000000003';
    init(device, 'Vanisher');
    db.fileReport({ playerId: device, username: 'Vanisher', category: 'exploit', text: 'paddle clips' });
    db.deleteAccount(device);

    const rows = db.listReports(50, false).filter((r) => r.text === 'paddle clips');
    expect(rows).toHaveLength(1);
    expect(rows[0].playerId).toBe(DELETED_PLAYER_ID);
    expect(rows[0].username).not.toBe('Vanisher');
  });

  it('survives the person it is ABOUT deleting their account', () => {
    // The sharper half: an abuse report names somebody else, so the reported
    // player's own deletion must not take the evidence with it either.
    const reporter = 'dev_report0000000004';
    const subject = 'dev_report0000000005';
    init(reporter, 'Witness');
    init(subject, 'Accused');
    db.fileReport({
      playerId: reporter,
      username: 'Witness',
      category: 'abuse',
      text: 'avatar is not ok',
      subjectId: subject,
    });
    db.deleteAccount(subject);

    const rows = db.listReports(50, false).filter((r) => r.text === 'avatar is not ok');
    expect(rows).toHaveLength(1);
    expect(rows[0].playerId).toBe(reporter);
    expect(rows[0].subjectId).toBe(DELETED_PLAYER_ID);
  });
});

describe('the daily allowance', () => {
  it('counts only this player, and only today', () => {
    const a = 'dev_report0000000006';
    const b = 'dev_report0000000007';
    init(a, 'Chatty');
    init(b, 'Quiet');
    for (let i = 0; i < 3; i++) {
      db.fileReport({ playerId: a, username: 'Chatty', category: 'bug', text: `n${i}` });
    }
    expect(db.reportsToday(a)).toBe(3);
    expect(db.reportsToday(b)).toBe(0);
    // Tomorrow is a fresh allowance — the row is keyed on the day the report
    // was filed, so this is a read against a different key, not a reset.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(db.reportsToday(a, tomorrow)).toBe(0);
  });

  it('bounds the text at write time as well as at the route', () => {
    const device = 'dev_report0000000008';
    init(device, 'Verbose');
    db.fileReport({ playerId: device, username: 'Verbose', category: 'bug', text: 'x'.repeat(9000) });
    const row = db.listReports(50, false).find((r) => r.playerId === device)!;
    expect(row.text.length).toBeLessThanOrEqual(2000);
  });

  it('marks a report read so --unread means something on the next pass', () => {
    const device = 'dev_report0000000009';
    init(device, 'Once');
    const id = db.fileReport({ playerId: device, username: 'Once', category: 'other', text: 'hello' });
    expect(db.listReports(200, true).some((r) => r.id === id)).toBe(true);
    db.markReportRead(id);
    expect(db.listReports(200, true).some((r) => r.id === id)).toBe(false);
    expect(db.listReports(200, false).some((r) => r.id === id)).toBe(true);
  });
});
