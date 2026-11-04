// Adapted from Jasaz (GPL-3.0): https://github.com/itsyebekhe/jasaz
// This deployment-only implementation is modified: stricter validation,
// bounded source downloads, paginated resource lookup, and checked API errors.

const CF_API = "https://api.cloudflare.com/client/v4";
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "raw.github.com",
]);

class DeployError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.name = "DeployError";
    this.status = status;
    this.details = details;
  }
}

function fail(message, status = 400, details) {
  throw new DeployError(message, status, details);
}

function validateName(value, label, max = 63) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    fail(`${label} معتبر نیست. فقط حروف انگلیسی، عدد، خط تیره و زیرخط مجاز است.`);
  }
  return value;
}

function validateBinding(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test(value)) {
    fail(`${label} باید یک نام معتبر متغیر JavaScript باشد؛ مانند DB یا MY_KV.`);
  }
  return value;
}

function normalizeDomain(value) {
  if (!value) return null;
  let input = String(value).trim();
  input = input.replace(/^https?:\/\//i, "");
  if (/[/?#@]/.test(input) || input.includes("\\")) {
    fail("دامنه اختصاصی را فقط به‌صورت hostname وارد کنید؛ بدون مسیر، پورت یا پارامتر.");
  }
  input = input.replace(/\.$/, "").toLowerCase();
  if (input.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input)) {
    fail("فرمت دامنه اختصاصی معتبر نیست.");
  }
  return input;
}

function validateRawUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("آدرس سورس معتبر نیست."); }
  if (url.protocol !== "https:") fail("برای امنیت، آدرس سورس باید HTTPS باشد.");
  if (url.username || url.password || url.port) fail("آدرس سورس نباید نام کاربری، رمز یا پورت سفارشی داشته باشد.");
  if (!RAW_HOSTS.has(url.hostname.toLowerCase())) {
    fail("برای جلوگیری از درخواست به آدرس‌های داخلی، فقط لینک مستقیم GitHub Raw یا Gist Raw پذیرفته می‌شود.");
  }
  return url;
}

function cloudflareHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { _raw: text.slice(0, 1000) }; }
}

function cloudflareError(data, fallback) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const messages = errors.map(item => item?.message).filter(Boolean);
  const codes = errors.map(item => item?.code).filter(value => value !== undefined);
  if (messages.length) return `${fallback}: ${messages.join(" | ")}${codes.length ? ` (کد ${codes.join(", ")})` : ""}`;
  if (typeof data?._raw === "string") return `${fallback}: ${data._raw}`;
  return fallback;
}

async function cfRequest(path, token, options = {}, label = "درخواست Cloudflare") {
  const response = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      ...cloudflareHeaders(token),
      ...(options.headers || {}),
    },
  });
  const data = await readJsonResponse(response);
  if (!response.ok || data?.success === false) {
    const status = response.status >= 400 ? response.status : 400;
    fail(cloudflareError(data, label), status, data?.errors || undefined);
  }
  return { response, data };
}

