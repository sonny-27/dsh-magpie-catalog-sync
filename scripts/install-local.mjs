import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeBaseURL } from '../lib/catalog.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key.startsWith('--') || !process.argv[i + 1]) throw new Error('参数格式：--home <目录> --profile <名称> --upstream <地址> [--key-file <私密文件>]');
  args[key.slice(2)] = process.argv[i + 1];
}
const home = path.resolve(args.home ?? '');
const profileName = args.profile;
if (!args.home || !/^[a-zA-Z0-9_-]+$/.test(profileName ?? '')) throw new Error('请指定有效的 --home 和 --profile');
const profile = path.join(home, 'profiles', profileName);
const manifestPath = path.join(profile, 'package.json');
const original = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(original);
const name = 'dsh-magpie-catalog-sync';
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const files = [];
function collect(relative) {
  const file = path.join(source, relative), stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('插件源文件不能是符号链接');
  if (stat.isDirectory()) for (const child of fs.readdirSync(file)) collect(path.join(relative, child));
  else files.push(relative);
}
for (const entry of ['package.json', 'index.mjs', 'client.js', 'client.mjs', 'lib', 'server', 'cordis.patch.yml', 'README.md', 'LICENSE']) collect(entry);
const digest = createHash('sha256');
for (const file of files.sort()) digest.update(file).update(fs.readFileSync(path.join(source, file)));
const packageDir = path.join(home, 'plugin-archives', name, packageManifest.version, digest.digest('hex').slice(0, 12), profileName);
for (const relative of files) {
  const target = path.join(packageDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.copyFileSync(path.join(source, relative), target);
}
fs.writeFileSync(path.join(packageDir, 'instance.json'), JSON.stringify({ home, profile: profileName }) + '\n', { mode: 0o600 });
const dataDir = path.join(home, name, profileName);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configPath = path.join(dataDir, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
config.upstream = normalizeBaseURL(args.upstream ?? config.upstream ?? '');
config.providerId ??= 'magpie-sync';
config.credentialRef ??= 'MAGPIE_CATALOG_SYNC_KEY';
config.pollSeconds ??= 300;
config.api ??= 'openai-responses';
let secret;
if (args['key-file']) {
  secret = fs.readFileSync(path.resolve(args['key-file']), 'utf8').trim();
  if (!secret || /\s/.test(secret)) throw new Error('网关密钥格式不正确');
}
let verified;
if (args['capabilities-file']) {
  verified = JSON.parse(fs.readFileSync(path.resolve(args['capabilities-file']), 'utf8'));
  if (verified.upstream !== config.upstream || !verified.models || typeof verified.models !== 'object') throw new Error('验证能力文件与此网关不匹配');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(home, 'backups', name + '-' + stamp, profileName);
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(backup, 'package.json'), original, { mode: 0o600 });
if (fs.existsSync(configPath)) fs.copyFileSync(configPath, path.join(backup, 'config.json'));
const link = path.join(profile, 'node_modules', name);
fs.mkdirSync(path.dirname(link), { recursive: true });
if (fs.existsSync(link)) {
  const old = JSON.parse(fs.readFileSync(path.join(link, 'package.json'), 'utf8'));
  if (!fs.lstatSync(link).isSymbolicLink() || old.name !== name) throw new Error('安装目录已有非本插件的真实文件，未覆盖');
  if (path.resolve(fs.realpathSync(link)) !== path.resolve(packageDir)) fs.unlinkSync(link);
}
if (!fs.existsSync(link)) fs.symlinkSync(packageDir, link, process.platform === 'win32' ? 'junction' : 'dir');
manifest.dependencies ??= {};
manifest.dependencies[name] = 'link:' + packageDir.replaceAll('\\', '/');
manifest.dsh ??= {}; manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name);
fs.writeFileSync(manifestPath + '.magpie-tmp', JSON.stringify(manifest, null, 2) + '\n');
fs.renameSync(manifestPath + '.magpie-tmp', manifestPath);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
if (secret) fs.writeFileSync(path.join(dataDir, 'bootstrap.key'), secret + '\n', { mode: 0o600 });
if (verified) {
  fs.writeFileSync(path.join(dataDir, 'verified-capabilities.json'), JSON.stringify(verified, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify({ installed: true, home, profile: profileName, packageDir, dataDir, providerId: config.providerId, backup, restartRequired: true }));
