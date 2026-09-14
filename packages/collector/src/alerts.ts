import type { CollectorConfig } from "./config.js";
import type { Logger } from "./log.js";

export type AlertKey = "lag" | "stall" | "rpc_down" | "db_error" | "chain_mismatch" | "gaps";

/**
 * Throttled alerting: log always, Telegram when configured. One message per key per state change
 * (fires on enter, sends a recovery note on clear); repeats every `repeatMs` while the condition holds.
 */
export class Alerter {
  private active = new Map<AlertKey, number>();
  constructor(
    private readonly cfg: CollectorConfig,
    private readonly log: Logger,
    private readonly repeatMs = 15 * 60_000,
  ) {}

  async raise(key: AlertKey, message: string): Promise<void> {
    const last = this.active.get(key);
    const now = Date.now();
    if (last !== undefined && now - last < this.repeatMs) return;
    this.active.set(key, now);
    this.log.error({ alert: key }, message);
    await this.send(`🔴 [cra-agent ${this.cfg.network}] ${key}: ${message}`);
  }

  async clear(key: AlertKey, message = "recovered"): Promise<void> {
    if (!this.active.has(key)) return;
    this.active.delete(key);
    this.log.info({ alert: key }, `cleared: ${message}`);
    await this.send(`🟢 [cra-agent ${this.cfg.network}] ${key} cleared: ${message}`);
  }

  async info(message: string): Promise<void> {
    this.log.info(message);
    await this.send(`ℹ️ [cra-agent ${this.cfg.network}] ${message}`);
  }

  activeKeys(): AlertKey[] {
    return [...this.active.keys()];
  }

  private async send(text: string): Promise<void> {
    const tg = this.cfg.telegram;
    if (!tg) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.warn({ status: res.status }, "telegram send failed");
    } catch (err) {
      this.log.warn({ err }, "telegram send error");
    }
  }
}
