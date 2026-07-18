import { describe, expect, it } from 'vitest';
import { parseWhois, extractNetname } from './parser.js';

describe('parseWhois', () => {
  it('parses key: value lines into fields, in order', () => {
    const raw = [
      '% comment line, ignored',
      '',
      'NetRange:       1.1.1.0 - 1.1.1.255',
      'CIDR:           1.1.1.0/24',
      'NetName:        APNIC-1-1-1-1',
    ].join('\n');

    expect(parseWhois(raw)).toEqual([
      { key: 'NetRange', value: '1.1.1.0 - 1.1.1.255' },
      { key: 'CIDR', value: '1.1.1.0/24' },
      { key: 'NetName', value: 'APNIC-1-1-1-1' },
    ]);
  });

  it('skips lines with no colon and lines with an empty key or value', () => {
    const raw = ['no colon here', 'EmptyValue:', ': missing key', 'Key: Value'].join('\n');
    expect(parseWhois(raw)).toEqual([{ key: 'Key', value: 'Value' }]);
  });

  it('skips comment lines starting with % or #', () => {
    const raw = ['% comment: value', '# comment: value', 'Real: Value'].join('\n');
    expect(parseWhois(raw)).toEqual([{ key: 'Real', value: 'Value' }]);
  });

  it('returns an empty array for only comments/blank lines', () => {
    expect(parseWhois('% just a comment\n\n# another comment\n')).toEqual([]);
  });
});

describe('extractNetname', () => {
  it('extracts a RIPE/APNIC-style "netname" field, case-insensitively', () => {
    expect(extractNetname([{ key: 'netname', value: 'APNIC-LABS' }])).toBe('APNIC-LABS');
    expect(extractNetname([{ key: 'NetName', value: 'APNIC-LABS' }])).toBe('APNIC-LABS');
  });

  it('falls back to an ARIN-style "OrgName" field when netname is absent', () => {
    expect(extractNetname([{ key: 'OrgName', value: 'Example Org' }])).toBe('Example Org');
  });

  it('prefers netname over orgname when both are present', () => {
    const fields = [
      { key: 'OrgName', value: 'Example Org' },
      { key: 'netname', value: 'EXAMPLE-NET' },
    ];
    expect(extractNetname(fields)).toBe('EXAMPLE-NET');
  });

  it('returns null when no recognized netname key is present', () => {
    expect(extractNetname([{ key: 'country', value: 'US' }])).toBeNull();
  });
});
