/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<object, object, unknown>
  export default component
}

// Lua applet sources bundled via Vite's ?raw query — Vue wizards
// import their applet.lua as a string and ship it to the FC via
// MAVLink FTP at runtime. vite/client declares ?raw for built-in
// types but doesn't cover non-standard extensions like .lua.
declare module '*.lua?raw' {
  const content: string
  export default content
}
