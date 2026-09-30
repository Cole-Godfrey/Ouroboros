// the LLM provider table shared by the runner, the metering proxy and the CLI.

export type WireApi = 'anthropic' | 'openai';

export interface ProviderSpec {
  /** vault secret / environment variable holding the API key. */
  keyEnv: string;
  /** scheme + host of the real API. */
  upstream: string;
  /** path prefix Pi puts on requests for this provider (e.g. "/v1"). */
  basePath: string;
  api: WireApi;
  /** environment variable the vendor SDKs read for a base URL override, if any. */
  baseUrlEnv?: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', upstream: 'https://api.anthropic.com', basePath: '', api: 'anthropic', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
  openai: { keyEnv: 'OPENAI_API_KEY', upstream: 'https://api.openai.com', basePath: '/v1', api: 'openai', baseUrlEnv: 'OPENAI_BASE_URL' },
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', upstream: 'https://openrouter.ai', basePath: '/api/v1', api: 'openai' },
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY', upstream: 'https://api.deepseek.com', basePath: '', api: 'openai' },
  groq: { keyEnv: 'GROQ_API_KEY', upstream: 'https://api.groq.com', basePath: '/openai/v1', api: 'openai' },
  xai: { keyEnv: 'XAI_API_KEY', upstream: 'https://api.x.ai', basePath: '/v1', api: 'openai' },
  together: { keyEnv: 'TOGETHER_API_KEY', upstream: 'https://api.together.xyz', basePath: '/v1', api: 'openai' },
  fireworks: { keyEnv: 'FIREWORKS_API_KEY', upstream: 'https://api.fireworks.ai', basePath: '/inference/v1', api: 'openai' },
};

/** providers Pi knows that are not proxied (no entry above) still work: their key is passed straight through. */
export const EXTRA_KEY_ENV: Record<string, string> = {
  google: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
};

export function providerKeyEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.keyEnv ?? EXTRA_KEY_ENV[provider];
}

/**
 * model id as pi and the provider api expect it. a leading "<provider>/" is dropped
 * (so "anthropic/claude-x" works for anthropic) except on openrouter, whose own ids
 * contain slashes ("openrouter/free", "qwen/qwen3-coder:free").
 */
export function modelId(model: string, provider?: string): string {
  if (!provider || provider === 'openrouter') return model;
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

/** the free router picks any free model that supports the request. it is always available, so it is the fallback. */
export const FREE_ROUTER = 'openrouter/free';

/** free models cost nothing, so they never count against a budget. */
export function isFreeModel(model: string): boolean {
  return model === FREE_ROUTER || model.endsWith(':free');
}

/**
 * environment variables that point every LLM client in a process tree at the metering proxy (with a
 * short-lived token) or, when there is no proxy, at the real key.
 */
export function providerEnv(o: { provider: string; proxy?: { url: string; token: string }; secret?: string }): Record<string, string> {
  const env: Record<string, string> = {};
  if (o.proxy) {
    env.OURO_LLM_PROXY_URL = o.proxy.url;
    for (const [name, spec] of Object.entries(PROVIDERS)) {
      env[spec.keyEnv] = o.proxy.token;
      if (spec.baseUrlEnv) env[spec.baseUrlEnv] = `${o.proxy.url}/${name}${spec.basePath}`;
    }
    return env;
  }
  const keyEnv = providerKeyEnv(o.provider);
  if (keyEnv && o.secret) env[keyEnv] = o.secret;
  return env;
}
