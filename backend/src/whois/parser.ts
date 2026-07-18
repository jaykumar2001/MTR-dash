export interface WhoisField {
  key: string;
  value: string;
}

/**
 * Parses raw WHOIS response text into an ordered list of key/value fields.
 * WHOIS output isn't a single standard format (it varies by registrar/RIR),
 * but nearly all of them use "Key: Value" lines with `%`/`#` comment lines
 * and blank separators — this covers that common shape without attempting
 * per-registrar special-casing.
 */
export function parseWhois(raw: string): WhoisField[] {
  const fields: WhoisField[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%') || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key || !value) continue;
    fields.push({ key, value });
  }
  return fields;
}

const NETNAME_KEYS = ['netname', 'net-name', 'orgname', 'org-name'];

/**
 * Extracts a human-readable network name from parsed whois fields, checking
 * a few of the common key spellings used across registrars (RIPE/APNIC use
 * "netname", ARIN-style records often use "OrgName") and returning the first
 * match found. Returns null if none of those keys are present.
 */
export function extractNetname(fields: WhoisField[]): string | null {
  for (const key of NETNAME_KEYS) {
    const match = fields.find((f) => f.key.toLowerCase() === key);
    if (match) return match.value;
  }
  return null;
}
