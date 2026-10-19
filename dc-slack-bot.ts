import * as pw from "playwright";
import fetch from "node-fetch";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { acquireLock, Ledger } from "./bot-state.js";
import { collectSource, sendRecentPages, type Source } from "./bot-core.js";
import { readPosts } from "./collectors.js";
import { SOURCES } from "./sources.js";
dotenv.config();

const directory = fileURLToPath(new URL("./.state/", import.meta.url));
const dryRun = process.env.TEST_MODE === "true";
const audit = process.argv.includes("--audit");
const firstPage = process.argv.includes("--send-first-page");
const sendPagesArgument = process.argv.find(argument => argument.startsWith("--send-pages="));
const sendPages = sendPagesArgument ? Number(sendPagesArgument.split("=")[1]) : firstPage ? 1 : 0;
const extendIfEmpty = process.argv.includes("--extend-if-empty");

async function migrateLegacy(ledger: Ledger, sources: Source[]) {
  let raw: string;
  try { raw = await readFile(new URL("./.state/dc_checked.json", import.meta.url), "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return {}; throw error; }
  const legacy = JSON.parse(raw);
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error("기존 상태 파일이 손상되었습니다.");
  for (const source of sources.filter(item => item.kind === "dc")) {
    if (ledger.cursors.has(source.key) || legacy[source.name] === undefined) continue;
    const ids = legacy[source.name];
    if (!Array.isArray(ids) || ids.some(id => !/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id))))
      throw new Error("기존 상태 파일 오류: " + source.name);
    if (ids.length) await ledger.cursor(source.key, Math.max(...ids.map(Number)));
  }
  return legacy;
}

async function main() {
  if (audit && (firstPage || sendPagesArgument)) throw new Error("audit과 실제 전송을 동시에 실행할 수 없습니다.");
  if (sendPagesArgument && (!Number.isInteger(sendPages) || sendPages < 1 || sendPages > 20)) throw new Error("수동 수집은 최대 20페이지까지만 허용합니다.");
  if (extendIfEmpty && sendPages !== 10) throw new Error("조건부 확장은 --send-pages=10과 함께 사용하세요.");
  // A local lock cannot coordinate with another machine or ephemeral CI checkout.
  if (process.env.GITHUB_ACTIONS === "true") throw new Error("GitHub Actions 전송 차단: 영구 원장을 사용하는 Windows 작업으로 실행하세요.");
  const limit = Number(process.env.MAX_PAGES ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("MAX_PAGES는 1~1000 정수여야 합니다.");
  const keys = process.env.SOURCE_KEYS?.split(",").map(value => value.trim()).filter(Boolean);
  const sources = SOURCES.filter(source => !keys || keys.includes(source.key));
  if (!sources.length || keys?.some(key => !SOURCES.some(source => source.key === key))) throw new Error("SOURCE_KEYS가 올바르지 않습니다.");
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!dryRun && !audit && !webhook) throw new Error("SLACK_WEBHOOK_URL이 필요합니다.");
  const release = await acquireLock(directory);
  let browser: pw.Browser | undefined;
  try {
    const ledger = audit ? undefined : await Ledger.load(directory, dryRun);
    const legacy = ledger ? await migrateLegacy(ledger, sources) : {};
    browser = await pw.chromium.launch({ headless: true });
    // Fresh anonymous context: no personal account, saved cookies, or login.
    const context = await browser.newContext();
    const page = await context.newPage();
    let sent = 0;
    let failures = 0;
    for (const source of sources) {
      console.log("\n[" + source.name + "] " + source.key);
      try {
        if (audit) {
          const posts = await readPosts(page, source, 1);
          const ordinary = posts.filter(post => !post.notice);
          if (!ordinary.length) throw new Error("일반 글을 찾지 못했습니다.");
          if (ordinary.some((post, i) => i > 0 && post.id > ordinary[i - 1].id)) throw new Error("최신순 정렬을 확인하지 못했습니다.");
          const second = (await readPosts(page, source, 2)).filter(post => !post.notice);
          const firstIds = new Set(ordinary.map(post => post.id));
          if (!second.length || second.every(post => firstIds.has(post.id))) throw new Error("페이지 2 이동을 확인하지 못했습니다.");
          console.log(JSON.stringify({ source: source.key, url: page.url(), ordinary: ordinary.length, page2: second.length, sample: ordinary.slice(0, 2) }));
        } else {
          const send = async (message: string) => {
            if (dryRun) { console.log("[테스트: 실제 전송 없음] " + message); return; }
            // No automatic retries. Durable reservation precedes the request.
            const response = await fetch(webhook!, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: message }), signal: AbortSignal.timeout(15000),
            });
            if (!response.ok || (await response.text()).trim() !== "ok") throw new Error("슬랙 응답 불확실");
          };
          if (sendPages) {
            const checked = new Set<number>(source.kind === "dc" ? (legacy[source.name] ?? []).map(Number) : []);
            // Old DC state kept only 200 entries. IDs below its high-water mark may
            // have been notified before pruning, so never backfill that history.
            const legacyFloor = checked.size ? Math.max(...checked) : 0;
            const result = await sendRecentPages(source, ledger!, number => readPosts(page, source, number), send, sendPages, checked, extendIfEmpty ? 20 : sendPages, legacyFloor);
            sent += result.sent;
            console.log(`  1~${result.pagesRead}페이지 키워드 일치 ${result.matched}개, ${dryRun ? "테스트" : "전송"} ${result.sent}개`);
          } else {
            sent += await collectSource(source, ledger!, number => readPosts(page, source, number), send, limit);
          }
        }
      } catch (error) {
        if (ledger && !ledger.healthy) throw error;
        failures++;
        console.error(source.name + ": " + (error instanceof Error ? error.message : "수집 실패"));
      }
    }
    const uncertain = ledger ? [...ledger.outcomes.values()].filter(outcome => outcome !== "sent").length : 0;
    console.log("\n완료: " + (dryRun ? "테스트 일치 " : "전송 ") + sent + "개, 수집 오류 " + failures + "곳, 전송 결과 미확정 " + uncertain + "개");
    if (failures || uncertain) process.exitCode = 1;
  } finally {
    try { await browser?.close(); } finally { await release(); }
  }
}
main().catch(error => {
  // Never log webhook URLs, response bodies, or credentials.
  console.error(error instanceof Error ? error.message : "실행 실패");
  process.exitCode = 1;
});
