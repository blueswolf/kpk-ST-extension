/**
 * 卡铺控 Kapuk · SillyTavern 扩展
 *
 * 将卡铺控角色卡社区以 iframe 嵌入酒馆顶部导航抽屉：
 *  - 扩展设置面板输入网站用户名/密码，直连 Supabase Auth REST 登录
 *    （密码仅用于登录、绝不落地保存；只保存可续期、可吊销的 refresh token 凭据）
 *  - 打开面板后通过 postMessage 将登录态注入站点 iframe，自动登录
 *  - 站点内点击「下载」→ postMessage 通知本扩展 → 抓取 PNG →
 *    POST /api/characters/import 导入酒馆角色列表（计费仍在站点侧完成）
 */
import { getRequestHeaders, getCharacters, saveSettingsDebounced, name1 } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

// 自适应安装目录名（git 安装时目录名 = 仓库名，手动安装时可任意命名）
const MODULE_DIR = new URL('.', import.meta.url).pathname.replace(/\/+$/, '');
const EXT_FOLDER = MODULE_DIR.split('/').pop() || 'kapuk';
const EXT_ID = `third-party/${EXT_FOLDER}`;

const DEFAULT_SITE_URL = 'https://card.kpk.dpdns.org';
const SUPABASE_URL = 'https://api.kpk.dpdns.org';
// Supabase anon key 为公开密钥（网站前端包中本就可见），仅用于标识客户端，无安全风险
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzM1Njg5NjAwLCJleHAiOjIwNTEyMjI0MDB9.ImLMn0jCYHYKfkepd-0rKgm_HfkfCIkd_3r359WE5lE';

/* ---------------- 设置读写 ---------------- */

function getSettings() {
    if (!extension_settings[EXT_FOLDER]) {
        extension_settings[EXT_FOLDER] = {
            siteUrl: DEFAULT_SITE_URL,
            username: '',
            accessToken: '',
            refreshToken: '',
        };
    }
    return extension_settings[EXT_FOLDER];
}

function saveSettings() {
    saveSettingsDebounced();
}

function getSiteUrl() {
    return (getSettings().siteUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

function getSiteOrigin() {
    try {
        return new URL(getSiteUrl()).origin;
    } catch {
        return DEFAULT_SITE_URL;
    }
}

/* ---------------- Supabase 登录 ---------------- */

async function kapukLogin(identifier, password) {
    let email = String(identifier || '').trim();
    if (!email) throw new Error('请输入用户名或邮箱');
    if (!password) throw new Error('请输入密码');

    // 与网站登录页一致：用户名先通过 RPC 换真实邮箱
    if (!email.includes('@')) {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_email_by_username`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_username: email }),
        });
        if (!resp.ok) throw new Error(`查询用户名失败 (HTTP ${resp.status})`);
        const data = await resp.json().catch(() => null);
        if (!data) throw new Error('找不到该用户名');
        email = data;
    }

    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
        throw new Error(data.error_description || data.msg || '账号或密码错误');
    }
    return data;
}

// 用 refresh token 换新凭据（Supabase 会轮换 refresh token，需保存新值）
async function refreshSession() {
    const s = getSettings();
    if (!s.refreshToken) return false;
    try {
        const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: s.refreshToken }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.access_token) return false;
        s.accessToken = data.access_token;
        s.refreshToken = data.refresh_token || s.refreshToken;
        saveSettings();
        return true;
    } catch (e) {
        console.warn('[kapuk] 刷新登录凭据失败', e);
        return false;
    }
}

// 吊销 refresh token（退出登录时调用，失败不阻塞本地清理）
async function revokeSession() {
    const s = getSettings();
    if (!s.accessToken) return;
    try {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${s.accessToken}` },
        });
    } catch { /* ignore */ }
}

function clearTokens() {
    const s = getSettings();
    s.accessToken = '';
    s.refreshToken = '';
    saveSettings();
}

/* ---------------- iframe 面板 ---------------- */

let iframeCreated = false;

function ensureIframe() {
    const wrap = document.getElementById('kapuk_iframe_wrap');
    if (!wrap || iframeCreated) return;
    iframeCreated = true;

    const iframe = document.createElement('iframe');
    iframe.id = 'kapuk_iframe';
    iframe.title = '卡铺控';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.addEventListener('load', () => {
        document.getElementById('kapuk_iframe_placeholder')?.classList.add('kapuk-placeholder-hidden');
    });
    iframe.src = `${getSiteUrl()}/?st=1#/`;
    wrap.appendChild(iframe);
}

function getIframe() {
    return document.getElementById('kapuk_iframe');
}

function sendAuthToIframe() {
    const s = getSettings();
    const iframe = getIframe();
    if (!iframe || !iframe.contentWindow) return;
    if (!s.accessToken || !s.refreshToken) {
        updateBadge();
        return;
    }
    iframe.contentWindow.postMessage({
        type: 'kapuk-auth',
        access_token: s.accessToken,
        refresh_token: s.refreshToken,
    }, getSiteOrigin());
}

