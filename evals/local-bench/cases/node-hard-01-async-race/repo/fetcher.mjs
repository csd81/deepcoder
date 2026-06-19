// Load many ids concurrently and return their results.
export async function mapInOrder(ids, load) {
  const out = [];
  // BUG: results are pushed as they resolve, so `out` ends up in completion
  // order rather than the order of `ids`.
  await Promise.all(
    ids.map(async (id) => {
      const value = await load(id);
      out.push(value);
    }),
  );
  return out;
}
