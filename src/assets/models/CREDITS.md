# Vendored 3D models — credits

Nothing is vendored here right now.

`quad_x.gltf`, the Betaflight Configurator quad-X airframe, was removed on
2026-09-09 when the motor-check wizard's three.js scene was replaced by a flat
schematic (`src/ui/visuals/MotorMap.vue`). The schematic draws any frame from
its own motor angles, so there is no mesh to vendor and no second code path for
the frames a quad-X mesh could not honestly represent.

This file stays because the next vendored asset needs somewhere to be credited,
and because a removed attribution should say what it was rather than vanish.
The original entry: quad-X airframe model from
https://github.com/betaflight/betaflight-configurator (`resources/models/quad_x.gltf`),
GNU General Public License v3.0 — the same licence this project ships under.
