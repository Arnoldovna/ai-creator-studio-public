// Etappe 16b (E2E only): a local stand-in for the public Google Fonts endpoints – the metadata fixture, the CSS2 answer
// for Bebas Neue and the real (OFL) Bebas Neue TTF from test/fixtures. No network, nothing about her is sent anywhere.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const here = import.meta.dirname;
const meta = readFileSync(path.join(here, '../../../packages/core/test/fixtures/google-metadata.json'));
const bebas = readFileSync(path.join(here, '../test/fixtures/fonts/BebasNeue-Regular.ttf'));
const port = Number(process.env.FAKE_GOOGLE_PORT || 3199);
const base = `http://127.0.0.1:${port}`;

createServer((req, res) => {
  const u = new URL(req.url ?? '/', base);
  const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  if (u.pathname === '/health') return send(200, 'text/plain', 'ok');
  if (u.pathname === '/metadata/fonts') return send(200, 'application/json', meta);
  if (u.pathname === '/css2') {
    const family = (u.searchParams.get('family') ?? '').split(':')[0];
    if (family !== 'Bebas Neue') return send(400, 'text/plain', 'unknown family');
    return send(200, 'text/css', `@font-face {\n  font-family: 'Bebas Neue';\n  font-style: normal;\n  font-weight: 400;\n  src: url(${base}/s/bebasneue/v16/bebas.ttf) format('truetype');\n}\n`);
  }
  if (u.pathname === '/s/bebasneue/v16/bebas.ttf') return send(200, 'font/ttf', bebas);
  send(404, 'text/plain', 'not found');
}).listen(port, '127.0.0.1');
