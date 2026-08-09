const CRM_STATUSES = Object.freeze([
  'NUEVO_CONTACTO',
  'PROSPECTO',
  'CLIENTE_NUEVO',
  'CLIENTE_RECURRENTE',
  'CLIENTE_FRECUENTE',
  'VIP',
  'INACTIVO',
  'RECUPERADO',
  'NO_CONTACTAR',
]);

const DEFAULT_CRM_RULES = Object.freeze({
  inactiveDays: 90,
  frequentOrders: 5,
  vipOrders: 10,
  vipSpend: 500_000,
});

function classifyCrmContact(contact = {}, rules = DEFAULT_CRM_RULES, now = new Date()) {
  if (contact.no_contact || contact.marketing_opt_out) return 'NO_CONTACTAR';
  const orders = Math.max(0, Number(contact.orders_count) || 0);
  const totalSpent = Math.max(0, Number(contact.total_spent) || 0);
  const previousStatus = String(contact.status || '').toUpperCase();
  const lastPurchase = contact.last_purchase_at ? new Date(contact.last_purchase_at) : null;
  const inactiveCutoff = new Date(now.getTime() - Math.max(1, Number(rules.inactiveDays) || 90) * 86_400_000);

  if (!orders) return contact.first_contact_at ? 'PROSPECTO' : 'NUEVO_CONTACTO';
  if (lastPurchase && lastPurchase < inactiveCutoff) return 'INACTIVO';
  if (previousStatus === 'INACTIVO') return 'RECUPERADO';
  if (orders >= (Number(rules.vipOrders) || 10) || totalSpent >= (Number(rules.vipSpend) || 500_000)) return 'VIP';
  if (orders >= (Number(rules.frequentOrders) || 5)) return 'CLIENTE_FRECUENTE';
  if (orders >= 2) return 'CLIENTE_RECURRENTE';
  return 'CLIENTE_NUEVO';
}

module.exports = { CRM_STATUSES, DEFAULT_CRM_RULES, classifyCrmContact };
