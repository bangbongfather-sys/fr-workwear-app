// ============================================================
// 원단 입고 내역 일괄 추가 스크립트 (16건)
// 사용법: 웹앱 화면에서 F12 → Console 탭 → 아래 코드 전체 복사 후 붙여넣기 → Enter
// ============================================================
(async () => {
  const FB_URL = "https://njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app/frw.json";

  // 추가할 입고 내역 (스크린샷 기준)
  const NEW_INTAKES = [
    { date: "2026-01-26", materialName: "방염 화복 매아엔(곤색) AFN115966", qty: "370",   unit: "yard", unitPrice: "13500", supplier: "", status: "입고완료", inspector: "", note: "납기지연으로 kgs에서 쓰는 트리코트 매이샤로 받음" },
    { date: "2026-03-04", materialName: "방염 PK 니트 (AFK185900) Grey 185gsm",       qty: "1986.8", unit: "yard", unitPrice: "20300", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-04", materialName: "방염하복 상의 화색(린체3) AFP155537 수지가공", qty: "1027.5", unit: "yard", unitPrice: "20300", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-09", materialName: "방염하복 상의 화색(린체3) AFP155537 수지가공", qty: "999.5",  unit: "yard", unitPrice: "20300", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-09", materialName: "방염하복 화의곤감(Span) Navy (AFL165831)",    qty: "1063",   unit: "yard", unitPrice: "21700", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-09", materialName: "방염하복 상의안감(매이앤사) AFN115966",         qty: "764",    unit: "yard", unitPrice: "13500", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-19", materialName: "방염하복 상의 화색(린체3) AFP155537 수지가공", qty: "2015.5", unit: "yard", unitPrice: "20300", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-19", materialName: "방염하복 상의안감(매이앤사) AFN115966",         qty: "2035.5", unit: "yard", unitPrice: "13500", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-19", materialName: "방염하복 화의곤감(Span) AFL165831",           qty: "5709",   unit: "yard", unitPrice: "21700", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-19", materialName: "방염하복 상의 해판자넬 (AFP160653)",            qty: "1070.5", unit: "yard", unitPrice: "22000", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-30", materialName: "방염 PK 니트 (AFK185900) Grey 185gsm",       qty: "1986.8", unit: "yard", unitPrice: "20300", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-30", materialName: "방독시보리 Navy 565g 9만치",                  qty: "2029",   unit: "yard", unitPrice: "8000",  supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-30", materialName: "손목시보리 Grey 565g 7만치",                  qty: "2185",   unit: "yard", unitPrice: "7500",  supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-31", materialName: "방염하복 상의 해판자넬 (AFP160653)",            qty: "5594",   unit: "yard", unitPrice: "22000", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-31", materialName: "방염하복 상의 해판자넬 (AFP160653)",            qty: "3421",   unit: "yard", unitPrice: "22000", supplier: "", status: "입고완료", inspector: "", note: "" },
    { date: "2026-03-31", materialName: "방염하복 화의곤감(Span) Navy (AFL165831)",    qty: "3744.5", unit: "yard", unitPrice: "21700", supplier: "", status: "입고완료", inspector: "", note: "" },
  ];

  console.log(`[Import] 시작: ${NEW_INTAKES.length}건 추가 예정`);

  // 1. 현재 클라우드 데이터 가져오기
  const res = await fetch(FB_URL);
  if (!res.ok) { console.error("[Import] 클라우드 로드 실패"); return; }
  const data = await res.json() || {};
  const existing = Array.isArray(data.fabricIntakes) ? data.fabricIntakes : [];
  console.log(`[Import] 기존 입고: ${existing.length}건`);

  // 2. 자동 백업 (브라우저 다운로드)
  const backupBlob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const backupUrl = URL.createObjectURL(backupBlob);
  const backupLink = document.createElement("a");
  backupLink.href = backupUrl;
  backupLink.download = `frw_backup_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  backupLink.click();
  URL.revokeObjectURL(backupUrl);
  console.log("[Import] 백업 파일 다운로드 완료");

  // 3. 중복 체크 (날짜 + 품명 + 입고량 동일하면 스킵)
  const seen = new Set(existing.map(r => `${r.date}|${r.materialName}|${r.qty}`));
  const fresh = [];
  let baseId = Date.now();
  for (const it of NEW_INTAKES) {
    const key = `${it.date}|${it.materialName}|${it.qty}`;
    if (seen.has(key)) { console.log(`[Import] 중복 스킵: ${it.materialName} ${it.qty}`); continue; }
    fresh.push({ id: ++baseId, ...it });
    seen.add(key);
  }

  if (fresh.length === 0) { console.log("[Import] 추가할 내역 없음 (모두 중복)"); return; }

  // 4. 사용자 확인
  if (!confirm(`✅ 백업 다운로드 완료.\n\n신규 입고 ${fresh.length}건을 추가할까요?\n(중복 ${NEW_INTAKES.length - fresh.length}건은 자동 제외)`)) {
    console.log("[Import] 사용자 취소");
    return;
  }

  // 5. 클라우드에 저장
  const updated = { ...data, fabricIntakes: [...existing, ...fresh] };
  const saveRes = await fetch(FB_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updated),
  });
  if (!saveRes.ok) { console.error("[Import] 저장 실패", saveRes.status); alert("❌ 저장 실패: " + saveRes.status); return; }

  console.log(`[Import] ✅ 완료: ${fresh.length}건 추가됨 (총 ${updated.fabricIntakes.length}건)`);
  alert(`✅ ${fresh.length}건 추가 완료!\n\n새로고침하면 원단 입고현황 탭에서 확인할 수 있습니다.`);
  setTimeout(() => location.reload(), 800);
})();
