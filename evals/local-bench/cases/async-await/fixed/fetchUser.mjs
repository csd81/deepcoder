async function load(id) {
  return { id, name: "u" + id };
}

export async function getName(id) {
  const user = await load(id);
  return user.name;
}
