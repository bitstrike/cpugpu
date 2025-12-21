# System Monitor Cinnamon Applet

A real-time system monitoring applet for the Cinnamon desktop environment that displays CPU and GPU temperature in the panel.

## Screenshot

![Applet in Action](in-action.png)

*The applet running in the Cinnamon panel, showing real-time CPU and GPU monitoring*

## Features

- Real-time CPU/GPU temps with history
- Customizable refresh intervals
- Visual threshold indicators
- Configurable appearance and behavior

## Installation

### Method 1: Manual Installation (Recommended)

1. **Create the applet directory:**
   ```bash
   mkdir -p ~/.local/share/cinnamon/applets/cpugpu@bitcrash
   ```

2. **Copy all applet files:**
   ```bash
   cp applet.js metadata.json settings-schema.json stylesheet.css icon.svg ~/.local/share/cinnamon/applets/cpugpu@bitcrash/
   ```

3. **Set proper permissions:**
   ```bash
   chmod +x ~/.local/share/cinnamon/applets/cpugpu@bitcrash/applet.js
   ```

4. **Restart Cinnamon:**
   - Press `Alt+F2`, type `r`, and press Enter
   - Or log out and back in

5. **Enable the applet:**
   - Right-click on your panel → "Applets"
   - Find "System Monitor" in the list and enable it
   - The applet will appear in your panel

### Method 2: From Current Directory

If you're in the applet source directory:
```bash
cp -r . ~/.local/share/cinnamon/applets/cpugpu@bitcrash/
chmod +x ~/.local/share/cinnamon/applets/cpugpu@bitcrash/applet.js
```

### Troubleshooting

- Check Cinnamon logs: `journalctl -f | grep cinnamon`
- Verify the directory name matches the UUID: `cpugpu@bitcrash`
- Ensure all required files are present in the applet directory

## Files Structure

- `applet.js` - Main applet implementation
- `metadata.json` - Applet metadata and compatibility information
- `settings-schema.json` - Configuration options schema
- `stylesheet.css` - Visual styling for the applet
- `README.md` - This documentation file

## Configuration

Right-click the applet in the panel to access configuration options:

- **Refresh Interval**: How often to update system statistics (500-5000ms)
- **Display Format**: Choose between percentage, graph, or both
- **Show GPU**: Toggle GPU information display
- **Color Theme**: Select color scheme for usage indicators
- **Thresholds**: Set warning and critical usage levels
- **Custom Colors**: Define custom colors when using custom theme

## Requirements

- Cinnamon Desktop Environment 4.0+
- Ubuntu 22.04 or compatible Linux distribution
- Access to `/proc/stat` and `/proc/cpuinfo` for CPU monitoring
- GPU monitoring tools (nvidia-smi for NVIDIA, etc.) for GPU statistics

## Development

This applet follows Cinnamon's standard applet architecture and uses the Applet.TextIconApplet base class for panel integration.