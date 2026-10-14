# 速启 (Suqi Launcher)

Windows 快捷启动器，基于 Tauri 2 + Vite + TypeScript + Rust。

## 功能

- 分组管理（全部 / 自定义分组 / 加密 / 未分组）
- 加密分组密码保护
- 搜索（支持拼音首拼 / 全拼 / 模糊匹配）
- 拖拽排序
- 桌面扫描批量导入（.lnk / .exe / 文件夹 / 文件）
- 图标缓存
- 右键添加 / 编辑 / 删除
- 全局快捷键呼出 / 隐藏（默认 `Win + \``）
- 系统托盘图标
- 钉住面板（置顶）
- 开机自启 / 静默启动
- 记住窗口大小
- 外观设置（主题 / 字号 / 高亮色 / 窗口效果）
- 数据库导入 / 导出 / 信息查看

## 技术栈

- **前端**: Vite + TypeScript
- **后端**: Rust (Tauri 2)
- **插件**: global-shortcut, autostart, process, fs, dialog, opener
- **存储**: JSON 文件（`%APPDATA%/suqi/`）

## 开发

```bash
bun install
bun run tauri dev
```

## 构建

```bash
bun run tauri build
```

## 发布

打 `v*` 标签推送即可触发 GitHub Actions 自动构建 Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```
