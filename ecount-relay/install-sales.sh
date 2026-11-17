#!/bin/bash
# NJ SAFETY — 이카운트 「판매조회」 로봇 설치 (사무실 맥, 한 번만)
#
# 이카운트 공개 API 에는 판매 조회가 없어서, 이 맥이 Chrome 을 화면 없이 띄워 이카운트 웹에 로그인하고
# 판매조회를 읽어 회사 앱 「판매 현황」에 넣는다.
#  - 먼저 「이카운트 재고 중계」가 이 맥에 설치돼 있어야 한다 (같은 인증키로 회사 앱과 통신)
#  - 이카운트 웹 아이디·비밀번호는 이 맥의 「키체인」에만 저장한다 (파일·회사 앱 서버에 남기지 않음)
#  - 정해진 시간에 돌지 않는다: 회사 앱(또는 Claude)이 요청을 걸면 1분마다 확인하다가 그때만 실행
#  - 실행할 프로그램(web.mjs)은 실행할 때마다 회사 앱에서 최신본을 받는다
#  - 필요한 실행기(Node)는 이 맥 전체가 아니라 nj-ecount 폴더 안에만 내려받는다 (관리자 암호 필요 없음)
#  - 바탕화면 「이카운트 판매 로봇 점검」을 더블클릭하면 지금 바로 정찰(로그인 → 판매조회 메뉴)을 한다
#  - 아이디·비밀번호를 바꾸려면 끝에 reset, 지우려면 remove 를 붙여 실행
#      bash <(curl -fsSL https://fr-workwear-app.njsafety91.workers.dev/ecount-relay/install-sales.sh)
set -e
APP="https://fr-workwear-app.njsafety91.workers.dev"
DIR="$HOME/Library/Application Support/nj-ecount"
WEB="$DIR/web"
PLIST="$HOME/Library/LaunchAgents/kr.njsafety.ecount-websales.plist"
DESK="$HOME/Desktop/이카운트 판매 로봇 점검.command"
LABEL="kr.njsafety.ecount-websales"
NODE_VER="v22.12.0"
PWCORE="playwright-core@1.49.1"
kc() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null; }

