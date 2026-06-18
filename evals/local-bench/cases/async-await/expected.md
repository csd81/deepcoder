The fix awaits the async call (`const user = await load(id);`) before reading
`.name`. Only `fetchUser.mjs` changes.
