/**
 * 自动隐藏楼层（Auto Hide Floors）
 * 适用于 TauriTavern / SillyTavern 1.13+
 *
 * 两种能力可以独立开关：
 * 1. 界面折叠：只给较早的 .mes 加一个 CSS 类，点“显示”可以临时看全部。
 * 2. 上下文排除：生成前临时把较早消息标成 is_system，生成数据组装完成后立刻还原。
 *    - 这是 SillyTavern 原生的“从提示词中排除”机制，不会删除消息。
 *    - 临时标记不会保存；正常情况下聊天 JSONL 不会因此改变。
 *
 * 之所以要“生成前临时标记、生成后还原”，是为了避免像 /hide 一样把 is_system 永久写进聊天记录，
 * 也避免污染用户手动隐藏的状态。
 */

const MODULE_NAME = 'autoHideFloors';

// 仓库安装时文件夹名可能是仓库名（例如 SillyTavern-），不能写死 auto-hide-floors
const EXTENSION_PATH = (() => {
    try {
        const parts = new URL(import.meta.url).pathname.split('/').filter(Boolean);
        const folder = parts[parts.length - 2];
        if (folder) return `third-party/${decodeURIComponent(folder)}`;
    } catch {
        // ignore
    }
    return 'third-party/auto-hide-floors';
})();
const HIDDEN_CLASS = 'ahf-hidden';
const FLASH_CLASS = 'ahf-flash';
const FAB_POS_KEY = 'ahf-fab-pos';
const PANEL_OPEN_KEY = 'ahf-panel-open';
const MANUAL_RANGE_PREFIX = 'ahf-ranges:';
const TEMPORARY_RESTORE_TIMEOUT = 30_000;

const DEFAULTS = Object.freeze({
    enabled: true,
    keep: 10,
    countMode: 'all',
    foldUi: true,
    trimContext: true,
    persistentHide: true,
});

/** 只对这些面向用户的生成类型做上下文排除；quiet 等内部生成保持完整上下文 */
const TRIMMABLE_GENERATION_TYPES = new Set([
    'normal',
    'regenerate',
    'swipe',
    'continue',
    'impersonate',
]);

const EVENTS_TO_WATCH = [
    'APP_READY',
    'CHAT_CHANGED',
    'CHAT_LOADED',
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
    'MESSAGE_EDITED',
    'MESSAGE_DELETED',
    'MESSAGE_SWIPED',
    'MESSAGE_UPDATED',
    'MORE_MESSAGES_LOADED',
];

/** @type {{enabled: boolean, keep: number, countMode: 'all'|'normal', foldUi: boolean, trimContext: boolean, persistentHide: boolean}} */
let settings = { ...DEFAULTS };
/** 临时“显示全部”状态；切换聊天时自动复位 */
let peek = false;
/** @type {MutationObserver|null} */
let chatObserver = null;
/** @type {HTMLElement|null} */
let observedChatEl = null;
/** @type {number|null} */
let updateTimer = null;
/** @type {Promise<void>|null} */
let mountingSettings = null;
let lastChatKey = '';

/** 浮动面板与手动区间 */
/** @type {HTMLElement|null} */
let fabEl = null;
/** @type {HTMLElement|null} */
let panelEl = null;
let panelOpen = false;
/** @type {{pointerId: number, startX: number, startY: number, fabLeft: number, fabTop: number}|null} */
let panelDrag = null;
/** @type {{pointerId: number, startX: number, startY: number, dx: number, dy: number, rect: DOMRect, active: boolean}|null} */
let fabDrag = null;
/** @type {Array<{start: number, end: number}>} */
let manualRanges = [];
let rangeStart = null;
let rangeEnd = null;
let lastRangesKey = null;

/** 生成期间临时改成 is_system 的消息；生成数据组装完成后必须还原 */
/** @type {Array<{index: number, message: any, originalIsSystem: boolean, node: HTMLElement|null}>} */
let temporaryMarks = [];
/** @type {number|null} */
let temporaryRestoreTimer = null;
/** 当前是否处于 Generate() 的上下文中；用来避免把 /sendas 之类的普通 MESSAGE_SENT 当成生成 */
let generationPending = false;
/** regenerate 会先删除末楼并触发一次防抖保存，必须等删除保存完成后再临时标记 */
let pendingRegenerate = false;
/** 上一次生成实际临时排除了多少层，便于 /ahf 排查 */
let lastTrimmedCount = 0;
/** 持久化隐藏的串行任务，避免重复 save */
/** @type {Promise<number>|null} */
let persistentApplyPromise = null;

const getContext = () => SillyTavern.getContext();

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: source.enabled !== false,
        keep: clampInteger(source.keep, 1, 500, DEFAULTS.keep),
        countMode: source.countMode === 'normal' ? 'normal' : 'all',
        foldUi: source.foldUi !== false,
        trimContext: source.trimContext !== false,
        persistentHide: source.persistentHide !== false,
    };
}

function loadSettings() {
    const ctx = getContext();
    const stored = ctx.extensionSettings?.[MODULE_NAME];
    settings = normalizeSettings(stored);
    if (ctx.extensionSettings) {
        ctx.extensionSettings[MODULE_NAME] = settings;
    }
}

function persistSettings() {
    const ctx = getContext();
    if (ctx.extensionSettings) {
        ctx.extensionSettings[MODULE_NAME] = settings;
    }
    ctx.saveSettingsDebounced?.();
}

/** 判断一条消息是否算作“普通对话楼层”（用于“仅普通对话”计数模式） */
function isPluginMarkedHidden(message) {
    return message?.extra?.ahf_hidden === true;
}

function isCountedMessage(message) {
    if (!message) return false;
    // 插件自己永久隐藏的楼层仍然参与“最近 N 层”计数，否则会越隐藏越往前吞
    if (message.is_system && !isPluginMarkedHidden(message)) return false;
    const type = message.extra?.type;
    return type !== 'narrator' && type !== 'comment' && type !== 'assistant_note';
}

