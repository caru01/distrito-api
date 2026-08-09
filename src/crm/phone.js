const COLOMBIA_COUNTRY_CODE = '57';

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhoneE164(value, countryCode = COLOMBIA_COUNTRY_CODE) {
  const raw = String(value || '').trim();
  let digits = phoneDigits(raw);
  const internationalDialPrefix = digits.startsWith('00');
  if (internationalDialPrefix) digits = digits.slice(2);
  if (!digits) return null;
  if (internationalDialPrefix && digits.length >= 8 && digits.length <= 15) return `+${digits}`;

  const defaultCountry = phoneDigits(countryCode) || COLOMBIA_COUNTRY_CODE;
  if (defaultCountry === COLOMBIA_COUNTRY_CODE) {
    if (digits.length === 10 && /^(3|60)/.test(digits)) return `+57${digits}`;
    if (digits.length === 12 && digits.startsWith('57') && /^(3|60)/.test(digits.slice(2))) {
      return `+${digits}`;
    }
  }

  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.startsWith(defaultCountry) && digits.length >= defaultCountry.length + 7 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

function whatsappRecipient(value) {
  const normalized = normalizePhoneE164(value);
  return normalized ? normalized.slice(1) : null;
}

function maskPhone(value) {
  const normalized = normalizePhoneE164(value);
  if (!normalized) return '';
  return `${normalized.slice(0, 3)}••••••${normalized.slice(-3)}`;
}

module.exports = {
  COLOMBIA_COUNTRY_CODE,
  maskPhone,
  normalizePhoneE164,
  phoneDigits,
  whatsappRecipient,
};
