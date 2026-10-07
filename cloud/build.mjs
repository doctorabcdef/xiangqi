import { mkdir, copyFile, access } from 'node:fs/promises';
await mkdir('dist/server', { recursive: true });
await copyFile('worker.js', 'dist/server/index.js');
for (const name of ['store.js', 'live.js']) await copyFile(name, 'dist/server/' + name);
// Keep the cloud source self-contained for future Sites rebuilds.
await mkdir('shared', { recursive: true });
for (const name of ['engine.js', 'state.js']) {
  try { await access('../src/' + name); await copyFile('../src/' + name, 'shared/' + name); } catch { await access('shared/' + name); }
  await copyFile('shared/' + name, 'dist/server/' + name);
}
console.log('Cloud Worker built.');
