#!/usr/bin/env node
// Downloads ipdeny.com's country CIDR-block zone files (IPv4 + IPv6),
// converts them into compact JSON range arrays using this project's own
// tested ipMath conversion logic, and writes geoip-v4.json/geoip-v6.json to
// the output directory given as the first argument.
//
// Run once at Docker build time (see the Dockerfile's backend-builder
// stage, after `npm run build` so dist/geoip/ipMath.js exists) — the final
// runtime image has no network dependency on ipdeny.com at all.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cidrToRangeV4, cidrToRangeV6 } from '../dist/geoip/ipMath.js';

const V4_URL = 'https://www.ipdeny.com/ipblocks/data/countries/all-zones.tar.gz';
const V6_URL = 'https://www.ipdeny.com/ipv6/ipaddresses/blocks/ipv6-all-zones.tar.gz';

const outDir = process.argv[2] ?? './geoip-data';
fs.mkdirSync(outDir, { recursive: true });

async function downloadAndExtract(url, label) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `geoip-${label}-`));
  const tarballPath = path.join(tmpDir, 'archive.tar.gz');
  console.log(`Downloading ${label} zones from ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${label} zones: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tarballPath, buffer);
  const extractDir = path.join(tmpDir, 'extracted');
  fs.mkdirSync(extractDir);
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir]);
  return extractDir;
}

function zoneFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.zone'));
}

function buildV4Ranges(zoneDir) {
  const ranges = [];
  for (const file of zoneFiles(zoneDir)) {
    const country = path.basename(file, '.zone').toUpperCase();
    for (const line of fs.readFileSync(path.join(zoneDir, file), 'utf-8').split('\n')) {
      const cidr = line.trim();
      if (!cidr) continue;
      const range = cidrToRangeV4(cidr);
      if (range) ranges.push({ start: range.start, end: range.end, country });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function buildV6Ranges(zoneDir) {
  const ranges = [];
  for (const file of zoneFiles(zoneDir)) {
    const country = path.basename(file, '.zone').toUpperCase();
    for (const line of fs.readFileSync(path.join(zoneDir, file), 'utf-8').split('\n')) {
      const cidr = line.trim();
      if (!cidr) continue;
      const range = cidrToRangeV6(cidr);
      if (range) ranges.push({ startHex: range.startHex, endHex: range.endHex, country });
    }
  }
  ranges.sort((a, b) => (a.startHex < b.startHex ? -1 : a.startHex > b.startHex ? 1 : 0));
  return ranges;
}

const v4ZoneDir = await downloadAndExtract(V4_URL, 'v4');
const v4Ranges = buildV4Ranges(v4ZoneDir);
fs.writeFileSync(path.join(outDir, 'geoip-v4.json'), JSON.stringify(v4Ranges));
console.log(`Wrote ${v4Ranges.length} IPv4 ranges to geoip-v4.json`);

const v6ZoneDir = await downloadAndExtract(V6_URL, 'v6');
const v6Ranges = buildV6Ranges(v6ZoneDir);
fs.writeFileSync(path.join(outDir, 'geoip-v6.json'), JSON.stringify(v6Ranges));
console.log(`Wrote ${v6Ranges.length} IPv6 ranges to geoip-v6.json`);
