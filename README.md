# qq-bridge-memory

给 qq-bridge 的「大肥魚」补一层跨会话记忆：把群里和私聊里说过的原话存进本地 SQLite，让她能用 `qq_search_history` 翻回去。

**外挂**：代码和数据全在 `/root/qq-memory`。`/root/qq-bridge` 里只碰三处接线（守卫白名单、preset 一条、cordis 一个块），全部由 `apply.py` 幂等维护，上游 merge 后跑一次就补回来。

## 为什么自己写

`dsh-memory` 是事实词典（23 条，全量注入 system prompt），它治「记住结论」，不治「翻出原话」。群聊和私聊是两个独立 dsh session，私聊上下文里根本没有群聊原文，`recentMessages` 也只有 60 条。详见 `DECISIONS.md`。

## 结构

```
src/tokenize.mjs    中文 bigram 分词（unicode61/trigram 对两字词全废，实测见 DECISIONS）
src/db.mjs          schema + 写入 + 检索（node:sqlite + FTS5 external content）+ gaps 台账
src/backfill.mjs    从 dsh session 归档回填历史（两条数据源）
src/collect.mjs     从 social-v2.json 增量采集
src/time.mjs        since/until 解析（本地自然日）/ 时间格式化
src/access.mjs      跨会话访问控制（own / owner / linked / self-only，私聊永不跨会话）
src/relations.mjs   跨群白名单（ownerUsers + links，缺失 = 谁都不通）
src/redact.mjs      输出脱敏（手机/身份证/卡号/邮箱；QQ 号故意不打码）
src/mcp-server.mjs  MCP server（零依赖手写 JSON-RPC）
bin/qqmem.mjs       CLI
config/relations.json 白名单模板（owner 123456789，links 留空）
tests/unit.test.mjs 43 条
apply.py            四处接线的幂等补丁（默认修 / --check / --revert / --dry-run）
systemd/            1 分钟定时采集
```

## 部署（远端 /root/qq-memory）

> 改名进行中：本仓库已改名 qq-bridge-memory，线上运行目录与 systemd 单元仍是旧名 `/root/qq-memory`，改名分两批，第二批随部署一起切。

```bash
cd qq-bridge-memory
rsync -az src bin tests package.json systemd apply.py qq:/root/qq-memory/
ssh qq 'mkdir -p /root/qq-memory/data'
ssh qq '/root/.nvm/versions/node/v24.21.0/bin/node /root/qq-memory/bin/qqmem.mjs backfill'
ssh qq 'python3 /root/qq-memory/apply.py'          # 补三处接线（幂等）
ssh qq 'python3 /root/qq-memory/apply.py --check'  # 全好 exit 0
ssh qq 'systemctl restart dsh-web'                 # 新代码/new preset 要重启才生效
```

`node` 必须用绝对路径 `/root/.nvm/versions/node/v24.21.0/bin/node`：远端走 nvm，`node` 不在 PATH，`npm` 也跑不起来——所以本项目零 npm 依赖。

定时采集：

```bash
scp systemd/qq-memory-collect.* qq:/etc/systemd/system/
ssh qq 'systemctl daemon-reload && systemctl enable --now qq-memory-collect.timer'
```

## CLI

```bash
node bin/qqmem.mjs stats                 # 条数、时间跨度、游标
node bin/qqmem.mjs search 显卡 --limit 5
node bin/qqmem.mjs search 白米饭 --scope group:987654321 --since 3d
node bin/qqmem.mjs recent --scope private:123456789 --until 2026-09-30 --limit 20
node bin/qqmem.mjs backfill              # 全量重扫（去重，幂等）
node bin/qqmem.mjs collect               # 增量一次
```

库默认 `/root/qq-memory/data/messages.db`，可用 `--db` 或 `QQ_MEMORY_DB` 覆盖。

## 跨会话访问控制

三个查询参数都必填、都没有默认值：`scope`（要查哪个会话）、`caller`（调用方当前所在会话）、`as_user`（提问者的 QQ 号）。服务端按这四个模式判：

