#!/usr/bin/env bash
# qq-bridge-memory 远端切换脚本（B 批改名：qq-memory → qq-bridge-memory）
#
# 这是「在远端跑」的脚本，本机通过 stdin 喂过去：
#   ssh qq 'bash -s -- --check' < scripts/cutover-batch-b.sh
#   ssh qq 'bash -s -- --apply' < scripts/cutover-batch-b.sh
#   ssh qq 'bash -s -- --revert' < scripts/cutover-batch-b.sh          # 反向，dry-run
#   ssh qq 'bash -s -- --revert --apply' < scripts/cutover-batch-b.sh  # 反向，真做
#
# 默认（不带参数）就是 dry-run：只打印要做什么，不落盘、不重启。
# 必须以 root 在远端跑（要动 /root、/etc/systemd/system）。
#
# 前置假设：新代码已经 rsync 到运行目录（旧的 /root/qq-memory 或新的
# /root/qq-bridge-memory 都行 —— systemd 单元文件若还是旧名，脚本会就地按改名映射
# 生成新名副本，不会静默失败）。

set -euo pipefail

PROG="cutover-batch-b.sh"

OLD_DIR="/root/qq-memory"
NEW_DIR="/root/qq-bridge-memory"
CORDIS="/root/.dsh/profiles/web/cordis.patch.yml"
GUARD="/root/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs"
UNIT_DIR="/etc/systemd/system"
OLD_UNIT="qq-memory-collect"
NEW_UNIT="qq-bridge-memory-collect"
NODE_BIN="/root/.nvm/versions/node/v24.21.0/bin/node"
AGENT_CORDIS="/root/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml"
PRESET_PATCH="/root/qq-bridge/plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml"
BUILD_SCRIPT="/root/qq-bridge/scripts/build-agent-preset-patches.mjs"

usage() {
  cat <<'USAGE'
用法（在远端跑，本机用 ssh 把脚本喂进去）：
  ssh qq 'bash -s -- --check' < scripts/cutover-batch-b.sh
  ssh qq 'bash -s -- --apply' < scripts/cutover-batch-b.sh
  ssh qq 'bash -s -- --revert [--apply]' < scripts/cutover-batch-b.sh

参数：
  （不带）        dry-run：qq-memory → qq-bridge-memory，只打印不落盘、不重启
  --apply        真做：停旧 timer / mv 目录 / 改 cordis + guard / 换 systemd 单元 /
                 按需重建 preset patch / 重启 dsh-web
  --check        只验状态：已切完 exit 0，未切完 exit 1（不动任何东西）
  --revert       反向切回 qq-memory（默认同样 dry-run，加 --apply 才真做）
  --dry-run      显式指定 dry-run（与不带参数等价）
  -h, --help     打这份说明

幂等：跑两次结果一样；已切换状态下再 --apply 只会报「本来就是好的」。

注意：--apply 最后会 systemctl restart dsh-web，线上 bot 会断十几秒。
USAGE
}

