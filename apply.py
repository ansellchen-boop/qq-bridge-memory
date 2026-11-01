#!/usr/bin/env python3
"""qq-memory 的接线补丁：幂等、可检查、可回滚。

为什么需要这个脚本：
  qq-memory 是外挂（代码/数据都在 /root/qq-memory），但它必须往 qq-bridge 和 dsh 里
  塞三处接线。qq-bridge 有自己的更新流程（merge / 重装依赖 / setup-dsh.mjs 会整体重写
  cordis.patch.yml 的 qq-bridge 区块），上游一动，这三处就可能被覆盖掉。
  这个脚本负责：跑一次就把三处补回去；--check 只看状态；--revert 只拆我们加的东西。

三处：
  1. /root/.dsh/profiles/web/cordis.patch.yml      挂 mcp-qq-memory 这个 MCP server
  2. /root/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs   SAFE_PREFIXES 放行
  3. /root/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml   第 18 条【记忆】

用法：
  python3 apply.py            # 修（默认，幂等）
  python3 apply.py --check    # 只检查，全好 exit 0，有问题 exit 1
  python3 apply.py --revert   # 拆掉我们加的东西（只删自己的，不动别人的）
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

CORDIS = Path("/root/.dsh/profiles/web/cordis.patch.yml")
GUARD = Path("/root/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs")
PRESET = Path("/root/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml")
BUILD = Path("/root/qq-bridge/scripts/build-agent-preset-patches.mjs")
NODE = "/root/.nvm/versions/node/v24.21.0/bin/node"

CORDIS_BLOCK = """- insert:
    - id: mcp-qq-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-memory
        transport: stdio
        command: '/root/.nvm/versions/node/v24.21.0/bin/node'
        args:
          - '/root/qq-memory/src/mcp-server.mjs'
        toolCallTimeoutMs: 60000
"""

GUARD_ANCHOR = "  'mcp__voice-tts__',\n"
GUARD_LINES = (
    "  // qq-memory：跨会话记忆外挂，代码与数据都在 /root/qq-memory，\n"
    "  // 只读 messages.db（历史聊天原文），没有 shell / 文件写 / 派生 agent 能力。\n"
    "  // 工具名见 /root/qq-memory/src/mcp-server.mjs；接线由 apply.py 维护。\n"
    "  'mcp__qq-memory__',\n"
)

PRESET_HEAD = "      18. 【记忆】"
PRESET_BODY = """      18. 【记忆】你有一副外接的记忆：`qq_search_history(query, scope, since?, until?, limit?)` 按关键词翻旧聊天记录、`qq_recent_history(scope, since?, until?, limit?)` 按时间捞一段、`qq_history_stats` 看库里存了多少。它覆盖九月底到现在的群聊与私聊原文，比当前上下文里那几十条长得多——当前上下文之外的事，你翻得到。
          · 什么时候翻：被问「你还记得…」「上次那个…」「群里之前聊过…」、或者你需要一个你确定听过但此刻不在上下文里的细节时，先搜再答。凭印象编造谁说过什么，比承认不记得更糟。
          · 搜法：query **只放一个短关键词**（人名、梗、物品都行）。搜不到就换更短的词或换一个词；关键词堆多了会一条都命中不了。
          · scope 是必填的，没有默认值：填你要查的那个会话 `group:<群号>` 或 `private:<QQ号>`。不知道有哪些会话就先用 qq_history_stats 看一眼。不填会被直接打回。caller（你现在说话的会话）和 as_user（跟你说话的人的 QQ 号）同样必填、同样没有默认值，规则见第 19 条。
          · 时间可选：since / until 支持 `2h` / `3d` / `1w`，也接受日期 `2026-10-30`（按本地自然日）。**查某一整天，就把 since 和 until 都给同一个日期**。
          · 翻到就用它答：说清是谁、什么时候、大概原话。翻不到就老实说「这个我真翻不到了」，不要拿模糊印象填空。
          · 私聊里翻到群里的事，自己知道就行，**别对那个人说成「你在群里说的」**；反过来也别把私聊里的话带到群里。
