import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "ai.overcode.mobile",
  appName: "Overcode Mobile",
  webDir: "../app/dist",
  android: {
    backgroundColor: "#191515",
  },
  server: {
    androidScheme: "https",
  },
}

export default config
