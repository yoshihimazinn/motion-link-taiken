(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MotionLinkPinHash = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // PIN の記録（PinRecord、指示書 4.5.2）。PIN の数字は保存せず、塩を足した PBKDF2-SHA256 のハッシュだけを持つ。
  // 家族のしくみ（device-service/motionlink_device/family/auth.py の verify_pin）も同じ形で確かめる：PIN の UTF-8 のバイト・16バイトの塩・
  // 32バイトのハッシュ・base64url（埋め草の = なし）。テレビでは WebCrypto（crypto.subtle）を使う。http://127.0.0.1 は安全な場所とみなされるので
  // 使えるが、LAN の IP で開いたときなどは使えない（available() が false。そのときは PIN を変えられない）
  const ALGO = "pbkdf2-sha256";
  const ITERATIONS = 100000;
  const SALT_BYTES = 16;
  const HASH_BYTES = 32;

  const subtle = () => root.crypto?.subtle || null;
  function available() {
    return Boolean(subtle() && typeof root.crypto.getRandomValues === "function");
  }

  function toBase64url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return root.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // 形が違えば null
  function fromBase64url(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
    const body = text.replace(/=+$/, "");
    if (body.length % 4 === 1) return null;
    const binary = root.atob(body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - body.length % 4) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function derive(pin, salt, iter) {
    const key = await subtle().importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, HASH_BYTES * 8);
    return new Uint8Array(bits);
  }

  // 新しい PinRecord。salt（Uint8Array か base64url）を渡さなければ新しく作る。now は changedAt に入れる時刻
  async function hashPin(pin, { salt, iter = ITERATIONS, now } = {}) {
    if (!available()) throw new Error("この画面では PIN を変えられません");
    if (typeof pin !== "string" || !pin) throw new Error("PIN がありません");
    const saltBytes = typeof salt === "string" ? fromBase64url(salt) : salt || root.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    if (!saltBytes || saltBytes.length !== SALT_BYTES) throw new Error("塩は16バイトです");
    const hash = await derive(pin, saltBytes, iter);
    const changedAt = new Date(now === undefined ? Date.now() : now).toISOString();
    return { v: 1, algo: ALGO, iter, salt: toBase64url(saltBytes), hash: toBase64url(hash), changedAt };
  }

  // PIN が PinRecord に合うか。形の崩れた記録とは比べない（false）。比べるのは全部のバイト（途中で止めない）
  async function verifyPin(pin, record) {
    if (!available() || typeof pin !== "string" || !pin || !record || record.v !== 1 || record.algo !== ALGO) return false;
    if (!Number.isInteger(record.iter) || record.iter < 1000 || record.iter > 2000000) return false;
    const salt = fromBase64url(record.salt);
    const expected = fromBase64url(record.hash);
    if (!salt || salt.length !== SALT_BYTES || !expected || expected.length !== HASH_BYTES) return false;
    const actual = await derive(pin, salt, record.iter);
    let difference = 0;
    for (let index = 0; index < HASH_BYTES; index += 1) difference |= actual[index] ^ expected[index];
    return difference === 0;
  }

  return { ALGO, ITERATIONS, available, hashPin, verifyPin, toBase64url, fromBase64url };
});
