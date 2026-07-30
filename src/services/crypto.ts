/**
 * =============================================================================
 * PULSE — Crypto utilities for broker API-token encryption
 * =============================================================================
 *
 * AES-256-GCM. Format: iv:authTag:ciphertext (all hex).
 * ENCRYPTION_KEY must be a 64-character hex string (32 bytes).
 */

import crypto from 'crypto';

const KEY_HEX = process.env.ENCRYPTION_KEY;

if (!KEY_HEX || KEY_HEX.length !== 64 || !/^[0-9a-fA-F]+$/.test(KEY_HEX)) {
  throw new Error(
    'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Set it in the environment.'
  );
}

const KEY = Buffer.from(KEY_HEX, 'hex');

const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

function generateIv(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

export function encrypt(plain: string): string {
  if (plain === null || plain === undefined) {
    throw new Error('Cannot encrypt null or undefined value');
  }
  const iv = generateIv();
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plain), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(encrypted: string): string {
  if (!encrypted) {
    throw new Error('Cannot decrypt empty string');
  }
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new Error('Invalid IV or auth tag length');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function getTail(plain: string, n = 4): string {
  if (!plain) return '';
  const s = String(plain);
  return s.length <= n ? s : s.slice(-n);
}

export function maskToken(plain: string): string {
  const tail = getTail(plain, 4);
  return `••••${tail}`;
}
