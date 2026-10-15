#!/bin/bash
# NJ SAFETY — 이카운트 재고 중계 설치 (사무실 맥, 한 번만)
#
# 이카운트 API 는 등록된 IP(사무실 맥)에서만 열린다. 회사 앱 서버(Cloudflare)는 IP 가 계속 바뀌어
# 직접 못 부르므로, 이 맥이 대신 이카운트에서 재고를 받아 회사 앱으로 보낸다.
#  - 정해진 시간에 돌지 않는다: 앱 「새로고침」 단추나 Claude 가 요청을 걸면, 맥이 1분마다 확인하다가 그때만 조회한다
#  - 회사코드·사용자ID·인증키는 이 맥의 「키체인」에만 저장한다 (파일에 남기지 않음)
#  - 맥이 잠자기 중이면 깨어난 뒤 처리한다
#  - 바탕화면 「이카운트 재고 보내기」를 더블클릭해도 바로 보낸다
#  - 다시 설치하면 키체인에 있는 정보를 그대로 쓴다. 정보를 바꾸려면 끝에 reset 을 붙여 실행
#  - 지우려면: bash <(curl -fsSL https://fr-workwear-app.njsafety91.workers.dev/ecount-relay/install.sh) remove
set -e
APP="https://fr-workwear-app.njsafety91.workers.dev"
DIR="$HOME/Library/Application Support/nj-ecount"
PLIST="$HOME/Library/LaunchAgents/kr.njsafety.ecount-relay.plist"
DESK="$HOME/Desktop/이카운트 재고 보내기.command"
LABEL="kr.njsafety.ecount-relay"

if [ "$1" = "remove" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$DESK"; rm -rf "$DIR"
  for s in nj-ecount-com nj-ecount-user nj-ecount-key; do security delete-generic-password -a "$USER" -s "$s" >/dev/null 2>&1 || true; done
  echo "이카운트 재고 중계를 지웠습니다."; exit 0
fi

echo ""
echo "=== NJ SAFETY 이카운트 재고 중계 설치 ==="
kc() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null; }
FRESH=0
if [ "$1" != "reset" ] && [ -n "$(kc nj-ecount-com)" ] && [ -n "$(kc nj-ecount-user)" ] && [ -n "$(kc nj-ecount-key)" ]; then
  echo "키체인에 저장된 이카운트 정보를 그대로 씁니다. (바꾸려면 끝에 reset 을 붙여 다시 실행)"
else
  FRESH=1
  echo "이카운트 정보를 넣어 주세요. 이 맥의 키체인에만 저장됩니다."
  read -r -p "회사코드: " COM < /dev/tty
  read -r -p "이카운트 사용자 ID: " EUSER < /dev/tty
  read -r -s -p "실서버 인증키 (붙여넣고 Enter — 화면에는 안 보입니다): " KEY < /dev/tty; echo ""
  if [ -z "$COM" ] || [ -z "$EUSER" ] || [ -z "$KEY" ]; then echo "빈 값이 있습니다. 다시 실행해 주세요."; exit 1; fi
  security add-generic-password -U -a "$USER" -s nj-ecount-com -w "$COM"
  security add-generic-password -U -a "$USER" -s nj-ecount-user -w "$EUSER"
  security add-generic-password -U -a "$USER" -s nj-ecount-key -w "$KEY"
fi

mkdir -p "$DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$DIR/relay.sh" <<'EOS'
#!/bin/zsh
# 이카운트(창고별재고현황 + 품목조회) → 회사 앱 /api/ecount/push
APP="https://fr-workwear-app.njsafety91.workers.dev"
LOG="$HOME/Library/Logs/nj-ecount-relay.log"
get() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null; }
COM=$(get nj-ecount-com); EUSER=$(get nj-ecount-user); KEY=$(get nj-ecount-key)
RELAY=$(printf %s "$KEY" | shasum -a 256 | awk '{print $1}')
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG"; }
post() { curl -sS -m 90 -X POST "$APP/api/ecount/push" -H "Content-Type: application/json" -H "X-Relay-Key: $RELAY" --data-binary @-; }
jstr() { printf '"%s"' "$(printf %s "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-300)"; }
fail() { say "실패: $1"; printf '{"error":%s}' "$(jstr "$1")" | post >/dev/null 2>&1; exit 1; }
pick() { plutil -extract "$1" raw -o - - 2>/dev/null; }

