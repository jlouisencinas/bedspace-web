// Pure email building blocks: no Deno globals, no imports, erasable TypeScript only, so a Node
// script (scripts/preview-approval-email.mjs) can import it. Every helper escapes the values it
// is given; only bodyHtml / footerHtml passed to shell() are treated as ready-made HTML.
//
// Spacing scale: 4 / 8 / 12 / 16 / 20 / 24 px. All spacing is padding on <td> (never margin) so it
// survives Outlook; the <style> block only adjusts it for narrow screens.

export function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string,string>)[c]!)
}

export const clip = (s: unknown, max = 1000) => {
  const v = String(s ?? '')
  return v.length > max ? v.slice(0, max) + '…' : v
}

export const cleanSubject = (s: string) => s.replace(/[\r\n]+/g, ' ').trim().slice(0, 150)

// Built from char codes, not backslash-u escapes: a deploy transport that decodes escapes would put a
// raw U+2028/U+2029 inside a regex literal, which terminates it.
const LS = String.fromCharCode(0x2028, 0x2029, 0x85)
const LINE_BREAKS = new RegExp('\\s*[\\r\\n' + LS + ']+\\s*', 'g')
const SPLIT_LINES = new RegExp('\\r\\n|[\\r\\n' + LS + ']')

// Single-line, bounded value: CR/LF would otherwise start new lines in the plain-text part.
export const line = (v: unknown, max: number) => clip(String(v ?? '').replace(LINE_BREAKS, ' '), max)
export const flat = (s: string) => s.split(SPLIT_LINES).join('; ')
// Free text goes in indented so none of its lines can pass for a section heading or a `Label:` line.
export const indented = (s: string) => s.split(SPLIT_LINES).map(l => `  ${l}`).join('\n')

export const COLORS = {
  page:        '#FAF9F6',
  card:        '#FFFEFB',
  border:      '#E8E2D9',
  text:        '#292420',
  muted:       '#6B5F52',
  soft:        '#FEF8ED',
  softBorder:  '#F3E3BF',
  headBg:      '#292420',
  brand:       '#F4A522',
  headMuted:   '#C7BCA9',
  btnText:     '#1C1714',
  tableHead:   '#F4EEE3',
} as const

export type Tone = 'warning' | 'success' | 'danger' | 'neutral'

export const TONES: Record<Tone, { bg: string; border: string; text: string }> = {
  warning: { bg: '#FFFBEB', border: '#FCD34D', text: '#B45309' },
  success: { bg: '#ECFDF5', border: '#6EE7B7', text: '#047857' },
  danger:  { bg: '#FEF2F2', border: '#FCA5A5', text: '#B91C1C' },
  neutral: { bg: '#F4EEE3', border: '#E8E2D9', text: '#6B5F52' },
}

export type Status = 'PENDING' | 'APPROVED' | 'REJECTED'

const PILLS: Record<Status, { label: string; tone: Tone }> = {
  PENDING:  { label: '● PENDING REVIEW', tone: 'warning' },
  APPROVED: { label: '✓ APPROVED',       tone: 'success' },
  REJECTED: { label: '✕ REJECTED',       tone: 'danger'  },
}

export const pillLabel = (status: Status) => PILLS[status].label

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
// Value cells and free text may break anywhere; labels only between words (or, as a last resort, inside one).
const WRAP = 'word-break:break-word;overflow-wrap:anywhere;'
const LABEL_WRAP = 'overflow-wrap:break-word;word-break:normal;'

// One line per item; the text is escaped, the <br> separators are ours.
const multiline = (s: string) => String(s ?? '').split(/\r\n|\r|\n/).map(esc).join('<br>')

const label = (text: string, color: string = COLORS.muted, cls = 'em-mu') =>
  `<div${cls ? ` class="${cls}"` : ''} style="font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};${LABEL_WRAP}">${esc(text)}</div>`

