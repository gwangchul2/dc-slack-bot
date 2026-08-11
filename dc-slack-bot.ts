import * as pw from "playwright"; // Playwright로 브라우저 자동화를 하기 위한 모듈 임포트
import fetch from "node-fetch"; // 슬랙에 메시지를 보내기 위해 HTTP 요청용 fetch 사용
import { writeFile, readFile, mkdir } from "fs/promises"; // 파일 저장 및 디렉토리 생성용 Node 비동기 FS API
import dotenv from "dotenv"; // 환경변수(.env)에서 설정값 불러오기
dotenv.config(); // .env 파일 로드

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL!; // 슬랙 웹훅 주소를 환경변수에서 불러옴 (강제 non-null)
const KEYWORDS = [
  // 감지할 키워드 목록 (제목에 포함되면 알림)
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
  // 크롤링할 디씨 갤러리 목록
  {
    name: "일본갤", // 갤러리 이름 (로깅 및 구분용)
    url: "https://gall.dcinside.com/mgallery/board/lists/?id=nokanto", // URL
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

const statePath = "./.state/dc_checked.json"; // 이미 확인한 게시글 번호를 저장할 파일 경로
type CheckedSet = Set<string>; // "갤러리명_게시글번호" 형태의 unique key 저장

async function loadCheckedPosts(): Promise<CheckedSet> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const lines = raw.trim().split("\n").filter(l => l.length > 0);
    const set = new Set<string>(lines);
    console.log(`✅ 상태 파일 로드: ${set.size}개 게시글 추적 중`);
    return set;
  } catch (e) {
    console.log("ℹ️ 상태 파일 없음. 새로 시작합니다.");
    return new Set<string>();
  }
}

async function saveCheckedPosts(checked: CheckedSet) {
  try {
    await mkdir(".state", { recursive: true });
    const lines = Array.from(checked).sort();
    await writeFile(statePath, lines.join("\n") + "\n");
    console.log(`✅ 상태 파일 저장: ${checked.size}개 게시글 추적`);
  } catch (error) {
    console.error("❌ 상태 파일 저장 실패:", error);
  }
}

async function sendToSlack(text: string) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST", // POST 방식으로
    headers: { "Content-Type": "application/json" }, // JSON 형식
    body: JSON.stringify({ text }), // 메시지 전송
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`슬랙 전송 실패 (${res.status}): ${errorBody}`); // 에러 throw로 try-catch에 감지되게 함
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
  const checked = await loadCheckedPosts();
  let sentCount = 0;

  for (const { name, url } of GALLERIES) {
    console.log(`\n[크롤링] ${name}`);
    const isMinor = url.includes("/mgallery/");
    const baseUrl = new URL(url);
    const posts: { title: string; link: string; no: string }[] = [];

    for (let pageNum = 1; pageNum <= 15; pageNum++) {
      const pageUrl = new URL(baseUrl.toString());
      pageUrl.searchParams.set("page", String(pageNum));

      try {
        await page.goto(pageUrl.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        const selector = isMinor ? ".us-post" : ".gall_list .ub-content";
        await page.waitForSelector(selector, { timeout: 15000 });

        const newPosts = await page.$$eval(selector, (rows) =>
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

        posts.push(...newPosts);
      } catch (e) {
        console.error(`  ⚠️ 페이지 ${pageNum} 오류: ${e}`);
      }
    }

    console.log(`  수집: ${posts.length}개 게시물`);

    // 중복 제거
    const uniquePosts = new Map<string, typeof posts[0]>();
    for (const post of posts) {
      if (post.no && post.title) {
        uniquePosts.set(post.no, post);
      }
    }

    console.log(`  중복 제거 후: ${uniquePosts.size}개`);

    // 새 글만 필터링
    const newPosts = Array.from(uniquePosts.values()).filter(
      (post) => !checked.has(`${name}_${post.no}`),
    );

    console.log(`  신규: ${newPosts.length}개`);

    for (const post of newPosts) {
      const key = `${name}_${post.no}`;

      // 키워드 매칭 확인
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

      // 전송 성공/실패 관계없이 상태에 추가 (중복 방지)
      checked.add(key);
    }
  }

  await browser.close();
  await saveCheckedPosts(checked);
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
