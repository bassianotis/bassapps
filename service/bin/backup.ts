// A consistent copy of the sign-in service's durable data, for the nightly backup and before each
// ship: door.sqlite (SQLite's online backup, safe while the service runs), door.key and
// internal.key. The copy is checked before it counts.
//   node service/bin/backup.ts <into-folder>      DOOR_DATA_DIR and DOOR_SECRET_FILE as for the service
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const dataDir = process.env.DOOR_DATA_DIR ?? path.resolve(import.meta.dirname, '../../data');
const into = process.argv[2];
if (!into) {
    console.error('usage: node service/bin/backup.ts <into-folder>');
    process.exit(1);
}
fs.mkdirSync(into, { recursive: true, mode: 0o700 });
const source = new DatabaseSync(path.join(dataDir, 'door.sqlite'), { readOnly: true });
await backup(source, path.join(into, 'door.sqlite'));
source.close();
fs.copyFileSync(path.join(dataDir, 'door.key'), path.join(into, 'door.key'));
fs.copyFileSync(process.env.DOOR_SECRET_FILE ?? path.join(dataDir, 'internal.key'), path.join(into, 'internal.key'));
for (const f of ['door.sqlite', 'door.key', 'internal.key']) fs.chmodSync(path.join(into, f), 0o600);
// One self-contained file (no write-ahead log beside it), then its check
const copy = new DatabaseSync(path.join(into, 'door.sqlite'));
copy.exec('PRAGMA journal_mode = DELETE');
const check = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
const { user_version: version } = copy.prepare('PRAGMA user_version').get() as { user_version: number };
copy.close();
if (check !== 'ok') {
    console.error(`backup in ${into} failed its check: ${check}`);
    process.exit(1);
}
console.log(`backed up door.sqlite (v${version}, checked), door.key and internal.key to ${into}`);
