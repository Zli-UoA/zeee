export type CustomEmoji = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  image_url: string;
  updated_at: string;
  version: number;
};
export class EmojiClient {
  private value: CustomEmoji[] = [];
  private etag?: string;
  private fetched = 0;
  private loaded = false;
  private pending?: Promise<CustomEmoji[]>;
  readonly origin: string;
  readonly fetcher: typeof fetch;
  constructor(origin: string, fetcher: typeof fetch = fetch) {
    this.origin = new URL(origin).origin;
    this.fetcher = fetcher;
  }
  async list(force = false): Promise<CustomEmoji[]> {
    if (!force && this.loaded && Date.now() - this.fetched < 60_000)
      return structuredClone(this.value);
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return structuredClone(await this.pending);
  }
  private async refresh() {
    try {
      const response = await this.fetcher(`${this.origin}/api/v1/emojis`, {
        headers: this.etag ? { 'If-None-Match': this.etag } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 304 && this.loaded) {
        this.fetched = Date.now();
        return this.value;
      }
      if (!response.ok) throw new Error('Emoji catalog unavailable');
      const data = (await response.json()) as { emojis?: unknown };
      if (!Array.isArray(data.emojis)) throw new Error('Invalid catalog');
      const names = new Set<string>();
      const values: CustomEmoji[] = data.emojis.map((value) => {
        if (
          !value ||
          typeof value !== 'object' ||
          typeof value.id !== 'string' ||
          typeof value.name !== 'string' ||
          !Array.isArray(value.aliases) ||
          typeof value.category !== 'string' ||
          !/^\/images\/[0-9a-f]{64}$/.test(value.image_url) ||
          typeof value.updated_at !== 'string' ||
          !Number.isInteger(value.version)
        )
          throw new Error('Invalid catalog entry');
        if (!/^[a-z0-9_-]{1,64}$/.test(value.name)) throw new Error('Invalid emoji name');
        for (const name of [value.name, ...value.aliases]) {
          if (
            typeof name !== 'string' ||
            !name ||
            Array.from(name).length > 100 ||
            name.trim() !== name ||
            /[:\p{Cc}]/u.test(name) ||
            names.has(name)
          )
            throw new Error('Invalid catalog names');
          names.add(name);
        }
        return {
          ...value,
          image_url: new URL(value.image_url, this.origin).toString(),
        } as CustomEmoji;
      });
      this.value = values;
      this.etag = response.headers.get('etag') ?? undefined;
      this.fetched = Date.now();
      this.loaded = true;
      return this.value;
    } catch (error) {
      // Keep the last valid catalog for display when the service is unavailable.
      if (this.loaded) {
        this.fetched = Date.now();
        return this.value;
      }
      throw error;
    }
  }
  async resolve(name: string) {
    return (await this.list()).find((e) => e.name === name || e.aliases.includes(name));
  }
}
