import { createTestRenderer } from "@opentui/core/testing";
import { Picker } from "./dist/tui/components.js";

const setup = await createTestRenderer({ width: 80, height: 24 });
const picker = new Picker(setup.renderer, "操作を検索", [
  { value: "login", label: "認証", description: "/login" },
  { value: "doctor", label: "ローカル診断", description: "/doctor" },
], true);
setup.renderer.root.add(picker);
await setup.renderOnce();
console.log("=== CHAR FRAME ===");
console.log(setup.captureCharFrame());
