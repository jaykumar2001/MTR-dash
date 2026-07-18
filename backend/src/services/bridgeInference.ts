import type Database from 'better-sqlite3';

const NO_REPLY_HOST = '???';
const RECENT_OCCURRENCE_LIMIT = 20;

interface Occurrence {
  runId: number;
  ttl: number;
}

/**
 * Finds a specific, real identity for a "???" gap when exactly one distinct
 * real intermediate sequence has ever connected the gap's two bounding hosts
 * in this target's recent history — never a best-effort/most-recent guess,
 * since a wrong specific guess is worse than an honest "unknown" (e.g. under
 * ECMP/load-balanced routing, different times can genuinely take different
 * real paths between the same two endpoints).
 *
 * Lookback is capped to each host's most recent RECENT_OCCURRENCE_LIMIT
 * appearances for the target (not full history, not a time window) — see
 * docs/superpowers/specs/2026-07-11-known-bridge-identity-inference-design.md.
 */
export class BridgeInferenceService {
  private recentOccurrencesStmt: Database.Statement;
  private hopAtTtlStmt: Database.Statement;
  private distinctRealHostsAtTtlStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.recentOccurrencesStmt = this.db.prepare(
      `SELECT h.run_id as runId, h.ttl as ttl FROM hops h
       JOIN runs r ON h.run_id = r.id
       WHERE r.target_id = ? AND h.host = ?
       ORDER BY h.run_id DESC LIMIT ?`,
    );
    this.hopAtTtlStmt = this.db.prepare('SELECT host FROM hops WHERE run_id = ? AND ttl = ?');
    // LIMIT 2: callers only distinguish zero / exactly-one / more-than-one.
    this.distinctRealHostsAtTtlStmt = this.db.prepare(
      `SELECT DISTINCT h.host as host FROM hops h
       JOIN runs r ON h.run_id = r.id
       WHERE r.target_id = ? AND h.ttl = ? AND h.host != ?
       LIMIT 2`,
    );
  }

  private recentOccurrences(targetId: number, host: string): Occurrence[] {
    return this.recentOccurrencesStmt.all(
      targetId,
      host,
      RECENT_OCCURRENCE_LIMIT,
    ) as Occurrence[];
  }

  private hopAt(runId: number, ttl: number): string | undefined {
    const row = this.hopAtTtlStmt.get(runId, ttl) as { host: string } | undefined;
    return row?.host;
  }

  /**
   * Sole distinct real sequence of exactly `exactLen` hosts connecting
   * `nearHost` to `farHost` (in `direction`), if this target's recent
   * history shows exactly one such sequence; null if zero or if occurrences
   * disagree.
   */
  findExactBridge(
    targetId: number,
    nearHost: string,
    farHost: string,
    exactLen: number,
    direction: 1 | -1,
  ): string[] | null {
    const occurrences = this.recentOccurrences(targetId, nearHost);
    const distinct = new Map<string, string[]>();

    for (const occ of occurrences) {
      const hosts: string[] = [];
      let ttl = occ.ttl;
      let ok = true;
      for (let i = 0; i < exactLen; i++) {
        ttl += direction;
        const host = this.hopAt(occ.runId, ttl);
        if (host === undefined || host === NO_REPLY_HOST) {
          ok = false;
          break;
        }
        hosts.push(host);
      }
      if (!ok) continue;
      const finalHost = this.hopAt(occ.runId, ttl + direction);
      if (finalHost !== farHost) continue;
      distinct.set(JSON.stringify(hosts), hosts);
    }

    if (distinct.size !== 1) return null;
    return distinct.values().next().value as string[];
  }

  /**
   * Sole distinct real sequence starting at `nearHost` (in `direction`), up
   * to `maxLen` hosts — stopping early if it hits another "???" (a
   * confirmed boundary), or using the full `maxLen` if it doesn't. Null if
   * no occurrence has any real data, or if occurrences disagree.
   */
  findKnownContinuation(
    targetId: number,
    nearHost: string,
    maxLen: number,
    direction: 1 | -1,
  ): string[] | null {
    const occurrences = this.recentOccurrences(targetId, nearHost);
    let matched: string[] | null = null;
    let matchedKey: string | null = null;

    for (const occ of occurrences) {
      const hosts: string[] = [];
      let ttl = occ.ttl;
      let deadEnd = false;
      for (let i = 0; i < maxLen; i++) {
        ttl += direction;
        const host = this.hopAt(occ.runId, ttl);
        if (host === undefined) {
          deadEnd = true;
          break;
        }
        if (host === NO_REPLY_HOST) break;
        hosts.push(host);
      }
      if (deadEnd || hosts.length === 0) continue;
      const key = JSON.stringify(hosts);
      if (matchedKey === null) {
        matchedKey = key;
        matched = hosts;
      } else if (key !== matchedKey) {
        return null;
      }
    }

    return matched;
  }

  /**
   * Sole real identity ever recorded at this exact ttl for the target, with
   * both neighboring ttls likewise unanimous — the long-horizon fallback
   * for hops whose identity evidence is older than the recent-occurrence
   * window (e.g. a router that answers probes a few minutes per day). Null
   * on zero real sightings (no evidence is not evidence) or two-plus
   * distinct identities at any of the three ttls — any historical
   * disagreement vetoes, permanently. The unbounded horizon is safe
   * because more history only makes unanimity harder to pass, never
   * easier. See
   * docs/superpowers/specs/2026-07-13-long-horizon-identity-inference-design.md.
   */
  findSoleIdentityAtTtl(targetId: number, ttl: number): string | null {
    const at = this.distinctRealHostsAtTtl(targetId, ttl);
    if (at.length !== 1) return null;
    // ttl 1's left bound is the monitoring source itself — structural,
    // known a priori, and never present in hops (mtr numbering starts at
    // 1) — so there is nothing to verify on that side. No route change
    // can ever alter what sits before ttl 1.
    if (ttl > 1 && this.distinctRealHostsAtTtl(targetId, ttl - 1).length !== 1) return null;
    if (this.distinctRealHostsAtTtl(targetId, ttl + 1).length !== 1) return null;
    return at[0];
  }

  private distinctRealHostsAtTtl(targetId: number, ttl: number): string[] {
    return (
      this.distinctRealHostsAtTtlStmt.all(targetId, ttl, NO_REPLY_HOST) as { host: string }[]
    ).map((r) => r.host);
  }
}
