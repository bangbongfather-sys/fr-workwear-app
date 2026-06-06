// <Icon name="..."> 리터럴 + icon:"..." 데이터 필드가 ICON_PATHS에 전부 존재하는지 검증
import fs from "node:fs";
const src = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const reg = src.match(/const ICON_PATHS = \{([\s\S]*?)\n\};/);
if (!reg) { console.error("ICON_PATHS not found"); process.exit(2); }
const keys = new Set([...reg[1].matchAll(/^\s*([A-Za-z][\w]*):/gm)].map(m => m[1]));
console.log("ICON_PATHS keys:", keys.size);

const used = new Set([...src.matchAll(/<Icon\s+name="([^"]+)"/g)].map(m => m[1]));
// 동적 사용처에 들어가는 데이터 필드 값들 (icon:"name" / return "name" in fileIcon)
const dataIcons = new Set([...src.matchAll(/icon:\s*"([a-zA-Z][\w]*)"/g)].map(m => m[1]));

const missing = [...used].filter(n => !keys.has(n));
const missingData = [...dataIcons].filter(n => !keys.has(n));
console.log("literal <Icon name>:", used.size, missing.length ? "MISSING: " + missing.join(",") : "all OK");
console.log('icon:"..." fields:', dataIcons.size, missingData.length ? "MISSING: " + missingData.join(",") : "all OK");
process.exit(missing.length || missingData.length ? 1 : 0);
