/**
 * =============================================================================
 * PULSE — Crypto utilities for broker API-token encryption
 * =============================================================================
 *
 * AES-256-GCM. Format: iv:authTag:ciphertext (all hex).
 * ENCRYPTION_KEY must be a 64-character hex string (32 bytes).
 */

import crypto from 'crypto';

const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

let validatedKey: Buffer | null = null;
let validatedKeyHex: string | null = null;

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (keyHex === validatedKeyHex && validatedKey) return validatedKey;

  if (!keyHex || keyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(keyHex)) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Set it in the environment.'
    );
  }
  validatedKeyHex = keyHex;
  validatedKey = Buffer.from(keyHex, 'hex');
  return validatedKey;
}

export function encryptionKeyConfigured(): boolean {
  const keyHex = process.env.ENCRYPTION_KEY;
  return !!keyHex && keyHex.length === 64 && /^[0-9a-fA-F]+$/.test(keyHex);
}

function generateIv(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

export function encrypt(plain: string): string {
  if (plain === null || plain === undefined) {
    throw new Error('Cannot encrypt null or undefined value');
  }
  const key = getKey();
  const iv = generateIv();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
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
  const key = getKey();
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

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
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
