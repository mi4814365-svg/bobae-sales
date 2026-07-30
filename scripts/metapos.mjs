// 메타포스(메타씨티 MagicERP) 매출 조회 클라이언트 — 2026-07-28 역추적·실측 검증.
//
// 구조:
//   클래식 ASP + ASPSESSIONID 쿠키. 비번 암호화 없음(평문 POST).
//   로그인 = POST /new/member/login_ok.asp { id, pw, cli:'p' }
//     ⚠️ cli='m'(모바일)이면 매장계정용 축소화면으로 빠짐 → 반드시 'p'
//   일별 매출 = GET /new/api/sales/today.asp?date=YYYYMMDD
//     → { rows:[ {STORE_IDX, STORE_NM, CNT, AMT, CARD, CASH, PUREAMT, VAT, ...35개 필드} ], ms }
//     날짜 무관하게 과거도 조회됨(이름만 'today'). 1~10초.
//   ⚠️ /new/api/sales/period.asp(기간합계)는 한 달치가 3분+ → 쓰지 말고 일별을 합산할 것.
//
// 검증(2026-06 직영점 vs 정산서): 대치·야탑·가산·판교 원 단위 일치.
//   강남 -44,000 / 구의 +579,900 / 방배 -599,500(+청년지원금 360만은 정산서가 매출에 가산) = 정산서 수기 입력 오차.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://smart.magicerp.co.kr";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CACHE = path.join(ROOT, "_metapos-cache");

// 직영점 7곳 STORE_IDX(실측 확정). ⚠️ '강남세곡점'은 별개 가맹점 — 이름 부분일치로 묶지 말 것.
export const DIRECT = [
  { name: "강남", idx: "I22101300015", full: "보배반점 강남점" },
  { name: "대치", idx: "I23092600017", full: "보배반점 대치점" },
  { name: "야탑", idx: "I22101800007", full: "보배반점 야탑점" },
  { name: "구의", idx: "I22101300009", full: "보배반점 구의점" },
  { name: "가산", idx: "I25040300004", full: "보배반점 가산점" },
  { name: "방배", idx: "I22092700006", full: "보배반점 방배점" },
  { name: "판교", idx: "I24092700010", full: "보배반점 판교테크노밸리점" },
];
export const IDX2NAME = Object.fromEntries(DIRECT.map((s) => [s.idx, s.name]));

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
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(";")[0], i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}
// 구형 ASP는 EUC-KR로 내려주기도 함 → 깨짐 감지해 자동 전환
function decode(buf, ct) {
  const cs = (/charset=([\w-]+)/i.exec(ct || "")?.[1] || "").toLowerCase();
  const dec = (e) => { try { return new TextDecoder(e).decode(buf); } catch { return null; } };
  if (cs && cs !== "utf-8") { const t = dec(cs); if (t) return t; }
  const u = dec("utf-8") ?? "";
  return (u.match(/�/g) || []).length > 3 ? (dec("euc-kr") ?? u) : u;
}

async function raw(url, opts = {}) {
  const res = await fetch(BASE + url, {
    method: opts.method ?? "GET",
    body: opts.body,
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeout ?? 90000),
    headers: {
      "User-Agent": UA, Accept: "application/json,text/plain,*/*",
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      Referer: BASE + "/new/dashboard.asp",
      ...(opts.headers ?? {}),
    },
  });
  absorb(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: decode(buf, res.headers.get("content-type")) };
}

let loggedIn = false;
export async function login() {
  if (loggedIn) return;
  const E = { ...loadEnv(), ...process.env };
  if (!E.METAPOS_ID || !E.METAPOS_PW) throw new Error(".env에 METAPOS_ID / METAPOS_PW 없음");
  await raw("/new/login.asp");
  const r = await raw("/new/member/login_ok.asp", {
    method: "POST",
    body: new URLSearchParams({ id: E.METAPOS_ID, pw: E.METAPOS_PW, cli: "p" }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  // 성공 시 302 → dashboard.asp. 로그인 화면으로 되돌면 실패.
  if (r.status !== 302 && r.status !== 200) throw new Error(`메타포스 로그인 실패 status=${r.status}`);
  loggedIn = true;
}

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

// 하루치 전 매장 매출. 과거 날짜는 파일 캐시(값이 더는 안 변함), 오늘은 항상 새로 받음.
export async function salesByDate(date, { noCache = false } = {}) {
  const cf = path.join(CACHE, `${date}.json`);
  const past = date < today();
  if (past && !noCache && fs.existsSync(cf)) {
    try { return JSON.parse(fs.readFileSync(cf, "utf8")); } catch { /* 깨진 캐시는 무시하고 재조회 */ }
  }
  await login();
  let last;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await raw(`/new/api/sales/today.asp?date=${date}`);
      const j = JSON.parse(r.text);
      if (!Array.isArray(j.rows)) throw new Error("rows 없음: " + r.text.slice(0, 120));
      if (past) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(j)); }
      return j;
    } catch (e) { last = e; }
  }
  throw new Error(`${date} 조회 실패: ${last?.message}`);
}

