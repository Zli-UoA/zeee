export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  });
}

export function formatDateOnly(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
}
