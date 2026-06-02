#!/usr/bin/env node
import { readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { publish } from 'libnpmpublish';
import pacote from 'pacote';

const TOKEN = readFileSync(process.env.HOME + '/.npmrc', 'utf-8')
  .match(/_authToken=(.+)/)?.[1]?.trim();

if (!TOKEN) {
  console.error('No npm token found in ~/.npmrc. Run `npm login --auth-type=web` first.');
  process.exit(1);
}

execSync('npm run build', { stdio: 'inherit' });

const tarballName = execSync('npm pack', { encoding: 'utf-8' }).trim().split('\n').pop();
console.log('Packed:', tarballName);

try {
  const tarball = readFileSync('./' + tarballName);
  const manifest = await pacote.manifest('./' + tarballName);

  console.log(`Publishing ${manifest.name}@${manifest.version} as public...`);

  const result = await publish(manifest, tarball, {
    access: 'public',
    defaultTag: 'latest',
    registry: 'https://registry.npmjs.org/',
    forceAuth: { token: TOKEN, alwaysAuth: true },
    ...(process.env.NPM_OTP ? { otp: process.env.NPM_OTP } : {}),
  });

  console.log('✓ Published successfully:', result);
} catch (err) {
  console.error('Publish failed:');
  console.error('  statusCode:', err.statusCode);
  console.error('  code:', err.code);
  console.error('  message:', err.message);
  if (err.body) console.error('  body:', err.body.toString ? err.body.toString() : err.body);
  process.exit(1);
} finally {
  try { unlinkSync('./' + tarballName); } catch {}
}
