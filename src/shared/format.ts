export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  });
}
