import { DatabaseSync } from 'node:sqlite';
import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  console.error('Usage: node scripts/backup-sqlite.mjs <source.sqlite> <new-backup.sqlite>\nThis command snapshots SQLite only. Use the database provider for Postgres backups.');
  process.exitCode = 1;
} else {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (sourcePath === destinationPath) throw new Error('Source and backup must be different paths.');
  await access(sourcePath);
  let exists = false;
  try { await access(destinationPath); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) throw new Error('Backup path already exists. Choose a new destination; backups are never overwritten.');
  await mkdir(dirname(destinationPath), { recursive: true });
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(destinationPath);
  } finally { db.close(); }
  const backup = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') throw new Error('Backup failed SQLite integrity check.');
    if (backup.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup contains foreign key violations.');
    console.log(`Verified SQLite snapshot: ${destinationPath}`);
  } finally { backup.close(); }
}
