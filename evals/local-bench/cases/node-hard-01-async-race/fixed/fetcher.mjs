// Load many ids concurrently and return their results in input order.
export async function mapInOrder(ids, load) {
  const out = new Array(ids.length);
  await Promise.all(
    ids.map(async (id, i) => {
      out[i] = await load(id);
    }),
  );
  return out;
}
