// 직영점 매출 → 슬랙 자동 보고 (오후 3시 / 오후 11시 스케줄용).
//   홀=메타포스(실시간 확정) + 배달=푸드테크(실시간) 합산 = 오늘 실질매출.
// 발송: .env SLACK_WEBHOOK_URL (Incoming Webhook)  또는  SLACK_BOT_TOKEN + SLACK_CHANNEL
// 실행: node scripts/sales-slack.mjs            (발송)
//       node scripts/sales-slack.mjs --dry      (발송 안 하고 콘솔 미리보기만)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIRECT, salesByDate, pickDirect, detailByDate, splitKinds, today } from "./metapos.mjs";
import { deliveryRange } from "./foodtech.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");
const JSON_OUT = process.argv.includes("--json");
const dateArg = process.argv.find((a) => /^\d{8}$/.test(a));
function env() {
  const e = {};
  const f = path.join(ROOT, ".env");
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l); if (m) e[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, "$1"); }
  return { ...e, ...process.env };
}
const E = env();

const D = dateArg || today();
const nowH = new Date(Date.now() + 9 * 3600e3).getUTCHours(); // KST hour
const label = nowH < 18 ? "낮 (점심 마감 기준)" : "마감 (오늘 최종)";
const prevWeek = (() => { const d = new Date(+D.slice(0, 4), +D.slice(4, 6) - 1, +D.slice(6) - 7); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; })();
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const dowOf = (s) => DOW[new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)).getDay()];
const won = (n) => n.toLocaleString("ko-KR");
const man = (n) => Math.round(n / 10000).toLocaleString("ko-KR") + "만";

// 수집
const cur = pickDirect(await salesByDate(D, { noCache: true }));
const pw = pickDirect(await salesByDate(prevWeek));
const posKind = {};
await Promise.all(DIRECT.map(async (s) => { try { posKind[s.name] = splitKinds((await detailByDate(s.idx, D, { noCache: true })).rows); } catch { posKind[s.name] = null; } }));
let ftk = {};
try { ftk = await deliveryRange(D, D, { noCache: true }); } catch { /* 배달 조회 실패 시 홀만 */ }

const rows = DIRECT.map((s) => {
  const n = s.name, k = posKind[n], f = ftk[n];
  const 홀 = k?.홀 ?? 0, 포장 = k?.포장 ?? 0, 배달 = f?.배달 ?? 0, 배달건 = f ? f.건수 : null;
  const 실질 = 홀 + 포장 + 배달;
  const dead = 실질 === 0 && (배달건 === null || 배달건 === 0);
  return { n, 홀, 포장, 배달, 배달건, 실질, dead };
}).sort((a, b) => b.실질 - a.실질);

const T = rows.reduce((s, r) => ({ 홀: s.홀 + r.홀, 배달: s.배달 + r.배달, 포장: s.포장 + r.포장, 실질: s.실질 + r.실질 }), { 홀: 0, 배달: 0, 포장: 0, 실질: 0 });
const dead = rows.filter((r) => r.dead);

// 슬랙 메시지(mrkdwn)
const clock = new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16);
let lines = [];
lines.push(`*🍜 직영점 매출 — ${D.slice(0, 4)}.${D.slice(4, 6)}.${D.slice(6)}(${dowOf(D)}) ${clock} ${label}*`);
lines.push("");
for (const r of rows) {
  if (r.dead) { lines.push(`• *${r.n}*  ⚠️ 데이터 없음 (매장 점검)`); continue; }
  const share = r.실질 ? Math.round(r.배달 / r.실질 * 100) : 0;
  lines.push(`• *${r.n}*  ${won(r.실질)}  _(홀 ${man(r.홀)} · 배달 ${man(r.배달)} ${share}%)_`);
}
lines.push("");
lines.push(`*합계  ${won(T.실질)}*   홀 ${man(T.홀)} · 배달 ${man(T.배달)} · 포장 ${man(T.포장)}`);
if (dead.length) lines.push(`\n⚠️ *${dead.map((r) => r.n).join(", ")}* 매출 0 — 포스/영업 확인 필요`);
lines.push(`\n_배달은 배달앱 실접수 기준(마감 전 포스 미반영분 포함). 최종 정산은 마감 후 메타포스._`);
const text = lines.join("\n");

if (JSON_OUT) {
  console.log(JSON.stringify({ date: D, dow: dowOf(D), clock, label, rows, total: T, dead: dead.map((r) => r.n) }));
  process.exit(0);
}

console.log("\n──────── 슬랙 미리보기 ────────\n" + text.replace(/\*/g, "").replace(/_/g, "") + "\n───────────────────────────\n");

if (DRY) { console.log("(--dry: 발송 안 함)"); process.exit(0); }

// 발송
async function send() {
  if (E.SLACK_WEBHOOK_URL) {
    const r = await fetch(E.SLACK_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, mrkdwn: true }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Webhook 발송 실패 ${r.status}: ${await r.text()}`);
    return "webhook";
  }
  if (E.SLACK_BOT_TOKEN && E.SLACK_CHANNEL) {
    const r = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${E.SLACK_BOT_TOKEN}` }, body: JSON.stringify({ channel: E.SLACK_CHANNEL, text, mrkdwn: true }), signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!j.ok) throw new Error(`Slack API 실패: ${j.error}`);
    return "bot";
  }
  throw new Error(".env에 SLACK_WEBHOOK_URL (또는 SLACK_BOT_TOKEN + SLACK_CHANNEL) 없음");
}
try { const via = await send(); console.log(`✅ 슬랙 발송 완료 (${via})`); }
catch (e) { console.error("❌ " + e.message); process.exit(1); }
