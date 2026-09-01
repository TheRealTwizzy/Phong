// What a report is, shared by the client and the server — the same convention
// as profileRules.ts and matchRules.ts, and for the same reason: the form is
// drawn by the client, so every bound it draws has to be one the route
// actually enforces, or the form is describing a different product.

export const REPORT_CATEGORIES = ['bug', 'exploit', 'abuse', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Short enough that a one-line report is allowed, long enough that an empty
 * box or a stray tap is not a report.
 */
export const REPORT_TEXT_MIN = 10;

/**
 * Per player, per UTC day.
 *
 * Counted from the reports table rather than from memory, unlike the sign-in
 * limiter: an in-memory counter is reset by every deploy, and a deploy is
 * exactly when a wave of reports arrives.
 */
export const REPORTS_PER_DAY = 20;

/** Which categories name somebody else rather than the game. */
export const reportNeedsSubject = (category: ReportCategory): boolean => category === 'abuse';
