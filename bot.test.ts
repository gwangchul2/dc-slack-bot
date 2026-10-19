import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, appendFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { Ledger, acquireLock } from "./bot-state.js";
import { collectSource, deliverOnce, sendFirstPage, sendRecentPages, matchesKeyword, type Post, type Source } from "./bot-core.js";

const source: Source = { key: "naver:1", kind: "naver", name: "테스트", url: "https://cafe.naver.com/test", clubId: "1" };
const post = (id: number, title = "말톡 후기", notice = false): Post => ({ id, title, notice, link: `https://example.com/${id}` });
async function fixture(run: (dir: string, ledger: Ledger) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "travel-bot-test-"));
  try { await run(dir, await Ledger.load(dir)); }
  finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("travel-bot-test-"));
    await rm(dir, { recursive: true, force: true });
  }
}

test("only the seven brand keywords match", () => {
  for (const title of ["유심사", "유심사후기", "로밍도깨비", "와이파이도시락", "도시락이심", "말톡", "이심이지"]) assert.ok(matchesKeyword(title));
  for (const title of ["일본 유심 추천", "이심 질문", "eSIM", "로깨비", "로밍망", "로컬망"]) assert.equal(matchesKeyword(title), false);
});
test("explicit first page sends baseline-only matches once and preserves existing cursor", () => fixture(async (dir, ledger) => {
  await ledger.cursor(source.key, 20);
  let sent = 0;
  const rows = [post(25), post(19), post(19), post(18, "유심 질문"), post(1, "말톡 공지", true)];
  await sendFirstPage(source, ledger, rows, async () => { sent++; });
  await sendFirstPage(source, await Ledger.load(dir), rows, async () => { sent++; });
  assert.equal(sent, 2);
  assert.equal(ledger.cursors.get(source.key), 20);
}));
test("first page excludes legacy checked IDs and initializes a new source", () => fixture(async (_dir, ledger) => {
  let sent = 0;
  const result = await sendFirstPage(source, ledger, [post(12), post(11)], async () => { sent++; }, new Set([11]));
  assert.equal(sent, 1);
  assert.deepEqual(result, { matched: 2, sent: 1 });
  assert.equal(ledger.cursors.get(source.key), 12);
}));
test("legacy high-water mark blocks older alerts whose exact records were pruned", () => fixture(async (_dir, ledger) => {
  let sent = 0;
  await sendFirstPage(source, ledger, [post(101), post(99), post(1)], async () => { sent++; }, new Set([100]), 100);
  assert.equal(sent, 1);
  assert.ok(!ledger.attempts.has(`${source.key}:99`));
}));
test("Slack success followed by outcome write failure never causes a resend", () => fixture(async (dir, ledger) => {
  let sent = 0;
  ledger.outcome = async () => { throw new Error("result write failed after Slack receipt"); };
  await assert.rejects(deliverOnce(ledger, `${source.key}:99`, "test", async () => { sent++; }));
  await deliverOnce(await Ledger.load(dir), `${source.key}:99`, "test", async () => { sent++; });
  assert.equal(sent, 1);
}));
test("manual backfill reads exactly ten pages and never sends older history", () => fixture(async (dir, ledger) => {
  await ledger.cursor(source.key, 1);
  const pages: number[] = [];
  let sent = 0;
  const read = async (page: number) => { pages.push(page); return [post(100 - page)]; };
  await sendRecentPages(source, ledger, read, async () => { sent++; }, 10);
  assert.deepEqual(pages, [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(sent, 10);
  assert.equal(ledger.cursors.get(source.key), 99);
  await sendRecentPages(source, await Ledger.load(dir), read, async () => { sent++; }, 10);
  assert.equal(sent, 10);
  await assert.rejects(sendRecentPages(source, ledger, read, async () => assert.fail(), 21));
}));
test("backfill only expands to twenty when no unattempted matches exist in ten pages", () => fixture(async (_dir, ledger) => {
  const visited: number[] = [];
  let sent = 0;
  const result = await sendRecentPages(source, ledger, async page => {
    visited.push(page);
    return [post(200 - page, page === 15 ? "유심사 후기" : "일본 여행")];
  }, async () => { sent++; }, 10, new Set(), 20);
  assert.equal(result.pagesRead, 20);
  assert.equal(visited.length, 20);
  assert.equal(sent, 1);
}));
test("backfill with a matching post stops at ten and skips duplicate rows", () => fixture(async (_dir, ledger) => {
  let sent = 0;
  const result = await sendRecentPages(source, ledger, async page => [post(200 - page), post(200 - page)], async () => { sent++; }, 10, new Set(), 20);
  assert.equal(result.pagesRead, 10);
  assert.equal(sent, 10);
}));
test("new source baselines without sending historical posts or notices", () => fixture(async (dir, ledger) => {
  let sent = 0;
  await collectSource(source, ledger, async () => [post(999, "말톡", true), post(12), post(11)], async () => { sent++; }, 3);
  assert.equal(sent, 0);
  assert.equal((await Ledger.load(dir)).cursors.get(source.key), 12);
}));
test("same article in duplicate rows and on later runs sends once", () => fixture(async (dir, ledger) => {
  await ledger.cursor(source.key, 10);
  let sent = 0;
  const read = async () => [post(12, "유심사후기 말톡"), post(12), post(10)];
  await collectSource(source, ledger, read, async () => { sent++; }, 3);
  await collectSource(source, await Ledger.load(dir), read, async () => { sent++; }, 3);
  assert.equal(sent, 1);
}));
test("pagination ignores pinned notices and deduplicates overlapping pages", () => fixture(async (_dir, ledger) => {
  await ledger.cursor(source.key, 10);
  let sent = 0;
  const pages = [[post(1, "말톡", true), post(14), post(13)], [post(13), post(12), post(10)]];
  await collectSource(source, ledger, async n => pages[n - 1], async () => { sent++; }, 3);
  assert.equal(sent, 3);
  assert.equal(ledger.cursors.get(source.key), 14);
}));
test("ambiguous delivery is persisted and never automatically retried", () => fixture(async (dir, ledger) => {
  let attempts = 0;
  const send = async () => { attempts++; throw new Error("timeout after receipt"); };
  await deliverOnce(ledger, "naver:1:12", "test", send);
  await deliverOnce(await Ledger.load(dir), "naver:1:12", "test", send);
  assert.equal(attempts, 1);
  assert.equal((await Ledger.load(dir)).outcomes.get("naver:1:12"), "uncertain");
}));
test("crash after reservation blocks a second delivery after restart", () => fixture(async (dir, ledger) => {
  await ledger.reserve("naver:1:12");
  assert.equal(await deliverOnce(await Ledger.load(dir), "naver:1:12", "test", async () => assert.fail()), false);
}));
test("identity includes platform and cafe ID", () => fixture(async (_dir, ledger) => {
  for (const key of ["naver:1:12", "naver:2:12", "dc:china:12"]) assert.ok(await ledger.reserve(key));
}));
test("simultaneous attempts for the same key send only once", () => fixture(async (_dir, ledger) => {
  let sent = 0;
  const send = async () => { sent++; };
  await Promise.all(Array.from({ length: 10 }, () => deliverOnce(ledger, "naver:1:12", "test", send)));
  assert.equal(sent, 1);
}));
test("unordered lists never advance the cursor or send", () => fixture(async (_dir, ledger) => {
  await ledger.cursor(source.key, 10);
  await assert.rejects(collectSource(source, ledger, async () => [post(11), post(14), post(10)], async () => assert.fail(), 3), /최신순/);
  assert.equal(ledger.cursors.get(source.key), 10);
}));
test("page cap preserves cursor and reservations prevent duplicates on recovery", () => fixture(async (dir, ledger) => {
  await ledger.cursor(source.key, 10);
  let sent = 0;
  await assert.rejects(collectSource(source, ledger, async () => [post(14), post(13)], async () => { sent++; }, 1), /MAX_PAGES/);
  const recovered = await Ledger.load(dir);
  assert.equal(recovered.cursors.get(source.key), 10);
  await collectSource(source, recovered, async n => n === 1 ? [post(14), post(13)] : [post(12), post(10)], async () => { sent++; }, 2);
  assert.equal(sent, 3);
}));
test("repeating pagination fails without moving the cursor", () => fixture(async (_dir, ledger) => {
  await ledger.cursor(source.key, 10);
  await assert.rejects(collectSource(source, ledger, async () => [post(12)], async () => {}, 3), /반복/);
  assert.equal(ledger.cursors.get(source.key), 10);
}));
test("dry run never changes production ledger", () => fixture(async (dir, _ledger) => {
  const before = await readFile(join(dir, "notifications.jsonl"), "utf8");
  const dry = await Ledger.load(dir, true);
  await dry.cursor(source.key, 100);
  await deliverOnce(dry, "naver:1:101", "test", async () => {});
  assert.equal(await readFile(join(dir, "notifications.jsonl"), "utf8"), before);
}));
test("corrupt or torn ledger fails closed", () => fixture(async (dir, _ledger) => {
  await appendFile(join(dir, "notifications.jsonl"), '{"type":"attempt"');
  await assert.rejects(Ledger.load(dir), /불완전/);
}));
test("missing initialized ledger fails closed", () => fixture(async (dir, _ledger) => {
  await unlink(join(dir, "notifications.jsonl"));
  await assert.rejects(Ledger.load(dir), /사라졌/);
}));
test("failed reservation prevents webhook and blocks further writes", () => fixture(async (dir, ledger) => {
  // Replace journal with directory to deterministically cause append failure on every OS.
  await unlink(join(dir, "notifications.jsonl"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "notifications.jsonl"));
  await assert.rejects(deliverOnce(ledger, "naver:1:12", "test", async () => assert.fail()));
  assert.equal(ledger.healthy, false);
  await assert.rejects(ledger.reserve("naver:1:13"));
}));
test("exclusive process lock blocks concurrent runs; release allows next run", () => fixture(async (dir, _ledger) => {
  const release = await acquireLock(dir);
  try { await assert.rejects(acquireLock(dir), /중복 실행/); } finally { await release(); }
  await (await acquireLock(dir))();
}));
