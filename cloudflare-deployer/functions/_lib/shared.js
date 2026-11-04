const SESSION_COOKIE = "__Host-zeus_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 310000;

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      ...extraHeaders,
    },
  });
}

export async function readJson(request, maxBytes = 48 * 1024) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw httpError("حجم درخواست بیش از حد مجاز است.", 413);
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw httpError("حجم درخواست بیش از حد مجاز است.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw httpError("بدنه درخواست JSON معتبر نیست.", 400); }
}

export function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function requireDb(env) {
  if (!env?.DB) throw httpError("پایگاه داده D1 متصل نیست. ابتدا Binding با نام DB را در Pages تنظیم کنید.", 503);
  return env.DB;
}

export function enforceSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw httpError("درخواست از مبدأ غیرمجاز رد شد.", 403);
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite === "cross-site") throw httpError("درخواست Cross-site مجاز نیست.", 403);
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64(new Uint8Array(digest));
}

async function derivePassword(password, saltBytes) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, material, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw httpError("رمز عبور باید حداقل ۸ و حداکثر ۲۵۶ نویسه باشد.", 400);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await derivePassword(password, salt);
  return { salt: base64(salt), hash: base64(digest) };
}

export async function verifyPassword(password, salt, expectedHash) {
  try {
    const actual = await derivePassword(password, fromBase64(salt));
    const expected = fromBase64(expectedHash);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
    return difference === 0;
  } catch { return false; }
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try { return decodeURIComponent(value); } catch { return ""; }
    }
  }
  return "";
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function createSession(db, userId) {
  const raw = base64(crypto.getRandomValues(new Uint8Array(32))).replace(/=+$/g, "");
  const tokenHash = await sha256(raw);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db.prepare("INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), userId, tokenHash, now, expiresAt).run();
  return sessionCookie(raw, Math.floor(SESSION_TTL_MS / 1000));
}

export async function destroySession(request, db) {
  const raw = getCookie(request, SESSION_COOKIE);
  if (raw) {
    const tokenHash = await sha256(raw);
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function requireUser(request, env) {
  const db = requireDb(env);
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw) throw httpError("برای ادامه وارد حساب کاربری شوید.", 401);
  const tokenHash = await sha256(raw);
  const now = Date.now();
  const row = await db.prepare(
    `SELECT u.id,u.username,u.role,u.active,s.id AS session_id
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>? LIMIT 1`
  ).bind(tokenHash, now).first();
  if (!row || row.active !== 1) throw httpError("نشست ورود معتبر نیست؛ دوباره وارد شوید.", 401);
  return { id: row.id, username: row.username, role: row.role, sessionId: row.session_id };
}

export function requireAdmin(user) {
  if (user.role !== "admin") throw httpError("این بخش فقط برای مدیر قابل دسترسی است.", 403);
}

function decodeSecretKey(value) {
  if (!value) throw httpError("کلید VAULT_ENCRYPTION_KEY در Secrets تنظیم نشده است.", 503);
  const normalized = String(value).trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== 32) throw httpError("VAULT_ENCRYPTION_KEY باید Base64 معادل ۳۲ بایت باشد.", 503);
  return bytes;
}

async function importVaultKey(env) {
  const raw = decodeSecretKey(env.VAULT_ENCRYPTION_KEY);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptAccountToken(token, env) {
  const key = await importVaultKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { tokenIv: base64(iv), tokenCipher: base64(new Uint8Array(cipher)) };
}

export async function decryptAccountToken(record, env) {
  const key = await importVaultKey(env);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(record.token_iv) }, key, fromBase64(record.token_cipher));
  return new TextDecoder().decode(clear);
}

export async function getAuthorizedAccount(db, user, accountRecordId) {
  if (typeof accountRecordId !== "string" || accountRecordId.length > 80) throw httpError("حساب انتخاب‌شده معتبر نیست.", 400);
  let row;
  if (user.role === "admin") {
    row = await db.prepare("SELECT * FROM accounts WHERE id=? LIMIT 1").bind(accountRecordId).first();
  } else {
    row = await db.prepare(
      `SELECT a.*,p.can_rebuild FROM accounts a
       JOIN account_permissions p ON p.account_id=a.id
       WHERE a.id=? AND p.user_id=? AND p.can_deploy=1 LIMIT 1`
    ).bind(accountRecordId, user.id).first();
  }
  if (!row) throw httpError("به این حساب Cloudflare دسترسی ندارید یا حساب حذف شده است.", 403);
  return row;
}

export function validateAccountId(value) {
  const accountId = String(value || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw httpError("Account ID باید شناسه ۳۲ کاراکتری هگزادسیمال باشد.", 400);
  return accountId;
}
