#!/bin/bash
# NJ SAFETY — 이카운트 재고 중계 설치 (사무실 맥, 한 번만)
#
# 이카운트 API 는 등록된 IP(사무실 218.39.175.10)에서만 열린다. 회사 앱 서버(Cloudflare)는 IP 가 계속 바뀌어
# 직접 못 부르므로, 이 맥이 하루 네 번(9·11·14·16시) 이카운트에서 재고를 받아 회사 앱으로 보낸다.
#  - 회사코드·사용자ID·인증키는 이 맥의 「키체인」에만 저장한다 (파일에 남기지 않음)
#  - 맥이 잠자기 중이면 그 시간은 건너뛰고, 깨어날 때 한 번 실행된다 (macOS launchd 기본 동작)
#  - 바탕화면 「이카운트 재고 보내기」를 더블클릭하면 언제든 바로 보낸다
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
echo "이카운트 정보를 넣어 주세요. 이 맥의 키체인에만 저장됩니다."
read -r -p "회사코드: " COM < /dev/tty
read -r -p "이카운트 사용자 ID: " EUSER < /dev/tty
read -r -s -p "실서버 인증키 (붙여넣고 Enter — 화면에는 안 보입니다): " KEY < /dev/tty; echo ""
if [ -z "$COM" ] || [ -z "$EUSER" ] || [ -z "$KEY" ]; then echo "빈 값이 있습니다. 다시 실행해 주세요."; exit 1; fi
security add-generic-password -U -a "$USER" -s nj-ecount-com -w "$COM"
security add-generic-password -U -a "$USER" -s nj-ecount-user -w "$EUSER"
security add-generic-password -U -a "$USER" -s nj-ecount-key -w "$KEY"

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

[ -n "$COM" ] && [ -n "$EUSER" ] && [ -n "$KEY" ] || fail "키체인에 이카운트 정보가 없습니다 — 설치를 다시 실행하세요"
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

# 하루 네 번 (매일 9·11·14·16시 5분) — 잠자기 중이면 깨어날 때 한 번
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo "<key>Label</key><string>$LABEL</string>"
  echo "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$DIR/relay.sh</string></array>"
  echo '<key>StartCalendarInterval</key><array>'
  for h in 9 11 14 16; do echo "<dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>5</integer></dict>"; done
  echo '</array>'
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
echo "설치했습니다. 지금 한 번 보내 봅니다…"
zsh "$DIR/relay.sh" || true
echo ""
echo "끝. 매일 9·11·14·16시에 자동으로 보냅니다. 바탕화면 「이카운트 재고 보내기」로 언제든 바로 보낼 수 있어요."