/**
 * 计算第一条“应该保持可见/保留在上下文”的消息下标；0 表示全部保留。
 * 下标小于该值的楼层会被折叠或排除。
 * @param {any[]} chat
 */
function computeStartIndex(chat) {
    const total = Array.isArray(chat) ? chat.length : 0;
    if (total === 0) return 0;

    const keep = Math.max(1, settings.keep);

    if (settings.countMode === 'all') {
        return Math.max(0, total - keep);
    }

    // 从后往前数 keep 条普通消息，第一条被保留消息之前的内容全部排除
    let counted = 0;
    for (let index = total - 1; index >= 0; index--) {
        if (!isCountedMessage(chat[index])) continue;
        counted++;
        if (counted >= keep) return index;
    }

    // 普通消息不足 keep 条：没有可排除的内容
    return 0;
}

function currentChatKey() {
    const ctx = getContext();
    const chatId = ctx.chatId ?? ctx.getCurrentChatId?.() ?? '';
    return `${ctx.characterId ?? ''}|${ctx.groupId ?? ''}|${chatId}`;
}

/* --------------------------------------------------------------------------
 * 手动隐藏区间（浮动面板的 起始/截止/隐/显）
 * 只存 localStorage，不写聊天记录；开启上下文排除时，下一次生成也会临时排除这些楼层
 * -------------------------------------------------------------------------- */

function manualRangeStorageKey() {
    return MANUAL_RANGE_PREFIX + (currentChatKey() || 'default');
}

function normalizeRange(range) {
    if (!range) return null;
    const start = Number.parseInt(range.start, 10);
    const end = Number.parseInt(range.end, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start: Math.min(start, end), end: Math.max(start, end) };
}

