# Changelog

## Secure dashboard edition

- بازطراحی رابط مطابق تصویر مبنا با تم بنفش/آبی، گرافیک jellyfish، RTL و واکنش‌گرایی موبایل.
- حذف دفترچه محلی و انتقال حساب‌ها به D1 با رمزگذاری AES-GCM سمت سرور.
- افزودن ورود username/password، نشست HttpOnly، هش PBKDF2، محدودیت تلاش‌های ورود و مدیریت کاربران.
- افزودن مجوزدهی حساب‌به‌کاربر؛ مدیر تعیین می‌کند هر کاربر کدام حساب‌ها را ببیند و استفاده کند.
- تغییر APIهای Deploy و Health برای دریافت accountRecordId و بازیابی Token به‌صورت server-side.
- حفظ سورس پیش‌فرض، Obfuscator، Clean Rebuild، D1/KV، دامنه و پایش مرورگری.


## API hardening and deployment console

- تکمیل تم Neon Glassmorphism و تطبیق شیشه‌ای کارت‌ها با رنگ‌بندی درخواستی.
- افزودن کنسول زنده NDJSON و دکمه بررسی زنده Token.
- اعتبارسنجی سخت‌گیرانه نام Worker در endpoint و هسته با `^[a-z0-9_-]{1,63}$`.
- استفاده از Verify Token حساب‌محور Cloudflare و Probe دسترسی Workers/D1؛ بدون ادعای نادرست درباره نمایش Edit در Verify.
- اجرای Migration پایه D1 به‌صورت چند Query مستقل و idempotent پیش از Upload، سپس افزودن Binding به metadata.
- گسترش پوشش Timeout به دریافت بدنه پاسخ‌های Cloudflare و دانلود کامل سورس.
- به‌روزرسانی مستندات ساختار، مسیر Verify و سیاست Cookie SameSite=Lax.
- انتقال JavaScript رابط به `public/app.js` و بستن اسکریپت inline در CSP (`script-src 'self'`).
- محدودکردن URL ساخت Token به Account ID واردشده و مستندسازی تفاوت Editor و Admin در مدل مجوزهای جدید Cloudflare.

- افزودن هشدار درباره تفاوت Workers Editor با Workers product-level Admin برای ساخت/حذف Worker جدید.


## v3.1.1 — PBKDF2 compatibility fix
- Lowered PBKDF2 iterations from 310,000 to Cloudflare Workers maximum 100,000.
- Fixes first-admin bootstrap/login failure (`Pbkdf2 failed: iteration counts above 100000 are not supported`).
- No D1 migration required when the users table is empty.


## v3.2 — API Token diagnostic fix
- Verify user-owned API tokens through the canonical `GET /user/tokens/verify` endpoint, with an account-scoped fallback for account-owned tokens.
- Normalize copied tokens that include a leading `Bearer ` prefix or surrounding quotes before encrypting or using them.
- Distinguish invalid authentication (401 / code 10000) from permission/scope denial (403 / code 100), and include the API route in deployment diagnostics.
- Only probe D1/KV when those bindings are requested.

## v3.3 – Per-account deployment profiles and automatic panel checks

- Added persistent per-Cloudflare-account deployment profiles in the dashboard D1 database through `/api/account-settings`.
- Worker, D1, and KV names are securely randomized on first account selection and remain saved per account.
- Added random-name controls for Worker, D1, and KV fields; generated values are automatically persisted.
- Added a configurable panel path. Final deployment output now includes a link ending in `/panel` (and can include an account-specific route prefix such as `qna61nmQZUnG/panel`).
- Health checks and automatic rebuild are enabled by default. Monitoring starts after a successful deployment and resumes when a previously deployed account is selected again.
- Fixed automatic rebuild to consume the deployment NDJSON stream rather than attempting to parse it as JSON.
- Persisted monitoring counters and cooldown timestamps per account.
- Added an idempotent account settings table creation path; existing D1 installs do not require a manual migration.


## v3.3.1 – Randomized account profiles and panel URL polish

- Ensure final `workers.dev` and custom-domain URLs append the saved panel path and always terminate in `/panel`.
- Securely randomize Worker, D1, and KV names per selected Cloudflare account; persist them in the dashboard D1 settings table.
- Use `crypto.getRandomValues` for the Worker prefix choice as well as the suffix.
- Keep automatic health checking and automatic rebuild enabled in new account profiles and the UI defaults.
- Document that browser monitoring requires the page to remain open and that the initial Deploy remains user-triggered.
