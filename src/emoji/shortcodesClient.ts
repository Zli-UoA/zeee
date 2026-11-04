/** Read-only gemoji catalog, revalidated hourly and retained during service failures. */
export class ShortcodeClient {
  private value?: Record<string, string>;
  private etag?: string;
  private checked = 0;
  private sourceValue: unknown = null;
  get source(): unknown {
    return structuredClone(this.sourceValue);
  }
  private pending?: Promise<Record<string, string>>;
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async list(force = false): Promise<Record<string, string>> {
    if (!force && this.value && Date.now() - this.checked < 3_600_000)
      return structuredClone(this.value);
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return structuredClone(await this.pending);
  }
  private async refresh() {
    try {
      const response = await this.fetcher(`${this.origin}/api/v1/shortcodes`, {
        headers: this.etag ? { 'If-None-Match': this.etag } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 304 && this.value) {
        this.checked = Date.now();
        return this.value;
      }
      if (!response.ok) throw Error('Shortcode catalog unavailable');
      const data = (await response.json()) as { shortcodes?: unknown; source?: unknown };
      if (!data.shortcodes || typeof data.shortcodes !== 'object' || Array.isArray(data.shortcodes))
        throw Error('Invalid shortcodes');
      const entries = Object.entries(data.shortcodes);
      if (
        entries.some(
          ([name, value]) =>
            !/^[a-z0-9_+-]{1,100}$/.test(name) ||
            typeof value !== 'string' ||
            !value ||
            value.length > 128 ||
            /\p{Cc}/u.test(value),
        )
      )
        throw Error('Invalid shortcode entry');
      this.value = Object.fromEntries(entries);
      this.sourceValue = data.source ?? null;
      this.etag = response.headers.get('etag') ?? undefined;
      this.checked = Date.now();
      return this.value;
    } catch (error) {
      if (!this.value) throw error;
      this.checked = Date.now();
      return this.value;
    }
  }
}
