const Applet = imports.ui.applet;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Settings = imports.ui.settings;

/**
 * System Monitor Applet for Cinnamon Desktop
 * Provides real-time CPU and GPU monitoring in the panel
 */
function SystemMonitorApplet(orientation, panel_height, instance_id) {
    this._init(orientation, panel_height, instance_id);
}

SystemMonitorApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    /**
     * Initialize the applet
     */
    _init: function(orientation, panel_height, instance_id) {
        Applet.TextIconApplet.prototype._init.call(this, orientation, panel_height, instance_id);
        
        this.set_applet_icon_name("utilities-system-monitor");
        this.set_applet_label("CPU: 0%");
        this.set_applet_tooltip("System Monitor - Click to configure");
        
        // Initialize monitoring state
        this._monitoring_active = false;
        this._refresh_interval = 1000; // Default 1 second
        this._timeout_id = null;
        this._last_update_time = 0;
        this._update_in_progress = false;
        
        // Initialize data structures using SystemMetrics model
        this._current_metrics = this._create_empty_system_metrics();
        
        // Set up settings
        this._setup_settings();
        
        // Set up tooltip handlers
        this._setup_tooltip_handlers();
        
        // Set up context menu
        this._create_context_menu();
        
        // Set up theme integration and monitoring
        this._integrate_with_cinnamon_theme();
        this._setup_theme_monitoring();
    },

    /**
     * Create empty SystemMetrics data structure
     * @returns {Object} Empty SystemMetrics object with proper structure
     */
    _create_empty_system_metrics: function() {
        return {
            cpu: {
                usage: 0,
                cores: [],
                temperature: null
            },
            gpu: {
                usage: 0,
                memory: {
                    used: 0,
                    total: 0
                },
                temperature: null
            },
            timestamp: Date.now()
        };
    },

    /**
     * Create SystemMetrics object with validation
     * @param {Object} cpu_data - CPU metrics data
     * @param {Object} gpu_data - GPU metrics data
     * @returns {Object} Validated SystemMetrics object
     */
    _create_system_metrics: function(cpu_data, gpu_data) {
        let metrics = this._create_empty_system_metrics();
        
        // Validate and sanitize CPU data
        if (cpu_data) {
            metrics.cpu = this._validate_cpu_data(cpu_data);
        }
        
        // Validate and sanitize GPU data
        if (gpu_data) {
            metrics.gpu = this._validate_gpu_data(gpu_data);
        }
        
        // Set current timestamp
        metrics.timestamp = Date.now();
        
        return metrics;
    },

    /**
     * Validate and sanitize CPU data
     * @param {Object} cpu_data - Raw CPU data
     * @returns {Object} Validated CPU data
     */
    _validate_cpu_data: function(cpu_data) {
        let validated = {
            usage: 0,
            cores: [],
            temperature: null
        };
        
        // Validate overall CPU usage (0-100%)
        if (typeof cpu_data.usage === 'number') {
            validated.usage = this._clamp_percentage(cpu_data.usage);
        }
        
        // Validate per-core usage data
        if (Array.isArray(cpu_data.cores)) {
            validated.cores = cpu_data.cores.map(core_usage => {
                return typeof core_usage === 'number' ? this._clamp_percentage(core_usage) : 0;
            });
        }
        
        // Validate temperature (if provided)
        if (typeof cpu_data.temperature === 'number' && cpu_data.temperature > -273) {
            // Temperature should be reasonable (above absolute zero)
            validated.temperature = Math.round(cpu_data.temperature);
        }
        
        return validated;
    },

    /**
     * Validate and sanitize GPU data
     * @param {Object} gpu_data - Raw GPU data
     * @returns {Object} Validated GPU data
     */
    _validate_gpu_data: function(gpu_data) {
        let validated = {
            usage: 0,
            memory: {
                used: 0,
                total: 0
            },
            temperature: null
        };
        
        // Validate GPU usage (0-100%)
        if (typeof gpu_data.usage === 'number') {
            validated.usage = this._clamp_percentage(gpu_data.usage);
        }
        
        // Validate memory data
        if (gpu_data.memory && typeof gpu_data.memory === 'object') {
            if (typeof gpu_data.memory.used === 'number' && gpu_data.memory.used >= 0) {
                validated.memory.used = Math.round(gpu_data.memory.used);
            }
            if (typeof gpu_data.memory.total === 'number' && gpu_data.memory.total >= 0) {
                validated.memory.total = Math.round(gpu_data.memory.total);
            }
            
            // Ensure used memory doesn't exceed total
            if (validated.memory.used > validated.memory.total && validated.memory.total > 0) {
                validated.memory.used = validated.memory.total;
            }
        }
        
        // Validate temperature (if provided)
        if (typeof gpu_data.temperature === 'number' && gpu_data.temperature > -273) {
            validated.temperature = Math.round(gpu_data.temperature);
        }
        
        return validated;
    },

    /**
     * Clamp percentage values to valid range (0-100)
     * @param {number} value - Input percentage value
     * @returns {number} Clamped percentage (0-100)
     */
    _clamp_percentage: function(value) {
        return Math.max(0, Math.min(100, Math.round(value)));
    },

    /**
     * Get current system metrics
     * @returns {Object} Current SystemMetrics object
     */
    _get_current_metrics: function() {
        return this._current_metrics;
    },

    /**
     * Update system metrics with new data
     * @param {Object} cpu_data - New CPU data
     * @param {Object} gpu_data - New GPU data
     */
    _update_system_metrics: function(cpu_data, gpu_data) {
        this._current_metrics = this._create_system_metrics(cpu_data, gpu_data);
    },

    /**
     * Check if metrics data is stale based on timestamp
     * @param {number} max_age_ms - Maximum age in milliseconds
     * @returns {boolean} True if data is stale
     */
    _is_metrics_stale: function(max_age_ms) {
        if (!this._current_metrics || !this._current_metrics.timestamp) {
            return true;
        }
        
        let age = Date.now() - this._current_metrics.timestamp;
        return age > max_age_ms;
    },

    /**
     * Called when applet is added to panel
     */
    on_applet_added_to_panel: function() {
        this._start_monitoring();
    },

    /**
     * Called when applet is removed from panel
     */
    on_applet_removed_from_panel: function() {
        this._stop_monitoring();
        this._cleanup_resources();
    },

    /**
     * Set up settings and configuration
     */
    _setup_settings: function() {
        try {
            // Initialize GSettings with the applet's settings schema
            this._settings_manager = new Settings.AppletSettings(this, "cpugpu@bitcrash", this.instance_id);
            
            // Bind settings to properties with change handlers
            this._bind_settings();
            
            // Validate and migrate settings if needed
            this._validate_and_migrate_settings();
            
            // Initialize internal settings object with current values
            this._update_internal_settings();
            
            // Store validation timestamp
            this._last_settings_validation = Date.now();
            
            global.log("System Monitor: Settings initialized successfully");
            
        } catch (error) {
            global.logError("System Monitor: Error setting up settings: " + error.message);
            
            // Fallback to default settings if GSettings fails
            this._setup_fallback_settings();
        }
    },

    /**
     * Bind GSettings properties to internal handlers
     */
    _bind_settings: function() {
        // Bind refresh interval with validation and change handler
        this._settings_manager.bind("refreshInterval", "refreshInterval", this._on_refresh_interval_changed.bind(this));
        
        // Bind display format with change handler
        this._settings_manager.bind("displayFormat", "displayFormat", this._on_display_format_changed.bind(this));
        
        // Bind GPU display setting
        this._settings_manager.bind("showGPU", "showGPU", this._on_show_gpu_changed.bind(this));
        
        // Bind color theme setting
        this._settings_manager.bind("colorTheme", "colorTheme", this._on_color_theme_changed.bind(this));
        
        // Bind threshold settings
        this._settings_manager.bind("warningThreshold", "warningThreshold", this._on_warning_threshold_changed.bind(this));
        this._settings_manager.bind("criticalThreshold", "criticalThreshold", this._on_critical_threshold_changed.bind(this));
        
        // Bind custom color settings
        this._settings_manager.bind("normalColor", "normalColor", this._on_custom_colors_changed.bind(this));
        this._settings_manager.bind("warningColor", "warningColor", this._on_custom_colors_changed.bind(this));
        this._settings_manager.bind("criticalColor", "criticalColor", this._on_custom_colors_changed.bind(this));
    },

    /**
     * Update internal settings object from GSettings values
     */
    _update_internal_settings: function() {
        this._settings = {
            refreshInterval: this.refreshInterval || 1000,
            displayFormat: this.displayFormat || "percentage",
            showGPU: this.showGPU !== undefined ? this.showGPU : true,
            colorTheme: this.colorTheme || "default",
            thresholds: {
                warning: this.warningThreshold || 70,
                critical: this.criticalThreshold || 90
            },
            customColors: {
                normal: this.normalColor || "#00ff00",
                warning: this.warningColor || "#ffff00",
                critical: this.criticalColor || "#ff0000"
            }
        };
    },

    /**
     * Set up fallback settings when GSettings fails
     */
    _setup_fallback_settings: function() {
        global.logWarning("System Monitor: Using fallback settings due to GSettings failure");
        
        this._settings = {
            refreshInterval: 1000,
            displayFormat: "percentage",
            showGPU: true,
            colorTheme: "default",
            thresholds: {
                warning: 70,
                critical: 90
            },
            customColors: {
                normal: "#00ff00",
                warning: "#ffff00",
                critical: "#ff0000"
            }
        };
        
        // Mark that we're using fallback settings
        this._using_fallback_settings = true;
    },

    /**
     * Start system monitoring
     */
    _start_monitoring: function() {
        if (this._monitoring_active) {
            return;
        }
        
        this._monitoring_active = true;
        this._last_update_time = 0; // Force immediate first update
        this._schedule_next_update();
        
        global.log("System Monitor: Started monitoring with " + this._refresh_interval + "ms interval");
    },

    /**
     * Stop system monitoring
     */
    _stop_monitoring: function() {
        this._monitoring_active = false;
        
        if (this._timeout_id) {
            Mainloop.source_remove(this._timeout_id);
            this._timeout_id = null;
        }
        
        this._update_in_progress = false;
        global.log("System Monitor: Stopped monitoring");
    },

    /**
     * Restart monitoring with new interval
     * @param {number} new_interval - New refresh interval in milliseconds
     */
    _restart_monitoring_with_interval: function(new_interval) {
        let was_active = this._monitoring_active;
        
        // Validate interval
        if (!this._is_valid_refresh_interval(new_interval)) {
            global.logError("System Monitor: Invalid refresh interval: " + new_interval);
            return false;
        }
        
        // Stop current monitoring
        this._stop_monitoring();
        
        // Update interval
        this._refresh_interval = new_interval;
        
        // Restart if it was active
        if (was_active) {
            this._start_monitoring();
        }
        
        global.log("System Monitor: Updated refresh interval to " + new_interval + "ms");
        return true;
    },

    /**
     * Validate refresh interval
     * @param {number} interval - Interval to validate in milliseconds
     * @returns {boolean} True if interval is valid
     */
    _is_valid_refresh_interval: function(interval) {
        return typeof interval === 'number' && 
               interval >= 100 &&  // Minimum 100ms
               interval <= 60000 && // Maximum 60 seconds
               interval % 50 === 0; // Must be multiple of 50ms for consistency
    },

    /**
     * Get current refresh interval
     * @returns {number} Current refresh interval in milliseconds
     */
    _get_refresh_interval: function() {
        return this._refresh_interval;
    },

    /**
     * Set new refresh interval without restart
     * @param {number} new_interval - New refresh interval in milliseconds
     * @returns {boolean} True if successfully updated
     */
    _set_refresh_interval: function(new_interval) {
        if (!this._is_valid_refresh_interval(new_interval)) {
            return false;
        }
        
        if (new_interval === this._refresh_interval) {
            return true; // No change needed
        }
        
        return this._restart_monitoring_with_interval(new_interval);
    },

    /**
     * Schedule next data update
     */
    _schedule_next_update: function() {
        if (!this._monitoring_active) {
            return;
        }
        
        // Clear any existing timeout
        if (this._timeout_id) {
            Mainloop.source_remove(this._timeout_id);
            this._timeout_id = null;
        }
        
        // Calculate next update time
        let now = Date.now();
        let time_since_last = now - this._last_update_time;
        let delay = Math.max(0, this._refresh_interval - time_since_last);
        
        this._timeout_id = Mainloop.timeout_add(delay, Lang.bind(this, function() {
            this._timeout_id = null;
            this._perform_scheduled_update();
            return false; // Don't repeat automatically
        }));
    },

    /**
     * Perform scheduled system update
     */
    _perform_scheduled_update: function() {
        if (!this._monitoring_active || this._update_in_progress) {
            return;
        }
        
        this._update_in_progress = true;
        let update_start_time = Date.now();
        this._last_update_time = update_start_time;
        
        try {
            // Collect system data with timeout protection
            this._update_system_data_with_timeout();
            
            // Update display with performance optimization
            this._update_display_optimized();
            
            // Track update performance
            this._track_update_performance(update_start_time);
            
        } catch (error) {
            global.logError("System Monitor: Error during scheduled update: " + error.message);
        } finally {
            this._update_in_progress = false;
            
            // Schedule next update with adaptive timing
            this._schedule_next_update_adaptive();
        }
    },

    /**
     * Update system data with timeout protection
     */
    _update_system_data_with_timeout: function() {
        let data_collection_start = Date.now();
        
        try {
            let cpu_data = this._collect_cpu_data();
            let gpu_data = this._collect_gpu_data();
            
            // Update metrics using the SystemMetrics model
            this._update_system_metrics(cpu_data, gpu_data);
            
            // Handle rapid load changes
            this._handle_rapid_load_changes();
            
            // Check if data collection took too long
            let collection_time = Date.now() - data_collection_start;
            if (collection_time > this._refresh_interval / 2) {
                global.logWarning(`System Monitor: Data collection took ${collection_time}ms (>${this._refresh_interval/2}ms threshold)`);
            }
            
        } catch (error) {
            global.logError("System Monitor: Error updating system data: " + error.message);
            
            // Use previous data if available to maintain display continuity
            if (!this._current_metrics || this._is_metrics_stale(this._refresh_interval * 3)) {
                // Create fallback metrics if no recent data available
                this._current_metrics = this._create_fallback_metrics();
            }
        }
    },

    /**
     * Create fallback metrics when data collection fails
     * @returns {Object} Fallback SystemMetrics object
     */
    _create_fallback_metrics: function() {
        return {
            cpu: {
                usage: 0,
                cores: [],
                temperature: null
            },
            gpu: {
                usage: 0,
                memory: { used: 0, total: 0 },
                temperature: null
            },
            timestamp: Date.now()
        };
    },

    /**
     * Optimized display update with change detection
     */
    _update_display_optimized: function() {
        let metrics = this._get_current_metrics();
        
        // Check if display update is necessary
        if (this._should_skip_display_update(metrics)) {
            return;
        }
        
        let display_start = Date.now();
        
        try {
            // Update panel text and icon based on display format
            this._update_panel_text_and_icon(metrics);
            
            // Update tooltip only if it's currently visible or hover is active
            if (this._tooltip_visible || this._tooltip_hover_timeout) {
                let tooltip = this._generate_detailed_tooltip(metrics);
                this.set_applet_tooltip(tooltip);
            } else {
                // Use lightweight tooltip for better performance
                this._update_lightweight_tooltip(metrics);
            }
            
            // Apply color coding based on thresholds
            this._apply_visual_indicators(metrics);
            
            // Store current display state for next comparison
            this._last_display_state = this._get_display_state_snapshot(metrics);
            
            // Track display update performance
            let display_time = Date.now() - display_start;
            if (display_time > 50) { // Display updates should be very fast
                global.logWarning(`System Monitor: Display update took ${display_time}ms`);
            }
            
        } catch (error) {
            global.logError("System Monitor: Error updating display: " + error.message);
        }
    },

    /**
     * Check if display update can be skipped for performance
     * @param {Object} metrics - Current SystemMetrics
     * @returns {boolean} True if update can be skipped
     */
    _should_skip_display_update: function(metrics) {
        if (!this._last_display_state) {
            return false; // First update, don't skip
        }
        
        // Skip if values haven't changed significantly
        let cpu_change = Math.abs(metrics.cpu.usage - this._last_display_state.cpu_usage);
        let gpu_change = Math.abs(metrics.gpu.usage - this._last_display_state.gpu_usage);
        
        // Only update if change is significant (>= 1% for CPU/GPU)
        if (cpu_change < 1 && gpu_change < 1) {
            // But still update periodically even with small changes
            let time_since_last_display = Date.now() - (this._last_display_state.timestamp || 0);
            if (time_since_last_display < this._refresh_interval * 5) {
                return true; // Skip this update
            }
        }
        
        return false; // Don't skip
    },

    /**
     * Get snapshot of current display state for comparison
     * @param {Object} metrics - Current SystemMetrics
     * @returns {Object} Display state snapshot
     */
    _get_display_state_snapshot: function(metrics) {
        return {
            cpu_usage: metrics.cpu.usage,
            gpu_usage: metrics.gpu.usage,
            threshold_level: this._get_threshold_level(Math.max(metrics.cpu.usage, metrics.gpu.usage)),
            timestamp: Date.now()
        };
    },

    /**
     * Update lightweight tooltip for better performance
     * @param {Object} metrics - Current SystemMetrics
     */
    _update_lightweight_tooltip: function(metrics) {
        let tooltip = `CPU: ${metrics.cpu.usage}%`;
        if (this._settings.showGPU && metrics.gpu.usage > 0) {
            tooltip += ` | GPU: ${metrics.gpu.usage}%`;
        }
        this.set_applet_tooltip(tooltip);
    },

    /**
     * Track update performance metrics
     * @param {number} start_time - Update start timestamp
     */
    _track_update_performance: function(start_time) {
        let total_time = Date.now() - start_time;
        
        // Initialize performance tracking if not exists
        if (!this._performance_stats) {
            this._performance_stats = {
                update_times: [],
                max_update_time: 0,
                avg_update_time: 0,
                slow_updates: 0
            };
        }
        
        // Track this update
        this._performance_stats.update_times.push(total_time);
        this._performance_stats.max_update_time = Math.max(this._performance_stats.max_update_time, total_time);
        
        // Keep only last 50 update times for rolling average
        if (this._performance_stats.update_times.length > 50) {
            this._performance_stats.update_times.shift();
        }
        
        // Calculate rolling average
        let sum = this._performance_stats.update_times.reduce((a, b) => a + b, 0);
        this._performance_stats.avg_update_time = Math.round(sum / this._performance_stats.update_times.length);
        
        // Count slow updates (taking more than half the refresh interval)
        if (total_time > this._refresh_interval / 2) {
            this._performance_stats.slow_updates++;
            global.logWarning(`System Monitor: Slow update detected: ${total_time}ms (refresh interval: ${this._refresh_interval}ms)`);
        }
    },

    /**
     * Schedule next update with adaptive timing
     */
    _schedule_next_update_adaptive: function() {
        if (!this._monitoring_active) {
            return;
        }
        
        // Clear any existing timeout
        if (this._timeout_id) {
            Mainloop.source_remove(this._timeout_id);
            this._timeout_id = null;
        }
        
        // Calculate adaptive delay based on performance
        let base_delay = this._refresh_interval;
        let adaptive_delay = this._calculate_adaptive_delay(base_delay);
        
        // Calculate next update time
        let now = Date.now();
        let time_since_last = now - this._last_update_time;
        let delay = Math.max(0, adaptive_delay - time_since_last);
        
        this._timeout_id = Mainloop.timeout_add(delay, Lang.bind(this, function() {
            this._timeout_id = null;
            this._perform_scheduled_update();
            return false; // Don't repeat automatically
        }));
    },

    /**
     * Calculate adaptive delay based on system performance
     * @param {number} base_delay - Base refresh interval
     * @returns {number} Adaptive delay in milliseconds
     */
    _calculate_adaptive_delay: function(base_delay) {
        if (!this._performance_stats || this._performance_stats.update_times.length < 5) {
            return base_delay; // Not enough data for adaptation
        }
        
        let avg_update_time = this._performance_stats.avg_update_time;
        
        // If updates are consistently slow, increase interval slightly
        if (avg_update_time > base_delay / 3) {
            let slowdown_factor = Math.min(1.5, 1 + (avg_update_time / base_delay));
            return Math.round(base_delay * slowdown_factor);
        }
        
        // If updates are very fast, we can maintain the base interval
        return base_delay;
    },

    /**
     * Handle rapid system load changes with burst detection
     */
    _handle_rapid_load_changes: function() {
        let metrics = this._get_current_metrics();
        
        // Initialize load change tracking
        if (!this._load_change_history) {
            this._load_change_history = [];
        }
        
        // Track current load
        let current_load = {
            cpu: metrics.cpu.usage,
            gpu: metrics.gpu.usage,
            timestamp: Date.now()
        };
        
        this._load_change_history.push(current_load);
        
        // Keep only recent history (last 10 updates)
        if (this._load_change_history.length > 10) {
            this._load_change_history.shift();
        }
        
        // Detect rapid changes
        if (this._load_change_history.length >= 3) {
            let rapid_change_detected = this._detect_rapid_load_change();
            
            if (rapid_change_detected) {
                // Force immediate display update for rapid changes
                this._force_immediate_display_update();
            }
        }
    },

    /**
     * Detect rapid load changes in recent history
     * @returns {boolean} True if rapid change detected
     */
    _detect_rapid_load_change: function() {
        if (this._load_change_history.length < 3) {
            return false;
        }
        
        let recent = this._load_change_history.slice(-3);
        let cpu_changes = [];
        let gpu_changes = [];
        
        for (let i = 1; i < recent.length; i++) {
            cpu_changes.push(Math.abs(recent[i].cpu - recent[i-1].cpu));
            gpu_changes.push(Math.abs(recent[i].gpu - recent[i-1].gpu));
        }
        
        // Rapid change if any change > 20% in recent updates
        let max_cpu_change = Math.max(...cpu_changes);
        let max_gpu_change = Math.max(...gpu_changes);
        
        return max_cpu_change > 20 || max_gpu_change > 20;
    },

    /**
     * Force immediate display update (for rapid changes)
     */
    _force_immediate_display_update: function() {
        if (this._update_in_progress) {
            return; // Don't interrupt ongoing update
        }
        
        try {
            this._update_display_optimized();
            global.log("System Monitor: Forced immediate display update due to rapid load change");
        } catch (error) {
            global.logError("System Monitor: Error in forced display update: " + error.message);
        }
    },

    /**
     * Get display responsiveness statistics
     * @returns {Object} Performance and responsiveness metrics
     */
    _get_display_responsiveness_stats: function() {
        return {
            performance_stats: this._performance_stats || null,
            load_change_history: this._load_change_history || [],
            current_refresh_interval: this._refresh_interval,
            adaptive_delay_active: this._performance_stats && this._performance_stats.avg_update_time > this._refresh_interval / 3,
            last_update_time: this._last_update_time,
            update_in_progress: this._update_in_progress
        };
    },

    /**
     * Force immediate update (useful for configuration changes)
     */
    _force_immediate_update: function() {
        if (!this._monitoring_active) {
            return;
        }
        
        // Cancel current scheduled update
        if (this._timeout_id) {
            Mainloop.source_remove(this._timeout_id);
            this._timeout_id = null;
        }
        
        // Perform update immediately
        this._perform_scheduled_update();
    },

    /**
     * Get monitoring status information
     * @returns {Object} Status information
     */
    _get_monitoring_status: function() {
        return {
            active: this._monitoring_active,
            interval: this._refresh_interval,
            last_update: this._last_update_time,
            update_in_progress: this._update_in_progress,
            next_update_in: this._timeout_id ? this._refresh_interval - (Date.now() - this._last_update_time) : null
        };
    },

    /**
     * Handle configuration changes that affect monitoring
     * @param {Object} new_settings - New settings object
     */
    _handle_monitoring_config_change: function(new_settings) {
        let needs_restart = false;
        let old_interval = this._refresh_interval;
        
        // Check if refresh interval changed
        if (new_settings.refreshInterval && new_settings.refreshInterval !== old_interval) {
            if (this._set_refresh_interval(new_settings.refreshInterval)) {
                needs_restart = true;
                global.log("System Monitor: Refresh interval changed from " + old_interval + "ms to " + new_settings.refreshInterval + "ms");
            }
        }
        
        // Update other settings that don't require restart
        if (new_settings.showGPU !== undefined) {
            this._settings.showGPU = new_settings.showGPU;
        }
        
        if (new_settings.displayFormat) {
            this._settings.displayFormat = new_settings.displayFormat;
        }
        
        if (new_settings.colorTheme) {
            this._settings.colorTheme = new_settings.colorTheme;
        }
        
        if (new_settings.thresholds) {
            this._settings.thresholds = Object.assign({}, this._settings.thresholds, new_settings.thresholds);
        }
        
        // Force immediate display update to reflect changes
        if (this._monitoring_active) {
            this._force_immediate_update();
        }
        
        return needs_restart;
    },

    /**
     * Validate monitoring configuration
     * @param {Object} config - Configuration to validate
     * @returns {Object} Validation result with errors if any
     */
    _validate_monitoring_config: function(config) {
        let result = {
            valid: true,
            errors: []
        };
        
        // Validate refresh interval
        if (config.refreshInterval !== undefined) {
            if (!this._is_valid_refresh_interval(config.refreshInterval)) {
                result.valid = false;
                result.errors.push("Invalid refresh interval: must be between 100-60000ms and multiple of 50ms");
            }
        }
        
        // Validate thresholds
        if (config.thresholds) {
            if (config.thresholds.warning !== undefined) {
                if (typeof config.thresholds.warning !== 'number' || config.thresholds.warning < 0 || config.thresholds.warning > 100) {
                    result.valid = false;
                    result.errors.push("Invalid warning threshold: must be 0-100");
                }
            }
            
            if (config.thresholds.critical !== undefined) {
                if (typeof config.thresholds.critical !== 'number' || config.thresholds.critical < 0 || config.thresholds.critical > 100) {
                    result.valid = false;
                    result.errors.push("Invalid critical threshold: must be 0-100");
                }
            }
            
            // Warning threshold should be less than critical
            if (config.thresholds.warning !== undefined && config.thresholds.critical !== undefined) {
                if (config.thresholds.warning >= config.thresholds.critical) {
                    result.valid = false;
                    result.errors.push("Warning threshold must be less than critical threshold");
                }
            }
        }
        
        return result;
    },

    /**
     * Update system data
     */
    _update_system_data: function() {
        try {
            let cpu_data = this._collect_cpu_data();
            let gpu_data = this._collect_gpu_data();
            
            // Update metrics using the SystemMetrics model
            this._update_system_metrics(cpu_data, gpu_data);
        } catch (error) {
            global.logError("System Monitor: Error updating system data: " + error.message);
        }
    },

    /**
     * Collect CPU data from /proc/stat and /proc/cpuinfo
     * @returns {Object} Raw CPU data for validation
     */
    _collect_cpu_data: function() {
        try {
            let cpu_data = {
                usage: 0,
                cores: [],
                temperature: null
            };
            
            // Read CPU usage from /proc/stat
            let cpu_usage = this._parse_cpu_usage();
            if (cpu_usage !== null) {
                cpu_data.usage = cpu_usage.overall;
                cpu_data.cores = cpu_usage.cores;
            }
            
            // Read CPU info from /proc/cpuinfo (for temperature if available)
            cpu_data.temperature = this._parse_cpu_temperature();
            
            return cpu_data;
            
        } catch (error) {
            global.logError("System Monitor: Error collecting CPU data: " + error.message);
            // Return current CPU data from metrics on error
            return this._current_metrics ? this._current_metrics.cpu : null;
        }
    },

    /**
     * Parse CPU usage from /proc/stat
     * Returns object with overall usage and per-core usage percentages
     */
    _parse_cpu_usage: function() {
        try {
            let file = Gio.File.new_for_path('/proc/stat');
            let [success, contents] = file.load_contents(null);
            
            if (!success) {
                throw new Error("Failed to read /proc/stat");
            }
            
            let content = contents.toString();
            let lines = content.split('\n');
            
            let cpu_data = {
                overall: 0,
                cores: []
            };
            
            // Track previous CPU times for delta calculation
            if (!this._prev_cpu_times) {
                this._prev_cpu_times = {};
            }
            
            for (let line of lines) {
                if (line.startsWith('cpu ')) {
                    // Overall CPU usage
                    cpu_data.overall = this._calculate_cpu_usage_from_line(line, 'cpu');
                } else if (line.match(/^cpu\d+/)) {
                    // Per-core CPU usage
                    let core_match = line.match(/^(cpu\d+)/);
                    if (core_match) {
                        let core_id = core_match[1];
                        let core_usage = this._calculate_cpu_usage_from_line(line, core_id);
                        cpu_data.cores.push(core_usage);
                    }
                }
            }
            
            return cpu_data;
            
        } catch (error) {
            global.logError("System Monitor: Error parsing CPU usage: " + error.message);
            return null;
        }
    },

    /**
     * Calculate CPU usage percentage from a /proc/stat line
     */
    _calculate_cpu_usage_from_line: function(line, cpu_id) {
        try {
            let parts = line.trim().split(/\s+/);
            
            // /proc/stat format: cpu user nice system idle iowait irq softirq steal guest guest_nice
            if (parts.length < 5) {
                throw new Error("Invalid /proc/stat line format");
            }
            
            let user = parseInt(parts[1]) || 0;
            let nice = parseInt(parts[2]) || 0;
            let system = parseInt(parts[3]) || 0;
            let idle = parseInt(parts[4]) || 0;
            let iowait = parseInt(parts[5]) || 0;
            let irq = parseInt(parts[6]) || 0;
            let softirq = parseInt(parts[7]) || 0;
            let steal = parseInt(parts[8]) || 0;
            
            let total_time = user + nice + system + idle + iowait + irq + softirq + steal;
            let idle_time = idle + iowait;
            let work_time = total_time - idle_time;
            
            // Calculate usage based on delta from previous reading
            let prev_times = this._prev_cpu_times[cpu_id];
            let usage = 0;
            
            if (prev_times) {
                let total_delta = total_time - prev_times.total;
                let work_delta = work_time - prev_times.work;
                
                if (total_delta > 0) {
                    usage = Math.round((work_delta / total_delta) * 100);
                    usage = Math.max(0, Math.min(100, usage)); // Clamp to 0-100
                }
            }
            
            // Store current times for next calculation
            this._prev_cpu_times[cpu_id] = {
                total: total_time,
                work: work_time
            };
            
            return usage;
            
        } catch (error) {
            global.logError("System Monitor: Error calculating CPU usage: " + error.message);
            return 0;
        }
    },

    /**
     * Parse CPU temperature from thermal zones
     * @returns {number|null} CPU temperature in Celsius or null if unavailable
     */
    _parse_cpu_temperature: function() {
        try {
            // Try to read from thermal zones
            let thermal_zones = ['/sys/class/thermal/thermal_zone0/temp', 
                               '/sys/class/thermal/thermal_zone1/temp'];
            
            for (let zone_path of thermal_zones) {
                try {
                    let file = Gio.File.new_for_path(zone_path);
                    let [success, contents] = file.load_contents(null);
                    
                    if (success) {
                        let temp_str = contents.toString().trim();
                        let temp_millicelsius = parseInt(temp_str);
                        
                        if (!isNaN(temp_millicelsius)) {
                            // Convert from millicelsius to celsius
                            let temp_celsius = temp_millicelsius / 1000;
                            
                            // Sanity check: temperature should be reasonable
                            if (temp_celsius > -50 && temp_celsius < 150) {
                                return temp_celsius;
                            }
                        }
                    }
                } catch (zone_error) {
                    // Continue to next thermal zone
                    continue;
                }
            }
            
            return null;
            
        } catch (error) {
            global.logError("System Monitor: Error reading CPU temperature: " + error.message);
            return null;
        }
    },

    /**
     * Collect GPU data using available monitoring tools
     * @returns {Object} Raw GPU data for validation
     */
    _collect_gpu_data: function() {
        try {
            // Try different GPU monitoring approaches
            let gpu_data = this._detect_and_parse_gpu_data();
            
            if (gpu_data) {
                return gpu_data;
            } else {
                // No GPU data available, return empty structure
                return {
                    usage: 0,
                    memory: { used: 0, total: 0 },
                    temperature: null
                };
            }
            
        } catch (error) {
            global.logError("System Monitor: Error collecting GPU data: " + error.message);
            // Return current GPU data from metrics on error
            return this._current_metrics ? this._current_metrics.gpu : null;
        }
    },

    /**
     * Detect available GPU monitoring tools and parse data
     */
    _detect_and_parse_gpu_data: function() {
        // Try NVIDIA first
        let nvidia_data = this._parse_nvidia_gpu_data();
        if (nvidia_data) {
            return nvidia_data;
        }
        
        // Try AMD tools
        let amd_data = this._parse_amd_gpu_data();
        if (amd_data) {
            return amd_data;
        }
        
        // Try Intel GPU tools
        let intel_data = this._parse_intel_gpu_data();
        if (intel_data) {
            return intel_data;
        }
        
        return null;
    },

    /**
     * Parse NVIDIA GPU data using nvidia-smi
     */
    _parse_nvidia_gpu_data: function() {
        try {
            // Check if nvidia-smi is available
            let [success, stdout, stderr] = GLib.spawn_command_line_sync('which nvidia-smi');
            if (!success) {
                return null;
            }
            
            // Run nvidia-smi with specific query format
            let cmd = 'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits';
            let [cmd_success, cmd_stdout, cmd_stderr] = GLib.spawn_command_line_sync(cmd);
            
            if (!cmd_success) {
                global.logError("System Monitor: nvidia-smi command failed: " + cmd_stderr.toString());
                return null;
            }
            
            let output = cmd_stdout.toString().trim();
            if (!output) {
                return null;
            }
            
            // Parse the first GPU (for multi-GPU systems, we'll aggregate later)
            let lines = output.split('\n');
            let first_gpu = lines[0];
            let parts = first_gpu.split(',').map(part => part.trim());
            
            if (parts.length >= 4) {
                let gpu_data = {
                    usage: parseInt(parts[0]) || 0,
                    memory: {
                        used: parseInt(parts[1]) || 0,
                        total: parseInt(parts[2]) || 0
                    },
                    temperature: parseInt(parts[3]) || null
                };
                
                // Handle multi-GPU systems by aggregating data
                if (lines.length > 1) {
                    gpu_data = this._aggregate_multi_gpu_data(lines, 'nvidia');
                }
                
                return gpu_data;
            }
            
        } catch (error) {
            global.logError("System Monitor: Error parsing NVIDIA GPU data: " + error.message);
        }
        
        return null;
    },

    /**
     * Parse AMD GPU data using rocm-smi or other AMD tools
     */
    _parse_amd_gpu_data: function() {
        try {
            // Try rocm-smi first
            let [success, stdout, stderr] = GLib.spawn_command_line_sync('which rocm-smi');
            if (success) {
                return this._parse_rocm_smi_data();
            }
            
            // Try radeontop if available
            let [radeontop_success] = GLib.spawn_command_line_sync('which radeontop');
            if (radeontop_success) {
                return this._parse_radeontop_data();
            }
            
        } catch (error) {
            global.logError("System Monitor: Error checking AMD GPU tools: " + error.message);
        }
        
        return null;
    },

    /**
     * Parse AMD GPU data using rocm-smi
     */
    _parse_rocm_smi_data: function() {
        try {
            let cmd = 'rocm-smi --showuse --showmemuse --showtemp --csv';
            let [success, stdout, stderr] = GLib.spawn_command_line_sync(cmd);
            
            if (!success) {
                return null;
            }
            
            let output = stdout.toString().trim();
            let lines = output.split('\n');
            
            // Parse CSV output (implementation would depend on rocm-smi output format)
            // This is a simplified implementation
            for (let line of lines) {
                if (line.includes('GPU') && !line.includes('device')) {
                    // Basic parsing - would need to be refined based on actual rocm-smi output
                    return {
                        usage: 0, // rocm-smi parsing would go here
                        memory: { used: 0, total: 0 },
                        temperature: null
                    };
                }
            }
            
        } catch (error) {
            global.logError("System Monitor: Error parsing rocm-smi data: " + error.message);
        }
        
        return null;
    },

    /**
     * Parse AMD GPU data using radeontop
     */
    _parse_radeontop_data: function() {
        try {
            // radeontop requires special handling as it's interactive
            // For now, return null - would need more complex implementation
            return null;
            
        } catch (error) {
            global.logError("System Monitor: Error parsing radeontop data: " + error.message);
        }
        
        return null;
    },

    /**
     * Parse Intel GPU data
     */
    _parse_intel_gpu_data: function() {
        try {
            // Try intel_gpu_top if available
            let [success, stdout, stderr] = GLib.spawn_command_line_sync('which intel_gpu_top');
            if (!success) {
                return null;
            }
            
            // intel_gpu_top is also interactive, would need special handling
            // For now, return basic data structure
            return null;
            
        } catch (error) {
            global.logError("System Monitor: Error checking Intel GPU tools: " + error.message);
        }
        
        return null;
    },

    /**
     * Aggregate data from multiple GPUs
     */
    _aggregate_multi_gpu_data: function(gpu_lines, gpu_type) {
        try {
            let total_usage = 0;
            let total_memory_used = 0;
            let total_memory_total = 0;
            let max_temperature = null;
            let gpu_count = 0;
            
            for (let line of gpu_lines) {
                let parts = line.split(',').map(part => part.trim());
                
                if (parts.length >= 4) {
                    total_usage += parseInt(parts[0]) || 0;
                    total_memory_used += parseInt(parts[1]) || 0;
                    total_memory_total += parseInt(parts[2]) || 0;
                    
                    let temp = parseInt(parts[3]);
                    if (temp && (max_temperature === null || temp > max_temperature)) {
                        max_temperature = temp;
                    }
                    
                    gpu_count++;
                }
            }
            
            if (gpu_count > 0) {
                return {
                    usage: Math.round(total_usage / gpu_count), // Average usage
                    memory: {
                        used: total_memory_used, // Total used memory
                        total: total_memory_total // Total available memory
                    },
                    temperature: max_temperature // Highest temperature
                };
            }
            
        } catch (error) {
            global.logError("System Monitor: Error aggregating multi-GPU data: " + error.message);
        }
        
        return null;
    },

    /**
     * Update panel display
     */
    _update_display: function() {
        let metrics = this._get_current_metrics();
        
        // Update panel text and icon based on display format
        this._update_panel_text_and_icon(metrics);
        
        // Update tooltip with detailed information
        let tooltip = this._generate_detailed_tooltip(metrics);
        this.set_applet_tooltip(tooltip);
        
        // Apply color coding based on thresholds
        this._apply_visual_indicators(metrics);
    },

    /**
     * Update panel text and icon display
     * @param {Object} metrics - SystemMetrics object
     */
    _update_panel_text_and_icon: function(metrics) {
        let display_text = this._format_display_text(metrics);
        let icon_name = this._get_appropriate_icon(metrics);
        
        // Update applet label
        this.set_applet_label(display_text);
        
        // Update applet icon based on system load
        this.set_applet_icon_name(icon_name);
    },

    /**
     * Format display text based on current settings and metrics
     * @param {Object} metrics - SystemMetrics object
     * @returns {string} Formatted display text
     */
    _format_display_text: function(metrics) {
        let text = "";
        
        switch (this._settings.displayFormat) {
            case "percentage":
                text = this._format_percentage_display(metrics);
                break;
            case "graph":
                text = this._format_graph_display(metrics);
                break;
            case "both":
                text = this._format_combined_display(metrics);
                break;
            default:
                text = this._format_percentage_display(metrics);
        }
        
        return text;
    },

    /**
     * Format percentage-based display
     * @param {Object} metrics - SystemMetrics object
     * @returns {string} Percentage display text
     */
    _format_percentage_display: function(metrics) {
        let text = `CPU: ${metrics.cpu.usage}%`;
        
        // Add GPU information if enabled and available
        if (this._settings.showGPU && metrics.gpu.usage > 0) {
            text += ` GPU: ${metrics.gpu.usage}%`;
        }
        
        return text;
    },

    /**
     * Format graph-based display using Unicode block characters
     * @param {Object} metrics - SystemMetrics object
     * @returns {string} Graph display text
     */
    _format_graph_display: function(metrics) {
        let cpu_graph = this._create_usage_graph(metrics.cpu.usage);
        let text = `CPU${cpu_graph}`;
        
        // Add GPU graph if enabled and available
        if (this._settings.showGPU && metrics.gpu.usage > 0) {
            let gpu_graph = this._create_usage_graph(metrics.gpu.usage);
            text += ` GPU${gpu_graph}`;
        }
        
        return text;
    },

    /**
     * Format combined percentage and graph display
     * @param {Object} metrics - SystemMetrics object
     * @returns {string} Combined display text
     */
    _format_combined_display: function(metrics) {
        let cpu_graph = this._create_usage_graph(metrics.cpu.usage);
        let text = `CPU: ${metrics.cpu.usage}%${cpu_graph}`;
        
        // Add GPU information if enabled and available
        if (this._settings.showGPU && metrics.gpu.usage > 0) {
            let gpu_graph = this._create_usage_graph(metrics.gpu.usage);
            text += ` GPU: ${metrics.gpu.usage}%${gpu_graph}`;
        }
        
        return text;
    },

    /**
     * Create a visual usage graph using Unicode block characters
     * @param {number} usage - Usage percentage (0-100)
     * @returns {string} Unicode graph representation
     */
    _create_usage_graph: function(usage) {
        // Use Unicode block characters for visual representation
        const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
        const graph_length = 5; // Number of characters in graph
        let graph = "";
        
        for (let i = 0; i < graph_length; i++) {
            let threshold = ((i + 1) / graph_length) * 100;
            if (usage >= threshold) {
                graph += blocks[7]; // Full block
            } else if (usage >= threshold - (100 / graph_length)) {
                // Partial block based on how close we are to threshold
                let partial_index = Math.floor((usage - (threshold - (100 / graph_length))) / (100 / graph_length) * 8);
                graph += blocks[Math.max(0, Math.min(7, partial_index))];
            } else {
                graph += blocks[0]; // Minimal block
            }
        }
        
        return ` [${graph}]`;
    },

    /**
     * Get appropriate icon based on system metrics
     * @param {Object} metrics - SystemMetrics object
     * @returns {string} Icon name
     */
    _get_appropriate_icon: function(metrics) {
        let cpu_usage = metrics.cpu.usage;
        
        // Choose icon based on CPU usage level
        if (cpu_usage >= this._settings.thresholds.critical) {
            return "utilities-system-monitor-critical";
        } else if (cpu_usage >= this._settings.thresholds.warning) {
            return "utilities-system-monitor-warning";
        } else if (cpu_usage > 50) {
            return "utilities-system-monitor-medium";
        } else if (cpu_usage > 20) {
            return "utilities-system-monitor-low";
        } else {
            return "utilities-system-monitor-idle";
        }
    },

    /**
     * Generate detailed tooltip with system metrics
     * @param {Object} metrics - SystemMetrics object
     * @returns {string} Formatted tooltip text
     */
    _generate_detailed_tooltip: function(metrics) {
        let sections = [];
        
        // CPU Section
        sections.push(this._format_cpu_tooltip_section(metrics.cpu));
        
        // GPU Section (if enabled and available)
        if (this._settings.showGPU && (metrics.gpu.usage > 0 || metrics.gpu.memory.total > 0)) {
            sections.push(this._format_gpu_tooltip_section(metrics.gpu));
        }
        
        // System Information Section
        sections.push(this._format_system_info_tooltip_section(metrics));
        
        // Threshold Information Section
        sections.push(this._format_threshold_tooltip_section());
        
        return sections.join('\n\n');
    },

    /**
     * Format CPU section of tooltip
     * @param {Object} cpu_data - CPU metrics data
     * @returns {string} Formatted CPU tooltip section
     */
    _format_cpu_tooltip_section: function(cpu_data) {
        let section = `🖥️  CPU Information\n`;
        section += `   Overall Usage: ${cpu_data.usage}%`;
        
        // Add per-core information if available
        if (cpu_data.cores && cpu_data.cores.length > 0) {
            section += `\n   Cores (${cpu_data.cores.length}): `;
            
            // Group cores for better readability
            if (cpu_data.cores.length <= 8) {
                section += cpu_data.cores.map(usage => `${usage}%`).join(', ');
            } else {
                // Show first 4 and last 4 cores for many-core systems
                let first_cores = cpu_data.cores.slice(0, 4).map(usage => `${usage}%`).join(', ');
                let last_cores = cpu_data.cores.slice(-4).map(usage => `${usage}%`).join(', ');
                section += `${first_cores} ... ${last_cores}`;
            }
        }
        
        // Add CPU temperature if available
        if (cpu_data.temperature !== null) {
            section += `\n   Temperature: ${cpu_data.temperature}°C`;
            
            // Add temperature status indicator
            if (cpu_data.temperature > 80) {
                section += ` 🔥 (Hot)`;
            } else if (cpu_data.temperature > 60) {
                section += ` ⚠️  (Warm)`;
            } else {
                section += ` ✅ (Normal)`;
            }
        }
        
        return section;
    },

    /**
     * Format GPU section of tooltip
     * @param {Object} gpu_data - GPU metrics data
     * @returns {string} Formatted GPU tooltip section
     */
    _format_gpu_tooltip_section: function(gpu_data) {
        let section = `🎮 GPU Information\n`;
        section += `   Usage: ${gpu_data.usage}%`;
        
        // Add memory information if available
        if (gpu_data.memory.total > 0) {
            let memory_percent = Math.round((gpu_data.memory.used / gpu_data.memory.total) * 100);
            section += `\n   Memory: ${gpu_data.memory.used}MB / ${gpu_data.memory.total}MB (${memory_percent}%)`;
            
            // Add memory usage indicator
            if (memory_percent > 90) {
                section += ` 🔴 (Critical)`;
            } else if (memory_percent > 70) {
                section += ` 🟡 (High)`;
            } else {
                section += ` 🟢 (Normal)`;
            }
        }
        
        // Add GPU temperature if available
        if (gpu_data.temperature !== null) {
            section += `\n   Temperature: ${gpu_data.temperature}°C`;
            
            // Add temperature status indicator
            if (gpu_data.temperature > 85) {
                section += ` 🔥 (Hot)`;
            } else if (gpu_data.temperature > 70) {
                section += ` ⚠️  (Warm)`;
            } else {
                section += ` ✅ (Normal)`;
            }
        }
        
        return section;
    },

    /**
     * Format system information section of tooltip
     * @param {Object} metrics - SystemMetrics object
     * @returns {string} Formatted system info tooltip section
     */
    _format_system_info_tooltip_section: function(metrics) {
        let section = `⚙️  System Information\n`;
        section += `   Refresh Rate: ${this._refresh_interval}ms`;
        
        // Add data freshness information
        if (metrics.timestamp) {
            let age = Date.now() - metrics.timestamp;
            let age_seconds = Math.round(age / 1000);
            section += `\n   Last Update: ${age_seconds}s ago`;
            
            // Add freshness indicator
            if (age_seconds > 10) {
                section += ` ⚠️  (Stale)`;
            } else if (age_seconds > 5) {
                section += ` 🟡 (Old)`;
            } else {
                section += ` 🟢 (Fresh)`;
            }
        }
        
        // Add monitoring status
        section += `\n   Status: ${this._monitoring_active ? '🟢 Active' : '🔴 Inactive'}`;
        
        return section;
    },

    /**
     * Format threshold information section of tooltip
     * @returns {string} Formatted threshold tooltip section
     */
    _format_threshold_tooltip_section: function() {
        let section = `📊 Thresholds\n`;
        section += `   Warning: ${this._settings.thresholds.warning}%\n`;
        section += `   Critical: ${this._settings.thresholds.critical}%`;
        
        // Add current status
        let metrics = this._get_current_metrics();
        let max_usage = this._settings.showGPU ? 
            Math.max(metrics.cpu.usage, metrics.gpu.usage) : 
            metrics.cpu.usage;
        
        let threshold_level = this._get_threshold_level(max_usage);
        let status_icon = threshold_level === 'critical' ? '🔴' : 
                         threshold_level === 'warning' ? '🟡' : '🟢';
        
        section += `\n   Current: ${status_icon} ${threshold_level.charAt(0).toUpperCase() + threshold_level.slice(1)}`;
        
        return section;
    },

    /**
     * Handle tooltip hover events and positioning
     */
    _setup_tooltip_handlers: function() {
        // Connect to hover events for enhanced tooltip behavior
        this.actor.connect('enter-event', Lang.bind(this, this._on_tooltip_enter));
        this.actor.connect('leave-event', Lang.bind(this, this._on_tooltip_leave));
        
        // Initialize tooltip state
        this._tooltip_hover_timeout = null;
        this._tooltip_visible = false;
    },

    /**
     * Handle tooltip enter event
     * @param {Object} actor - The applet actor
     * @param {Object} event - The enter event
     */
    _on_tooltip_enter: function(actor, event) {
        // Clear any existing timeout
        if (this._tooltip_hover_timeout) {
            Mainloop.source_remove(this._tooltip_hover_timeout);
            this._tooltip_hover_timeout = null;
        }
        
        // Set a small delay before showing detailed tooltip
        this._tooltip_hover_timeout = Mainloop.timeout_add(500, Lang.bind(this, function() {
            this._show_enhanced_tooltip();
            this._tooltip_hover_timeout = null;
            return false;
        }));
    },

    /**
     * Handle tooltip leave event
     * @param {Object} actor - The applet actor
     * @param {Object} event - The leave event
     */
    _on_tooltip_leave: function(actor, event) {
        // Clear hover timeout
        if (this._tooltip_hover_timeout) {
            Mainloop.source_remove(this._tooltip_hover_timeout);
            this._tooltip_hover_timeout = null;
        }
        
        // Hide enhanced tooltip
        this._hide_enhanced_tooltip();
    },

    /**
     * Show enhanced tooltip with current system information
     */
    _show_enhanced_tooltip: function() {
        if (this._tooltip_visible) {
            return;
        }
        
        // Update tooltip with fresh data
        let metrics = this._get_current_metrics();
        let tooltip_text = this._generate_detailed_tooltip(metrics);
        this.set_applet_tooltip(tooltip_text);
        
        this._tooltip_visible = true;
        
        // Log tooltip display for debugging
        global.log("System Monitor: Enhanced tooltip displayed");
    },

    /**
     * Hide enhanced tooltip
     */
    _hide_enhanced_tooltip: function() {
        if (!this._tooltip_visible) {
            return;
        }
        
        // Revert to basic tooltip
        let metrics = this._get_current_metrics();
        let basic_tooltip = `CPU: ${metrics.cpu.usage}%`;
        if (this._settings.showGPU && metrics.gpu.usage > 0) {
            basic_tooltip += ` | GPU: ${metrics.gpu.usage}%`;
        }
        this.set_applet_tooltip(basic_tooltip);
        
        this._tooltip_visible = false;
    },

    /**
     * Get tooltip display information
     * @returns {Object} Current tooltip state
     */
    _get_tooltip_info: function() {
        let metrics = this._get_current_metrics();
        
        return {
            basic_tooltip: `CPU: ${metrics.cpu.usage}%${this._settings.showGPU && metrics.gpu.usage > 0 ? ` | GPU: ${metrics.gpu.usage}%` : ''}`,
            detailed_tooltip: this._generate_detailed_tooltip(metrics),
            is_visible: this._tooltip_visible,
            hover_timeout_active: this._tooltip_hover_timeout !== null
        };
    },

    /**
     * Apply visual indicators based on usage thresholds
     * @param {Object} metrics - SystemMetrics object
     */
    _apply_visual_indicators: function(metrics) {
        let cpu_usage = metrics.cpu.usage;
        let gpu_usage = metrics.gpu.usage;
        let actor = this.actor;
        
        // Determine the highest usage level to base visual indicators on
        let max_usage = cpu_usage;
        if (this._settings.showGPU && gpu_usage > 0) {
            max_usage = Math.max(cpu_usage, gpu_usage);
        }
        
        // Remove existing style classes
        this._remove_all_visual_indicator_classes(actor);
        
        // Apply base applet styling
        actor.add_style_class_name('system-monitor-applet');
        
        // Apply theme-specific classes
        this._apply_theme_classes(actor, max_usage);
        
        // Apply usage level classes
        this._apply_usage_level_classes(actor, max_usage);
        
        // Apply custom styling if needed
        this._apply_theme_specific_styling(actor, max_usage);
    },

    /**
     * Apply theme-specific CSS classes
     * @param {Object} actor - The applet actor
     * @param {number} usage - Current usage percentage
     */
    _apply_theme_classes: function(actor, usage) {
        // Apply theme class
        switch (this._settings.colorTheme) {
            case "monochrome":
                actor.add_style_class_name('system-monitor-monochrome');
                break;
            case "custom":
                actor.add_style_class_name('system-monitor-custom');
                break;
            case "default":
            default:
                // Default theme uses base classes only
                break;
        }
        
        // Apply display format classes
        if (this._settings.displayFormat === "graph" || this._settings.displayFormat === "both") {
            actor.add_style_class_name('system-monitor-graph');
        }
    },

    /**
     * Apply usage level CSS classes
     * @param {Object} actor - The applet actor
     * @param {number} usage - Current usage percentage
     */
    _apply_usage_level_classes: function(actor, usage) {
        let usage_class = this._get_usage_style_class(usage);
        let icon_class = this._get_icon_style_class(usage);
        
        actor.add_style_class_name(usage_class);
        actor.add_style_class_name(icon_class);
    },

    /**
     * Apply theme-specific styling (colors, etc.)
     * @param {Object} actor - The applet actor
     * @param {number} usage - Current usage percentage
     */
    _apply_theme_specific_styling: function(actor, usage) {
        // Clear any existing inline styles
        actor.set_style('');
        
        switch (this._settings.colorTheme) {
            case "custom":
                this._apply_custom_colors(actor, usage);
                break;
            case "monochrome":
                this._apply_monochrome_styling(actor, usage);
                break;
            case "default":
            default:
                // Default theme relies on CSS classes only
                break;
        }
    },

    /**
     * Apply monochrome theme styling
     * @param {Object} actor - The applet actor
     * @param {number} usage - Current usage percentage
     */
    _apply_monochrome_styling: function(actor, usage) {
        // Monochrome theme uses opacity and font weight variations
        // The CSS classes handle most of this, but we can add dynamic opacity
        let opacity = this._calculate_monochrome_opacity(usage);
        let current_style = actor.get_style() || '';
        
        // Add opacity to existing style
        if (current_style) {
            actor.set_style(current_style + ` opacity: ${opacity};`);
        } else {
            actor.set_style(`opacity: ${opacity};`);
        }
    },

    /**
     * Calculate opacity for monochrome theme based on usage
     * @param {number} usage - Usage percentage
     * @returns {number} Opacity value (0.6-1.0)
     */
    _calculate_monochrome_opacity: function(usage) {
        if (usage >= this._settings.thresholds.critical) {
            return 1.0;
        } else if (usage >= this._settings.thresholds.warning) {
            return 0.9;
        } else {
            // Scale opacity from 0.6 to 0.8 based on usage (0-warning threshold)
            let ratio = usage / this._settings.thresholds.warning;
            return 0.6 + (ratio * 0.2);
        }
    },

    /**
     * Remove all visual indicator style classes
     * @param {Object} actor - The applet actor
     */
    _remove_all_visual_indicator_classes: function(actor) {
        const style_classes = [
            'system-monitor-applet',
            'system-monitor-normal',
            'system-monitor-warning', 
            'system-monitor-critical',
            'system-monitor-custom',
            'system-monitor-monochrome',
            'system-monitor-graph',
            'system-monitor-icon-normal',
            'system-monitor-icon-warning',
            'system-monitor-icon-critical'
        ];
        
        style_classes.forEach(class_name => {
            actor.remove_style_class_name(class_name);
        });
    },

    /**
     * Get icon style class based on usage level
     * @param {number} usage - Usage percentage
     * @returns {string} Icon CSS class name
     */
    _get_icon_style_class: function(usage) {
        if (usage >= this._settings.thresholds.critical) {
            return 'system-monitor-icon-critical';
        } else if (usage >= this._settings.thresholds.warning) {
            return 'system-monitor-icon-warning';
        } else {
            return 'system-monitor-icon-normal';
        }
    },

    /**
     * Get appropriate style class based on usage level
     * @param {number} usage - Usage percentage
     * @returns {string} CSS class name
     */
    _get_usage_style_class: function(usage) {
        if (usage >= this._settings.thresholds.critical) {
            return 'system-monitor-critical';
        } else if (usage >= this._settings.thresholds.warning) {
            return 'system-monitor-warning';
        } else {
            return 'system-monitor-normal';
        }
    },

    /**
     * Apply custom colors based on usage thresholds
     * @param {Object} actor - The applet actor
     * @param {number} usage - Usage percentage
     */
    _apply_custom_colors: function(actor, usage) {
        if (!this._settings.customColors) {
            global.logWarning("System Monitor: Custom colors not available");
            return;
        }
        
        let color = this._get_custom_color_for_usage(usage);
        let font_weight = this._get_font_weight_for_usage(usage);
        let text_shadow = this._get_text_shadow_for_usage(usage);
        
        // Build custom style string
        let style_parts = [`color: ${color}`];
        
        if (font_weight) {
            style_parts.push(`font-weight: ${font_weight}`);
        }
        
        if (text_shadow) {
            style_parts.push(`text-shadow: ${text_shadow}`);
        }
        
        // Apply custom styling
        let style_string = style_parts.join('; ') + ';';
        actor.set_style(style_string);
        
        global.log(`System Monitor: Applied custom color ${color} for usage ${usage}%`);
    },

    /**
     * Get custom color for specific usage level
     * @param {number} usage - Usage percentage
     * @returns {string} Hex color string
     */
    _get_custom_color_for_usage: function(usage) {
        if (usage >= this._settings.thresholds.critical) {
            return this._settings.customColors.critical || '#ff0000';
        } else if (usage >= this._settings.thresholds.warning) {
            return this._settings.customColors.warning || '#ffff00';
        } else {
            return this._settings.customColors.normal || '#00ff00';
        }
    },

    /**
     * Get font weight for usage level
     * @param {number} usage - Usage percentage
     * @returns {string} Font weight value
     */
    _get_font_weight_for_usage: function(usage) {
        if (usage >= this._settings.thresholds.warning) {
            return 'bold';
        } else {
            return 'normal';
        }
    },

    /**
     * Get text shadow for usage level
     * @param {number} usage - Usage percentage
     * @returns {string|null} Text shadow CSS value or null
     */
    _get_text_shadow_for_usage: function(usage) {
        if (usage >= this._settings.thresholds.critical) {
            return '1px 1px 2px rgba(0, 0, 0, 0.3)';
        }
        return null;
    },

    /**
     * Validate custom color format
     * @param {string} color - Color string to validate
     * @returns {boolean} True if valid hex color
     */
    _is_valid_hex_color: function(color) {
        const hex_regex = /^#[0-9A-Fa-f]{6}$/;
        return hex_regex.test(color);
    },

    /**
     * Get theme information for external access
     * @returns {Object} Current theme configuration
     */
    _get_theme_info: function() {
        return {
            current_theme: this._settings.colorTheme,
            available_themes: ["default", "custom", "monochrome"],
            custom_colors: Object.assign({}, this._settings.customColors),
            thresholds: Object.assign({}, this._settings.thresholds),
            cinnamon_theme_integration: true,
            high_contrast_support: true
        };
    },

    /**
     * Apply theme to specific element (for testing)
     * @param {Object} element - Element to apply theme to
     * @param {number} usage - Usage percentage for testing
     * @param {string} theme_name - Theme to apply
     */
    _apply_theme_to_element: function(element, usage, theme_name) {
        if (!element) {
            return;
        }
        
        // Store current theme
        let original_theme = this._settings.colorTheme;
        
        try {
            // Temporarily change theme
            this._settings.colorTheme = theme_name;
            
            // Remove existing classes
            this._remove_all_visual_indicator_classes(element);
            
            // Apply new theme
            element.add_style_class_name('system-monitor-applet');
            this._apply_theme_classes(element, usage);
            this._apply_usage_level_classes(element, usage);
            this._apply_theme_specific_styling(element, usage);
            
        } finally {
            // Restore original theme
            this._settings.colorTheme = original_theme;
        }
    },

    /**
     * Detect and integrate with Cinnamon's current theme
     */
    _integrate_with_cinnamon_theme: function() {
        try {
            // Get the current Cinnamon theme context
            let theme_context = St.ThemeContext.get_for_stage(global.stage);
            let theme = theme_context.get_theme();
            
            if (theme) {
                // Check if we're in a dark or light theme
                let is_dark_theme = this._detect_dark_theme(theme);
                
                // Apply appropriate panel class for theme adaptation
                if (is_dark_theme) {
                    this.actor.add_style_class_name('cinnamon-panel-dark');
                } else {
                    this.actor.add_style_class_name('cinnamon-panel-light');
                }
                
                global.log("System Monitor: Integrated with Cinnamon theme (dark: " + is_dark_theme + ")");
            }
            
        } catch (error) {
            global.logError("System Monitor: Error integrating with Cinnamon theme: " + error.message);
        }
    },

    /**
     * Detect if current Cinnamon theme is dark
     * @param {Object} theme - Cinnamon theme object
     * @returns {boolean} True if dark theme detected
     */
    _detect_dark_theme: function(theme) {
        try {
            // Try to get panel background color to determine if theme is dark
            let panel_node = new St.Widget();
            panel_node.set_style_class_name('panel');
            
            let theme_node = theme.get_node(panel_node);
            if (theme_node) {
                let bg_color = theme_node.get_background_color();
                if (bg_color) {
                    // Calculate luminance to determine if background is dark
                    let luminance = this._calculate_color_luminance(bg_color);
                    return luminance < 0.5; // Dark if luminance < 50%
                }
            }
            
        } catch (error) {
            global.logError("System Monitor: Error detecting theme darkness: " + error.message);
        }
        
        // Default to assuming dark theme (most common for panels)
        return true;
    },

    /**
     * Calculate color luminance for theme detection
     * @param {Object} color - Color object
     * @returns {number} Luminance value (0-1)
     */
    _calculate_color_luminance: function(color) {
        try {
            // Extract RGB values (this is a simplified approach)
            let r = color.red / 255;
            let g = color.green / 255;
            let b = color.blue / 255;
            
            // Apply gamma correction
            r = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
            g = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
            b = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
            
            // Calculate luminance
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            
        } catch (error) {
            global.logError("System Monitor: Error calculating color luminance: " + error.message);
            return 0.5; // Default to middle value
        }
    },

    /**
     * Handle Cinnamon theme changes
     */
    _on_cinnamon_theme_changed: function() {
        global.log("System Monitor: Cinnamon theme changed, re-integrating");
        
        // Remove existing theme classes
        this.actor.remove_style_class_name('cinnamon-panel-dark');
        this.actor.remove_style_class_name('cinnamon-panel-light');
        
        // Re-integrate with new theme
        this._integrate_with_cinnamon_theme();
        
        // Force display update to apply new theme
        if (this._monitoring_active) {
            this._force_immediate_update();
        }
    },

    /**
     * Set up theme change monitoring
     */
    _setup_theme_monitoring: function() {
        try {
            // Monitor Cinnamon theme changes
            let theme_context = St.ThemeContext.get_for_stage(global.stage);
            this._theme_changed_id = theme_context.connect('changed', Lang.bind(this, this._on_cinnamon_theme_changed));
            
            global.log("System Monitor: Theme change monitoring set up");
            
        } catch (error) {
            global.logError("System Monitor: Error setting up theme monitoring: " + error.message);
        }
    },

    /**
     * Clean up theme monitoring
     */
    _cleanup_theme_monitoring: function() {
        if (this._theme_changed_id) {
            try {
                let theme_context = St.ThemeContext.get_for_stage(global.stage);
                theme_context.disconnect(this._theme_changed_id);
                this._theme_changed_id = null;
                
                global.log("System Monitor: Theme monitoring cleaned up");
                
            } catch (error) {
                global.logError("System Monitor: Error cleaning up theme monitoring: " + error.message);
            }
        }
    },

    /**
     * Get default configuration values
     * @returns {Object} Default configuration object
     */
    _get_default_configuration: function() {
        return {
            refreshInterval: 1000,
            displayFormat: "percentage",
            showGPU: true,
            colorTheme: "default",
            warningThreshold: 70,
            criticalThreshold: 90,
            normalColor: "#00ff00",
            warningColor: "#ffff00",
            criticalColor: "#ff0000"
        };
    },

    /**
     * Validate and migrate settings on startup
     */
    _validate_and_migrate_settings: function() {
        try {
            // Check if this is a first run or settings need migration
            let settings_version = this._get_settings_version();
            let current_version = "1.0.0";
            
            if (!settings_version) {
                // First run - initialize with defaults
                this._initialize_default_settings();
                this._set_settings_version(current_version);
                global.log("System Monitor: Initialized default settings for first run");
                
            } else if (settings_version !== current_version) {
                // Settings migration needed
                this._migrate_settings(settings_version, current_version);
                this._set_settings_version(current_version);
                global.log("System Monitor: Migrated settings from " + settings_version + " to " + current_version);
                
            } else {
                // Settings are current - validate them
                this._validate_current_settings();
                global.log("System Monitor: Settings validation completed");
            }
            
        } catch (error) {
            global.logError("System Monitor: Error during settings validation/migration: " + error.message);
            
            // Fall back to defaults on error
            this._reset_to_default_settings();
        }
    },

    /**
     * Get current settings version
     * @returns {string|null} Settings version or null if not set
     */
    _get_settings_version: function() {
        try {
            if (this._settings_manager && !this._using_fallback_settings) {
                // Try to get version from a custom key (we'll add this to schema)
                return this._settings_manager.getValue("settingsVersion") || null;
            }
        } catch (error) {
            // Settings version not available
        }
        return null;
    },

    /**
     * Set settings version
     * @param {string} version - Version to set
     */
    _set_settings_version: function(version) {
        try {
            if (this._settings_manager && !this._using_fallback_settings) {
                this._settings_manager.setValue("settingsVersion", version);
            }
        } catch (error) {
            global.logError("System Monitor: Error setting settings version: " + error.message);
        }
    },

    /**
     * Initialize settings with default values
     */
    _initialize_default_settings: function() {
        let defaults = this._get_default_configuration();
        
        try {
            if (this._settings_manager && !this._using_fallback_settings) {
                // Set each default value
                Object.keys(defaults).forEach(key => {
                    try {
                        this._settings_manager.setValue(key, defaults[key]);
                    } catch (error) {
                        global.logError("System Monitor: Error setting default for " + key + ": " + error.message);
                    }
                });
                
                global.log("System Monitor: Default settings initialized");
            }
            
        } catch (error) {
            global.logError("System Monitor: Error initializing default settings: " + error.message);
        }
    },

    /**
     * Migrate settings from old version to new version
     * @param {string} from_version - Source version
     * @param {string} to_version - Target version
     */
    _migrate_settings: function(from_version, to_version) {
        global.log("System Monitor: Migrating settings from " + from_version + " to " + to_version);
        
        try {
            // Version-specific migration logic
            if (from_version === "0.9.0" && to_version === "1.0.0") {
                this._migrate_from_0_9_to_1_0();
            }
            // Add more migration paths as needed
            
        } catch (error) {
            global.logError("System Monitor: Error during settings migration: " + error.message);
            throw error;
        }
    },

    /**
     * Migrate settings from version 0.9.0 to 1.0.0
     */
    _migrate_from_0_9_to_1_0: function() {
        // Example migration - in a real scenario, this would handle
        // changes in setting names, value formats, etc.
        
        try {
            // Check if old setting names exist and migrate them
            let old_refresh_rate = this._settings_manager.getValue("refreshRate");
            if (old_refresh_rate !== undefined) {
                this._settings_manager.setValue("refreshInterval", old_refresh_rate);
                // Note: In a real implementation, we'd remove the old key
            }
            
            // Ensure new settings have defaults
            let defaults = this._get_default_configuration();
            
            // Add any new settings that didn't exist in 0.9.0
            if (this._settings_manager.getValue("colorTheme") === undefined) {
                this._settings_manager.setValue("colorTheme", defaults.colorTheme);
            }
            
            global.log("System Monitor: Migration from 0.9.0 to 1.0.0 completed");
            
        } catch (error) {
            global.logError("System Monitor: Error in 0.9.0 to 1.0.0 migration: " + error.message);
            throw error;
        }
    },

    /**
     * Validate current settings and fix any issues
     */
    _validate_current_settings: function() {
        let validation_errors = [];
        let defaults = this._get_default_configuration();
        
        try {
            // Validate each setting
            Object.keys(defaults).forEach(key => {
                try {
                    let current_value = this._settings_manager.getValue(key);
                    let validation_result = this._validate_setting_value(key, current_value, defaults[key]);
                    
                    if (!validation_result.valid) {
                        validation_errors.push(`${key}: ${validation_result.error}`);
                        
                        // Reset to default value
                        this._settings_manager.setValue(key, defaults[key]);
                        global.logWarning("System Monitor: Reset " + key + " to default due to validation error");
                    }
                    
                } catch (error) {
                    validation_errors.push(`${key}: ${error.message}`);
                    
                    // Reset to default on error
                    this._settings_manager.setValue(key, defaults[key]);
                }
            });
            
            // Validate threshold relationships
            let warning = this._settings_manager.getValue("warningThreshold");
            let critical = this._settings_manager.getValue("criticalThreshold");
            
            if (warning >= critical) {
                validation_errors.push("Warning threshold must be less than critical threshold");
                this._settings_manager.setValue("warningThreshold", defaults.warningThreshold);
                this._settings_manager.setValue("criticalThreshold", defaults.criticalThreshold);
            }
            
            if (validation_errors.length > 0) {
                global.logWarning("System Monitor: Settings validation found issues: " + validation_errors.join(", "));
            }
            
        } catch (error) {
            global.logError("System Monitor: Error during settings validation: " + error.message);
            throw error;
        }
    },

    /**
     * Validate a single setting value
     * @param {string} key - Setting key
     * @param {*} value - Current value
     * @param {*} default_value - Default value
     * @returns {Object} Validation result
     */
    _validate_setting_value: function(key, value, default_value) {
        let result = { valid: true, error: null };
        
        try {
            switch (key) {
                case "refreshInterval":
                    if (!this._is_valid_refresh_interval(value)) {
                        result.valid = false;
                        result.error = "Invalid refresh interval: must be 500-5000ms, multiple of 100ms";
                    }
                    break;
                    
                case "displayFormat":
                    if (!["percentage", "graph", "both"].includes(value)) {
                        result.valid = false;
                        result.error = "Invalid display format";
                    }
                    break;
                    
                case "colorTheme":
                    if (!["default", "custom", "monochrome"].includes(value)) {
                        result.valid = false;
                        result.error = "Invalid color theme";
                    }
                    break;
                    
                case "warningThreshold":
                case "criticalThreshold":
                    if (typeof value !== 'number' || value < 1 || value > 100) {
                        result.valid = false;
                        result.error = "Invalid threshold: must be 1-100";
                    }
                    break;
                    
                case "normalColor":
                case "warningColor":
                case "criticalColor":
                    if (!this._is_valid_hex_color(value)) {
                        result.valid = false;
                        result.error = "Invalid color format: must be hex (#RRGGBB)";
                    }
                    break;
                    
                case "showGPU":
                    if (typeof value !== 'boolean') {
                        result.valid = false;
                        result.error = "Invalid boolean value";
                    }
                    break;
                    
                default:
                    // Unknown setting - this is okay, might be from newer version
                    break;
            }
            
        } catch (error) {
            result.valid = false;
            result.error = error.message;
        }
        
        return result;
    },

    /**
     * Reset all settings to defaults
     */
    _reset_to_default_settings: function() {
        global.logWarning("System Monitor: Resetting all settings to defaults");
        
        try {
            if (this._settings_manager && !this._using_fallback_settings) {
                this._initialize_default_settings();
            } else {
                // Use fallback settings
                this._setup_fallback_settings();
            }
            
            // Force immediate update to apply new settings
            this._update_internal_settings();
            
            if (this._monitoring_active) {
                this._force_immediate_update();
            }
            
            global.log("System Monitor: Settings reset to defaults completed");
            
        } catch (error) {
            global.logError("System Monitor: Error resetting settings to defaults: " + error.message);
        }
    },

    /**
     * Export current settings to a configuration object
     * @returns {Object} Exportable configuration
     */
    _export_settings: function() {
        try {
            let exported = {};
            let defaults = this._get_default_configuration();
            
            // Export all known settings
            Object.keys(defaults).forEach(key => {
                try {
                    if (this._settings_manager && !this._using_fallback_settings) {
                        exported[key] = this._settings_manager.getValue(key);
                    } else {
                        // Export from internal settings for fallback mode
                        exported[key] = this._get_internal_setting_value(key);
                    }
                } catch (error) {
                    global.logError("System Monitor: Error exporting setting " + key + ": " + error.message);
                    exported[key] = defaults[key];
                }
            });
            
            // Add metadata
            exported._metadata = {
                version: "1.0.0",
                exported_at: new Date().toISOString(),
                applet_uuid: "cpugpu@bitcrash"
            };
            
            return exported;
            
        } catch (error) {
            global.logError("System Monitor: Error exporting settings: " + error.message);
            return this._get_default_configuration();
        }
    },

    /**
     * Import settings from a configuration object
     * @param {Object} config - Configuration to import
     * @returns {boolean} True if successfully imported
     */
    _import_settings: function(config) {
        if (!config || typeof config !== 'object') {
            global.logError("System Monitor: Invalid configuration object for import");
            return false;
        }
        
        try {
            // Validate the configuration
            let validation = this._validate_complete_configuration(config);
            if (!validation.valid) {
                global.logError("System Monitor: Configuration validation failed: " + validation.errors.join(", "));
                return false;
            }
            
            // Apply the configuration
            return this._apply_configuration_changes(config);
            
        } catch (error) {
            global.logError("System Monitor: Error importing settings: " + error.message);
            return false;
        }
    },

    /**
     * Get internal setting value for fallback mode
     * @param {string} key - Setting key
     * @returns {*} Setting value
     */
    _get_internal_setting_value: function(key) {
        switch (key) {
            case "refreshInterval":
                return this._settings.refreshInterval;
            case "displayFormat":
                return this._settings.displayFormat;
            case "showGPU":
                return this._settings.showGPU;
            case "colorTheme":
                return this._settings.colorTheme;
            case "warningThreshold":
                return this._settings.thresholds.warning;
            case "criticalThreshold":
                return this._settings.thresholds.critical;
            case "normalColor":
                return this._settings.customColors.normal;
            case "warningColor":
                return this._settings.customColors.warning;
            case "criticalColor":
                return this._settings.customColors.critical;
            default:
                return null;
        }
    },

    /**
     * Get settings persistence status
     * @returns {Object} Persistence status information
     */
    _get_settings_persistence_status: function() {
        return {
            using_gsettings: !this._using_fallback_settings,
            settings_manager_available: this._settings_manager !== null,
            current_version: "1.0.0",
            settings_version: this._get_settings_version(),
            last_validation: this._last_settings_validation || null,
            fallback_mode: this._using_fallback_settings || false
        };
    },

    /**
     * Create settings backup
     * @returns {string} JSON string of current settings
     */
    _create_settings_backup: function() {
        try {
            let settings = this._export_settings();
            let backup = {
                settings: settings,
                backup_metadata: {
                    created_at: new Date().toISOString(),
                    applet_version: "1.0.0",
                    cinnamon_version: global.cinnamon_version || "unknown"
                }
            };
            
            return JSON.stringify(backup, null, 2);
            
        } catch (error) {
            global.logError("System Monitor: Error creating settings backup: " + error.message);
            return null;
        }
    },

    /**
     * Restore settings from backup
     * @param {string} backup_json - JSON string of backup
     * @returns {boolean} True if successfully restored
     */
    _restore_settings_from_backup: function(backup_json) {
        try {
            let backup = JSON.parse(backup_json);
            
            if (!backup.settings) {
                global.logError("System Monitor: Invalid backup format - missing settings");
                return false;
            }
            
            // Import the settings
            let success = this._import_settings(backup.settings);
            
            if (success) {
                global.log("System Monitor: Settings restored from backup successfully");
                
                // Log backup metadata if available
                if (backup.backup_metadata) {
                    global.log("System Monitor: Backup created at " + backup.backup_metadata.created_at);
                }
            }
            
            return success;
            
        } catch (error) {
            global.logError("System Monitor: Error restoring settings from backup: " + error.message);
            return false;
        }
    },

    /**
     * Perform settings integrity check
     * @returns {Object} Integrity check results
     */
    _perform_settings_integrity_check: function() {
        let results = {
            passed: true,
            issues: [],
            warnings: []
        };
        
        try {
            // Check if settings manager is working
            if (!this._settings_manager || this._using_fallback_settings) {
                results.warnings.push("Using fallback settings - persistence may be limited");
            }
            
            // Check each setting
            let defaults = this._get_default_configuration();
            
            Object.keys(defaults).forEach(key => {
                try {
                    let value = this._settings_manager ? this._settings_manager.getValue(key) : this._get_internal_setting_value(key);
                    let validation = this._validate_setting_value(key, value, defaults[key]);
                    
                    if (!validation.valid) {
                        results.passed = false;
                        results.issues.push(`${key}: ${validation.error}`);
                    }
                    
                } catch (error) {
                    results.passed = false;
                    results.issues.push(`${key}: Error accessing setting - ${error.message}`);
                }
            });
            
            // Check threshold relationships
            try {
                let warning = this._settings_manager ? 
                    this._settings_manager.getValue("warningThreshold") : 
                    this._settings.thresholds.warning;
                let critical = this._settings_manager ? 
                    this._settings_manager.getValue("criticalThreshold") : 
                    this._settings.thresholds.critical;
                
                if (warning >= critical) {
                    results.passed = false;
                    results.issues.push("Warning threshold must be less than critical threshold");
                }
                
            } catch (error) {
                results.passed = false;
                results.issues.push("Error checking threshold relationships: " + error.message);
            }
            
            // Check settings version
            let version = this._get_settings_version();
            if (!version) {
                results.warnings.push("Settings version not set - may indicate first run or migration needed");
            } else if (version !== "1.0.0") {
                results.warnings.push("Settings version mismatch - migration may be needed");
            }
            
        } catch (error) {
            results.passed = false;
            results.issues.push("Critical error during integrity check: " + error.message);
        }
        
        return results;
    },

    /**
     * Auto-fix settings issues
     * @returns {boolean} True if fixes were applied
     */
    _auto_fix_settings_issues: function() {
        try {
            let integrity_check = this._perform_settings_integrity_check();
            
            if (integrity_check.passed && integrity_check.issues.length === 0) {
                global.log("System Monitor: No settings issues to fix");
                return false;
            }
            
            global.logWarning("System Monitor: Auto-fixing settings issues: " + integrity_check.issues.join(", "));
            
            // Reset problematic settings to defaults
            this._validate_current_settings();
            
            // Re-run integrity check
            let recheck = this._perform_settings_integrity_check();
            
            if (recheck.passed) {
                global.log("System Monitor: Settings issues auto-fixed successfully");
                return true;
            } else {
                global.logError("System Monitor: Could not auto-fix all settings issues: " + recheck.issues.join(", "));
                return false;
            }
            
        } catch (error) {
            global.logError("System Monitor: Error during auto-fix: " + error.message);
            return false;
        }
    },

    /**
     * Get current visual indicator status
     * @returns {Object} Current visual status information
     */
    _get_visual_indicator_status: function() {
        let metrics = this._get_current_metrics();
        let cpu_usage = metrics.cpu.usage;
        let gpu_usage = metrics.gpu.usage;
        let max_usage = this._settings.showGPU ? Math.max(cpu_usage, gpu_usage) : cpu_usage;
        
        return {
            cpu_usage: cpu_usage,
            gpu_usage: gpu_usage,
            max_usage: max_usage,
            threshold_level: this._get_threshold_level(max_usage),
            style_class: this._get_usage_style_class(max_usage),
            using_custom_colors: this._settings.colorTheme === "custom"
        };
    },

    /**
     * Get threshold level name for current usage
     * @param {number} usage - Usage percentage
     * @returns {string} Threshold level name
     */
    _get_threshold_level: function(usage) {
        if (usage >= this._settings.thresholds.critical) {
            return 'critical';
        } else if (usage >= this._settings.thresholds.warning) {
            return 'warning';
        } else {
            return 'normal';
        }
    },

    /**
     * Clean up resources
     */
    _cleanup_resources: function() {
        this._stop_monitoring();
        
        // Clean up tooltip handlers
        if (this._tooltip_hover_timeout) {
            Mainloop.source_remove(this._tooltip_hover_timeout);
            this._tooltip_hover_timeout = null;
        }
        
        // Clean up theme monitoring
        this._cleanup_theme_monitoring();
        
        // Clean up settings manager
        if (this._settings_manager) {
            try {
                this._settings_manager.finalize();
            } catch (error) {
                global.logError("System Monitor: Error finalizing settings manager: " + error.message);
            }
            this._settings_manager = null;
        }
        
        // Clean up any remaining resources
        this._current_metrics = null;
        this._settings = null;
        this._prev_cpu_times = null;
        this._last_update_time = 0;
        this._update_in_progress = false;
        this._performance_stats = null;
        this._load_change_history = null;
        this._last_display_state = null;
        this._tooltip_visible = false;
        this._using_fallback_settings = false;
        
        global.log("System Monitor: Resources cleaned up");
    },

    /**
     * Handle display format changes
     * @param {string} new_format - New display format ("percentage", "graph", "both")
     */
    _handle_display_format_change: function(new_format) {
        const valid_formats = ["percentage", "graph", "both"];
        
        if (!valid_formats.includes(new_format)) {
            global.logError("System Monitor: Invalid display format: " + new_format);
            return false;
        }
        
        if (this._settings.displayFormat !== new_format) {
            this._settings.displayFormat = new_format;
            
            // Force immediate display update to show new format
            if (this._monitoring_active) {
                this._update_display();
            }
            
            global.log("System Monitor: Display format changed to " + new_format);
            return true;
        }
        
        return true;
    },

    /**
     * Handle color theme changes
     * @param {string} new_theme - New color theme ("default", "custom", "monochrome")
     * @param {Object} custom_colors - Custom color configuration (if theme is "custom")
     */
    _handle_color_theme_change: function(new_theme, custom_colors) {
        const valid_themes = ["default", "custom", "monochrome"];
        
        if (!valid_themes.includes(new_theme)) {
            global.logError("System Monitor: Invalid color theme: " + new_theme);
            return false;
        }
        
        this._settings.colorTheme = new_theme;
        
        // Update custom colors if provided
        if (new_theme === "custom" && custom_colors) {
            this._settings.customColors = Object.assign({}, this._settings.customColors, custom_colors);
        }
        
        // Force immediate visual update
        if (this._monitoring_active) {
            this._update_display();
        }
        
        global.log("System Monitor: Color theme changed to " + new_theme);
        return true;
    },

    /**
     * Handle threshold changes
     * @param {Object} new_thresholds - New threshold configuration
     */
    _handle_threshold_change: function(new_thresholds) {
        if (!new_thresholds || typeof new_thresholds !== 'object') {
            return false;
        }
        
        let updated = false;
        
        // Update warning threshold
        if (typeof new_thresholds.warning === 'number' && 
            new_thresholds.warning >= 0 && new_thresholds.warning <= 100) {
            this._settings.thresholds.warning = new_thresholds.warning;
            updated = true;
        }
        
        // Update critical threshold
        if (typeof new_thresholds.critical === 'number' && 
            new_thresholds.critical >= 0 && new_thresholds.critical <= 100) {
            this._settings.thresholds.critical = new_thresholds.critical;
            updated = true;
        }
        
        // Validate that warning < critical
        if (this._settings.thresholds.warning >= this._settings.thresholds.critical) {
            global.logError("System Monitor: Warning threshold must be less than critical threshold");
            return false;
        }
        
        // Force immediate visual update if thresholds changed
        if (updated && this._monitoring_active) {
            this._update_display();
        }
        
        return updated;
    },

    /**
     * Get current panel display information
     * @returns {Object} Current display state
     */
    _get_panel_display_info: function() {
        let metrics = this._get_current_metrics();
        
        return {
            display_text: this._format_display_text(metrics),
            icon_name: this._get_appropriate_icon(metrics),
            tooltip_text: this._generate_detailed_tooltip(metrics),
            visual_status: this._get_visual_indicator_status(),
            display_format: this._settings.displayFormat,
            color_theme: this._settings.colorTheme,
            show_gpu: this._settings.showGPU,
            thresholds: Object.assign({}, this._settings.thresholds)
        };
    },

    /**
     * Test panel display with mock data (for testing purposes)
     * @param {Object} mock_metrics - Mock SystemMetrics data
     */
    _test_panel_display: function(mock_metrics) {
        if (!mock_metrics) {
            global.logError("System Monitor: No mock metrics provided for display test");
            return;
        }
        
        // Temporarily store current metrics
        let original_metrics = this._current_metrics;
        
        try {
            // Use mock metrics for display
            this._current_metrics = mock_metrics;
            this._update_display();
            
            global.log("System Monitor: Panel display test completed with mock data");
            
        } finally {
            // Restore original metrics
            this._current_metrics = original_metrics;
        }
    },

    /**
     * Handle refresh interval setting change
     */
    _on_refresh_interval_changed: function() {
        let new_interval = this.refreshInterval;
        
        // Validate the new interval
        if (!this._is_valid_refresh_interval(new_interval)) {
            global.logError("System Monitor: Invalid refresh interval from settings: " + new_interval);
            return;
        }
        
        // Update internal settings
        this._settings.refreshInterval = new_interval;
        
        // Apply the new interval to monitoring
        if (this._monitoring_active) {
            this._restart_monitoring_with_interval(new_interval);
        } else {
            this._refresh_interval = new_interval;
        }
        
        global.log("System Monitor: Refresh interval updated to " + new_interval + "ms");
    },

    /**
     * Handle display format setting change
     */
    _on_display_format_changed: function() {
        let new_format = this.displayFormat;
        
        // Update internal settings
        this._settings.displayFormat = new_format;
        
        // Apply display format change
        this._handle_display_format_change(new_format);
        
        global.log("System Monitor: Display format updated to " + new_format);
    },

    /**
     * Handle show GPU setting change
     */
    _on_show_gpu_changed: function() {
        let show_gpu = this.showGPU;
        
        // Update internal settings
        this._settings.showGPU = show_gpu;
        
        // Force immediate display update
        if (this._monitoring_active) {
            this._force_immediate_update();
        }
        
        global.log("System Monitor: Show GPU updated to " + show_gpu);
    },

    /**
     * Handle color theme setting change
     */
    _on_color_theme_changed: function() {
        let new_theme = this.colorTheme;
        
        // Update internal settings
        this._settings.colorTheme = new_theme;
        
        // Update custom colors from current settings
        let custom_colors = {
            normal: this.normalColor,
            warning: this.warningColor,
            critical: this.criticalColor
        };
        
        // Apply color theme change
        this._handle_color_theme_change(new_theme, custom_colors);
        
        global.log("System Monitor: Color theme updated to " + new_theme);
    },

    /**
     * Handle warning threshold setting change
     */
    _on_warning_threshold_changed: function() {
        let new_warning = this.warningThreshold;
        let current_critical = this._settings.thresholds.critical;
        
        // Validate threshold relationship
        if (new_warning >= current_critical) {
            global.logError("System Monitor: Warning threshold (" + new_warning + ") must be less than critical threshold (" + current_critical + ")");
            
            // Reset to previous valid value
            this._settings_manager.setValue("warningThreshold", this._settings.thresholds.warning);
            return;
        }
        
        // Update internal settings
        this._settings.thresholds.warning = new_warning;
        
        // Force immediate visual update
        if (this._monitoring_active) {
            this._force_immediate_update();
        }
        
        global.log("System Monitor: Warning threshold updated to " + new_warning + "%");
    },

    /**
     * Handle critical threshold setting change
     */
    _on_critical_threshold_changed: function() {
        let new_critical = this.criticalThreshold;
        let current_warning = this._settings.thresholds.warning;
        
        // Validate threshold relationship
        if (current_warning >= new_critical) {
            global.logError("System Monitor: Critical threshold (" + new_critical + ") must be greater than warning threshold (" + current_warning + ")");
            
            // Reset to previous valid value
            this._settings_manager.setValue("criticalThreshold", this._settings.thresholds.critical);
            return;
        }
        
        // Update internal settings
        this._settings.thresholds.critical = new_critical;
        
        // Force immediate visual update
        if (this._monitoring_active) {
            this._force_immediate_update();
        }
        
        global.log("System Monitor: Critical threshold updated to " + new_critical + "%");
    },

    /**
     * Handle custom color setting changes
     */
    _on_custom_colors_changed: function() {
        // Update internal custom colors
        this._settings.customColors = {
            normal: this.normalColor || "#00ff00",
            warning: this.warningColor || "#ffff00",
            critical: this.criticalColor || "#ff0000"
        };
        
        // Apply color changes if using custom theme
        if (this._settings.colorTheme === "custom") {
            this._handle_color_theme_change("custom", this._settings.customColors);
        }
        
        global.log("System Monitor: Custom colors updated");
    },

    /**
     * Open configuration dialog
     */
    _open_configuration_dialog: function() {
        try {
            if (this._using_fallback_settings) {
                global.logError("System Monitor: Cannot open configuration dialog - using fallback settings");
                return;
            }
            
            // Open the settings dialog using Cinnamon's built-in mechanism
            this._settings_manager.open();
            
            global.log("System Monitor: Configuration dialog opened");
            
        } catch (error) {
            global.logError("System Monitor: Error opening configuration dialog: " + error.message);
        }
    },

    /**
     * Get current configuration for external access
     * @returns {Object} Current configuration object
     */
    _get_current_configuration: function() {
        return {
            refreshInterval: this._settings.refreshInterval,
            displayFormat: this._settings.displayFormat,
            showGPU: this._settings.showGPU,
            colorTheme: this._settings.colorTheme,
            thresholds: Object.assign({}, this._settings.thresholds),
            customColors: Object.assign({}, this._settings.customColors),
            using_fallback: this._using_fallback_settings || false
        };
    },

    /**
     * Validate complete configuration object
     * @param {Object} config - Configuration to validate
     * @returns {Object} Validation result
     */
    _validate_complete_configuration: function(config) {
        let result = {
            valid: true,
            errors: []
        };
        
        // Validate refresh interval
        if (config.refreshInterval !== undefined) {
            if (!this._is_valid_refresh_interval(config.refreshInterval)) {
                result.valid = false;
                result.errors.push("Invalid refresh interval: must be between 500-5000ms and multiple of 100ms");
            }
        }
        
        // Validate display format
        if (config.displayFormat !== undefined) {
            const valid_formats = ["percentage", "graph", "both"];
            if (!valid_formats.includes(config.displayFormat)) {
                result.valid = false;
                result.errors.push("Invalid display format: must be 'percentage', 'graph', or 'both'");
            }
        }
        
        // Validate color theme
        if (config.colorTheme !== undefined) {
            const valid_themes = ["default", "custom", "monochrome"];
            if (!valid_themes.includes(config.colorTheme)) {
                result.valid = false;
                result.errors.push("Invalid color theme: must be 'default', 'custom', or 'monochrome'");
            }
        }
        
        // Validate thresholds
        if (config.thresholds) {
            if (config.thresholds.warning !== undefined) {
                if (typeof config.thresholds.warning !== 'number' || 
                    config.thresholds.warning < 1 || config.thresholds.warning > 99) {
                    result.valid = false;
                    result.errors.push("Invalid warning threshold: must be 1-99");
                }
            }
            
            if (config.thresholds.critical !== undefined) {
                if (typeof config.thresholds.critical !== 'number' || 
                    config.thresholds.critical < 1 || config.thresholds.critical > 100) {
                    result.valid = false;
                    result.errors.push("Invalid critical threshold: must be 1-100");
                }
            }
            
            // Check threshold relationship
            let warning = config.thresholds.warning !== undefined ? 
                config.thresholds.warning : this._settings.thresholds.warning;
            let critical = config.thresholds.critical !== undefined ? 
                config.thresholds.critical : this._settings.thresholds.critical;
            
            if (warning >= critical) {
                result.valid = false;
                result.errors.push("Warning threshold must be less than critical threshold");
            }
        }
        
        // Validate custom colors (basic hex color format)
        if (config.customColors) {
            const color_regex = /^#[0-9A-Fa-f]{6}$/;
            
            ['normal', 'warning', 'critical'].forEach(color_type => {
                if (config.customColors[color_type] !== undefined) {
                    if (!color_regex.test(config.customColors[color_type])) {
                        result.valid = false;
                        result.errors.push(`Invalid ${color_type} color: must be hex format (#RRGGBB)`);
                    }
                }
            });
        }
        
        return result;
    },

    /**
     * Apply configuration changes programmatically
     * @param {Object} config - Configuration changes to apply
     * @returns {boolean} True if successfully applied
     */
    _apply_configuration_changes: function(config) {
        // Validate configuration first
        let validation = this._validate_complete_configuration(config);
        if (!validation.valid) {
            global.logError("System Monitor: Configuration validation failed: " + validation.errors.join(", "));
            return false;
        }
        
        try {
            // Apply changes through GSettings if available
            if (this._settings_manager && !this._using_fallback_settings) {
                if (config.refreshInterval !== undefined) {
                    this._settings_manager.setValue("refreshInterval", config.refreshInterval);
                }
                
                if (config.displayFormat !== undefined) {
                    this._settings_manager.setValue("displayFormat", config.displayFormat);
                }
                
                if (config.showGPU !== undefined) {
                    this._settings_manager.setValue("showGPU", config.showGPU);
                }
                
                if (config.colorTheme !== undefined) {
                    this._settings_manager.setValue("colorTheme", config.colorTheme);
                }
                
                if (config.thresholds) {
                    if (config.thresholds.warning !== undefined) {
                        this._settings_manager.setValue("warningThreshold", config.thresholds.warning);
                    }
                    if (config.thresholds.critical !== undefined) {
                        this._settings_manager.setValue("criticalThreshold", config.thresholds.critical);
                    }
                }
                
                if (config.customColors) {
                    if (config.customColors.normal !== undefined) {
                        this._settings_manager.setValue("normalColor", config.customColors.normal);
                    }
                    if (config.customColors.warning !== undefined) {
                        this._settings_manager.setValue("warningColor", config.customColors.warning);
                    }
                    if (config.customColors.critical !== undefined) {
                        this._settings_manager.setValue("criticalColor", config.customColors.critical);
                    }
                }
                
                global.log("System Monitor: Configuration changes applied successfully");
                return true;
                
            } else {
                // Apply changes directly to fallback settings
                this._apply_fallback_configuration_changes(config);
                return true;
            }
            
        } catch (error) {
            global.logError("System Monitor: Error applying configuration changes: " + error.message);
            return false;
        }
    },

    /**
     * Apply configuration changes to fallback settings
     * @param {Object} config - Configuration changes to apply
     */
    _apply_fallback_configuration_changes: function(config) {
        let needs_restart = false;
        let needs_display_update = false;
        
        // Apply refresh interval
        if (config.refreshInterval !== undefined && config.refreshInterval !== this._settings.refreshInterval) {
            this._settings.refreshInterval = config.refreshInterval;
            needs_restart = this._set_refresh_interval(config.refreshInterval);
        }
        
        // Apply display format
        if (config.displayFormat !== undefined && config.displayFormat !== this._settings.displayFormat) {
            this._settings.displayFormat = config.displayFormat;
            needs_display_update = true;
        }
        
        // Apply show GPU setting
        if (config.showGPU !== undefined && config.showGPU !== this._settings.showGPU) {
            this._settings.showGPU = config.showGPU;
            needs_display_update = true;
        }
        
        // Apply color theme
        if (config.colorTheme !== undefined && config.colorTheme !== this._settings.colorTheme) {
            this._settings.colorTheme = config.colorTheme;
            needs_display_update = true;
        }
        
        // Apply thresholds
        if (config.thresholds) {
            if (config.thresholds.warning !== undefined) {
                this._settings.thresholds.warning = config.thresholds.warning;
                needs_display_update = true;
            }
            if (config.thresholds.critical !== undefined) {
                this._settings.thresholds.critical = config.thresholds.critical;
                needs_display_update = true;
            }
        }
        
        // Apply custom colors
        if (config.customColors) {
            Object.assign(this._settings.customColors, config.customColors);
            if (this._settings.colorTheme === "custom") {
                needs_display_update = true;
            }
        }
        
        // Apply updates
        if (needs_display_update && this._monitoring_active) {
            this._force_immediate_update();
        }
        
        global.log("System Monitor: Fallback configuration changes applied");
    },

    /**
     * Handle applet click to open configuration dialog
     */
    on_applet_clicked: function(event) {
        this._open_configuration_dialog();
    },

    /**
     * Create context menu with configuration option
     */
    _create_context_menu: function() {
        // Add configuration menu item
        let config_item = new Applet.MenuItem("Configure System Monitor", "preferences-system", Lang.bind(this, function() {
            this._open_configuration_dialog();
        }));
        
        this._applet_context_menu.addMenuItem(config_item);
        
        // Add separator
        this._applet_context_menu.addMenuItem(new Applet.MenuSeparator());
        
        // Add about item
        let about_item = new Applet.MenuItem("About", "help-about", Lang.bind(this, function() {
            this._show_about_dialog();
        }));
        
        this._applet_context_menu.addMenuItem(about_item);
    },

    /**
     * Show about dialog
     */
    _show_about_dialog: function() {
        try {
            const ModalDialog = imports.ui.modalDialog;
            const St = imports.gi.St;
            const Clutter = imports.gi.Clutter;
            const GLib = imports.gi.GLib;
            const Gio = imports.gi.Gio;
            
            let dialog = new ModalDialog.ModalDialog();
            
            // Create main content box
            let contentBox = new St.BoxLayout({
                style_class: 'about-dialog-content',
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER
            });
            
            // Add custom icon
            let iconPath = GLib.build_filenamev([this._get_applet_directory(), 'icon.svg']);
            let iconFile = Gio.File.new_for_path(iconPath);
            
            if (iconFile.query_exists(null)) {
                let icon = new St.Icon({
                    gicon: Gio.icon_new_for_string(iconPath),
                    icon_size: 64,
                    style_class: 'about-dialog-icon'
                });
                contentBox.add_child(icon);
            } else {
                // Fallback to system icon if custom icon not found
                let icon = new St.Icon({
                    icon_name: 'utilities-system-monitor',
                    icon_size: 64,
                    style_class: 'about-dialog-icon'
                });
                contentBox.add_child(icon);
            }
            
            // Add title
            let title = new St.Label({
                text: 'System Monitor Applet',
                style_class: 'about-dialog-title'
            });
            contentBox.add_child(title);
            
            // Add version
            let version = new St.Label({
                text: 'Version 1.0.0',
                style_class: 'about-dialog-version'
            });
            contentBox.add_child(version);
            
            // Add description
            let description = new St.Label({
                text: 'Real-time CPU and GPU monitoring for Cinnamon desktop.',
                style_class: 'about-dialog-description'
            });
            contentBox.add_child(description);
            
            // Add features list
            let featuresText = 'Features:\n' +
                             '• Real-time CPU and GPU usage monitoring\n' +
                             '• Customizable refresh intervals\n' +
                             '• Multiple display formats\n' +
                             '• Configurable usage thresholds\n' +
                             '• Custom color themes\n\n' +
                             'Right-click to configure settings.';
            
            let features = new St.Label({
                text: featuresText,
                style_class: 'about-dialog-features'
            });
            contentBox.add_child(features);
            
            // Add content to dialog
            dialog.contentLayout.add_child(contentBox);
            
            // Add close button
            dialog.setButtons([{
                label: 'Close',
                action: function() {
                    dialog.close();
                },
                key: Clutter.KEY_Escape
            }]);
            
            // Show dialog
            dialog.open();
            
            global.log("System Monitor: About dialog displayed");
            
        } catch (error) {
            global.logError("System Monitor: Error showing about dialog: " + error.message);
            
            // Fallback to simple notification
            let about_text = "System Monitor Applet v1.0.0 - Real-time CPU and GPU monitoring for Cinnamon desktop.";
            global.log("System Monitor: " + about_text);
        }
    },
    
    /**
     * Get applet directory path
     * @returns {string} Path to applet directory
     */
    _get_applet_directory: function() {
        try {
            // Get the directory where this applet is installed
            let appletPath = imports.ui.appletManager.appletMeta["cpugpu@bitcrash"].path;
            return appletPath;
        } catch (error) {
            // Fallback method
            return GLib.get_home_dir() + "/.local/share/cinnamon/applets/cpugpu@bitcrash";
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new SystemMonitorApplet(orientation, panel_height, instance_id);
}