/* ---------------- 导入角色卡到酒馆 ---------------- */

async function importCardToTavern(url, title) {
    try {
        toastr.info(`正在下载「${title}」…`, '卡铺控');
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`获取卡片图片失败 (HTTP ${resp.status})`);
        const blob = await resp.blob();
        const safeName = (String(title || 'card').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80)) || 'card';
        const file = new File([blob], `${safeName}.png`, { type: blob.type || 'image/png' });

        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', 'png');
        try {
            if (typeof name1 !== 'undefined' && name1) formData.append('user_name', name1);
        } catch { /* ignore */ }

        const result = await fetch('/api/characters/import', {
            method: 'POST',
            body: formData,
            headers: getRequestHeaders({ omitContentType: true }),
            cache: 'no-cache',
        });
        if (!result.ok) throw new Error(`酒馆导入接口返回 HTTP ${result.status}`);
        const importData = await result.json().catch(() => ({}));
        if (importData.error) throw new Error(String(importData.error));

        toastr.success(`角色卡「${title}」已导入酒馆`, '卡铺控');
        try {
            // 与酒馆原生导入 PNG 的体验一致：清空搜索过滤 → 刷新角色列表 → 收起卡铺控面板 → 角色栏展开并闪烁新卡
            $('#character_search_bar').val('').trigger('input');
            await getCharacters();
            if ($('#kapuk_drawer_content').hasClass('openDrawer')) {
                $('#kapuk_drawer .drawer-toggle').trigger('click');
            }
            if (importData.file_name) {
                const script = await import('../../../../script.js');
                script.select_rm_info?.('char_import_no_toast', importData.file_name);
            }
        } catch (e) {
            console.warn('[kapuk] 刷新角色列表/闪烁提示失败', e);
        }
        return { ok: true };
    } catch (e) {
        const msg = String(e?.message || e);
        toastr.error(msg, '卡铺控导入失败');
        return { ok: false, error: msg };
    }
}

/* ---------------- postMessage 桥 ---------------- */

function onWindowMessage(ev) {
    if (ev.origin !== getSiteOrigin()) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'kapuk-ready') {
        sendAuthToIframe();
        return;
    }
    if (d.type === 'kapuk-auth-required') {
        handleAuthRequired();
        return;
    }
    if (d.type === 'kapuk-import') {
        importCardToTavern(d.url, d.title).then((r) => {
            try {
                ev.source?.postMessage({ type: 'kapuk-import-result', id: d.id, ok: r.ok, error: r.error }, ev.origin);
            } catch { /* ignore */ }
        });
        return;
    }
}

let reloginInFlight = false;
let lastRefreshAt = 0;

async function handleAuthRequired() {
    const s = getSettings();
    if (!s.refreshToken) {
        updateBadge();
        setStatus('尚未登录，请先在「扩展 → 卡铺控」面板登录账号', true);
        return;
    }
    if (reloginInFlight) return;
    // 防抖：刚刷新过凭据站点仍拒绝（说明凭据已彻底失效），清空并停止循环
    const now = Date.now();
    if (now - lastRefreshAt < 15000) {
        console.warn('[kapuk] 刷新凭据后站点仍拒绝登录，清空凭据');
        clearTokens();
        updateBadge();
        setStatus('登录凭据已失效，请到「扩展 → 卡铺控」重新登录', true);
        return;
    }
    reloginInFlight = true;
    lastRefreshAt = now;
    try {
        // 用 refresh token 换新凭据再注入（access token 仅 1 小时有效，必须刷新）
        if (await refreshSession()) {
            updateBadge();
            sendAuthToIframe();
        } else {
            clearTokens();
            updateBadge();
            setStatus('登录已过期，请到「扩展 → 卡铺控」重新登录', true);
        }
    } finally {
        reloginInFlight = false;
    }
}

/* ---------------- UI 状态 ---------------- */

function updateBadge() {
    const s = getSettings();
    const badge = document.getElementById('kapuk_auth_badge');
    if (!badge) return;
    if (s.accessToken) {
        badge.textContent = `已登录：${s.username}`;
        badge.classList.remove('kapuk-badge-off');
        badge.classList.add('kapuk-badge-on');
    } else {
        badge.textContent = '未登录';
        badge.classList.add('kapuk-badge-off');
        badge.classList.remove('kapuk-badge-on');
    }
}

