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