# ── 输出 helper ─────────────────────────────────────────────────
say()  { printf '%s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }
step() { printf '\n# === %s ===\n' "$*"; }

# 真跑还是只打印（由 DRY 决定）
run() {
  if [ "$DRY" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    printf '  $ %s\n' "$*"
    "$@"
  fi
}

# 精确替换：python3 读原文 → 逐个断言命中次数 → 写回（dry-run 不写）。
# 用法：py_edit <cordis|guard|units> <apply|revert> <dry:0|1>
#   cordis/guard：断言每个替换串命中恰好指定次数，失败打印「文件 + 哪一句 + 命中几次」
#   units：新名单元文件不在时，从旧名文件按改名映射就地生成
py_edit() {
  python3 - "$1" "$2" "$3" <<'PYEOF'
import sys, os, shutil, time

target, direction, dry_s = sys.argv[1], sys.argv[2], sys.argv[3]
dry = (dry_s == "1")

OLD_DIR = "/root/qq-memory"
NEW_DIR = "/root/qq-bridge-memory"
CORDIS = "/root/.dsh/profiles/web/cordis.patch.yml"
GUARD = "/root/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs"
OLD_UNIT = "qq-memory-collect"
NEW_UNIT = "qq-bridge-memory-collect"


def fail(msg):
    sys.stderr.write("✗ " + msg + "\n")
    sys.exit(1)


def read_text(path, label):
    if not os.path.isfile(path):
        fail(f"{label}: 文件不存在 {path}")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def apply_pairs_text(text, pairs, label):
    """按 (old, new, expect) 逐个替换；每处都断言命中次数。"""
    notes = []
    for old, new, expect in pairs:
        c = text.count(old)
        if c == expect:
            text = text.replace(old, new)
        elif c == 0 and text.count(new) >= 1:
            notes.append(old)          # 已经是新名，跳过
        else:
            fail(f"{label}: 串 {old!r} 命中 {c} 次，应为 {expect} 次（{label} 未改）")
    return text, notes


def write_back(path, text, label):
    st = time.strftime("%Y%m%d-%H%M%S")
    bak = f"{path}.bak-cutover-{st}"
    shutil.copy2(path, bak)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"✓ {label}: 已写回（备份 {os.path.basename(bak)}）")


def sensitive_lines(text):
    return [l for l in text.splitlines()
            if ("promptApiKey" in l) or ("channelSecrets" in l)]


# ── cordis.patch.yml ─────────────────────────────────────────────
if target == "cordis":
    pairs = [
        ("- id: mcp-qq-memory", "- id: mcp-qq-bridge-memory", 1),
        ("serverName: qq-memory", "serverName: qq-bridge-memory", 1),
        ("- '/root/qq-memory/src/mcp-server.mjs'",
         "- '/root/qq-bridge-memory/src/mcp-server.mjs'", 1),
        ("# qq-memory：跨会话记忆外挂", "# qq-bridge-memory：跨会话记忆外挂", 1),
    ]
    if direction == "revert":
        pairs = [(new, old, expect) for old, new, expect in pairs][::-1]

    label = "cordis.patch.yml"
    text = read_text(CORDIS, label)
    before_sens = sensitive_lines(text)
    before_stars = text.count("***")

    new_text, notes = apply_pairs_text(text, pairs, label)

    # 防掩码写回：promptApiKey / channelSecrets 那几行必须逐字节不变
    if sensitive_lines(new_text) != before_sens:
        fail(f"{label}: promptApiKey / channelSecrets 行在替换前后不一致"
             f"（替换前 {len(before_sens)} 行、替换后 {len(sensitive_lines(new_text))} 行），"
             "可能把掩码写回去了，已中止，未写入")
    after_stars = new_text.count("***")
    if before_stars != 0 or after_stars != 0:
        fail(f"{label}: '***' 计数 替换前={before_stars} 替换后={after_stars}，应都为 0，已中止")

    if new_text == text:
        print(f"✓ {label}: 本来就是好的（无需改动）")
    elif dry:
        print(f"~ {label}: 需要改 {len(pairs) - len(notes)} 处，dry-run 未落盘")
    else:
        write_back(CORDIS, new_text, label)

# ── qq-tool-restrict.mjs（守卫前缀 + 三行注释）───────────────────
elif target == "guard":
    pairs = [
        ("'mcp__qq-memory__'", "'mcp__qq-bridge-memory__'", 1),
        ("// qq-memory：", "// qq-bridge-memory：", 1),
        ("/root/qq-memory", "/root/qq-bridge-memory", 2),
    ]
    if direction == "revert":
        pairs = [(new, old, expect) for old, new, expect in pairs][::-1]

    label = "qq-tool-restrict.mjs"
    text = read_text(GUARD, label)
    new_text, notes = apply_pairs_text(text, pairs, label)

    if new_text == text:
        print(f"✓ {label}: 本来就是好的（无需改动）")
    elif dry:
        print(f"~ {label}: 需要改 {len(pairs) - len(notes)} 处，dry-run 未落盘")
    else:
        write_back(GUARD, new_text, label)

# ── systemd 单元文件（只在目标名不存在时生成）────────────────────
elif target == "units":
    base = NEW_DIR if direction == "apply" else OLD_DIR
    # dry-run 里目录还没 mv，源文件还在「移动前」那一侧 —— 回退到那边读，别误报失败
    if dry and not os.path.isdir(os.path.join(base, "systemd")):
        base = OLD_DIR if direction == "apply" else NEW_DIR
    to_unit = NEW_UNIT if direction == "apply" else OLD_UNIT
    from_unit = OLD_UNIT if direction == "apply" else NEW_UNIT
    old_name = "qq-memory"
    new_name = "qq-bridge-memory"
    if direction == "revert":
        old_name, new_name = new_name, old_name
    sdir = os.path.join(base, "systemd")

    for ext in ("service", "timer"):
        dst = os.path.join(sdir, f"{to_unit}.{ext}")
        src = os.path.join(sdir, f"{from_unit}.{ext}")
        if os.path.isfile(dst):
            print(f"✓ 单元文件已在位：{dst}")
            continue
        if not os.path.isfile(src):
            fail(f"units: 单元文件都不存在：{dst} 与 {src}")
        text = read_text(src, "units")
        c = text.count(old_name)
        if c < 1:
            fail(f"units: {src} 里 {old_name!r} 命中 0 次，无法生成 {os.path.basename(dst)}")
        if dry:
            print(f"~ 需要从旧名生成：{src} → {dst}（{c} 处，dry-run 未落盘）")
            continue
        with open(dst, "w", encoding="utf-8") as f:
            f.write(text.replace(old_name, new_name))
        print(f"✓ 已从旧名生成：{dst}（替换 {c} 处）")

else:
    fail(f"py_edit: 未知 target {target!r}")
PYEOF
}

# ── 参数 ─────────────────────────────────────────────────────────
MODE="apply"
DRY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)    DRY=0 ;;
    --dry-run)  DRY=1 ;;
    --check)    MODE="check" ;;
    --revert)   MODE="revert" ;;
    -h|--help)  usage; exit 0 ;;
    *)          printf '✗ 未知参数：%s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = "check" ] && [ "$DRY" -eq 0 ]; then
  printf '✗ --check 只读，不能和 --apply 一起用\n' >&2
  exit 2
