/** Installs `hooks.mjs` into the module customization thread. See that file. */
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
