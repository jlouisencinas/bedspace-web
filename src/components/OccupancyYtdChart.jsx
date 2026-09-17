import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useTheme } from '../lib/theme'

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Recharts takes colors as JS props, not CSS classes, so they can't read
// var(--token) directly — mirror the light/dark token pairs here instead.
const CHART_COLORS = {
  light: { grid: '#F0EBE3', tick: '#948A7C', cursor: '#FEF8ED', bar: '#1e3a5f' },
  dark:  { grid: '#2E271D', tick: '#9C917E', cursor: '#2A2319', bar: '#5B8DEF' },
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface border border-line rounded-lg shadow-card px-3 py-2 text-[12px]">
      <div className="font-semibold text-ink">{label}</div>
      <div className="text-navy-600">{payload[0].value}% occupied</div>
    </div>
  )
}

// data: [{ month: 'Jan', occupancy_pct: number }] — months with no snapshot are
// omitted (gaps), not rendered as zero-value bars.
export default function OccupancyYtdChart({ data }) {
  const { isDark } = useTheme()
  const c = isDark ? CHART_COLORS.dark : CHART_COLORS.light

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-[13px] text-ink-faint">
        No occupancy snapshots yet this year.
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={c.grid} />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: c.tick }} axisLine={false} tickLine={false} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: c.tick }} axisLine={false} tickLine={false} width={36} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: c.cursor }} />
          <Bar dataKey="occupancy_pct" fill={c.bar} radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export { MO }
