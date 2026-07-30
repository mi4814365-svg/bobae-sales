// 푸드테크(smartone plus, smartoneplus.ftk.kr) — 직영점 '배달' 통합 POS 조회.
//   메타포스는 배달앱 주문을 이 푸드테크 미들웨어를 통해 받는다(배민·쿠팡·요기요·땡겨요 통합).
//   2026-07-28 직영점 배달연동 장애 때 메타포스엔 배달이 안 찍혔지만 여기엔 실주문이 그대로 남음
//   → '배달 매출의 정본' + '메타포스 배달 누락 감지'용.
//
// 구조(2026-07-28 역추적):
//   로그인 = POST /login {userId, userPwd}  (평문, JSON 응답 {code:"200"}), 쿠키 SERVERID+JSESSIONID
//   배달 = GET /api/srv0020/brands/{brandCd}/onlines?operDtFrom=YYYYMMDD&operDtTo=YYYYMMDD
//     → content[]: { itemKey:strCd, itemValue:매장명, total:{totalSalesAmt,totalSalesCount,...},
//                    dataSet:{ "쿠팡이츠":{totalSalesAmt,totalSalesCount}, "배민배달":{...}, ... } }
//     ⚠️ 기간 한 번에 전 매장 반환(6월 전체 157매장 ≈ 38초). 일별로 나눠 부를 필요 없음.
//   ⚠️ totalSalesAmt는 메타포스 배달금액(TBL_NO 기준)과 5~8% 차이(정의 상이) — 총매출 정본은 메타포스.
//      여기 값은 배달 '건수·채널구성·누락 여부' 판정에 신뢰.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const B = "http://smartoneplus.ftk.kr";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 직영점 strCd(푸드테크). ⚠️ 강남='강남직영점'(bbbj083) — '강남세곡' 아님.
export const FTK_STORES = {
  강남: "bbbj083", 대치: "bbbj164", 야탑: "bbbj001",
  구의: "bbbj002", 가산: "bbbj199", 방배: "bbbj113", 판교: "bbbj186",
};
const STRCD2NAME = Object.fromEntries(Object.entries(FTK_STORES).map(([k, v]) => [v, k]));

function loadEnv() {
  const env = {};
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return env;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return env;
}

const jar = new Map();
const absorb = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(";")[0], i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); } };
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

async function raw(u, opts = {}) {
  const r = await fetch(B + u, {
    method: opts.method ?? "GET", body: opts.body, redirect: "manual", signal: AbortSignal.timeout(opts.timeout ?? 90000),
    headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), Cookie: cookie(), ...(opts.headers ?? {}) },
  });
  absorb(r);
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* HTML=에러/미로그인 */ }
  return { status: r.status, text: t, json: j };
}

let loggedIn = false, BRAND = null;
export async function login() {
  if (loggedIn) return;
  const E = { ...loadEnv(), ...process.env };
  if (!E.FTK_ID || !E.FTK_PW) throw new Error(".env에 FTK_ID / FTK_PW 없음");
  BRAND = E.FTK_BRAND || "101058";
  await raw("/login");
  const r = await raw("/login", { method: "POST", body: new URLSearchParams({ userId: E.FTK_ID, userPwd: E.FTK_PW }).toString() });
  if (r.json?.code !== "200") throw new Error(`푸드테크 로그인 실패: ${r.json?.message ?? r.status}`);
  loggedIn = true;
}

const CACHE = path.join(ROOT, "_metapos-cache", "ftk");
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

// 브랜드 전 매장 배달(기간). 반환: { [매장명]: {배달:금액, 건수, 채널별:{쿠팡이츠,배민,...}} } — 직영점만.
// past(오늘 미포함) 기간은 캐시. 오늘 포함이면 새로 받음.
export async function deliveryRange(fromDt, toDt, { noCache = false } = {}) {
  const cf = path.join(CACHE, `${fromDt}-${toDt}.json`);
  const past = toDt < today();
  if (past && !noCache && fs.existsSync(cf)) {
    try { return JSON.parse(fs.readFileSync(cf, "utf8")); } catch { /* 깨진 캐시 무시 */ }
  }
  await login();
  const r = await raw(`/api/srv0020/brands/${BRAND}/onlines?operDtFrom=${fromDt}&operDtTo=${toDt}`, { timeout: 120000 });
  const rows = r.json?.data?.result?.content;
  if (!Array.isArray(rows)) throw new Error(`푸드테크 배달 조회 실패(${fromDt}~${toDt}): ${r.text.slice(0, 100)}`);
  const out = {};
  for (const row of rows) {
    const n = STRCD2NAME[row.itemKey];
    if (!n) continue;
    const ch = {};
    for (const [k, v] of Object.entries(row.dataSet ?? {})) {
      if ((v.totalSalesCount ?? 0) > 0 || (v.totalSalesAmt ?? 0) > 0) ch[normCh(k)] = { 금액: v.totalSalesAmt ?? 0, 건수: v.totalSalesCount ?? 0 };
    }
    out[n] = { 배달: row.total?.totalSalesAmt ?? 0, 건수: row.total?.totalSalesCount ?? 0, 채널별: ch };
  }
  if (past) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(out)); }
  return out;
}

// 채널명 표준화(메타포스 쪽과 맞춤)
function normCh(k) {
  if (/쿠팡/.test(k)) return "쿠팡이츠";
  if (/배민|배달의민족/.test(k)) return "배민";
  if (/요기/.test(k)) return "요기요";
  if (/땡겨요/.test(k)) return "땡겨요";
  if (/먹깨비/.test(k)) return "먹깨비";
  if (/위메프/.test(k)) return "위메프오";
  return k;
}

export { today };
