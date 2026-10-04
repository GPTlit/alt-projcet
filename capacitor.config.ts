import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "fm.spoiled.app",
  appName: "SPOILED",
  webDir: "dist/client",
  server: {
    url: "https://spoiled-fm.lovable.app",
    cleartext: false,
  },
  android: {
    backgroundColor: "#f6f8fb",
  },
};

export default config;