fi

[ "$(id -u)" -eq 0 ] || die "必须以 root 在远端运行（要动 /root 与 /etc/systemd/system）"

# ── --check：只验状态 ────────────────────────────────────────────
if [ "$MODE" = "check" ]; then
  bad=0
  pass_check() { printf '✓ %s\n' "$*"; }
  fail_check() { printf '✗ %s\n' "$*"; bad=$((bad + 1)); }

  step "状态检查（已切完应 exit 0）"

  # 1. 目录
  if [ -d "$NEW_DIR" ] && [ ! -e "$OLD_DIR" ]; then
    pass_check "目录：$NEW_DIR 在位，$OLD_DIR 已不存在"
  elif [ -d "$NEW_DIR" ] && [ -e "$OLD_DIR" ]; then
    fail_check "目录：新旧同时存在（$NEW_DIR + $OLD_DIR）"
  elif [ -e "$OLD_DIR" ]; then
    fail_check "目录：仍是旧目录 $OLD_DIR，$NEW_DIR 不存在"
  else
    fail_check "目录：两个都不存在（$NEW_DIR / $OLD_DIR）"
  fi

  # 2. cordis
  if [ ! -f "$CORDIS" ]; then
    fail_check "cordis：文件不存在 $CORDIS"
  else
    if grep -q "id: mcp-qq-bridge-memory" "$CORDIS"; then
      pass_check "cordis：有 'id: mcp-qq-bridge-memory'"
    else
      fail_check "cordis：缺 'id: mcp-qq-bridge-memory'"
    fi
    if grep -q "id: mcp-qq-memory" "$CORDIS"; then
      fail_check "cordis：仍残留 'id: mcp-qq-memory'"
    else
      pass_check "cordis：已无 'id: mcp-qq-memory'"
    fi
    say "  （参考）args 指向：$(grep -o "/root/[a-z-]*memory/src/mcp-server.mjs" "$CORDIS" | head -1 || true)"
  fi

  # 3. guard
  if [ ! -f "$GUARD" ]; then
    fail_check "guard：文件不存在 $GUARD"
  else
    if grep -q "'mcp__qq-bridge-memory__'" "$GUARD"; then
      pass_check "guard：有 'mcp__qq-bridge-memory__'"
    else
      fail_check "guard：缺 'mcp__qq-bridge-memory__'"
    fi
    if grep -q "'mcp__qq-memory__'" "$GUARD"; then
      fail_check "guard：仍残留 'mcp__qq-memory__'"
    else
      pass_check "guard：已无 'mcp__qq-memory__'"
    fi
  fi

  # 4. systemd 单元文件
  missing=""
  for ext in service timer; do
    [ -f "$UNIT_DIR/${NEW_UNIT}.${ext}" ] || missing="$missing ${NEW_UNIT}.${ext}"
  done
  if [ -z "$missing" ]; then
    pass_check "systemd：${NEW_UNIT}.service / .timer 都在 $UNIT_DIR"
  else
    fail_check "systemd：缺${missing}"
  fi
  leftover=""
  for ext in service timer; do
    [ -e "$UNIT_DIR/${OLD_UNIT}.${ext}" ] && leftover="$leftover ${OLD_UNIT}.${ext}"
  done
  if [ -z "$leftover" ]; then
    pass_check "systemd：旧单元文件已清掉"
  else
    fail_check "systemd：仍残留${leftover}"
  fi

  # 5. timer 活着
  if systemctl is-active --quiet "${NEW_UNIT}.timer"; then
    pass_check "systemd：${NEW_UNIT}.timer 是 active"
  else
    fail_check "systemd：${NEW_UNIT}.timer 不是 active（$(systemctl is-active "${NEW_UNIT}.timer" 2>/dev/null || true)）"
  fi

  say ""
  if [ "$bad" -eq 0 ]; then
    ok "全部通过 —— 已经切到 qq-bridge-memory"
    exit 0
  fi
  printf '✗ %d 项未通过 —— 还没切完（或切坏了），按上面逐条处理\n' "$bad"
  exit 1
