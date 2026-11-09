// Keys kept on disk, each in its own 0600 file next to (not inside) the database: door.key signs
// the "known computer" mark. Back the keys up together with the database. (AES-256-GCM helpers,
// shared with Mail's engine, for anything that needs encrypting at rest.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 'v1';

export function loadOrCreateKey(file: string): Buffer {
    if (fs.existsSync(file)) {
        const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
        if (key.length !== 32) throw new Error(`${file} does not contain a 32-byte key`);
        return key;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    return key;
}

/** "v1:" + base64(iv | tag | ciphertext). */
export function encrypt(key: Buffer, plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decrypt(key: Buffer, blob: string): string {
    const [version, payload] = blob.split(':', 2);
    if (version !== VERSION || !payload) throw new Error('unknown secret format');
    const raw = Buffer.from(payload, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
