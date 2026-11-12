import { useEffect, useState } from 'react';
import type { AccountProfile } from './accountsClient';

export function AccountGlyph({
  account,
  iconOnly,
}: {
  account: AccountProfile;
  iconOnly: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [account.avatar_url]);
  const label = account.display_name || account.username;
  return (
    <span
      className={iconOnly ? 'zeee-account-emoji' : 'zeee-account-mention'}
      title={`@${account.username}`}
    >
      {!iconOnly && '@'}
      <span
        role={iconOnly ? 'img' : undefined}
        aria-label={iconOnly ? `:@${account.username}:` : undefined}
        aria-hidden={!iconOnly || undefined}
        className="zeee-account-icon"
      >
        {account.avatar_url && !failed ? (
          <img src={account.avatar_url} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          (Array.from(label)[0] ?? '?')
        )}
      </span>
      {!iconOnly && <span>{label}</span>}
    </span>
  );
}
