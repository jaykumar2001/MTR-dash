import path from 'node:path';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { createDb } from './db/client.js';
import { TargetsService } from './services/targets.js';
import { RunsService } from './services/runs.js';
import { MapService } from './services/map.js';
import { DeviationsService } from './services/deviations.js';
import { PositionsService } from './services/positions.js';
import { WhoisService } from './services/whois.js';
import { DnsService } from './services/dns.js';
import { GeoipService } from './services/geoip.js';
import { loadGeoipData } from './geoip/loader.js';
import { ensureMaxmindData } from './geoip/ensureMaxmindData.js';
import { SseHub } from './sse/hub.js';
import { Scheduler } from './scheduler/scheduler.js';
import { registerTargetRoutes } from './routes/targets.js';
import { registerMapRoutes } from './routes/map.js';
import { registerDeviationRoutes } from './routes/deviations.js';
import { registerPositionRoutes } from './routes/positions.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerWhoisRoutes } from './routes/whois.js';
import { registerDnsRoutes } from './routes/dns.js';
import { registerGeoipRoutes } from './routes/geoip.js';
import { registerRunRoutes } from './routes/runs.js';
import { runMtr } from './mtr/runner.js';

export interface CreateAppOptions {
  db?: Database.Database;
  runMtrFn?: typeof runMtr;
  startScheduler?: boolean;
  startMaxmindRefresh?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const db = options.db ?? createDb(process.env.DB_PATH ?? './data/mtr-dash.sqlite3');
  loadGeoipData(db, process.env.GEOIP_DATA_DIR ?? './geoip');

  const maxmindDbDir =
    process.env.MAXMIND_DB_DIR ??
    path.join(path.dirname(process.env.DB_PATH ?? './data/mtr-dash.sqlite3'), 'maxmind');
  const maxmindDbPath = path.join(maxmindDbDir, 'GeoLite2-City.mmdb');

  const targetsService = new TargetsService(db);
  const runsService = new RunsService(db);
  const mapService = new MapService(db);
  const deviationsService = new DeviationsService(db);
  const positionsService = new PositionsService(db);
  const whoisService = new WhoisService(db);
  const dnsService = new DnsService(db);
  const geoipService = new GeoipService(db, { maxmindDbPath });
  const sseHub = new SseHub();
  const scheduler = new Scheduler(targetsService, runsService, sseHub, options.runMtrFn ?? runMtr);

  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  registerTargetRoutes(app, targetsService, scheduler);
  registerMapRoutes(app, mapService);
  registerDeviationRoutes(app, deviationsService);
  registerPositionRoutes(app, positionsService);
  registerStreamRoutes(app, sseHub);
  registerWhoisRoutes(app, whoisService);
  registerDnsRoutes(app, dnsService);
  registerGeoipRoutes(app, geoipService);
  registerRunRoutes(app, runsService);

  if (options.startScheduler !== false) scheduler.start();

  if (options.startMaxmindRefresh !== false) {
    const refresh = () => {
      ensureMaxmindData(process.env.GEOIP_CONF_PATH, maxmindDbDir).catch((err) =>
        console.warn(`geoip: maxmind refresh failed: ${(err as Error).message}`),
      );
    };
    refresh();
    setInterval(refresh, 24 * 60 * 60 * 1000).unref();
  }

  return app;
}
