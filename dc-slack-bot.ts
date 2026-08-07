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
const backupPath = "./.state/dc_checked.backup.json"; // 백업 파일 경로
type State = Record<string, string[]>; // 갤러리별로 게시글 번호 목록을 저장하는 객체 타입

async function loadCheckedPosts(): Promise<State> {
  try {
    const raw = await readFile(statePath, "utf-8"); // 이전에 저장한 JSON 파일 읽기
    const state = JSON.parse(raw); // 파싱해서 반환

    // 상태 파일이 비정상적으로 작아졌는지 체크 (초기화 감지)
    if (Object.keys(state).length === 0 || Object.values(state).some((arr) => !Array.isArray(arr))) {
      console.warn("⚠️ 상태 파일이 비정상입니다. 백업에서 복구 시도...");
      try {
        const backupRaw = await readFile(backupPath, "utf-8");
        const backupState = JSON.parse(backupRaw);
        console.log("✅ 백업에서 복구 완료");
        return backupState;
      } catch {
        console.warn("⚠️ 백업도 없습니다. 새로 시작합니다.");
        return {};
      }
    }

    return state;
  } catch {
    console.warn("⚠️ 상태 파일을 읽을 수 없습니다. 백업 사용 시도...");
    try {
      const backupRaw = await readFile(backupPath, "utf-8"); // 백업 파일 읽기
      console.log("✅ 백업 파일에서 복구 완료");
      return JSON.parse(backupRaw);
    } catch {
      console.warn("⚠️ 백업도 없습니다. 새로 시작합니다.");
      return {}; // 파일 없거나 에러 시 빈 객체 반환 (처음 실행하는 경우)
    }
  }
}

async function saveCheckedPosts(state: State) {
  try {
    await mkdir(".state", { recursive: true }); // 디렉토리가 없으면 생성

    // 백업 생성 (기존 파일이 있으면 먼저 백업)
    try {
      const existing = await readFile(statePath, "utf-8");
      await writeFile(backupPath, existing); // 기존 상태를 백업으로 저장
    } catch {
      // 첫 실행인 경우 백업 없음
    }

    // 새 상태 저장
    await writeFile(statePath, JSON.stringify(state, null, 2)); // 확인한 게시글 번호 저장 (포맷팅 포함)
    console.log("✅ 상태 파일 저장 완료");
  } catch (error) {
    console.error("❌ 상태 파일 저장 실패:", error); // 저장 실패 시 로깅 (프로그램은 계속 실행)
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
  const sentInThisRun = new Map<string, string[]>(); // 갤러리별 전송 성공한 게시글 번호

  for (const { name, url } of GALLERIES) {
    console.log(`[크롤링 시작] ${name}`);
    checked[name] ||= [];
    sentInThisRun[name] ||= [];

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
        console.error(`[오류] ${name} 페이지 ${pageNum}:`, e);
      }
    }

    console.log(`[${name}] 총 게시물 수집: ${posts.length}개`);
    console.log(posts.slice(0, 3));

    // 새 글 필터링 및 전송
    const newPosts = posts.filter(
      (post) => post.no && post.title && !checked[name].includes(post.no),
    );

    for (const post of newPosts) {
      const isMatch = KEYWORDS.some(
        (k) => post.title.toLowerCase().includes(k.toLowerCase()),
      );

      if (isMatch) {
        const message = `[${name}] 새 글 발견!\n> ${post.title}\n\n링크: ${post.link}`;
        console.log("슬랙 전송 시도:", message);

        try {
          await sendToSlack(message);
          checked[name].push(post.no);
          sentInThisRun[name].push(post.no);
          console.log(`✅ 전송 성공: ${name} - ${post.no}`);
        } catch (error) {
          console.error(
            `❌ 전송 실패: ${name} - ${post.no}:`,
            error,
          );
        }
      } else {
        // 키워드 미매칭 게시글도 상태에 추가해서 다시 확인하지 않게 함
        checked[name].push(post.no);
      }
    }

    // 갤러리별 최근 100개만 유지
    checked[name] = checked[name].slice(-100);
  }

  // 최종 상태 저장
  await saveCheckedPosts(checked);
  await browser.close();

  // 실행 결과 요약
  const totalSent = Object.values(sentInThisRun).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  console.log(`\n✅ 실행 완료: 총 ${totalSent}개 알람 전송`);
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
