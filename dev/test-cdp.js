/* CDP 驱动的插件集成测试（无需 Playwright） */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const HTTP_PORT = 8765;
const ROOT = path.resolve(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ahf-edge-'));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return response.json();
}

async function main() {
    const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], {
        cwd: ROOT, stdio: 'ignore', windowsHide: true,
    });
    const edge = spawn(EDGE, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        'about:blank',
    ], { stdio: 'ignore', windowsHide: true });

    try {
        let targets = null;
        for (let i = 0; i < 40; i++) {
            try {
                targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
                if (targets.length) break;
            } catch {}
            await sleep(250);
        }
        if (!targets?.length) throw new Error('Edge CDP 未就绪');

        const page = targets.find(t => t.type === 'page');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });

        let nextId = 0;
        const pending = new Map();
        ws.addEventListener('message', event => {
            const data = JSON.parse(String(event.data));
            if (data.id && pending.has(data.id)) {
                const { resolve, reject } = pending.get(data.id);
                pending.delete(data.id);
                if (data.error) reject(new Error(data.error.message));
                else resolve(data.result);
            }
        });

        function send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method, params }));
            });
        }

        async function evaluate(expression, awaitPromise = true) {
            const result = await send('Runtime.evaluate', {
                expression, awaitPromise, returnByValue: true, userGesture: true,
            });
            if (result.exceptionDetails) {
                throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
            }
            return result.result.value;
        }

        await send('Page.enable');
        await send('Runtime.enable');
        await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/dev/test-harness.html` });
        await sleep(1200);

        const report = await evaluate(`(async () => {
            const wait = ms => new Promise(r => setTimeout(r, ms));
            const chat = window.__test.chat;
            const chatEl = document.getElementById('chat');
            const result = { steps: [] };
            const hidden = () => [...chatEl.querySelectorAll('.mes.ahf-hidden')].map(n => Number(n.getAttribute('mesid')));
            const visible = () => [...chatEl.querySelectorAll('.mes:not(.ahf-hidden)')].map(n => Number(n.getAttribute('mesid')));
            const contextHidden = () => chat.filter(m => m.is_system === true).length;
            const emit = (name, ...args) => window.__test.context.eventSource.emit(name, ...args);
            const snapshot = label => result.steps.push({
                label,
                hidden: hidden(),
                visible: visible(),
                contextHidden: contextHidden(),
                hidingClass: chatEl.classList.contains('ahf-hiding'),
                settings: JSON.parse(JSON.stringify(window.__test.context.extensionSettings.autoHideFloors ?? null)),
            });

            await wait(250);
            snapshot('initial (keep=10 of 25)');

            // 浮动面板：打开、手动区间、跳转
            document.querySelector('.ahf-fab')?.click();
            await wait(80);
            const panel = document.querySelector('.ahf-panel');
            result.panelOpen = !!panel?.classList.contains('open');
            result.panelStats = panel ? {
                all: panel.querySelector('[data-stat="all"]')?.textContent,
                hidden: panel.querySelector('[data-stat="hidden"]')?.textContent,
                context: panel.querySelector('[data-stat="context"]')?.textContent,
                keep: panel.querySelector('#ahf-panel-keep')?.value,
            } : null;
            result.panelOverflow = panel ? {
                scrollWidth: panel.scrollWidth,
                clientWidth: panel.clientWidth,
                scrollHeight: panel.scrollHeight,
                clientHeight: panel.clientHeight,
            } : null;

            const fab = document.querySelector('.ahf-fab');
            if (fab) {
                const rect = fab.getBoundingClientRect();
                const panelBefore = panel?.getBoundingClientRect();
                const pointer = (type, x, y) => new PointerEvent(type, {
                    bubbles: true, pointerId: 99, button: 0, clientX: x, clientY: y,
                });
                fab.dispatchEvent(pointer('pointerdown', rect.left + 20, rect.top + 15));
                fab.dispatchEvent(pointer('pointermove', rect.left - 80, rect.top - 40));
                fab.dispatchEvent(pointer('pointerup', rect.left - 80, rect.top - 40));
                await wait(50);
                const panelAfter = panel?.getBoundingClientRect();
                result.fabDrag = {
                    left: fab.style.left,
                    top: fab.style.top,
                    stored: !!localStorage.getItem('ahf-fab-pos'),
                    panelOpen: panel?.classList.contains('open'),
                    panelDelta: panelBefore && panelAfter ? {
                        x: Math.round(panelAfter.left - panelBefore.left),
                        y: Math.round(panelAfter.top - panelBefore.top),
                    } : null,
                };
                localStorage.removeItem('ahf-fab-pos');
                fab.style.left = '';
                fab.style.top = '';
                fab.style.right = '';
                fab.style.bottom = '';
                window.dispatchEvent(new Event('resize'));
            }

            const panelKeep = panel?.querySelector('#ahf-panel-keep');
            if (panelKeep) {
                panelKeep.value = '5';
                panelKeep.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(80);
                snapshot('panel keep changed to 5');
                panelKeep.value = '10';
                panelKeep.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(80);
                snapshot('panel keep back to 10');
            }

            const floorInput = panel?.querySelector('#ahf-floor');
            if (floorInput && panel) {
                floorInput.value = '15';
                panel.querySelector('[data-action="start"]')?.click();
                floorInput.value = '18';
                panel.querySelector('[data-action="end"]')?.click();
                panel.querySelector('[data-action="hide"]')?.click();
                await wait(80);
                snapshot('manual range hidden 15-18');
                result.manualRangeStored = localStorage.getItem('ahf-ranges:0||test-chat');

                emit('GENERATION_AFTER_COMMANDS', 'normal', { automatic_trigger: true }, false);
                await wait(30);
                snapshot('manual range + context trim');
                emit('GENERATE_AFTER_DATA');
                await wait(30);
                snapshot('manual range restored');

                panel.querySelector('[data-action="show"]')?.click();
                await wait(80);
                snapshot('manual range shown');

                floorInput.value = '0';
                panel.querySelector('[data-action="jump"]')?.click();
                await wait(150);
                snapshot('jump to hidden floor 0 (peek)');
                result.jumpFlash = document.querySelector('.mes[mesid="0"]')?.classList.contains('ahf-flash');

                panel.querySelector('[data-action="peek"]')?.click();
                await wait(80);
                snapshot('after jump restore');
            }

            panel?.querySelector('[data-action="peek"]')?.click();
            await wait(80);
            snapshot('peek on');

            panel?.querySelector('[data-action="peek"]')?.click();
            await wait(80);
            snapshot('peek off');

            const keep = document.getElementById('ahf-keep');
            keep.value = '5';
            keep.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(80);
            snapshot('keep changed to 5');

            chat.push({ name: 'AI', mes: '第 25 层消息', is_user: false, is_system: false, extra: {} });
            const node = document.createElement('div');
            node.className = 'mes';
            node.setAttribute('mesid', '25');
            node.innerHTML = '<div class="mes_text">第 25 层消息</div>';
            chatEl.appendChild(node);
            window.__test.context.eventSource.emit('MESSAGE_RECEIVED');
            await wait(150);
            snapshot('after new message');

            // 上下文排除：自动生成（无用户消息）直接标记，生成数据组装后还原
            emit('GENERATION_AFTER_COMMANDS', 'normal', { automatic_trigger: true }, false);
            await wait(30);
            snapshot('context trim: auto generation');
            emit('GENERATE_AFTER_DATA');
            await wait(30);
            snapshot('context trim: restored after data');

            // 普通用户消息：MESSAGE_SENT 之前不能标记（此时聊天已保存）
            emit('GENERATION_AFTER_COMMANDS', 'normal', { automatic_trigger: false }, false);
            await wait(30);
            snapshot('context trim: normal before MESSAGE_SENT');
            emit('MESSAGE_SENT', 25);
            await wait(30);
            snapshot('context trim: normal after MESSAGE_SENT');
            emit('GENERATE_AFTER_DATA');
            await wait(30);
            snapshot('context trim: normal restored');

            // 群聊：wrapper 先保存，再发 GROUP_MEMBER_DRAFTED；不能提前标记
            window.__test.context.groupId = 'group-1';
            emit('GENERATION_AFTER_COMMANDS', 'normal', { automatic_trigger: false }, false);
            emit('MESSAGE_SENT', 25);
            await wait(30);
            snapshot('context trim: group before drafted');
            emit('GROUP_MEMBER_DRAFTED', 1);
            await wait(30);
            snapshot('context trim: group after drafted');
            emit('GENERATE_AFTER_DATA');
            window.__test.context.groupId = undefined;
            await wait(30);
            snapshot('context trim: group restored');

            // quiet 内部生成不裁剪
            emit('GENERATION_AFTER_COMMANDS', 'quiet', { quiet_prompt: 'summary' }, false);
            await wait(30);
            snapshot('context trim: quiet generation skipped');
            emit('GENERATE_AFTER_DATA');
            await wait(30);

            // Chat Completion 的提示词数组构建后仍保持标记，直到 GENERATE_AFTER_DATA
            emit('GENERATION_AFTER_COMMANDS', 'normal', { automatic_trigger: true }, false);
            await wait(30);
            snapshot('context trim: chat completion before prompt ready');
            emit('CHAT_COMPLETION_PROMPT_READY', { chat: [], dryRun: false });
            await wait(30);
            snapshot('context trim: chat completion after prompt ready');
            emit('GENERATE_AFTER_DATA');
            await wait(30);
            snapshot('context trim: chat completion restored after data');

            // 关闭上下文排除后不再标记
            const trimContext = document.getElementById('ahf-trim-context');
            trimContext.checked = false;
            trimContext.dispatchEvent(new Event('change', { bubbles: true }));
            emit('GENERATION_AFTER_COMMANDS', 'normal', { automatic_trigger: true }, false);
            await wait(30);
            snapshot('context trim: disabled by setting');
            emit('GENERATE_AFTER_DATA');
            trimContext.checked = true;
            trimContext.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(30);
            snapshot('context trim: re-enabled by setting');

            const countMode = document.getElementById('ahf-count-mode');
            countMode.value = 'normal';
            countMode.dispatchEvent(new Event('change', { bubbles: true }));
            // 插入两条系统消息到末尾附近，验证“仅普通对话”的计数
            chat.push({ name: 'System', mes: '系统提示', is_user: false, is_system: true, extra: {} });
            chat.push({ name: '旁白', mes: '旁白', is_user: false, is_system: false, extra: { type: 'narrator' } });
            const sysNode = document.createElement('div');
            sysNode.className = 'mes';
            sysNode.setAttribute('mesid', '26');
            sysNode.innerHTML = '<div class="mes_text">系统提示</div>';
            const narNode = document.createElement('div');
            narNode.className = 'mes';
            narNode.setAttribute('mesid', '27');
            narNode.innerHTML = '<div class="mes_text">旁白</div>';
            chatEl.append(sysNode, narNode);
            window.__test.context.eventSource.emit('MESSAGE_UPDATED');
            await wait(150);
            snapshot('normal count mode with system/narrator at end');

            const enabled = document.getElementById('ahf-enabled');
            enabled.checked = false;
            enabled.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(100);
            snapshot('disabled');

            enabled.checked = true;
            enabled.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(100);
            snapshot('re-enabled');

            const command = window.__test.command;
            result.commandRegistered = !!command;
            if (command) {
                command.callback({}, 'show');
                await wait(100);
                snapshot('/ahf show');

                command.callback({}, 'hide');
                await wait(100);
                snapshot('/ahf hide');

                result.trimToggleOff = command.callback({}, 'trim');
                await wait(30);
                result.trimToggleOn = command.callback({}, 'trim');
                await wait(30);

                result.commandStatus = command.callback({}, '');
            }

            const foldUi = document.getElementById('ahf-fold-ui');
            foldUi.checked = false;
            foldUi.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(100);
            snapshot('fold UI off (context-only)');

            emit('GENERATION_AFTER_COMMANDS', 'normal', { automatic_trigger: true }, false);
            await wait(30);
            snapshot('fold UI off + context trim');
            emit('GENERATE_AFTER_DATA');
            await wait(30);

            foldUi.checked = true;
            foldUi.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(100);
            snapshot('fold UI back on');

            // regenerate：删除末楼 -> 保存 -> 再标记；避免防抖保存把 is_system 写进聊天记录
            emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
            await wait(30);
            snapshot('regenerate before delete');
            chat.pop();
            chatEl.querySelector('.mes[mesid="25"]')?.remove();
            await emit('MESSAGE_DELETED', chat.length);
            await wait(50);
            snapshot('regenerate after delete (saved then marked)');
            emit('GENERATE_AFTER_DATA');
            await wait(30);
            snapshot('regenerate restored');
            result.chatSaveCount = window.__test.saved.chatCount;

            result.bannerRemoved = !document.querySelector('.ahf-banner');
            result.savedCount = window.__test.saved.count;
            result.settingsDrawerExists = !!document.getElementById('ahf-settings');
            result.settingsCheckbox = document.getElementById('ahf-enabled')?.checked;
            return result;
        })()`);

        console.log(JSON.stringify(report, null, 2));

        await send('Page.captureScreenshot', { format: 'png' }).then(result => {
            fs.writeFileSync(path.join(__dirname, 'screenshot-test.png'), Buffer.from(result.data, 'base64'));
        });

        ws.close();
    } finally {
        edge.kill();
        server.kill();
        await sleep(300);
        try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
    }
}

main().catch(error => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
});
