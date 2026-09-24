import { getKeybindings, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";

export function createMonitorTui(terminal: Terminal): TuiAltScreen {
  // 正文由 MonitorRouter 分页；外层视口消费这些键后无法滚动，也不会继续分发。
  const keybindings = getKeybindings();
  keybindings.setUserBindings({
    ...keybindings.getUserBindings(),
    "tui.altScreen.pageUp": [],
    "tui.altScreen.pageDown": [],
    "tui.altScreen.top": [],
    "tui.altScreen.bottom": [],
  });
  return new TuiAltScreen(terminal);
}
