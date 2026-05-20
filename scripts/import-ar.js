// ============================================================
// 거래처별 미수금 (AR) 일괄 추가 스크립트
// 사용법:
//   1. 웹앱 (https://fr-workwear-app.njsafety91.workers.dev/) 열기
//   2. F12 → Console
//   3. 콘솔에 "allow pasting" 입력 → Enter
//   4. 아래 코드 전체 복사 → 붙여넣기 → Enter
// ============================================================
(async () => {
  const FB_URL = "https://njsafety-2ee24-default-rtdb.asia-southeast1.firebasedatabase.app/frw.json";

  // 추가할 미수금 내역
  // 각 entry: { type: "청구"|"입금", desc, amount(절대값), date }
  // 입금은 절대값으로 입력 (잔액 계산은 자동으로 청구-입금)
  const NEW_AR = {
    "선인안전산업": [
      { type: "청구", desc: "26년 3월",   amount: 13742300, date: "" },
      { type: "청구", desc: "26년 4월",   amount: 10994500, date: "" },
      { type: "입금", desc: "2026-04-19", amount: 5000000,  date: "2026-04-19" },
    ],
    "삼원툴": [
      { type: "청구", desc: "26년 01월",      amount: 3183300, date: "" },
      { type: "청구", desc: "26년 02월",      amount: 365200,  date: "" },
      { type: "입금", desc: "26년 03월 10일", amount: 2917200, date: "2026-03-10" },
      { type: "청구", desc: "26년 3월",       amount: 6234800, date: "" },
      { type: "입금", desc: "2026-04-07",     amount: 1144000, date: "2026-04-07" },
    ],
    "장안산업(주)": [
      { type: "청구", desc: "25년 12월", amount: 8170800, date: "" },
    ],
  };

  console.log("[Import-AR] 시작");
  const res = await fetch(FB_URL);
  if (!res.ok) { console.error("로드 실패"); return; }
  const data = await res.json() || {};
  const cur = data.clientAR || {};

  // 자동 백업 다운로드
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `frw_backup_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
  console.log("[Import-AR] 백업 다운로드 완료");

  // 거래처명 fuzzy 매칭 (정확 매칭 → 부분 매칭 순)
  const allKeys = Object.keys(cur);
  const findKey = (target) => {
    if (cur[target]) return target;
    // 부분 매칭 (target이 key에 포함되거나 그 반대)
    const hit = allKeys.find(k =>
      k.replace(/[\s()㈜주식회사]/g, "") === target.replace(/[\s()㈜주식회사]/g, "") ||
      k.includes(target) || target.includes(k)
    );
    return hit || target;  // 없으면 새로 만들기
  };

  const next = { ...cur };
  let totalAdded = 0;
  let totalSkipped = 0;
  const summary = [];

  for (const [name, entries] of Object.entries(NEW_AR)) {
    const key = findKey(name);
    const existing = (next[key] && next[key].entries) || [];
    const seen = new Set(existing.map(e => `${e.type}|${e.amount}|${e.desc}|${e.date||""}`));
    const fresh = [];
    let baseId = Date.now() + Math.floor(Math.random()*1000);
    for (const e of entries) {
      const sig = `${e.type}|${e.amount}|${e.desc}|${e.date||""}`;
      if (seen.has(sig)) { totalSkipped++; continue; }
      fresh.push({ id: ++baseId, ...e });
      seen.add(sig);
    }
    if (fresh.length > 0) {
      next[key] = { entries: [...existing, ...fresh] };
      totalAdded += fresh.length;
      summary.push(`  ${key}: +${fresh.length}건 (기존 ${existing.length}건)`);
    } else {
      summary.push(`  ${key}: 모두 중복 (스킵)`);
    }
  }

  console.log(`[Import-AR] 매칭 결과:\n${summary.join("\n")}`);
  console.log(`[Import-AR] 추가 ${totalAdded}건, 중복 스킵 ${totalSkipped}건`);

  if (totalAdded === 0) { alert("추가할 항목이 없습니다 (모두 중복)"); return; }

  if (!confirm(`📂 백업 다운로드 완료\n\n다음 항목을 추가합니다:\n${summary.join("\n")}\n\n총 ${totalAdded}건 추가 (중복 ${totalSkipped}건 제외)\n진행할까요?`)) {
    console.log("취소됨");
    return;
  }

  // PATCH 사용 (다른 필드 보존)
  // 2026-05-14: PUT → PATCH 변경. PUT 은 전체 노드 교체로 ledgers 등 데이터 손실 위험.
  const saveRes = await fetch(FB_URL, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientAR: next }),
  });
  if (!saveRes.ok) { alert("❌ 저장 실패: " + saveRes.status); return; }

  alert(`✅ ${totalAdded}건 추가 완료!\n\n장부 → 거래처별 미수금 탭에서 확인하세요.`);
  setTimeout(() => location.reload(), 800);
})();
