import * as pw from "playwright";
import fetch from "node-fetch";
import { writeFile, readFile } from "fs/promises";
import dotenv from "dotenv";
dotenv.config();

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL!;
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
type State = Record<string, string[]>;

async function loadCheckedPosts(): Promise<State> {
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCheckedPosts(state: State) {
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function sendToSlack(text: string) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    console.error("🔴 슬랙 응답 실패:", res.status, await res.text());
  }
}

async function crawlAndNotify() {
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage();
  const checked = await loadCheckedPosts();

  for (const { name, url } of GALLERIES) {
    console.log(`🧭 [크롤링] ${name}`);
    checked[name] ||= [];

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      const posts = await page.$$eval(".ub-content.us-post", (rows) =>
        rows.map((row) => {
          const title =
            row.querySelector(".gall_tit")?.textContent?.trim() || "";
          const link =
            (row.querySelector(".gall_tit > a") as HTMLAnchorElement)?.href ||
            "";
          const match = link.match(/no=(\d+)/);
          const no = match?.[1] || "";
          return { title, link, no };
        })
      );

      for (const post of posts) {
        if (!post.no || !post.title) continue;

        const isMatch = KEYWORDS.some((k) =>
          post.title.toLowerCase().includes(k.toLowerCase())
        );
        const isNew = !checked[name].includes(post.no);

        if (isMatch && isNew) {
          const message = `📢 *[${name}]* 새 글 발견!\n> ${post.title}\n\n🔗 <${post.link}|게시글 바로가기>`;
          console.log("🔔 슬랙 전송 시도:", message);
          await sendToSlack(message);
          checked[name].push(post.no);
          checked[name] = checked[name].slice(-50); // 최근 50개만 유지
        }
      }
    } catch (e) {
      console.error(`🔴 ${name} 갤러리 크롤링 실패:`, e);
    }
  }

  await saveCheckedPosts(checked);
  await browser.close();
}

crawlAndNotify().catch((e) => {
  console.error("🔴 전체 실행 실패:", e);
});