function mergeRanges(ranges) {
    const normalized = ranges
        .map(normalizeRange)
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const range of normalized) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end + 1) {
            last.end = Math.max(last.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

function ensureManualRangesForChat(force = false) {
    const key = manualRangeStorageKey();
    if (!force && key === lastRangesKey) return;
    lastRangesKey = key;

    try {
        const raw = JSON.parse(localStorage.getItem(key) || '[]');
        manualRanges = Array.isArray(raw) ? mergeRanges(raw) : [];
    } catch {
        manualRanges = [];
    }

    if (force) {
        rangeStart = null;
        rangeEnd = null;
    }
}

function saveManualRanges() {
    if (!lastRangesKey) return;
    try {
        if (manualRanges.length > 0) {
            localStorage.setItem(lastRangesKey, JSON.stringify(manualRanges));
        } else {
            localStorage.removeItem(lastRangesKey);
        }
    } catch {
        // localStorage 不可用时只保留在当前会话
    }
}

function isManuallyHidden(index) {
    return manualRanges.some(range => index >= range.start && index <= range.end);
}

function countHiddenIndices(autoStart, includeManual, total) {
    const hidden = new Set();
    for (let index = 0; index < autoStart && index < total; index++) {
        hidden.add(index);
    }
    if (includeManual) {
        for (const range of manualRanges) {
            const start = Math.max(0, range.start);
            const end = Math.min(total - 1, range.end);
            for (let index = start; index <= end; index++) {
                hidden.add(index);
            }
        }
    }
    return hidden.size;
}

function addManualRange(range) {
    const normalized = normalizeRange(range);
    if (!normalized) return;
    manualRanges = mergeRanges([...manualRanges, normalized]);
    peek = false;
    saveManualRanges();
    update();
    if (settings.persistentHide) void applyPersistentVisibility();
}

function removeManualRange(range) {
    const normalized = normalizeRange(range);
    if (!normalized) return;

    const remaining = [];
    for (const existing of manualRanges) {
        if (existing.end < normalized.start || existing.start > normalized.end) {
            remaining.push(existing);
            continue;
        }
        if (existing.start < normalized.start) {
            remaining.push({ start: existing.start, end: normalized.start - 1 });
        }
        if (existing.end > normalized.end) {
            remaining.push({ start: normalized.end + 1, end: existing.end });
        }
    }

    manualRanges = remaining;
    saveManualRanges();
    update();
    if (settings.persistentHide) void applyPersistentVisibility();
}

function scheduleUpdate(delay = 40) {
    if (updateTimer !== null) {
        clearTimeout(updateTimer);
    }
    updateTimer = window.setTimeout(() => {
        updateTimer = null;
        update();
    }, delay);
}

function applyHiddenClasses(chatEl, autoStart, manualActive) {
    for (const node of chatEl.querySelectorAll('.mes[mesid]')) {
        const mesId = Number(node.getAttribute('mesid'));
        if (!Number.isInteger(mesId)) continue;
        const shouldHide = (mesId >= 0 && mesId < autoStart)
            || (manualActive && isManuallyHidden(mesId));
        node.classList.toggle(HIDDEN_CLASS, shouldHide);
    }
}

/* --------------------------------------------------------------------------
 * 上下文排除：生成前临时标记，生成数据组装完成后还原
 * -------------------------------------------------------------------------- */

function armTemporaryRestoreTimer() {
    if (temporaryRestoreTimer !== null) {
        clearTimeout(temporaryRestoreTimer);
    }
    temporaryRestoreTimer = window.setTimeout(() => {
        temporaryRestoreTimer = null;
        generationPending = false;
        restoreTemporaryHiding();
    }, TEMPORARY_RESTORE_TIMEOUT);
}

function applyTemporaryHiding() {
    if (!settings.enabled || !settings.trimContext) return;
    if (settings.persistentHide) return;
    if (temporaryMarks.length > 0) {
        armTemporaryRestoreTimer();
        return;
    }

    ensureManualRangesForChat();
    lastTrimmedCount = 0;

    const chat = getContext().chat;
    if (!Array.isArray(chat)) return;

    const startIndex = computeStartIndex(chat);
    const indices = new Set();
    for (let index = 0; index < startIndex && index < chat.length; index++) {
        indices.add(index);
    }
    for (const range of manualRanges) {
        const start = Math.max(0, range.start);
        const end = Math.min(chat.length - 1, range.end);
        for (let index = start; index <= end; index++) {
            indices.add(index);
        }
    }

    if (indices.size === 0) return;

    for (const index of indices) {
        const message = chat[index];
        if (!message || message.is_system === true) continue;

        const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
        temporaryMarks.push({
            index,
            message,
            originalIsSystem: false,
            node: node instanceof HTMLElement ? node : null,
        });
        message.is_system = true;
    }

    if (temporaryMarks.length > 0) {
        lastTrimmedCount = temporaryMarks.length;
        console.debug('[auto-hide-floors] 本次生成临时排除', lastTrimmedCount, '层');
        armTemporaryRestoreTimer();
    }
}

function restoreTemporaryHiding() {
    if (temporaryRestoreTimer !== null) {
        clearTimeout(temporaryRestoreTimer);
        temporaryRestoreTimer = null;
    }
    if (temporaryMarks.length === 0) return;

    const marks = temporaryMarks;
    temporaryMarks = [];

    for (const mark of marks) {
        if (mark.message && mark.message.is_system === true) {
            mark.message.is_system = mark.originalIsSystem;
        }

        // 正常情况下 DOM 从未被改动；只有生成期间发生重渲染时才需要纠正属性
        const node = mark.node?.isConnected
            ? mark.node
            : document.querySelector(`#chat .mes[mesid="${mark.index}"]`);
        if (node instanceof HTMLElement) {
            node.setAttribute('is_system', String(mark.originalIsSystem));
        }
    }
}

/* --------------------------------------------------------------------------
 * 永久隐藏：直接写 is_system（等价于 /hide、/unhide），会保存进聊天记录
 * -------------------------------------------------------------------------- */

function countPluginMarkedHidden(chat = getContext().chat) {
    if (!Array.isArray(chat)) return 0;
    return chat.reduce((count, message) => count + (isPluginMarkedHidden(message) ? 1 : 0), 0);
}

function getPersistentDesiredSet(chat) {
    const desired = new Set();
    if (!settings.enabled || !settings.trimContext) return desired;

    const start = computeStartIndex(chat);
    for (let index = 0; index < start && index < chat.length; index++) {
        desired.add(index);
    }
    for (const range of manualRanges) {
        const startIndex = Math.max(0, range.start);
        const endIndex = Math.min(chat.length - 1, range.end);
        for (let index = startIndex; index <= endIndex; index++) {
            desired.add(index);
        }
    }
    return desired;
}

function setMessageHiddenDom(index, hidden) {
    const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (node instanceof HTMLElement) {
        node.setAttribute('is_system', String(hidden));
    }
}

async function applyPersistentVisibility() {
    if (!settings.persistentHide) return 0;
    restoreTemporaryHiding();
    if (persistentApplyPromise) return persistentApplyPromise;

    persistentApplyPromise = (async () => {
        ensureManualRangesForChat();
        const ctx = getContext();
        const chat = ctx.chat;
        if (!Array.isArray(chat) || chat.length === 0) return 0;

        const desired = getPersistentDesiredSet(chat);
        let changed = 0;

        for (let index = 0; index < chat.length; index++) {
            const message = chat[index];
            if (!message) continue;

            const marked = isPluginMarkedHidden(message);
            if (desired.has(index)) {
                if (!message.is_system) {
                    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
                    message.extra.ahf_hidden = true;
                    message.is_system = true;
                    setMessageHiddenDom(index, true);
                    changed++;
                }
                // 已经被用户手动 /hide 的消息不打插件标记，避免以后误 unhide
                continue;
            }

            if (marked) {
                message.is_system = false;
                delete message.extra.ahf_hidden;
                setMessageHiddenDom(index, false);
                changed++;
            }
        }

        if (changed > 0) {
            try {
                await ctx.saveChat?.();
            } catch (error) {
                console.warn('[auto-hide-floors] 保存永久隐藏状态失败：', error);
            }
            try {
                ctx.swipe?.refresh?.();
            } catch {
                // ignore
            }
            update();
        }
        return changed;
    })().finally(() => {
        persistentApplyPromise = null;
    });

    return persistentApplyPromise;
}

async function restorePluginHiddenMessages() {
    if (persistentApplyPromise) {
        try {
            await persistentApplyPromise;
        } catch {
            // ignore
        }
    }
    const ctx = getContext();
    const chat = ctx.chat;
    if (!Array.isArray(chat) || chat.length === 0) return 0;

    let changed = 0;
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (!isPluginMarkedHidden(message)) continue;

        message.is_system = false;
        delete message.extra.ahf_hidden;
        setMessageHiddenDom(index, false);
        changed++;
    }

    if (changed > 0) {
        try {
            await ctx.saveChat?.();
        } catch (error) {
            console.warn('[auto-hide-floors] 恢复永久隐藏状态失败：', error);
        }
        try {
            ctx.swipe?.refresh?.();
        } catch {
            // ignore
        }
        update();
    }
    return changed;
}

let persistentApplyTimer = null;
function schedulePersistentApply(delay = 250) {
    if (!settings.persistentHide) return;
    if (persistentApplyTimer !== null) {
        clearTimeout(persistentApplyTimer);
    }
    persistentApplyTimer = window.setTimeout(() => {
        persistentApplyTimer = null;
        void applyPersistentVisibility();
    }, delay);
}

/* --------------------------------------------------------------------------
 * 界面折叠
 * -------------------------------------------------------------------------- */

function update() {
    const ctx = getContext();
    const chat = ctx.chat;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    // #chat 在极端情况下可能被宿主重建，确保观察器跟到新节点
    observeChat();

    // 切换聊天时退出临时显示模式，并载入该聊天的手动区间
    const chatKey = currentChatKey();
    if (chatKey !== lastChatKey) {
        lastChatKey = chatKey;
        peek = false;
        ensureManualRangesForChat(true);
    } else {
        ensureManualRangesForChat();
    }

    const total = Array.isArray(chat) ? chat.length : 0;
    const autoStart = settings.enabled ? computeStartIndex(chat) : 0;
    const autoHideStart = settings.enabled && settings.foldUi && !peek ? autoStart : 0;
    const manualActive = settings.enabled && !peek;
    const uiHidden = settings.enabled && !peek
        ? countHiddenIndices(autoHideStart, manualActive, total)
        : 0;
    const contextHidden = settings.enabled && settings.trimContext
        ? countHiddenIndices(autoStart, true, total)
        : 0;
    const hiding = settings.enabled && !peek
        && (autoHideStart > 0 || (manualActive && manualRanges.length > 0));

    applyHiddenClasses(chatEl, autoHideStart, manualActive);
    chatEl.classList.toggle('ahf-hiding', hiding);
    updatePanel();
}

function observeChat() {
    const chatEl = document.getElementById('chat');
    if (!chatEl || chatEl === observedChatEl) return;
    chatObserver?.disconnect();
    chatObserver = new MutationObserver(() => scheduleUpdate());
    chatObserver.observe(chatEl, { childList: true });
    observedChatEl = chatEl;
}

/* --------------------------------------------------------------------------
 * 浮动控制面板
 * -------------------------------------------------------------------------- */

function ensurePanel() {
    if (panelEl) return;

    fabEl = document.createElement('button');
    fabEl.type = 'button';
    fabEl.className = 'ahf-fab';
    fabEl.title = '自动隐藏楼层';
    fabEl.innerHTML = '<i class="fa-solid fa-layer-group"></i><span class="ahf-fab-label">楼层</span><span class="ahf-fab-badge"></span>';
    document.body.appendChild(fabEl);
    bindFabEvents();

    panelEl = document.createElement('div');
    panelEl.className = 'ahf-panel';
    panelEl.innerHTML = `
        <div class="ahf-panel-header">
            <span class="ahf-panel-grip fa-solid fa-grip-vertical"></span>
            <span class="ahf-panel-title">自动隐藏楼层</span>
            <button type="button" class="ahf-panel-icon" data-action="refresh" title="刷新">
                <i class="fa-solid fa-rotate"></i>
            </button>
            <button type="button" class="ahf-panel-icon" data-action="close" title="关闭">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="ahf-panel-stats">
            <div class="ahf-stat"><span>全部楼层</span><b data-stat="all">0</b></div>
            <div class="ahf-stat"><span>界面折叠</span><b data-stat="hidden">0</b></div>
            <div class="ahf-stat"><span>AI 排除</span><b data-stat="context">0</b></div>
            <div class="ahf-stat ahf-stat-keep">
                <span>保留最近</span>
                <span class="ahf-keep-control">
                    <input type="number" id="ahf-panel-keep" min="1" max="500" step="1">
                    <span>层</span>
                </span>
            </div>
        </div>
        <div class="ahf-panel-row">
            <input type="number" id="ahf-floor" class="text_pole" min="0" placeholder="楼号">
            <button type="button" class="menu_button" data-action="jump">跳转</button>
        </div>
        <div class="ahf-panel-range">
            <button type="button" class="menu_button" data-action="start">起始</button>
            <button type="button" class="menu_button" data-action="end">截止</button>
            <button type="button" class="menu_button" data-action="hide">隐</button>
            <button type="button" class="menu_button" data-action="show">显</button>
        </div>
        <div class="ahf-panel-hint" data-stat="range">区间：未选择</div>
        <div class="ahf-panel-hint" data-stat="last">上次生成：暂无记录</div>
        <div class="ahf-panel-footer">
            <button type="button" class="menu_button" data-action="peek">显示全部</button>
        </div>
    `;
    document.body.appendChild(panelEl);

    bindPanelEvents();

    try {
        panelOpen = localStorage.getItem(PANEL_OPEN_KEY) === '1';
    } catch {
        panelOpen = false;
    }
    restoreFabPosition();
    setPanelOpen(panelOpen);
    updatePanel();
}

function clampFabToViewport() {
    if (!fabEl || fabEl.style.left === '') return;
    const maxLeft = Math.max(0, window.innerWidth - fabEl.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - fabEl.offsetHeight);
    fabEl.style.left = `${Math.min(Math.max(0, fabEl.offsetLeft), maxLeft)}px`;
    fabEl.style.top = `${Math.min(Math.max(0, fabEl.offsetTop), maxTop)}px`;
}

function restoreFabPosition() {
    if (!fabEl) return;
    try {
        const raw = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
        if (!raw || !Number.isFinite(raw.left) || !Number.isFinite(raw.top)) return;
        fabEl.style.left = `${raw.left}px`;
        fabEl.style.top = `${raw.top}px`;
        fabEl.style.right = 'auto';
        fabEl.style.bottom = 'auto';
        clampFabToViewport();
    } catch {
        // ignore
    }
}

function bindFabEvents() {
    fabEl.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const rect = fabEl.getBoundingClientRect();
        fabDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            rect,
            active: false,
        };
        try {
            fabEl.setPointerCapture(event.pointerId);
        } catch {
            // ignore
        }
        event.preventDefault();
    });

    fabEl.addEventListener('pointermove', event => {
        if (!fabDrag || event.pointerId !== fabDrag.pointerId) return;

        if (!fabDrag.active) {
            if (Math.abs(event.clientX - fabDrag.startX) < 5
                && Math.abs(event.clientY - fabDrag.startY) < 5) {
                return;
            }
            fabDrag.active = true;
            fabEl.classList.add('ahf-dragging');
            fabEl.style.left = `${fabDrag.rect.left}px`;
            fabEl.style.top = `${fabDrag.rect.top}px`;
            fabEl.style.right = 'auto';
            fabEl.style.bottom = 'auto';
        }

        const maxLeft = Math.max(0, window.innerWidth - fabEl.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - fabEl.offsetHeight);
        const left = Math.min(Math.max(0, event.clientX - fabDrag.dx), maxLeft);
        const top = Math.min(Math.max(0, event.clientY - fabDrag.dy), maxTop);
        fabEl.style.left = `${left}px`;
        fabEl.style.top = `${top}px`;
        if (panelOpen) positionPanelNearFab();
    });

    const endDrag = event => {
        if (!fabDrag || event.pointerId !== fabDrag.pointerId) return;
        const wasActive = fabDrag.active;
        fabDrag = null;
        fabEl.classList.remove('ahf-dragging');
        try {
            fabEl.releasePointerCapture(event.pointerId);
        } catch {
            // ignore
        }

        if (wasActive) {
            try {
                localStorage.setItem(FAB_POS_KEY, JSON.stringify({
                    left: fabEl.offsetLeft,
                    top: fabEl.offsetTop,
                }));
            } catch {
                // ignore
            }
        } else {
            togglePanel();
        }
    };

    fabEl.addEventListener('pointerup', endDrag);
    fabEl.addEventListener('pointercancel', () => {
        fabDrag = null;
        fabEl.classList.remove('ahf-dragging');
    });

    // 键盘 Enter/Space 的 click detail 为 0；鼠标点击已在 pointerup 中处理
    fabEl.addEventListener('click', event => {
        if (event.detail === 0) togglePanel();
    });
}

