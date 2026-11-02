/** Installs `hooks.mjs` into the module customization thread. See that file. */
import { register } from 'node:module'
// Stays on `register()` (deprecated from Node 26, DEP0205) rather than `registerHooks()`:
// the hooks' `load` awaits a dynamic import of the plugin's `transformMacro`, which only
// the asynchronous hooks thread allows. Node 26 prints the deprecation warning once.
register('./hooks.mjs', import.meta.url)
