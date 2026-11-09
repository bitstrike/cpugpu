# Filename: Makefile
UUID        := cpugpu@bitcrash
SRC_DIR     := $(UUID)
INSTALL_DIR ?= $(HOME)/.local/share/cinnamon/applets/$(UUID)

.PHONY: install

# Copy the applet from the project into the installed applet directory.
# Skipped when INSTALL_DIR is a symlink (dev setup), since it already tracks the project.
# Override the destination with: make install INSTALL_DIR=/path/to/applets/$(UUID)
install:
	@if [ -L "$(INSTALL_DIR)" ]; then \
		echo "$(INSTALL_DIR) is a symlink; already tracks the project"; \
	else \
		mkdir -p "$(INSTALL_DIR)" && \
		cp -av "$(SRC_DIR)/." "$(INSTALL_DIR)/" && \
		echo "Installed to $(INSTALL_DIR). Restart Cinnamon (Alt+F2, r) to reload."; \
	fi
