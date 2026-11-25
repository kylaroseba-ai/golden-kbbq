import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { getBackend } from '../lib/backend'
import { deviceNow, useOnline, useRpc } from '../lib/hooks'
import { mutate, uuid } from '../lib/outbox'
import { dateTime, manilaDate, peso } from '../lib/format'
import { Button, Card, ErrorBox, Field, PageHeader, inputCls, useManagerPin, useToast } from '../components/ui'

const METHODS = [['cash', 'Cash'], ['gcash', 'GCash'], ['maya', 'Maya'], ['card', 'Card'], ['bank', 'Bank transfer']] as const

export function useTerminal() {
  const auth = useAuth()
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true, staleTime: 60_000 })
  const deviceId = auth.who.mode === 'device' ? auth.who.device.id : null
  const terminals: any[] = boot.data?.terminals ?? []
  return terminals.find((t) => t.device_id === deviceId) ?? null
}

// Billing, payment and the BIR sales invoice (§6.7)
export function Billing({ s, compact }: { s: any; compact?: boolean }) {
  const auth = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const online = useOnline()
  const terminal = useTerminal()
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true, staleTime: 60_000 })
  const [totals, setTotals] = useState<any>(null)
  const [payments, setPayments] = useState<{ method: string; amount: string; reference_no: string }[]>([{ method: 'cash', amount: '', reference_no: '' }])
  const [scpwd, setScpwd] = useState<{ kind: string; full_name: string; id_number: string }[]>([])
  const [booklet, setBooklet] = useState('')
  const [err, setErr] = useState<unknown>(null)
  const official = !!terminal?.invoice_printing_enabled && online
  // Internal mode (v0.6): the POS is not BIR-registered; it prints an Order Summary, never an invoice.
  const internal = (boot.data?.settings?.receipt_mode ?? 'internal') === 'internal'

  const prepare = async () => {
    try {
      const b = await getBackend()
      const r = await b.rpc('preview_bill', { p_session_id: s.id })
      setTotals(r)
      // a reservation fee paid by GCash is already part of the payment; the cashier collects the rest
      const fee = Number(s.reservation_fee?.amount ?? 0)
      setPayments(fee > 0
        ? [{ method: 'gcash', amount: String(Math.min(fee, Number(r.total))), reference_no: `Reservation fee ${s.reservation_fee.code} ${s.reservation_fee.ref ?? ''}`.trim() },
           ...(Number(r.total) > fee ? [{ method: 'cash', amount: (Number(r.total) - fee).toFixed(2), reference_no: '' }] : [])]
        : [{ method: 'cash', amount: String(r.total), reference_no: '' }])
      setScpwd(Array.from({ length: Number(r.sc_pwd_pax) }, () => ({ kind: 'sc', full_name: '', id_number: '' })))
    } catch (e) { setErr(e) }
  }

  const paid = payments.reduce((a, p) => a + Number(p.amount || 0), 0)
  const due = Number(totals?.total ?? 0)
  const cash = payments.filter((p) => p.method === 'cash').reduce((a, p) => a + Number(p.amount || 0), 0)

  const settle = async () => {
    setErr(null)
    try {
      const r = await mutate('settle_bill', { p_client_uuid: uuid(), p_token: auth.token, p_session_id: s.id,
        p_payments: payments.filter((p) => Number(p.amount) > 0).map((p) => ({ method: p.method, amount: Number(p.amount), reference_no: p.reference_no || null })),
        p_sc_pwd: scpwd, p_terminal_id: terminal?.id ?? null, p_manual_booklet_no: official ? null : booklet || null },
        { queueable: !official, label: `Settle table ${s.table_label}`, session_id: s.id, branch_id: auth.branchId! })
      if (r.queued) { toast('Payment saved offline — it syncs when the internet is back', 'info'); nav('/floor') }
      else { toast(`Change ${peso(r.result.change)}`, 'ok'); nav(`/invoice/${r.result.invoice_id}`) }
    } catch (e) { setErr(e) }
  }

  if (s.status === 'closed') {
    return <Card><p className="mb-3">This bill is settled.</p>{s.invoice && <Button variant="gold" onClick={() => nav(`/invoice/${s.invoice.id}`)}>View / reprint</Button>}</Card>
  }

  if (!totals) {
    const est = (s.lines ?? []).filter((l: any) => l.status === 'active').reduce((a: number, l: any) => a + Number(l.net_amount), 0)
    const overMin = s.timer_ends_at ? Math.floor((deviceNow().getTime() - new Date(s.timer_ends_at).getTime()) / 60000) : 0
    const overtimeItem = (boot.data?.menu_items ?? []).find((m: any) => m.item_type === 'fee' && /overtime/i.test(m.name) && m.is_active)
    const hasOvertime = (s.lines ?? []).some((l: any) => l.status === 'active' && l.menu_item_id === overtimeItem?.id)
    return (
      <Card>
        {overMin > 0 && overtimeItem && !hasOvertime && (
          <div className="rounded-xl bg-warn-bg text-warn p-3 mb-4 text-sm flex flex-wrap items-center gap-3">
            <span className="flex-1">This table is {overMin} min past the 2-hour limit. Overtime fee: {peso(overtimeItem.price)} per table.</span>
            <Button onClick={() => mutate('post_order_lines', { p_client_uuid: uuid(), p_token: auth.token, p_session_id: s.id, p_lines: [{ menu_item_id: overtimeItem.id, qty: 1 }] },
              { queueable: true, label: 'Overtime fee', session_id: s.id, branch_id: auth.branchId! }).then(() => toast('Overtime fee added', 'ok')).catch((e) => toast(e.message, 'error'))}>Add overtime fee</Button>
          </div>)}
        {s.reservation_fee && <p className="text-sm text-ok mb-3">Reservation fee {peso(s.reservation_fee.amount)} already paid by GCash (ref {s.reservation_fee.ref}). It is taken off at payment.</p>}
        <p className="mb-1 text-silver">Running total</p>
        <p className="text-4xl font-black mb-4">{peso(est)}</p>
        <p className="text-sm text-silver mb-4">Billing out locks the table: no more refills or orders unless you reopen it.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="gold" big onClick={prepare}>Bill out</Button>
          <Button big onClick={() => window.print()}>Print bill (not an invoice)</Button>
        </div>
        <ErrorBox error={err} />
      </Card>
    )
  }

  return (
    <div className={`grid gap-4 ${compact ? '' : 'lg:grid-cols-2'}`}>
      <Card>
        <h3 className="font-bold mb-3">Bill</h3>
        {(s.lines ?? []).filter((l: any) => l.status === 'active').map((l: any) => (
          <div key={l.id} className="flex justify-between text-sm py-1"><span>{Number(l.qty)}× {l.name}{l.choice_name ? ` — ${l.choice_name}` : ''}{l.discount_name && l.discount_name !== 'Regular' ? ` · ${l.discount_name}` : ''}</span><span>{peso(l.net_amount)}</span></div>
        ))}
        <div className="border-t border-charcoal-600 mt-2 pt-2 space-y-1 text-sm">
          <Row k="Subtotal" v={peso(totals.subtotal)} /><Row k="Discounts" v={`− ${peso(totals.discount_total)}`} />
          <Row k="VATable sales" v={peso(totals.vatable_sales)} /><Row k="VAT (12%)" v={peso(totals.vat_amount)} />
          <Row k="VAT-exempt sales" v={peso(totals.vat_exempt_sales)} />
          <div className="flex justify-between text-2xl font-black pt-2"><span>Total</span><span>{peso(totals.total)}</span></div>
        </div>
        <Button className="mt-4" onClick={async () => { await mutate('reopen_session', { p_token: auth.token, p_session_id: s.id }).catch((e) => toast(e.message, 'error')); setTotals(null) }}>Reopen table</Button>
      </Card>
      <Card>
        <h3 className="font-bold mb-3">Payment</h3>
        {payments.map((p, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-2">
            <select className={inputCls} value={p.method} onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, method: e.target.value } : x))}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input className={inputCls} inputMode="decimal" placeholder={p.method === 'cash' ? 'Tendered' : 'Amount'} value={p.amount}
              onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
            <button className="px-3 text-red-300" onClick={() => setPayments(payments.filter((_, j) => j !== i))} disabled={payments.length === 1}>✕</button>
            {p.method !== 'cash' && <input className={`${inputCls} col-span-3`} placeholder="Reference no." value={p.reference_no}
              onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, reference_no: e.target.value } : x))} />}
          </div>
        ))}
        <Button variant="ghost" onClick={() => setPayments([...payments, { method: 'gcash', amount: String(Math.max(0, due - paid).toFixed(2)), reference_no: '' }])}>+ Split payment</Button>
        <div className="my-3 text-lg">{paid >= due ? <>Change: <strong>{peso(Math.min(cash, paid - due))}</strong></> : <span className="text-amber-300">Short {peso(due - paid)}</span>}</div>

        {scpwd.length > 0 && <div className="mb-3">
          <h4 className="font-semibold mb-2">SC / PWD details (printed on the invoice)</h4>
          {scpwd.map((x, i) => (
            <div key={i} className="grid grid-cols-[90px_1fr_1fr] gap-2 mb-2">
              <select className={inputCls} value={x.kind} onChange={(e) => setScpwd(scpwd.map((y, j) => j === i ? { ...y, kind: e.target.value } : y))}><option value="sc">SC</option><option value="pwd">PWD</option></select>
              <input className={inputCls} placeholder="Full name" value={x.full_name} onChange={(e) => setScpwd(scpwd.map((y, j) => j === i ? { ...y, full_name: e.target.value } : y))} />
              <input className={inputCls} placeholder="ID no." value={x.id_number} onChange={(e) => setScpwd(scpwd.map((y, j) => j === i ? { ...y, id_number: e.target.value } : y))} />
            </div>
          ))}
        </div>}

        {official ? <p className="text-emerald-300 text-sm mb-3">Official sales invoice will print from terminal {terminal.terminal_code}.</p>
          : internal ? (
          <Field label="Official receipt no. from the BIR booklet (optional)" hint="Prints an Order Summary — not an official receipt. Write the official receipt from the booklet as usual; typing its number here helps match the two.">
            <input className={inputCls} value={booklet} onChange={(e) => setBooklet(e.target.value)} placeholder="e.g. 0001234" />
          </Field>
        ) : (
          <Field label="Manual booklet invoice no." hint={!terminal ? 'This device is not a registered POS terminal.' : !online ? 'Offline: official invoices need internet — use the booklet.' : 'Invoice printing is off until the BIR permit is approved.'}>
            <input className={inputCls} value={booklet} onChange={(e) => setBooklet(e.target.value)} placeholder="e.g. 0001234" />
          </Field>
        )}
        <ErrorBox error={err} />
        <Button variant="ok" big className="w-full" disabled={paid < due || (!official && !internal && !booklet)} onClick={settle}>Settle {peso(due)}</Button>
        <p className="text-xs text-silver mt-2">Manager discount or comps need a manager PIN at order time.</p>
      </Card>
    </div>
  )
}