function setPanelOpen(open) {
    panelOpen = Boolean(open);
    panelEl?.classList.toggle('open', panelOpen);
    fabEl?.classList.toggle('active', panelOpen);
    try {
        localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? '1' : '0');
    } catch {
        // ignore
    }
    if (panelOpen) {
        ensureManualRangesForChat();
        positionPanelNearFab();
        updatePanel();
    }
}

function positionPanelNearFab() {
    if (!panelEl || !fabEl) return;

    const fabRect = fabEl.getBoundingClientRect();
    const width = panelEl.offsetWidth;
    const height = panelEl.offsetHeight;
    if (!width || !height) return;

    const gap = 10;
    let left = fabRect.right - width;
    let top = fabRect.top - height - gap;
    if (top < 8) {
        top = fabRect.bottom + gap;
    }

    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));

    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
}

function togglePanel() {
    ensurePanel();
    setPanelOpen(!panelOpen);
}

function openPanel() {
    ensurePanel();
    setPanelOpen(true);
}

function readFloorInput() {
    const raw = panelEl?.querySelector('#ahf-floor')?.value;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
}

function getSelectedRange() {
    let start = rangeStart;
    let end = rangeEnd;

    if (start === null && end === null) {
        const value = readFloorInput();
        if (value === null) return null;
        start = value;
        end = value;
    } else if (start === null) {
        start = end;
    } else if (end === null) {
        end = start;
    }

    return { start: Math.min(start, end), end: Math.max(start, end) };
}

