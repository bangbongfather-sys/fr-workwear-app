# NJ SAFETY — 이카운트 재고 중계 설치 (윈도우 PC, 한 번만)
#
# 이카운트 API 는 등록된 IP 에서만 열린다. 회사 앱 서버(Cloudflare)는 IP 가 계속 바뀌어 직접 못 부르므로,
# 이 PC 가 대신 이카운트에서 재고를 받아 회사 앱으로 보낸다. (사무실 맥과 같은 역할 — 둘 중 켜져 있는 쪽이 처리)
#  - 정해진 시간에 돌지 않는다: 앱 「새로고침」 단추나 Claude 가 요청을 걸면, 1분마다 확인하다가 그때만 조회한다
#  - 회사코드·사용자ID·인증키는 이 PC 의 윈도우 계정으로 암호화(DPAPI)해 저장한다 — 다른 계정·다른 PC 에서는 못 푼다
#  - 바탕화면 「이카운트 재고 보내기」를 더블클릭해도 바로 보낸다
#
# 설치 (PowerShell 에 붙여넣기):
#   [Net.ServicePointManager]::SecurityProtocol='Tls12'; iex ([Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://fr-workwear-app.njsafety91.workers.dev/ecount-relay/install.ps1')))
# 정보 바꾸기: 맨 앞에  $nj='reset';  을 붙여 실행 / 지우기: 맨 앞에  $nj='remove';  을 붙여 실행

function Install-NjEcountRelay {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $Mode = if (Get-Variable -Name nj -Scope Global -ErrorAction SilentlyContinue) { "$global:nj" } else { '' }
  $Dir = Join-Path $env:LOCALAPPDATA 'nj-ecount'
  $Task = 'NJ SAFETY ecount relay'
  $Desk = Join-Path ([Environment]::GetFolderPath('Desktop')) '이카운트 재고 보내기.cmd'
  $Cred = Join-Path $Dir 'cred.json'
  $Relay = Join-Path $Dir 'relay.ps1'
  $Vbs = Join-Path $Dir 'run-hidden.vbs'

  if ($Mode -eq 'remove') {
    Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Force $Desk -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
    Write-Host '이카운트 재고 중계를 지웠습니다.'
    return
  }

  Write-Host ''
  Write-Host '=== NJ SAFETY 이카운트 재고 중계 설치 (윈도우) ==='
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $fresh = $false
  if ($Mode -ne 'reset' -and (Test-Path $Cred)) {
    Write-Host '저장된 이카운트 정보를 그대로 씁니다. (바꾸려면 맨 앞에 $nj=''reset''; 을 붙여 다시 실행)'
  } else {
    $fresh = $true
    Write-Host '이카운트 정보를 넣어 주세요. 이 PC 의 윈도우 계정으로 암호화해 저장합니다.'
    $com = Read-Host '회사코드'
    $user = Read-Host '이카운트 사용자 ID'
    $key = Read-Host '실서버 인증키 (붙여넣고 Enter — 화면에는 안 보입니다)' -AsSecureString
    if (-not $com -or -not $user -or $key.Length -eq 0) { Write-Host '빈 값이 있습니다. 다시 실행해 주세요.'; return }
    $enc = { param($t) ConvertFrom-SecureString (ConvertTo-SecureString $t.Trim() -AsPlainText -Force) }
    @{ com = (& $enc $com); user = (& $enc $user); key = (ConvertFrom-SecureString $key) } | ConvertTo-Json | Set-Content -Path $Cred -Encoding ASCII
  }

  # 중계 스크립트 — 이카운트(창고별재고현황 + 품목조회) → 회사 앱 /api/ecount/push
  $relayText = @'
param([string]$Mode = '')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$App = 'https://fr-workwear-app.njsafety91.workers.dev'
$Dir = Join-Path $env:LOCALAPPDATA 'nj-ecount'
$Log = Join-Path $Dir 'relay.log'
function Say($m) { $l = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Add-Content -Path $Log -Value $l -Encoding UTF8; Write-Host $l }
function Cut($s) { if ($null -eq $s) { '' } elseif ($s.Length -gt 200) { $s.Substring(0, 200) } else { $s } }
function Plain($enc) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $enc))
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
# 한글이 깨지지 않게 UTF-8 로 주고받는다. 4xx/5xx 도 본문을 돌려준다(회사 앱의 오류 설명).
function Call($url, $body, $hdr) {
  $w = New-Object Net.WebClient
  $w.Encoding = [Text.Encoding]::UTF8
  if ($hdr) { foreach ($k in $hdr.Keys) { $w.Headers[$k] = $hdr[$k] } }
  try {
    if ($null -eq $body) { return $w.DownloadString($url) }
    $w.Headers['Content-Type'] = 'application/json'
    return $w.UploadString($url, 'POST', $body)
  } catch [Net.WebException] {
    if ($_.Exception.Response) { return (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)).ReadToEnd() }
    throw
  }
}

$cf = Join-Path $Dir 'cred.json'
if (-not (Test-Path $cf)) { if ($Mode -ne 'check') { Say '실패: 저장된 이카운트 정보가 없습니다 — 설치를 다시 실행하세요' }; exit 1 }
$c = Get-Content $cf -Raw | ConvertFrom-Json
$Com = (Plain $c.com).Trim(); $User = (Plain $c.user).Trim(); $Key = (Plain $c.key).Trim()
$sha = [Security.Cryptography.SHA256]::Create()
$RelayKey = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Key)) | ForEach-Object { $_.ToString('x2') })
$H = @{ 'X-Relay-Key' = $RelayKey; 'X-Relay-Dev' = 'home-pc' }
function Fail($m) {
  Say "실패: $m"
  try { Call "$App/api/ecount/push" (@{ error = "$m" } | ConvertTo-Json -Compress) $H | Out-Null } catch {}
  exit 1
}

