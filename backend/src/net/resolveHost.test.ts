import { describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { resolveHost } from './resolveHost.js';

vi.mock('node:dns/promises');

describe('resolveHost', () => {
  it('returns an IPv4 literal unchanged, without a DNS lookup', async () => {
    const result = await resolveHost('8.8.8.8');
    expect(result).toBe('8.8.8.8');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('returns an IPv6 literal unchanged, without a DNS lookup', async () => {
    const result = await resolveHost('2001:db8::1');
    expect(result).toBe('2001:db8::1');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('forward-resolves a hostname to an IP', async () => {
    vi.mocked(dns.lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const result = await resolveHost('example.com');
    expect(result).toBe('93.184.216.34');
    expect(dns.lookup).toHaveBeenCalledWith('example.com');
  });

  it('returns null when the hostname cannot be resolved', async () => {
    vi.mocked(dns.lookup).mockRejectedValue(new Error('ENOTFOUND'));
    const result = await resolveHost('unresolvable.example');
    expect(result).toBeNull();
  });
});
