type StatusBadgeProps = {
  status: string;
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`badge badge--${status}`}>{status}</span>;
}

const YM_AVAILABILITY_LABELS: Record<string, string> = {
  PUBLISHED:             'Готов к продаже',
  CHECKING:              'На проверке',
  NO_STOCKS:             'Нет на складе',
  HIDDEN:                'Скрыт',
  SUSPENDED:             'Приостановлен',
  DISABLED:              'Отключён',
  REJECTED:              'Отклонён',
  DISABLED_AUTOMATICALLY: 'Есть ошибки',
};

const YM_AVAILABILITY_CLASS: Record<string, string> = {
  PUBLISHED:             'ym-ok',
  CHECKING:              'ym-warn',
  NO_STOCKS:             'ym-warn',
  HIDDEN:                'ym-warn',
  SUSPENDED:             'ym-error',
  DISABLED:              'ym-error',
  REJECTED:              'ym-error',
  DISABLED_AUTOMATICALLY: 'ym-error',
};

export function YmStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span>—</span>;
  const label = YM_AVAILABILITY_LABELS[status] ?? status;
  const cls = YM_AVAILABILITY_CLASS[status] ?? 'ym-unknown';
  return <span className={`badge badge--${cls}`}>{label}</span>;
}