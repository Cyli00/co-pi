export function formatMonitorTime(value: string | undefined, { year = true, zone = false } = {}): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (part: number) => String(part).padStart(2, "0");
  const day = `${year ? `${date.getFullYear()}-` : ""}${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const offset = -date.getTimezoneOffset();
  const timezone = `UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${day} ${time}${zone ? ` ${timezone}` : ""}`;
}
