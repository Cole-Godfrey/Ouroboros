// Secret redaction. The vault registers every secret value here; anything that
// leaves the daemon toward the model, a log file or a notification passes through it.

export interface RedactorOptions {
  minLength?: number;
}

const GENERIC_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, '«ANTHROPIC_KEY»'],
  [/sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{24,}/g, '«API_KEY»'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '«GITHUB_TOKEN»'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer «TOKEN»'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«PRIVATE_KEY_BLOCK»'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '«TELEGRAM_BOT_TOKEN»'],
];

export class Redactor {
  private secrets = new Map<string, string>(); // value -> name
  private minLength: number;
  private sorted: string[] | null = null;

  constructor(opts: RedactorOptions = {}) {
    this.minLength = opts.minLength ?? 8;
  }

  /** Replace the full secret set (called after every vault change). */
  setSecrets(entries: Array<[name: string, value: string]>): void {
    this.secrets.clear();
    for (const [name, value] of entries) this.add(name, value);
  }

  add(name: string, value: string): void {
    if (typeof value !== 'string' || value.length < this.minLength) return;
    this.secrets.set(value, name);
    this.sorted = null;
    // also register common transformed forms of a secret
    if (/^0x[0-9a-fA-F]{64}$/.test(value)) this.secrets.set(value.slice(2), name);
  }

  get size(): number {
    return this.secrets.size;
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    if (this.secrets.size) {
      if (!this.sorted) this.sorted = [...this.secrets.keys()].sort((a, b) => b.length - a.length);
      for (const v of this.sorted) {
        if (out.includes(v)) out = out.split(v).join(`«${this.secrets.get(v)}»`);
      }
    }
    for (const [re, repl] of GENERIC_PATTERNS) out = out.replace(re, repl);
    return out;
  }

  /** Deep-redact any JSON-serialisable value. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = this.redactValue(v);
      return o as T;
    }
    return value;
  }
}

/** Process-wide redactor shared by logger, notifier and API. */
export const globalRedactor = new Redactor();
