export type TocItem = {
  id: string;
  depth: number;
  text: string;
};

export function sameToc(a: TocItem[], b: TocItem[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.id === b[index].id && item.depth === b[index].depth && item.text === b[index].text,
    )
  );
}