function updatePanel() {
    if (!panelEl) return;
    ensureManualRangesForChat();

    const chat = getContext().chat;
    const total = Array.isArray(chat) ? chat.length : 0;
    const autoStart = settings.enabled ? computeStartIndex(chat) : 0;
    const autoHideStart = settings.enabled && settings.foldUi && !peek ? autoStart : 0;
    const manualActive = settings.enabled && !peek;
    const uiHidden = settings.enabled && !peek
        ? countHiddenIndices(autoHideStart, manualActive, total)
        : 0;
    const contextHidden = settings.enabled && settings.trimContext
        ? countHiddenIndices(autoStart, true, total)
        : 0;

    const setText = (selector, text) => {
        const node = panelEl.querySelector(selector);
        if (node) node.textContent = text;
    };

    setText('[data-stat="all"]', total > 0 ? `0–${total - 1}` : '0');
    setText('[data-stat="hidden"]', String(uiHidden));
    setText('[data-stat="context"]', settings.trimContext ? String(contextHidden) : '关');

    const keepInput = panelEl.querySelector('#ahf-panel-keep');
    if (keepInput && document.activeElement !== keepInput) {
        keepInput.value = String(settings.keep);
    }

    const startButton = panelEl.querySelector('[data-action="start"]');
    const endButton = panelEl.querySelector('[data-action="end"]');
    startButton?.classList.toggle('ahf-active', rangeStart !== null);
    endButton?.classList.toggle('ahf-active', rangeEnd !== null);

    let rangeText = '区间：未选择';
    if (rangeStart !== null && rangeEnd !== null) {
        rangeText = `区间：${Math.min(rangeStart, rangeEnd)}–${Math.max(rangeStart, rangeEnd)}`;
    } else if (rangeStart !== null) {
        rangeText = `起点：${rangeStart}`;
    } else if (rangeEnd !== null) {
        rangeText = `终点：${rangeEnd}`;
    }
    setText('[data-stat="range"]', rangeText);

    const lastHint = panelEl.querySelector('[data-stat="last"]');
    if (lastHint) {
        // 永久模式下不显示“已写入聊天”的提示，避免面板冗余
        lastHint.style.display = settings.persistentHide ? 'none' : '';
        if (!settings.persistentHide) {
            lastHint.textContent = lastTrimmedCount > 0
                ? `上次生成排除 ${lastTrimmedCount} 层`
                : '上次生成：暂无记录';
        }
    }

    const peekButton = panelEl.querySelector('[data-action="peek"]');
    if (peekButton) {
        peekButton.textContent = peek ? '恢复折叠' : '显示全部';
    }

    const floorInput = panelEl.querySelector('#ahf-floor');
    if (floorInput) {
        floorInput.max = total > 0 ? String(total - 1) : '0';
    }

    const badge = fabEl?.querySelector('.ahf-fab-badge');
    if (badge) {
        const count = Math.max(uiHidden, contextHidden);
        badge.textContent = count > 0 ? String(count) : '';
        badge.style.display = count > 0 ? '' : 'none';
    }
    if (fabEl) {
        fabEl.title = `自动隐藏楼层：界面隐藏 ${uiHidden} 层，AI 排除 ${contextHidden} 层`;
    }
}

