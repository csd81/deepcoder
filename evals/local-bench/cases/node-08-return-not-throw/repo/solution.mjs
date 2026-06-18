export function find(users, id) {
  return users.find((u) => u.id === id);
}