[ "$1" = "check" ] && [ -z "$KEY" ] && exit 0   # 1분마다 도는 확인에서는 실패 기록을 남기지 않는다
[ -n "$COM" ] && [ -n "$EUSER" ] && [ -n "$KEY" ] || fail "키체인에 이카운트 정보가 없습니다 — 설치를 다시 실행하세요"
# check: 1분마다 launchd 가 부른다 — 회사 앱에 새로고침 요청이 있을 때만 아래로 진행 (없으면 조용히 끝)
if [ "$1" = "check" ]; then
  P=$(curl -sS -m 15 "$APP/api/ecount/pending" -H "X-Relay-Key: $RELAY" 2>/dev/null)
  print -r -- "$P" | grep -q '"pending":true' || exit 0
  say "새로고침 요청 받음"
fi
H='Content-Type: application/json'
ZR=$(curl -sS -m 30 -X POST "https://oapi.ecount.com/OAPI/V2/Zone" -H "$H" -d "{\"COM_CODE\":\"$COM\"}") || fail "이카운트 연결 실패(Zone)"
ZONE=$(print -r -- "$ZR" | pick Data.ZONE) || fail "Zone 응답: ${ZR:0:200}"
LR=$(curl -sS -m 30 -X POST "https://oapi$ZONE.ecount.com/OAPI/V2/OAPILogin" -H "$H" \
  -d "{\"COM_CODE\":\"$COM\",\"USER_ID\":\"$EUSER\",\"API_CERT_KEY\":\"$KEY\",\"LAN_TYPE\":\"ko-KR\",\"ZONE\":\"$ZONE\"}") || fail "이카운트 연결 실패(로그인)"
SID=$(print -r -- "$LR" | pick Data.Datas.SESSION_ID) || fail "로그인 응답: ${LR:0:200}"
TODAY=$(date +%Y%m%d)
INV=$(curl -sS -m 60 -X POST "https://oapi$ZONE.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID=$SID" -H "$H" \
  -d "{\"BASE_DATE\":\"$TODAY\",\"PROD_CD\":\"\",\"WH_CD\":\"\",\"ZERO_FLAG\":\"Y\"}") || fail "이카운트 연결 실패(재고)"
[ "$(print -r -- "$INV" | pick Status)" = "200" ] || fail "재고 응답: ${INV:0:200}"
# 품목조회는 이름 보충용 — 실패해도 재고는 보낸다 (실서버에서 아직 검증 전일 수 있음)
PROD=$(curl -sS -m 60 -X POST "https://oapi$ZONE.ecount.com/OAPI/V2/InventoryBasic/GetBasicProductsList?SESSION_ID=$SID" -H "$H" -d '{}' 2>/dev/null)
[ "$(print -r -- "$PROD" | pick Status)" = "200" ] || PROD='{}'
RES=$(printf '{"inv":%s,"prod":%s}' "$INV" "$PROD" | post) || fail "회사 앱으로 보내지 못했습니다"
say "보냄: $RES"
EOS
chmod +x "$DIR/relay.sh"

# 1분마다 요청 확인 (요청이 없으면 이카운트는 건드리지 않는다)
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo "<key>Label</key><string>$LABEL</string>"
  echo "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$DIR/relay.sh</string><string>check</string></array>"
  echo '<key>StartInterval</key><integer>60</integer>'
  echo "<key>StandardOutPath</key><string>$HOME/Library/Logs/nj-ecount-relay.out</string>"
  echo "<key>StandardErrorPath</key><string>$HOME/Library/Logs/nj-ecount-relay.out</string>"
  echo '</dict></plist>'
} > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# 바탕화면 단추 — 더블클릭하면 지금 바로 보낸다
printf '#!/bin/zsh\nzsh "%s"\necho ""\necho "창을 닫아도 됩니다."\n' "$DIR/relay.sh" > "$DESK"
chmod +x "$DESK"

echo ""
if [ "$FRESH" = "1" ]; then
  echo "설치했습니다. 지금 한 번 보내 봅니다…"
  zsh "$DIR/relay.sh" || true
fi
echo ""
echo "끝. 정해진 시간에는 보내지 않습니다."
echo "회사 앱 재고 탭의 「새로고침」(또는 Claude 에게 「재고 새로고침」)을 누르면 1분 안에 이 맥이 가져와 보냅니다."
echo "바탕화면 「이카운트 재고 보내기」로도 바로 보낼 수 있어요."
