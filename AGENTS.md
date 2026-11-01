# AGENTS.md —— qq-memory

给在这台机器上干活的 agent 看。**先读本文件，再动手。**

## 这是什么

小鲸鱼（QQ bot）的**跨会话记忆外挂**：把群聊/私聊的原话落成可检索的 SQLite，通过 MCP 工具让她在任意会话里翻得到历史。

## 硬约束（违反即返工）

1. **外挂，绝不改 `/root/qq-bridge`** —— 一行都不改。qq-bridge 会独立更新（`scripts/setup-dsh.mjs` 会重写 cordis.patch.yml 的 MCP 区块），本项目只能待在区块外的「手工区」，并只**只读**它的数据文件。
   - 允许读：`/root/qq-bridge/state/social-v2.json`、`/root/.dsh/sessions/**`
   - 允许写：只写 `/root/qq-memory/**`
2. **只读上游数据要防竞态** —— `social-v2.json` 由 bridge 持续改写，读它可能拿到半截 JSON：解析失败当「这轮没数据」，不重试到死、不覆盖游标。
3. **中文检索必须用 bigram** —— SQLite FTS5 的 `unicode61` 把整句当一个 token，`trigram` 对两字词 0 命中（实测）。本项目自切 bigram 存 `tokens` 列，查询同样切。单字查询降级 LIKE。
4. **改完必须真跑一次** —— 「代码看着对」不算。`node bin/qqmem.mjs search 显卡` 出结果才算。
5. **中文用户** —— 面向人的输出用简体中文；代码、命令、路径、报错原文不翻译。
6. **可交接** —— 进度进 `PROGRESS.md`，决定进 `ROADMAP.md §决策`（含否决方案和原因）。

## 常用命令

```bash
# 远端（所有实际运行都在远端）
ssh qq 'cd /root/qq-memory && node bin/qqmem.mjs stats'
ssh qq 'cd /root/qq-memory && node bin/qqmem.mjs backfill'      # 从 dsh 归档回填
ssh qq 'cd /root/qq-memory && node bin/qqmem.mjs collect'       # 从 social-v2.json 增量
ssh qq 'cd /root/qq-memory && node bin/qqmem.mjs search 显卡 --days 7'

# 测试
ssh qq 'cd /root/qq-memory && node --test tests/'
```

Node 用 `/root/.nvm/versions/node/v24.21.0/bin/node`（`node:sqlite` 需要 ≥22）。

## 目录

| 路径 | 是什么 |
|---|---|
| `src/tokenize.mjs` | 中文 bigram 切词（检索的地基，所有查询都过它） |
| `src/db.mjs` | SQLite schema + 写入 + 查询 |
| `src/backfill.mjs` | 扫 dsh session 归档（`session.v4.jsonl.zstd`），抠 `【本次消息快照】` 的 JSON |
| `src/collect.mjs` | 轮询 `social-v2.json` 的 `recentMessages` 增量入库 |
| `src/mcp-server.mjs` | MCP stdio server，暴露 `qq_search_history` / `qq_recent_history` |
| `bin/qqmem.mjs` | CLI 入口 |
| `data/qq-memory.sqlite` | 主库（含 FTS5 虚表） |

## 数据来源（实测过的形状）

1. **social-v2.json**：`conversations.<scope>.recentMessages[]`，每条 `{seq, messageId, sender, userId, text, plain, time}`。**只有最近 60 条**，滚动丢——所以必须勤采集。
2. **dsh session 归档**：`/root/.dsh/sessions/--root-qq-bridge-state-agents--/session-*/session.v4.jsonl.zstd`，每行一个事件。`type == "user/message"` 的文本里，`【本次消息快照】` 之后是 `{"messages":[...],"recent":[...]}` JSON，这两组都带原话。这是历史回填的唯一来源。
   - 群：`session-c31ee33b-2561-4ca2-b84c-047c49343d67`（38.9 MB，2026-09-30 起）
   - 私聊：`session-a0a1f1a1-5c3b-4643-924e-0fb527803307`
   - 映射在 `/root/qq-bridge/state/sessions.json`
3. **sender 字段带控制字符**（雪人侧写入），必须清洗，见 `src/tokenize.mjs` 的 `cleanName`。
