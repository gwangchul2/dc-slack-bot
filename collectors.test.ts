import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { readPosts } from "./collectors.js";
import type { Source } from "./bot-core.js";

async function browserFixture(run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true });
  try { await run(await browser.newPage()); } finally { await browser.close(); }
}
const naver: Source = { key: "naver:20421433", kind: "naver", name: "테스트", clubId: "20421433", url: "https://cafe.naver.com/worldtravelcafe" };
test("Naver parser excludes sidebar and comment links, identifies pinned rows, canonicalizes URLs", () => browserFixture(async page => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
    <a href="/f-e/cafes/20421433/articles/999">유심사 사이드 광고</a>
    <table><tbody>
      <tr class="board-notice"><td>공지</td><td><a class="article" href="/f-e/cafes/20421433/articles/5">말톡 공지</a></td></tr>
      <tr><td>질문·답변</td><td><a class="article" href="/f-e/cafes/20421433/articles/100?boardtype=L">일본 여행 질문</a><a class="cmt" href="/f-e/cafes/20421433/articles/100?commentFocus=true">댓글수[말톡]</a></td></tr>
      <tr><td>후기</td><td><a class="article" href="/f-e/cafes/20421433/articles/99?referrerAllArticles=true">도시락이심 후기</a></td></tr>
    </tbody></table>` }));
  const posts = await readPosts(page, naver, 1);
  assert.deepEqual(posts.map(post => [post.id, post.title, post.notice]), [[5, "말톡 공지", true], [100, "일본 여행 질문", false], [99, "도시락이심 후기", false]]);
  assert.equal(posts[1].link, "https://cafe.naver.com/f-e/cafes/20421433/articles/100");
}));
test("DC parser excludes numeric notices marked with icon_notice", () => browserFixture(async page => {
  await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
    <table class="gall_list"><tbody>
      <tr class="ub-content us-post" data-type="icon_notice"><td class="gall_num">1</td><td class="gall_tit"><a href="/mgallery/board/view/?id=nokanto&no=1">말톡 공지</a></td></tr>
      <tr class="ub-content us-post" data-type="icon_recomimg"><td class="gall_num">2</td><td class="gall_tit"><a href="/mgallery/board/view/?id=nokanto&no=2">말톡 예전 추천글</a></td></tr>
      <tr class="ub-content us-post"><td class="gall_num">102</td><td class="gall_tit"><a href="/mgallery/board/view/?id=nokanto&no=102">유심사후기</a></td></tr>
    </tbody></table>` }));
  const posts = await readPosts(page, { key: "dc:nokanto", kind: "dc", name: "테스트", url: "https://gall.dcinside.com/mgallery/board/lists/?id=nokanto" }, 1);
  assert.deepEqual(posts.map(post => [post.id, post.notice]), [[1, true], [2, true], [102, false]]);
}));
test("page number is used and different pages produce different articles", () => browserFixture(async page => {
  await page.route("**/*", route => {
    const number = Number(new URL(route.request().url()).searchParams.get("page"));
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<table><tr><td>후기</td><td><a href="/f-e/cafes/20421433/articles/${103 - number}">말톡 후기</a></td></tr></table>` });
  });
  assert.equal((await readPosts(page, naver, 1))[0].id, 102);
  assert.equal((await readPosts(page, naver, 2))[0].id, 101);
}));
