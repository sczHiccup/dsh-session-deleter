# dsh-session-deleter

一个给 **DeepSeek Harness** 用的会话删除插件：在确认风险之后，彻底删除一个会话。

> 中文 | [English](#english)

---

## 为什么需要它

DeepSeek Harness 的侧栏只能「归档」会话，归档只是把会话从导航里隐藏，会话日志仍然留在磁盘上。
`@deepseek-ai/dsh-session-persistence-jsonl` 的文档明确写着：*没有任何东西会删除会话文件，持久化接口也没有删除 API*。

这个插件补上这一步：确认之后停止仍在运行的工作，并删除该会话自己的日志与投影缓存。

## 功能

- **会话顶部的垃圾桶按钮** —— 位于会话头部的右侧工具区。
- **侧栏会话行 `...` 菜单里的「删除会话」** —— 与内置的「重命名 / 归档 / 固定」同处一个菜单，带危险色与分隔线。
- **风险确认弹窗** —— 说明不可撤销、显示目标会话名、**必须勾选**确认项才能继续；支持 `Esc`、点遮罩、取消关闭，并在关闭后把焦点还给原控件。
- **运行中的会话会额外警告** —— 仍然确认时，先停止该会话正在进行的回合、子代理、后台任务与提醒，然后再删除。
- 成功后显示服务端返回的结果摘要；如果被删的正是当前界面停留的会话，会自动切到新会话。

## 安装

插件是一个本地 bundle，需要一个已安装的 DeepSeek Harness 环境。

```bash
git clone https://github.com/sczHiccup/dsh-session-deleter.git
```

然后让当前的 Harness Agent 把它装进当前 profile：

```text
plugin_manager → action: install_bundle → target: <本仓库目录的绝对路径>
```

安装后 Harness 会按 [`cordis.patch.yml`](cordis.patch.yml) 插入插件行，效果对当前 profile 的每个会话生效，并在重启后保留。若界面没有立刻出现按钮，刷新一次页面即可。

## 使用

1. 打开任意会话，点顶部的垃圾桶图标；或在侧栏把鼠标移到某个会话行上，打开 `...` → 「删除会话」。
2. 弹窗里确认会话名与删除范围，勾选确认项。
3. 点「删除会话」。

高级用户也可以直接在输入框执行（与 UI 共用同一实现）：

```text
/delete-session <sessionId>
```

## 删除范围

会删除：

| 内容 | 路径 |
|---|---|
| 会话日志（含历史格式代） | `<DSH_HOME>/sessions/--<cwd>--/<sessionId>/session[.vN].jsonl[.zstd]` |
| 投影检查点缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` |
| 侧栏导航入口 | 通过 Workspace 归档移出导航 |

不会删除：

- **共享附件**：附件是内容寻址、可能被其他会话引用的对象，因此保留。
- **全文检索索引**：`dsh-session-query-sqlite` 是派生库，会自动清理已消失的来源。

## 安全设计

删除操作只在 Host 侧执行，并且刻意保守：

- **停止运行**走 `workspaceRegistry.archiveSession(id, { stopActivity: true })` —— 和用户自己点「停止并归档」是同一套 provider，而不是自己造一套中断逻辑。
- **目录守卫**：只删除「父目录形如 `--…--` 或 `_no-cwd`、目录名匹配会话 id、目录内只有会话日志 / `session.lock` / 临时文件」的目录；任何不符合的情况都会拒绝并如实报告。
- **非递归删除**：先删允许列表里的文件，再用 `rmdir`（非递归）收尾；目录里若还有别的文件，它会原样保留。
- **不谎报成功**：删除后再读一次持久化状态，仍能读到会话就返回错误并附上原因与残留路径。
- **补写清扫**：会话销毁时会再写一次投影检查点，所以删除后会在 1.2s / 5s / 20s 复查并再次清扫（仅在会话确实不存在时动手）。
- 面向模型的工具不暴露此能力：删除是不可撤销操作，只能由用户在 UI 里确认后触发。

## 兼容性

- 面向 DeepSeek Harness `0.2.2-rc.1` 编写，使用公开服务：`commands`、`sessionPersistence`、`workspaceRegistry`、`storageDomain`，以及客户端 `slots`、`contextMenus`、`sessions`、`remote.commands`。
- 不 import 任何 Harness Client 包；样式只使用 `--dsw-alias-*` 主题令牌（危险按钮的遮罩用了 `color-mix` 混合令牌，随明暗主题变化）。
- 若未来 Harness 改动了日志目录布局，守卫会**拒绝删除**而不是误删。

## 已知限制

- 删除后会在 Workspace 注册表的 `archivedSessionIds` 里留下该会话 id（归档是停止运行和移出导航的官方机制）。这是惰性残留，不影响界面。
- 「运行中」提示取决于会话列表投影里的 `running`；取不到时只是少一条警告，删除逻辑不变。
- 仓库暂无界面截图（作者环境无法截图）。欢迎 PR 补充。

## 卸载

```text
plugin_manager → action: set_plugin → target: include:session-deleter → enabled: false
plugin_manager → action: remove_bundle → target: @local/session-deleter
```

## 开发

仓库根目录就是插件包本身：

```text
package.json         # bundle 清单 + dsh.client 声明
cordis.patch.yml     # Loader 补丁（插入插件行）
index.js             # Host 半：/delete-session 命令与真正的删除逻辑
client.js            # Client 半：按钮、菜单项、确认弹窗
locale/{en,zh}.json  # 插件管理器里显示的标题与说明
icon.svg             # 插件图标
```

没有构建步骤，改完文件让插件行重启即可（Plugin Manager 操作会触发重载）：

```bash
node --check index.js
node --check client.js
```

## 许可证

[MIT](LICENSE)

---

<a id="english"></a>
## English

A session deleter plugin for **DeepSeek Harness**. Archiving a session only hides it from navigation — its log stays on disk, and the shipped persistence backend states that nothing deletes session files. This plugin adds that step behind an explicit risk confirmation.

- **Trash button** in the conversation header (right-hand utilities).
- **"Delete session"** row in the sidebar session `...` menu, beside the built-in rename / archive / pin actions.
- **Confirmation dialog** that requires a checked acknowledgement, shows the target session, and closes on Escape, scrim click, or Cancel.
- **Running sessions warn first**; confirming stops the turn, subagents, background jobs, and reminders through the Workspace archive admission, then deletes.

It removes the session's own JSONL log directory and its persisted projection checkpoint, and hides the session from navigation. Shared content-addressed attachments and the derived full-text index are left alone.

Every destructive step is guarded: it only touches a directory that proves to be the documented per-session layout, deletes files from an allow-list, finishes with a non-recursive `rmdir`, re-reads persistence afterwards and reports leftovers instead of claiming success. A live agent rewrites its projection checkpoint on disposal, so the plugin sweeps it again at 1.2s, 5s, and 20s — only while the session is still gone.

Licensed under [MIT](LICENSE).
