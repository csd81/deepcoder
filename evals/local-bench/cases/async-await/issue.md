`getName(id)` resolves to `undefined` instead of the user's name. `load()` is async
but its result is used without `await`, so `.name` is read off a Promise. Fix it to
await the loaded user.
