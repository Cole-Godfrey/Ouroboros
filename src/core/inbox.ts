// The inbox is the only channel between the agent and its operator.
// Everything is an event in the audit log; the state fold provides the views.

import { localDate, systemClock, type Clock } from '../lib/clock.ts';
import { shortId } from '../lib/ids.ts';
import type { InboxItem, StateStore } from './state.ts';

export interface NewInboxItem {
  kind: InboxItem['kind'];
  title: string;
  body?: string;
  steps?: string[];
  /** Names of secrets the operator should provide with `ouro secret set NAME`. */
  secrets?: string[];
  urgency?: InboxItem['urgency'];
  /** What the agent will do (or cannot do) until this is resolved. */
  blocking?: string;
  from?: InboxItem['from'];
}

export interface InboxOptions {
  clock?: Clock;
  maxNonUrgentPerDay?: () => number;
  timezone?: () => string;
}

export class Inbox {
  private store: StateStore;
  private clock: Clock;
  private maxNonUrgent: () => number;
  private tz: () => string;

  constructor(store: StateStore, opts: InboxOptions = {}) {
    this.store = store;
    this.clock = opts.clock ?? systemClock;
    this.maxNonUrgent = opts.maxNonUrgentPerDay ?? (() => 6);
    this.tz = opts.timezone ?? (() => 'UTC');
  }

  private freshId(): string {
    for (;;) {
      const id = shortId();
      if (!this.store.state.inbox.has(id)) return id;
    }
  }

  /** Create an item. Agent-originated non-urgent items beyond the daily cap are recorded but not pushed. */
  create(item: NewInboxItem): { id: string; throttled: boolean } {
    this.store.sync();
    const from = item.from ?? 'agent';
    const urgency = item.urgency ?? 'normal';
    let throttled = false;
    if (from === 'agent' && urgency !== 'high') {
      const today = localDate(this.clock(), this.tz());
      let n = 0;
      for (const it of this.store.state.inbox.values()) {
        if (it.from === 'agent' && it.urgency !== 'high' && !it.throttled && localDate(it.ts, this.tz()) === today) n++;
      }
      throttled = n >= this.maxNonUrgent();
    }
    const id = this.freshId();
    this.store.append('inbox.item', {
      id,
      kind: item.kind,
      from,
      title: item.title.slice(0, 200),
      body: (item.body ?? '').slice(0, 8000),
      steps: item.steps?.slice(0, 30),
      secrets: item.secrets?.slice(0, 20),
      urgency,
      blocking: item.blocking?.slice(0, 500),
      throttled,
    });
    return { id, throttled };
  }

  /** Operator says something to the agent without replying to a specific item. */
  say(text: string, channel = 'cli'): string {
    const { id } = this.create({ kind: 'message', from: 'operator', title: text.slice(0, 80), body: text, urgency: 'high' });
    this.store.append('inbox.reply', { id, by: 'operator', text, channel });
    return id;
  }

  reply(id: string, text: string, by: 'operator' | 'agent' | 'system', channel = 'cli'): void {
    this.store.sync();
    if (!this.store.state.inbox.has(id)) throw new Error(`no such inbox item: ${id}`);
    this.store.append('inbox.reply', { id, by, text, channel });
  }

  setStatus(id: string, status: InboxItem['status'], by: string, note?: string): void {
    this.store.sync();
    if (!this.store.state.inbox.has(id)) throw new Error(`no such inbox item: ${id}`);
    this.store.append('inbox.status', { id, status, by, note });
  }

  ack(ids: string[]): void {
    if (ids.length) this.store.append('inbox.ack', { ids });
  }

  markPushed(id: string, channels: string[]): void {
    this.store.append('inbox.pushed', { id, channels });
  }

  open(): InboxItem[] {
    this.store.sync();
    return this.store.state.openInbox().sort((a, b) => a.ts - b.ts);
  }

  all(limit = 100): InboxItem[] {
    this.store.sync();
    return [...this.store.state.inbox.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  get(id: string): InboxItem | undefined {
    this.store.sync();
    return this.store.state.inbox.get(id);
  }

  /** What the agent should read now (and then ack). */
  unseenForAgent(): InboxItem[] {
    this.store.sync();
    return this.store.state.unseenForAgent();
  }
}
