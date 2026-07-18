import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
const staticDir = process.env.STATIC_DIR ?? '../public';

app.use('/*', serveStatic({ root: staticDir }));
app.get('/', serveStatic({ path: `${staticDir}/index.html` }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mtr-dash backend listening on port ${info.port}`);
});
