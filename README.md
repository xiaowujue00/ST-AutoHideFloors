# 自动隐藏楼层（Auto Hide Floors）

一个适用于 **TauriTavern / SillyTavern 1.13+** 的第三方扩展：只保留最近 `N` 层消息

![浮动面板](docs/panel.png)

- GitHub：<https://github.com/xiaowujue00/SillyTavern->
- 版本：1.3.0

## 两种模式

两个开关相互独立，可以只开其中一个：

### 1. 上下文排除（省 token）

**设置项：发送给 AI 时只带最近 N 层**

- 在每次生成前，临时把较早的消息标记为 SillyTavern 原生的 `is_system`（即“从提示词中排除”）。
- 提示词/消息数组组装完成后立刻还原，扩展本身不调用保存；正常生成流程不会把 `is_system` 写进聊天记录。
- 对 Chat Completion 和 Text Completion 都有效。
- 只对面向用户的生成类型生效：普通发送、重新生成、swipe、continue、impersonate。
- `quiet` 等扩展内部生成不会裁剪，避免把摘要/标题类任务的历史上下文也截掉。
- `generateRaw()` 这类绕过 `Generate()` 的调用不在覆盖范围内。

### 2. 界面折叠

**设置项：在聊天界面折叠较早楼层**

- 只给较早的 `.mes` 加 CSS 类，从视觉上隐藏。
- 不删除、不改写聊天记录。
- 在浮动面板点 **显示全部** 可以临时展开全部楼层；点 **恢复折叠** 再折叠。
- 即使展开了界面，只要“上下文排除”还开着，较早楼层仍然不会发送给 AI。

## 效果

- 每当聊天新增、删除、切换或加载更多消息时，自动重新计算。
- 默认保留最近 `10` 层，可在设置里改成 `1–500`。
- 右下角「楼层」按钮的角标和浮动面板会显示当前隐藏数 / AI 排除数，不再占用聊天顶部空间。
- 设置面板位于 **扩展 → 自动隐藏楼层**：
  - 启用 / 关闭
  - 最近层数 `N`
  - 计数方式：所有楼层 / 仅普通对话（跳过系统消息、旁白、注释）
  - 发送给 AI 时只带最近 N 层
  - 在聊天界面折叠较早楼层
  - 打开浮动面板
- 斜杠命令：
  - `/ahf`：查看状态
  - `/ahf show` / `/ahf hide` / `/ahf toggle`：展开或折叠界面
  - `/ahf trim on` / `/ahf trim off` / `/ahf trim`：开关或切换上下文排除
  - `/ahf 20`：把保留层数改成 20

## 浮动面板

聊天右下角有一个「楼层」悬浮按钮，点开就是控制面板：

- **全部楼层**：当前聊天的楼层范围，例如 `0–27`
- **隐藏楼层**：界面当前隐藏的楼层数（自动 + 手动区间）
- **AI 排除**：下一次生成计划排除的楼层数
- **保留最近**：直接在这里输入 `N`，改完立即生效
- **楼号 + 跳转**：跳到指定楼层；如果目标被隐藏，会先临时展开
- **起始 / 截止**：用楼号设置一个区间
- **隐 / 显**：隐藏或恢复这个区间；不选区间时点“显”会清空当前聊天的手动区间
- **显示全部 / 恢复折叠**：临时显示全部楼层，或恢复自动折叠
- 拖拽「楼层」悬浮按钮或面板标题栏都会让两者一起移动；位置会记住，面板自动出现在按钮上方或下方
- 右上角可以刷新或关闭面板

手动区间按聊天保存在 `localStorage`，**不写聊天记录**。开启“发送给 AI 时只带最近 N 层”时，手动隐藏的区间在下一次生成也会临时排除；关闭上下文排除时，手动区间只影响界面显示。

## 安装

### 方式一：直接复制文件夹（推荐）

把 `auto-hide-floors` 整个文件夹放到：

```text
%APPDATA%\com.tauritavern.client\data\extensions\third-party\auto-hide-floors
```

Windows 上的完整路径通常是：

```text
C:\Users\<用户名>\AppData\Roaming\com.tauritavern.client\data\extensions\third-party\auto-hide-floors
```

然后重启 TauriTavern，或刷新页面。扩展会自动加载，不需要手动启用。

### 方式二：TauriTavern 扩展管理器从 Git 安装

在扩展管理器里选择从 Git 安装，填写本仓库地址：

```text
https://github.com/xiaowujue00/SillyTavern-.git
```

### 方式三：从压缩包安装

如果当前版本的扩展管理器支持上传 zip，直接选择 `auto-hide-floors.zip` 即可；否则用方式一。

## 卸载

删除 `extensions/third-party/auto-hide-floors` 文件夹，重启应用。

- 不会影响聊天记录。
- 如果卸载时刚好处于“生成中”的极短窗口，理论上可能留下临时 `is_system` 标记；正常结束生成后再卸载即可。扩展本身不会主动保存这些标记。

## 实现说明

上下文排除不是通过改写提示词字符串，而是利用 SillyTavern 的 `coreChat = chat.filter(x => !x.is_system)`：

1. `GENERATION_AFTER_COMMANDS` / `MESSAGE_SENT` / `GROUP_MEMBER_DRAFTED` 时，把 `index < startIndex` 且原本未隐藏的消息临时设为 `is_system = true`。
2. `GENERATE_AFTER_DATA`（Chat Completion 和 Text Completion 的最终 prompt 都已构建）时立刻还原为 `false`。
3. regenerate 会先删除末楼并触发防抖保存，所以这类生成要等 `MESSAGE_DELETED`（删除已保存）之后再临时标记，避免把 `is_system` 写进聊天记录。
4. 另外注册了 `GENERATION_STOPPED` / `GENERATION_ENDED` / 超时兜底，避免异常路径留下标记。

之所以不用 `/hide` 永久标记，是为了不污染聊天文件、不覆盖用户手动隐藏的状态。

## 已知边界

- 群聊、工具调用（tool calls）等复杂场景没有做“工具链配对”特殊处理；如果裁剪点正好落在工具调用链中间，可能出现孤立的 tool 结果。遇到这种情况可以把 `N` 调大，或临时关闭上下文排除。
- 只覆盖 `Generate()` 路径；扩展直接调用 `generateRaw()` / 自行拼 prompt 的请求不受影响。
- 上下文排除依赖 SillyTavern 的 `is_system` 语义；如果某个前端分支改写了 `coreChat` 过滤逻辑，需要相应调整。

## 兼容性

- 依赖公开扩展 API：`SillyTavern.getContext()`、`extensionSettings`、`eventSource`、`renderExtensionTemplateAsync`。
- 不依赖 Tauri 专有接口，标准 SillyTavern 也可以使用。
- 针对 TauriTavern 2.3.0（SillyTavern 1.19 前端）编写；核心逻辑已在同一套 DOM / 事件 / 扩展 API 的模拟环境中验证（见 `dev/`）。
- TauriTavern 2.3.0 会把完整聊天放进 `chat[]`，因此“最后 N 层”按完整历史的绝对 `mesid` 计算，不受 `chat_truncation` 只渲染部分 DOM 的影响。

## 文件结构

```text
auto-hide-floors/
├── manifest.json
├── index.js
├── style.css
├── settings.html
├── README.md
└── dev/            # 本地回归测试，不会随扩展加载
```
