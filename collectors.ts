import type { Page } from "playwright";
import type { Post, Source } from "./bot-core.js";

export async function readPosts(page: Page, source: Source, number: number): Promise<Post[]> {
  if (number > 1) await new Promise(resolve => setTimeout(resolve, 800));
  const url = source.kind === "naver"
    ? new URL(`https://cafe.naver.com/f-e/cafes/${source.clubId}/menus/0`)
    : new URL(source.url);
  url.searchParams.set("page", String(number));
  if (source.kind === "naver") url.searchParams.set("viewType", "L");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
  if (source.kind === "dc") {
    await page.waitForSelector(".gall_list .ub-content", { timeout: 20000 });
    return page.$$eval(".gall_list .ub-content", rows => rows.flatMap(row => {
      const link = row.querySelector<HTMLAnchorElement>(".gall_tit a[href*='no=']");
      const id = Number(link?.href.match(/[?&]no=(\d+)/)?.[1]);
      const title = link?.textContent?.trim();
      const label = row.querySelector(".gall_num")?.textContent?.trim() ?? "";
      // DC can insert old recommended posts between chronological rows on later pages.
      const type = row.getAttribute("data-type") ?? "";
      const notice = !/^\d+$/.test(label) || type === "icon_notice" || type.startsWith("icon_recom") || !!row.querySelector(".icon_notice") || row.classList.contains("notice");
      return id && title && link ? [{ id, title, link: link.href, notice }] : [];
    }));
  }
  await page.waitForSelector(`table a[href*='/cafes/${source.clubId}/articles/']`, { timeout: 25000 });
  const posts = await page.$$eval("table tr", (rows, clubId) => rows.flatMap(row => {
    const links = Array.from(row.querySelectorAll<HTMLAnchorElement>(`a[href*='/cafes/${clubId}/articles/']`));
    const link = links.find(a => !a.href.includes("commentFocus=true") && !/^댓글수/.test(a.textContent?.trim() ?? ""));
    if (!link) return [];
    const id = Number(link.href.match(/\/articles\/(\d+)/)?.[1]);
    const title = link.textContent?.trim();
    const label = row.querySelector("td")?.textContent?.trim() ?? "";
    return id && title ? [{ id, title, link: `https://cafe.naver.com/f-e/cafes/${clubId}/articles/${id}`, notice: row.classList.contains("board-notice") || /^(공지|필독|전체 공지)$/.test(label) }] : [];
  }), source.clubId!);
  if (!posts.length) throw new Error("공개 글 목록을 읽지 못했습니다.");
  return posts;
}
