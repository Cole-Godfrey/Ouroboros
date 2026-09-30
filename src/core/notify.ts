// Operator notifications: agent -> phone (ntfy, Telegram) and replies back.
//
// Trust levels: the CLI and a chat-id-locked Telegram bot are authoritative.
// ntfy replies arrive on a topic anyone who guesses it could write to, so they
// are marked untrusted; the agent is told to treat them as hints, never as
// authorisation for anything involving money.

import type { InboxItem } from './state.ts';
import type { StateStore } from './state.ts';
import type { Inbox } from './inbox.ts';
import { fetchJson, fetchText } from '../lib/http.ts';
import { globalRedactor } from '../lib/redact.ts';
import { nullLogger, type Logger } from '../lib/log.ts';

export interface OutMessage {
  id: string;
  title: string;
  body: string;
  urgency: 'low' | 'normal' | 'high';
  kind: string;
  steps?: string[];
  secrets?: string[];
}

export interface InboundMessage {
  channel: string;
  trusted: boolean;
  text: string;
  ts: number;
  /** Set when the reply targets a specific inbox item. */
  targetId?: string;
}

export interface Channel {
  name: string;
  trusted: boolean;
  send(msg: OutMessage): Promise<void>;
  poll?(): Promise<InboundMessage[]>;
}

export function formatMessage(msg: OutMessage): string {
  const lines: string[] = [];
  if (msg.body) lines.push(msg.body.trim());
  if (msg.steps?.length) {
    lines.push('', 'Steps:');
    msg.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (msg.secrets?.length) {
    lines.push('', `Secrets to provide (run in the VM): ${msg.secrets.map((n) => `ouro secret set ${n}`).join(' ; ')}`);
  }
  lines.push('', `Reply here starting with #${msg.id}, or run: ouro reply ${msg.id} "..."`);
  return lines.join('\n');
}

/** "#a3f9 done" -> {id:"a3f9", text:"done"}. Also finds "#a3f9" inside the quoted message being replied to. */
export function parseReplyTarget(text: string, quoted?: string): { id?: string; text: string } {
  const m = /^\s*#([0-9a-f]{4})\b[:\s-]*([\s\S]*)$/i.exec(text);
  if (m) return { id: m[1].toLowerCase(), text: m[2].trim() || text.trim() };
  if (quoted) {
    const q = /#([0-9a-f]{4})\b/i.exec(quoted);
    if (q) return { id: q[1].toLowerCase(), text: text.trim() };
  }
  return { text: text.trim() };
}

// ------------------------------------------------------------------ ntfy

export interface NtfyOptions {
  server: string;
  topic: string;
  replyTopic?: string;
  token?: string;
  since?: string;
}

export class NtfyChannel implements Channel {
  readonly name = 'ntfy';
  readonly trusted = false;
  private o: NtfyOptions;
  private cursor: string;

  constructor(o: NtfyOptions) {
    this.o = { ...o, server: o.server.replace(/\/+$/, '') };
    this.cursor = o.since ?? String(Math.floor(Date.now() / 1000));
  }

  private headers(): Record<string, string> {
    return this.o.token ? { authorization: `Bearer ${this.o.token}` } : {};
  }

  async send(msg: OutMessage): Promise<void> {
    const { status, text } = await fetchText(this.o.server, {
      method: 'POST',
      headers: this.headers(),
      json: {
        topic: this.o.topic,
        title: `Ouroboros: ${msg.title}`.slice(0, 250),
        message: formatMessage(msg).slice(0, 3800),
        priority: msg.urgency === 'high' ? 4 : msg.urgency === 'low' ? 2 : 3,
        tags: [msg.kind === 'alert' ? 'warning' : msg.kind === 'request' ? 'raising_hand' : 'snake'],
      },
      timeoutMs: 15_000,
      retries: 1,
    });
    if (status < 200 || status >= 300) throw new Error(`ntfy ${status}: ${text.slice(0, 200)}`);
  }

  async poll(): Promise<InboundMessage[]> {
    if (!this.o.replyTopic) return [];
    const { status, text } = await fetchText(`${this.o.server}/${encodeURIComponent(this.o.replyTopic)}/json?poll=1&since=${encodeURIComponent(this.cursor)}`, {
      headers: this.headers(),
      timeoutMs: 15_000,
    });
    if (status < 200 || status >= 300) throw new Error(`ntfy poll ${status}`);
    const out: InboundMessage[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { id: string; time: number; event: string; message?: string };
        if (ev.id) this.cursor = ev.id;
        if (ev.event !== 'message' || !ev.message) continue;
        const parsed = parseReplyTarget(ev.message);
        out.push({ channel: 'ntfy', trusted: false, text: parsed.text, ts: ev.time * 1000, targetId: parsed.id });
      } catch {
        /* ignore malformed line */
      }
    }
    return out;
  }
}

// -------------------------------------------------------------- telegram

export interface TelegramOptions {
  token: string;
  chatId: string;
  apiBase?: string;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  readonly trusted = true;
  private o: TelegramOptions;
  private offset = 0;

  constructor(o: TelegramOptions) {
    this.o = { ...o, apiBase: (o.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '') };
  }

  private url(method: string): string {
    return `${this.o.apiBase}/bot${this.o.token}/${method}`;
  }

  async send(msg: OutMessage): Promise<void> {
    const text = `[Ouroboros] ${msg.title}\n\n${formatMessage(msg)}`.slice(0, 4000);
    const res = await fetchJson<{ ok: boolean; description?: string }>(this.url('sendMessage'), {
      method: 'POST',
      json: { chat_id: this.o.chatId, text, disable_web_page_preview: true },
      timeoutMs: 15_000,
      retries: 1,
    });
    if (!res.ok) throw new Error(`telegram: ${res.description ?? 'send failed'}`);
  }

