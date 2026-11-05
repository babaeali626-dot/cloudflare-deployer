(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/babaeali626-dot/clean-ips/refs/heads/main/worker%2Cjs';
  let currentUser = null;
  let accounts = [];
  let users = [];
  let currentDeployConfig = null;
  let monitorTimer = null;
  let monitorBusy = false;
  let consecutiveFailures = 0;
  let lastRebuildAt = 0;
  let lastMonitorCheckAt = 0;
  let activeSettingsAccountId = '';
  let settingsLoading = false;
  let settingsSaveTimer = null;
  let settingsSaveQueue = Promise.resolve();

  function setStatus(id, message, error = false, success = false) {
    const node = $(id); if (!node) return;
    node.hidden = !message;
    node.textContent = message || '';
    node.classList.toggle('error', !!error);
    node.classList.toggle('success', !!success);
  }

  async function api(url, method = 'GET', body = undefined) {
    const options = { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } };
    if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && url !== '/api/auth/login') showLogin('نشست شما پایان یافته است؛ دوباره وارد شوید.');
    if (!response.ok || data.success === false) throw new Error(data.error || `درخواست ناموفق بود (HTTP ${response.status}).`);
    return data;
  }

  function appendDeployLog(message, kind = '') {
    const node = $('deployConsole');
    if (!node) return;
    const placeholder = node.querySelector('.console-placeholder');
    if (placeholder) placeholder.remove();
    const line = document.createElement('span');
    line.className = `console-line ${kind}`.trim();
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    line.textContent = `[${stamp}] ${String(message || '').slice(0, 1500)}`;
    node.appendChild(line);
    while (node.children.length > 180) node.removeChild(node.firstElementChild);
    node.scrollTop = node.scrollHeight;
  }

  function clearDeployLog() {
    $('deployConsole').replaceChildren();
    appendDeployLog('کنسول آماده است؛ در انتظار شروع عملیات Deploy...');
  }

  async function streamDeploy(payload) {
    const response = await fetch('/api/deploy', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/x-ndjson', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) showLogin('نشست شما پایان یافته است؛ دوباره وارد شوید.');
      throw new Error(data.error || `درخواست استقرار ناموفق بود (HTTP ${response.status}).`);
    }
    if (!response.body) throw new Error('مرورگر امکان دریافت کنسول زنده را فراهم نکرد.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let terminalError = null;
    const consumeLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { appendDeployLog('یک رویداد نامعتبر از سرور دریافت شد.', 'error'); return; }
      if (event.type === 'log') appendDeployLog(event.message || 'مرحله جدید');
      else if (event.type === 'result') { result = event.data; appendDeployLog('استقرار با موفقیت تکمیل شد.', 'success'); }
      else if (event.type === 'error') { const status = Number(event.status); const suffix = status >= 400 ? ` (HTTP ${status})` : ''; terminalError = new Error(`${event.error || 'استقرار ناموفق بود.'}${suffix}`); appendDeployLog(terminalError.message, 'error'); }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(consumeLine);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
    if (terminalError) throw terminalError;
    if (!result) throw new Error('ارتباط کنسول قطع شد و پاسخ نهایی Deploy دریافت نشد.');
    return result;
  }

  function showLogin(message = '') {
    currentUser = null;
    if ($('apiToken')) $('apiToken').value = '';
    $('appContent').hidden = true;
    $('loginPanel').hidden = false;
    setStatus('loginStatus', message, !!message);
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
  }

  function showApp(user) {
    currentUser = user;
    $('loginPanel').hidden = true;
    $('appContent').hidden = false;
    $('currentUsername').textContent = user.username;
    $('currentRole').textContent = user.role === 'admin' ? 'مدیر' : 'کاربر مجاز';
    document.querySelectorAll('.admin-only').forEach(node => { node.hidden = user.role !== 'admin'; });
    $('memberAccountNote').hidden = user.role === 'admin';
    loadDashboard().catch(error => setStatus('dashboardStatus', error.message, true));
  }

  async function loadSession() {
    try {
      const data = await api('/api/auth/me');
      showApp(data.user);
    } catch (error) { showLogin(error.message || 'برای ورود نام کاربری و رمز عبور را وارد کنید.'); }
  }

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('loginBtn'); button.disabled = true; button.textContent = 'در حال ورود...';
    try {
      const data = await api('/api/auth/login', 'POST', { username: $('loginUsername').value.trim(), password: $('loginPassword').value });
      $('loginPassword').value = '';
      setStatus('loginStatus', '', false);
      showApp(data.user);
    } catch (error) { setStatus('loginStatus', error.message, true); }
    finally { button.disabled = false; button.textContent = 'ورود به پنل'; }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', 'POST', {}); } catch {}
    showLogin('با موفقیت خارج شدید.');
  });

  async function loadDashboard() {
    await loadAccounts();
    if (currentUser?.role === 'admin') await loadUsers();
  }

  async function loadAccounts(preferredId = '') {
    const data = await api('/api/accounts');
    accounts = data.accounts || [];
    const select = $('accountSelect');
    const old = preferredId || select.value;
    select.replaceChildren(new Option('انتخاب حساب', ''));
    accounts.forEach(account => select.add(new Option(`${account.label} · ••••${String(account.account_id).slice(-6)}`, account.id)));
    if (old && accounts.some(a => a.id === old)) select.value = old;
    else if (accounts.length) select.value = accounts[0].id;
    $('accountCount').textContent = `${accounts.length.toLocaleString('fa-IR')} حساب`;
    renderNewUserAccountChecks();
    if (currentUser?.role === 'admin' && select.value) fillAccountForm(select.value);
    if (select.value) await loadAccountSettings(select.value);
    else { activeSettingsAccountId = ''; currentDeployConfig = null; }
  }

  function selectedAccount() { return accounts.find(account => account.id === $('accountSelect').value) || null; }

  function collectAccountSettings() {
    const rawPanelPath = $('panelPath').value.trim().replace(/^\/+|\/+$/g, '') || 'panel';
    const panelPath = /(^|\/)panel$/i.test(rawPanelPath) ? rawPanelPath : `${rawPanelPath}/panel`;
    return {
      workerName: $('workerName').value.trim(),
      d1Name: $('d1Name').value.trim(),
      kvName: $('kvName').value.trim(),
      enableD1: $('enableD1').checked,
      enableKV: $('enableKV').checked,
      bindingName: $('bindingName').value.trim() || 'DB',
      kvBindingName: $('kvBindingName').value.trim() || 'KV',
      scriptUrl: $('scriptUrl').value.trim() || DEFAULT_SOURCE,
      customDomain: $('customDomain').value.trim(),
      panelPath,
      enableObfuscation: $('enableObfuscation').checked,
      recreateWorker: $('recreateWorker').checked,
      healthCheckEnabled: $('healthCheckEnabled').checked,
      autoRebuildMonitor: $('autoRebuildMonitor').checked,
      monitorInterval: Number($('monitorInterval').value) || 10,
      failureThreshold: Number($('failureThreshold').value) || 3,
      probePath: $('probePath').value.trim() || `/${panelPath}`,
      consecutiveFailures,
      lastRebuildAt,
    };
  }

  function applyAccountSettings(settings) {
    settingsLoading = true;
    const value = settings || {};
    $('workerName').value = value.workerName || '';
    $('d1Name').value = value.d1Name || '';
    $('kvName').value = value.kvName || '';
    $('enableD1').checked = value.enableD1 !== false;
    $('enableKV').checked = value.enableKV === true;
    $('bindingName').value = value.bindingName || 'DB';
    $('kvBindingName').value = value.kvBindingName || 'KV';
    $('d1Fields').classList.toggle('open', $('enableD1').checked);
    $('kvFields').classList.toggle('open', $('enableKV').checked);
    $('scriptUrl').value = value.scriptUrl || DEFAULT_SOURCE;
    $('sourcePreset').value = $('scriptUrl').value === DEFAULT_SOURCE ? 'default' : 'custom';
    $('customSourceField').hidden = $('sourcePreset').value !== 'custom';
    $('customDomain').value = value.customDomain || '';
    $('panelPath').value = value.panelPath || 'panel';
    $('enableObfuscation').checked = value.enableObfuscation === true;
    $('recreateWorker').checked = value.recreateWorker === true;
    $('healthCheckEnabled').checked = value.healthCheckEnabled !== false;
    $('autoRebuildMonitor').checked = value.autoRebuildMonitor !== false;
    $('monitorInterval').value = value.monitorInterval || 10;
    $('failureThreshold').value = value.failureThreshold || 3;
    $('probePath').value = value.probePath || `/${String(value.panelPath || 'panel').replace(/^\/+/, '')}`;
    consecutiveFailures = Number(value.consecutiveFailures || 0);
    lastRebuildAt = Number(value.lastRebuildAt || 0);
    lastMonitorCheckAt = Number(value.lastMonitorCheckAt || value.lastCronCheckAt || 0);
    settingsLoading = false;
  }

  async function loadAccountSettings(accountId) {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    $('monitorToggleBtn').textContent = 'شروع پایش';
    activeSettingsAccountId = accountId || '';
    currentDeployConfig = null;
    if (!accountId) { updateMonitorStatus('ابتدا یک حساب Cloudflare انتخاب کنید.'); return; }
    try {
      const response = await api(`/api/account-settings?accountRecordId=${encodeURIComponent(accountId)}`);
      const settings = response.settings || {};
      applyAccountSettings(settings);
      if (settings.lastCronCheckAt) {
        const cronDate = new Date(Number(settings.lastCronCheckAt));
        const cronDateLabel = Number.isNaN(cronDate.getTime()) ? "" : ` · ${cronDate.toLocaleString('fa-IR')}`;
        logMonitor(`آخرین نتیجه Cron پس‌زمینه: ${settings.lastCronStatus || 'ثبت شده'}${cronDateLabel} · ${settings.lastCronMessage || ''}`);
      }
      if (settings.lastDeployedAt) {
        currentDeployConfig = {
          accountRecordId: accountId,
          workerName: settings.workerName,
          scriptUrl: settings.scriptUrl || DEFAULT_SOURCE,
          customDomain: settings.customDomain || null,
          panelPath: settings.panelPath || 'panel',
          probePath: settings.probePath || `/${settings.panelPath || 'panel'}`,
          enableObfuscation: settings.enableObfuscation === true,
          recreateWorker: false,
          d1Name: settings.enableD1 ? settings.d1Name : null,
          bindingName: settings.enableD1 ? settings.bindingName || 'DB' : null,
          kvName: settings.enableKV ? settings.kvName : null,
          kvBindingName: settings.enableKV ? settings.kvBindingName || 'KV' : null,
        };
        updateMonitorStatus(`Worker ذخیره‌شده: ${settings.workerName} · ${$('healthCheckEnabled').checked ? 'بررسی خودکار روشن' : 'بررسی خودکار خاموش'}`);
        if ($('healthCheckEnabled').checked) startMonitoring({ silent: true });
      } else {
        updateMonitorStatus('نام‌های Worker و منابع این حساب ذخیره شدند. بعد از اولین Deploy، بررسی خودکار شروع می‌شود.');
      }
    } catch (error) {
      setStatus('dashboardStatus', `دریافت تنظیمات ذخیره‌شده حساب ناموفق بود: ${error.message}`, true);
    }
  }

  async function persistAccountSettings(accountId = activeSettingsAccountId, extra = {}) {
    if (!accountId || settingsLoading) return null;
    const settings = collectAccountSettings();
    const run = () => api('/api/account-settings', 'PUT', {
      accountRecordId: accountId,
      settings,
      ...extra,
    });
    settingsSaveQueue = settingsSaveQueue.catch(() => {}).then(run);
    return settingsSaveQueue;
  }

  function scheduleAccountSettingsSave() {
    if (!activeSettingsAccountId || settingsLoading) return;
    clearTimeout(settingsSaveTimer);
    const accountId = activeSettingsAccountId;
    settingsSaveTimer = setTimeout(() => {
      persistAccountSettings(accountId).catch(error => {
        setStatus('dashboardStatus', `ذخیره خودکار نام‌ها ناموفق بود: ${error.message}`, true);
      });
    }, 450);
  }

  async function flushAccountSettingsSave(accountId = activeSettingsAccountId) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    if (!accountId || settingsLoading) return null;
    return persistAccountSettings(accountId);
  }

  function secureRandomHex(byteCount = 5) {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function randomResourceName(prefix) { return `${prefix}-${secureRandomHex(5)}`; }

  [
    'workerName','d1Name','kvName','enableD1','enableKV','bindingName','kvBindingName',
    'scriptUrl','customDomain','panelPath','enableObfuscation','recreateWorker',
    'healthCheckEnabled','autoRebuildMonitor','monitorInterval','failureThreshold','probePath',
    'sourcePreset'
  ].forEach(id => {
    const node = $(id);
    if (!node) return;
    node.addEventListener('input', scheduleAccountSettingsSave);
    node.addEventListener('change', scheduleAccountSettingsSave);
  });

  function fillAccountForm(id) {
    const account = accounts.find(item => item.id === id);
    if (!account) return;
    $('accountLabel').value = account.label;
    $('accountId').value = account.account_id;
    $('apiToken').value = '';
    $('apiToken').placeholder = `Token فعلی: ${account.tokenMasked || '••••••••****'}؛ برای حفظ خالی بگذارید`; 
  }

  function clearMonitorForAccountChange() {
    if (currentDeployConfig && currentDeployConfig.accountRecordId !== $('accountSelect').value && monitorTimer) {
      clearInterval(monitorTimer); monitorTimer = null;
      $('monitorToggleBtn').textContent = 'شروع پایش';
      updateMonitorStatus('حساب عوض شد؛ برای جلوگیری از پایش حساب قبلی، پایش متوقف شد.');
    }
  }

  $('accountSelect').addEventListener('change', async () => {
    const previousId = activeSettingsAccountId;
    const nextId = $('accountSelect').value;
    if (previousId && previousId !== nextId) {
      await flushAccountSettingsSave(previousId).catch(error => setStatus('dashboardStatus', `ذخیره تنظیمات حساب قبلی ناموفق بود: ${error.message}`, true));
      clearMonitorForAccountChange();
    }
    if (currentUser?.role === 'admin' && nextId) fillAccountForm(nextId);
    await loadAccountSettings(nextId);
  });

  function clearAccountForm() {
    $('accountLabel').value = '';
    $('accountId').value = '';
    $('apiToken').value = '';
    $('apiToken').placeholder = 'توکن را پس از ساخت وارد کنید';
    $('accountSelect').value = '';
  }
  $('clearAccountFormBtn').addEventListener('click', clearAccountForm);

  function validateAccountForm(requireToken) {
    const label = $('accountLabel').value.trim();
    const accountId = $('accountId').value.trim();
    const token = $('apiToken').value.trim();
    if (!label || label.length > 60) throw new Error('نام حساب را وارد کنید (حداکثر ۶۰ نویسه).');
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Account ID باید ۳۲ کاراکتر هگزادسیمال باشد.');
    if (requireToken && (token.length < 20 || token.length > 512)) throw new Error('API Token نامعتبر است.');
    if (token && (token.length < 20 || token.length > 512)) throw new Error('API Token نامعتبر است.');
    return { label, accountId, token };
  }

  $('saveAccountBtn').addEventListener('click', async () => {
    try {
      const value = validateAccountForm(true);
      const result = await api('/api/accounts', 'POST', value);
      $('apiToken').value = '';
      await loadAccounts(result.account.id);
      await loadUsers();
      setStatus('accountStatus', 'حساب جدید با رمزگذاری سمت سرور ذخیره شد.', false, true);
    } catch (error) { setStatus('accountStatus', error.message, true); }
  });

  $('updateAccountBtn').addEventListener('click', async () => {
    try {
      const selected = selectedAccount();
      if (!selected) throw new Error('ابتدا حساب موردنظر را انتخاب کنید.');
      const value = validateAccountForm(false);
      await api(`/api/accounts/${encodeURIComponent(selected.id)}`, 'PATCH', value);
      $('apiToken').value = '';
      await loadAccounts(selected.id);
      await loadUsers();
      setStatus('accountStatus', 'اطلاعات حساب به‌روزرسانی شد.', false, true);
    } catch (error) { setStatus('accountStatus', error.message, true); }
  });

  $('deleteAccountBtn').addEventListener('click', async () => {
    try {
      const selected = selectedAccount();
      if (!selected) throw new Error('ابتدا حسابی را انتخاب کنید.');
      if (!confirm(`حساب «${selected.label}» و دسترسی‌های واگذارشده به آن حذف شود؟`)) return;
      await api(`/api/accounts/${encodeURIComponent(selected.id)}`, 'DELETE');
      clearAccountForm();
      await loadAccounts();
      await loadUsers();
      setStatus('accountStatus', 'حساب حذف شد و مجوزهای وابسته نیز لغو شدند.', false, true);
    } catch (error) { setStatus('accountStatus', error.message, true); }
  });

  // Cloudflare's official user-token template URL. The form is prefilled; Cloudflare still requires the owner to confirm and copy the token.
  function refreshTokenTemplateLink() {
    const permissions = [
      { key: 'workers_scripts', type: 'edit' },
      { key: 'workers_kv_storage', type: 'edit' },
      { key: 'd1', type: 'edit' },
      { key: 'account_settings', type: 'read' },
      { key: 'workers_routes', type: 'edit' },
    ];
    const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
    url.searchParams.set('permissionGroupKeys', JSON.stringify(permissions));
    const accountId = $('accountId').value.trim();
    // Restrict the template to the account entered in the form instead of all accounts.
    url.searchParams.set('accountId', /^[a-f0-9]{32}$/i.test(accountId) ? accountId : '*');
    url.searchParams.set('zoneId', 'all');
    url.searchParams.set('name', $('tokenName').value.trim() || 'JASAZ Cloudflare Worker Deployer');
    $('generateTokenBtn').href = url.toString();
  }
  $('tokenName').addEventListener('input', refreshTokenTemplateLink);
  $('accountId').addEventListener('input', refreshTokenTemplateLink);
  $('generateTokenBtn').addEventListener('click', (event) => {
    const accountId = $('accountId').value.trim();
    if (!/^[a-f0-9]{32}$/i.test(accountId)) {
      event.preventDefault();
      setStatus('accountStatus', 'ابتدا Account ID معتبر ۳۲ کاراکتری را وارد کنید تا Token فقط به همان حساب محدود شود.', true);
      $('accountId').focus();
      return;
    }
    refreshTokenTemplateLink();
  });
  refreshTokenTemplateLink();

  $('verifyTokenBtn').addEventListener('click', async () => {
    const button = $('verifyTokenBtn');
    button.disabled = true;
    button.textContent = 'در حال بررسی...';
    setStatus('tokenVerifyStatus', 'در حال بررسی وضعیت Token و دسترسی سرویس‌های Cloudflare...', false);
    try {
      const typedToken = $('apiToken')?.value.trim() || '';
      let payload;
      if (typedToken) {
        const accountId = $('accountId')?.value.trim() || '';
        if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('برای تست Token جدید، ابتدا Account ID معتبر را وارد کنید.');
        payload = { accountId, token: typedToken };
      } else {
        const selected = selectedAccount();
        if (!selected) throw new Error('Token را وارد کنید یا یک حساب ذخیره‌شده انتخاب کنید.');
        payload = { accountRecordId: selected.id };
      }
      const checked = await api('/api/token/verify', 'POST', payload);
      const workersOk = !!checked.access?.workers?.available;
      const d1Ok = !!checked.access?.d1?.available;
      const workersState = workersOk ? 'API قابل دسترس' : 'دسترسی API رد شد';
      const d1State = d1Ok ? 'API قابل دسترس' : 'دسترسی API رد شد';
      const expires = checked.token?.expiresOn ? ` · انقضا: ${new Date(checked.token.expiresOn).toLocaleDateString('fa-IR')}` : '';
      setStatus('tokenVerifyStatus', `Token فعال است${expires} · Workers: ${workersState} · D1: ${d1State}\n${checked.note || ''}`, !(workersOk && d1Ok), workersOk && d1Ok);
    } catch (error) {
      setStatus('tokenVerifyStatus', error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'تست زنده API Token';
    }
  });

  $('sourcePreset').addEventListener('change', () => {
    $('customSourceField').hidden = $('sourcePreset').value !== 'custom';
    if ($('sourcePreset').value === 'default') $('scriptUrl').value = DEFAULT_SOURCE;
  });
  $('randomWorkerBtn').addEventListener('click', () => {
    const prefixes = ['smart','turbo','edge','cloud','fast','pixel','flow','shield','zeus'];
    const choice = new Uint32Array(1);
    crypto.getRandomValues(choice);
    $('workerName').value = `${prefixes[choice[0] % prefixes.length]}-${secureRandomHex(5)}`;
    scheduleAccountSettingsSave();
  });
  $('randomD1Btn').addEventListener('click', () => {
    $('d1Name').value = randomResourceName('zeus-db');
    $('enableD1').checked = true;
    $('d1Fields').classList.add('open');
    scheduleAccountSettingsSave();
  });
  $('randomKVBtn').addEventListener('click', () => {
    $('kvName').value = randomResourceName('zeus-kv');
    $('enableKV').checked = true;
    $('kvFields').classList.add('open');
    scheduleAccountSettingsSave();
  });
  $('panelPath').addEventListener('change', () => {
    const path = $('panelPath').value.trim().replace(/^\/+|\/+$/g, '') || 'panel';
    $('probePath').value = `/${path}`;
    if (!/\/panel$/i.test(path)) $('probePath').value += '/panel';
    scheduleAccountSettingsSave();
  });
  $('enableD1').addEventListener('change', () => $('d1Fields').classList.toggle('open', $('enableD1').checked));
  $('enableKV').addEventListener('change', () => $('kvFields').classList.toggle('open', $('enableKV').checked));

  function validateDeploy() {
    if (!selectedAccount()) throw new Error('یک حساب Cloudflare مجاز انتخاب کنید.');
    const workerName = $('workerName').value.trim();
    if (!/^[a-z0-9_-]{1,63}$/.test(workerName)) throw new Error('نام Worker نامعتبر است؛ فقط حروف کوچک انگلیسی، اعداد، خط تیره و زیرخط مجاز هستند (حداکثر ۶۳ نویسه).');
    const url = $('scriptUrl').value.trim() || DEFAULT_SOURCE;
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('آدرس سورس معتبر نیست.'); }
    if (parsed.protocol !== 'https:' || !['raw.githubusercontent.com','gist.githubusercontent.com','raw.github.com'].includes(parsed.hostname.toLowerCase())) throw new Error('سورس باید HTTPS و از نوع GitHub Raw یا Gist Raw باشد.');
    const domain = $('customDomain').value.trim();
    const panelPath = $('panelPath').value.trim().replace(/^\/+|\/+$/g, '') || 'panel';
    $('probePath').value = `/${/(^|\/)panel$/i.test(panelPath) ? panelPath : `${panelPath}/panel`}`;
    if (panelPath.length > 180 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(panelPath)) throw new Error('مسیر پنل نامعتبر است؛ فقط حروف انگلیسی، عدد، -، _ و / مجاز هستند.');
    if (domain && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain.replace(/^https?:\/\//i,'').replace(/\.$/,''))) throw new Error('دامنه اختصاصی معتبر نیست.');
    if ($('enableD1').checked) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test($('d1Name').value.trim())) throw new Error('نام دیتابیس D1 معتبر نیست.');
      if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test($('bindingName').value.trim())) throw new Error('نام Binding دیتابیس معتبر نیست.');
    }
    if ($('enableKV').checked) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test($('kvName').value.trim())) throw new Error('نام KV معتبر نیست.');
      if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test($('kvBindingName').value.trim())) throw new Error('نام Binding مربوط به KV معتبر نیست.');
    }
    return {
      accountRecordId: selectedAccount().id,
      workerName,
      scriptUrl: url,
      customDomain: domain || null,
      panelPath: /(^|\/)panel$/i.test(panelPath) ? panelPath : `${panelPath}/panel`,
      enableObfuscation: $('enableObfuscation').checked,
      recreateWorker: $('recreateWorker').checked,
      d1Name: $('enableD1').checked ? $('d1Name').value.trim() : null,
      bindingName: $('enableD1').checked ? $('bindingName').value.trim() : null,
      kvName: $('enableKV').checked ? $('kvName').value.trim() : null,
      kvBindingName: $('enableKV').checked ? $('kvBindingName').value.trim() : null,
    };
  }

  function renderDeployResult(data) {
    const box = $('deployResult');
    box.className = 'result show';
    box.replaceChildren();
    const title = document.createElement('h3'); title.textContent = 'استقرار موفق بود'; box.appendChild(title);
    const text = document.createElement('p'); text.textContent = `Worker: ${data.workerName} · نوع: ${data.moduleWorker ? 'ES Module' : 'Service Worker'}`; box.appendChild(text);
    const panelLinks = [
      ['لینک پنل', data.panelUrl || null],
      ['لینک پنل روی دامنه اختصاصی', data.customDomainPanelUrl || null],
    ];
    if (panelLinks.some(([, url]) => url)) {
      const row = document.createElement('div'); row.className = 'url-row';
      for (const [label, url] of panelLinks) {
        if (!url) continue;
        const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = `${label}: ${url}`; row.appendChild(a);
      }
      box.appendChild(row);
    }
    if (data.workerUrl) {
      const root = document.createElement('p'); root.className = 'muted'; root.style.direction = 'ltr'; root.textContent = `Worker root: ${data.workerUrl}`; box.appendChild(root);
    }
    if (Array.isArray(data.steps)) {
      const list = document.createElement('ul');
      data.steps.forEach(step => { const li = document.createElement('li'); li.textContent = step; list.appendChild(li); });
      box.appendChild(list);
    }
  }

  async function saveLastDeploy(config, result) {
    currentDeployConfig = { ...config };
    consecutiveFailures = 0;
    await persistAccountSettings(config.accountRecordId, {
      markDeployed: true,
      lastWorkerUrl: result.workerUrl || null,
      lastPanelUrl: result.panelUrl || null,
      lastCustomDomainUrl: result.customDomainPanelUrl || result.customDomainUrl || null,
    });
    updateMonitorStatus('استقرار و تنظیمات این حساب در D1 ذخیره شدند.');
  }

  $('deployForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('deployBtn');
    if (button.disabled) return;
    let payload;
    try { payload = validateDeploy(); }
    catch (error) {
      $('deployResult').className = 'result show error';
      $('deployResult').textContent = error.message;
      appendDeployLog(error.message, 'error');
      return;
    }
    if (payload.recreateWorker && !confirm('Clean Rebuild روشن است. Worker فعلی با همین نام حذف و سپس دوباره ساخته می‌شود. ادامه می‌دهید؟')) return;
    button.disabled = true;
    button.textContent = 'در حال استقرار...';
    $('deployResult').className = 'result show';
    $('deployResult').textContent = 'فرایند شروع شد؛ مراحل را در کنسول زنده مشاهده کنید.';
    clearDeployLog();
    appendDeployLog('شروع استقرار؛ بررسی ورودی‌ها و حساب انتخاب‌شده...');
    try {
      await flushAccountSettingsSave(payload.accountRecordId);
      const data = await streamDeploy(payload);
      renderDeployResult(data);
      await saveLastDeploy(payload, data);
      appendDeployLog(`Worker ${data.workerName} آماده است.`, 'success');
      if ($('healthCheckEnabled').checked) startMonitoring({ silent: true });
    } catch (error) {
      $('deployResult').className = 'result show error';
      $('deployResult').textContent = `استقرار ناموفق بود: ${error.message}`;
      appendDeployLog(`استقرار ناموفق بود: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'نصب و راه‌اندازی Worker (Deploy Worker)';
    }
  });

  function logMonitor(message) {
    const node = $('monitorLog');
    const lines = node.textContent.split('\n').filter(Boolean);
    lines.push(`[${new Date().toLocaleString('fa-IR')}] ${message}`);
    node.textContent = lines.slice(-24).join('\n');
    node.scrollTop = node.scrollHeight;
  }

  function updateMonitorStatus(message) {
    if (message) $('monitorStatus').textContent = message;
    else if (!currentDeployConfig) $('monitorStatus').textContent = 'پس از استقرار موفق Worker، پایش خودکار فعال می‌شود.';
    else $('monitorStatus').textContent = `Worker: ${currentDeployConfig.workerName} · ${monitorTimer ? 'پایش فعال است' : 'پایش متوقف است'}`;
  }

  async function persistMonitorState() {
    if (!currentDeployConfig?.accountRecordId) return;
    try {
      lastMonitorCheckAt = Date.now();
      await persistAccountSettings(currentDeployConfig.accountRecordId, {
        settings: {
          ...collectAccountSettings(),
          consecutiveFailures,
          lastRebuildAt,
          lastMonitorCheckAt,
          lastMonitorSource: 'browser',
        },
      });
    } catch (error) {
      logMonitor(`ذخیره وضعیت پایش ناموفق بود: ${error.message}`);
    }
  }

  async function monitorTick() {
    if (monitorBusy || !currentDeployConfig) return;
    monitorBusy = true;
    try {
      const config = currentDeployConfig;
      const latest = await api(`/api/account-settings?accountRecordId=${encodeURIComponent(config.accountRecordId)}`);
      const latestSettings = latest.settings || {};
      const remoteCheckAt = Number(latestSettings.lastMonitorCheckAt || latestSettings.lastCronCheckAt || 0);
      if (remoteCheckAt > lastMonitorCheckAt) {
        lastMonitorCheckAt = remoteCheckAt;
        consecutiveFailures = Number(latestSettings.consecutiveFailures || 0);
        lastRebuildAt = Number(latestSettings.lastRebuildAt || 0);
        const intervalMs = Math.max(5, Math.min(1440, Number(latestSettings.monitorInterval) || 10)) * 60 * 1000;
        if (Date.now() - remoteCheckAt < intervalMs) {
          updateMonitorStatus(`آخرین پایش ${latestSettings.lastMonitorSource === 'cron' ? 'در پس‌زمینه Cron' : 'در نشست دیگر'} انجام شده؛ شمارنده‌ها همگام شدند.`);
          return;
        }
      }
      const probePath = $('probePath').value.trim() || `/${config.panelPath || 'panel'}`;
      const result = await api('/api/health', 'POST', {
        accountRecordId: config.accountRecordId,
        workerName: config.workerName,
        customDomain: config.customDomain || null,
        probePath,
      });
      if (result.healthy) {
        consecutiveFailures = 0;
        logMonitor(`سالم · ${result.message}`);
      } else {
        consecutiveFailures += 1;
        logMonitor(`خرابی ${consecutiveFailures}/${Number($('failureThreshold').value)||3} · ${result.message}`);
        const threshold = Math.max(2, Math.min(10, Number($('failureThreshold').value) || 3));
        if (consecutiveFailures >= threshold && $('autoRebuildMonitor').checked) {
          const elapsed = Date.now() - lastRebuildAt;
          if (elapsed < 60 * 60 * 1000) {
            logMonitor('به دلیل محدودیت یک‌ساعته، بازسازی فعلاً متوقف شد.');
          } else {
            lastRebuildAt = Date.now();
            logMonitor('تعداد شکست‌ها به حد مجاز رسید؛ Clean Rebuild خودکار شروع شد.');
            const rebuildPayload = { ...config, recreateWorker: true, panelPath: config.panelPath || $('panelPath').value.trim() || 'panel' };
            const deployed = await streamDeploy(rebuildPayload);
            consecutiveFailures = 0;
            await saveLastDeploy(rebuildPayload, deployed);
            logMonitor(`بازسازی Worker ${deployed.workerName} انجام شد.`);
          }
        }
      }
      await persistMonitorState();
      updateMonitorStatus();
    } catch (error) {
      logMonitor(`بررسی نامشخص؛ خطای API باعث افزایش شمارنده یا Rebuild نمی‌شود: ${error.message}`);
      updateMonitorStatus('بررسی سلامت نامشخص بود؛ هیچ Rebuildی به دلیل خطای API انجام نمی‌شود.');
    } finally {
      monitorBusy = false;
    }
  }

  function startMonitoring({ silent = false } = {}) {
    if (monitorTimer) return;
    if (!currentDeployConfig) {
      updateMonitorStatus('ابتدا یک Worker را با موفقیت Deploy کنید.');
      return;
    }
    const interval = Math.max(5, Math.min(1440, Number($('monitorInterval').value) || 10));
    const threshold = Math.max(2, Math.min(10, Number($('failureThreshold').value) || 3));
    $('monitorToggleBtn').textContent = 'توقف پایش';
    updateMonitorStatus(`پایش هر ${interval} دقیقه فعال شد؛ آستانه ${threshold} شکست متوالی.`);
    if (!silent) logMonitor('پایش دوره‌ای فعال شد.');
    monitorTick();
    monitorTimer = setInterval(monitorTick, interval * 60 * 1000);
    scheduleAccountSettingsSave();
  }

  $('monitorToggleBtn').addEventListener('click', async () => {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
      $('monitorToggleBtn').textContent = 'شروع پایش';
      $('healthCheckEnabled').checked = false;
      await flushAccountSettingsSave();
      updateMonitorStatus('پایش متوقف شد.');
      logMonitor('پایش متوقف شد.');
      return;
    }
    if (!currentDeployConfig) { updateMonitorStatus('ابتدا یک Worker را با موفقیت Deploy کنید.'); return; }
    $('healthCheckEnabled').checked = true;
    await flushAccountSettingsSave();
    startMonitoring();
  });

  $('healthCheckEnabled').addEventListener('change', async () => {
    if ($('healthCheckEnabled').checked) {
      if (currentDeployConfig) startMonitoring({ silent: true });
    } else if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
      $('monitorToggleBtn').textContent = 'شروع پایش';
      updateMonitorStatus('بررسی خودکار غیرفعال شد.');
    }
    await flushAccountSettingsSave().catch(error => setStatus('dashboardStatus', error.message, true));
  });

  $('autoRebuildMonitor').addEventListener('change', () => {
    if ($('autoRebuildMonitor').checked && !$('healthCheckEnabled').checked) {
      $('healthCheckEnabled').checked = true;
      if (currentDeployConfig) startMonitoring({ silent: true });
    }
    scheduleAccountSettingsSave();
  });

  $('monitorCheckBtn').addEventListener('click', monitorTick);

  function renderNewUserAccountChecks() {
    const holder = $('newUserAccounts');
    if (!holder) return;
    holder.replaceChildren();
    if (!accounts.length) { const p=document.createElement('span');p.className='muted';p.textContent='ابتدا حساب Cloudflare اضافه کنید.';holder.appendChild(p);return; }
    accounts.forEach(account => {
      const block=document.createElement('div');block.className='permission-item';
      const label=document.createElement('label');label.className='checkline';
      const input=document.createElement('input');input.type='checkbox';input.value=account.id;input.className='new-user-account';
      const text=document.createElement('span');text.textContent=account.label;
      label.append(input,text);block.appendChild(label);
      const sub=document.createElement('label');sub.className='checkline permission-sub';
      const rebuild=document.createElement('input');rebuild.type='checkbox';rebuild.value=account.id;rebuild.className='new-user-rebuild';rebuild.disabled=true;
      input.addEventListener('change',()=>{rebuild.disabled=!input.checked;if(!input.checked)rebuild.checked=false;});
      const subText=document.createElement('span');subText.textContent='اجازه Clean Rebuild';sub.append(rebuild,subText);block.appendChild(sub);holder.appendChild(block);
    });
  }

  async function loadUsers() {
    const data = await api('/api/users');
    users = data.users || [];
    renderUsers();
  }

  function accountCheckList(user, selectedIds) {
    const holder = document.createElement('div'); holder.className='checks';
    accounts.forEach(account => {
      const block=document.createElement('div');block.className='permission-item';
      const label=document.createElement('label');label.className='checkline';
      const input=document.createElement('input');input.type='checkbox';input.value=account.id;input.dataset.accountFor=user.id;input.checked=selectedIds.includes(account.id);
      const text=document.createElement('span');text.textContent=account.label;
      label.append(input,text);block.appendChild(label);
      const sub=document.createElement('label');sub.className='checkline permission-sub';
      const rebuild=document.createElement('input');rebuild.type='checkbox';rebuild.value=account.id;rebuild.dataset.rebuildFor=user.id;rebuild.checked=(user.rebuildIds||[]).includes(account.id);rebuild.disabled=!input.checked;
      input.addEventListener('change',()=>{rebuild.disabled=!input.checked;if(!input.checked)rebuild.checked=false;});
      const subText=document.createElement('span');subText.textContent='اجازه Clean Rebuild';sub.append(rebuild,subText);block.appendChild(sub);holder.appendChild(block);
    });
    if (!accounts.length) holder.textContent='هیچ حسابی ثبت نشده است.';
    return holder;
  }

  function renderUsers() {
    const list = $('usersList'); list.replaceChildren();
    const members = users.filter(user => user.role !== 'admin');
    if (!members.length) { const p=document.createElement('p');p.className='muted';p.textContent='هنوز کاربر دیگری ایجاد نشده است.';list.appendChild(p);return; }
    members.forEach(user => {
      const card=document.createElement('div');card.className='user-card';
      const head=document.createElement('div');head.className='user-card-head';
      const title=document.createElement('div');title.className='user-name';title.textContent=`${user.username} · ${user.active ? 'فعال' : 'غیرفعال'}`;
      const actions=document.createElement('div');actions.style.display='flex';actions.style.gap='6px';
      const save=document.createElement('button');save.type='button';save.className='btn btn-soft btn-small';save.textContent='ذخیره دسترسی';
      save.addEventListener('click',async()=>{try{const ids=[...card.querySelectorAll(`input[data-account-for="${CSS.escape(user.id)}"]:checked`)].map(x=>x.value);const rebuildIds=[...card.querySelectorAll(`input[data-rebuild-for="${CSS.escape(user.id)}"]:checked`)].map(x=>x.value);await api(`/api/users/${encodeURIComponent(user.id)}`,'PATCH',{accountIds:ids,rebuildIds});setStatus('usersStatus',`دسترسی‌های ${user.username} ذخیره شد.`,false,true);await loadUsers();}catch(e){setStatus('usersStatus',e.message,true);}});
      const toggle=document.createElement('button');toggle.type='button';toggle.className='btn btn-soft btn-small';toggle.textContent=user.active?'غیرفعال‌کردن':'فعال‌کردن';
      toggle.addEventListener('click',async()=>{try{await api(`/api/users/${encodeURIComponent(user.id)}`,'PATCH',{active:!user.active});await loadUsers();setStatus('usersStatus','وضعیت کاربر تغییر کرد.',false,true);}catch(e){setStatus('usersStatus',e.message,true);}});
      const del=document.createElement('button');del.type='button';del.className='btn btn-danger btn-small';del.textContent='حذف';
      del.addEventListener('click',async()=>{if(!confirm(`کاربر ${user.username} حذف شود؟`))return;try{await api(`/api/users/${encodeURIComponent(user.id)}`,'DELETE');await loadUsers();setStatus('usersStatus','کاربر حذف شد.',false,true);}catch(e){setStatus('usersStatus',e.message,true);}});
      actions.append(save,toggle,del);head.append(title,actions);card.appendChild(head);
      const passwordLabel=document.createElement('label');passwordLabel.textContent='رمز جدید (اختیاری، حداقل ۱۲ نویسه)';passwordLabel.style.marginTop='12px';card.appendChild(passwordLabel);
      const passwordInput=document.createElement('input');passwordInput.className='input';passwordInput.type='password';passwordInput.autocomplete='new-password';passwordInput.placeholder='برای تغییر رمز وارد کنید';passwordInput.style.marginTop='6px';card.appendChild(passwordInput);
      const reset=document.createElement('button');reset.type='button';reset.className='btn btn-soft btn-small';reset.textContent='تغییر رمز کاربر';reset.style.marginTop='7px';reset.addEventListener('click',async()=>{try{if(passwordInput.value.length<12)throw new Error('رمز جدید باید حداقل ۱۲ نویسه داشته باشد.');await api(`/api/users/${encodeURIComponent(user.id)}`,'PATCH',{password:passwordInput.value});passwordInput.value='';setStatus('usersStatus','رمز کاربر تغییر کرد و نشست‌های قبلی او بسته شدند.',false,true);}catch(e){setStatus('usersStatus',e.message,true);}});card.appendChild(reset);
      const accessTitle=document.createElement('div');accessTitle.className='muted';accessTitle.style.marginTop='12px';accessTitle.textContent='حساب‌هایی که این کاربر می‌تواند استفاده کند:';card.appendChild(accessTitle);
      card.appendChild(accountCheckList(user,user.accountIds||[]));list.appendChild(card);
    });
  }

  $('createUserBtn').addEventListener('click', async () => {
    try {
      const username=$('newUsername').value.trim();const password=$('newUserPassword').value;
      const accountIds=[...document.querySelectorAll('.new-user-account:checked')].map(x=>x.value);
      const rebuildIds=[...document.querySelectorAll('.new-user-rebuild:checked')].map(x=>x.value);
      const result=await api('/api/users','POST',{username,password,accountIds,rebuildIds});
      $('newUsername').value='';$('newUserPassword').value='';
      setStatus('usersStatus',`کاربر ${result.user.username} ساخته شد و فقط به حساب‌های انتخاب‌شده دسترسی دارد.`,false,true);
      await loadUsers();
    } catch(error) { setStatus('usersStatus',error.message,true); }
  });

  $('passwordPanelBtn').addEventListener('click', () => { $('passwordCard').hidden=!$('passwordCard').hidden; if (!$('passwordCard').hidden) $('passwordCard').scrollIntoView({behavior:'smooth',block:'center'}); });
  $('changePasswordBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/password','POST',{currentPassword:$('currentPassword').value,newPassword:$('newPassword').value});
      $('currentPassword').value='';$('newPassword').value='';
      setStatus('passwordStatus','رمز عبور با موفقیت تغییر کرد.',false,true);
    } catch(error) { setStatus('passwordStatus',error.message,true); }
  });

  $('menuTop').addEventListener('click', () => { document.getElementById('cloudflareCard').scrollIntoView({behavior:'smooth'}); });
  $('themeBtn').addEventListener('click', () => {
    document.body.classList.toggle('soft-light');
    const light=document.body.classList.contains('soft-light');
    document.documentElement.style.setProperty('--text',light?'#fff':'#f5f1ff');
    $('themeBtn').textContent=light?'☾':'☼';
  });

  // Defaults are created server-side per Cloudflare account and persisted in D1.
  $('scriptUrl').value = DEFAULT_SOURCE;
  $('healthCheckEnabled').checked = true;
  $('autoRebuildMonitor').checked = true;
  $('enableD1').checked = true;
  $('enableKV').checked = false;
  $('probePath').value = '/panel';
  loadSession();
})();