fi

# ── 方向变量：apply / revert 走同一条流程，只换新旧两端 ─────────
if [ "$MODE" = "revert" ]; then
  DIRECTION="revert"
  FROM_DIR="$NEW_DIR"; TO_DIR="$OLD_DIR"
  FROM_UNIT="$NEW_UNIT"; TO_UNIT="$OLD_UNIT"
  FROM_NAME="qq-bridge-memory"; TO_NAME="qq-memory"
else
  DIRECTION="apply"
  FROM_DIR="$OLD_DIR"; TO_DIR="$NEW_DIR"
  FROM_UNIT="$OLD_UNIT"; TO_UNIT="$NEW_UNIT"
  FROM_NAME="qq-memory"; TO_NAME="qq-bridge-memory"
fi

if [ "$DRY" -eq 1 ]; then
  say "== $PROG · $DIRECTION · DRY-RUN（不落盘、不重启）=="
else
  say "== $PROG · $DIRECTION · 真做 =="
fi
say "   方向：$FROM_NAME → $TO_NAME"

# ── 0. 预检：运行目录里的代码版本（必须排在停 timer / mv 之前）────────
# 前置假设是「新代码已经 rsync 到运行目录」，这一步负责把它验出来。
# 防的是：mv 目录 → 改接线 → 重启 dsh-web 之后，运行目录里还是旧版代码，
# 默认库路径仍指向刚被 mv 走的目录，MCP 起来后指向一个不存在的库 —— 看着切完了，其实记忆坏了。
# 放在第 1 步之前：预检失败时不能留下任何副作用（连停 timer 都算），否则要人工复位。
# dry-run 同样要跑：它的价值就是提前暴露「rsync 忘了」。
step "0/8 预检：运行目录里的代码版本"
if [ ! -d "$FROM_DIR" ] && [ -d "$TO_DIR" ]; then
  ok "已是目标状态，跳过预检"