const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between"><span className="text-silver">{k}</span><span>{v}</span></div>

// Printable 80 mm invoice; reprints are marked and counted (§6.7).
export function InvoicePage() {
  const { id } = useParams()
  const auth = useAuth()
  const toast = useToast()
  const askPin = useManagerPin()
  const nav = useNavigate()
  const [reprint, setReprint] = useState(false)
  const inv = useRpc<any>('get_invoice', { p_invoice_id: id, p_reprint: reprint }, { staleTime: Infinity })
  const d = inv.data
  if (!d) return <ErrorBox error={inv.error ?? new Error('Loading…')} />
  const official = d.invoice.invoice_no != null
  if (d.receipt_mode === 'internal' && !official) return <OrderSummary d={d} reprint={() => setReprint(true)} />
  return (
    <div>
      <div className="no-print flex flex-wrap gap-2 mb-4">
        <Button onClick={() => nav('/floor')}>← Floor</Button>
        <Button variant="gold" onClick={() => window.print()}>Print</Button>
        <Button onClick={() => setReprint(true)}>Reprint (marked REPRINT)</Button>
        {d.invoice.status === 'issued' && <Button variant="danger" onClick={async () => {
          const reason = prompt('Void reason?'); if (!reason) return
          const tok = await askPin('Voiding an invoice needs a manager PIN.')
          await mutate('void_invoice', { p_token: auth.token, p_invoice_id: d.invoice.id, p_reason: reason, p_override: tok })
            .then(() => { toast('Invoice voided — its number is kept', 'ok'); inv.refetch() }).catch((e) => toast(e.message, 'error'))
        }}>Void</Button>}
      </div>
      <div className="bg-white text-black rounded-lg p-4 w-fit mx-auto">
        <div className="receipt w-[72mm] font-mono text-[11px] leading-snug">
          {d.reprint && <div className="text-center font-bold">*** REPRINT ***</div>}
          {d.invoice.status === 'voided' && <div className="text-center font-bold">*** VOID *** {d.invoice.void_reason}</div>}
          <div className="text-center font-bold">{d.branch.registered_name}</div>
          <div className="text-center">GOLDEN KOREAN BBQ</div>
          <div className="text-center">{d.branch.address}</div>
          <div className="text-center">{d.branch.vat_reg_tin}</div>
          <div className="text-center font-bold my-1">{official ? 'SALES INVOICE' : 'BILL / STATEMENT OF ACCOUNT'}</div>
          {!official && <div className="text-center font-bold">THIS IS NOT AN INVOICE</div>}
          {official ? <div>SI No: {d.terminal?.prefix}{String(d.invoice.invoice_no).padStart(8, '0')}</div> : <div>Booklet SI No: {d.invoice.manual_booklet_no}</div>}
          <div>Date: {dateTime(d.invoice.issued_at)}</div>
          <div>Table: {d.table_label} · Cashier: {d.cashier}</div>
          <hr className="my-1 border-black border-dashed" />
          {(d.lines ?? []).filter((l: any) => l.status === 'active').map((l: any) => (
            <div key={l.id}>
              <div className="flex justify-between"><span>{Number(l.qty)} {l.name}</span><span>{Number(l.gross_amount).toFixed(2)}</span></div>
              {Number(l.discount_amount) > 0 && <div className="flex justify-between pl-2"><span>Less {l.discount_name}</span><span>-{Number(l.discount_amount).toFixed(2)}</span></div>}
            </div>
          ))}
          <hr className="my-1 border-black border-dashed" />
          <R k="VATable Sales" v={d.invoice.vatable_sales} /><R k="VAT Amount (12%)" v={d.invoice.vat_amount} />
          <R k="VAT-Exempt Sales" v={d.invoice.vat_exempt_sales} /><R k="Zero-Rated Sales" v={d.invoice.zero_rated_sales} />
          <R k="Total Discount" v={d.invoice.discount_total} />
          <div className="flex justify-between font-bold text-[13px]"><span>TOTAL DUE</span><span>{Number(d.invoice.total).toFixed(2)}</span></div>
          {(d.payments ?? []).map((p: any) => <R key={p.id} k={`${p.method.toUpperCase()}${p.reference_no ? ' ' + p.reference_no : ''}`} v={p.tendered ?? p.amount} />)}
          {(d.payments ?? []).filter((p: any) => p.change > 0).map((p: any) => <R key={'c' + p.id} k="Change" v={p.change} />)}
          {(d.sc_pwd ?? []).map((x: any, i: number) => (
            <div key={i} className="mt-1">{x.kind.toUpperCase()}: {x.full_name}<br />ID No: {x.id_number}<br />Signature: ____________</div>
          ))}
          <hr className="my-1 border-black border-dashed" />
          {d.terminal && <div>MIN: {d.terminal.bir_min} · SN: {d.terminal.bir_serial_no}<br />PTU: {d.terminal.bir_ptu_no} {d.terminal.bir_ptu_date ?? ''}</div>}
          <div className="text-center mt-1">Thank you! 감사합니다</div>
          <div className="text-center text-[9px]">Fields to verify with the accountant / BIR RDO before go-live.</div>
        </div>
      </div>
    </div>
  )
}
const R = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between"><span>{k}</span><span>{Number(v ?? 0).toFixed(2)}</span></div>
const money = (v: any) => Number(v ?? 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const Dash = () => <div className="border-t border-dashed border-black my-1" />

// Unofficial receipt for the customer (SPEC §15.5). Deliberately has no BIR invoice fields:
// no "Sales Invoice"/"Official Receipt" title, no TIN, no VAT breakdown, no serial/permit numbers.
function OrderSummary({ d, reprint }: { d: any; reprint: () => void }) {
  const nav = useNavigate()
  const lines = (d.lines ?? []).filter((l: any) => l.status === 'active')
  const gross = lines.reduce((a: number, l: any) => a + Number(l.gross_amount), 0)
  const disc = lines.reduce((a: number, l: any) => a + Number(l.discount_amount), 0)
  const branch = (d.branch.name ?? '').replace(/^Golden (Korean BBQ|Baboy) — /, '').toUpperCase()
  return (
    <div>
      <div className="no-print flex flex-wrap gap-2 mb-4">
        <Button onClick={() => nav('/floor')}>← Floor</Button>
        <Button variant="gold" onClick={() => window.print()}>Print</Button>
        <Button onClick={reprint}>Reprint (marked REPRINT)</Button>
      </div>
      <div className="bg-white text-black rounded-lg p-4 w-fit mx-auto">
        <div className="receipt w-[72mm] font-mono text-[11px] leading-snug">
          {d.reprint && <div className="text-center font-bold">*** REPRINT ***</div>}
          {d.invoice.status === 'voided' && <div className="text-center font-bold">*** VOID *** {d.invoice.void_reason}</div>}
          <div className="text-center font-bold text-[13px]">GOLDEN KOREAN BBQ{branch ? ` – ${branch}` : ''}</div>
          <div className="text-center">Unli Korean Grill{d.branch_phone ? ` · ${d.branch_phone}` : ''}</div>
          <Dash />
          <div className="text-center font-bold">ORDER SUMMARY</div>
          <div className="text-center font-bold">*** NOT AN OFFICIAL RECEIPT ***</div>
          <Dash />
          <div className="flex justify-between"><span>Bill #: {d.bill_no}</span><span>Table: {d.table_label}</span></div>
          <div className="flex justify-between"><span>{dateTime(d.invoice.issued_at)}</span><span>Pax: {d.pax}</span></div>
          <div className="flex justify-between"><span>Server: {d.server ?? '—'}</span><span>Cashier: {d.cashier ?? '—'}</span></div>
          <Dash />
          {lines.map((l: any) => (
            <div key={l.id} className="flex justify-between gap-2"><span>{l.name}{l.choice_name ? ` (${l.choice_name})` : ''} x{Number(l.qty)}{Number(l.qty) > 1 ? ` @${money(l.unit_price)}` : ''}</span><span>{money(l.gross_amount)}</span></div>
          ))}
          <Dash />
          <div className="flex justify-between"><span>Subtotal</span><span>{money(gross)}</span></div>
          {lines.filter((l: any) => Number(l.discount_amount) > 0).map((l: any) => (
            <div key={'d' + l.id} className="flex justify-between"><span>{l.discount_name} ({Number(l.qty)} pax)</span><span>-{money(l.discount_amount)}</span></div>
          ))}
          <div className="flex justify-between font-bold text-[13px]"><span>TOTAL</span><span>₱ {money(Number(d.invoice.total) || gross - disc)}</span></div>
          {(d.payments ?? []).map((p: any) => (
            <div key={p.id} className="flex justify-between"><span>{p.method.toUpperCase()}{p.reference_no ? ` ${p.reference_no}` : ''}</span><span>{money(p.tendered ?? p.amount)}</span></div>
          ))}
          {(d.payments ?? []).filter((p: any) => p.change > 0).map((p: any) => <div key={'c' + p.id} className="flex justify-between"><span>Change</span><span>{money(p.change)}</span></div>)}
          <Dash />
          <div className="text-center">Please ask for your official receipt.</div>
          <div className="text-center">Thank you! 감사합니다</div>
          <div className="text-center font-bold mt-1">*** NOT AN OFFICIAL RECEIPT ***</div>
        </div>
      </div>
    </div>
  )
}

// ───── Cashier shift and day close (§6.8) ─────
export function ShiftPage() {
  const auth = useAuth()
  const toast = useToast()
  const terminal = useTerminal()
  const boot = useRpc<any>('get_bootstrap', { p_branch: auth.branchId }, { cache: true })
  const terminalId = terminal?.id ?? boot.data?.terminals?.[0]?.id
  const shift = useRpc<any>('get_open_shift', { p_terminal_id: terminalId }, { enabled: !!terminalId })
  const [float, setFloat] = useState('2000')
  const [counted, setCounted] = useState('')
  const [xr, setXr] = useState<any>(null)
  const [reportId, setReportId] = useState<string | null>(null)
  const [zr, setZr] = useState<any>(null)
  const [zDate, setZDate] = useState(boot.data?.business_date ?? manilaDate())
  return (
    <div>
      <PageHeader title="Cashier shift & day close" />
      {!terminalId && <p className="text-silver">No POS terminal set up for this branch.</p>}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <h3 className="font-bold mb-3">Shift {terminal ? `· terminal ${terminal.terminal_code}` : ''}</h3>
          {!shift.data ? (
            <>
              <Field label="Opening cash float"><input className={inputCls} inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
              <Button variant="gold" onClick={() => mutate('open_cash_shift', { p_token: auth.token, p_terminal_id: terminalId, p_opening_float: Number(float) })
                .then(() => shift.refetch()).catch((e) => toast(e.message, 'error'))}>Open shift</Button>
            </>
          ) : (
            <>
              <p className="mb-2">Open since {dateTime(shift.data.opened_at)} · {shift.data.cashier_name}</p>
              <p className="mb-2 text-silver">Float {peso(shift.data.opening_float)} · Cash sales {peso(shift.data.cash_sales)} · In {peso(shift.data.cash_in)} · Out {peso(shift.data.cash_out)}</p>
              <div className="flex gap-2 mb-4">
                <Button onClick={() => { const a = prompt('Cash in amount?'); if (a) mutate('cash_move', { p_token: auth.token, p_shift_id: shift.data.id, p_amount: Number(a) }).then(() => shift.refetch()) }}>Cash in</Button>
                <Button onClick={() => { const a = prompt('Cash out amount?'); if (a) mutate('cash_move', { p_token: auth.token, p_shift_id: shift.data.id, p_amount: -Number(a) }).then(() => shift.refetch()) }}>Cash out</Button>
              </div>
              <Field label="Counted cash in drawer"><input className={inputCls} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
              <Button variant="gold" disabled={!counted} onClick={() => mutate('close_cash_shift', { p_token: auth.token, p_shift_id: shift.data.id, p_counted_cash: Number(counted) })
                .then((r) => { setXr(r.result.totals); setReportId(r.result.shift_id ?? shift.data.id); shift.refetch() }).catch((e) => toast(e.message, 'error'))}>Close shift · print report</Button>
            </>
          )}
          {reportId && <ShiftReport shiftId={reportId} />}
          {xr && !reportId && <Reading title="X-reading" data={xr} />}
        </Card>
        <Card>
          <h3 className="font-bold mb-3">Day close · Z-reading</h3>
          <Field label="Business date"><input type="date" className={inputCls} value={zDate} onChange={(e) => setZDate(e.target.value)} /></Field>
          <Button variant="gold" disabled={!terminalId} onClick={() => mutate('z_reading', { p_token: auth.token, p_terminal_id: terminalId, p_business_date: zDate })
            .then((r) => setZr(r.result)).catch((e) => toast(e.message, 'error'))}>Generate Z-reading</Button>
          {zr && <Reading title="Z-reading" data={zr} />}
        </Card>
      </div>
    </div>
  )
}

// Shift report in the layout Taft prints today (SPEC §15.5): cash drawer + sales summary.
function ShiftReport({ shiftId }: { shiftId: string }) {
  const r = useRpc<any>('get_shift_report', { p_shift_id: shiftId })
  const d = r.data
  if (!d) return <ErrorBox error={r.error} />
  const L = ({ k, v, b }: { k: string; v: any; b?: boolean }) => <div className={`flex justify-between ${b ? 'font-bold' : ''}`}><span>{k}</span><span>₱{money(v)}</span></div>
  const METHOD: Record<string, string> = { cash: 'Cash', gcash: 'GCash', maya: 'Maya', card: 'Card', bank: 'Bank transfer' }
  return (
    <div className="mt-4">
      <div className="no-print flex justify-end mb-2"><Button variant="gold" onClick={() => window.print()}>Print shift report</Button></div>
      <div className="bg-white text-black rounded-lg p-4 w-fit mx-auto">
        <div className="receipt w-[72mm] font-mono text-[11px] leading-snug">
          <div className="text-center font-bold text-[13px]">Shift report</div>
          <div>Shift number: {d.shift_number}</div>
          <div>Store: {d.store}</div>
          <div>POS: {d.pos}</div>
          <Dash />
          <div>Shift opened:</div><div className="flex justify-between"><span>{d.opened_by}</span><span>{dateTime(d.opened_at)}</span></div>
          {d.closed_at && <><div>Shift closed:</div><div className="flex justify-between"><span>{d.closed_by}</span><span>{dateTime(d.closed_at)}</span></div></>}
          <Dash />
          <div className="text-center font-bold">Cash drawer</div>
          <L k="Starting cash" v={d.cash_drawer.starting_cash} /><L k="Cash payments" v={d.cash_drawer.cash_payments} />
          <L k="Cash refunds" v={d.cash_drawer.cash_refunds} /><L k="Paid in" v={d.cash_drawer.paid_in} /><L k="Paid out" v={d.cash_drawer.paid_out} />
          <L k="Expected cash amount" v={d.cash_drawer.expected_cash} />
          {d.cash_drawer.actual_cash != null && <><L k="Actual cash amount" v={d.cash_drawer.actual_cash} /><L k="Difference" v={d.cash_drawer.difference} b /></>}
          <Dash />
          <div className="text-center font-bold">Sales summary</div>
          <L k="Gross sales" v={d.sales_summary.gross_sales} b /><L k="Refunds" v={d.sales_summary.refunds} />
          <L k="Discounts" v={d.sales_summary.discounts} /><L k="Net sales" v={d.sales_summary.net_sales} b />
          {Object.entries(d.by_method ?? {}).map(([m, v]) => <L key={m} k={METHOD[m] ?? m} v={v} />)}
          <L k="VAT included" v={d.sales_summary.vat_included} />
          <div className="flex justify-between"><span>Bills</span><span>{d.bills}{d.voided_bills ? ` (+${d.voided_bills} void)` : ''}</span></div>
          <Dash />
          <div className="text-right">{dateTime(d.printed_at)}</div>
          <div className="text-center text-[9px]">Internal report — not a BIR reading</div>
        </div>
      </div>
    </div>
  )
}

function Reading({ title, data }: { title: string; data: any }) {
  return (
    <div className="mt-4 rounded-xl bg-charcoal-800 p-3 text-sm">
      <div className="flex justify-between mb-2"><strong>{title}</strong><button className="underline no-print" onClick={() => window.print()}>Print</button></div>
      {Object.entries(data).filter(([k]) => !['id', 'branch_id', 'terminal_id'].includes(k)).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-0.5"><span className="text-silver">{k.replace(/_/g, ' ')}</span>
          <span className="text-right">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</span></div>
      ))}
    </div>
  )
}
