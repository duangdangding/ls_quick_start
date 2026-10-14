# 速启 (Suqi Launcher)

Windows 快捷启动器，基于 Tauri 2 + Vite + TypeScript + Rust。

## 功能

- 分组管理（全部 / 自定义分组 / 加密 / 未分组）
- 加密分组密码保护
- 搜索（支持拼音首拼 / 全拼 / 模糊匹配，命中字符高亮）
- 拖拽排序
- 桌面扫描批量导入（.lnk / .exe / 文件夹 / 文件）
- 图标缓存
- 右键添加 / 编辑 / 删除
- 全局快捷键呼出 / 隐藏（默认 `Win + \``）
- 系统托盘图标
- 钉住面板（置顶，按钮与托盘菜单实时同步）
- 开机自启 / 静默启动
- 记住窗口大小
- 全局显示方式切换（卡片 / 列表，默认卡片）
- 外观设置（主题 / 字号 / 高亮色（可跟随主题）/ 窗口效果 / 面板背景图）
  - 面板背景支持拉伸 / 平铺、宽高百分比、旋转 0/90/180/270°、框选区域裁剪、透明度，并可应用到设置窗口
- 数据存储于 SQLite，旧版 JSON 数据自动迁移
- 自定义配置文件目录（默认软件同目录，目标目录已有配置文件时直接使用）
- 自定义数据库文件目录（默认软件同目录）
- 自动更新（便携版自替换 / 安装版下载安装包）
- 更新文件 SHA-256 校验
- Windows 代码签名（GitHub Actions 注入）
- 数据库信息查看

## 技术栈

- **前端**: Vite + TypeScript
- **后端**: Rust (Tauri 2)
- **插件**: global-shortcut, autostart, process, fs, dialog, opener, updater
- **存储**: SQLite（`suqi.db`，默认在软件同目录）

## 开发

```bash
bun install
bun run tauri dev
```

## 构建

```bash
bun run build        # tsc + vite
cargo check          # Rust 检查（src-tauri/ 下）
bun run tauri build  # 打包
```

## 发布

打 `v*` 标签推送即可触发 GitHub Actions 自动构建 Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

产物：NSIS 安装包 + 便携版 exe + SHA-256 校验文件 + latest.json（updater）。

### 代码签名

GitHub 仓库需配置以下 secrets：
- `WINDOWS_CERT_PFX`：base64 编码的代码签名证书（.pfx）
- `WINDOWS_CERT_PASSWORD`：证书密码
- `TAURI_SIGNING_PRIVATE_KEY`：Tauri updater 签名私钥
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码

生成 updater 密钥对：`npx @tauri-apps/cli signer generate -w ~/.tauri/suqi.key`。