function jumpToFloor(index) {
    const chat = getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const target = Math.min(chat.length - 1, Math.max(0, index));
    const autoStart = settings.enabled ? computeStartIndex(chat) : 0;
    const hidden = !peek && (
        isManuallyHidden(target)
        || (settings.foldUi && target < autoStart)
    );

    if (hidden) {
        peek = true;
        update();
    }

    const node = document.querySelector(`#chat .mes[mesid="${target}"]`);
    if (!(node instanceof HTMLElement)) {
        console.warn('[auto-hide-floors] 目标楼层尚未渲染：', target);
        return;
    }

    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add(FLASH_CLASS);
    window.setTimeout(() => node.classList.remove(FLASH_CLASS), 1400);
}

function bindPanelEvents() {
    panelEl.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const actionNode = event.target.closest('[data-action]');
        if (!actionNode) return;
        const action = actionNode.getAttribute('data-action');

        if (action === 'jump') {
            const value = readFloorInput();
            if (value !== null) jumpToFloor(value);
            return;
        }

        if (action === 'start' || action === 'end') {
            const value = readFloorInput();
            if (value === null) return;
            if (action === 'start') rangeStart = value;
            else rangeEnd = value;
            updatePanel();
            return;
        }

        if (action === 'hide' || action === 'show') {
            const range = getSelectedRange();
            if (!range) {
                if (action === 'show') {
                    manualRanges = [];
                    saveManualRanges();
                    update();
                }
                return;
            }
            if (action === 'hide') addManualRange(range);
            else removeManualRange(range);
            return;
        }

        if (action === 'peek') {
            const wasPeeking = peek;
            peek = !peek;
            update();
            if (wasPeeking && !peek) {
                try {
                    getContext().scrollChatToBottom?.({ waitForFrame: true });
                } catch {
                    // ignore
                }
            }
            return;
        }

        if (action === 'refresh') {
            ensureManualRangesForChat(true);
            update();
            return;
        }

        if (action === 'close') {
            setPanelOpen(false);
        }
    });

    const keepInput = panelEl.querySelector('#ahf-panel-keep');
    keepInput?.addEventListener('change', () => {
        settings.keep = clampInteger(keepInput.value, 1, 500, settings.keep);
        keepInput.value = String(settings.keep);
        peek = false;
        persistSettings();
        syncSettingsUi();
        update();
        if (settings.persistentHide) void applyPersistentVisibility();
    });
    keepInput?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            keepInput.blur();
        }
    });

    const header = panelEl.querySelector('.ahf-panel-header');
    if (!(header instanceof HTMLElement)) return;

    header.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button')) return;

        const fabRect = fabEl.getBoundingClientRect();
        panelDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            fabLeft: fabRect.left,
            fabTop: fabRect.top,
        };

        try {
            header.setPointerCapture(event.pointerId);
        } catch {
            // ignore
        }
        event.preventDefault();
    });

    header.addEventListener('pointermove', event => {
        if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;

        const maxLeft = Math.max(0, window.innerWidth - fabEl.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - fabEl.offsetHeight);
        const left = Math.min(Math.max(0, panelDrag.fabLeft + event.clientX - panelDrag.startX), maxLeft);
        const top = Math.min(Math.max(0, panelDrag.fabTop + event.clientY - panelDrag.startY), maxTop);

        fabEl.style.left = `${left}px`;
        fabEl.style.top = `${top}px`;
        fabEl.style.right = 'auto';
        fabEl.style.bottom = 'auto';
        positionPanelNearFab();
    });

    const endDrag = event => {
        if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
        panelDrag = null;
        try {
            header.releasePointerCapture(event.pointerId);
        } catch {
            // ignore
        }
        try {
            localStorage.setItem(FAB_POS_KEY, JSON.stringify({
                left: fabEl.offsetLeft,
                top: fabEl.offsetTop,
            }));
        } catch {
            // ignore
        }
    };

    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
        clampFabToViewport();
        if (panelOpen) positionPanelNearFab();
    });
}


/* --------------------------------------------------------------------------
 * 事件绑定
 * -------------------------------------------------------------------------- */

