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
  const browser = await pw.chromium.launch({ headless: true }); // Headless 브라우저 실행
  const context = await browser.newContext({
    // 디씨에서 자동화 탐지를 피하기 위해 일반 브라우저의 User-Agent 설정
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
  });
  const page = await context.newPage(); // 새 페이지 생성
  const checked = await loadCheckedPosts(); // 이전에 체크한 게시물 불러오기
  const sentSet = new Set<string>(); // 이번 실행에서 이미 전송한 게시글 번호 저장 (중복 방지)

  for (const { name, url } of GALLERIES) {
    console.log(`[크롤링 시작] ${name}`);
    checked[name] ||= []; // 해당 갤러리의 게시글 번호 배열 초기화

    const isMinor = url.includes("/mgallery/"); // 마이너 갤러리 여부 판단
    const baseUrl = new URL(url); // URL 객체로 파싱
    const posts: { title: string; link: string; no: string }[] = []; // 수집된 게시물 배열

    for (let pageNum = 1; pageNum <= 15; pageNum++) {
      // 페이지를 1~15까지 순회
      const pageUrl = new URL(baseUrl.toString()); // base URL 복사
      pageUrl.searchParams.set("page", String(pageNum)); // page 파라미터 설정

      try {
        await page.goto(pageUrl.toString(), {
          waitUntil: "domcontentloaded", // DOM 로딩만 기다림 (성능 향상)
          timeout: 60000, // 최대 60초 대기
        });

        const selector = isMinor ? ".us-post" : ".gall_list .ub-content"; // 마이너/일반 갤에 따라 셀렉터 다르게
        await page.waitForSelector(selector, { timeout: 15000 }); // 셀렉터가 나타날 때까지 대기

        const newPosts = await page.$$eval(selector, (rows) =>
          rows.map((row) => {
            const a = row.querySelector(
              ".gall_tit a",
            ) as HTMLAnchorElement | null; // 제목 링크 요소 선택
            const title = a?.textContent?.trim() || ""; // 제목 텍스트 추출
            const link = a?.href || ""; // 링크 URL 추출
            const no = link.match(/no=(\d+)/)?.[1] || ""; // 게시글 번호 추출
            return { title, link, no }; // 게시물 객체 반환
          }),
        );

        posts.push(...newPosts); // 누적 수집
      } catch (e) {
        console.error(`[오류] ${name} 페이지 ${pageNum}:`, e); // 에러 발생 시 로깅
      }
    }

    console.log(`[${name}] 총 게시물 수집: ${posts.length}개`);
    console.log(posts.slice(0, 3)); // 일부만 출력 (디버깅용)

    for (const post of posts) {
      if (!post.no || !post.title) continue; // 번호나 제목이 없으면 건너뜀

      const isMatch = KEYWORDS.some(
        (k) => post.title.toLowerCase().includes(k.toLowerCase()), // 키워드 포함 여부 체크 (대소문자 무시)
      );
      const isNew = !checked[name].includes(post.no); // 이미 확인한 게시물인지 확인
      const alreadySent = sentSet.has(post.no); // 이번 실행에서 이미 전송했는지 확인

      if (isMatch && isNew && !alreadySent) {
        const message = `[${name}] 새 글 발견!\n> ${post.title}\n\n링크: ${post.link}`; // 알림 메시지 구성
        console.log("슬랙 전송:", message);

        // 슬랙 전송 후 상태에만 추가 (저장 실패해도 메모리상 중복 방지)
        try {
          await sendToSlack(message); // 슬랙으로 전송
          checked[name].push(post.no); // 슬랙 전송 성공 후에만 상태에 추가
          sentSet.add(post.no); // 이번 실행에서 전송한 게시글로 기록
          checked[name] = checked[name].slice(-50); // 최근 50개까지만 유지 (메모리 절약)
        } catch (error) {
          console.error(`[오류] 슬랙 전송 중 예외 발생 (${name}, ${post.no}):`, error); // 전송 실패 시 로깅
          // 전송 실패 시 상태에 추가하지 않음 (다음 실행에 재시도)
        }
      }
    }
  }

  await saveCheckedPosts(checked); // 갱신된 확인 목록 저장
  await browser.close(); // 브라우저 종료
}

crawlAndNotify().catch((e) => {
  console.error("전체 실행 실패:", e); // 최상위 예외 처리
});




// npx tsx dc-slack-bot.ts