if [ "$1" = "remove" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$DESK"; rm -rf "$WEB" "$DIR/node" "$DIR/web-profile"
  for s in nj-ecount-web-id nj-ecount-web-pw; do security delete-generic-password -a "$USER" -s "$s" >/dev/null 2>&1 || true; done
  echo "이카운트 판매 로봇을 지웠습니다. (재고 중계는 그대로입니다)"; exit 0
fi

echo ""
echo "=== NJ SAFETY 이카운트 판매조회 로봇 설치 ==="
if [ -z "$(kc nj-ecount-key)" ]; then
  echo "이 맥에 「이카운트 재고 중계」가 없습니다. 먼저 재고 중계를 설치해 주세요:"
  echo "  bash <(curl -fsSL $APP/ecount-relay/install.sh)"
  exit 1
fi
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then echo "Google Chrome 이 없습니다. Chrome 을 설치한 뒤 다시 실행해 주세요."; exit 1; fi

# 회사코드는 재고 중계에 넣은 것을 쓴다. 웹 아이디·비밀번호만 새로 받는다.
if [ "$1" = "reset" ] || [ -z "$(kc nj-ecount-web-id)" ] || [ -z "$(kc nj-ecount-web-pw)" ]; then
  echo ""
  echo "이카운트 웹에 로그인할 아이디·비밀번호를 넣어 주세요. 이 맥의 키체인에만 저장됩니다."
  echo "※ 대표님이 평소 쓰는 아이디와 같으면, 로봇이 로그인할 때 쓰던 화면이 끊길 수 있습니다."
  echo "   가능하면 로봇 전용 아이디(조회 권한만)를 하나 만들어 넣는 걸 권합니다."
  read -r -p "이카운트 아이디: " WID < /dev/tty
  read -r -s -p "이카운트 비밀번호 (화면에는 안 보입니다): " WPW < /dev/tty; echo ""
  if [ -z "$WID" ] || [ -z "$WPW" ]; then echo "빈 값이 있습니다. 다시 실행해 주세요."; exit 1; fi
  security add-generic-password -U -a "$USER" -s nj-ecount-web-id -w "$WID"
  security add-generic-password -U -a "$USER" -s nj-ecount-web-pw -w "$WPW"
  unset WPW
else
  echo "키체인에 저장된 이카운트 웹 아이디·비밀번호를 그대로 씁니다. (바꾸려면 끝에 reset)"
fi

mkdir -p "$WEB" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# 실행기(Node) — 이 맥에 18 이상이 있으면 그걸, 없으면 폴더 안에 내려받는다
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  ARCH=$( [ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64 )
  if [ ! -x "$DIR/node/bin/node" ]; then
    echo "실행기(Node $NODE_VER)를 내려받는 중… (한 번만, 50MB 정도)"
    TMP=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$ARCH.tar.gz" -o "$TMP/node.tgz"
    mkdir -p "$DIR/node" && tar -xzf "$TMP/node.tgz" -C "$DIR/node" --strip-components=1
    rm -rf "$TMP"
  fi
  NODE="$DIR/node/bin/node"
fi
NPM_CLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"
echo "브라우저 조종 도구(playwright-core)를 설치하는 중…"
( cd "$WEB" && [ -f package.json ] || echo '{"name":"nj-ecount-web","private":true,"type":"module"}' > "$WEB/package.json" )
"$NODE" "$NPM_CLI" install --prefix "$WEB" "$PWCORE" --no-audit --no-fund --silent
curl -fsSL "$APP/ecount-relay/web.mjs" -o "$WEB/web.mjs"

cat > "$WEB/run.sh" <<EOS
#!/bin/zsh
# 1분마다(check) 또는 바탕화면 단추(probe)로 실행 — 겹쳐 돌지 않게 잠금
WEB="$WEB"; NODE="$NODE"; APP="$APP"
LOG="\$HOME/Library/Logs/nj-ecount-websales.log"
LOCK="\$WEB/.lock"
if ! mkdir "\$LOCK" 2>/dev/null; then
  # 20분 넘은 잠금은 비정상 종료로 보고 푼다
  if [ -n "\$(find "\$LOCK" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then rmdir "\$LOCK"; mkdir "\$LOCK"; else exit 0; fi
fi
trap 'rmdir "\$LOCK" 2>/dev/null' EXIT
if [ "\$1" != "check" ]; then curl -fsS -m 30 "\$APP/ecount-relay/web.mjs" -o "\$WEB/web.mjs.new" && mv "\$WEB/web.mjs.new" "\$WEB/web.mjs"; fi
cd "\$WEB" && NJ_APP="\$APP" "\$NODE" web.mjs "\$@" >> "\$LOG" 2>&1
EOS
# check 일 때도 요청이 있으면 최신본을 받는다 (web.mjs 가 요청을 확인한 뒤라 여기서는 미리 한 번 받아 둔다 — 하루 한 번)
cat > "$WEB/check.sh" <<EOS
#!/bin/zsh
WEB="$WEB"; APP="$APP"
if [ -z "\$(find "\$WEB/web.mjs" -mmin -60 2>/dev/null)" ]; then curl -fsS -m 30 "\$APP/ecount-relay/web.mjs" -o "\$WEB/web.mjs.new" && mv "\$WEB/web.mjs.new" "\$WEB/web.mjs"; fi
exec /bin/zsh "\$WEB/run.sh" check
EOS
chmod +x "$WEB/run.sh" "$WEB/check.sh"

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo "<key>Label</key><string>$LABEL</string>"
  echo "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$WEB/check.sh</string></array>"
  echo '<key>StartInterval</key><integer>60</integer>'
  echo "<key>StandardOutPath</key><string>$HOME/Library/Logs/nj-ecount-websales.out</string>"
  echo "<key>StandardErrorPath</key><string>$HOME/Library/Logs/nj-ecount-websales.out</string>"
  echo '</dict></plist>'
} > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

printf '#!/bin/zsh\necho "이카운트에 로그인해 판매조회 메뉴까지 가 보고, 화면을 찍어 회사 앱에 보냅니다… (1~2분)"\nzsh "%s" probe\ntail -n 3 "$HOME/Library/Logs/nj-ecount-websales.log"\necho ""\necho "창을 닫아도 됩니다."\n' "$WEB/run.sh" > "$DESK"
chmod +x "$DESK"

echo ""
echo "설치했습니다. 지금 한 번 점검(로그인 → 판매조회 메뉴까지)을 해서 회사 앱에 보냅니다…"
zsh "$WEB/run.sh" probe || true
tail -n 3 "$HOME/Library/Logs/nj-ecount-websales.log" 2>/dev/null || true
echo ""
echo "끝. Claude 에게 「판매 로봇 점검 결과 봐줘」라고 하면 결과를 보고 다음 단계를 마무리합니다."
