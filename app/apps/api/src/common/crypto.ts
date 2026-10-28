import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * SMTP 密码加密存储。
 * 用 AES-256-GCM：自带完整性校验，密文被篡改会直接解密失败，而不是悄悄解出乱码。
 * 密文格式：v1.<iv>.<tag>.<ciphertext>，全部 base64url，便于直接存 text 列。
 */
const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;

function toKey(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('CRED_KEY 必须是 32 字节（64 位十六进制）');
  return key;
}

export function encryptSecret(plain: string, hexKey: string): string {
  const key = toKey(hexKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, hexKey: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('密文格式不正确（可能是旧版本数据或密钥已更换）');
  }
  const key = toKey(hexKey);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64url')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/** 用于展示：只留最后两位，6 位授权码不至于被截图看走 4 位 */
export function maskSecret(plain: string): string {
  if (plain.length <= 6) return '****';
  return `****${plain.slice(-2)}`;
}