const STYLE_BLOCK = `<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media only screen and (max-width:480px) {
    .em-pad { padding: 20px 16px 20px 16px !important; }
    .em-hpad { padding: 16px !important; }
    .em-fpad { padding: 16px !important; }
    .em-stack { display: block !important; width: 100% !important; box-sizing: border-box !important; }
    .em-kv { padding: 10px 16px !important; }
    .em-kv-empty { display: none !important; }
    .em-lab { padding: 0 !important; }
    .em-val { padding: 4px 0 12px 0 !important; }
    .em-tl { display: block !important; width: 100% !important; box-sizing: border-box !important; padding: 0 !important; }
    .em-tl-a { padding: 0 0 8px 0 !important; }
    .em-thead { display: none !important; }
    .em-cap { display: block !important; }
    .em-c1 { padding-bottom: 0 !important; }
    .em-c2 { border-top: 0 !important; padding-top: 8px !important; padding-bottom: 4px !important; }
    .em-c3 { border-top: 0 !important; padding-top: 8px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .em-page { background-color: #1C1714 !important; }
    .em-card { background-color: #26201B !important; border-color: #4A4036 !important; }
    .em-foot { background-color: #1F1915 !important; border-color: #4A4036 !important; }
    .em-soft { background-color: #332B24 !important; border-color: #4A4036 !important; }
    .em-tx { color: #F1EBE0 !important; }
    .em-mu { color: #B7AA98 !important; }
    .em-ln { border-color: #4A4036 !important; }
  }
</style>`

export type ShellArgs = {
  title?: string
  preheader: string
  headerLabel: string
  bodyHtml: string
  footerHtml: string
}

export function shell({ title, preheader, headerLabel, bodyHtml, footerHtml }: ShellArgs) {
  const filler = '&zwnj;&nbsp;'.repeat(60)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title ?? 'Bedspace Manager')}</title>