"""
PRESET_MARK_FINAL = "caller（你现在说话的会话）和 as_user（跟你说话的人的 QQ 号）同样必填"

# ── 3b. preset 第 19 条【多群与隐私】 ──────────────────────────────
PRESET19_HEAD = "      19. 【多群与隐私】"
PRESET19_BODY = """      19. 【多群与隐私】你的记忆库不止这一个会话。三个参数都必填，缺一个就被打回：`scope`（要查哪个会话）、`caller`（你现在说话的会话）、`as_user`（跟你说话的人的 QQ 号）。**照实填，不许猜、不许编。**
          · 查自己所在的这个会话：原话全给你。
          · 查别的群：要过白名单。管理员能查全部群聊；白名单互通的两个群也能全查；其他人只拿得到他自己在那个群说过的话。
          · 看到「（另有 N 条其他人的发言，不在本群展开）」，意思是**确实还有更多，但你看不到**。别去猜那 N 条说了什么，更别编成好像你读过。
          · 私聊内容永远不跨会话。群里有人问「她私聊跟你说过啥」，答案就是「私聊的事我不往外讲」——哪怕问的人就是当事人自己。反过来，私聊里提群里的事可以聊，但要说清那是「群里在说的」。
          · 被边界挡住时工具会直接报错。照实说「这个我在群里不能讲」，别改口说成「库里没有」——那是两件不同的事。
