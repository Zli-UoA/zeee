import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { useRouter } from '@void/react';
import type { LinkComponentProps } from '@cloudflare/kumo';

type Props = LinkComponentProps & {
  children?: ReactNode;
};

export const AppLink = forwardRef<HTMLAnchorElement, Props>(function AppLink(
  { href = '', to: _to, onClick, target, download, children, ...props }: Props,
  ref,
) {
  const router = useRouter();

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if ((target && target !== '_self') || download !== undefined) return;
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return;

    event.preventDefault();
    void router.visit(href);
  }

  return (
    <a
      {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}
      ref={ref}
      href={href}
      target={target}
      download={download}
      onClick={handleClick}
    >
      {children}
    </a>
  );
});