function bindChatEvents() {
    const ctx = getContext();
    const on = (name, handler) => {
        const eventType = ctx.eventTypes?.[name];
        if (eventType) ctx.eventSource.on(eventType, handler);
    };
    const onLast = (name, handler) => {
        const eventType = ctx.eventTypes?.[name];
        if (!eventType) return;
        if (typeof ctx.eventSource.makeLast === 'function') {
            ctx.eventSource.makeLast(eventType, handler);
        } else {
            ctx.eventSource.on(eventType, handler);
        }
    };
    const onFirst = (name, handler) => {
        const eventType = ctx.eventTypes?.[name];
        if (!eventType) return;
        if (typeof ctx.eventSource.makeFirst === 'function') {
            ctx.eventSource.makeFirst(eventType, handler);
        } else {
            ctx.eventSource.on(eventType, handler);
        }
    };

    for (const eventName of EVENTS_TO_WATCH) {
        on(eventName, () => {
            if (eventName === 'CHAT_CHANGED' || eventName === 'CHAT_LOADED') {
                peek = false;
                generationPending = false;
                pendingRegenerate = false;
                restoreTemporaryHiding();
            }
            if (eventName === 'APP_READY') {
                loadSettings();
                syncSettingsUi();
                mountSettings();
            }
            if (eventName === 'MESSAGE_RECEIVED' && settings.persistentHide) {
                schedulePersistentApply();
            }
            scheduleUpdate(eventName === 'APP_READY' ? 0 : 40);
        });
    }

    // 1:1 生成：在 Generate() 进入提示词组装前标记；普通用户消息要等 MESSAGE_SENT（此时已保存）
    onLast('GENERATION_AFTER_COMMANDS', (type, options = {}, dryRun = false) => {
        if (type && !TRIMMABLE_GENERATION_TYPES.has(type)) {
            generationPending = false;
            pendingRegenerate = false;
            return;
        }

        generationPending = true;
        pendingRegenerate = false;

        // regenerate 在提示词组装前会删除末楼并触发 saveChatDebounced；
        // 如果此时已经标记 is_system，防抖保存会把标记写进聊天记录。
        // 因此等到 MESSAGE_DELETED（删除已保存）之后再标记。
        if (type === 'regenerate') {
            const chat = getContext().chat;
            const lastMessage = Array.isArray(chat) && chat.length > 0 ? chat[chat.length - 1] : undefined;
            if (lastMessage && !lastMessage.is_user) {
                pendingRegenerate = true;
                return;
            }
        }

        if (getContext().groupId) {
            // 群聊由 generateGroupWrapper 先 saveChat，再发 GROUP_MEMBER_DRAFTED；
            // 不能在 wrapper 保存前标记，否则 is_system 会被写进聊天记录
            return;
        }

        const textareaText = String(document.getElementById('send_textarea')?.value ?? '').trim();
        const isUserSend = !options?.automatic_trigger
            && !options?.depth
            && !dryRun
            && (
                type === 'normal'
                || (type === 'continue' && textareaText.length > 0)
            );

        if (isUserSend) return;

        applyTemporaryHiding();
    });

    onLast('MESSAGE_SENT', async () => {
        if (settings.persistentHide) {
            await applyPersistentVisibility();
            return;
        }
        if (!generationPending) return;
        if (pendingRegenerate) return;
        if (getContext().groupId) return;
        applyTemporaryHiding();
    });

    onLast('GROUP_MEMBER_DRAFTED', () => {
        if (!generationPending) return;
        if (pendingRegenerate) return;
        applyTemporaryHiding();
    });

    // regenerate 删除末楼后：先把删除保存掉（同时会取消 saveChatDebounced），再标记
    onLast('MESSAGE_DELETED', () => {
        if (!pendingRegenerate) return;
        pendingRegenerate = false;
        return (async () => {
            try {
                await getContext().saveChat?.();
            } catch (error) {
                console.warn('[auto-hide-floors] regenerate 删除保存失败：', error);
            }
            applyTemporaryHiding();
        })();
    });

    onFirst('GENERATE_AFTER_DATA', () => {
        pendingRegenerate = false;
        restoreTemporaryHiding();
        generationPending = false;
    });

    onFirst('GENERATION_STOPPED', () => {
        pendingRegenerate = false;
        restoreTemporaryHiding();
        generationPending = false;
    });

    onFirst('GENERATION_ENDED', () => {
        pendingRegenerate = false;
        restoreTemporaryHiding();
        generationPending = false;
    });

    onFirst('GROUP_WRAPPER_FINISHED', () => {
        pendingRegenerate = false;
        restoreTemporaryHiding();
        generationPending = false;
    });
}

/* --------------------------------------------------------------------------
 * 设置面板
 * -------------------------------------------------------------------------- */

function syncSettingsUi() {
    const root = document.getElementById('ahf-settings');
    if (!root) return;
    const enabled = root.querySelector('#ahf-enabled');
    const keep = root.querySelector('#ahf-keep');
    const countMode = root.querySelector('#ahf-count-mode');
    const foldUi = root.querySelector('#ahf-fold-ui');
    const trimContext = root.querySelector('#ahf-trim-context');
    const persistentHide = root.querySelector('#ahf-persistent-hide');

    if (enabled) enabled.checked = settings.enabled;
    if (keep) keep.value = String(settings.keep);
    if (countMode) countMode.value = settings.countMode;
    if (foldUi) foldUi.checked = settings.foldUi;
    if (trimContext) trimContext.checked = settings.trimContext;
    if (persistentHide) persistentHide.checked = settings.persistentHide;
}

function bindSettingsUi(root) {
    const enabled = root.querySelector('#ahf-enabled');
    const keep = root.querySelector('#ahf-keep');
    const countMode = root.querySelector('#ahf-count-mode');
    const foldUi = root.querySelector('#ahf-fold-ui');
    const trimContext = root.querySelector('#ahf-trim-context');
    const persistentHide = root.querySelector('#ahf-persistent-hide');

    enabled?.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        if (!settings.enabled) {
            peek = false;
            restoreTemporaryHiding();
            if (settings.persistentHide) void restorePluginHiddenMessages();
        } else if (settings.persistentHide) {
            void applyPersistentVisibility();
        }
        persistSettings();
        update();
    });

    keep?.addEventListener('change', () => {
        settings.keep = clampInteger(keep.value, 1, 500, DEFAULTS.keep);
        keep.value = String(settings.keep);
        peek = false;
        persistSettings();
        update();
        if (settings.persistentHide) void applyPersistentVisibility();
    });

    countMode?.addEventListener('change', () => {
        settings.countMode = countMode.value === 'normal' ? 'normal' : 'all';
        persistSettings();
        update();
    });

    foldUi?.addEventListener('change', () => {
        settings.foldUi = foldUi.checked;
        if (!settings.foldUi) peek = false;
        persistSettings();
        update();
    });

    trimContext?.addEventListener('change', () => {
        settings.trimContext = trimContext.checked;
        if (!settings.trimContext) {
            restoreTemporaryHiding();
            if (settings.persistentHide) void restorePluginHiddenMessages();
        } else if (settings.persistentHide) {
            void applyPersistentVisibility();
        }
        persistSettings();
        update();
    });

    persistentHide?.addEventListener('change', () => {
        settings.persistentHide = persistentHide.checked;
        persistSettings();
        if (settings.persistentHide) {
            void applyPersistentVisibility();
        } else {
            void restorePluginHiddenMessages();
        }
        update();
    });

    root.querySelector('#ahf-restore-hidden')?.addEventListener('click', () => {
        if (settings.persistentHide) {
            settings.persistentHide = false;
            syncSettingsUi();
            persistSettings();
        }
        void restorePluginHiddenMessages();
    });

    root.querySelector('#ahf-open-panel')?.addEventListener('click', () => openPanel());

    syncSettingsUi();
}

