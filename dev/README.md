# dev 测试

这组文件只用于本地回归，不会随扩展安装，也不需要放进 TauriTavern 的扩展目录。

## 运行

在插件根目录执行：

```bash
node dev/test-cdp.js
```

脚本会：

1. 用 Python 启动一个本地静态服务器；
2. 启动无头 Edge，并通过 CDP 驱动测试页面；
3. 模拟 25 层聊天，验证“保留最近 N 层”、临时显示、设置变更、系统/旁白跳过、禁用/启用、提示条开关；
4. 验证浮动面板：打开、统计、手动区间隐/显、楼号跳转、手动区间参与上下文排除；
5. 模拟生成事件，验证上下文排除的临时 `is_system` 标记会在 `GENERATE_AFTER_DATA` 后还原，并覆盖普通发送、群聊、quiet、Chat Completion 等时序；
6. 把结果写到 `dev/test-report.json`，并截一张 `dev/screenshot-test.png`。

测试页面 `dev/test-harness.html` 用假的 `SillyTavern.getContext()` 复刻了扩展实际依赖的 DOM 与 API。

## 注意

- 测试需要 `python` 和 Edge（路径写死在 `test-cdp.js` 的 `EDGE` 常量里）。
- 这只是逻辑回归，不等同于在真实 TauriTavern 里加载；真实应用仍需重启/刷新后由扩展管理器加载。
