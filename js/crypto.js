// 端到端加密：密钥由密码在本机派生，永不离开设备。
// 服务器只收到 authKey（用于登录验证，由密码单向派生，无法反推出加密密钥）和密文。
const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITER = 600000;

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64(buf) {
  let s = '';
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export function cryptoAvailable() {
  return !!(globalThis.crypto && crypto.subtle);
}

/** 由用户名+密码派生：authKey（hex，发给服务器验证）和 encKey（AES-GCM，只留在本机） */
export async function deriveKeys(user, password) {
  const salt = await crypto.subtle.digest('SHA-256', enc.encode('tsdq-v1|' + user));
  const pwKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, pwKey, 256);
  const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('auth') }, hk, 256);
  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('enc') }, hk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { authKey: hex(authBits), encKey };
}

/** 加密一条记录。记录 ID 作为附加认证数据，服务器无法把密文挪到别的记录上。 */
export async function encryptRecord(key, id, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(id) }, key, enc.encode(JSON.stringify(data)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64(out);
}

export async function decryptRecord(key, id, blob) {
  const a = unb64(blob);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: a.subarray(0, 12), additionalData: enc.encode(id) }, key, a.subarray(12));
  return JSON.parse(dec.decode(pt));
}
