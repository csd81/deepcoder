// Convert a dollar amount to integer cents.
export function cents(dollars) {
  // BUG: floating-point dollars must be rounded, or callers accumulate error.
  return dollars * 100;
}