function mountSettings() {
    if (document.getElementById('ahf-settings')) return Promise.resolve();
    if (mountingSettings) return mountingSettings;

    mountingSettings = (async () => {
        const ctx = getContext();
        const container = document.getElementById('extensions_settings');
        if (!container) {
            console.warn('[auto-hide-floors] 找不到扩展设置容器 #extensions_settings');
            return;
        }

        try {
            const html = await ctx.renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
            if (!html || document.getElementById('ahf-settings')) return;

            const wrapper = document.createElement('div');
            wrapper.innerHTML = html.trim();
            const drawer = wrapper.firstElementChild;
            if (!drawer) return;

            container.appendChild(drawer);
            bindSettingsUi(drawer);
        } catch (error) {
            console.error('[auto-hide-floors] 设置面板加载失败：', error);
        }
    })().finally(() => {
        mountingSettings = null;
    });

    return mountingSettings;
}

/* --------------------------------------------------------------------------
 * 斜杠命令
 * -------------------------------------------------------------------------- */

function registerSlashCommand() {
    const ctx = getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;

    const callback = async (_args, value) => {
        const action = String(value ?? '').trim().toLowerCase();

        if (!action) {
            const hidden = settings.enabled ? computeStartIndex(getContext().chat) : 0;
            const state = settings.enabled ? '已启用' : '已关闭';
            const modes = [
                settings.foldUi ? '界面折叠' : null,
                settings.trimContext ? '上下文排除' : null,
                settings.persistentHide ? '永久 /hide' : '临时标记',
            ].filter(Boolean).join(' + ') || '无';
            const pause = peek ? '，当前正在显示全部' : '';
            let last = '';
            if (settings.persistentHide) {
                const marked = countPluginMarkedHidden(getContext().chat);
                last = marked > 0 ? `；永久隐藏 ${marked} 层` : '';
            } else if (lastTrimmedCount > 0) {
                last = `；上次生成排除 ${lastTrimmedCount} 层`;
            }
            return `自动隐藏楼层：${state}，模式 ${modes}，保留最近 ${settings.keep} 层，已处理 ${hidden} 层${last}${pause}`;
        }

        if (action === 'show' || action === 'all' || action === 'off') {
            peek = true;
            update();
            return settings.trimContext
                ? '已临时显示全部楼层；较早楼层仍不会发送给 AI。'
                : '已临时显示全部楼层。';
        }

        if (action === 'hide' || action === 'on') {
            peek = false;
            update();
            return settings.trimContext
                ? `已恢复折叠，保留最近 ${settings.keep} 层；较早楼层不发送给 AI。`
                : `已恢复折叠，保留最近 ${settings.keep} 层。`;
        }

        if (action === 'toggle') {
            peek = !peek;
            update();
            if (peek) {
                return settings.trimContext
                    ? '已临时显示全部楼层；较早楼层仍不会发送给 AI。'
                    : '已临时显示全部楼层。';
            }
            return `已恢复折叠，保留最近 ${settings.keep} 层。`;
        }

        if (action === 'trim' || action === 'trim-on' || action === 'trim-off') {
            settings.trimContext = action === 'trim' ? !settings.trimContext : action === 'trim-on';
            if (!settings.trimContext) {
                restoreTemporaryHiding();
                if (settings.persistentHide) await restorePluginHiddenMessages();
            } else if (settings.persistentHide) {
                await applyPersistentVisibility();
            }
            persistSettings();
            syncSettingsUi();
            update();
            return settings.trimContext ? '已开启上下文排除。' : '已关闭上下文排除（仍然只折叠界面）。';
        }

        const trimMatch = action.match(/^trim\s+(on|off|true|false|1|0)$/);
        if (trimMatch) {
            settings.trimContext = ['on', 'true', '1'].includes(trimMatch[1]);
            if (!settings.trimContext) {
                restoreTemporaryHiding();
                if (settings.persistentHide) await restorePluginHiddenMessages();
            } else if (settings.persistentHide) {
                await applyPersistentVisibility();
            }
            persistSettings();
            syncSettingsUi();
            update();
            return settings.trimContext ? '已开启上下文排除。' : '已关闭上下文排除（仍然只折叠界面）。';
        }

        const keep = Number.parseInt(action, 10);
        if (Number.isFinite(keep)) {
            settings.keep = clampInteger(keep, 1, 500, settings.keep);
            peek = false;
            persistSettings();
            syncSettingsUi();
            update();
            if (settings.persistentHide) await applyPersistentVisibility();
            return `已设置为保留最近 ${settings.keep} 层。`;
        }

        if (action === 'restore') {
            if (settings.persistentHide) {
                settings.persistentHide = false;
                syncSettingsUi();
                persistSettings();
            }
            const changed = await restorePluginHiddenMessages();
            return changed > 0
                ? `已恢复 ${changed} 层插件永久隐藏的楼层，并切换到临时模式。`
                : '没有找到插件永久隐藏的楼层，已切换到临时模式。';
        }

        return '用法：/ahf [show|hide|toggle|trim on|trim off|restore|数字]';
    };

    const props = {
        name: 'ahf',
        callback,
        helpString: '自动隐藏楼层：显示全部 / 恢复折叠 / 开关上下文排除 / 恢复永久隐藏 / 设置保留层数（1–500）。',
    };

    if (SlashCommandArgument?.fromProps && ARGUMENT_TYPE?.STRING) {
        props.unnamedArgumentList = [
            SlashCommandArgument.fromProps({
                description: 'show、hide、toggle、trim on/off、restore，或要保留的层数',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ];
    }

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps(props));
    } catch (error) {
        console.warn('[auto-hide-floors] 注册 /ahf 命令失败：', error);
    }
}

function boot() {
    try {
        loadSettings();
        observeChat();
        bindChatEvents();
        registerSlashCommand();
        mountSettings();
        ensurePanel();
        scheduleUpdate(0);
        console.debug(
            '[auto-hide-floors] 已加载：保留最近',
            settings.keep,
            '层；界面折叠',
            settings.foldUi,
            '；上下文排除',
            settings.trimContext,
        );
    } catch (error) {
        console.error('[auto-hide-floors] 初始化失败：', error);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
