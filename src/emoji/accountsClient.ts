export type AccountProfile = { username: string; display_name: string; avatar_url: string | null };
export class AccountClient {
  private value: AccountProfile[] = [];
  private checked = 0;
  private pending?: Promise<AccountProfile[]>;
  constructor(
    private endpoint: string,
    private publicOrigin: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async list(): Promise<AccountProfile[]> {
    if (this.pending) return structuredClone(await this.pending);
    if (Date.now() - this.checked < 60_000) return structuredClone(this.value);
    this.pending = this.refresh().finally(() => {
      this.pending = undefined;
    });
    return structuredClone(await this.pending);
  }
  private async refresh() {
    this.checked = Date.now();
    try {
      const url = new URL(this.endpoint);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw Error();
      const response = await this.fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw Error();
      const reader = response.body?.getReader();
      if (!reader) throw Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 2 * 1024 * 1024) throw Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const { accounts } = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(accounts) || accounts.length > 10000) throw Error();
      const names = new Set<string>();
      for (const item of accounts) {
        if (
          !item ||
          typeof item.username !== 'string' ||
          !/^[a-z0-9._-]{1,80}$/.test(item.username) ||
          names.has(item.username) ||
          typeof item.display_name !== 'string' ||
          item.display_name.length > 200
        )
          throw Error();
        names.add(item.username);
        if (
          item.avatar_url !== null &&
          (typeof item.avatar_url !== 'string' ||
            !item.avatar_url.startsWith(this.publicOrigin + '/api/v1/account-images/') ||
            !/^[a-f0-9]{64}$/.test(
              item.avatar_url.slice((this.publicOrigin + '/api/v1/account-images/').length),
            ))
        )
          throw Error();
      }
      this.value = accounts;
    } catch {
      this.value = [];
    }
    return this.value;
  }
}