| 模式 | 触发条件 | 返回什么 | 脱敏 |
|---|---|---|---|
| `own` | `scope === caller` | 该会话全部原话 | 否 |
| `owner` | `as_user` 在 `ownerUsers` 里 | 该群聊全部原话 | 是 |
| `linked` | `caller` 与 `scope` 在 `links` 里互通 | 该群聊全部原话 | 是 |
| `self-only` | 其他情况，且 `as_user` 在该会话有发言 | 只有他自己那几条 + 「另有 N 条其他人的发言，不在本群展开」 | 是 |

先于所有规则的一条：**`scope` 是私聊且 `caller` 不是同一个私聊 → 一律拒绝，owner 也不例外。** 也就是私聊里的原话永远不会出现在群里，包括管理员自己的私聊。

白名单在 `config/relations.json`（可用 `QQ_MEMORY_RELATIONS` 覆盖）：文件不存在 = 谁都不通；读坏了（非法 JSON）服务启动时降级成「谁都不通」并把原因打到 stderr，**绝不放通**。`links` 只接受 `group:A ↔ group:B`，写进 `private:*` 会被跳过并记警告。

`N` 用 `countMatches()` 单独数，不是拿 `hits.length` 反推——后者已经被 `limit` 砍过，会让「另有 N 条」偏小甚至变 0。

## 接线（四处，由 apply.py 维护）

这是唯一的侵入点，也是唯一会在 `git merge` 上游时被覆盖的地方：

| 位置 | 改了什么 |
|---|---|
| `/root/.dsh/profiles/web/cordis.patch.yml` | 手工区（qq-bridge 区块之外）追加 `mcp-qq-memory`，stdio 指向 `src/mcp-server.mjs` |
| `/root/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs` | `SAFE_PREFIXES` 加 `'mcp__qq-memory__'` |
| `/root/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 第 18 条【记忆】（scope/caller/as_user 必填）+ 第 19 条【多群与隐私】 |

守卫那条最容易漏：`qq-tool-restrict.mjs` 的 `ctx.tools.guard()` 是执行期白名单，没进名单的 MCP 工具一律被拒（报「不在 QQ 桥接白名单内」），光在 cordis 里挂上不生效。

`apply.py` 的行为：

- 默认：三处逐个查，缺就补；改完 preset 自动跑 `build-agent-preset-patches.mjs` 重建 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`（漏这步等于白改，她拿到的还是旧文本）
- `--check`：全好 exit 0，否则 exit 1 并列出哪处缺失
- `--revert`：外科式只删自己加的块/行，不整文件覆盖（避免把上游改动一起回滚）
- 幂等压测过：revert → check exit 1 → apply → check exit 0 → 四个文件与压测前快照逐字节一致

## 回滚

```bash
ssh qq 'python3 /root/qq-memory/apply.py --revert && systemctl restart dsh-web'
ssh qq 'systemctl disable --now qq-memory-collect.timer'
ssh qq 'rm -f /etc/systemd/system/qq-memory-collect.{service,timer} && systemctl daemon-reload'
```

数据库留着不影响任何东西，想清就 `rm -rf /root/qq-memory`。

## 已知局限

- 多词 bigram AND 太严（`繁星 显卡` 搜不到两条同时出现），工具描述里已写「搜不到就减到一个词」
- 单字查询切不出 bigram，降级 LIKE（慢但能用）
- **边界仍然是「参数自报 + 服务端物理过滤」，不是身份认证**：dsh 的 `dsh-mcp-client` 会洗掉父进程环境变量（`buildChildEnv` 只留 `scrubbedParentEnv()` + 静态 `config.env`），MCP 子进程拿不到调用方 sessionId，`caller` / `as_user` 只能是模型自己填的。服务端能保证「填了 2001 就只看得到 2001 的发言」（按 `user_id` 物理过滤，模型拿不到别人的行），但挡不住有人话术诱导她伪造 `as_user`。这一层降的是误伤，不是防攻击。要真认证得改 dsh 的 mcp-client。
- 采集间隔 1 分钟，`recentMessages` 窗口 60 条。实测出现过 5 分钟 63 条的高峰，所以 1 分钟是余量不是保证；**漏采会写进 `gaps` 表**（`listGaps`），不是静默丢
- session 归档是 dsh 内部格式，升级可能变；单行解析/写库失败会统计成 `lineErrors` 打出来，不静默吞

## License

MIT
