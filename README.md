# 速启 (Suqi Launcher)

Windows 快捷启动器，基于 Tauri 2 + Vite + TypeScript + Rust。

## 功能

- 分组管理（全部 / 自定义分组 / 加密 / 未分组）
- 加密分组密码保护（解锁策略可选：每次打开面板都需输入密码 / 仅重启应用才需输入密码）
- 启动项关键字：添加 / 编辑时可填写搜索关键字（留空则使用名称），卡片上会展示关键字标签
- 搜索（优先按关键字，同时匹配名称 / 拼音首拼 / 全拼 / 模糊匹配，命中字符高亮，支持一键清空）
- 排序（名称 / 添加时间 / 类型，默认名称）；分组标签支持拖拽排序
- 扫描导入：默认扫描桌面，也可选择任意文件夹或系统开始菜单（.lnk / .exe / 文件夹 / 文件）；可选择是否扫描子文件夹（默认不扫描）与是否按所在文件夹名称自动分组（默认开启，分组不存在则新建）；结果中快捷方式默认排前，每条显示所在文件夹名称；结果列表支持全选 / 取消全选 / 按类型快选，支持卡片 / 列表两种布局（默认卡片），窗口可最大化、可拖拽调整大小
- 图标缓存
- 右键添加 / 编辑 / 删除；点击条目上的 ✎ 按钮可直接就地修改名称（Enter 保存 / Esc 取消）
- 条目「⋯」菜单支持编辑 / 打开 / 移动到分组 / 删除
- 多选模式：工具栏「多选」进入后，点击卡片勾选，支持全选 / 反选 / 清空，可批量删除或批量移动到其他分组（未分组 / 自定义分组）
- 删除分组时可选择处理方式：仅删除分组（组内项目转为未分组）或同时删除组内全部项目
- 全局快捷键呼出 / 隐藏（默认 `Win + \``）
- 单实例运行（重复启动时提示"速启已在运行"，不再开启第二个进程）
- 系统托盘图标
- 钉住面板（置顶，按钮与托盘菜单实时同步）
- 最大化 / 还原面板（头部按钮，展示更多搜索结果，与原生标题栏最大化状态实时同步）
- 开机自启 / 静默启动
- 记住窗口大小
- 全局显示方式切换（卡片 / 列表，默认卡片；卡片为紧凑布局）
- 外观设置（主题 / 字号 / 高亮色（可跟随主题）/ 窗口效果 / 面板背景图）
  - 面板背景支持拉伸 / 平铺、宽高百分比、旋转 0/90/180/270°、框选区域裁剪、透明度，并可应用到设置窗口
- 数据存储于 SQLite，旧版 JSON 数据自动迁移
- 自定义配置文件目录（默认软件同目录，目标目录已有配置文件时直接使用）
- 自定义数据库文件目录（默认软件同目录）
- 自动更新（启动自动检查 + 面板横幅提示；注册表探测安装方式：便携版就地替换重启 / 可下载到其他目录，安装版下载 NSIS 安装包）
- 更新文件 SHA-256 校验（Release 的 sha256sums.txt）
- 便携版更新辅助进程：退出后替换 exe 并自动重启（%TEMP% 副本执行）
- Windows 代码签名（GitHub Actions 注入）
- 数据库信息查看

## 技术栈

- **前端**: Vite + TypeScript
- **后端**: Rust (Tauri 2)
- **插件**: global-shortcut, autostart, process, fs, dialog, opener, updater, single-instance
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
