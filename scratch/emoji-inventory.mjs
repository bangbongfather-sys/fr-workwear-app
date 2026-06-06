// 이모지 사용 라인 인벤토리 (토스 ② 이모지→Lucide 교체 스코핑용)
import fs from "node:fs";
const lines = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8").split("\n");
const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
const all = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;
const out = [];
const freq = {};
lines.forEach((l, i) => {
  if (!re.test(l)) return;
  const emojis = l.match(all) || [];
  emojis.forEach(e => { freq[e] = (freq[e] || 0) + 1; });
  out.push(`${i + 1}\t${[...new Set(emojis)].join("")}\t${l.trim().slice(0, 130)}`);
});
console.log("EMOJI LINES:", out.length);
console.log("FREQ:", Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}x${n}`).join(" "));
console.log(out.join("\n"));
