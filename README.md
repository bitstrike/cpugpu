# CPU/GPU Temperature Monitor - Cinnamon Applet

Real-time CPU and GPU temperature monitoring with scrolling line graphs for the Cinnamon desktop panel.
Supports up to 4 GPUs (NVIDIA and AMD). Each GPU is drawn as its own temperature line on the GPU graph, with a per-GPU VRAM bar beside it.

## Screenshot

![Applet in Action](in-action.png)

## Features

- Scrolling Cairo line graphs for CPU and GPU temperature
- Multi-GPU support (max 4): one colored line per GPU on shared axes
- Vertical VRAM bars (one per GPU, same color as its line) beside the GPU graph
- Blinking 1px red dot beside the temperature of each GPU that has a monitor connected (read from DRM connector status)
- Tooltip showing current temps and VRAM usage per GPU, with `[display]` on GPUs driving a monitor
- Popup with full-history graphs on left-click
- Configurable graph dimensions, colors, sample rate, and temperature range
- Fahrenheit/Celsius support
- Automatic panel height fitting
- Sensor backends: thermal_zone sysfs, lm-sensors, nvidia-smi, AMD hwmon

## Installation

```bash
git clone https://github.com/bitstrike/cpugpu
cd cpugpu
ln -sf "$(pwd)/cpugpu@bitcrash" ~/.local/share/cinnamon/applets/cpugpu@bitcrash
```

Then restart Cinnamon (Alt+F2, type `r`, Enter) and enable "CPU/GPU Temperature Monitor" in Panel > Applets.

## Configuration

Right-click the applet and select "Configure" to adjust:

- Graph width and height (or auto-fit to panel)
- Sample rate and time range
- CPU line color, GPU0-GPU3 line/VRAM bar colors, background, and grid colors
- Temperature range (Y-axis min/max, entered in your chosen unit)
- Fahrenheit/Celsius toggle
- History buffer size

## Requirements

- Cinnamon 4.0+
- For GPU temperature: `nvidia-smi` (NVIDIA) or AMD hwmon sysfs
- For CPU temperature: `/sys/class/thermal/` or `lm-sensors`

## Files

```
cpugpu@bitcrash/        (applet - symlink to ~/.local/share/cinnamon/applets/)
  applet.js             Main applet code
  metadata.json         Applet metadata
  settings-schema.json  Configuration schema
  stylesheet.css        Theme-compatible styles
  icon.svg              Applet icon
```

## License

See [LICENSE](LICENSE).