function setStatus(text, isError = false) {
    const el = document.getElementById('kapuk_login_status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('kapuk-status-error', !!isError);
}

/* ---------------- 顶栏抽屉 ---------------- */

async function addNavbarDrawer() {
    if (document.getElementById('kapuk_drawer')) return;
    const drawerHtml = await renderExtensionTemplateAsync(EXT_ID, 'drawer');
    const anchor = $('#extensions-settings-button');
    if (anchor.length) {
        anchor.after(drawerHtml);
    } else {
        $('#top-settings-holder').prepend(drawerHtml);
    }

    const toggle = $('#kapuk_drawer .drawer-toggle');
    let bound = false;
    try {
        const script = await import('../../../../script.js');
        if (typeof script.doNavbarIconClick === 'function') {
            toggle.on('click', script.doNavbarIconClick);
            bound = true;
        }
    } catch (e) {
        console.warn('[kapuk] doNavbarIconClick 不可用，回退内置开关', e);
    }
    if (!bound) {
        toggle.on('click', () => {
            const content = $('#kapuk_drawer_content');
            const icon = $('#kapuk_drawer_icon');
            const willOpen = content.hasClass('closedDrawer');
            content.toggleClass('closedDrawer openDrawer');
            icon.toggleClass('closedIcon openIcon');
            if (willOpen) ensureIframe();
        });
    }
    // 无论走哪条路径，点击时都尝试初始化 iframe（幂等）
    toggle.on('click', () => setTimeout(ensureIframe, 0));

    $('#kapuk_reload_btn').on('click', () => {
        const iframe = getIframe();
        const placeholder = document.getElementById('kapuk_iframe_placeholder');
        placeholder?.classList.remove('kapuk-placeholder-hidden');
        if (iframe) {
            iframe.src = `${getSiteUrl()}/?st=1#/`;
        } else {
            iframeCreated = false;
            ensureIframe();
        }
    });

    $('#kapuk_settings_btn').on('click', () => {
        $('#extensions-settings-button .drawer-toggle').trigger('click');
    });
}

function openDrawer() {
    ensureIframe();
    const content = $('#kapuk_drawer_content');
    if (content.hasClass('closedDrawer')) {
        $('#kapuk_drawer .drawer-toggle').trigger('click');
    }
}

/* ---------------- 设置面板 ---------------- */

async function addSettingsPanel() {
    const html = await renderExtensionTemplateAsync(EXT_ID, 'settings');
    const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    container.append(html);

    const s = getSettings();
    $('#kapuk_site_url').val(s.siteUrl || DEFAULT_SITE_URL);
    $('#kapuk_username').val(s.username || '');
    // 密码框始终留空：密码仅用于登录，不会被保存/回填
    updateBadge();
    if (s.accessToken) setStatus(`已登录：${s.username}（凭据自动续期，无需重新登录）`);

    $('#kapuk_site_url').on('change', function () {
        const v = (String($(this).val() || '').trim() || DEFAULT_SITE_URL).replace(/\/+$/, '');
        s.siteUrl = v;
        $(this).val(v);
        saveSettings();
        // 站点变更后，iframe 下次打开时按新地址重新加载
        iframeCreated = false;
        getIframe()?.remove();
        document.getElementById('kapuk_iframe_placeholder')?.classList.remove('kapuk-placeholder-hidden');
    });

    $('#kapuk_login_btn').on('click', async () => {
        const username = String($('#kapuk_username').val() || '').trim();
        const password = String($('#kapuk_password').val() || '');
        setStatus('登录中…');
        try {
            const data = await kapukLogin(username, password);
            s.username = username;
            delete s.password; // 密码绝不落地保存
            s.accessToken = data.access_token;
            s.refreshToken = data.refresh_token;
            saveSettings();
            $('#kapuk_password').val('');
            updateBadge();
            setStatus(`登录成功：${username}（密码未保存，凭据将自动续期）`);
            toastr.success('登录成功，点击顶栏 KPK 图标开始使用', '卡铺控');
            sendAuthToIframe();
        } catch (e) {
            setStatus(String(e?.message || e), true);
        }
    });

    $('#kapuk_logout_btn').on('click', async () => {
        setStatus('正在退出…');
        await revokeSession(); // 吊销 refresh token，使其立即失效
        clearTokens();
        delete s.password;
        updateBadge();
        setStatus('已退出登录（凭据已吊销，站点面板刷新后将需要重新登录）');
        $('#kapuk_password').val('');
    });

    $('#kapuk_open_panel_btn').on('click', openDrawer);
}

/* ---------------- 入口 ---------------- */

jQuery(async () => {
    try {
        const s = getSettings();
        // 迁移：旧版本曾明文保存密码，本版本起仅保存登录凭据，立即清除
        if (s.password) {
            delete s.password;
            saveSettings();
            console.log('[kapuk] 已清除旧版本保存的明文密码');
        }
        window.addEventListener('message', onWindowMessage);
        await addNavbarDrawer();
        await addSettingsPanel();
        console.log('[kapuk] 卡铺控扩展已加载');
    } catch (e) {
        console.error('[kapuk] 扩展加载失败', e);
    }
});