  async poll(): Promise<InboundMessage[]> {
    const res = await fetchJson<{
      ok: boolean;
      result: Array<{
        update_id: number;
        message?: { date: number; text?: string; chat: { id: number | string }; reply_to_message?: { text?: string } };
      }>;
    }>(`${this.url('getUpdates')}?offset=${this.offset}&timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`, { timeoutMs: 15_000 });
    const out: InboundMessage[] = [];
    for (const u of res.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message;
      if (!m?.text) continue;
      if (String(m.chat.id) !== String(this.o.chatId)) continue; // only the operator's chat is trusted
      const parsed = parseReplyTarget(m.text, m.reply_to_message?.text);
      out.push({ channel: 'telegram', trusted: true, text: parsed.text, ts: m.date * 1000, targetId: parsed.id });
    }
    return out;
  }

  /** Helper for `ouro init`: the chat id of whoever last messaged the bot. */
  static async discoverChatId(token: string, apiBase = 'https://api.telegram.org'): Promise<string | undefined> {
    const res = await fetchJson<{ result: Array<{ message?: { chat: { id: number | string } } }> }>(`${apiBase}/bot${token}/getUpdates?timeout=0`, { timeoutMs: 15_000 });
    const last = [...(res.result ?? [])].reverse().find((u) => u.message?.chat?.id !== undefined);
    return last?.message ? String(last.message.chat.id) : undefined;
  }
}

// -------------------------------------------------------------- notifier

export class Notifier {
  readonly channels: Channel[];
  private log: Logger;

  constructor(channels: Channel[], log: Logger = nullLogger) {
    this.channels = channels;
    this.log = log;
  }

  get enabled(): boolean {
    return this.channels.length > 0;
  }

  async push(msg: OutMessage): Promise<{ sent: string[]; failed: string[] }> {
    const clean: OutMessage = {
      ...msg,
      title: globalRedactor.redact(msg.title),
      body: globalRedactor.redact(msg.body),
      steps: msg.steps?.map((s) => globalRedactor.redact(s)),
    };
    const sent: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      this.channels.map(async (c) => {
        try {
          await c.send(clean);
          sent.push(c.name);
        } catch (e) {
          failed.push(c.name);
          this.log.warn(`notify via ${c.name} failed`, e instanceof Error ? e.message : String(e));
        }
      }),
    );
    return { sent, failed };
  }

  async pollAll(): Promise<InboundMessage[]> {
    const out: InboundMessage[] = [];
    for (const c of this.channels) {
      if (!c.poll) continue;
      try {
        out.push(...(await c.poll()));
      } catch (e) {
        this.log.debug(`poll ${c.name} failed`, e instanceof Error ? e.message : String(e));
      }
    }
    return out;
  }
}

// --------------------------------------------------------------- service

/** Glue between the inbox and the notifier: pushes new items, ingests replies. Driven by `tick()`. */
export class NotifyService {
  private store: StateStore;
  private inbox: Inbox;
  private getNotifier: () => Notifier;
  private log: Logger;
  private inflight = new Set<string>();

  constructor(store: StateStore, inbox: Inbox, notifier: Notifier | (() => Notifier), log: Logger = nullLogger) {
    this.store = store;
    this.inbox = inbox;
    this.getNotifier = typeof notifier === 'function' ? notifier : () => notifier;
    this.log = log;
  }

  private get notifier(): Notifier {
    return this.getNotifier();
  }

  private shouldPush(it: InboxItem, now: number): boolean {
    if (it.pushedAt || it.throttled || it.from === 'operator') return false;
    if (it.status !== 'open') return false;
    return now - it.ts >= 0;
  }

  async pushPending(now = Date.now()): Promise<number> {
    if (!this.notifier.enabled) return 0;
    this.store.sync();
    let n = 0;
    for (const it of this.store.state.inbox.values()) {
      if (!this.shouldPush(it, now) || this.inflight.has(it.id)) continue;
      this.inflight.add(it.id);
      try {
        const r = await this.notifier.push({
          id: it.id,
          title: it.title,
          body: it.body,
          urgency: it.urgency,
          kind: it.kind,
          steps: it.steps,
          secrets: it.secrets,
        });
        if (r.sent.length) {
          this.inbox.markPushed(it.id, r.sent);
          n++;
        }
      } finally {
        this.inflight.delete(it.id);
      }
    }
    return n;
  }

  /** Pull replies from every channel and record them. Returns how many messages were ingested. */
  async ingest(): Promise<number> {
    if (!this.notifier.enabled) return 0;
    const msgs = await this.notifier.pollAll();
    let n = 0;
    for (const m of msgs) {
      if (!m.text) continue;
      this.store.sync();
      let target = m.targetId && this.store.state.inbox.has(m.targetId) ? m.targetId : undefined;
      if (!target) {
        const open = this.inbox.open().filter((i) => i.from !== 'operator');
        if (open.length === 1) target = open[0].id;
      }
      const tag = m.trusted ? m.channel : `${m.channel} (untrusted)`;
      if (target) this.inbox.reply(target, m.text, 'operator', tag);
      else this.inbox.say(m.text, tag);
      n++;
    }
    if (n) this.log.info(`ingested ${n} operator message(s)`);
    return n;
  }

  async tick(now = Date.now()): Promise<void> {
    await this.pushPending(now);
    await this.ingest();
  }
}
