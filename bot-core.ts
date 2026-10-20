import { Ledger } from "./bot-state.js";

export const KEYWORDS = ["유심사", "유심사후기", "로밍도깨비", "와이파이도시락", "도시락이심", "말톡", "이심이지", "esim"];
export interface Post { id: number; title: string; link: string; notice: boolean }
export interface Source { key: string; name: string; kind: "dc" | "naver"; url: string; clubId?: string }
export const matchesKeyword = (title: string) => KEYWORDS.some(word => title.toLowerCase().includes(word.toLowerCase()));

// Filter the recurring campaign header only in Osaka Holic; keep ordinary reviews.
export const shouldNotify = (source: Source, title: string) => matchesKeyword(title) && !(
  source.key === "naver:20421433" && /^\s*\[[^\p{L}\p{N}]*유심사\s*단독\s*프로모션\s*\]/u.test(title.normalize("NFKC"))
);

export function formatAlert(source: Source, post: Post): string {
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const label = source.kind === "dc" ? "🟧 [디시]" : "🟩 [네이버 카페]";
  const keywords = KEYWORDS.filter(word => post.title.toLowerCase().includes(word.toLowerCase()));
  return `${label} *${escape(source.name)}*\n> ${escape(post.title)}\n🔎 ${keywords.join(" · ")} · <${post.link}|원문 보기>`;
}

export async function deliverOnce(ledger: Ledger, key: string, message: string, send: (text: string) => Promise<void>) {
  if (!await ledger.reserve(key)) return false;
  // Never retry an ambiguous webhook request, including errors/timeouts/non-2xx responses.
  try { await send(message); }
  catch {
    await ledger.outcome(key, "uncertain");
    console.error(`⚠️ 전송 결과 불확실 (자동 재전송 금지): ${key}`);
    return false;
  }
  await ledger.outcome(key, "sent");
  return true;
}

// Explicit operator-requested backfill of the currently visible first page.
// A baseline cursor does not mean an alert was sent; the durable attempt ledger does.
export async function sendFirstPage(source: Source, ledger: Ledger, rows: Post[], send: (text: string) => Promise<void>, legacyChecked = new Set<number>(), legacyFloor = 0) {
  const posts = rows.filter(post => !post.notice);
  if (!posts.length || posts.some((post, i) => i > 0 && post.id > posts[i - 1].id))
    throw new Error(`${source.name}: 최신순 일반 글을 확인하지 못했습니다.`);
  const unique = [...new Map(posts.map(post => [post.id, post])).values()];
  const matches = unique.filter(post => shouldNotify(source, post.title));
  let sent = 0;
  for (const post of matches) {
    if (post.id <= legacyFloor || legacyChecked.has(post.id)) continue;
    if (await deliverOnce(ledger, `${source.key}:${post.id}`, formatAlert(source, post), send)) sent++;
  }
  // Do not move an established cursor over pages we did not read.
  if (!ledger.cursors.has(source.key)) await ledger.cursor(source.key, Math.max(...posts.map(post => post.id)));
  return { matched: matches.length, sent };
}

export async function sendRecentPages(source: Source, ledger: Ledger, readPage: (page: number) => Promise<Post[]>, send: (text: string) => Promise<void>, count: number, legacyChecked = new Set<number>(), fallbackCount = count, legacyFloor = 0) {
  if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(fallbackCount) || fallbackCount < count || fallbackCount > 20)
    throw new Error("최초 수동 수집은 최대 20페이지만 허용합니다.");
  // Once a source has been scanned, even manual runs must only alert newer IDs.
  // Keyword additions and title edits must not resurrect previously scanned history.
  const alertFloor = Math.max(legacyFloor, ledger.cursors.get(source.key) ?? 0);
  const posts = new Map<number, Post>();
  const pageSignatures = new Set<string>();
  let pagesRead = 0;
  for (let number = 1; number <= fallbackCount; number++) {
    const rows = (await readPage(number)).filter(post => !post.notice);
    if (!rows.length || rows.some((post, i) => i > 0 && post.id > rows[i - 1].id))
      throw new Error(`${source.name}: ${number}페이지의 최신순 일반 글을 확인하지 못했습니다.`);
    const signature = rows.map(post => post.id).join(",");
    if (pageSignatures.has(signature)) throw new Error(`${source.name}: 페이지가 반복됩니다.`);
    pageSignatures.add(signature);
    rows.forEach(post => posts.set(post.id, post));
    pagesRead = number;
    console.log(`  ${number}페이지 확인 (${rows.length}개 일반 글)`);
    if (number === count) {
      const eligible = [...posts.values()].some(post => post.id > alertFloor && shouldNotify(source, post.title) && !legacyChecked.has(post.id) && !ledger.attempts.has(`${source.key}:${post.id}`));
      if (eligible) break;
      if (fallbackCount > count) console.log(`  ${count}페이지 내 미전송 키워드 글 없음 → ${fallbackCount}페이지까지 확장`);
    }
  }
  const rows = [...posts.values()].sort((a, b) => b.id - a.id);
  const result = await sendFirstPage(source, ledger, rows, send, legacyChecked, alertFloor);
  // This explicitly requested historical window is complete; older history is excluded.
  await ledger.cursor(source.key, rows[0].id);
  return { ...result, pagesRead };
}

export async function collectSource(source: Source, ledger: Ledger, readPage: (page: number) => Promise<Post[]>, send: (text: string) => Promise<void>, maxPages: number) {
  const previous = ledger.cursors.get(source.key);
  let newest = previous ?? 0;
  let sent = 0;
  const seen = new Set<number>();
  for (let page = 1; page <= maxPages; page++) {
    const rows = await readPage(page);
    const posts = rows.filter(post => !post.notice);
    if (!posts.length) throw new Error(`${source.name}: 일반 글이 없습니다. 공개 목록/선택자를 확인하세요.`);
    if (posts.some((post, i) => i > 0 && post.id > posts[i - 1].id))
      throw new Error(`${source.name}: 글 번호가 최신순이 아닙니다. 기준점 갱신을 중단합니다.`);
    const fresh = posts.filter(post => !seen.has(post.id));
    if (!fresh.length) throw new Error(`${source.name}: 페이지가 반복됩니다. 커서를 갱신하지 않습니다.`);
    fresh.forEach(post => seen.add(post.id));
    newest = Math.max(newest, ...posts.map(post => post.id));
    // New sources start from now. Old notices and history must not flood Slack.
    if (previous === undefined) {
      await ledger.cursor(source.key, newest);
      console.log(`  초기 기준점 ${newest} 저장 (과거 글 알림 생략)`);
      return 0;
    }
    for (const post of fresh) {
      if (post.id <= previous || !shouldNotify(source, post.title)) continue;
      if (await deliverOnce(ledger, `${source.key}:${post.id}`, formatAlert(source, post), send)) sent++;
    }
    // Require descending chronological lists; do not advance on incomplete/gapped scans.
    if (posts.some(post => post.id <= previous)) {
      await ledger.cursor(source.key, newest);
      return sent;
    }
  }
  throw new Error(`${source.name}: ${maxPages}페이지 안에서 이전 기준점에 도달하지 못했습니다. 커서를 유지합니다. MAX_PAGES를 늘려주세요.`);
}
