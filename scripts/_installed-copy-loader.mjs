// ESM loader hook for scripts/_old-config-probe.mjs (task 01a14b9f stage 3).
//
// The probe imports the INSTALLED plugin copy (the .ts files update.sh copied
// into a scratch extension dir). That dir has no node_modules: update.sh's
// `npm install` is stubbed so the check runs offline. Two redirects make the
// copy loadable without installing anything into it:
//   - `phoenix` resolves to a capturing shim (data.phoenixShimUrl), so a join
//     is recorded instead of dialled;
//   - any other bare specifier that does not resolve from the copy is retried
//     from this repo's root, so `ws`, `@sinclair/typebox` and `openclaw`
//     resolve to the versions this checkout already has.
// Relative imports are never redirected: the code under test is the copy.

let phoenixShimUrl;
let repoParentUrl;

export async function initialize(data) {
  phoenixShimUrl = data.phoenixShimUrl;
  repoParentUrl = data.repoParentUrl;
}

const isBare = (s) => !s.startsWith(".") && !s.startsWith("/") && !s.startsWith("node:") && !/^[a-z]+:/i.test(s);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "phoenix") {
    return { url: phoenixShimUrl, format: "module", shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (isBare(specifier) && err?.code === "ERR_MODULE_NOT_FOUND") {
      return nextResolve(specifier, { ...context, parentURL: repoParentUrl });
    }
    throw err;
  }
}
