'use client';

export function LineChart({ values, label, suffix = '' }: { values: { label: string; value: number | null }[]; label: string; suffix?: string }) {
  const valid = values.filter((item): item is { label: string; value: number } => item.value !== null);
  if (!valid.length) return <div className="empty">No {label.toLowerCase()} recorded yet.</div>;
  const min = Math.min(...valid.map(item => item.value));
  const max = Math.max(...valid.map(item => item.value));
  const range = max - min || 1;
  const points = valid.map((item, index) => `${(index / Math.max(valid.length - 1, 1)) * 94 + 3},${92 - ((item.value - min) / range) * 76}`).join(' ');

  return (
    <div className="chart" aria-label={`${label} over time`}>
      <svg viewBox="0 0 100 100" role="img">
        <line x1="3" y1="92" x2="97" y2="92" />
        <line x1="3" y1="16" x2="97" y2="16" />
        <text x="3" y="10">{max.toFixed(max < 10 ? 2 : 0)}{suffix}</text>
        <text x="3" y="99">{min.toFixed(min < 10 ? 2 : 0)}{suffix}</text>
        <polyline points={points} />
        {valid.map((item, index) => {
          const x = (index / Math.max(valid.length - 1, 1)) * 94 + 3;
          const y = 92 - ((item.value - min) / range) * 76;
          return <circle key={`${item.label}-${index}`} cx={x} cy={y} r="1.7" />;
        })}
      </svg>
    </div>
  );
}
