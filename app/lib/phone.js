/** The last 10 digits of a phone number, so +91 88006 37327, 08800637327 and 8800637327 all match. */
export function phoneKey(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}
