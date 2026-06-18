export function canAccess(u) {
  return u.admin || u.active;
}
