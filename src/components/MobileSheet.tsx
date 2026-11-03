import type { ReactNode } from 'react';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import { XIcon } from '@phosphor-icons/react';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
};

export function MobileSheet({ open, onOpenChange, title, children }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-kumo-overlay opacity-80" />
        <Dialog.Popup
          aria-label={title}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80svh] flex-col rounded-t-2xl bg-kumo-base text-kumo-default shadow-xl ring ring-kumo-line focus:outline-none"
        >
          <div className="flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold text-kumo-strong">
              {title}
            </Dialog.Title>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={`${title}を閉じる`}
              className="grid size-9 shrink-0 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
            >
              <XIcon size={17} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
