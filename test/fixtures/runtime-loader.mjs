export async function resolve(specifier, context, next) {
  if (specifier === './runtime.js' && context.parentURL?.endsWith('/src/main.js'))
    return { url: new URL('./runtime.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
