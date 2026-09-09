# Vendored 3D models — credits

## quad_x.gltf

Quad-X airframe model, vendored from the **Betaflight Configurator** project
(`resources/models/quad_x.gltf`).

- Source: https://github.com/betaflight/betaflight-configurator
- License: GNU General Public License v3.0 — the same licence this project
  ships under, so redistribution here is compatible.
- Used by `src/ui/visuals/Drone3D.vue` as the drone on the Connect screen,
  where it mirrors the connected drone's attitude. The model itself is
  unmodified; we centre it, scale it, and rotate it so its nose lies along
  the +X axis our attitude convention expects.

Betaflight's own airframe models (quad/hex/etc.) carry no separate
third-party model licence in the source tree — only the explicitly
third-party assets (`airplane`, `car`) do — so they are treated as
Betaflight-authored work under the project's GPLv3.

It was briefly removed on 2026-09-09, when the motor-check wizard's three.js
scene became a flat schematic and nothing else used it, and restored the same
day when the Connect screen's live attitude view wanted a real airframe rather
than one built from boxes and cylinders.
