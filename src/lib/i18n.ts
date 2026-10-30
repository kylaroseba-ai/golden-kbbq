import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// English is the default. Tagalog and Ilocano labels cover the staff screens (§9.5).
// The tl / ilo strings are a first draft — have staff review them during testing.
const en = {
  floor: 'Floor', kitchen: 'Kitchen', stock: 'Stock', counts: 'Counts', waste: 'Waste', deliveries: 'Deliveries', prep: 'Prep',
  reservations: 'Reservations', dashboard: 'Dashboard', reports: 'Reports', suppliers: 'Suppliers', reorder: 'Reorder', admin: 'Admin',
  alerts: 'Alerts', sync: 'Sync', lock: 'Lock', switch_user: 'Switch user',
  open_table: 'Open table', refill: 'Refill', order: 'Order', bill: 'Bill', served: 'Served', mark_served: 'Mark served',
  submit: 'Submit', cancel: 'Cancel', save: 'Save', confirm: 'Confirm', decline: 'Decline', seat: 'Seat',
  pax: 'Pax', plates: 'plates', round: 'Round', time_left: 'Time left', refill_closes_in: 'Refills close in',
  refill_cutoff_reached: 'Refill cutoff reached', last_call: 'Last call for refills', limit_per_round: 'Limit is {{n}} plates per round',
  waiting_on_dispatch: 'Waiting on dispatch — ask the kitchen', pending_sync: 'Pending sync', offline: 'Offline',
  low: 'LOW', out: 'OUT', ok: 'OK', expiring: 'EXPIRING', expired: 'EXPIRED',
  enter_pin: 'Enter your PIN', who_are_you: 'Who is using this device?', start_service: 'Start service',
  new_ticket: 'New ticket', counted: 'Counted', reason: 'Reason', qty: 'Quantity', item: 'Item',
  free: 'Free', seated: 'Seated', billing: 'Billing', dirty: 'Dirty', bussed: 'Mark clean',
}
type Dict = Partial<typeof en>

const tl: Dict = {
  floor: 'Mesa', kitchen: 'Kusina', stock: 'Stock', counts: 'Bilang', waste: 'Sayang', deliveries: 'Deliver', prep: 'Prep',
  open_table: 'Buksan ang mesa', refill: 'Refill', order: 'Order', bill: 'Bill', served: 'Naihain na', mark_served: 'Naihain na',
  submit: 'Ipasa', cancel: 'Kanselahin', save: 'I-save', confirm: 'Kumpirmahin', decline: 'Tanggihan', seat: 'Paupuin',
  plates: 'plato', round: 'Round', time_left: 'Natitirang oras', refill_closes_in: 'Sarado ang refill sa',
  refill_cutoff_reached: 'Sarado na ang refill', last_call: 'Huling tawag sa refill', limit_per_round: 'Hanggang {{n}} plato lang bawat round',
  waiting_on_dispatch: 'Hinihintay pa ang dispatch — tanungin ang kusina', pending_sync: 'Hindi pa naipapadala', offline: 'Walang internet',
  enter_pin: 'Ilagay ang PIN', who_are_you: 'Sino ang gagamit?', start_service: 'Simulan ang serbisyo',
  counted: 'Nabilang', reason: 'Dahilan', qty: 'Dami', free: 'Bakante', seated: 'May kumakain', dirty: 'Marumi', bussed: 'Nalinis na',
}
const ilo: Dict = {
  floor: 'Lamisaan', kitchen: 'Kusina', counts: 'Bilang', waste: 'Nadadael', open_table: 'Lukatan ti lamisaan',
  served: 'Naiserbi', mark_served: 'Naiserbi', submit: 'Ipatulod', cancel: 'Ibabawi', save: 'Idulin', confirm: 'Kumpirmaren',
  plates: 'plato', time_left: 'Nabati nga oras', refill_cutoff_reached: 'Nairikep ti refill', last_call: 'Maudi nga awag para iti refill',
  limit_per_round: 'Agingga iti {{n}} a plato iti tunggal round', pending_sync: 'Saan pay a naipatulod', offline: 'Awan ti internet',
  enter_pin: 'Ikabil ti PIN mo', who_are_you: 'Siasino ti agusar?', start_service: 'Rugian ti serbisyo',
  counted: 'Nabilang', reason: 'Gapu', qty: 'Kaadu', free: 'Awan tao', dirty: 'Narugit', bussed: 'Nadalusan',
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, tl: { translation: tl }, ilo: { translation: ilo } },
  lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false },
})

export default i18n
export const LANGUAGES = [{ code: 'en', label: 'English' }, { code: 'tl', label: 'Tagalog' }, { code: 'ilo', label: 'Ilocano' }]
