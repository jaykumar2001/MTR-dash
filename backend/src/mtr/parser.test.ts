import { describe, expect, it } from 'vitest';
import { parseMtrJson } from './parser.js';

const SAMPLE = JSON.stringify({
  report: {
    mtr: { src: 'localhost', dst: '1.1.1.1', tos: '0x0', tests: 10 },
    hubs: [
      {
        count: 1,
        host: '192.168.1.1',
        'Loss%': 0.0,
        Snt: 10,
        Last: 1.2,
        Avg: 1.5,
        Best: 1.0,
        Wrst: 2.0,
        StDev: 0.3,
      },
      {
        count: 2,
        host: '10.0.0.1',
        'Loss%': 10.0,
        Snt: 10,
        Last: 5.2,
        Avg: 5.5,
        Best: 4.9,
        Wrst: 7.0,
        StDev: 0.8,
      },
    ],
  },
});

describe('parseMtrJson', () => {
  it('parses hops with the correct field mapping', () => {
    const result = parseMtrJson(SAMPLE);
    expect(result.target).toBe('1.1.1.1');
    expect(result.hops).toHaveLength(2);
    expect(result.hops[0]).toEqual({
      ttl: 1,
      host: '192.168.1.1',
      lossPct: 0,
      snt: 10,
      last: 1.2,
      avg: 1.5,
      best: 1.0,
      wrst: 2.0,
      stdev: 0.3,
    });
    expect(result.hops[1].lossPct).toBe(10);
  });

  it('throws on malformed JSON missing report.hubs', () => {
    expect(() => parseMtrJson(JSON.stringify({ report: {} }))).toThrow(
      /missing report.hubs/,
    );
  });
});