# check: 1분마다 작업 스케줄러가 부른다 — 회사 앱에 새로고침 요청이 있을 때만 아래로 진행 (없으면 조용히 끝)
if ($Mode -eq 'check') {
  $p = ''
  try { $p = Call "$App/api/ecount/pending" $null $H } catch { exit 0 }
  if ($p -notmatch '"pending"\s*:\s*true') { exit 0 }
  Say '새로고침 요청 받음'
}

try {
  $z = Call 'https://oapi.ecount.com/OAPI/V2/Zone' (@{ COM_CODE = $Com } | ConvertTo-Json -Compress) $null
  $zone = $null; try { $zone = ($z | ConvertFrom-Json).Data.ZONE } catch {}
  if (-not $zone) { Fail "Zone 응답: $(Cut $z)" }
  $lr = Call "https://oapi$zone.ecount.com/OAPI/V2/OAPILogin" (@{ COM_CODE = $Com; USER_ID = $User; API_CERT_KEY = $Key; LAN_TYPE = 'ko-KR'; ZONE = $zone } | ConvertTo-Json -Compress) $null
  $sid = $null; try { $sid = ($lr | ConvertFrom-Json).Data.Datas.SESSION_ID } catch {}
  if (-not $sid) { Fail "로그인 응답: $(Cut $lr)" }
  $q = '?SESSION_ID=' + [Uri]::EscapeDataString($sid)
  $today = Get-Date -Format 'yyyyMMdd'
  $inv = Call "https://oapi$zone.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation$q" ('{"BASE_DATE":"' + $today + '","PROD_CD":"","WH_CD":"","ZERO_FLAG":"Y"}') $null
  if ($inv -notmatch '"Status"\s*:\s*"?200') { Fail "재고 응답: $(Cut $inv)" }
  # 품목조회는 이름 보충용 — 실패해도 재고는 보낸다
  $prod = '{}'
  try { $prod = Call "https://oapi$zone.ecount.com/OAPI/V2/InventoryBasic/GetBasicProductsList$q" '{}' $null } catch { $prod = '{}' }
  if ($prod -notmatch '"Status"\s*:\s*"?200') { $prod = '{}' }
} catch { Fail "이카운트 연결 실패: $($_.Exception.Message)" }

try { $res = Call "$App/api/ecount/push" ('{"inv":' + $inv + ',"prod":' + $prod + '}') $H }
catch { Say "실패: 회사 앱으로 보내지 못했습니다 — $($_.Exception.Message)"; exit 1 }
Say "보냄: $res"
'@
  # BOM 있는 UTF-8 로 저장해야 윈도우 PowerShell 5.1 이 한글을 바르게 읽는다
  [IO.File]::WriteAllText($Relay, $relayText, (New-Object Text.UTF8Encoding $true))

  # 1분마다 창 없이 확인 (VBS 로 감싸야 PowerShell 창이 번쩍이지 않는다)
  $vbsText = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' + $Relay + '"" check", 0, True'
  [IO.File]::WriteAllText($Vbs, $vbsText, [Text.Encoding]::Unicode)
  $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $Vbs + '"')
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  try { $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) }
  catch { $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650) }
  Register-ScheduledTask -TaskName $Task -Action $act -Trigger $trg -Settings $set -Description 'NJ SAFETY 회사 앱의 이카운트 재고 새로고침 요청을 1분마다 확인합니다' -Force | Out-Null

  # 바탕화면 단추 — 더블클릭하면 지금 바로 보낸다
  $cmd = "@echo off`r`nchcp 65001 >nul`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%LOCALAPPDATA%\nj-ecount\relay.ps1`"`r`necho.`r`npause`r`n"
  [IO.File]::WriteAllText($Desk, $cmd, [Text.Encoding]::ASCII)

  $ip = ''
  try { $ip = (New-Object Net.WebClient).DownloadString('https://api.ipify.org').Trim() } catch {}
  Write-Host ''
  Write-Host '설치했습니다.'
  if ($ip) {
    Write-Host "이 PC 의 인터넷 주소(IP): $ip" -ForegroundColor Yellow
    Write-Host '→ 이카운트 ERP > API인증키발급 > IP등록 에 이 주소를 추가해야 이 PC 에서 가져올 수 있어요.'
  }
  if ($fresh) {
    $ans = Read-Host '이카운트에 IP 를 등록했으면 지금 한 번 보내 볼까요? (y/n)'
    if ($ans -match '^[yYㅛ]') { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Relay }
  }
  Write-Host ''
  Write-Host '끝. 정해진 시간에는 보내지 않습니다.'
  Write-Host '회사 앱 재고 탭의 「새로고침」(또는 Claude 에게 「재고 새로고침」)을 누르면 1분 안에 사무실 맥·이 PC 중 켜져 있는 쪽이 가져와 보냅니다.'
  Write-Host '바탕화면 「이카운트 재고 보내기」로도 바로 보낼 수 있어요.'
}
Install-NjEcountRelay
