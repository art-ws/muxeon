import { createRoot } from "react-dom/client";
import { App } from "./App";

/** Baked in by build.ts (T281); "dev" when the module runs unbundled. */
declare const __PANEL_BUILD__: string;
// One line at boot: the entry bundle has a stable name, so a soft reload can
// keep serving an older one — and a fixed panel then looks unfixed. This makes
// "which build is this tab running?" answerable without guessing.
console.info(`muxeon panel build ${typeof __PANEL_BUILD__ === "string" ? __PANEL_BUILD__ : "dev"}`);

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(<App />);