async function fetchRawSource(scriptUrl) {
  let current = validateRawUrl(scriptUrl);
  let response;
  // Revalidate every redirect target to avoid turning the deploy endpoint into an open fetch proxy.
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetch(current.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CloudflareWorkerDeployer/1.0)" },
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) fail("تعداد تغییرمسیرهای لینک سورس بیش از حد مجاز است.");
      const location = response.headers.get("Location");
      if (!location) fail("لینک سورس یک Redirect بدون مقصد معتبر برگرداند.");
      current = validateRawUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }

  if (!response?.ok) fail(`دانلود سورس ناموفق بود: HTTP ${response?.status || "unknown"} ${response?.statusText || ""}`.trim(), 502);
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > MAX_SOURCE_BYTES) fail("حجم سورس بیشتر از ۲ مگابایت است.");
  if (!response.body) fail("پاسخ لینک سورس خالی است.", 502);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) {
      try { await reader.cancel(); } catch {}
      fail("حجم سورس بیشتر از ۲ مگابایت است.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("فایل سورس UTF-8 معتبر نیست."); }
  if (!source.trim()) fail("فایل سورس خالی است.");
  return source;
}

// Jasaz's original string-table XOR/Base64 obfuscation routine (GPL-3.0).
// This is obfuscation only, not encryption, and is not a JavaScript parser.
const XOR_KEY = 0x4f;
function encodeStringToTable(str, key) {
  const utf8Str = unescape(encodeURIComponent(str));
  let out = "";
  for (let i = 0; i < utf8Str.length; i++) {
    out += String.fromCharCode(utf8Str.charCodeAt(i) ^ (key ^ (i % 11)));
  }
  return btoa(out);
}

export function obfuscateWorkerCode(code) {
  const stringTable = [];
  const stringIndexMap = new Map();
  function getOrAddString(strContent) {
    if (stringIndexMap.has(strContent)) return stringIndexMap.get(strContent);
    const idx = stringTable.length;
    stringTable.push(encodeStringToTable(strContent, XOR_KEY));
    stringIndexMap.set(strContent, idx);
    return idx;
  }

  let i = 0;
  const len = code.length;
  let output = "";
  while (i < len) {
    const char = code[i];
    const nextChar = i + 1 < len ? code[i + 1] : "";

    if (char === "/" && nextChar === "/") {
      const end = code.indexOf("\n", i);
      if (end === -1) { output += code.slice(i); break; }
      output += code.slice(i, end); i = end; continue;
    }
    if (char === "/" && nextChar === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) { output += code.slice(i); break; }
      output += code.slice(i, end + 2); i = end + 2; continue;
    }
    if (char === "`") {
      let end = i + 1;
      while (end < len) {
        if (code[end] === "\\") end += 2;
        else if (code[end] === "`") { end++; break; }
        else end++;
      }
      output += code.slice(i, end); i = end; continue;
    }
    if (char === "/") {
      const trimmed = output.trimEnd();
      const lastChar = trimmed.slice(-1);
      const isRegex = !lastChar || "(=:[,!&|?;{}~^+*%-".includes(lastChar) || /(?:return|case|delete|throw|typeof)\s*$/.test(trimmed);
      if (isRegex) {
        let end = i + 1;
        let inClass = false;
        while (end < len) {
          if (code[end] === "\\") end += 2;
          else if (code[end] === "[" && !inClass) { inClass = true; end++; }
          else if (code[end] === "]" && inClass) { inClass = false; end++; }
          else if (code[end] === "/" && !inClass) {
            end++;
            while (end < len && /[gimsuy]/.test(code[end])) end++;
            break;
          } else end++;
        }
        output += code.slice(i, end); i = end; continue;
      }
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const strStart = i;
      let strEnd = i + 1;
      while (strEnd < len) {
        if (code[strEnd] === "\\") strEnd += 2;
        else if (code[strEnd] === quote) { strEnd++; break; }
        else if (code[strEnd] === "\n") break;
        else strEnd++;
      }
      const strLiteral = code.slice(strStart, strEnd);
      let rawVal = null;
      try {
        rawVal = quote === '"'
          ? JSON.parse(strLiteral)
          : JSON.parse(`"${strLiteral.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
      } catch { rawVal = strLiteral.slice(1, -1); }

      const prevTrimmed = output.trimEnd();
      const isImportExport = /(?:from|import)\s*$/.test(prevTrimmed);
      const isDirective = rawVal === "use strict";
      if (isImportExport || isDirective || !rawVal || rawVal.length === 0) {
        output += strLiteral; i = strEnd; continue;
      }
      let k = strEnd;
      while (k < len && [" ", "\t", "\r", "\n"].includes(code[k])) k++;
      const isFollowedByColon = code[k] === ":" && code[k + 1] !== ":";
      const lastToken = prevTrimmed.slice(-1);
      const isTernaryOrCondition = lastToken === "?" || /(?:case)\s*$/.test(prevTrimmed);
      if (isFollowedByColon && !isTernaryOrCondition) output += strLiteral;
      else output += `func_dec(${getOrAddString(rawVal)})`;
      i = strEnd; continue;
    }
    output += char;
    i++;
  }

  const runtimeHeader = `// @ts-nocheck
const _0x_key = ${XOR_KEY};
const _0x_tbl = ${JSON.stringify(stringTable)};
const _0x_cache = new Map();
function func_dec(idx) {
  if (_0x_cache.has(idx)) return _0x_cache.get(idx);
  const raw = atob(_0x_tbl[idx]);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    out += String.fromCharCode(raw.charCodeAt(i) ^ (_0x_key ^ (i % 11)));
  }
  try { out = decodeURIComponent(escape(out)); } catch (_) {}
  _0x_cache.set(idx, out);
  return out;
}
`;
  return runtimeHeader + "\n" + output;
}

async function listAllPages(path, token, label) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await cfRequest(`${path}${separator}page=${page}&per_page=100`, token, {}, label);
    const rows = Array.isArray(data.result) ? data.result : [];
    all.push(...rows);
    const info = data.result_info || {};
    if (info.total_pages && Number(info.total_pages) > 50) {
      fail(`${label}: تعداد صفحات منابع از سقف ایمن این ابزار بیشتر است.`, 413);
    }
    if (info.total_pages && page >= Number(info.total_pages)) break;
    if (typeof info.total_count === "number" && all.length >= info.total_count) break;
    if (!info.total_count && rows.length < 100) break;
    if (page === 50) fail(`${label}: فهرست منابع بیش از ۵۰۰۰ مورد است؛ برای جلوگیری از ساخت مورد تکراری عملیات متوقف شد.`, 413);
  }
  return all;
}

async function ensureD1(accountId, token, name) {
  const rows = await listAllPages(`/accounts/${accountId}/d1/database`, token, "خطا در دریافت فهرست D1");
  const existing = rows.find(db => db.name === name);
  if (existing) return existing.uuid || existing.id;
  const { data } = await cfRequest(`/accounts/${accountId}/d1/database`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }, "خطا در ساخت دیتابیس D1");
  const id = data.result?.uuid || data.result?.id;
  if (!id) fail("Cloudflare دیتابیس D1 را ایجاد کرد اما شناسه آن را برنگرداند.", 502);
  return id;
}

async function ensureKV(accountId, token, title) {
  const rows = await listAllPages(`/accounts/${accountId}/storage/kv/namespaces`, token, "خطا در دریافت فهرست KV");
  const existing = rows.find(ns => ns.title === title);
  if (existing) return existing.id;
  const { data } = await cfRequest(`/accounts/${accountId}/storage/kv/namespaces`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }, "خطا در ساخت KV Namespace");
  const id = data.result?.id;
  if (!id) fail("Cloudflare فضای KV را ایجاد کرد اما شناسه آن را برنگرداند.", 502);
  return id;
}

async function deleteExistingWorker(accountId, token, workerName) {
  const response = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, {
    method: "DELETE",
    headers: cloudflareHeaders(token),
  });
  if (response.status === 404) return { deleted: false, absent: true };
  const data = await readJsonResponse(response);
  if (!response.ok || data?.success === false) {
    fail(cloudflareError(data, "حذف Worker قبلی ناموفق بود؛ بازسازی متوقف شد تا وضعیت قبلی ناخواسته از بین نرود."), response.status >= 400 ? response.status : 400);
  }
  return { deleted: true, absent: false };
}

function looksLikeModule(source) {
  // Matches the original deployer's simple detection rule, while ignoring a few common comment-only cases.
  return /(?:^|[\n;}]\s*)(?:export\s+(?:default|async\s+function|function|class|const\b|let\b|var\b|\{|\*)|import\s+(?:[\w*{]|\())/m.test(source)
    || source.includes("export ");
}

async function tryEnableWorkersDev(accountId, token, workerName) {
  const { data } = await cfRequest(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  }, "فعال‌سازی workers.dev ناموفق بود");
  return data;
}

async function getWorkerUrl(accountId, token, workerName) {
  try {
    const { data } = await cfRequest(`/accounts/${accountId}/workers/subdomain`, token, {}, "دریافت ساب‌دامین حساب ناموفق بود");
    const subdomain = data.result?.subdomain;
    if (!subdomain) return null;
    const suffix = String(subdomain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const accountHost = suffix.endsWith(".workers.dev") ? suffix : `${suffix}.workers.dev`;
    return `https://${workerName}.${accountHost}`;
  } catch {
    return null;
  }
}

export async function deployWorker(payload) {
  const accountId = String(payload?.accountId || "").trim();
  const apiToken = String(payload?.apiToken || "").trim();
  const workerName = validateName(String(payload?.workerName || "").trim(), "نام Worker");
  const scriptUrl = String(payload?.scriptUrl || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail("Account ID باید یک شناسه ۳۲ کاراکتری هگزادسیمال باشد.");
  if (!apiToken || apiToken.length < 20 || apiToken.length > 512) fail("API Token خالی یا نامعتبر است.");
  validateRawUrl(scriptUrl);

  const enableObfuscation = payload?.enableObfuscation === true;
  const recreateWorker = payload?.recreateWorker === true;
  const customDomain = normalizeDomain(payload?.customDomain || "");
  const d1Name = payload?.d1Name ? validateName(String(payload.d1Name).trim(), "نام دیتابیس D1") : null;
  const bindingName = payload?.bindingName ? validateBinding(String(payload.bindingName).trim(), "نام Binding دیتابیس") : null;
  const kvName = payload?.kvName ? validateName(String(payload.kvName).trim(), "نام KV Namespace") : null;
  const kvBindingName = payload?.kvBindingName ? validateBinding(String(payload.kvBindingName).trim(), "نام Binding مربوط به KV") : null;
  if (!!d1Name !== !!bindingName) fail("برای اتصال D1 هم نام دیتابیس و هم نام Binding را وارد کنید.");
  if (!!kvName !== !!kvBindingName) fail("برای اتصال KV هم نام Namespace و هم نام Binding را وارد کنید.");

  const steps = [];
  let workerScript = await fetchRawSource(scriptUrl);
  const originalBytes = new TextEncoder().encode(workerScript).byteLength;
  steps.push(`سورس با موفقیت دریافت شد (${originalBytes.toLocaleString("en-US")} بایت).`);

  if (enableObfuscation) {
    workerScript = obfuscateWorkerCode(workerScript);
    steps.push("مبهم‌سازی XOR/Base64 انجام شد.");
  }

  const bindings = [];
  let d1DatabaseId = null;
  let kvNamespaceId = null;
  if (d1Name && bindingName) {
    d1DatabaseId = await ensureD1(accountId, apiToken, d1Name);
    bindings.push({ type: "d1", name: bindingName, id: d1DatabaseId });
    steps.push(`D1 آماده شد و با Binding «${bindingName}» متصل می‌شود.`);
  }
  if (kvName && kvBindingName) {
    kvNamespaceId = await ensureKV(accountId, apiToken, kvName);
    bindings.push({ type: "kv_namespace", name: kvBindingName, namespace_id: kvNamespaceId });
    steps.push(`KV آماده شد و با Binding «${kvBindingName}» متصل می‌شود.`);
  }

  let deleted = false;
  if (recreateWorker) {
    const outcome = await deleteExistingWorker(accountId, apiToken, workerName);
    deleted = outcome.deleted;
    steps.push(outcome.deleted ? "Worker قبلی حذف شد؛ بازسازی از صفر ادامه پیدا می‌کند." : "Worker قبلی وجود نداشت؛ ساخت تازه ادامه پیدا می‌کند.");
  }

  const moduleWorker = looksLikeModule(workerScript);
  const metadata = {
    ...(moduleWorker ? { main_module: "worker.js" } : { body_part: "worker.js" }),
    bindings,
    compatibility_date: new Date().toISOString().slice(0, 10),
  };
  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  formData.append("worker.js", new Blob([workerScript], {
    type: moduleWorker ? "application/javascript+module" : "application/javascript",
  }), "worker.js");

  const upload = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, {
    method: "PUT",
    headers: cloudflareHeaders(apiToken),
    body: formData,
  });
  const uploadData = await readJsonResponse(upload);
  if (!upload.ok || uploadData?.success === false) {
    fail(cloudflareError(uploadData, "آپلود و استقرار Worker ناموفق بود"), upload.status >= 400 ? upload.status : 400, uploadData?.errors || undefined);
  }
  steps.push(`کد Worker با موفقیت به Cloudflare ارسال شد (${moduleWorker ? "ES Module" : "Service Worker"}).`);

  let workersDevError = null;
  try {
    await tryEnableWorkersDev(accountId, apiToken, workerName);
    steps.push("دسترسی workers.dev فعال شد.");
  } catch (error) {
    workersDevError = error.message;
    steps.push(`هشدار workers.dev: ${error.message}`);
  }
  const workerUrl = await getWorkerUrl(accountId, apiToken, workerName);

  let customDomainUrl = null;
  let customDomainError = null;
  if (customDomain) {
    try {
      await cfRequest(`/accounts/${accountId}/workers/domains`, apiToken, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: customDomain, service: workerName }),
      }, "اتصال دامنه اختصاصی ناموفق بود");
      customDomainUrl = `https://${customDomain}`;
      steps.push("دامنه اختصاصی به Worker متصل شد.");
    } catch (error) {
      customDomainError = error.message;
      steps.push(`هشدار دامنه اختصاصی: ${error.message}`);
    }
  }

  return {
    success: true,
    workerName,
    workerUrl,
    customDomainUrl,
    customDomainError,
    workersDevError,
    d1DatabaseId,
    kvNamespaceId,
    obfuscated: enableObfuscation,
    recreated: recreateWorker,
    deletedExisting: deleted,
    moduleWorker,
    sourceBytes: originalBytes,
    steps,
  };
}

