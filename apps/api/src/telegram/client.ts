/**
 * The few Telegram Bot API calls Compass needs, over fetch (openspec
 * telegram-decisions, design §1). The token is only ever part of the request
 * URL; errors never include it.
 */

export interface InlineButton {
  text: string;
  /** ≤ 64 bytes: `<verb>:<id>`. */
  callback_data?: string;
  url?: string;
}

export type Keyboard = InlineButton[][];

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string };
  from?: { id: number; username?: string; is_bot?: boolean };
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TgCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
  }
}

/** The calls the bot makes; a fake implements the same shape in tests. */
export interface TelegramApi {
  sendMessage(chatId: number, html: string, keyboard?: Keyboard, replyTo?: number): Promise<TgMessage>;
  editMessage(chatId: number, messageId: number, html: string, keyboard?: Keyboard): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  typing(chatId: number): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

export class TelegramClient implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) throw new TelegramError(method, res.status, json.description ?? res.statusText);
    return json.result as T;
  }

  sendMessage(chatId: number, html: string, keyboard?: Keyboard, replyTo?: number): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  async editMessage(chatId: number, messageId: number, html: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      });
    } catch (e) {
      // Editing to the same text is not a failure worth surfacing.
      if (e instanceof TelegramError && /message is not modified/i.test(e.description)) return;
      throw e;
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }

  async typing(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  }
}

/** Escape text for Telegram's HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram caps a message at 4096 characters; keep room for the frame. */
export function clip(s: string, max = 3500): string {
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}
