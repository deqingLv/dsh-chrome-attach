# dsh-chrome-attach

[English](README.md) · 简体中文 · MIT · DeepSeek Harness 插件

把**当前 Chrome 标签页**变成对话里的图片附件——ChatGPT 里「+ → attach 浏览器」的那个动作：截图、进草稿、可继续打字，回车才发送。

插件按能力自动降级，**没有 `dsh-chrome-bridge`、没有 DSH Bridge 扩展也能用**，只是截图质量不同：

| 通道 | 截图内容 | 需要什么 | 备注 |
|---|---|---|---|
| `bridge` | 纯网页（无标签栏/地址栏） | 安装 `dsh-chrome-bridge` + DSH Bridge 扩展 | 体验最好：不抢焦点、不弹授权、支持整页 |
| `cdp` | 纯网页 | Chrome 自带「Remote debugging」开关 | 一次授权，保留登录态和扩展 |
| `window` | 整个 Chrome 窗口（**含**标签栏、地址栏、侧栏） | macOS + 屏幕录制权限 | 不需要扩展；会短暂把 Chrome 切到前台再切回 |

默认按 `bridge → cdp → window` 依次尝试，第一个成功的就用它；返回里带 `source`，窗口截图会在提示里标「窗口截图，含浏览器界面」。

## 安装

### 用 Release 里的 tgz

1. 从 [Releases](https://github.com/deqingLv/dsh-chrome-attach/releases) 下载 `dsh-chrome-attach-<版本>.tgz`；
2. DSH 插件页 → **添加插件** → 粘贴这个 tgz 的绝对路径；
3. **刷新窗口（Cmd+R）或重启 DSH**。新 bundle 不热加载。

### 从源码安装（开发用）

```sh
git clone https://github.com/deqingLv/dsh-chrome-attach.git
```

在插件页添加**目录**的绝对路径（`link:` 安装，改代码重启即生效）：

```
/Users/you/WorkSpace/Github/dsh-chrome-attach
```

## 使用

输入框左下的 **`+`** 展开列表里多一行，紧挨在「添加文件」下面、「添加」组内：

> [Chrome 彩色标志] **附加 Chrome** · attach —— 把当前页面截图放进输入框

点它就会截当前活动标签页（或降级为窗口），图片进当前会话草稿，**不自动发送**，可以继续打字。也可以直接输入 `/attach` 回车。

附件名带页面标题，例如 `DeepSeek-Harness-155812.png`。

整页截图目前只在接口层支持（`POST /api/chrome-attach/shot {"full":true}`），菜单里暂未单列一行。

## 三种通道怎么配

### 1. `bridge`：零权限，体验最好

在 DSH 插件页安装 `dsh-chrome-bridge`，并在 Chrome 里装好 **DSH Bridge** 扩展，点一次连接。插件调用 `cb` 命令（`~/.dsh/bin/cb`）拿到纯网页，不抢焦点。

### 2. `cdp`：Chrome 自带的 Remote debugging 开关

不需要扩展，也不需要屏幕录制。Chrome 136 收紧了 `--remote-debugging-port`，但 Chrome 现在自带一个开关：

1. 打开 `chrome://inspect/#remote-debugging`，勾选 **Remote debugging**；
2. 在 DSH 里点「附加 Chrome」，首次连接会弹一次授权，允许即可；
3. Chrome 把选中的端口写进 `<profile>/DevToolsActivePort`，插件自动读取。登录态、标签页、扩展都不受影响。

已经在用调试端口启动 Chrome 的，插件也会探测 `9222`/`9223`，以及 `DSH_CHROME_DEBUG_PORT` 指定的端口：

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-dsh-debug"
```

### 3. `window`：macOS 窗口截图（零 Chrome 改动）

什么都不用装，只需要给 DSH 授一次屏幕录制权限：

1. 系统设置 → 隐私与安全性 → **屏幕录制** → 勾选 **DeepSeek Harness**；
2. 完全退出并重开 DSH（macOS 对权限变更要求进程重启）；
3. 从 `+` 菜单选「附加 Chrome 页面」。截图是 Chrome 窗口整体，包含标签栏、地址栏和侧栏。

窗口截图会缩到长边 2200px（Retina 下约 1 MB，仍足够看清页面）。窗口被其它窗口挡住时，插件会先把 Chrome 切到前台再抓屏，然后切回 DSH（约 1 秒的焦点切换）；只支持 Google Chrome。

## 工作原理

```
浏览器（client/client.js）
  └─ 点按钮 → POST /api/chrome-attach/shot {full}
        └─ Host（lib/index.js → lib/capture.js）
              ├─ bridge: cb shot active --out … --json
              ├─ cdp:    /json/version → WebSocket → Page.captureScreenshot
              └─ window: Chrome AppleScript 取窗口坐标 → screencapture -R
        ← { dataUrl, title, url, source, degraded }
  └─ dataUrl → File → 合成 drop → DSH 官方图片 intake → 草稿
```

Host 侧只用 Node 内置模块，不 import profile 里可能解析不到的包。客户端只负责 `+` 菜单里的那一行，图片交给和真实拖拽相同的附件入口。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_CHROME_ATTACH_MODE` | `auto` | 固定通道：`bridge` / `cdp` / `window` |
| `DSH_CHROME_DEBUG_PORT` | — | 额外探测的 CDP 端口 |
| `DSH_CHROME_BRIDGE_CB` | — | 显式指定 `cb` 路径 |
| `DSH_OSASCRIPT_BIN` / `DSH_SCREENCAPTURE_BIN` | 系统路径 | 测试用覆盖 |

## 已知限制

- 只截**当前活动标签页**（`bridge`/`cdp`）或**当前 Chrome 窗口**（`window`）。
- `chrome://`、Chrome 应用商店等受保护页面无法通过 `chrome.debugger` 截图；`window` 模式不受此限制。
- `window` 模式需要屏幕录制权限；首次失败会给出系统设置路径。
- 图片走本机回环路由，不上传；最终以 DSH 附件形式落盘。

## 开发

```sh
npm run check
```

单独验证某一通道：

```sh
DSH_CHROME_ATTACH_MODE=window node -e "import('./lib/capture.js').then(m => m.capturePage())"
DSH_CHROME_DEBUG_PORT=9222 node -e "import('./lib/capture.js').then(m => m.capturePage({mode:'cdp'}))"
DSH_CHROME_BRIDGE_CB=/path/to/fake-cb node -e "import('./lib/capture.js').then(m => m.capturePage({mode:'bridge'}))"
```

## License

[MIT](LICENSE)
