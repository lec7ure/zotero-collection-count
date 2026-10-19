# zotero-collection-count

一个极简的 Zotero 插件：**在左侧分类树（文件夹）名称旁显示条目数量**，仅此一个功能。
没有设置项、没有工具栏按钮、不改动任何数据库内容。

A minimal Zotero add-on that shows the item count next to each collection (folder)
in the left collection tree. Nothing more.

## 功能

| 情况 | 显示 |
| --- | --- |
| 普通分类（无子分类） | 条目数，如 `12` |
| 有子分类的分类（自身也有条目） | `12 15`：半透明 = 本分类直接条目数，加粗 = 含所有子分类的总数 |
| 纯父分类（自身无条目，文献全在子分类） | 只显示总数，如 `228` |
| 空分类 | `0` |
| 文库、群组库、回收站等非分类行 | 不显示 |

- 条目增删、移动、进出回收站后自动刷新（400ms 去抖）
- 悬停数字有提示（本分类直接条目数 / 含子分类总数）
- 卸载时恢复被修改的渲染函数，不在 Zotero 中留下痕迹

## 适用版本

- **Zotero 10.0 – 11.***（manifest：`strict_min_version: "10.0"` / `strict_max_version: "11.*"`）
- 在 **Zotero 10.0.6（Windows 64-bit）** 上开发并验证通过
- 不支持 Zotero 7/8/9（分类树渲染结构不同）
- 插件通过修补 Zotero 内部实现（CollectionTree 的 React 行渲染与虚拟列表
  `renderItem`）工作；Zotero 小版本更新一般无影响，**大版本升级可能导致补丁失效**

## 安装

1. 下载 `zotero-collection-count.xpi`
2. Zotero 菜单栏：**工具 → 插件 → 齿轮按钮 ⚙️ → 从文件安装插件（Install Add-on From File...）**
3. 选择该 xpi，确认安装并重启 Zotero

## 免责声明

**本项目是个人自用插件，仅供个人学习与研究使用，不保证稳定性，不保证持续更新，
不提供任何技术支持。使用本插件造成的任何问题或损失由使用者自行承担。**

This is a personal, self-use add-on for learning purposes only. It comes with
**no guarantee of stability, updates, or support**. Use at your own risk.

## AI 声明

本项目（含全部代码、测试、打包脚本与文档）**完全由 AI 完成，未经人工审查与维护**：

- AI 助手：WorkBuddy AI（底层模型：step-5-preview）
- 完成日期：2026-10-19

This project (all code, tests, packaging scripts, and documentation) was
**generated entirely by AI, without human review**:

- AI assistant: WorkBuddy AI (model: step-5-preview)
- Date: 2026-10-19

## 开发说明

- `bootstrap.js` — 全部逻辑（打补丁、计数、缓存、通知刷新、卸载还原）
- `manifest.json` — Zotero 7+ manifest 引导格式
- `test_bootstrap.js` — Node 冒烟测试（mock Zotero/DOM，17 项断言）：`node test_bootstrap.js`
- `build_xpi.py` — 重新打包 xpi：`python build_xpi.py`
- `make_icons.py` — 生成图标

### 实现要点

- 计数：`Zotero.Collection.getChildItems()`（直接条目，排除回收站）+
  `getChildCollections()` 递归求总数；数据未加载时 `loadDataType()` 兜底，
  再失败用 `Zotero.Search`（`collectionID` 条件）兜底
- 注入：同时修补 `ZoteroPane.collectionsView.renderItem`（React 重渲染时生效）和
  `ZoteroPane.collectionsView.tree._jsWindow.renderItem`（虚拟列表重画时立即生效）
- 变更刷新：`Zotero.Notifier` 监听 collection / collection-item / item / trash 事件，
  防抖 400ms 后清缓存并重画
