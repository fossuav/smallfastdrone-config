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

// GLTF 3D models imported as a URL (Vite copies the asset and hands back
// the resolved path); GLTFLoader fetches it at runtime. The bundled model
// has embedded buffers, so the single .gltf file is self-contained.
declare module '*.gltf?url' {
  const src: string
  export default src
}
