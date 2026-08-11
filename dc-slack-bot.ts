import * as pw from "playwright";
import fetch from "node-fetch";
import { writeFile, readFile, mkdir } from "fs/promises";
import dotenv from "dotenv";
dotenv.config();

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL!;
const TEST_MODE = process.env.TEST_MODE === "true"; // 테스트 모드 (슬랙 전송 안 함)
const KEYWORDS = [
  "유심사",
  "로밍도깨비",
  "와이파이도시락",
  "eSIM",
  "로밍망",
  "로컬망",
  "말톡",
  "이심이지",
  "이심",
  "유심",
  "로깨비",
];

const GALLERIES = [
  {
    name: "일본갤",
    url: "https://gall.dcinside.com/mgallery/board/lists/?id=nokanto",
  },
  {
    name: "동남아갤",
    url: "https://gall.dcinside.com/board/lists/?id=travel_asia",
  },
  {
    name: "중국홍콩마카오갤",
    url: "https://gall.dcinside.com/board/lists?id=china",
  },
  {
    name: "방콕파타야갤",
    url: "https://gall.dcinside.com/mgallery/board/lists?id=bangkokpattaya",
  },
];

const statePath = "./.state/dc_checked.json";
const MAX_PER_GALLERY = 200; // 갤러리당 최근 200개만 유지

interface StateData {
  [gallery: string]: string[]; // 갤러리별 게시글 번호 배열
}

async function loadCheckedPosts(): Promise<StateData> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as StateData;
    const total = Object.values(state).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`✅ 상태 파일 로드: ${total}개 게시글 추적 중`);
    return state;
  } catch (e) {
    console.log("ℹ️ 상태 파일 없음. 새로 시작합니다.");
    return {};
  }
}

async function saveCheckedPosts(state: StateData) {
  try {
    await mkdir(".state", { recursive: true });
    // 각 갤러리별 최근 MAX_PER_GALLERY개만 유지
    const trimmed: StateData = {};
    for (const [gallery, posts] of Object.entries(state)) {
      trimmed[gallery] = posts.slice(-MAX_PER_GALLERY);
    }
    await writeFile(statePath, JSON.stringify(trimmed, null, 2));
    const total = Object.values(trimmed).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`✅ 상태 파일 저장: ${total}개 게시글 추적`);
  } catch (error) {
    console.error("❌ 상태 파일 저장 실패:", error);
  }
}

async function sendToSlack(text: string) {
  if (TEST_MODE) {
    console.log(`  [테스트] 슬랙 전송: ${text.substring(0, 50)}...`);
    return;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`슬랙 전송 실패 (${res.status}): ${errorBody}`);
  }
}

async function crawlAndNotify() {
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const state = await loadCheckedPosts();
  let sentCount = 0;

  for (const { name, url } of GALLERIES) {
    console.log(`\n[크롤링] ${name}`);
    const isMinor = url.includes("/mgallery/");

    // 페이지 1만 크롤링 (30분 주기라 새 글은 페이지 1에만 있음)
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("page", "1");

    try {
      await page.goto(pageUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      const selector = isMinor ? ".us-post" : ".gall_list .ub-content";
      await page.waitForSelector(selector, { timeout: 15000 });

      const posts = await page.$$eval(selector, (rows) =>
        rows.map((row) => {
          const a = row.querySelector(
            ".gall_tit a",
          ) as HTMLAnchorElement | null;
          const title = a?.textContent?.trim() || "";
          const link = a?.href || "";
          const no = link.match(/no=(\d+)/)?.[1] || "";
          return { title, link, no };
        }),
      );

      console.log(`  수집: ${posts.length}개 게시물`);

      // 이 갤러리의 상태 초기화 (없으면 빈 배열)
      if (!state[name]) {
        state[name] = [];
      }
      const checked = new Set(state[name]);

      // 새 글만 필터링
      const newPosts = posts.filter(
        (post) => post.no && post.title && !checked.has(post.no),
      );

      console.log(`  신규: ${newPosts.length}개`);

      for (const post of newPosts) {
        const isMatch = KEYWORDS.some(
          (k) => post.title.toLowerCase().includes(k.toLowerCase()),
        );

        if (isMatch) {
          const message = `[${name}] 새 글 발견!\n> ${post.title}\n\n링크: ${post.link}`;

          try {
            await sendToSlack(message);
            console.log(`  ✅ 전송 성공: ${post.no}`);
            sentCount++;
          } catch (error) {
            console.error(`  ❌ 전송 실패: ${post.no} - ${error}`);
          }
        }

        // 모든 새 글을 상태에 추가
        state[name].push(post.no);
      }
    } catch (e) {
      console.error(`  ⚠️ 크롤링 오류: ${e}`);
    }
  }

  await browser.close();
  await saveCheckedPosts(state);
  console.log(`\n✅ 실행 완료: ${sentCount}개 알람 전송`);
}

crawlAndNotify()
  .then(() => {
    console.log("✅ 프로그램 정상 종료");
    process.exit(0);
  })
  .catch((e) => {
    console.error("전체 실행 실패:", e);
    process.exit(1);
  });




// npx tsx dc-slack-bot.ts
