export function find(users, id) {
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("not found: " + id);
  return u;
}