else
  EXPECT_DB="$TO_DIR/data/messages.db"
  EXPECT_MCP_ID="id: mcp-$TO_NAME"
  precheck_bad=()

  # 1. mcp-server.mjs 的默认库路径必须已指向目标目录
  if [ ! -f "$FROM_DIR/src/mcp-server.mjs" ]; then
    precheck_bad+=("缺 $FROM_DIR/src/mcp-server.mjs")
  elif ! grep -qF "$EXPECT_DB" "$FROM_DIR/src/mcp-server.mjs"; then
    precheck_bad+=("$FROM_DIR/src/mcp-server.mjs 里没有 $EXPECT_DB")
  fi

  # 2. apply.py 里的 MCP id 必须已是目标名
  if [ ! -f "$FROM_DIR/apply.py" ]; then
    precheck_bad+=("缺 $FROM_DIR/apply.py")
  elif ! grep -qF "$EXPECT_MCP_ID" "$FROM_DIR/apply.py"; then
    precheck_bad+=("$FROM_DIR/apply.py 里没有 '$EXPECT_MCP_ID'")
  fi

  # 3. rsync 把新名的 systemd 单元一起带过来了。
  #    只在 apply 方向检查：revert 时本地仓已经不含旧名单元文件，
  #    回滚用的旧名单元由第 6 步按改名映射现场生成，不该卡在这里。
  if [ "$DIRECTION" = "apply" ] && [ ! -f "$FROM_DIR/systemd/${TO_UNIT}.service" ]; then
    precheck_bad+=("缺 $FROM_DIR/systemd/${TO_UNIT}.service（新名单元没 rsync 到）")
  fi

  if [ "${#precheck_bad[@]}" -gt 0 ]; then
    precheck_joined=$(printf '%s；' "${precheck_bad[@]}")
    precheck_joined=${precheck_joined%；}
    die "运行目录里的代码还是旧版（$precheck_joined）
  先把新代码同步过去再跑：
    cd /home/ubuntu/qq-bridge-memory
    rsync -az --exclude config --exclude data src bin tests package.json systemd apply.py qq:$FROM_DIR/
  （--exclude config 是硬要求：config/relations.json 存线上真实白名单，本地那份是模板，覆盖了会丢授权）"
  fi
  ok "预检通过：代码已是 $TO_NAME 版本（库路径 $EXPECT_DB / $EXPECT_MCP_ID / systemd 单元都在）"
fi

# ── 1. 停旧 timer ───────────────────────────────────────────────
step "1/8 停旧 timer（${FROM_UNIT}.timer）"
if [ -f "$UNIT_DIR/${FROM_UNIT}.timer" ]; then
  run systemctl disable --now "${FROM_UNIT}.timer" \
    || warn "停 ${FROM_UNIT}.timer 失败（继续，后面会覆盖装）"
else
  ok "旧 timer 单元文件不存在，跳过"
fi

# ── 2. mv 目录 ──────────────────────────────────────────────────
step "2/8 移动运行目录 $FROM_DIR → $TO_DIR"
if [ ! -d "$FROM_DIR" ] && [ -d "$TO_DIR" ]; then
  ok "$FROM_DIR 不存在、$TO_DIR 已在位 —— 目录这步本来就是好的"
elif [ -d "$FROM_DIR" ] && [ -d "$TO_DIR" ]; then
  die "新旧目录同时存在（$FROM_DIR 与 $TO_DIR），先人工确认哪个是真的，脚本不动"
elif [ -d "$FROM_DIR" ]; then
  run mv "$FROM_DIR" "$TO_DIR"
else
  die "两个目录都不存在：$FROM_DIR / $TO_DIR"
fi

