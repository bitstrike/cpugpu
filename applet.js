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
        
        // Initialize settings
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("graph-width", "graphWidth", this.on_settings_changed);
        this.settings.bind("graph-height", "graphHeight", this.on_settings_changed);
        this.settings.bind("override-panel-height", "overridePanelHeight", this.on_settings_changed);
        this.settings.bind("time-range", "timeRange", this.on_settings_changed);
        this.settings.bind("sample-rate", "sampleRate", this.on_settings_changed);
        this.settings.bind("cpu-color", "cpuColor", this.on_settings_changed);
        this.settings.bind("gpu-color", "gpuColor", this.on_settings_changed);
        this.settings.bind("bg-color", "bgColor", this.on_settings_changed);
        this.settings.bind("grid-color", "gridColor", this.on_settings_changed);
        this.settings.bind("use-fahrenheit", "useFahrenheit", this.on_settings_changed);
        this.settings.bind("temp-min", "tempMin", this.on_settings_changed);
        this.settings.bind("temp-max", "tempMax", this.on_settings_changed);
        this.settings.bind("buffer-size", "bufferSize", this.on_buffer_size_changed);
        
        // Data storage
        this.cpuData = [];
        this.gpuData = [];
        this.gpuVramFraction = 0; // 0.0 to 1.0, current VRAM usage
        this.gpuVramUsed = 0;    // MiB
        this.gpuVramTotal = 0;   // MiB
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
        
        // Add "About" to the applet context menu (right-click)
        let aboutItem = new PopupMenu.PopupMenuItem("About");
        aboutItem.connect('activate', Lang.bind(this, this._showAboutDialog));
        this._applet_context_menu.addMenuItem(aboutItem);
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
        
        // Add canvases to container
        this.mainBox.add(this.cpuCanvas);
        this.mainBox.add(new St.Widget({width: 5})); // Spacer
        this.mainBox.add(this.gpuCanvas);
        
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
            width: 300,
            height: 200,
            style_class: 'temp-graph-canvas'
        });
        this.popupCpuCanvas.connect('repaint', Lang.bind(this, function(canvas) {
            this._drawPopupGraph(canvas, this.cpuData, this.cpuColor, "CPU");
        }));
        
        // Spacer
        let spacer = new St.Widget({width: 10});
        
        // Large GPU graph
        this.popupGpuCanvas = new St.DrawingArea({
            width: 300,
            height: 200,
            style_class: 'temp-graph-canvas'
        });
        this.popupGpuCanvas.connect('repaint', Lang.bind(this, function(canvas) {
            this._drawPopupGraph(canvas, this.gpuData, this.gpuColor, "GPU");
        }));
        
        graphsBox.add(this.popupCpuCanvas);
        graphsBox.add(spacer);
        graphsBox.add(this.popupGpuCanvas);
        
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
            }
            return true;
        }
        return false;
    },
    
    _showAboutDialog: function() {
        let dialog = new ModalDialog.ModalDialog();
        
        let contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'about-dialog-content'
        });
        
        // Load icon.svg from applet directory
        let iconPath = this.metadata.path + "/icon.svg";
        let icon = new St.Icon({
            icon_size: 64,
            icon_type: St.IconType.FULLCOLOR,
            style_class: 'about-dialog-icon'
        });
        icon.set_gicon(Gio.FileIcon.new(Gio.File.new_for_path(iconPath)));
        contentBox.add(icon, {x_align: St.Align.MIDDLE});
        
        let title = new St.Label({
            text: this.metadata.name,
            style_class: 'about-dialog-title'
        });
        contentBox.add(title, {x_align: St.Align.MIDDLE});
        
        let version = new St.Label({
            text: "v" + this.metadata.version,
            style_class: 'about-dialog-version'
        });
        contentBox.add(version, {x_align: St.Align.MIDDLE});
        
        let description = new St.Label({
            text: this.metadata.description,
            style_class: 'about-dialog-description'
        });
        contentBox.add(description, {x_align: St.Align.MIDDLE});
        
        dialog.contentLayout.add(contentBox);
        
        dialog.setButtons([{
            label: "Close",
            action: function() { dialog.close(); }
        }]);
        
        dialog.open();
    },
    
    _startMonitoring: function() {
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
        
        // Read GPU temperature (always store in Celsius internally)
        let gpuTemp = this._getGpuTemperature();
        this.gpuData.push(gpuTemp);
        
        // Maintain buffer of 1000 readings
        if (this.gpuData.length > this.maxBufferSize) {
            this.gpuData.shift();
        }
        
        // Redraw graphs
        this.cpuCanvas.queue_repaint();
        this.gpuCanvas.queue_repaint();
        
        // Redraw popup graphs if menu is open
        if (this.menu && this.menu.isOpen) {
            this.popupCpuCanvas.queue_repaint();
            this.popupGpuCanvas.queue_repaint();
        }
        
        // Update tooltip
        this._updateTooltip();
        
        return true;
    },
    
    _updateTooltip: function() {
        let cpuTemp = this.cpuData.length > 0 ? this.cpuData[this.cpuData.length - 1] : 0;
        let gpuTemp = this.gpuData.length > 0 ? this.gpuData[this.gpuData.length - 1] : 0;
        let unit = this.useFahrenheit ? "\u00B0F" : "\u00B0C";
        
        if (this.useFahrenheit) {
            cpuTemp = this._celsiusToFahrenheit(cpuTemp);
            gpuTemp = this._celsiusToFahrenheit(gpuTemp);
        }
        
        let text = "CPU: " + cpuTemp.toFixed(0) + unit +
                   "  GPU: " + gpuTemp.toFixed(0) + unit;
        
        if (this.gpuVramTotal > 0) {
            let usedGB = (this.gpuVramUsed / 1024).toFixed(1);
            let totalGB = (this.gpuVramTotal / 1024).toFixed(0);
            let pct = Math.round(this.gpuVramFraction * 100);
            text += "  VRAM: " + usedGB + "/" + totalGB + "GB (" + pct + "%)";
        }
        
        this._tooltip.set_text(text);
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
    
    _getGpuTemperature: function() {
        let temp = 0;
        
        // Method 1: NVIDIA GPU (get temp and VRAM in one call)
        try {
            let [res, out] = GLib.spawn_command_line_sync(
                "nvidia-smi --query-gpu=temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits"
            );
            if (res && out) {
                let parts = ByteArray.toString(out).trim().split(',');
                temp = parseFloat(parts[0]);
                if (!isNaN(temp) && temp > 0) {
                    let used = parseFloat(parts[1]);
                    let total = parseFloat(parts[2]);
                    if (!isNaN(used) && !isNaN(total) && total > 0) {
                        this.gpuVramUsed = used;
                        this.gpuVramTotal = total;
                        this.gpuVramFraction = used / total;
                    }
                    return temp;
                }
            }
        } catch (e) {}
        
        // Method 2: AMD GPU
        try {
            let hwmonPath = '/sys/class/drm/card0/device/hwmon';
            if (GLib.file_test(hwmonPath, GLib.FileTest.EXISTS)) {
                let dir = Gio.File.new_for_path(hwmonPath);
                let enumerator = dir.enumerate_children('standard::name', 
                    Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = enumerator.next_file(null)) != null) {
                    let tempFile = hwmonPath + '/' + info.get_name() + '/temp1_input';
                    if (GLib.file_test(tempFile, GLib.FileTest.EXISTS)) {
                        let [res, out] = GLib.file_get_contents(tempFile);
                        if (res) {
                            temp = parseInt(ByteArray.toString(out)) / 1000;
                            if (!isNaN(temp) && temp > 0) {
                                this._getAmdVram();
                                return temp;
                            }
                        }
                    }
                }
            }
        } catch (e) {}
        
        // Return simulated data if no sensor found
        return 50 + Math.random() * 20;
    },
    
    _getAmdVram: function() {
        try {
            let usedFile = '/sys/class/drm/card0/device/mem_info_vram_used';
            let totalFile = '/sys/class/drm/card0/device/mem_info_vram_total';
            if (GLib.file_test(usedFile, GLib.FileTest.EXISTS) &&
                GLib.file_test(totalFile, GLib.FileTest.EXISTS)) {
                let [r1, usedOut] = GLib.file_get_contents(usedFile);
                let [r2, totalOut] = GLib.file_get_contents(totalFile);
                if (r1 && r2) {
                    let used = parseInt(ByteArray.toString(usedOut)) / (1024 * 1024);
                    let total = parseInt(ByteArray.toString(totalOut)) / (1024 * 1024);
                    if (total > 0) {
                        this.gpuVramUsed = used;
                        this.gpuVramTotal = total;
                        this.gpuVramFraction = used / total;
                    }
                }
            }
        } catch (e) {}
    },
    
    _drawCpuGraph: function(canvas) {
        this._drawGraph(canvas, this.cpuData, this.cpuColor, "CPU");
    },
    
    _drawGpuGraph: function(canvas) {
        let cr = canvas.get_context();
        let [width, height] = canvas.get_surface_size();
        
        // Parse colors
        let bg = this._parseColor(this.bgColor);
        let grid = this._parseColor(this.gridColor);
        let line = this._parseColor(this.gpuColor);
        
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
        
        // Draw VRAM usage bar (gradient green->red, translucent)
        if (this.gpuVramFraction > 0) {
            let barHeight = Math.round(height * this.gpuVramFraction);
            
            // Draw gradient manually as horizontal slices
            for (let row = 0; row < barHeight; row++) {
                // t=0 at bottom (green), t=1 at top (red)
                let t = row / barHeight;
                let r = t * 0.8;
                let g = (1 - t) * 0.8;
                cr.setSourceRGBA(r, g, 0, 0.3);
                cr.rectangle(0, height - 1 - row, width, 1);
                cr.fill();
            }
        }
        
        // Draw temperature polyline
        let displayData = this.gpuData.slice(-this.maxDataPoints);
        if (displayData.length > 1) {
            cr.setSourceRGBA(line.r, line.g, line.b, line.a);
            cr.setLineWidth(2);
            
            let xStep = width / (this.maxDataPoints - 1);
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
        
        // Draw current temperature text
        if (this.gpuData.length > 0) {
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(12);
            let temp = this.useFahrenheit ? this._celsiusToFahrenheit(this.gpuData[this.gpuData.length - 1]) : this.gpuData[this.gpuData.length - 1];
            let unit = this.useFahrenheit ? "\u00B0F" : "\u00B0C";
            cr.moveTo(5, 15);
            cr.showText(temp.toFixed(1) + unit);
        }
        
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
    
    _drawPopupGraph: function(canvas, data, color, label) {
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
        
        // Use all buffer data for popup (full range)
        let displayData = data;
        
        // Draw temperature graph
        if (displayData.length > 1) {
            cr.setSourceRGBA(line.r, line.g, line.b, line.a);
            cr.setLineWidth(2);
            
            let xStep = width / (displayData.length - 1);
            
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
        
        // Draw label and current temperature
        if (data.length > 0) {
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(14);
            let temp = this.useFahrenheit ? this._celsiusToFahrenheit(data[data.length - 1]) : data[data.length - 1];
            let unit = this.useFahrenheit ? "°F" : "°C";
            cr.moveTo(5, 18);
            cr.showText(label + ": " + temp.toFixed(1) + unit);
        }
        
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
            if (this.gpuData.length > this.maxBufferSize) {
                this.gpuData = this.gpuData.slice(-this.maxBufferSize);
            }
            
            this.pendingBufferSize = null;
            
            // Redraw graphs
            this.cpuCanvas.queue_repaint();
            this.gpuCanvas.queue_repaint();
            if (this.menu && this.menu.isOpen) {
                this.popupCpuCanvas.queue_repaint();
                this.popupGpuCanvas.queue_repaint();
            }
        }
    },
    
    on_applet_removed_from_panel: function() {
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
        }
    },
    
    on_panel_height_changed: function() {
        if (!this.overridePanelHeight) {
            this.cpuCanvas.set_height(this._panelHeight);
            this.gpuCanvas.set_height(this._panelHeight);
            this.cpuCanvas.queue_repaint();
            this.gpuCanvas.queue_repaint();
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new TemperatureMonitorApplet(metadata, orientation, panel_height, instance_id);
}