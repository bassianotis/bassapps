// The sign-in service's own durable state (Bassapps: one sign-in for a family of apps).
// Separate from any app's database, so Mail, Tasks and later apps can
// share it. The schema evolves through numbered migrations and is never dropped.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
    // 1: people, signed-in computers, app tokens, one-time codes, the sign-in log
    `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         username TEXT NOT NULL UNIQUE COLLATE NOCASE,
         password_hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         passphrase_changed_at TEXT
     );
     -- A signed-in computer (one browser). Kept for a while after it ends, so an app can say why.
     CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         token_hash TEXT NOT NULL UNIQUE,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         created_at TEXT NOT NULL,
         last_seen_at TEXT NOT NULL,
         user_agent TEXT,
         ip TEXT,
         ended_at TEXT,
         end_reason TEXT
     );
     -- An app's own session cookie, tied to the computer's session (it ends with it).
     CREATE TABLE app_tokens (
         token_hash TEXT PRIMARY KEY,
         session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         app TEXT NOT NULL,
         created_at TEXT NOT NULL
     );
     -- Handed to an app on the way back from signing in; exchanged once, within a minute.
     CREATE TABLE codes (
         code_hash TEXT PRIMARY KEY,
         session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         app TEXT NOT NULL,
         expires_at TEXT NOT NULL
     );
     -- Every attempt; failed ones (counted) drive the limits on attempts.
     CREATE TABLE signins (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at TEXT NOT NULL,
         username TEXT NOT NULL,
         ip TEXT,
         user_agent TEXT,
         ok INTEGER NOT NULL,
         known INTEGER NOT NULL,
         counted INTEGER NOT NULL
     );
     CREATE INDEX signins_ip ON signins (ip, at);
     CREATE INDEX signins_user ON signins (username, at);
     CREATE INDEX sessions_user ON sessions (user_id);`,
    // 2: which apps each login may use: '*' (every app) or a comma list of app ids
    `ALTER TABLE users ADD COLUMN apps TEXT NOT NULL DEFAULT '*';`,
];

export class DoorDb {
    readonly db: DatabaseSync;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        if (path !== ':memory:') fs.chmodSync(path, 0o600);
        const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
        if (version > MIGRATIONS.length) throw new Error(`sign-in database is newer (v${version}) than this service (v${MIGRATIONS.length})`);
        for (let v = version; v < MIGRATIONS.length; v++) {
            this.transaction(() => {
                this.db.exec(MIGRATIONS[v]);
                this.db.exec(`PRAGMA user_version = ${v + 1}`);
            });
        }
    }

    transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    close(): void {
        this.db.close();
    }
}
