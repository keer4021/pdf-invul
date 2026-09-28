// Begin die bediener saam met 'n Cloudflare Tunnel, sodat spanlede van oral af toegang het.
//
// - Met TUNNEL_TOKEN in .env: 'n vaste ("named") tunnel met jou eie domein; stel PUBLIC_URL ook.
// - Sonder: 'n gratis vinnige tunnel (*.trycloudflare.com). Die adres verander by elke herbegin,
//   so deel-skakels wat voor 'n herbegin gestuur is, werk dan nie meer nie.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
const port = process.env.PORT || '3000';
const cloudflared = path.join(root, 'tools', 'cloudflared.exe');

const args = process.env.TUNNEL_TOKEN
  ? ['tunnel', '--no-autoupdate', 'run', '--token', process.env.TUNNEL_TOKEN]
  : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];
const tunnel = spawn(cloudflared, args, { stdio: ['ignore', 'pipe', 'pipe'] });
tunnel.on('error', (e) => {
  console.error(`Could not start ${cloudflared} (${e.message}). See the README for how to download it.`);
  process.exit(1);
});

let server;
function startServer(publicUrl) {
  if (server) return;
  console.log(`\nPublic address: ${publicUrl}\n`);
  server = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], {
    stdio: 'inherit', env: { ...process.env, PORT: port, PUBLIC_URL: publicUrl },
  });
  server.on('exit', (code) => { tunnel.kill(); process.exit(code ?? 0); });
}

// cloudflared skryf sy log na stderr; soek daarin na die vinnige-tunnel-adres
const onLog = (buf) => {
  const text = buf.toString();
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
  if (m) startServer(m[0]);
  if (/error|failed/i.test(text) && !/no error/i.test(text)) process.stderr.write(text);
};
tunnel.stdout.on('data', onLog);
tunnel.stderr.on('data', onLog);
if (process.env.TUNNEL_TOKEN) startServer(process.env.PUBLIC_URL || '');

const stop = () => { tunnel.kill(); server?.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.on('exit', (code) => { console.error(`Tunnel stopped (code ${code}).`); server?.kill(); process.exit(1); });
