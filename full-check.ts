import * as pw from "playwright";
import { readFile, writeFile, mkdir } from "fs/promises";
import dotenv from "dotenv";
dotenv.config();

const GALLERIES = [
  { name: "일본갤", url: "https://gall.dcinside.com/mgallery/board/lists/?id=nokanto" },
  { name: "동남아갤", url: "https://gall.dcinside.com/board/lists/?id=travel_asia" },
  { name: "중국홍콩마카오갤", url: "https://gall.dcinside.com/board/lists?id=china" },
  { name: "방콕파타야갤", url: "https://gall.dcinside.com/mgallery/board/lists?id=bangkokpattaya" },
];

interface StateData {
  [gallery: string]: string[];
}

async function fullInitialize() {
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  });
  const page = await context.newPage();

  // 기존 상태 파일 로드
  let state: StateData = {};
  try {
    const raw = await readFile("./.state/dc_checked.json", "utf-8");
    state = JSON.parse(raw);
  } catch (e) {
    state = {};
  }

  // 각 갤러리 페이지 1에서 모든 글 수집
  for (const { name, url } of GALLERIES) {
    console.log(`\n[${name}] 페이지 1 모든 글 수집 중...`);
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("page", "1");

    try {
      await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
      const selector = url.includes("/mgallery/") ? ".us-post" : ".gall_list .ub-content";
      await page.waitForSelector(selector, { timeout: 15000 });

      const posts = await page.$$eval(selector, (rows) =>
        rows.map((row) => {
          const a = row.querySelector(".gall_tit a") as HTMLAnchorElement | null;
          const link = a?.href || "";
          const no = link.match(/no=(\d+)/)?.[1] || "";
          return no;
        }),
      );

      const validPosts = posts.filter(p => p && p.length > 0);
      console.log(`  ✅ 수집: ${validPosts.length}개`);

      // 기존 상태에 합치기 (중복 제거)
      if (!state[name]) {
        state[name] = [];
      }
      const existing = new Set(state[name]);
      validPosts.forEach(p => existing.add(p));
      state[name] = Array.from(existing);

      console.log(`  📊 총 추적: ${state[name].length}개`);
    } catch (e) {
      console.error(`  ❌ 오류: ${e}`);
    }
  }

  await browser.close();

  // 상태 파일 저장
  await mkdir(".state", { recursive: true });
  await writeFile("./.state/dc_checked.json", JSON.stringify(state, null, 2));
  console.log("\n✅ 상태 파일 완전 초기화 완료!");
  
  // 최종 통계
  const total = Object.values(state).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\n📈 최종: ${total}개 게시글 추적 중`);
}

fullInitialize().catch(console.error).finally(() => process.exit(0));
