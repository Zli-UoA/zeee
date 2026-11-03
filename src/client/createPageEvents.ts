export const CREATE_PAGE_EVENT = 'zeee:create-page';

export type CreatePageEventDetail = {
  initialValue?: string;
};

export function openCreatePageDialog(initialValue = '') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<CreatePageEventDetail>(CREATE_PAGE_EVENT, {
      detail: { initialValue },
    }),
  );
}
