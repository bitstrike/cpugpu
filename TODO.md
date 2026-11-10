# Multi-GPU refactor

## Constants
- [x] Add `MAX_GPUS = 4` and named constants for VRAM strip bar width, line widths and alpha values
- [x] Add named constants for the vendor strings ("nvidia", "amd") used in branching

## Settings (settings-schema.json)
- [x] Add `gpu1-color`, `gpu2-color`, `gpu3-color`; keep `gpu-color` as GPU0
- [ ] Group GPU colors in a "GPU Colors" section (skipped: needs a full `layout` block that restructures the existing settings page)
- [x] Update "GPU Graph Color" description/tooltip to say GPU0
- [ ] (Optional) Add `show-vram-bars` checkbox (skipped, not requested)
- [x] Bind all GPU colors in a loop (`GPU_COLOR_SETTINGS`)

## Detection
- [x] Add `_detectGpus()` run once at startup
- [x] NVIDIA: parse every line of `nvidia-smi --query-gpu=index,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits`
- [x] AMD: enumerate `/sys/class/drm/card*/device/hwmon`; skip cards with no temp sensor
- [x] Truncate to `MAX_GPUS` and log once via `global.log` if more are found

## Data model
- [x] Replace `gpuData` with per-GPU `data[]`
- [x] Replace `gpuVramUsed/Total/Fraction` with per-GPU `vram = {used, total, fraction}`
- [x] Replace `_getGpuTemperature` and `_getAmdVram` with `_updateGpus` (single `nvidia-smi` call per tick)
- [x] Replace hardcoded `card0` with the detected card path per GPU
- [x] Update buffer trimming to loop over all GPUs

## Drawing
- [x] Refactor `_drawGpuGraph` to draw N polylines on shared axes, one color per GPU
- [x] Remove the green-to-red VRAM gradient from the graph
- [x] Add `vramCanvas` with N side-by-side vertical bars, filled from the bottom, in each GPU's color
- [x] Draw the current temp text per GPU in its color
- [x] Update `_drawPopupGraph` to overlay all GPU lines with a legend (GPU label, temp)
- [x] Add a popup VRAM strip

## UI wiring
- [x] Add `vramCanvas` and `popupVramCanvas` to `_createUI` and `_createPopupMenu`
- [x] Connect click handlers for new canvases
- [x] Update repaint calls in `_updateTemperatures`, `on_settings_changed`, `on_panel_height_changed`, `_onButtonPress`
- [x] Resize the VRAM canvas in `on_settings_changed`
- [x] Tooltip: one line per GPU

## Docs and verification
- [x] Update README.md (multi-GPU, 4 GPU cap, new settings)
- [ ] Update screenshot in-action.png (manual)
- [ ] Test with 1 GPU (no regression), 2 GPUs, and >4 GPUs (cap and log) (manual: restart Cinnamon, no JS engine available here)
- [ ] Test NVIDIA-only, AMD-only, and mixed (manual)
- [x] Update test-vram.sh for multi-GPU (optional GPU index arg)

## Decisions on open questions
- VRAM strip adds panel width (does not overlay the GPU graph)
- No "Show VRAM bars" checkbox

## Build
- [x] Add Makefile with `install` target that syncs the project applet into the installed applet directory

## Active display indicator
- [x] Map each GPU to its DRM card (AMD: card name; NVIDIA: match `pci.bus_id` to `/sys/class/drm/cardN/device`)
- [x] Add `pci.bus_id` to the NVIDIA query and update field parsing
- [x] Each poll, set `gpu.hasMonitor` if any `cardN-*/status` reads `connected`
- [x] Draw a 1px red dot at the upper left of that GPU's temperature label, blinking on a timer
- [x] Stop the blink timer on applet removal
- [x] Mark display GPUs in the tooltip
- [x] Update README
- [ ] Manual test: dot appears only for the GPU(s) with connected monitors
