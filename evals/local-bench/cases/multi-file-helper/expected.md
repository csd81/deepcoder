The fix rounds in the `cents()` helper (`Math.round(dollars * 100)`) in
`helpers.mjs`. Only `helpers.mjs` should change — duplicating the fix into
`api.mjs` is flagged as touching an unrelated file.
