import { open, mkdir, readFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";

type Event =
  | { type: "init"; version: 1 }
  | { type: "cursor"; source: string; id: number }
  | { type: "attempt" | "sent" | "uncertain"; key: string; at: string };

// Append-only, fsync'd ledger. A failed write is fatal: never send without a reservation.
export class Ledger {
  healthy = true;
  cursors = new Map<string, number>();
  attempts = new Set<string>();
  outcomes = new Map<string, string>();
  constructor(private path: string, private dryRun = false) {}

  static async load(directory: string, dryRun = false): Promise<Ledger> {
    const ledger = new Ledger(join(directory, "notifications.jsonl"), dryRun);
    let raw: string;
    try {
      raw = await readFile(ledger.path, "utf8");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      // A missing ledger after initialization must never mean "forget all deliveries".
      try {
        await access(join(directory, "ledger.initialized"));
      } catch (markerError: any) {
        if (markerError.code !== "ENOENT") throw markerError;
        if (!dryRun) {
          const handle = await open(ledger.path, "wx");
          try { await handle.writeFile(JSON.stringify({ type: "init", version: 1 }) + "\n"); await handle.sync(); }
          finally { await handle.close(); }
        }
        raw = JSON.stringify({ type: "init", version: 1 }) + "\n";
      }
      if (raw! === undefined) throw new Error("알림 원장이 사라졌습니다. 백업을 복구해야 합니다.");
    }
    if (!raw.endsWith("\n")) throw new Error("알림 원장 마지막 기록이 불완전합니다. 전송을 중단합니다.");
    const events: unknown[] = raw.trimEnd().split("\n").map(line => JSON.parse(line));
    if (!(events[0] as any)?.type || (events[0] as any).type !== "init" || (events[0] as any).version !== 1)
      throw new Error("지원하지 않는 알림 원장입니다.");
    for (const value of events.slice(1)) {
      const event = value as Event;
      if (event.type === "cursor" && typeof event.source === "string" && Number.isSafeInteger(event.id) && event.id > 0) {
        if (event.id < (ledger.cursors.get(event.source) ?? 0)) throw new Error("역행한 수집 커서입니다.");
        ledger.cursors.set(event.source, event.id);
      } else if (["attempt", "sent", "uncertain"].includes(event.type) && typeof (event as any).key === "string" && typeof (event as any).at === "string") {
        const entry = event as Extract<Event, { key: string }>;
        if (entry.type !== "attempt" && !ledger.attempts.has(entry.key)) throw new Error("예약 없는 전송 결과입니다.");
        ledger.attempts.add(entry.key);
        ledger.outcomes.set(entry.key, entry.type);
      } else throw new Error("잘못된 알림 원장 기록입니다.");
    }
    if (!dryRun) {
      const marker = await open(join(directory, "ledger.initialized"), "a");
      try { await marker.sync(); } finally { await marker.close(); }
    }
    return ledger;
  }

  private async append(event: Event) {
    if (!this.healthy) throw new Error("알림 원장 쓰기 실패 이후 전송이 차단되었습니다.");
    if (this.dryRun) return;
    try {
      const handle = await open(this.path, "a");
      try { await handle.writeFile(JSON.stringify(event) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) { this.healthy = false; throw error; }
  }
  async cursor(source: string, id: number) {
    if (id <= (this.cursors.get(source) ?? 0)) return;
    await this.append({ type: "cursor", source, id });
    this.cursors.set(source, id);
  }
  async reserve(key: string): Promise<boolean> {
    if (this.attempts.has(key)) return false;
    // Claim in memory before awaiting IO, also covering simultaneous callers.
    this.attempts.add(key);
    await this.append({ type: "attempt", key, at: new Date().toISOString() });
    this.outcomes.set(key, "attempt");
    return true;
  }
  async outcome(key: string, type: "sent" | "uncertain") {
    await this.append({ type, key, at: new Date().toISOString() });
    this.outcomes.set(key, type);
  }
}

export async function acquireLock(directory: string) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "bot.lock");
  let handle;
  try { handle = await open(path, "wx"); }
  catch (error: any) {
    if (error.code === "EEXIST") throw new Error("다른 수집 작업이 실행 중이거나 이전 실행의 잠금이 남아 있습니다. 중복 실행을 중단합니다.");
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); await handle.sync(); }
  catch (error) { await handle.close(); throw error; }
  return async () => { await handle.close(); await unlink(path); };
}
