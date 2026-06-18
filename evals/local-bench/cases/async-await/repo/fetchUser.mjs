async function load(id) {
  return { id, name: "u" + id };
}

export async function getName(id) {
  // BUG: missing `await` — `user` is a Promise, so `user.name` is undefined.
  const user = load(id);
  return user.name;
}