// Server-side health probe. The browser never calls the target Worker directly,
// avoiding CORS problems and keeping Cloudflare credentials out of probe URLs.
export async function checkWorkerHealth(payload) {
  const accountId = String(payload?.accountId || "").trim();
  const apiToken = String(payload?.apiToken || "").trim();
  const workerName = validateName(String(payload?.workerName || "").trim(), "نام Worker");
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail("Account ID نامعتبر است.");
  if (!apiToken || apiToken.length < 20 || apiToken.length > 512) fail("API Token خالی یا نامعتبر است.");

  // First verify that the script still exists. Authentication/permission errors
  // are inconclusive and must never be interpreted as a reason to delete it.
  const scriptResponse = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, {
    headers: cloudflareHeaders(apiToken),
  });
  const scriptData = await readJsonResponse(scriptResponse);
  if (scriptResponse.status === 404 || (scriptData?.success === false && (scriptData.errors || []).some(e => String(e.code) === "10007"))) {
    return { success: true, healthy: false, failureType: "worker_missing", message: "Worker در حساب Cloudflare پیدا نشد.", workerName };
  }
  if (!scriptResponse.ok || scriptData?.success === false) {
    fail(cloudflareError(scriptData, "بررسی وجود Worker در Cloudflare ناموفق بود؛ این خطا به معنی خرابی Worker نیست و Rebuild انجام نمی‌شود."), scriptResponse.status >= 400 ? scriptResponse.status : 502);
  }

  const customDomain = normalizeDomain(payload?.customDomain || "");
  const baseUrl = customDomain
    ? `https://${customDomain}`
    : await getWorkerUrl(accountId, apiToken, workerName);
  if (!baseUrl) fail("آدرس workers.dev این حساب قابل تشخیص نیست. workers.dev را در حساب فعال کنید یا دامنه اختصاصی وارد کنید.", 409);

  let probePath = String(payload?.probePath || "/").trim();
  if (!probePath.startsWith("/") || probePath.startsWith("//") || probePath.length > 256 || /[\r\n]/.test(probePath)) {
    fail("مسیر Health Check نامعتبر است؛ مسیر باید با / شروع شود.");
  }
  const target = new URL(probePath, baseUrl);
  if (target.origin !== new URL(baseUrl).origin) fail("مسیر Health Check نباید به دامنه دیگری اشاره کند.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("health-check-timeout"), 10000);
  try {
    const response = await fetch(target.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache", "User-Agent": "Cloudflare-Worker-Health-Probe/1.0" },
    });
    let body = "";
    if (response.body) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < 8192) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = value.subarray(0, 8192 - total);
        chunks.push(part);
        total += part.byteLength;
        if (total >= 8192) { try { await reader.cancel(); } catch {} break; }
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const part of chunks) { joined.set(part, offset); offset += part.byteLength; }
      body = new TextDecoder().decode(joined);
    }
    const errorMatch = body.match(/(?:error\s*)?(1101|1102)\b/i);
    const healthy = response.status < 500 && !errorMatch;
    return {
      success: true,
      healthy,
      workerName,
      probeUrl: target.toString(),
      httpStatus: response.status,
      failureType: healthy ? null : (errorMatch ? `cloudflare_${errorMatch[1]}` : `http_${response.status}`),
      message: healthy
        ? `Worker پاسخ HTTP ${response.status} برگرداند.`
        : (errorMatch ? `خطای Cloudflare ${errorMatch[1]} در پاسخ Worker شناسایی شد.` : `Worker پاسخ ناموفق HTTP ${response.status} برگرداند.`),
    };
  } catch (error) {
    return {
      success: true,
      healthy: false,
      workerName,
      probeUrl: target.toString(),
      failureType: error?.name === "AbortError" ? "timeout" : "network_error",
      message: error?.name === "AbortError" ? "Health Check پس از ۱۰ ثانیه Timeout شد." : `اتصال به Worker برقرار نشد: ${String(error?.message || error).slice(0, 180)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
