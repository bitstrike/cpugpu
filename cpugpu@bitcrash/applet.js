// Filename: applet.js
const Applet = imports.ui.applet;
const St = imports.gi.St;
const Cairo = imports.cairo;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const PopupMenu = imports.ui.popupMenu;
const ModalDialog = imports.ui.modalDialog;
const Tooltips = imports.ui.tooltips;
const ByteArray = imports.byteArray;

// Maximum number of GPUs tracked; any additional GPUs are ignored
const MAX_GPUS = 4;

// GPU vendor identifiers (SIMULATED is used when no sensor is found)
const VENDOR_NVIDIA = "nvidia";
const VENDOR_AMD = "amd";
const VENDOR_SIMULATED = "simulated";

// Linux PCI vendor id for AMD, as exposed in sysfs
const AMD_PCI_VENDOR_ID = "0x1002";
const DRM_PATH = "/sys/class/drm";
const DRM_CARD_REGEX = /^card\d+$/;

const NVIDIA_QUERY_CMD = "nvidia-smi --query-gpu=index,pci.bus_id,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits";
const NVIDIA_FIELD_COUNT = 5;

// Monitor-connected indicator: DRM connector status files (cardN-<connector>/status)
const DRM_STATUS_FILE = "status";
const DRM_STATUS_CONNECTED = "connected";
// nvidia-smi prints "00000000:01:00.0"; sysfs uses "0000:01:00.0" (last 12 chars)
const PCI_ADDRESS_LENGTH = 12;
// Blinking 1px red dot at the upper left of a display GPU's temperature label
const MONITOR_DOT_SIZE = 1;
const MONITOR_DOT_X = 1;
// Digits are about 0.7em tall, so half their height sits ~1/3 em above the baseline
const MONITOR_DOT_BASELINE_FRACTION = 1 / 3;
const MONITOR_DOT_COLOR = {r: 1, g: 0, b: 0, a: 1};
const MONITOR_BLINK_INTERVAL_SECONDS = 1;

// Settings key / property name pairs for per-GPU line colors (index = GPU index, length = MAX_GPUS)
const GPU_COLOR_SETTINGS = [
    ["gpu-color", "gpuColor"],
    ["gpu1-color", "gpu1Color"],
    ["gpu2-color", "gpu2Color"],
    ["gpu3-color", "gpu3Color"]
];

// Unit conversions
const MILLIDEGREES_PER_DEGREE = 1000;
const BYTES_PER_MIB = 1024 * 1024;
const MIB_PER_GIB = 1024;

// Layout and drawing
const GPU_LINE_WIDTH = 2;
const CANVAS_SPACING = 5;
const POPUP_GRAPH_WIDTH = 300;
const POPUP_GRAPH_HEIGHT = 200;
const PANEL_VRAM_BAR_WIDTH = 8;
const POPUP_VRAM_BAR_WIDTH = 14;
const VRAM_BAR_GAP = 2;
const VRAM_TRACK_ALPHA = 0.15;
const VRAM_FILL_ALPHA = 0.6;
const PANEL_LABEL_FONT_SIZE = 12;
const PANEL_LABEL_X = 5;
const PANEL_LABEL_FIRST_Y = 15;
const PANEL_LABEL_LINE_HEIGHT = 14;
const POPUP_LABEL_FIRST_Y = 18;
const POPUP_LABEL_LINE_HEIGHT = 16;

function TemperatureMonitorApplet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

TemperatureMonitorApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function(metadata, orientation, panel_height, instance_id) {
        Applet.Applet.prototype._init.call(this, orientation, panel_height, instance_id);
        
        this.metadata = metadata;
        this.instance_id = instance_id;
        this.panel_height = panel_height;
        
        // Install icon to user icon theme if not present
        this._installIcon();
        
        // Initialize settings
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("graph-width", "graphWidth", this.on_settings_changed);
        this.settings.bind("graph-height", "graphHeight", this.on_settings_changed);
        this.settings.bind("override-panel-height", "overridePanelHeight", this.on_settings_changed);
        this.settings.bind("time-range", "timeRange", this.on_settings_changed);
        this.settings.bind("sample-rate", "sampleRate", this.on_settings_changed);
        this.settings.bind("cpu-color", "cpuColor", this.on_settings_changed);
        for (let [key, prop] of GPU_COLOR_SETTINGS) {
            this.settings.bind(key, prop, this.on_settings_changed);
        }
        this.settings.bind("bg-color", "bgColor", this.on_settings_changed);
        this.settings.bind("grid-color", "gridColor", this.on_settings_changed);
        this.settings.bind("use-fahrenheit", "useFahrenheit", this.on_settings_changed);
        this.settings.bind("temp-min", "tempMin", this.on_settings_changed);
        this.settings.bind("temp-max", "tempMax", this.on_settings_changed);
        this.settings.bind("buffer-size", "bufferSize", this.on_buffer_size_changed);
        
        // Data storage
        this.cpuData = [];
        // Per-GPU state: {vendor, label, data[], vram:{used,total,fraction}, ...sensor info}
        this.gpus = this._detectGpus();
        this.maxDataPoints = Math.floor(this.timeRange / this.sampleRate);
        this.maxBufferSize = this.bufferSize; // Use configured buffer size
        this.pendingBufferSize = null; // Track pending buffer size changes
        
        // Create UI
        this._createUI();
        
        // Create popup menu
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._createPopupMenu();
        
        // Start monitoring
        this._startMonitoring();
    },
    
    _installIcon: function() {
        let iconName = "cpugpu-bitcrash";
        let destDir = GLib.get_home_dir() + "/.local/share/icons/hicolor/scalable/apps";
        let destPath = destDir + "/" + iconName + ".svg";
        if (!GLib.file_test(destPath, GLib.FileTest.EXISTS)) {
            let srcPath = this.metadata.path + "/icon.svg";
            if (GLib.file_test(srcPath, GLib.FileTest.EXISTS)) {
                GLib.mkdir_with_parents(destDir, 0o755);
                let [res, contents] = GLib.file_get_contents(srcPath);
                if (res) {
                    GLib.file_set_contents(destPath, contents);
                }
            }
        }
    },
    
    _createUI: function() {
        // Determine graph height: use panel height unless override is enabled
        let effectiveHeight = this.overridePanelHeight ? this.graphHeight : this.panel_height;
        
        // Main container
        this.mainBox = new St.BoxLayout({
            vertical: false,
            style_class: 'temp-monitor-box'
        });
        
        // CPU graph canvas
        this.cpuCanvas = new St.DrawingArea({
            width: this.graphWidth,
            height: effectiveHeight,
            style_class: 'temp-graph-canvas'
        });
        this.cpuCanvas.connect('repaint', Lang.bind(this, this._drawCpuGraph));
        
        // GPU graph canvas
        this.gpuCanvas = new St.DrawingArea({
            width: this.graphWidth,
            height: effectiveHeight,
            style_class: 'temp-graph-canvas'
        });
        this.gpuCanvas.connect('repaint', Lang.bind(this, this._drawGpuGraph));
        
        // VRAM canvas: one vertical bar per GPU
        this.vramCanvas = new St.DrawingArea({
            width: this._vramStripWidth(PANEL_VRAM_BAR_WIDTH),
            height: effectiveHeight,
            style_class: 'temp-graph-canvas'
        });
        this.vramCanvas.connect('repaint', Lang.bind(this, function(canvas) {
            this._drawVramBars(canvas, PANEL_VRAM_BAR_WIDTH);
        }));
        
        // Add canvases to container
        this.mainBox.add(this.cpuCanvas);
        this.mainBox.add(new St.Widget({width: CANVAS_SPACING})); // Spacer
        this.mainBox.add(this.gpuCanvas);
        this.mainBox.add(this.vramCanvas);
        
        this.actor.add_actor(this.mainBox);
        
        // Set up tooltip
        this._tooltip = new Tooltips.PanelItemTooltip(this, "", this._orientation);
        
        // Enable click to open popup
        this.actor.set_reactive(true);
        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        
        // Also connect to child elements to ensure clicks are captured
        this.mainBox.set_reactive(true);
        this.mainBox.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        
        this.cpuCanvas.set_reactive(true);
        this.cpuCanvas.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        
        this.gpuCanvas.set_reactive(true);
        this.gpuCanvas.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        
        this.vramCanvas.set_reactive(true);
        this.vramCanvas.connect('button-press-event', Lang.bind(this, this._onButtonPress));
    },
    
    _createPopupMenu: function() {
        // Container for popup graphs
        let popupBox = new St.BoxLayout({
            vertical: true,
            style_class: 'temp-monitor-popup'
        });
        
        // Large graphs container
        let graphsBox = new St.BoxLayout({
            vertical: false,
            style: 'padding: 10px;'
        });
        
        // Large CPU graph
        this.popupCpuCanvas = new St.DrawingArea({
            width: POPUP_GRAPH_WIDTH,
            height: POPUP_GRAPH_HEIGHT,
            style_class: 'temp-graph-canvas'
        });
        this.popupCpuCanvas.connect('repaint', Lang.bind(this, function(canvas) {
            this._drawPopupGraph(canvas, [{data: this.cpuData, color: this.cpuColor, label: "CPU"}]);
        }));
        
        // Spacer
        let spacer = new St.Widget({width: 10});
        
        // Large GPU graph (all GPUs overlaid)
        this.popupGpuCanvas = new St.DrawingArea({
            width: POPUP_GRAPH_WIDTH,
            height: POPUP_GRAPH_HEIGHT,
            style_class: 'temp-graph-canvas'
        });
        this.popupGpuCanvas.connect('repaint', Lang.bind(this, function(canvas) {
            this._drawPopupGraph(canvas, this._gpuSeries());
        }));
        
        // Large VRAM bars
        this.popupVramCanvas = new St.DrawingArea({
            width: this._vramStripWidth(POPUP_VRAM_BAR_WIDTH),
            height: POPUP_GRAPH_HEIGHT,
            style_class: 'temp-graph-canvas'
        });
        this.popupVramCanvas.connect('repaint', Lang.bind(this, function(canvas) {
            this._drawVramBars(canvas, POPUP_VRAM_BAR_WIDTH);
        }));
        
        graphsBox.add(this.popupCpuCanvas);
        graphsBox.add(spacer);
        graphsBox.add(this.popupGpuCanvas);
        graphsBox.add(this.popupVramCanvas);
        
        popupBox.add(graphsBox);
        
        // Add to menu
        this.menu.addActor(popupBox);
    },
    
    _onButtonPress: function(actor, event) {
        if (event.get_button() == 1) { // Left click
            this.menu.toggle();
            if (this.menu.isOpen) {
                // Redraw popup graphs when opened
                this.popupCpuCanvas.queue_repaint();
                this.popupGpuCanvas.queue_repaint();
                this.popupVramCanvas.queue_repaint();
            }
            return true;
        }
        return false;
    },
    
    _blink: function() {
        this._blinkOn = !this._blinkOn;
        if (this.gpus.some(function(gpu) { return gpu.hasMonitor; })) {
            this.gpuCanvas.queue_repaint();
        }
        return true;
    },
    
    _startMonitoring: function() {
        this._blinkOn = true;
        this._blinkTimeout = Mainloop.timeout_add_seconds(MONITOR_BLINK_INTERVAL_SECONDS,
            Lang.bind(this, this._blink));
        this._updateTemperatures();
        this._timeout = Mainloop.timeout_add_seconds(this.sampleRate, 
            Lang.bind(this, this._updateTemperatures));
    },
    
    _updateTemperatures: function() {
        // Read CPU temperature (always store in Celsius internally)
        let cpuTemp = this._getCpuTemperature();
        this.cpuData.push(cpuTemp);
        
        // Maintain buffer of 1000 readings
        if (this.cpuData.length > this.maxBufferSize) {
            this.cpuData.shift();
        }
        
        // Read all GPU temperatures and VRAM (temps stored in Celsius internally)
        this._updateGpus();
        
        // Redraw graphs
        this.cpuCanvas.queue_repaint();
        this.gpuCanvas.queue_repaint();
        this.vramCanvas.queue_repaint();
        
        // Redraw popup graphs if menu is open
        if (this.menu && this.menu.isOpen) {
            this.popupCpuCanvas.queue_repaint();
            this.popupGpuCanvas.queue_repaint();
            this.popupVramCanvas.queue_repaint();
        }
        
        // Update tooltip
        this._updateTooltip();
        
        return true;
    },
    
    _updateTooltip: function() {
        let cpuTemp = this.cpuData.length > 0 ? this.cpuData[this.cpuData.length - 1] : 0;
        let unit = this.useFahrenheit ? "\u00B0F" : "\u00B0C";
        
        if (this.useFahrenheit) {
            cpuTemp = this._celsiusToFahrenheit(cpuTemp);
        }
        
        let lines = ["CPU: " + cpuTemp.toFixed(0) + unit];
        
        // One line per GPU: label, temperature, and VRAM when available
        for (let gpu of this.gpus) {
            let gpuTemp = gpu.data.length > 0 ? gpu.data[gpu.data.length - 1] : 0;
            if (this.useFahrenheit) {
                gpuTemp = this._celsiusToFahrenheit(gpuTemp);
            }
            let line = gpu.label + (gpu.hasMonitor ? " [display]" : "") +
                ": " + gpuTemp.toFixed(0) + unit;
            if (gpu.vram.total > 0) {
                let usedGB = (gpu.vram.used / MIB_PER_GIB).toFixed(1);
                let totalGB = (gpu.vram.total / MIB_PER_GIB).toFixed(0);
                let pct = Math.round(gpu.vram.fraction * 100);
                line += "  VRAM: " + usedGB + "/" + totalGB + "GB (" + pct + "%)";
            }
            lines.push(line);
        }
        
        this._tooltip.set_text(lines.join("\n"));
    },
    
    _getCpuTemperature: function() {
        let temp = 0;
        
        // Method 1: thermal_zone files (preferred - no process spawn)
        try {
            let thermalFiles = [
                '/sys/class/thermal/thermal_zone0/temp',
                '/sys/class/thermal/thermal_zone1/temp'
            ];
            for (let file of thermalFiles) {
                if (GLib.file_test(file, GLib.FileTest.EXISTS)) {
                    let [res, out] = GLib.file_get_contents(file);
                    if (res) {
                        temp = parseInt(ByteArray.toString(out)) / 1000;
                        if (!isNaN(temp) && temp > 0) return temp;
                    }
                }
            }
        } catch (e) {}
        
        // Method 2: sensors command (needs bash for pipe)
        try {
            let [res, out] = GLib.spawn_command_line_sync(
                "bash -c \"sensors -u 2>/dev/null | grep temp1_input | head -n1 | awk '{print $2}'\""
            );
            if (res && out) {
                temp = parseFloat(ByteArray.toString(out));
                if (!isNaN(temp) && temp > 0) return temp;
            }
        } catch (e) {}
        
        // Return simulated data if no sensor found
        return 45 + Math.random() * 15;
    },
    
    _readFile: function(path) {
        // Returns trimmed file contents, or null if unreadable
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
            let [res, out] = GLib.file_get_contents(path);
            return res ? ByteArray.toString(out).trim() : null;
        } catch (e) {
            return null;
        }
    },
    
    _findHwmonTemp: function(hwmonPath) {
        // Returns the first hwmon temp1_input path under hwmonPath, or null
        try {
            if (!GLib.file_test(hwmonPath, GLib.FileTest.EXISTS)) return null;
            let dir = Gio.File.new_for_path(hwmonPath);
            let enumerator = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) != null) {
                let tempFile = hwmonPath + '/' + info.get_name() + '/temp1_input';
                if (GLib.file_test(tempFile, GLib.FileTest.EXISTS)) return tempFile;
            }
        } catch (e) {}
        return null;
    },
    
    _detectGpus: function() {
        // Runs once at startup. Builds the per-GPU state list (capped at MAX_GPUS).
        let gpus = [];
        
        // DRM entries: all cardN names, plus the connector entries (cardN-<connector>)
        let cards = [];
        this.drmEntries = [];
        try {
            let drm = Gio.File.new_for_path(DRM_PATH);
            let enumerator = drm.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) != null) {
                let name = info.get_name();
                this.drmEntries.push(name);
                if (DRM_CARD_REGEX.test(name)) cards.push(name);
            }
            cards.sort();
        } catch (e) {}
        
        // NVIDIA: nvidia-smi prints one csv line per GPU
        try {
            let [res, out] = GLib.spawn_command_line_sync(NVIDIA_QUERY_CMD);
            if (res && out) {
                for (let line of ByteArray.toString(out).trim().split('\n')) {
                    let parts = line.split(',');
                    if (parts.length < NVIDIA_FIELD_COUNT) continue;
                    gpus.push({
                        vendor: VENDOR_NVIDIA,
                        nvIndex: parseInt(parts[0]),
                        card: this._findCardByPciAddress(cards, parts[1].trim())
                    });
                }
            }
        } catch (e) {}
        
        // AMD: keep drm cards that are AMD and expose a hwmon temperature
        try {
            for (let card of cards) {
                let devPath = DRM_PATH + '/' + card + '/device';
                if (this._readFile(devPath + '/vendor') !== AMD_PCI_VENDOR_ID) continue;
                let tempPath = this._findHwmonTemp(devPath + '/hwmon');
                if (!tempPath) continue;
                gpus.push({
                    vendor: VENDOR_AMD,
                    card: card,
                    tempPath: tempPath,
                    vramUsedPath: devPath + '/mem_info_vram_used',
                    vramTotalPath: devPath + '/mem_info_vram_total'
                });
            }
        } catch (e) {}
        
        if (gpus.length > MAX_GPUS) {
            global.log(this.metadata.uuid + ": " + gpus.length +
                " GPUs detected, only the first " + MAX_GPUS + " are shown");
            gpus = gpus.slice(0, MAX_GPUS);
        }
        
        // No sensor found: keep one simulated GPU so the graph still draws
        if (gpus.length === 0) {
            gpus.push({vendor: VENDOR_SIMULATED});
        }
        
        gpus.forEach(function(gpu, i) {
            gpu.label = "GPU" + i;
            gpu.hasMonitor = false;
            gpu.data = [];
            gpu.vram = {used: 0, total: 0, fraction: 0}; // MiB
        });
        return gpus;
    },
    
    _findCardByPciAddress: function(cards, busId) {
        // Returns the drm card whose device symlink ends in the given PCI address, or null
        let wanted = busId.toLowerCase().slice(-PCI_ADDRESS_LENGTH);
        for (let card of cards) {
            try {
                let target = GLib.file_read_link(DRM_PATH + '/' + card + '/device');
                if (target.toLowerCase().endsWith(wanted)) return card;
            } catch (e) {}
        }
        return null;
    },
    
    _cardHasMonitor: function(card) {
        // True if any connector of this card (cardN-<connector>) reports "connected"
        if (!card) return false;
        let prefix = card + '-';
        for (let name of this.drmEntries) {
            if (!name.startsWith(prefix)) continue;
            let status = this._readFile(DRM_PATH + '/' + name + '/' + DRM_STATUS_FILE);
            if (status === DRM_STATUS_CONNECTED) return true;
        }
        return false;
    },
    
    _queryNvidia: function() {
        // Returns {gpuIndex: {temp, used, total}} from a single nvidia-smi call
        let readings = {};
        if (!this.gpus.some(function(gpu) { return gpu.vendor === VENDOR_NVIDIA; })) {
            return readings;
        }
        try {
            let [res, out] = GLib.spawn_command_line_sync(NVIDIA_QUERY_CMD);
            if (res && out) {
                for (let line of ByteArray.toString(out).trim().split('\n')) {
                    let parts = line.split(',');
                    if (parts.length < NVIDIA_FIELD_COUNT) continue;
                    readings[parseInt(parts[0])] = {
                        temp: parseFloat(parts[2]),
                        used: parseFloat(parts[3]),
                        total: parseFloat(parts[4])
                    };
                }
            }
        } catch (e) {}
        return readings;
    },
    
    _setVram: function(gpu, used, total) {
        if (!isNaN(used) && !isNaN(total) && total > 0) {
            gpu.vram.used = used;
            gpu.vram.total = total;
            gpu.vram.fraction = used / total;
        }
    },
    
    _readAmdGpu: function(gpu) {
        // Returns temperature in Celsius (or NaN) and refreshes VRAM
        let temp = parseInt(this._readFile(gpu.tempPath)) / MILLIDEGREES_PER_DEGREE;
        let used = parseInt(this._readFile(gpu.vramUsedPath)) / BYTES_PER_MIB;
        let total = parseInt(this._readFile(gpu.vramTotalPath)) / BYTES_PER_MIB;
        this._setVram(gpu, used, total);
        return temp;
    },
    
    _updateGpus: function() {
        let nvidia = this._queryNvidia();
        
        for (let gpu of this.gpus) {
            gpu.hasMonitor = this._cardHasMonitor(gpu.card);
            let temp = NaN;
            if (gpu.vendor === VENDOR_NVIDIA) {
                let reading = nvidia[gpu.nvIndex];
                if (reading) {
                    temp = reading.temp;
                    this._setVram(gpu, reading.used, reading.total);
                }
            } else if (gpu.vendor === VENDOR_AMD) {
                temp = this._readAmdGpu(gpu);
            } else {
                temp = 50 + Math.random() * 20;
            }
            
            // On a failed read, repeat the last value so the graph stays continuous
            if (isNaN(temp) || temp <= 0) {
                temp = gpu.data.length > 0 ? gpu.data[gpu.data.length - 1] : 0;
            }
            
            gpu.data.push(temp);
            if (gpu.data.length > this.maxBufferSize) {
                gpu.data.shift();
            }
        }
    },
    
    _gpuColor: function(index) {
        return this[GPU_COLOR_SETTINGS[index][1]];
    },
    
    _gpuSeries: function() {
        return this.gpus.map(Lang.bind(this, function(gpu, i) {
            return {data: gpu.data, color: this._gpuColor(i), label: gpu.label};
        }));
    },
    
    _vramStripWidth: function(barWidth) {
        let count = this.gpus.length;
        return count * barWidth + (count - 1) * VRAM_BAR_GAP;
    },
    
    _drawCpuGraph: function(canvas) {
        this._drawGraph(canvas, this.cpuData, this.cpuColor, "CPU");
    },
    
    _strokeSeries: function(cr, data, colorStr, height, xStep) {
        // Draws one temperature polyline, scaled to the configured Y range
        if (data.length < 2) return;
        let line = this._parseColor(colorStr);
        cr.setSourceRGBA(line.r, line.g, line.b, line.a);
        cr.setLineWidth(GPU_LINE_WIDTH);
        for (let i = 0; i < data.length; i++) {
            let temp = this.useFahrenheit ? this._celsiusToFahrenheit(data[i]) : data[i];
            let y = height - ((temp - this.tempMin) / (this.tempMax - this.tempMin)) * height;
            if (i === 0) {
                cr.moveTo(0, y);
            } else {
                cr.lineTo(i * xStep, y);
            }
        }
        cr.stroke();
    },
    
    _drawGpuGraph: function(canvas) {
        let cr = canvas.get_context();
        let [width, height] = canvas.get_surface_size();
        
        // Parse colors
        let bg = this._parseColor(this.bgColor);
        let grid = this._parseColor(this.gridColor);
        
        // Draw background
        cr.setSourceRGBA(bg.r, bg.g, bg.b, bg.a);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        
        // Draw grid
        cr.setSourceRGBA(grid.r, grid.g, grid.b, grid.a);
        cr.setLineWidth(1);
        for (let i = 0; i <= 4; i++) {
            let y = (height / 4) * i;
            cr.moveTo(0, y);
            cr.lineTo(width, y);
        }
        for (let i = 0; i <= 4; i++) {
            let x = (width / 4) * i;
            cr.moveTo(x, 0);
            cr.lineTo(x, height);
        }
        cr.stroke();
        
        // Draw one temperature polyline per GPU
        let xStep = width / (this.maxDataPoints - 1);
        this.gpus.forEach(Lang.bind(this, function(gpu, i) {
            this._strokeSeries(cr, gpu.data.slice(-this.maxDataPoints),
                this._gpuColor(i), height, xStep);
        }));
        
        // Draw current temperature per GPU (white for one GPU, GPU color for several)
        cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(PANEL_LABEL_FONT_SIZE);
        let unit = this.useFahrenheit ? "\u00B0F" : "\u00B0C";
        this.gpus.forEach(Lang.bind(this, function(gpu, i) {
            if (gpu.data.length === 0) return;
            let c = this.gpus.length > 1 ? this._parseColor(this._gpuColor(i)) : {r: 1, g: 1, b: 1};
            cr.setSourceRGBA(c.r, c.g, c.b, 0.9);
            let latest = gpu.data[gpu.data.length - 1];
            let temp = this.useFahrenheit ? this._celsiusToFahrenheit(latest) : latest;
            cr.moveTo(PANEL_LABEL_X, PANEL_LABEL_FIRST_Y + i * PANEL_LABEL_LINE_HEIGHT);
            cr.showText(temp.toFixed(1) + unit);
        }));
        
        // Blinking red dot for each GPU that has a monitor connected
        if (this._blinkOn) {
            cr.setSourceRGBA(MONITOR_DOT_COLOR.r, MONITOR_DOT_COLOR.g,
                MONITOR_DOT_COLOR.b, MONITOR_DOT_COLOR.a);
            // Anchor to the label: same row baseline as the text, raised to mid-digit height
            let dotRise = Math.round(PANEL_LABEL_FONT_SIZE * MONITOR_DOT_BASELINE_FRACTION);
            this.gpus.forEach(function(gpu, i) {
                if (!gpu.hasMonitor) return;
                let baseline = PANEL_LABEL_FIRST_Y + i * PANEL_LABEL_LINE_HEIGHT;
                cr.rectangle(MONITOR_DOT_X, baseline - dotRise,
                    MONITOR_DOT_SIZE, MONITOR_DOT_SIZE);
                cr.fill();
            });
        }
        
        cr.$dispose();
    },
    
    _drawVramBars: function(canvas, barWidth) {
        // One vertical bar per GPU, filled from the bottom by VRAM fraction
        let cr = canvas.get_context();
        let [width, height] = canvas.get_surface_size();
        
        let bg = this._parseColor(this.bgColor);
        cr.setSourceRGBA(bg.r, bg.g, bg.b, bg.a);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        
        this.gpus.forEach(Lang.bind(this, function(gpu, i) {
            let c = this._parseColor(this._gpuColor(i));
            let x = i * (barWidth + VRAM_BAR_GAP);
            
            // Full-height track
            cr.setSourceRGBA(c.r, c.g, c.b, VRAM_TRACK_ALPHA);
            cr.rectangle(x, 0, barWidth, height);
            cr.fill();
            
            // Used portion
            let fillHeight = Math.round(height * gpu.vram.fraction);
            if (fillHeight > 0) {
                cr.setSourceRGBA(c.r, c.g, c.b, VRAM_FILL_ALPHA);
                cr.rectangle(x, height - fillHeight, barWidth, fillHeight);
                cr.fill();
            }
        }));
        
        cr.$dispose();
    },
    
    _drawGraph: function(canvas, data, color, label) {
        let cr = canvas.get_context();
        let [width, height] = canvas.get_surface_size();
        
        // Parse colors
        let bg = this._parseColor(this.bgColor);
        let grid = this._parseColor(this.gridColor);
        let line = this._parseColor(color);
        
        // Draw background
        cr.setSourceRGBA(bg.r, bg.g, bg.b, bg.a);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        
        // Temperature range (user enters in their chosen unit directly)
        let minTemp = this.tempMin;
        let maxTemp = this.tempMax;
        
        // Draw grid
        cr.setSourceRGBA(grid.r, grid.g, grid.b, grid.a);
        cr.setLineWidth(1);
        
        // Horizontal grid lines (temperature)
        for (let i = 0; i <= 4; i++) {
            let y = (height / 4) * i;
            cr.moveTo(0, y);
            cr.lineTo(width, y);
        }
        
        // Vertical grid lines (time)
        for (let i = 0; i <= 4; i++) {
            let x = (width / 4) * i;
            cr.moveTo(x, 0);
            cr.lineTo(x, height);
        }
        cr.stroke();
        
        // Get the window of data to display (most recent maxDataPoints)
        let displayData = data.slice(-this.maxDataPoints);
        
        // Draw temperature graph
        if (displayData.length > 1) {
            cr.setSourceRGBA(line.r, line.g, line.b, line.a);
            cr.setLineWidth(2);
            
            let xStep = width / (this.maxDataPoints - 1);
            
            // Convert first data point if using Fahrenheit
            let firstTemp = this.useFahrenheit ? this._celsiusToFahrenheit(displayData[0]) : displayData[0];
            cr.moveTo(0, height - ((firstTemp - minTemp) / (maxTemp - minTemp)) * height);
            
            for (let i = 1; i < displayData.length; i++) {
                let x = i * xStep;
                let temp = this.useFahrenheit ? this._celsiusToFahrenheit(displayData[i]) : displayData[i];
                let y = height - ((temp - minTemp) / (maxTemp - minTemp)) * height;
                cr.lineTo(x, y);
            }
            cr.stroke();
        }
        
        // Draw current temperature
        if (data.length > 0) {
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(12);
            let temp = this.useFahrenheit ? this._celsiusToFahrenheit(data[data.length - 1]) : data[data.length - 1];
            let unit = this.useFahrenheit ? "°F" : "°C";
            cr.moveTo(5, 15);
            cr.showText(temp.toFixed(1) + unit);
        }
        
        cr.$dispose();
    },
    
    _drawPopupGraph: function(canvas, series) {
        // series: [{data, color, label}], all drawn on shared axes
        let cr = canvas.get_context();
        let [width, height] = canvas.get_surface_size();
        
        // Parse colors
        let bg = this._parseColor(this.bgColor);
        let grid = this._parseColor(this.gridColor);
        
        // Draw background
        cr.setSourceRGBA(bg.r, bg.g, bg.b, bg.a);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        
        // Temperature range (user enters in their chosen unit directly)
        let minTemp = this.tempMin;
        let maxTemp = this.tempMax;
        
        // Draw grid
        cr.setSourceRGBA(grid.r, grid.g, grid.b, grid.a);
        cr.setLineWidth(1);
        
        // Horizontal grid lines (temperature)
        for (let i = 0; i <= 4; i++) {
            let y = (height / 4) * i;
            cr.moveTo(0, y);
            cr.lineTo(width, y);
        }
        
        // Vertical grid lines (time)
        for (let i = 0; i <= 4; i++) {
            let x = (width / 4) * i;
            cr.moveTo(x, 0);
            cr.lineTo(x, height);
        }
        cr.stroke();
        
        // Draw temperature labels on grid lines
        cr.setSourceRGBA(grid.r, grid.g, grid.b, grid.a);
        cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
        cr.setFontSize(10);
        for (let i = 0; i <= 4; i++) {
            let y = (height / 4) * i;
            let temp = maxTemp - ((maxTemp - minTemp) / 4) * i;
            let unit = this.useFahrenheit ? "\u00B0F" : "\u00B0C";
            let tempLabel = temp.toFixed(0) + unit;
            cr.moveTo(5, y - 3);
            cr.showText(tempLabel);
        }
        
        // Draw each series using all buffer data (full range)
        for (let s of series) {
            let xStep = width / (s.data.length - 1);
            this._strokeSeries(cr, s.data, s.color, height, xStep);
        }
        
        // Draw legend: label and current temperature per series
        // (white for a single series, series color for several)
        cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(14);
        let unit = this.useFahrenheit ? "\u00B0F" : "\u00B0C";
        series.forEach(Lang.bind(this, function(s, i) {
            if (s.data.length === 0) return;
            let c = series.length > 1 ? this._parseColor(s.color) : {r: 1, g: 1, b: 1};
            cr.setSourceRGBA(c.r, c.g, c.b, 0.9);
            let latest = s.data[s.data.length - 1];
            let temp = this.useFahrenheit ? this._celsiusToFahrenheit(latest) : latest;
            cr.moveTo(PANEL_LABEL_X, POPUP_LABEL_FIRST_Y + i * POPUP_LABEL_LINE_HEIGHT);
            cr.showText(s.label + ": " + temp.toFixed(1) + unit);
        }));
        
        cr.$dispose();
    },
    
    _parseColor: function(colorStr) {
        // Parse color string (e.g., "rgba(255,0,0,1)" or "#ff0000")
        let r = 0, g = 0, b = 0, a = 1;
        
        if (colorStr.startsWith('rgba')) {
            let match = colorStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
            if (match) {
                r = parseInt(match[1]) / 255;
                g = parseInt(match[2]) / 255;
                b = parseInt(match[3]) / 255;
                a = parseFloat(match[4]);
            }
        } else if (colorStr.startsWith('rgb')) {
            let match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (match) {
                r = parseInt(match[1]) / 255;
                g = parseInt(match[2]) / 255;
                b = parseInt(match[3]) / 255;
            }
        } else if (colorStr.startsWith('#')) {
            let hex = colorStr.substring(1);
            r = parseInt(hex.substr(0, 2), 16) / 255;
            g = parseInt(hex.substr(2, 2), 16) / 255;
            b = parseInt(hex.substr(4, 2), 16) / 255;
        }
        
        return {r: r, g: g, b: b, a: a};
    },
    
    _celsiusToFahrenheit: function(celsius) {
        return (celsius * 9/5) + 32;
    },
    
    on_settings_changed: function() {
        // Update max data points
        this.maxDataPoints = Math.floor(this.timeRange / this.sampleRate);
        
        // Determine effective height
        let effectiveHeight = this.overridePanelHeight ? this.graphHeight : this.panel_height;
        
        // Resize canvases
        this.cpuCanvas.set_width(this.graphWidth);
        this.cpuCanvas.set_height(effectiveHeight);
        this.gpuCanvas.set_width(this.graphWidth);
        this.gpuCanvas.set_height(effectiveHeight);
        this.vramCanvas.set_height(effectiveHeight);
        
        // Restart monitoring with new sample rate
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
            this._timeout = null;
        }
        this._timeout = Mainloop.timeout_add_seconds(this.sampleRate,
            Lang.bind(this, this._updateTemperatures));
        
        // Redraw
        this.cpuCanvas.queue_repaint();
        this.gpuCanvas.queue_repaint();
        this.vramCanvas.queue_repaint();
    },
    
    on_buffer_size_changed: function() {
        let newSize = this.bufferSize;
        let currentSize = this.cpuData.length;
        
        // If reducing buffer size and would lose data, show confirmation
        if (newSize < currentSize) {
            this.pendingBufferSize = newSize;
            this._showBufferSizeWarning(currentSize, newSize);
        } else {
            // Increasing size or no data loss, apply immediately
            this.maxBufferSize = newSize;
        }
    },
    
    _showBufferSizeWarning: function(currentSize, newSize) {
        let dialog = new ModalDialog.ModalDialog();
        
        let label = new St.Label({
            text: "Warning: Reducing buffer size from " + currentSize + " to " + newSize + 
                  " will discard the " + (currentSize - newSize) + " oldest readings.\n\n" +
                  "Do you want to continue?",
            style: "padding: 20px;"
        });
        
        dialog.contentLayout.add(label);
        
        dialog.setButtons([
            {
                label: "Cancel",
                action: Lang.bind(this, function() {
                    // Revert the setting to current buffer size
                    this.settings.setValue("buffer-size", this.maxBufferSize);
                    this.pendingBufferSize = null;
                    dialog.close();
                })
            },
            {
                label: "OK",
                action: Lang.bind(this, function() {
                    // Apply the new buffer size
                    this._applyBufferSizeChange();
                    dialog.close();
                })
            }
        ]);
        
        dialog.open();
    },
    
    _applyBufferSizeChange: function() {
        if (this.pendingBufferSize !== null) {
            this.maxBufferSize = this.pendingBufferSize;
            
            // Trim buffers to new size, keeping most recent data
            if (this.cpuData.length > this.maxBufferSize) {
                this.cpuData = this.cpuData.slice(-this.maxBufferSize);
            }
            for (let gpu of this.gpus) {
                if (gpu.data.length > this.maxBufferSize) {
                    gpu.data = gpu.data.slice(-this.maxBufferSize);
                }
            }
            
            this.pendingBufferSize = null;
            
            // Redraw graphs
            this.cpuCanvas.queue_repaint();
            this.gpuCanvas.queue_repaint();
            if (this.menu && this.menu.isOpen) {
                this.popupCpuCanvas.queue_repaint();
                this.popupGpuCanvas.queue_repaint();
                this.popupVramCanvas.queue_repaint();
            }
        }
    },
    
    on_applet_removed_from_panel: function() {
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
        }
        if (this._blinkTimeout) {
            Mainloop.source_remove(this._blinkTimeout);
            this._blinkTimeout = null;
        }
    },
    
    on_panel_height_changed: function() {
        if (!this.overridePanelHeight) {
            this.cpuCanvas.set_height(this._panelHeight);
            this.gpuCanvas.set_height(this._panelHeight);
            this.vramCanvas.set_height(this._panelHeight);
            this.cpuCanvas.queue_repaint();
            this.gpuCanvas.queue_repaint();
            this.vramCanvas.queue_repaint();
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new TemperatureMonitorApplet(metadata, orientation, panel_height, instance_id);
}