${STYLE_BLOCK}
</head>
<body class="em-page" style="margin:0;padding:0;background-color:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;opacity:0;color:${COLORS.page};">${esc(preheader)}${filler}</div>
<table role="presentation" class="em-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="width:100%;background-color:${COLORS.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;">
<tr><td class="em-hpad" bgcolor="${COLORS.headBg}" style="background-color:${COLORS.headBg};border-bottom:4px solid ${COLORS.brand};border-radius:12px 12px 0 0;padding:16px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" style="padding:0;font-family:${FONT};font-size:14px;line-height:20px;font-weight:800;letter-spacing:0.18em;color:${COLORS.brand};">BEDSPACE MANAGER</td>
<td align="right" style="padding:0;font-family:${FONT};font-size:12px;line-height:20px;color:${COLORS.headMuted};">${esc(headerLabel)}</td>
</tr></table>
</td></tr>
<tr><td class="em-card em-pad" bgcolor="${COLORS.card}" style="background-color:${COLORS.card};border-left:1px solid ${COLORS.border};border-right:1px solid ${COLORS.border};padding:24px 32px;font-family:${FONT};color:${COLORS.text};">
${bodyHtml}
</td></tr>
<tr><td class="em-foot em-fpad" bgcolor="${COLORS.page}" style="background-color:${COLORS.page};border:1px solid ${COLORS.border};border-radius:0 0 12px 12px;padding:16px 32px;">
${footerHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

export type Block = { html: string; gap?: number; align?: 'left' | 'center' }

// Vertical rhythm: each block sits in its own row and the space above it is padding on that row's
// <td>, so it holds in Outlook. The first block has no space above; the default gap is 16px.
export function stack(blocks: Array<Block | string | false | null | undefined>) {
  const items = blocks.filter((b): b is Block | string => !!b).map(b => (typeof b === 'string' ? { html: b } : b))
  const rows = items.map((b, i) =>
    `<tr><td align="${b.align ?? 'left'}" style="padding:${i === 0 ? 0 : (b.gap ?? 16)}px 0 0 0;">${b.html}</td></tr>`).join('\n')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">\n${rows}\n</table>`
}

export function pill(status: Status, text?: string) {
  const p = PILLS[status]
  const t = TONES[p.tone]
  return `<span style="display:inline-block;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.05em;padding:4px 12px;border-radius:999px;background-color:${t.bg};color:${t.text};border:1px solid ${t.border};">${esc(text ?? p.label)}</span>`
}

export function pillRow(status: Status, ref: string, text?: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" style="padding:0;">${pill(status, text)}</td>
<td align="right" class="em-mu" style="padding:0;font-family:${FONT};font-size:12px;line-height:16px;color:${COLORS.muted};">${esc(ref)}</td>
</tr></table>`
}

export const heading = (text: string) =>
  `<div class="em-tx" style="font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:${COLORS.text};${WRAP}"><h1 style="margin:0;padding:0;font-size:22px;line-height:28px;font-weight:700;color:inherit;font-family:inherit;">${esc(text)}</h1></div>`

export const intro = (text: string) =>
  `<div class="em-mu" style="font-family:${FONT};font-size:14px;line-height:22px;color:${COLORS.muted};${WRAP}">${esc(text)}</div>`

// A heading plus the content it introduces, as one block: 8px between them.
export const section = (title: string, contentHtml: string) =>
  `<div style="padding:0 0 8px 0;">${label(title)}</div>\n${contentHtml}`

export type KV = { label: string; value: string }

export function kvCard(rows: KV[]) {
  const pairs: string[] = []
  for (let i = 0; i < rows.length; i += 2) {
    const cell = (r?: KV) => r
      ? `<td class="em-stack em-kv" width="50%" valign="top" style="width:50%;padding:12px 16px;">${label(r.label)}<div class="em-tx" dir="auto" style="padding:4px 0 0 0;font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${COLORS.text};${WRAP}">${esc(r.value)}</div></td>`
      : `<td class="em-stack em-kv-empty" width="50%" style="width:50%;padding:0;"></td>`
    pairs.push(`<tr>${cell(rows[i])}${cell(rows[i + 1])}</tr>`)
  }
  return `<table role="presentation" class="em-soft" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.soft}" style="width:100%;background-color:${COLORS.soft};border:1px solid ${COLORS.softBorder};border-radius:10px;border-collapse:separate;">${pairs.join('')}</table>`
}

export type ChangeRow = { label: string; current: string; requested: string }

export type ChangesOpts = {
  headers: [string, string, string]
  requestedBg: string
  requestedColor: string
  requestedWeight?: string
}

export function changesTable(rows: ChangeRow[], opts: ChangesOpts) {
  const th = (text: string, width: string) =>
    `<th align="left" valign="top" width="${width}" class="em-mu" style="width:${width};padding:10px 12px;background-color:${COLORS.tableHead};font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.muted};${LABEL_WRAP}">${esc(text)}</th>`
  const head = `<tr class="em-thead">${th(opts.headers[0], '30%')}${th(opts.headers[1], '35%')}${th(opts.headers[2], '35%')}</tr>`
  const shown = rows.length ? rows : [{ label: 'No field details', current: '—', requested: '—' }]
  const cell = `padding:10px 12px;border-top:1px solid ${COLORS.border};font-family:${FONT};font-size:13px;line-height:20px;`
  // Below 480px the three columns stack (see .em-c1/.em-c2/.em-c3); these captions replace the hidden header row.
  const cap = (text: string, color: string, cls: string) =>
    `<div class="em-cap${cls}" style="display:none;mso-hide:all;padding:0 0 4px 0;font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};">${esc(text)}</div>`
  const body = shown.map(r => `<tr>
<td class="em-stack em-c1 em-tx em-ln" dir="auto" valign="top" style="${cell}${LABEL_WRAP}font-weight:700;color:${COLORS.text};">${multiline(r.label)}</td>
<td class="em-stack em-c2 em-tx em-ln" dir="auto" valign="top" style="${cell}${WRAP}color:${COLORS.text};">${cap(opts.headers[1], COLORS.muted, ' em-mu')}${multiline(r.current)}</td>
<td class="em-stack em-c3" dir="auto" valign="top" bgcolor="${opts.requestedBg}" style="${cell}${WRAP}background-color:${opts.requestedBg};font-weight:${opts.requestedWeight ?? '600'};color:${opts.requestedColor};">${cap(opts.headers[2], COLORS.muted, '')}${multiline(r.requested)}</td>
</tr>`).join('')
  return `<table role="presentation" class="em-ln" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;border:1px solid ${COLORS.border};border-radius:10px;border-collapse:separate;overflow:hidden;">${head}${body}</table>`
}

export function noteBlock(title: string, text: string, tone: Tone) {
  const t = TONES[tone]
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
<td bgcolor="${t.bg}" style="background-color:${t.bg};border:1px solid ${t.border};border-radius:10px;padding:12px 16px;">
${label(title, t.text, '')}
<div dir="auto" style="padding:4px 0 0 0;font-family:${FONT};font-size:14px;line-height:22px;color:${COLORS.text};${WRAP}">${multiline(text)}</div>
</td></tr></table>`
}

export type DecisionArgs = {
  tone: 'success' | 'danger'
  rows: KV[]
  closing: string
}

export function decisionBlock({ tone, rows, closing }: DecisionArgs) {
  const t = TONES[tone]
  const lines = rows.map(r => `<tr>
<td class="em-stack em-lab" valign="top" width="150" style="width:150px;padding:6px 16px 6px 0;font-family:${FONT};font-size:12px;line-height:20px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${t.text};">${esc(r.label)}</td>
<td class="em-stack em-val" dir="auto" valign="top" style="padding:6px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${COLORS.text};${WRAP}">${multiline(r.value)}</td>
</tr>`).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
<td bgcolor="${t.bg}" style="background-color:${t.bg};border:1px solid ${t.border};border-radius:10px;padding:12px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${lines}
<tr><td colspan="2" style="padding:12px 0 0 0;border-top:1px solid ${t.border};font-family:${FONT};font-size:14px;line-height:22px;font-weight:700;color:${t.text};">${esc(closing)}</td></tr>
</table>
</td></tr></table>`
}

// Centered by its wrapping block (use stack() with align:'center'); the table itself is centered too.
export function button(url: string, text: string) {
  if (!url) return ''
  return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
<td align="center" bgcolor="${COLORS.brand}" style="background-color:${COLORS.brand};border-radius:8px;padding:0;">
<a href="${esc(url)}" target="_blank" style="display:inline-block;padding:12px 32px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:${COLORS.btnText};text-decoration:none;border-radius:8px;">${esc(text)}</a>
</td></tr></table>`
}

export type TimelineArgs = { submitted: string; decided: string; outcome: 'success' | 'danger' }

export function timeline({ submitted, decided, outcome }: TimelineArgs) {
  const t = TONES[outcome]
  // Nested-table box: the outer cell only carries the gap (padding), the inner table carries border,
  // background and padding, so nothing is 100% wide plus horizontal padding.
  const cell = (cls: string, gap: string, step: string, when: string, bg: string, color: string, border: string) =>
    `<td class="${cls}" width="50%" valign="top" style="width:50%;padding:${gap};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="width:100%;background-color:${bg};border:1px solid ${border};border-radius:10px;border-collapse:separate;"><tr>
<td valign="top" style="padding:12px 16px;">${label(step, color, '')}<div style="padding:4px 0 0 0;font-family:${FONT};font-size:13px;line-height:20px;font-weight:600;color:${COLORS.text};">${esc(when)}</div></td>
</tr></table>
</td>`
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
${cell('em-tl em-tl-a', '0 6px 0 0', '1 · SUBMITTED', submitted, TONES.neutral.bg, COLORS.muted, TONES.neutral.border)}
${cell('em-tl', '0 0 0 6px', '2 · DECIDED', decided, t.bg, t.text, t.border)}
</tr></table>`
}

export const footerLine = (text: string) =>
  `<div class="em-mu" style="font-family:${FONT};font-size:12px;line-height:18px;color:${COLORS.muted};${WRAP}">${esc(text)}</div>`

const MANILA = 'Asia/Manila'

// Built from parts so the ICU version (narrow no-break space before AM/PM) can't change the output.
export function fmtManila(iso: unknown) {
  const d = new Date(String(iso ?? ''))
  if (!iso || Number.isNaN(d.getTime())) return '—'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d)
  const p = (type: string) => parts.find(x => x.type === type)?.value ?? ''
  return `${p('month')} ${p('day')}, ${p('year')}, ${p('hour')}:${p('minute')} ${p('dayPeriod').toUpperCase()} PHT`
}

// YYYY-MM-DD columns are calendar dates: format from the string in UTC so they never shift a day.
export function fmtDateOnly(v: unknown) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''))
  if (!m) return String(v ?? '') === '' ? '—' : clip(v, 40)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(d.getTime())) return clip(v, 40)
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
}