// 직영점만 뽑아 {강남:{AMT,CNT,...}, ...} 형태로
export function pickDirect(json) {
  const out = {};
  for (const row of json.rows ?? []) {
    const n = IDX2NAME[row.STORE_IDX];
    if (!n) continue;
    out[n] = {
      AMT: +row.AMT || 0, CNT: +row.CNT || 0, CARD: +row.CARD || 0, CASH: +row.CASH || 0,
      PUREAMT: +row.PUREAMT || 0, VAT: +row.VAT || 0, DC: +row.DC || 0,
    };
  }
  return out;
}

// ── 배달/홀/포장 분리 ────────────────────────────────────────────────────────
// 메타포스는 채널 필드(BM_AMT 등)를 안 쓰고 **TBL_NO(테이블명)에 배달 채널을 그대로 적어** 구분한다.
//   배달 = 쿠팡이츠(배달) / 배민배달(배달) / 배달의민족(배달) / 요기요(배달) / 요기배달 / 땡겨요 / 자체배달
//   포장 = 포장, 포장1, 포장5, 포장-1 …
//   홀   = 숫자, 선불N, R32, 선불A, 선불B(비) …
// ⚠️ 포스 기준 배달금액은 배달앱 사장님사이트의 '주문금액'보다 5~16% 큼(할인·쿠폰 차감 전).
//    총매출은 today.asp와 원 단위로 일치 검증됨(대치 26년6월 192,928,800).
const DELIVERY_RE = /배달|쿠팡이츠|배민|요기요|요기배달|땡겨요|먹깨비|위메프|배달특급/;
const TAKEOUT_RE = /^포장/;
const CHANNELS = [[/쿠팡/, "쿠팡이츠"], [/자체배달/, "자체배달"], [/배민|배달의민족/, "배민"], [/요기/, "요기요"], [/땡겨요/, "땡겨요"], [/먹깨비/, "먹깨비"], [/위메프/, "위메프오"]];
export function channelOf(tblNo) {
  const k = String(tblNo ?? "").trim();
  if (TAKEOUT_RE.test(k)) return { kind: "포장", ch: null };
  if (DELIVERY_RE.test(k)) {
    for (const [re, n] of CHANNELS) if (re.test(k)) return { kind: "배달", ch: n };
    return { kind: "배달", ch: "기타배달" };
  }
  return { kind: "홀", ch: null };
}

// 매장·날짜별 영수증 상세(배달 구분용). 무거워서(2~11초) 과거분은 반드시 캐시.
export async function detailByDate(storeIdx, date, { noCache = false } = {}) {
  const dir = path.join(CACHE, "detail");
  const cf = path.join(dir, `${storeIdx}-${date}.json`);
  const past = date < today();
  if (past && !noCache && fs.existsSync(cf)) {
    try { return JSON.parse(fs.readFileSync(cf, "utf8")); } catch { /* 깨진 캐시 무시 */ }
  }
  await login();
  let last;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await raw(`/new/api/sales/today-detail.asp?storeIdx=${storeIdx}&date=${date}`, { timeout: 150000 });
      const j = JSON.parse(r.text);
      if (!Array.isArray(j.rows)) throw new Error("rows 없음");
      if (past) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(j)); }
      return j;
    } catch (e) { last = e; }
  }
  throw new Error(`${storeIdx} ${date} 상세 조회 실패: ${last?.message}`);
}

// 영수증 rows → {배달, 포장, 홀, 전체, 채널별{}}
export function splitKinds(rows) {
  const out = { 배달: 0, 포장: 0, 홀: 0, 전체: 0, 채널별: {}, 배달건수: 0, 홀건수: 0 };
  for (const x of rows ?? []) {
    const amt = +x.SAL_AMT || 0;
    const { kind, ch } = channelOf(x.TBL_NO);
    out.전체 += amt;
    out[kind] += amt;
    if (kind === "배달") { out.채널별[ch] = (out.채널별[ch] ?? 0) + amt; out.배달건수++; }
    else if (kind === "홀") out.홀건수++;
  }
  return out;
}

// 기간 일별 조회(동시 3개 — 서버가 느려서 과하게 때리면 타임아웃 남)
export async function salesRange(dates, onProgress) {
  const result = {};
  let done = 0;
  const work = async (d) => {
    result[d] = pickDirect(await salesByDate(d));
    onProgress?.(++done, dates.length, d);
  };
  for (let i = 0; i < dates.length; i += 3) await Promise.all(dates.slice(i, i + 3).map(work));
  return result;
}

// 여러 매장 × 여러 날짜의 배달/홀 분리. 동시 4개.
// 반환: { [날짜]: { [매장명]: {배달,포장,홀,전체,채널별} } }
export async function kindsRange(stores, dates, onProgress) {
  const jobs = [];
  for (const d of dates) for (const s of stores) jobs.push([d, s]);
  const out = {};
  let done = 0;
  const work = async ([d, s]) => {
    try {
      const j = await detailByDate(s.idx, d);
      (out[d] ??= {})[s.name] = splitKinds(j.rows);
    } catch { (out[d] ??= {})[s.name] = null; }
    onProgress?.(++done, jobs.length);
  };
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(work));
  return out;
}

// YYYYMM → 그 달의 날짜 배열(미래 날짜는 제외)
export function monthDates(ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(4, 6);
  const last = new Date(y, m, 0).getDate();
  const t = today();
  const out = [];
  for (let d = 1; d <= last; d++) {
    const s = `${ym}${String(d).padStart(2, "0")}`;
    if (s <= t) out.push(s);
  }
  return out;
}
export { today };
