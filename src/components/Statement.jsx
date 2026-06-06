/**
 * Statement — one compact half-A4 Statement of Account copy.
 * Reused by Rent+Water and Electricity print pages.
 *
 * props:
 *   company   { address, bankName, bankAcct, bankBranch }
 *   copyLabel "Tenant's Copy" | "Owner's Copy"
 *   name, room, asOf, due, billNo, preparedBy
 *   charges   [{ label, mid, amount }]
 *   total     number
 *   details   { header: [...], rows: [[...]] }
 *   asOfNote  string
 *   peso      formatter fn
 */
export default function Statement({
  company, copyLabel, name, room, asOf, due, billNo, preparedBy,
  charges, total, details, asOfNote, splitNote, peso,
}) {
  return (
    <div className="stmt-copy">
      {copyLabel && <div className="copy-label">{copyLabel}</div>}

      <div style={{ textAlign: 'center' }}>
        <img
          src="/bedspace-logo.png" alt="bedSPACE" className="stmt-logo"
          onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'inline'; }}
        />
        <span className="brand" style={{ display: 'none' }}>bed<span style={{ color: '#1B3A8C' }}>SPACE</span></span>
      </div>
      <div className="addr">{company.address}</div>
      <div className="soa-title">STATEMENT OF ACCOUNT</div>

      {/* Top info */}
      <table style={{ marginBottom: 8 }}><tbody><tr>
        <td style={{ verticalAlign: 'top', width: '55%' }}>
          <div><strong>Name</strong>&nbsp;&nbsp;{name}</div>
          <div><strong>Room</strong>&nbsp;&nbsp;&nbsp;{room}</div>
        </td>
        <td style={{ verticalAlign: 'top' }}>
          <div className="kv"><span>As of</span><span>{asOf}</span></div>
          <div className="kv"><span>Due Date</span><span>{due}</span></div>
          <div className="kv"><span>Billing No.</span><span>{billNo}</span></div>
        </td>
      </tr></tbody></table>

      {/* Charges + payment */}
      <table><tbody><tr>
        <td style={{ verticalAlign: 'top', width: '58%', paddingRight: 12 }}>
          <table className="soa-charges"><tbody>
            {charges.map((c, i) => (
              <tr key={i}>
                <td>{c.label}</td>
                <td style={{ textAlign: 'center' }}>{c.mid}</td>
                <td style={{ textAlign: 'right' }}>{peso(c.amount)}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 800 }}>
              <td>Total amount due</td><td></td>
              <td style={{ textAlign: 'right' }}>{peso(total)}</td>
            </tr>
          </tbody></table>
        </td>
        <td style={{ verticalAlign: 'top', fontSize: 10 }}>
          <div>Please deposit your payment at our BDO acct.</div>
          <div>Account Name: {company.bankName}</div>
          <div>Account No. : {company.bankAcct}</div>
          <div>Branch: {company.bankBranch}</div>
          <div style={{ marginTop: 6 }}>Please provide proof of payment once payment is made. Thank you.</div>
        </td>
      </tr></tbody></table>

      <div className="prep">Prepared by:&nbsp;&nbsp;{preparedBy}</div>

      {/* Billing details (room sub-meter) — omitted for special/commercial tenants */}
      {details && details.rows && details.rows.length > 0 && (
        <>
          <div className="soa-title" style={{ margin: '4px 0 3px' }}>BILLING DETAILS</div>
          <table className="soa-details"><tbody>
            <tr>{details.header.map((h, i) => <th key={i}>{h}</th>)}</tr>
            {details.rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j} style={j === 0 ? { fontWeight: 700 } : null}>{c}</td>)}</tr>
            ))}
          </tbody></table>
        </>
      )}
      {asOfNote && <div className="asof-note">{asOfNote}</div>}
      {splitNote && <div className="asof-note" style={{ color: '#1B3A8C', fontWeight: 700 }}>{splitNote}</div>}

      <div className="latefee">
        Please pay on or before the due date. Otherwise, a 2% late fee will be added to your next bill.
      </div>
    </div>
  )
}
