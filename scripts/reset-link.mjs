// Genera un link de un solo uso (24 h) para que una persona ponga una contraseña nueva.
// Uso: node scripts/reset-link.mjs --email persona@empresa.com [--local] [--origin https://geospots.patricbarca.workers.dev]
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const email = String(get('--email', '')).trim().toLowerCase();
const local = args.includes('--local');
const origin = get('--origin', 'https://geospots.patricbarca.workers.dev');
const persist = get('--persist-to', null);
if (!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) { console.error('Falta --email válido'); process.exit(1); }

const token = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(token).digest('base64url');
const now = Date.now();
// Cada consulta va entre comillas dobles (el SQL solo usa comillas simples), así la terminal no parte los argumentos.
const q = (x) => `"${x}"`;
function d1(sql) {
  const cmd = ['npx wrangler d1 execute geospots', local ? '--local' : '--remote', '--json', '--command', q(sql.replace(/\s+/g, ' ')), persist ? `--persist-to ${q(persist)}` : ''].join(' ');
  const out = execSync(cmd, { encoding: 'utf8' });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}
const user = d1(`SELECT id FROM users WHERE email = '${email}'`)[0];
if (!user) { console.error('No hay ninguna cuenta con ese email.'); process.exit(2); }
if (!/^u_[\w-]+$/.test(user.id)) { console.error('Id de usuario inesperado.'); process.exit(3); }
d1(`INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES ('${hash}', '${user.id}', ${now}, ${now + 24 * 3600 * 1000})`);
console.log(`${origin}/?reset=${token}`);
