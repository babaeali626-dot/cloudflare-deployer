# Zeus Cloud Deployer (Cloudflare Pages + D1)

پنل خصوصی استقرار Cloudflare Worker با رابط فارسی RTL، طراحی Glassmorphism نئونی، ورود کاربری، مدیریت چند حساب و دسترسی تفکیک‌شده.

## ویژگی‌ها

- رابط تیره نئونی و واکنش‌گرا، فرم یک‌صفحه‌ای و کنسول زنده Deploy.
- تست Token از طریق endpoint رسمی Verify در سطح Account و بررسی دسترسی API به Workers و D1؛ لینک ساخت Token به‌صورت پیش‌فرض به Account ID واردشده محدود می‌شود. پاسخ Verify وضعیت active/disabled/expired را می‌دهد؛ سطح دقیق Edit در پاسخ Verify افشا نمی‌شود و مجوز نوشتن هنگام عملیات واقعی ایجاد/آپلود/اجرای Migration بررسی می‌شود.
- اعتبارسنجی نام Worker در API و هسته Deploy با الگوی `^[a-z0-9_-]{1,63}$`.
- ورود مدیر و کاربران مجاز با Cookie از نوع HttpOnly/Secure/SameSite=Lax.
- ایجاد مدیر اولیه از طریق Secrets محیط Cloudflare؛ هیچ رمز ثابتی در HTML/JavaScript قرار ندارد.
- هش رمز عبور با PBKDF2-HMAC-SHA256 و salt تصادفی.
- نگهداری حداکثر ۱۰ حساب Cloudflare در D1؛ Tokenها با AES-256-GCM و کلید محرمانه سمت سرور رمزگذاری می‌شوند. API فهرست حساب‌ها Token کامل یا رمز عبور را برنمی‌گرداند.
- مدیریت کاربران و تخصیص حساب‌های مجاز؛ مجوز Clean Rebuild برای هر حساب مستقل است.
- استقرار Worker از GitHub Raw، اتصال اختیاری D1/KV و دامنه اختصاصی.
- تزریق Binding دیتابیس D1 در Multipart Metadata و اجرای Migration پایه idempotent روی D1 مقصد.
- حفظ Obfuscator و Clean Rebuild.
- کنترل Timeout و تبدیل خطاهای شبکه/API به خطاهای مشخص HTTP.
- پایش مرورگری با آستانه شکست متوالی و محدودیت زمانی بازسازی.

## ساختار

```text
public/
  index.html
  app.js
  _headers
functions/
  _lib/shared.js
  api/auth/login.js
  api/auth/me.js
  api/auth/logout.js
  api/auth/password.js
  api/accounts.js
  api/accounts/[id].js
  api/users.js
  api/users/[id].js
  api/token/verify.js
  api/deploy.js
  api/health.js
src/
  deployer-core.js
  worker-d1-migration.js
migrations/
  0001_init.sql
```

## نکات مهم

- `migrations/0001_init.sql` فقط برای دیتابیس خود پنل خصوصی است.
- `src/worker-d1-migration.js` یک Bootstrap عمومی و idempotent برای D1ای است که هنگام Deploy برای Worker ساخته/انتخاب می‌شود؛ این فایل طرح‌واره اختصاصی برنامه Worker مقصد نیست. اگر سورس Worker جدول‌های اختصاصی لازم دارد، فایل Migration مخصوص همان Worker باید جداگانه تعریف شود.
- Tokenها در مرورگر به‌صورت پایدار ذخیره نمی‌شوند و از API فهرست حساب‌ها برگردانده نمی‌شوند؛ کد JavaScript پنل نیز به فایل مستقل منتقل شده و CSP اجرای اسکریپت inline را می‌بندد.
- `BOOTSTRAP_ADMIN_USERNAME`، `BOOTSTRAP_ADMIN_PASSWORD` و `VAULT_ENCRYPTION_KEY` را فقط به‌عنوان Secret/Variable امن در Cloudflare تنظیم کنید؛ هرگز در GitHub قرار ندهید.
- پس از اولین ورود مدیر، رمز را عوض و متغیرهای Bootstrap را حذف کنید.
- کلید `VAULT_ENCRYPTION_KEY` را پشتیبان‌گیری امن کنید؛ تغییر آن بدون رمزگذاری مجدد، Tokenهای قبلی را غیرقابل‌خواندن می‌کند.
- Clean Rebuild ممکن است Secretها، تنظیمات و منابع متصل به Worker را از بین ببرد؛ قبل از حذف نسخه قبلی پشتیبان بگیرید.
- پایش فعلی فقط تا وقتی صفحه باز و نشست معتبر است ادامه می‌یابد؛ برای پایش ۲۴ ساعته Cron Worker مستقل لازم است.

راهنمای استقرار در `DEPLOYMENT-GUIDE.txt` قرار دارد.

## مجوزهای Cloudflare

قالب ساخت Token دسترسی‌های Workers Scripts Edit، D1 Edit، KV Edit، Workers Routes Edit و Account Settings Read را پیش‌انتخاب می‌کند. برای اتصال Custom Domain، مجوز Workers Routes روی Zone مربوط لازم است. طبق مدل مجوزهای جدید Cloudflare، Editor برای Deploy روی Worker موجود است؛ ساخت یا حذف Worker جدید ممکن است به نقش Admin در سطح محصول Workers نیاز داشته باشد. اگر ایجاد نام جدید یا Clean Rebuild با HTTP 403 رد شد، در Cloudflare دسترسی Workers Admin را در سطح Product برای همان حساب اعطا کنید یا از نقش/Token سازگار با مجوزهای موردنیاز endpoint استفاده کنید.


### PBKDF2 on Cloudflare Workers
Cloudflare Workers rejects PBKDF2 derivations above 100,000 iterations. This deployment uses 100,000 for both password creation and verification. Use long unique passwords and retain login rate limiting.


### API Token troubleshooting (v3.2)
The application verifies user-owned tokens with `GET /user/tokens/verify` and falls back to the account-scoped verify route for account-owned tokens. A `403` / Cloudflare `code 100` is reported as an authorization or account/resource-scope issue, not automatically as an invalid token. Enter the raw token; a copied `Bearer ` prefix is stripped automatically.