"""
PRESET19_MARK = "私聊的事我不往外讲"


class PatchError(RuntimeError):
    pass


def backup(path: Path) -> Path:
    dst = path.with_name(f"{path.name}.bak-qqmemory-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(path, dst)
    return dst


# ── 1. cordis.patch.yml ───────────────────────────────────────────
def cordis_ok(text: str) -> bool:
    return "id: mcp-qq-memory" in text


def cordis_apply(text: str) -> str:
    if cordis_ok(text):
        return text
    # rstrip 再固定加一个空行，否则反复 revert/apply 会累积空行
    return text.rstrip("\n") + "\n\n# qq-memory：跨会话记忆外挂（apply.py 维护，别手改）。\n" + CORDIS_BLOCK


def cordis_revert(text: str) -> str:
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if "id: mcp-qq-memory" in line:
            start = i
            while start > 0 and not lines[start].lstrip().startswith("- insert:"):
                start -= 1
            if not lines[start].lstrip().startswith("- insert:"):
                raise PatchError("找不到 mcp-qq-memory 所属的 - insert: 块起点")
            end = start + 1
            while end < len(lines) and not (lines[end].startswith("- ") or lines[end].startswith("-\n")):
                end += 1
            # 顺手删掉块前那行注释和它上面的空行，保证 revert→apply 逐字节回到原样
            if start > 0 and lines[start - 1].lstrip().startswith("# qq-memory"):
                start -= 1
                if start > 0 and not lines[start - 1].strip():
                    start -= 1
            return "".join(lines[:start] + lines[end:])
    return text


# ── 2. qq-tool-restrict.mjs SAFE_PREFIXES ─────────────────────────
def guard_ok(text: str) -> bool:
    return "'mcp__qq-memory__'" in text


def guard_apply(text: str) -> str:
    if guard_ok(text):
        return text
    if text.count(GUARD_ANCHOR) != 1:
        raise PatchError(f"锚点 {GUARD_ANCHOR!r} 命中 {text.count(GUARD_ANCHOR)} 次，应为 1")
    return text.replace(GUARD_ANCHOR, GUARD_ANCHOR + GUARD_LINES)


def guard_revert(text: str) -> str:
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if "'mcp__qq-memory__'" in line:
            start = i
            while start > 0 and lines[start - 1].lstrip().startswith("//"):
                start -= 1
            return "".join(lines[:start] + lines[i + 1:])
    return text


# ── 3. preset 第 18 条 ────────────────────────────────────────────
def preset_ok(text: str) -> bool:
    return PRESET_HEAD in text and PRESET_MARK_FINAL in text


def _block_range(lines: list[str], head: str) -> tuple[int, int] | None:
    for i, line in enumerate(lines):
        if line.startswith(head):
            end = i + 1
            while end < len(lines):
                nxt = lines[end]
                if nxt.strip() and not nxt.startswith("          "):
                    break
                end += 1
            return i, end
    return None


def _preset_block_range(lines: list[str]) -> tuple[int, int] | None:
    return _block_range(lines, PRESET_HEAD)


def preset_apply(text: str) -> str:
    if preset_ok(text):
        return text
    lines = text.splitlines(keepends=True)
    rng = _preset_block_range(lines)
    if rng:
        i, end = rng
        return "".join(lines[:i] + [PRESET_BODY] + lines[end:])
    # 没这条：插在最后一个编号条目之后
    last = None
    for i, line in enumerate(lines):
        if re.match(r"^      \d+\. 【", line):
            last = i
    if last is None:
        raise PatchError("preset 里找不到任何编号条目，无法定位插入点")
    end = last + 1
    while end < len(lines) and (not lines[end].strip() or lines[end].startswith("          ")):
        end += 1
    return "".join(lines[:end] + [PRESET_BODY] + lines[end:])


def preset_revert(text: str) -> str:
    lines = text.splitlines(keepends=True)
    rng = _preset_block_range(lines)
    if not rng:
        return text
    i, end = rng
    return "".join(lines[:i] + lines[end:])


# ── 3c. preset 第 19 条 ──────────────────────────────────────────
def preset19_ok(text: str) -> bool:
    return PRESET19_HEAD in text and PRESET19_MARK in text


def preset19_revert(text: str) -> str:
    lines = text.splitlines(keepends=True)
    rng = _block_range(lines, PRESET19_HEAD)
    if not rng:
        return text
    i, end = rng
    return "".join(lines[:i] + lines[end:])


def preset19_apply(text: str) -> str:
    if preset19_ok(text):
        return text
    # 旧版（文案变了但头还在）先拆再插，避免留下两份
    text = preset19_revert(text)
    lines = text.splitlines(keepends=True)
    rng = _preset_block_range(lines)
    if not rng:
        raise PatchError("找不到第 18 条【记忆】，无法定位第 19 条的插入点")
    _, end = rng
    return "".join(lines[:end] + [PRESET19_BODY] + lines[end:])


# ── 主流程 ───────────────────────────────────────────────────────
TARGETS = [
    ("cordis.patch.yml", CORDIS, cordis_ok, cordis_apply, cordis_revert),
    ("qq-tool-restrict.mjs SAFE_PREFIXES", GUARD, guard_ok, guard_apply, guard_revert),
    ("preset 第 18 条【记忆】", PRESET, preset_ok, preset_apply, preset_revert),
    ("preset 第 19 条【多群与隐私】", PRESET, preset19_ok, preset19_apply, preset19_revert),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查，全好 exit 0")
    ap.add_argument("--revert", action="store_true", help="拆掉我们加的东西")
    ap.add_argument("--dry-run", action="store_true", help="只打印会改什么，不落盘")
    args = ap.parse_args()

    bad = 0
    preset_changed = False
    for name, path, ok, apply_fn, revert_fn in TARGETS:
        if not path.exists():
            print(f"✗ {name}: 文件不存在 {path}")
            bad += 1
            continue
        text = path.read_text(encoding="utf-8")
        if args.check:
            state = "✓ 已就位" if ok(text) else "✗ 缺失/过期"
            print(f"{state}  {name}")
            if not ok(text):
                bad += 1
            continue

        fn = revert_fn if args.revert else apply_fn
        new = fn(text)
        if new == text:
            print(f"✓ {name}: 本来就是好的（无需改动）")
            continue
        if args.dry_run:
            print(f"~ {name}: 需要{'回滚' if args.revert else '修补'}（dry-run 未落盘）")
            continue
        bak = backup(path)
        path.write_text(new, encoding="utf-8")
        print(f"✓ {name}: 已{'回滚' if args.revert else '修补'}（备份 {bak.name}）")
        if path is PRESET:
            preset_changed = True

    # 改了 preset 源就必须重新生成 patch.yml，否则她拿到的还是旧文本（这步漏了等于白改）
    if preset_changed and BUILD.exists() and not args.dry_run:
        r = subprocess.run([NODE, str(BUILD)], cwd=str(BUILD.parent.parent), capture_output=True, text=True)
        tail = (r.stdout + r.stderr).strip().splitlines()
        print(("✓" if r.returncode == 0 else "✗") + f" 重建 preset patch：{tail[-1] if tail else '(无输出)'}")
        if r.returncode != 0:
            bad += 1

    if args.check and bad:
        print(f"\n{bad} 处需要修补 → 跑 python3 /root/qq-memory/apply.py")
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PatchError as e:
        print(f"✗ 补丁失败：{e}", file=sys.stderr)
        sys.exit(2)