# ── 3. cordis ───────────────────────────────────────────────────
step "3/8 改 cordis.patch.yml（id / serverName / args 路径 / 注释行）"
say "   每处断言命中 1 次；promptApiKey / channelSecrets 行必须逐字节不变"
py_edit cordis "$DIRECTION" "$DRY"
if [ "$DRY" -eq 0 ] && [ -f "$CORDIS" ]; then
  stars=$(grep -c '\*\*\*' "$CORDIS" || true)
  [ "$stars" = "0" ] || die "cordis: 写回后 '***' 命中 $stars 行，应为 0（可能把掩码写回去了，拿 .bak-cutover-* 还原）"
  ok "cordis: 写回后 '***' 命中 0 行（掩码没被写回）"
fi

# ── 4. guard ────────────────────────────────────────────────────
step "4/8 改 qq-tool-restrict.mjs（守卫前缀 + 三行注释）"
py_edit guard "$DIRECTION" "$DRY"

# ── 5. systemd 单元 ─────────────────────────────────────────────
step "5/8 装 ${TO_UNIT}.service / .timer 到 $UNIT_DIR"
py_edit units "$DIRECTION" "$DRY"
run install -m 644 "$TO_DIR/systemd/${TO_UNIT}.service" "$TO_DIR/systemd/${TO_UNIT}.timer" "$UNIT_DIR/"
if [ -e "$UNIT_DIR/${FROM_UNIT}.service" ] || [ -e "$UNIT_DIR/${FROM_UNIT}.timer" ]; then
  run rm -f "$UNIT_DIR/${FROM_UNIT}.service" "$UNIT_DIR/${FROM_UNIT}.timer"
fi
run systemctl daemon-reload
run systemctl enable --now "${TO_UNIT}.timer"

# ── 6. preset patch 重建（只 apply 方向需要）─────────────────────
step "6/8 preset patch 重建检查"
if [ "$DIRECTION" = "revert" ]; then
  ok "回滚方向不动 preset（第 18/19 条文案没变），跳过"
elif [ ! -f "$AGENT_CORDIS" ] || [ ! -f "$PRESET_PATCH" ]; then
  warn "缺 $AGENT_CORDIS 或 $PRESET_PATCH，跳过重建"
elif [ ! -x "$NODE_BIN" ]; then
  die "node 不在 $NODE_BIN，无法重建 preset patch"
elif [ "$AGENT_CORDIS" -nt "$PRESET_PATCH" ]; then
  say "   agent.cordis.yml 比 preset patch 新 → 需要重建"
  run "$NODE_BIN" "$BUILD_SCRIPT"
else
  ok "agent.cordis.yml 不比 patch 新，无需重建"
fi

# ── 7. 重启 dsh-web ─────────────────────────────────────────────
step "7/8 重启 dsh-web"
say "⚠ 这一步会让线上 bot 断十几秒，正在进行的会话会中断（真跑才执行）。"
run systemctl restart dsh-web

# ── 8. 验收摘要 ─────────────────────────────────────────────────
step "8/8 验收摘要"
if [ "$DRY" -eq 1 ]; then
  say "（dry-run：没有落盘也没有重启，下面是当前状态，仅作参考）"
fi

say "· 目录归属："
for d in "$OLD_DIR" "$NEW_DIR"; do
  if [ -d "$d" ]; then
    say "    $d 存在（$(stat -c '%U:%G %a' "$d" 2>/dev/null || echo '?')）"
  else
    say "    $d 不存在"
  fi
done

say "· apply.py --check："
if [ -f "$TO_DIR/apply.py" ]; then
  if python3 "$TO_DIR/apply.py" --check; then
    say "    exit 0（四处接线全就位）"
  else
    say "    exit 非 0（见上面 ✗ 行，接线还差东西）"
  fi
else
  say "    跳过：$TO_DIR/apply.py 不存在"
fi

say "· ${TO_UNIT}.timer："
systemctl list-timers --all --no-pager "${TO_UNIT}.timer" 2>/dev/null || say "    （list-timers 没查到）"

say "· dsh-web：$(systemctl is-active dsh-web 2>/dev/null || true)"

say ""
if [ "$DRY" -eq 1 ]; then
  say "dry-run 结束：确认无误后加 --apply 真跑。"
else
  ok "切换完成 —— 用 --check 复核一遍应 exit 0。"
fi
